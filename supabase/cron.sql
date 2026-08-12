-- ===========================================================================
-- pg_cron schedule — PHASE-1-PLAN.md §3.3 and §4.5.
--
-- DELIBERATELY NOT IN migrations/. The drain job needs two values that do not
-- exist until something is deployed: a reachable URL and a secret in Vault. A
-- migration that applied with a placeholder would schedule a job that quietly
-- POSTs into nothing every minute, which is worse than one nobody has run.
--
-- Run by hand against the Supabase project, in two parts. PART A needs nothing
-- and should be running already; PART B needs the deployment. Splitting them is
-- not tidiness: the sweeper is what recovers leads stranded by a dead function,
-- and it has no reason to wait for the thing that strands them.
--
-- Scheduling from Postgres rather than Vercel Cron is the point: the schedule
-- lives next to the queue it drains, it survives a bad Vercel deploy, and it
-- does not depend on the Pro cron tier.
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

/* ==========================================================================
 * PART A — no deployment required. Safe to run today.
 * ========================================================================== */

/* --- The stuck-delivering sweeper -----------------------------------------
 * Every minute, as pure SQL — no HTTP call, on purpose. A Vercel outage must
 * not also take out the mechanism that recovers from a Vercel timeout. Without
 * this, a function that dies mid-batch strands its claimed rows in
 * 'delivering' forever and the leads are silently lost, which is the exact
 * failure this project exists to prevent.
 */
select cron.schedule('openfunnel-sweep', '* * * * *', $job$
  select sweep_stuck_deliveries();
$job$);

-- Rate buckets are write-heavy and worthless once their window has passed.
select cron.schedule('openfunnel-rate-gc', '17 * * * *', $job$
  delete from rate_bucket where window_start < now() - interval '1 day';
$job$);

-- Expired and consumed challenges. The retention here is what bounds how long
-- `isEmailVerified()` can answer true, so do not lengthen it casually.
select cron.schedule('openfunnel-otp-gc', '23 * * * *', $job$
  delete from otp where expires_at < now() - interval '1 day';
$job$);

-- Drop-off events at 90 days (PLAN.md §8.7). Leads are NOT purged here — their
-- horizon is per-client (`client.retention_months`) and that job is Phase 2,
-- deliberately, because deleting a client's leads on the wrong schedule is not
-- a bug you can undo.
select cron.schedule('openfunnel-event-purge', '40 3 * * *', $job$
  delete from event where created_at < now() - interval '90 days';
$job$);

/* ==========================================================================
 * PART B — the retry drain. Needs a URL pg_net can actually reach.
 *
 * Prerequisites, all three:
 *
 *   1. A deployment whose `/api/internal/drain` answers. Use the BRANCH ALIAS,
 *      not a deployment URL: `openfunnel-git-<branch>-<team>.vercel.app` follows
 *      the newest deployment of that branch, while `openfunnel-<hash>-…` pins
 *      this job to one build forever — including its environment variables, so
 *      a rotated secret would take the drain down with no error anywhere.
 *
 *   2. `INTERNAL_SECRET` set in that deployment's environment, and the SAME
 *      value in Vault. Never inline it in a cron command: `cron.job` is readable
 *      by anyone who can read the catalog, and this secret is the only thing
 *      standing in front of every lead in the database.
 *        select vault.create_secret('<same value as INTERNAL_SECRET>', 'internal_secret');
 *
 *   3. While the target is a PROTECTED PREVIEW — which is where this runs until
 *      the project is split into a public `funnel` project and a private
 *      `console` one (PLAN.md §2) — Vercel Authentication answers 302 to every
 *      machine caller, including this one. A 302 is not an error pg_net reports
 *      as a failure, so the drain would look scheduled and healthy and do
 *      nothing. Generate a bypass in the Vercel dashboard (Settings →
 *      Deployment Protection → Protection Bypass for Automation) and store it
 *      the same way:
 *        select vault.create_secret('<the bypass secret>', 'vercel_bypass');
 *      Drop the `x-vercel-protection-bypass` header once the drain is served by
 *      an unprotected project — the header is inert there, but a header nobody
 *      needs is a secret nobody rotates.
 * ========================================================================== */

-- select cron.schedule('openfunnel-drain', '* * * * *', $job$
--   select net.http_post(
--     url     := 'https://openfunnel-git-phase-1-delivery-queue-enno-s-projects.vercel.app/api/internal/drain',
--     headers := jsonb_build_object(
--                  'content-type', 'application/json',
--                  'authorization', 'Bearer ' || (select decrypted_secret
--                                                   from vault.decrypted_secrets
--                                                  where name = 'internal_secret'),
--                  'x-vercel-protection-bypass', (select decrypted_secret
--                                                   from vault.decrypted_secrets
--                                                  where name = 'vercel_bypass')),
--     body    := '{}'::jsonb,
--     timeout_milliseconds := 55000
--   );
-- $job$);

/* --- Prove it before trusting it ------------------------------------------
 * The drain answering 200 is the whole point, and a scheduled job that 302s
 * looks identical to one that works. Run this once by hand and read the
 * response — anything other than 200 means the queue is not draining.
 *
 *   select net.http_post(
 *     url := 'https://openfunnel-git-phase-1-delivery-queue-enno-s-projects.vercel.app/api/internal/drain',
 *     headers := jsonb_build_object(
 *                  'content-type', 'application/json',
 *                  'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret'),
 *                  'x-vercel-protection-bypass', (select decrypted_secret from vault.decrypted_secrets where name = 'vercel_bypass')),
 *     body := '{}'::jsonb) as request_id;
 *
 *   -- a few seconds later, with that id:
 *   select status_code, content from net._http_response where id = <request_id>;
 */

-- Verify:      select jobname, schedule, active from cron.job;
-- Recent runs: select jobname, status, return_message, start_time
--                from cron.job_run_details order by start_time desc limit 20;
-- Remove one:  select cron.unschedule('openfunnel-drain');
