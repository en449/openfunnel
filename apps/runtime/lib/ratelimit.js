/**
 * @file The abuse limiter and the global outbound-mail ceiling.
 *
 * Everything here is a `Map` in this process's heap, which is a deliberate
 * trade — no Redis to run, no shared state to operate — and a real constraint:
 * the limits are per-process, so they reset on restart and do not compose across
 * replicas. `server.js` prints that at boot under NODE_ENV=production and the
 * README says it twice, because the failure is silent: with N instances every
 * ceiling below is effectively N times looser than the number configured.
 */

import { CORS, json } from "./http.js";

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
 */
const rateBuckets = new Map();

/**
 * Fixed-cost sliding-window limiter. In-memory and therefore per-process —
 * enough to stop scripted abuse of the mail and OTP endpoints, not a
 * substitute for an edge rate limit on a multi-instance deploy.
 *
 * @returns {boolean} true when the call is allowed.
 */
export function rateLimit(key, max, windowMs) {
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
