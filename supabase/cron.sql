-- ===========================================================================
-- pg_cron schedule — PHASE-1-PLAN.md §3.3.
--
-- DELIBERATELY NOT IN migrations/. Two of the values below do not exist yet:
-- the deployed drain URL and the shared secret in Supabase Vault. A migration
-- that applies with a placeholder URL would schedule a job that quietly POSTs
-- into nothing every minute, which is worse than one that has not been run.
--
-- Run this by hand, once, against the Supabase project, after:
--   1. the `funnel` Vercel project is deployed and `/api/internal/drain` answers
--   2. INTERNAL_SECRET is set in that project's environment
--   3. the same secret is stored in Vault (step 0 below)
--
-- Scheduling from Postgres rather than Vercel Cron is the point: the schedule
-- lives next to the queue it drains, it survives a bad Vercel deploy, and it
-- does not depend on the Pro cron tier.
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 0. The secret. Never inline it in a cron command — cron.job is readable by
--    anyone who can read the catalog, and the drain secret is the only thing
--    standing in front of every lead in the database. `requireInternal` in
--    apps/runtime/lib/auth.js also accepts `x-internal-secret` if a header named
--    `authorization` is ever inconvenient here.
--    select vault.create_secret('<the-same-value-as-INTERNAL_SECRET>', 'internal_secret');

/* --- 1. The retry drain ---------------------------------------------------
 * Every minute. Claims a batch of 25 and dispatches; see /api/internal/drain.
 * Replace <FUNNEL_HOST> with the deployed public project's hostname.
 */
select cron.schedule('openfunnel-drain', '* * * * *', $job$
  select net.http_post(
    url     := 'https://<FUNNEL_HOST>/api/internal/drain',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'authorization', 'Bearer ' || (select decrypted_secret
                                                  from vault.decrypted_secrets
                                                 where name = 'internal_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$job$);

/* --- 2. The stuck-delivering sweeper --------------------------------------
 * Every minute, as pure SQL — no HTTP call, on purpose. A Vercel outage must
 * not also take out the mechanism that recovers from a Vercel timeout. Without
 * this, a function that dies mid-batch strands its claimed rows in
 * 'delivering' forever and the leads are silently lost, which is the exact
 * failure this project exists to prevent.
 */
select cron.schedule('openfunnel-sweep', '* * * * *', $job$
  select sweep_stuck_deliveries();
$job$);

/* --- 3. Housekeeping ------------------------------------------------------ */

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

-- Verify:      select jobname, schedule, active from cron.job;
-- Recent runs: select jobname, status, return_message, start_time
--                from cron.job_run_details order by start_time desc limit 20;
-- Remove one:  select cron.unschedule('openfunnel-drain');
