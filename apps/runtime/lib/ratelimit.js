/**
 * @file The abuse limiter and the global outbound-mail ceiling.
 *
 * Backed by Postgres now. `rate_hit()` (`supabase/migrations/*_phase1_functions.sql`)
 * makes every ceiling durable and shared across every instance a deployment
 * runs — which the in-process `Map` this file used to be built around never
 * was. See PHASE-1-PLAN.md §4.1 for the failure that forced the move: with N
 * instances, every limit below used to be N times looser than the number
 * configured, and `MAIL_HOURLY_CAP` — the one ceiling whose key a caller cannot
 * rotate — is exactly the limit that mattered.
 *
 * The `Map` did not go away. It is now the FALLBACK, not the design: `rateLimit`
 * degrades to it when no database is configured, or when `rate_hit` throws for
 * any reason. That degrade is deliberate — ingest must never fail a visitor, and
 * a limiter that blocks or 500s on a database blip is a worse outage than the
 * abuse it exists to stop. The fallback is never worse than the status quo
 * before this file called Postgres at all, so failing the request over a
 * database hiccup was never on the table.
 */

import { dbConfigured, rpc } from "./db.js";
import { CORS, json } from "./http.js";
import { errSummary } from "./log.js";

/**
 * @typedef {{ windowMs: number, hits: number[] }} Bucket
 * @type {Map<string, Bucket>} sliding windows keyed by action + subject.
 *
 * The window is stored WITH the bucket. It used to be a bare `number[]`, and the
 * prune below then tested every bucket against whichever `windowMs` the current
 * caller happened to pass. An exhausted bucket stops appending timestamps, so an
 * hourly bucket sitting at its ceiling looked "older than 60s" to the very next
 * `ingest:` call — which deletes it, resetting the limit. That made
 * `MAIL_HOURLY_CAP`, the one ceiling whose key a caller cannot rotate, resettable
 * about once a minute by any unauthenticated request to `/api/events`.
 *
 * Reachable only through the fallback path below — see the `@file` header.
 */
const rateBuckets = new Map();

/**
 * Last time the RPC-failure fallback logged, so an outage under real ingest
 * traffic writes one line a minute instead of one line per request. A database
 * being down is already the incident; flooding the log on every one of dozens
 * of requests a second would be a second one.
 */
let lastRpcFallbackWarnAt = 0;

/**
 * Fixed-cost sliding-window limiter, in this process's heap. Unchanged from the
 * pre-Postgres implementation — this is exactly what every deployment ran
 * before `rate_hit` existed, and it is what every deployment still runs with no
 * database configured, or mid-outage.
 *
 * @param {string} key
 * @param {number} max
 * @param {number} windowMs
 * @returns {boolean} true when the call is allowed.
 */
function inMemoryRateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key)?.hits || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rateBuckets.set(key, { windowMs, hits });
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, { windowMs, hits });

  // Opportunistic prune so a long-running server cannot grow this unbounded.
  // Each bucket is judged against its OWN window, never the caller's.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.hits.length || now - v.hits[v.hits.length - 1] > v.windowMs) rateBuckets.delete(k);
    }
  }
  return true;
}

/**
 * The one rate limiter in the codebase — every caller from `/api/lead` to the
 * admin test-email route goes through this, so a new endpoint cannot pick up a
 * weaker check by accident.
 *
 * With a database configured, this calls `rate_hit(p_key, p_max, p_window_ms)`
 * and returns its answer directly. Anything that stops that call from
 * completing — no database configured, a timeout, a 5xx, a rotated key — falls
 * back to `inMemoryRateLimit` rather than throwing or blocking. See the `@file`
 * header for why that direction is safe and the other direction is not.
 *
 * @param {string} key
 * @param {number} max
 * @param {number} windowMs
 * @returns {Promise<boolean>} true when the call is allowed.
 */
export async function rateLimit(key, max, windowMs) {
  if (!dbConfigured()) return inMemoryRateLimit(key, max, windowMs);

  try {
    return Boolean(await rpc("rate_hit", { p_key: key, p_max: max, p_window_ms: windowMs }));
  } catch (err) {
    const now = Date.now();
    if (now - lastRpcFallbackWarnAt > 60_000) {
      lastRpcFallbackWarnAt = now;
      console.warn(`[ratelimit] rate_hit unavailable, falling back to the in-process bucket: ${errSummary(err)}`);
    }
    return inMemoryRateLimit(key, max, windowMs);
  }
}

export const tooMany = () => json({ error: "rate_limited" }, 429, CORS);

/**
 * Absolute ceiling on outbound mail per hour, across every caller — shared by
 * the OTP challenge and the lead autoresponder.
 *
 * The per-address and per-IP limits are the everyday guards; this one exists
 * because the per-IP key comes from `x-forwarded-for`, which the caller sets.
 * Bounding the total means the worst case is a capped amount of outbound mail
 * rather than an open relay. Generous by default so a real funnel never notices.
 *
 * Any new endpoint that mails a caller-supplied address needs this ceiling too,
 * not just a per-address limit — the caller picks the addresses.
 */
export const MAIL_HOURLY_CAP = Math.max(1, Number(process.env.MAIL_MAX_PER_HOUR) || 500);
