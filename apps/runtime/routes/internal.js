/**
 * @file `/api/internal/*` — the machine surface. One route today: the drain.
 *
 * The inline attempt in `/api/lead` delivers the common case in the same second
 * a visitor submits. This is what covers everything else: the endpoint that was
 * down, the delivery that was leased by an invocation the platform froze, the
 * backlog that built up while a client's CRM was being migrated. A `pg_cron` job
 * calls it every minute through `pg_net` (see `supabase/cron.sql`).
 *
 * It is NOT behind the admin gate — see `INTERNAL_SECRET` in `lib/config.js` for
 * why the secrets are separate, and `requireInternal` in `lib/auth.js` for the
 * gate itself. The router dispatches this module inside that branch, so nothing
 * here re-checks authentication and nothing here may be reached without it.
 *
 * The sweeper that returns expired leases to the queue is deliberately absent:
 * it runs as pure SQL inside Postgres on its own schedule, so the recovery
 * mechanism does not depend on this server being reachable. A drain endpoint
 * that is itself the only way to recover from the drain being unreachable is not
 * a recovery mechanism.
 */

import { drainOnce } from "../lib/delivery.js";
import { dbConfigured } from "../lib/db.js";
import { json } from "../lib/http.js";
import { errSummary } from "../lib/log.js";

/**
 * How long one drain call keeps claiming batches.
 *
 * This is a claiming deadline, not a hard wall-clock ceiling: an attempt already
 * in flight when it passes is left to finish under its own `DELIVERY_TIMEOUT_MS`
 * rather than being cut off, because aborting a request the target may already
 * have processed turns a slow delivery into a duplicate one.
 *
 * The straddling chunk is bounded by four things, not one, so the real worst
 * case at the defaults is the sum rather than the headline number:
 *
 *   DRAIN_BUDGET_MS   25s   this deadline
 *   DNS_TIMEOUT_MS     3s   the name lookup in `resolveSafeTarget`, which takes
 *                           no signal and so is bounded only by its own race
 *   DELIVERY_TIMEOUT_MS 10s the attempt itself
 *   DB_TIMEOUT_MS       5s  the `complete_delivery`/`fail_delivery` that follows
 *                       ---
 *                       43s
 *
 * Inside `pg_net`'s 55s timeout in `supabase/cron.sql`, inside Vercel's 60s
 * Hobby limit, and far inside the 5-minute Fluid ceiling and the claim lease.
 * Note that `EMAIL_TIMEOUT_MS` substitutes for `DELIVERY_TIMEOUT_MS` on an email
 * target: raising one without the other quietly raises this total.
 *
 * Read per call rather than captured at import, matching `lib/store.js` and
 * `lib/db.js`: these are the knobs an operator reaches for when the drain is
 * misbehaving, and a value frozen at module load is the surprise nobody expects.
 */
const budgetMs = () => Math.max(1000, Number(process.env.DRAIN_BUDGET_MS) || 25_000);

/** Rows per claim. One `FOR UPDATE SKIP LOCKED` statement's worth. */
const batchSize = () => Math.max(1, Number(process.env.DRAIN_BATCH) || 25);

/**
 * @param {Request} req
 * @param {{ path: string }} ctx
 * @returns {Promise<Response|null>} null when this is not an internal route.
 */
export async function handleInternal(req, ctx) {
  if (ctx.path !== "/api/internal/drain") return null;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);

  const startedAt = Date.now();
  const deadline = startedAt + budgetMs();
  const batch = batchSize();
  const totals = { claimed: 0, done: 0, failed: 0, dead: 0, passes: 0 };

  try {
    // Loop rather than one batch: a minute's backlog can be deeper than one
    // claim, and waiting for the next cron tick to take the next 25 rows turns a
    // ten-minute outage into an hour of catching up. Bounded three ways — the
    // deadline, an exhausted claim, and the caller giving up.
    //
    // The deadline is passed DOWN as well as checked here. Checking it only
    // between passes bounded how many passes start, not how long one runs, and
    // a pass beginning a millisecond under budget could still add ~50s of
    // in-flight attempts on top.
    while (Date.now() < deadline && !req.signal.aborted) {
      const counts = await drainOnce({ limit: batch, signal: req.signal, deadline });
      totals.passes++;
      totals.claimed += counts.claimed;
      totals.done += counts.done;
      totals.failed += counts.failed;
      totals.dead += counts.dead;
      // A short batch means the queue is empty right now. Anything that arrives
      // after this point is the next tick's problem, or the inline attempt's.
      if (counts.claimed < batch) break;
    }
  } catch (err) {
    // Report what was delivered before the failure rather than swallowing it:
    // the cron job's own log is the only place this is ever seen, and "500 with
    // no numbers" and "delivered 200 then died" need different responses.
    console.error(`[drain] aborted after ${totals.done} deliveries: ${errSummary(err)}`);
    return json({ ok: false, ...totals, ms: Date.now() - startedAt }, 500);
  }

  return json({ ok: true, ...totals, ms: Date.now() - startedAt });
}
