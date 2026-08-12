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
import { syncAllFunnelTargets } from "../lib/targets.js";
import { dbConfigured, rpc, select } from "../lib/db.js";
import { drainOnce } from "../lib/delivery.js";
import { errSummary } from "../lib/log.js";

/** The five states in the schema's own check constraint. */
const DELIVERY_STATUSES = new Set(["pending", "delivering", "done", "dead", "cancelled"]);

/**
 * States `resend_delivery` accepts. `delivering` is excluded because a lease is
 * still out on it and a second dispatch is a double-send; `pending` because it
 * is already going to be attempted.
 */
const RESENDABLE = new Set(["dead", "done", "cancelled"]);

/**
 * Columns the delivery log reads.
 *
 * `delivery_target.config` is NOT among them and must never be — it holds the
 * webhook secret, and §2 of the schema says in as many words that it may not be
 * returned by a console API.
 *
 * The funnel's SLUG comes through a nested embed rather than being resolved in
 * the console, because the console's funnel list is slugs only: `funnel.id` is a
 * UUID that never reaches it, so a client-side lookup by id would label every
 * row with a raw UUID forever.
 */
const DELIVERY_SELECT =
  "select=id,status,attempts,last_error,last_status,next_attempt_at,created_at,delivered_at," +
  "lead(id,funnel_id,created_at,funnel(slug)),delivery_target(kind)";

/**
 * Shape one delivery row for the console.
 *
 * An allowlist rather than a rename pass: if the select above ever grows a
 * column, it does not reach the console until someone adds it here too.
 *
 * @param {any} row
 */
const deliveryView = (row) => ({
  id: row.id,
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error ?? null,
  lastStatus: row.last_status ?? null,
  nextAttemptAt: row.next_attempt_at ?? null,
  createdAt: row.created_at ?? null,
  deliveredAt: row.delivered_at ?? null,
  kind: row.delivery_target?.kind ?? null,
  leadId: row.lead?.id ?? null,
  funnelId: row.lead?.funnel_id ?? null,
  funnelSlug: row.lead?.funnel?.slug ?? null,
  leadCreatedAt: row.lead?.created_at ?? null,
});

/**
 * Why `resend_delivery` said no.
 *
 * The RPC answers with one boolean for two very different situations, and the
 * console showed both as "the row's state changed" — which is a lie in the case
 * that matters: a restricted lead (Art. 18) refuses the re-send permanently, and
 * an operator told the state changed will simply click again. The lookup only
 * runs on the refusal path.
 *
 * @param {string} leadId
 * @returns {Promise<"lead_restricted"|"lead_deleted"|"not_resendable">}
 */
async function refusalReason(leadId) {
  try {
    const [lead] = await select("lead", `select=restricted,deleted_at&id=eq.${encodeURIComponent(leadId)}&limit=1`);
    if (lead?.restricted) return "lead_restricted";
    if (lead?.deleted_at) return "lead_deleted";
  } catch {
    /* the reason is a courtesy; the refusal itself already stands */
  }
  return "not_resendable";
}

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
    // The queue's `email` targets hold a copy of the notification address, so a
    // change here has to reach them — otherwise leads keep arriving at the
    // address the operator just replaced, durably and with no error anywhere.
    await syncAllFunnelTargets();
    // Re-resolve rather than echoing what was written: the saved object has
    // env-provided secrets stripped out (so they are not persisted to disk),
    // which would otherwise make this reply say "no key is set" at the exact
    // moment the operator might type one in — and a typed key persists and
    // shadows the env var, the failure that stripping exists to prevent.
    return json({ ok: true, settings: redactEmailSettings(await getEmailSettings()) });
  }

  // Re-derive every funnel's delivery targets. The backfill for funnels that
  // existed before targets did — without it, "never lose a lead" only becomes
  // true for a funnel once somebody happens to save it again. WO12's console
  // view calls this; until then it is the operator's one-request repair.
  if (path === "/api/admin/targets/sync" && req.method === "POST") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    return json({ ok: true, ...(await syncAllFunnelTargets()) });
  }

  // The delivery log. A read of the queue, never a second copy of it.
  if (path === "/api/admin/deliveries" && req.method === "GET") {
    // An empty log and no queue at all are opposite situations: a deployment
    // running on the legacy fan-out must not be told its delivery log is fine.
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    const wanted = url.searchParams.get("status") || "";
    if (wanted && !DELIVERY_STATUSES.has(wanted)) return json({ error: "invalid_status" }, 400);
    const asked = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 500) : 100;

    try {
      const rows = await select(
        "delivery",
        `${DELIVERY_SELECT}&order=id.desc&limit=${limit}${wanted ? `&status=eq.${wanted}` : ""}`,
      );
      return json({ deliveries: rows.map(deliveryView) });
    } catch (err) {
      console.warn(`[admin] delivery log unavailable: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  // Manual re-send. `resend_delivery` is the authority on whether the row may
  // move — the read below only exists to tell "no such row" apart from "not in a
  // state you can re-send", which the RPC's boolean cannot.
  if (path === "/api/admin/deliveries/resend" && req.method === "POST") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    const body = await readJson(req);
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid_id" }, 400);
    // Authenticated, but a leaked token that can trigger unbounded outbound
    // egress is worth a ceiling — same reasoning as the test-email route.
    if (!(await rateLimit(`resend:${clientIp(req, server) || "unknown"}`, 30, 60 * 60 * 1000))) return tooMany();

    try {
      const [row] = await select("delivery", `select=id,status,lead_id&id=eq.${id}&limit=1`);
      if (!row) return json({ error: "not_found" }, 404);
      if (!RESENDABLE.has(row.status)) return json({ error: "not_resendable", status: row.status }, 409);
      // Races the drain: the row can be claimed between the read and here, which
      // is exactly what the RPC's own status filter refuses.
      if (!(await rpc("resend_delivery", { p_id: id }))) return json({ error: await refusalReason(row.lead_id) }, 409);

      // Attempted inline, and awaited: the operator clicked a button and should
      // get the outcome, not a row that sits in `pending` until pg_cron fires.
      //
      // Bounded twice over. Each attempt has the dispatcher's own timeout, and
      // the deadline stops this claiming more work — `claim_deliveries` takes
      // every due row for the lead, not only the one that was clicked, so the
      // wait is not a function of anything this route can see. Accelerating a
      // sibling row that was already due is harmless; making the operator wait
      // an unbounded number of chunks for it is not.
      await drainOnce({ leadId: row.lead_id, limit: 10, deadline: Date.now() + 20_000, signal: req.signal });

      const [after] = await select("delivery", `select=status,attempts,last_error,last_status&id=eq.${id}&limit=1`);
      return json({
        ok: true,
        status: after?.status ?? "pending",
        attempts: after?.attempts ?? 0,
        lastError: after?.last_error ?? null,
        lastStatus: after?.last_status ?? null,
      });
    } catch (err) {
      console.warn(`[admin] re-send of delivery ${id} failed: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  if (path === "/api/admin/test-email" && req.method === "POST") {
    const body = await readJson(req);
    const targetEmail = String(body?.email || (await getEmailSettings()).notifyEmail || "").trim();
    if (!targetEmail) return json({ error: "No recipient email specified" }, 400);
    if (!EMAIL_RE.test(targetEmail)) return json({ error: "invalid_email" }, 400);
    // Authenticated, but still capped: a leaked token should not turn the
    // operator's mail domain into a spam source.
    if (!(await rateLimit(`test-email:${clientIp(req, server) || "unknown"}`, 10, 60 * 60 * 1000))) return tooMany();

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
