/**
 * @file `/api/lead` and `/api/events` — the entire public ingest surface.
 *
 * The governing rule is that ingest must NEVER fail a visitor. Both routes
 * answer 202 whatever happens downstream: a dead webhook, an unknown funnel or
 * a Supabase outage is a `console.warn`, never a 500 that breaks the funnel
 * someone is mid-way through.
 *
 * What changed in Phase 1 is where the lead goes, not what the visitor sees.
 * The old path fanned out with `Promise.allSettled` *after* responding, which
 * meant a webhook that was down for ten minutes cost the client every lead that
 * arrived in those ten minutes — the failure this phase exists to remove. Now
 * `ingest_lead` writes the lead and its delivery rows in one transaction, and
 * retries are the queue's problem rather than a lost `console.warn`.
 *
 * That insert is AWAITED before the 202. It is one round trip to Postgres in
 * the same region, and the alternative is worse than the latency: on serverless
 * the invocation can be frozen the moment the response is written, so a
 * fire-and-forget insert is a lead that exists only in a suspended process. The
 * invariant is that ingest never *fails* a visitor, not that it never waits.
 *
 * When that insert cannot happen — database unreachable, unknown slug, a row
 * the schema refuses — the route degrades forward: it runs the old fan-out so
 * the lead still reaches the operator right now, and still answers 202. A
 * degraded delivery beats a lost lead.
 *
 * Two things are re-derived server-side rather than trusted from the body:
 * `email_verified` (checked against the server's own record of who passed a
 * challenge) and the preview flag (checked with the same predicate the admin
 * readers use).
 */

import { createHash } from "node:crypto";
import { dbConfigured, dbErrorKind, rpc } from "../lib/db.js";
import { drainOnce } from "../lib/delivery.js";
import { isEmailVerified } from "../lib/email.js";
import { CORS, clientIp, json, readJson } from "../lib/http.js";
import { errSummary, oneLine } from "../lib/log.js";
import { isPreviewRecord } from "../lib/preview.js";
import { rateLimit, tooMany } from "../lib/ratelimit.js";
import { persist } from "../lib/store.js";

/* ========================================================================== *
 *  Personal data on the way in
 * ========================================================================== */

/**
 * Salt for the stored IP hash. Without it no IP is stored at all, which is the
 * safe default rather than the broken one: an unsalted hash of an IPv4 address
 * is reversible in seconds — the whole space is 2^32 — so it would be personal
 * data wearing a disguise. Rate limiting is unaffected either way; that runs on
 * the address in this process and never touches the column.
 */
const IP_HASH_SALT = process.env.IP_HASH_SALT || "";
let warnedNoSalt = false;

/**
 * @param {string|null|undefined} ip
 * @returns {string|null} Postgres `bytea` hex input, or null to store nothing.
 */
function hashIp(ip) {
  if (!ip) return null;
  if (!IP_HASH_SALT) {
    if (!warnedNoSalt) {
      warnedNoSalt = true;
      console.warn("[runtime] IP_HASH_SALT is unset — storing no IP with leads (set it to enable abuse forensics)");
    }
    return null;
  }
  // `\x…` is Postgres's hex input format for bytea; PostgREST passes the JSON
  // string through as text and the cast happens on the parameter's declared type.
  return `\\x${createHash("sha256").update(`${IP_HASH_SALT}:${ip}`).digest("hex")}`;
}

/**
 * Collapse a double-tapped submit into one lead, and one delivery.
 *
 * Hashed rather than stored plainly because a unique-constraint violation quotes
 * the conflicting key back in its error message, and `lib/db.js` truncates that
 * message into a log line. A plaintext key would put a visitor's email address
 * in the operator's logs on the exact request that was already a duplicate.
 *
 * Ten-minute fixed buckets, so two submits either side of a boundary are two
 * leads. That is the right way round: the failure of a too-wide window is a
 * silently dropped second enquiry.
 *
 * @param {string} slug
 * @param {Record<string, any>} lead
 * @returns {string|null} null when there is nothing stable to dedupe on.
 */
function dedupeKey(slug, lead) {
  const identity = String(lead?.email || lead?.phone || "").toLowerCase().trim();
  if (!identity) return null;
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  return createHash("sha256").update(`${slug}:${identity}:${bucket}`).digest("hex");
}

/** Attribution parameters, wherever the engine happened to put them. */
const ATTRIBUTION_RE = /^(utm_.*|gclid|fbclid|ttclid|ref)$/;

/**
 * @param {Record<string, any>} record
 * @returns {Record<string, unknown>}
 */
function attributionOf(record) {
  const explicit = record.utm || record.meta?.utm;
  if (explicit && typeof explicit === "object") return explicit;
  return Object.fromEntries(Object.entries(record).filter(([k]) => ATTRIBUTION_RE.test(k)));
}

/* ========================================================================== *
 *  The Postgres path
 * ========================================================================== */

/**
 * @typedef {object} Stored  What the queue did with a lead.
 * @property {string|null} leadId   Set only when there are fresh rows to drain.
 * @property {boolean} queueOwnsIt  True when the queue will deliver this lead.
 *
 * `queueOwnsIt` is the whole answer the caller needs, and it is deliberately NOT
 * `Boolean(leadId)`. Those came apart in two directions, both of which reached
 * the operator:
 *
 * - A DEDUPED resubmit has no rows to drain — the first submit queued them —
 *   but the queue does own the delivery. Reading it off a null lead id fanned
 *   out a second copy through the legacy path, so a double-tapped submit button
 *   sent the CRM and the alert inbox the same lead twice. Which is the exact
 *   thing `unique (lead_id, target_id)` and the whole fence exist to prevent,
 *   undone at the call site.
 * - A lead stored with `queued === 0` (no `delivery_target` row for the client,
 *   which is every deployment the moment it turns Postgres on, since nothing
 *   creates those rows yet) has a lead id and NOBODY to deliver it. Reading it
 *   off a truthy id suppressed the fan-out and took the operator's webhook and
 *   "new lead" alert silently dark.
 */

/**
 * Store a lead and queue its deliveries in one transaction.
 *
 * @param {Record<string, any>} record
 * @param {string|null} ip
 * @returns {Promise<Stored>}
 */
async function storeLead(record, ip) {
  /** Nothing was stored, so the direct fan-out is the only delivery left. */
  const fallBack = { leadId: null, queueOwnsIt: false };

  const slug = String(record.funnelId || "");
  if (!slug) {
    console.warn("[runtime] lead with no funnelId — falling back to the direct fan-out");
    return fallBack;
  }

  // `ip` and `user_agent` are columns, and the raw IP is never one of them.
  const { ip: _ip, user_agent: _ua, utm: _utm, referer: _referer, ...payload } = record;

  try {
    const [out] = await rpc("ingest_lead", {
      p_slug: slug,
      p_payload: payload,
      p_utm: attributionOf(record),
      p_consent: record.meta?.consent ?? record.consent ?? null,
      p_email_verified: Boolean(record.lead?.email_verified),
      p_ip_hash: hashIp(ip),
      p_user_agent: oneLine(record.user_agent, 400),
      p_dedupe_key: dedupeKey(slug, record.lead || {}),
    });

    if (out?.deduped) {
      // Not a failure and not a fallback: the first submit already queued the
      // deliveries. Fanning out here would send the operator the same lead
      // twice, and draining would re-send rows another attempt already owns.
      console.warn(`[runtime] duplicate submit within the dedupe window for ${oneLine(slug, 80)}`);
      return { leadId: null, queueOwnsIt: true };
    }
    if (!out?.lead_id) return fallBack;

    if (!out.queued) {
      // Stored, with nobody to deliver it. Until the console can create delivery
      // targets (WO12), that is the state EVERY deployment is in the moment it
      // configures Postgres — so this falls through to the fan-out rather than
      // logging a warning into a queue that will never move. No double send:
      // with zero delivery rows there is nothing for the queue to deliver.
      console.warn(
        `[runtime] no delivery_target for ${oneLine(slug, 80)} — lead stored, delivering via the direct fan-out`,
      );
      return { leadId: null, queueOwnsIt: false };
    }
    return { leadId: out.lead_id, queueOwnsIt: true };
  } catch (err) {
    // Three shapes, one response to the visitor and three different log lines,
    // because they need three different things from the operator:
    //   not_found   — the funnel has no client row yet. Deliver the old way.
    //   unavailable — Supabase is down, or the service-role key was rotated and
    //                 never updated. Deliver the old way, loudly.
    //   rejected    — the row itself was refused. A bug here, not an outage.
    const kind = dbErrorKind(err);
    const level = kind === "unavailable" ? console.error : console.warn;
    level(`[runtime] lead not queued (${kind}) for ${oneLine(slug, 80)}: ${errSummary(err)} — delivering directly`);
    return fallBack;
  }
}

/**
 * @param {Record<string, any>} record
 * @returns {Promise<boolean>} true when the event was stored.
 */
async function storeEvent(record) {
  const slug = String(record.funnelId || "");
  const sessionId = String(record.sessionId || "");
  const type = String(record.type || "");
  if (!slug || !sessionId || !type) return false;

  try {
    await rpc("ingest_event", {
      p_slug: slug,
      p_session_id: oneLine(sessionId, 200),
      p_type: oneLine(type, 60),
      p_step_id: record.stepId ? oneLine(record.stepId, 200) : null,
      p_meta: record.meta ?? null,
    });
    return true;
  } catch (err) {
    // Drop-off analytics, not a lead. Logged, never escalated, never retried.
    console.warn(`[runtime] event not stored (${dbErrorKind(err)}): ${errSummary(err)}`);
    return false;
  }
}

/* ========================================================================== *
 *  Route
 * ========================================================================== */

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

  if (path === "/api/events") {
    const stored = dbConfigured() ? await storeEvent(record) : false;
    void persist("events", record, { fanOut: !stored });
    return json({ ok: true }, 202, CORS);
  }

  const { leadId, queueOwnsIt } = dbConfigured()
    ? await storeLead(record, ip)
    : { leadId: null, queueOwnsIt: false };

  // The queue owns delivery now, so the direct fan-out runs only when the queue
  // did not take responsibility for this lead. Both running would send the
  // operator two copies; neither running would lose the lead outright — which is
  // why this reads `queueOwnsIt` rather than inferring it from `leadId`.
  // The JSONL sink is written either way — it is the console's lead inbox and
  // the operator's own copy, not a delivery channel.
  void persist("leads", record, { fanOut: !queueOwnsIt });

  // The first attempt happens here rather than waiting for the cron drain, so a
  // working webhook fires in the same second the visitor submitted. It goes
  // through the same `FOR UPDATE SKIP LOCKED` claim the drain uses, so a drain
  // running concurrently cannot send the same delivery twice.
  //
  // Deliberately not awaited: the visitor is mid-funnel. If the process is
  // suspended before it finishes, the rows are already durable and stay leased
  // for five minutes before the sweeper returns them to the queue — the outcome
  // is a late delivery, never a lost one. `req.signal` cuts it short when the
  // visitor's connection is gone.
  if (leadId) {
    void drainOnce({ leadId, signal: req.signal }).catch((err) => {
      console.warn(`[runtime] inline delivery attempt failed: ${errSummary(err)}`);
    });
  }

  return json({ ok: true }, 202, CORS);
}
