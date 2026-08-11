/**
 * @file The delivery dispatcher — what turns a claimed queue row into an
 * outbound call, and what it reports back to Postgres afterwards.
 *
 * This replaces the `Promise.allSettled` fan-out in `persist()` for everything
 * that leaves the server. The difference is not the sending, it is the
 * remembering: the old fan-out logged a failure and forgot the lead existed, so
 * a webhook that was down for ten minutes cost the client every lead that
 * arrived in those ten minutes. Here a failure is a row that still says
 * `pending` with a `next_attempt_at` in the future.
 *
 * Three rules the rest of the file follows:
 *
 * - **The claim is the only authority.** A dispatcher reports the outcome with
 *   `(attempts, idempotency_key)` from the claim it was handed. If those no
 *   longer match the row, the transition is refused — a call that outlived its
 *   lease cannot decide the fate of a claim someone else now owns.
 * - **Retry unless the refusal came from us, and can only ever come from us.**
 *   An HTTP error of any shape gets the backoff. Permanent is reserved for a
 *   refusal whose cause cannot change on its own — a URL the egress guard
 *   rejects on sight, a kind nothing dispatches — because retrying those eight
 *   times changes nothing and delays the operator seeing them in the dead-letter
 *   list. A DNS failure is NOT one of those, however much it looks like one.
 * - **Never log an error object from a `fetch`.** Bun puts the full request URL
 *   on `err.path`, and a webhook URL routinely carries a token in its path.
 *   `errSummary(err)` only — same rule as `forwardWebhook` and the CAPI forward.
 */

import { dbErrorKind, rpc } from "./db.js";
import { leadNotificationEmail, sendEmail } from "./email.js";
import { errSummary, oneLine } from "./log.js";
import { MAIL_HOURLY_CAP, rateLimit } from "./ratelimit.js";
import { isSafeWebhookTarget, resolveSafeTarget } from "./webhook.js";

/**
 * Per-attempt ceiling. Well under the 5-minute lease, so a hung endpoint gives
 * the row back to the queue long before the sweeper has to.
 *
 * Read per call rather than captured at import — same rule as `lib/store.js`
 * and `lib/db.js`. These are the knobs an operator reaches for when delivery is
 * misbehaving, and a value frozen at module load is a setting that appears to
 * have no effect.
 */
const attemptTimeoutMs = () => Math.max(1000, Number(process.env.DELIVERY_TIMEOUT_MS) || 10_000);

/** How many deliveries are in flight at once inside one drain. */
const maxParallel = () => Math.max(1, Number(process.env.DELIVERY_PARALLEL) || 5);

/**
 * @typedef {object} Claim  One row of `claim_deliveries`.
 * @property {number} delivery_id
 * @property {string} lead_id
 * @property {number} attempts
 * @property {string} idempotency_key
 * @property {string} kind
 * @property {Record<string, any>} config
 * @property {string} funnel_slug
 * @property {Record<string, any>} payload
 * @property {Record<string, any>|null} utm
 * @property {Record<string, any>|null} consent
 * @property {string} lead_created_at
 *
 * @typedef {{ ok: boolean, status: number|null, error: string|null, permanent?: boolean }} Outcome
 */

/**
 * Rebuild the record shape the old fan-out shipped, so an automation already
 * receiving OpenFunnel webhooks keeps parsing them after this change.
 *
 * Two fields the old shape had are deliberately gone: `ip` and `referer`. The
 * IP is stored hashed and never leaves, and neither belongs in a payload sent
 * to a third party the visitor never consented to.
 *
 * @param {Claim} claim
 */
function recordOf(claim) {
  // Stripped here as well as at ingest, not instead of. Ingest keeps them out of
  // the column; this keeps them out of the request even if a row predates that
  // change or arrives from a future writer — the two are different failures and
  // only one of them is undoable, because this one has already left the server.
  const { ip: _ip, referer: _referer, user_agent: _ua, ...payload } = claim.payload || {};
  return {
    ...payload,
    funnelId: claim.funnel_slug,
    utm: claim.utm || {},
    ...(claim.consent ? { consent: claim.consent } : {}),
    received_at: claim.lead_created_at,
  };
}

/**
 * Abort this attempt when it runs long, and also when the caller's own signal
 * fires — the inline path runs inside a request that Vercel can cut off, and a
 * fetch nobody is waiting on any more should not hold the invocation open.
 *
 * @param {AbortSignal} [outer]
 */
function attemptSignal(outer) {
  const own = AbortSignal.timeout(attemptTimeoutMs());
  return outer ? AbortSignal.any([own, outer]) : own;
}

/* ========================================================================== *
 *  Per-kind dispatch
 * ========================================================================== */

/**
 * @param {Claim} claim
 * @param {AbortSignal} [signal]
 * @returns {Promise<Outcome>}
 */
async function deliverWebhook(claim, signal) {
  const raw = String(claim.config?.url || "");
  if (!raw) return { ok: false, status: null, error: "target has no url", permanent: true };

  // Every outbound call to an operator-supplied URL goes through the egress
  // guard, which resolves the name and refuses loopback, the private ranges and
  // the cloud metadata address.
  //
  // `resolveSafeTarget` returns null for two different things, and they must not
  // share a verdict: a URL that is wrong (loopback literal, private range, a
  // scheme that is not HTTP) can never start working, while a name it could not
  // RESOLVE may just be a resolver having a bad minute. Treating both as
  // permanent meant one DNS outage dead-lettered every webhook delivery in the
  // system on its first attempt — found by running it end to end, where a
  // perfectly ordinary `.invalid` host died instantly.
  //
  // So the textual check decides permanence, and it is the conservative way
  // round: a hostname that really does resolve into a private range costs eight
  // pointless attempts before dying, which is cheaper than the alternative of
  // losing leads to a blip.
  const target = await resolveSafeTarget(raw);
  if (!target) {
    return isSafeWebhookTarget(raw)
      ? { ok: false, status: null, error: "target did not resolve to a vettable address" }
      : { ok: false, status: null, error: "blocked egress target", permanent: true };
  }

  /** @type {Record<string, string>} */
  const headers = {
    "content-type": "application/json",
    // The receiver's defence against a retry it already processed. Stable
    // across every attempt of one delivery, and rotated by `resend_delivery`
    // so a deliberate re-send is a new message rather than a suppressed one.
    "idempotency-key": String(claim.idempotency_key),
    ...target.headers,
  };
  if (claim.config?.secret) headers["x-webhook-secret"] = oneLine(String(claim.config.secret), 512);

  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(recordOf(claim)),
      redirect: "manual", // a 302 would sidestep the target check above
      signal: attemptSignal(signal),
    });
    return res.ok
      ? { ok: true, status: res.status, error: null }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, error: errSummary(err) };
  }
}

/**
 * @param {Claim} claim
 * @param {AbortSignal} [signal]
 * @returns {Promise<Outcome>}
 */
async function deliverEmail(claim, signal) {
  const to = String(claim.config?.to || "").trim();
  if (!to) return { ok: false, status: null, error: "target has no recipient", permanent: true };

  // Same absolute ceiling the fan-out's notification used, and the same bucket:
  // one cap over all lead alerts, so N clients cannot each get their own 500.
  // A breach retries rather than dying — the backoff reaches 40 minutes by the
  // fifth attempt, which is inside the hour the bucket needs to drain.
  if (!rateLimit("notify-global", MAIL_HOURLY_CAP, 60 * 60 * 1000)) {
    return { ok: false, status: null, error: "mail hourly ceiling reached — see MAIL_MAX_PER_HOUR" };
  }

  const { subject, html } = leadNotificationEmail(recordOf(claim));
  // The caller's raw signal, not `attemptSignal(signal)`: `sendEmail` applies its
  // own EMAIL_TIMEOUT_MS, and wrapping one timeout in another only builds a
  // second AbortSignal that can never fire first.
  const sent = await sendEmail({ to, subject, html, signal });
  return sent.ok
    ? { ok: true, status: null, error: null }
    : { ok: false, status: null, error: String(sent.error || "send failed") };
}

/**
 * Dispatch one claimed delivery. Never throws: the caller has to be able to
 * report an outcome for every claim it took, and an exception here would leave
 * the row leased until the sweeper reclaims it five minutes later.
 *
 * @param {Claim} claim
 * @param {AbortSignal} [signal]
 * @returns {Promise<Outcome>}
 */
export async function dispatch(claim, signal) {
  try {
    if (claim.kind === "webhook") return await deliverWebhook(claim, signal);
    if (claim.kind === "email") return await deliverEmail(claim, signal);
    // `sheet` is in the schema's check constraint but has no dispatcher yet.
    // Permanent rather than retried, so it shows up in the dead-letter list on
    // the first attempt instead of looking like a slow delivery for twelve
    // hours. A kind nothing dispatches must never look like one that works.
    return { ok: false, status: null, error: `no dispatcher for kind "${oneLine(claim.kind, 40)}"`, permanent: true };
  } catch (err) {
    return { ok: false, status: null, error: errSummary(err) };
  }
}

/* ========================================================================== *
 *  The claim → dispatch → settle loop
 * ========================================================================== */

/**
 * Report an outcome back to Postgres. A `false` from `complete_delivery` or a
 * `null` from `fail_delivery` means the fence rejected us — another claimer owns
 * the row now — which is the system working, not an error.
 *
 * @param {Claim} claim
 * @param {Outcome} out
 * @returns {Promise<"done"|"pending"|"dead"|"superseded"|"unreported">}
 */
async function settle(claim, out) {
  const fence = { p_id: claim.delivery_id, p_attempt: claim.attempts, p_key: claim.idempotency_key };
  try {
    if (out.ok) {
      const applied = await rpc("complete_delivery", { ...fence, p_status: out.status });
      return applied ? "done" : "superseded";
    }
    const status = await rpc("fail_delivery", {
      ...fence,
      p_status: out.status,
      p_error: oneLine(out.error || "delivery failed", 500),
      // 0 means "already past the ceiling at attempt 1", i.e. dead immediately.
      ...(out.permanent ? { p_max_attempts: 0 } : {}),
    });
    if (status === "dead") {
      // WO13 turns this into a real alert. Until then the loud line is the only
      // thing standing between a dead delivery and nobody ever noticing it.
      console.error(
        `[delivery] DEAD ${claim.kind} delivery ${claim.delivery_id} for funnel ` +
          `${oneLine(claim.funnel_slug, 80)}: ${oneLine(out.error || "", 200)}`,
      );
    }
    return status === null ? "superseded" : /** @type {"pending"|"dead"} */ (status);
  } catch (err) {
    // The delivery may well have gone out; we just could not record it. Say so
    // and leave it — the lease expires and the sweeper puts it back. That risks
    // one duplicate, which is why the receiver gets an `Idempotency-Key`.
    console.warn(
      `[delivery] could not record outcome for ${claim.delivery_id} (${dbErrorKind(err)}): ${errSummary(err)}`,
    );
    return "unreported";
  }
}

/**
 * Claim a batch and deliver it. One call is one drain pass — the cron job loops
 * by running again, not by looping in here, so a single invocation can never
 * outlive its function timeout no matter how deep the backlog is.
 *
 * `leadId` is what makes the inline first attempt share this path: it claims
 * only the rows for one lead, through the same `FOR UPDATE SKIP LOCKED`
 * statement the drain uses, so the two cannot double-send.
 *
 * `deadline` bounds the work INSIDE this call, which is not the same as the
 * caller checking the clock between calls. One pass is `limit / DELIVERY_PARALLEL`
 * sequential chunks, each able to sit at `DELIVERY_TIMEOUT_MS`, so at the
 * defaults a single pass can run ~50s — a caller that only checked its budget
 * before starting a pass could therefore overshoot it by that much, sail past
 * `pg_net`'s own 55s timeout, and have the cron job record a timeout while this
 * server carried on working. Checked here, the overshoot is bounded by one
 * attempt instead of one pass.
 *
 * In-flight attempts are deliberately NOT aborted when the deadline passes:
 * they are already bounded by `DELIVERY_TIMEOUT_MS`, and cutting off a request
 * the target may have already processed converts a slow delivery into a
 * duplicate one. The deadline stops us CLAIMING more, which is the part that
 * actually grows without bound.
 *
 * @param {{ limit?: number, leadId?: string|null, signal?: AbortSignal, deadline?: number }} [opts]
 * @returns {Promise<{ claimed: number, done: number, failed: number, dead: number }>}
 */
export async function drainOnce({ limit = 25, leadId = null, signal, deadline } = {}) {
  const claims = /** @type {Claim[]} */ (
    await rpc("claim_deliveries", { p_limit: limit, p_lead_id: leadId })
  );

  const counts = { claimed: claims.length, done: 0, failed: 0, dead: 0 };

  const parallel = maxParallel();
  for (let i = 0; i < claims.length; i += parallel) {
    // Rows claimed but never touched simply stay leased and expire back to
    // pending five minutes later — late, never lost.
    if (signal?.aborted) break;
    if (deadline && Date.now() >= deadline) break;
    const results = await Promise.all(
      claims.slice(i, i + parallel).map(async (claim) => settle(claim, await dispatch(claim, signal))),
    );
    for (const r of results) {
      if (r === "done") counts.done++;
      else if (r === "dead") counts.dead++;
      else if (r === "pending") counts.failed++;
    }
  }

  return counts;
}
