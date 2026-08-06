/**
 * @file `/api/lead` and `/api/events` — the entire public ingest surface.
 *
 * The governing rule is that ingest must NEVER fail a visitor. Both routes
 * return 202 immediately and persist in the background; `persist()` fans out
 * with `Promise.allSettled` so a dead webhook or a Supabase outage is a
 * `console.warn`, never a 500 that breaks the funnel someone is mid-way through.
 *
 * Two things are re-derived server-side rather than trusted from the body:
 * `email_verified` (checked against the server's own record of who passed a
 * challenge) and the preview flag (checked with the same predicate the admin
 * readers use).
 */

import { isEmailVerified } from "../lib/email.js";
import { CORS, clientIp, json, readJson } from "../lib/http.js";
import { oneLine } from "../lib/log.js";
import { isPreviewRecord } from "../lib/preview.js";
import { rateLimit, tooMany } from "../lib/ratelimit.js";
import { persist } from "../lib/store.js";

/**
 * @param {Request} req
 * @param {{ path: string, server: any }} ctx
 * @returns {Promise<Response|null>} null when this is not an ingest route.
 */
export async function handleIngest(req, ctx) {
  const { path, server } = ctx;
  if (path !== "/api/lead" && path !== "/api/events") return null;

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, CORS);

  const body = await readJson(req);
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400, CORS);

  // Use the SAME predicate the admin readers use. When these drifted, a
  // record marked only via `isPreview` / `meta.isPreview` / a `meta.url`
  // containing `preview=1` was persisted and fanned out to the webhook, the
  // operator's alert inbox and the autoresponder — and then filtered out of
  // `/api/admin/*`, so a stranger could inject records the operator could
  // never see.
  const referer = req.headers.get("referer") || "";
  if (isPreviewRecord({ ...body, referer })) {
    return json({ ok: true, preview: true }, 202, CORS);
  }

  const ip = clientIp(req, server);
  // Public endpoints: bound them so a script cannot flood the JSONL sink,
  // the webhook, and the autoresponder in a loop.
  if (!rateLimit(`ingest:${ip || "unknown"}`, path === "/api/lead" ? 30 : 300, 60 * 1000)) {
    return tooMany();
  }

  const record = {
    ...body,
    received_at: new Date().toISOString(),
    ip,
    user_agent: req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
  };

  // `email_verified` arrives from the browser, which the visitor controls.
  // Re-derive it from the server's own record of who passed a challenge so
  // the stored lead reflects what actually happened, not what was claimed.
  if (path === "/api/lead" && record.lead && typeof record.lead === "object") {
    const claimed = Boolean(record.lead.email_verified);
    const actual = claimed && isEmailVerified(record.lead.email);
    record.lead = { ...record.lead, email_verified: actual };
    if (claimed && !actual) {
      console.warn(`[runtime] unverified lead claimed email_verified: ${oneLine(record.lead.email, 120)}`);
    }
  }

  // Respond immediately; the visitor is mid-funnel and must not wait on I/O.
  void persist(path === "/api/lead" ? "leads" : "events", record);
  return json({ ok: true }, 202, CORS);
}
