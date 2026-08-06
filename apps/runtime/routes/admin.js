/**
 * @file `/api/admin/*` — the console's data and configuration APIs.
 *
 * PRIVILEGED. The router runs `isCrossSiteRequest` and `requireAdmin` before
 * dispatching here; these handlers do no auth of their own.
 *
 * Two invariants show up in this file:
 *
 *  - Every reader filters with `isPreviewRecord`, the SAME predicate the ingest
 *    path uses. When those drifted, a stranger could inject records the operator
 *    could never see.
 *  - `redactEmailSettings` runs on the way out. Secrets never travel outward,
 *    not even to an authenticated console.
 */

import { esc } from "../lib/html.js";
import { EMAIL_RE, getEmailSettings, redactEmailSettings, saveEmailSettings, sendEmail } from "../lib/email.js";
import { clientIp, json, readJson } from "../lib/http.js";
import { isPreviewRecord } from "../lib/preview.js";
import { rateLimit, tooMany } from "../lib/ratelimit.js";
import { readJsonlRecords } from "../lib/store.js";

/**
 * @param {Request} req
 * @param {{ path: string, url: URL, server: any }} ctx
 * @returns {Promise<Response|null>} null when no admin route matched.
 */
export async function handleAdmin(req, ctx) {
  const { path, url, server } = ctx;

  if (path === "/api/admin/leads" && req.method === "GET") {
    const records = (await readJsonlRecords("leads.jsonl")).filter((l) => !isPreviewRecord(l));
    return json({ leads: records.reverse() });
  }

  if (path === "/api/admin/stats" && req.method === "GET") {
    return json(await computeStats(url.searchParams.get("funnel") || ""));
  }

  if (path === "/api/admin/email-settings" && req.method === "GET") {
    const cfg = await getEmailSettings();
    return json({ settings: redactEmailSettings(cfg) });
  }

  if (path === "/api/admin/email-settings" && req.method === "POST") {
    const body = await readJson(req);
    await saveEmailSettings(body || {});
    // Re-resolve rather than echoing what was written: the saved object has
    // env-provided secrets stripped out (so they are not persisted to disk),
    // which would otherwise make this reply say "no key is set" at the exact
    // moment the operator might type one in — and a typed key persists and
    // shadows the env var, the failure that stripping exists to prevent.
    return json({ ok: true, settings: redactEmailSettings(await getEmailSettings()) });
  }

  if (path === "/api/admin/test-email" && req.method === "POST") {
    const body = await readJson(req);
    const targetEmail = String(body?.email || (await getEmailSettings()).notifyEmail || "").trim();
    if (!targetEmail) return json({ error: "No recipient email specified" }, 400);
    if (!EMAIL_RE.test(targetEmail)) return json({ error: "invalid_email" }, 400);
    // Authenticated, but still capped: a leaked token should not turn the
    // operator's mail domain into a spam source.
    if (!rateLimit(`test-email:${clientIp(req, server) || "unknown"}`, 10, 60 * 60 * 1000)) return tooMany();

    const res = await sendEmail({
      to: targetEmail,
      subject: "🎉 OpenFunnel Email Test Successful",
      html: `<div style="font-family:sans-serif;padding:20px;border-radius:12px;border:1px solid #e2e8f0;">
          <h2>OpenFunnel Email Verification</h2>
          <p>Your email notification settings are working correctly!</p>
          <p style="color:#64748b;font-size:13px;">Timestamp: ${esc(new Date().toISOString())}</p>
        </div>`,
    });
    return json(res);
  }

  return null;
}

/**
 * Roll the JSONL sinks up into the dashboard's numbers.
 *
 * @param {string} scope  a funnelId to narrow to, or "" for everything.
 */
async function computeStats(scope) {
  const allEvents = (await readJsonlRecords("events.jsonl")).filter((ev) => !isPreviewRecord(ev));
  const allLeads = (await readJsonlRecords("leads.jsonl")).filter((l) => !isPreviewRecord(l));

  const events = scope ? allEvents.filter((ev) => ev.funnelId === scope) : allEvents;
  const leads = scope ? allLeads.filter((l) => l.funnelId === scope) : allLeads;

  let starts = 0;
  let stepViews = 0;
  let completes = 0;

  // Drop-off is only honest per *visitor*, so each step counts distinct
  // sessions — a visitor tapping back and forth must not inflate a step.
  const sessions = new Set();
  /** @type {Map<string, { order: number, sessions: Set<string> }>} */
  const perStep = new Map();

  events.forEach((ev, i) => {
    if (ev.type === "funnel_start") starts++;
    if (ev.type === "step_view") stepViews++;
    if (ev.type === "complete") completes++;
    if (ev.sessionId) sessions.add(ev.sessionId);

    if (ev.type !== "step_view" || !ev.stepId) return;
    let entry = perStep.get(ev.stepId);
    if (!entry) {
      entry = { order: typeof ev.stepIndex === "number" ? ev.stepIndex : i, sessions: new Set() };
      perStep.set(ev.stepId, entry);
    }
    entry.sessions.add(ev.sessionId || `anon-${i}`);
  });

  const steps = [...perStep.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([stepId, entry]) => ({ stepId, sessions: entry.sessions.size }));

  // Per-funnel rollup always spans every funnel so the dashboard can label
  // each card even while a single funnel is in scope.
  /** @type {Record<string, { starts: number, leads: number, completes: number }>} */
  // Null-prototype: `funnelId` comes from the public /api/events body, and on
  // a plain object `perFunnel["__proto__"]` resolves to Object.prototype —
  // truthy, so `||=` never creates an own key and the increments land on the
  // prototype instead.
  const perFunnel = Object.create(null);
  const bucket = (id) => (perFunnel[id] ||= { starts: 0, leads: 0, completes: 0 });
  allEvents.forEach((ev) => {
    if (!ev.funnelId) return;
    if (ev.type === "funnel_start") bucket(ev.funnelId).starts++;
    if (ev.type === "complete") bucket(ev.funnelId).completes++;
  });
  allLeads.forEach((l) => {
    if (l.funnelId) bucket(l.funnelId).leads++;
  });

  return {
    starts,
    stepViews,
    leads: leads.length,
    completes,
    sessions: sessions.size,
    steps,
    perFunnel,
  };
}
