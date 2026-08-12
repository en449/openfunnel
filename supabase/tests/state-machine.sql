-- ===========================================================================
-- Delivery state-machine check.
--
-- The smallest runnable thing that fails if the queue stops behaving like
-- PHASE-1-PLAN.md §3 says it does. No framework, no fixtures: one transaction
-- that ends in ROLLBACK, so it can be run against any database carrying this
-- schema — including a live one — without leaving a row behind.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/state-machine.sql
--
-- Every check is an `assert`. A failure names the rule it broke, because six
-- months from now the useful part of a red test is which invariant died, not
-- which line number.
-- ===========================================================================

begin;

do $$
declare
  v_client  uuid;
  v_funnel  uuid;
  v_funnel2 uuid;
  v_target1 uuid;
  v_target2 uuid;
  v_lead    uuid;
  v_lead2   uuid;
  v_lead3   uuid;
  v_lead4   uuid;
  v_queued  int;
  v_dedup   boolean;
  v_id      bigint;
  v_id2     bigint;
  v_n       int;
  v_status  text;
  v_key     uuid;
  v_key2    uuid;
  v_rlkey   text;
  v_next    timestamptz;
begin
  /* --- fixtures ------------------------------------------------------- */

  insert into client (name, slug, contact_email)
    values ('Check Client', 'check-client-' || gen_random_uuid(), 'nobody@example.invalid')
    returning id into v_client;

  insert into funnel (client_id, slug, name, doc, status)
    values (v_client, 'check-funnel-' || gen_random_uuid(), 'Check', '{}'::jsonb, 'live')
    returning id into v_funnel;

  insert into delivery_target (client_id, funnel_id, kind, config)
    values (v_client, null, 'webhook', '{"url":"https://a.invalid/h"}'::jsonb)
    returning id into v_target1;

  insert into delivery_target (client_id, funnel_id, kind, config)
    values (v_client, v_funnel, 'email', '{"to":"nobody@example.invalid"}'::jsonb)
    returning id into v_target2;

  /* --- ingest: one lead, one delivery row per enabled target ---------- */

  select l.lead_id, l.queued, l.deduped into v_lead, v_queued, v_dedup
    from ingest_lead((select slug from funnel where id = v_funnel),
                     '{"lead":{"email":"a@example.invalid"}}'::jsonb,
                     null, null, false, null, null, 'dedupe-a') l;

  assert v_lead is not null,  'ingest_lead returned no lead id';
  assert v_queued = 2,        format('expected 2 delivery rows, got %s', v_queued);
  assert v_dedup = false,     'first insert must not report deduped';
  -- ingest_lead takes no client_id parameter at all, so this pins the
  -- propagation rather than a defence: the value has to come off the funnel row.
  assert (select client_id from lead where id = v_lead) = v_client,
         'client_id must be resolved from the funnel row';

  /* --- dedupe: a double submit costs one delivery, not two ------------ */

  select l.lead_id, l.queued, l.deduped into v_lead2, v_queued, v_dedup
    from ingest_lead((select slug from funnel where id = v_funnel),
                     '{"lead":{"email":"a@example.invalid"}}'::jsonb,
                     null, null, false, null, null, 'dedupe-a') l;

  assert v_dedup = true,      'second insert with the same dedupe_key must report deduped';
  assert v_queued = 0,        'a deduped lead must queue nothing';
  assert v_lead2 = v_lead,    'a deduped lead must return the id of the row that already exists';
  assert (select count(*) from delivery where lead_id = v_lead) = 2,
         'dedupe must not add delivery rows';

  /* --- ingest: a funnel with no enabled target must still queue 0, not error -
   *
   * A real lead id together with queued = 0 is the state CLAUDE.md names the
   * queueOwnsIt bug class: the runtime has to fan out, because nothing else
   * will ever deliver this lead. Until now only a stubbed fetch in
   * apps/runtime/test/ingest-queue.test.js pinned this — assert the SQL side
   * of the contract too.
   */

  insert into funnel (client_id, slug, name, doc, status)
    values (v_client, 'check-funnel2-' || gen_random_uuid(), 'Check 2', '{}'::jsonb, 'live')
    returning id into v_funnel2;

  -- v_target1 has funnel_id = null, i.e. "every funnel of this client" (see
  -- the fixtures above), so a naive second funnel would inherit it for free
  -- and this fixture would not be target-less at all. Disable it for exactly
  -- the width of this check and restore it before the claim assertions below
  -- rely on it again. v_target2 needs no such treatment — it is already
  -- scoped to v_funnel by funnel_id and was never going to match v_funnel2.
  update delivery_target set enabled = false where id = v_target1;

  select l.lead_id, l.queued, l.deduped into v_lead3, v_queued, v_dedup
    from ingest_lead((select slug from funnel where id = v_funnel2),
                     '{"lead":{"email":"b@example.invalid"}}'::jsonb,
                     null, null, false, null, null, 'dedupe-b') l;

  assert v_lead3 is not null, 'ingest_lead must still create the lead row when a funnel has no enabled target';
  assert v_queued = 0, format('a funnel with no enabled target must queue 0 rows, got %s', v_queued);
  assert v_dedup = false, 'a fresh dedupe_key must not report deduped';
  assert exists (select 1 from lead where id = v_lead3),
         'the lead row must exist even though nothing was queued to deliver it — this is the row the fan-out has to find';

  update delivery_target set enabled = true where id = v_target1;

  -- Mirror, so this check cannot pass by ingest being broken for everyone: the
  -- original, fully-targeted funnel must still queue both rows.
  select l.lead_id, l.queued, l.deduped into v_lead4, v_queued, v_dedup
    from ingest_lead((select slug from funnel where id = v_funnel),
                     '{"lead":{"email":"c@example.invalid"}}'::jsonb,
                     null, null, false, null, null, 'dedupe-c') l;

  assert v_queued = 2, format('the original, fully-targeted funnel must still queue 2 rows, got %s', v_queued);

  /* --- unknown slug is distinguishable from an outage ----------------- */

  begin
    perform ingest_lead('no-such-funnel', '{}'::jsonb);
    assert false, 'an unknown slug must raise, so the runtime can tell it from a Supabase outage';
  exception when sqlstate 'PT404' then
    -- PT404, not P0002: PostgREST maps its own PTxxx range onto HTTP status
    -- codes, so this is what reaches the runtime as a 404. A plain P0002 comes
    -- back as a generic 500, i.e. indistinguishable from the database being
    -- down — and the runtime would then degrade forward for a funnel that has
    -- no targets to deliver to.
    null;
  end;

  /* --- claim: leases the row, counts the attempt ---------------------- */

  select count(*) into v_n from claim_deliveries(10, v_lead);
  assert v_n = 2, format('expected to claim 2 rows, got %s', v_n);

  select count(*) into v_n from delivery
   where lead_id = v_lead and status = 'delivering' and attempts = 1;
  assert v_n = 2, 'a claim must set status=delivering and increment attempts';

  select count(*) into v_n from delivery
   where lead_id = v_lead and next_attempt_at > now() + interval '4 minutes';
  assert v_n = 2, 'a claim must set the 5-minute lease on next_attempt_at';

  -- The whole point of SKIP LOCKED: nobody else can pick these up.
  select count(*) into v_n from claim_deliveries(10, v_lead);
  assert v_n = 0, 'a claimed row must not be claimable again — this is the double-send guard';

  /* --- fail: back to pending, on the backoff schedule ------------------ */

  select id, idempotency_key into v_id, v_key from delivery where lead_id = v_lead order by id limit 1;
  select fail_delivery(v_id, 1, v_key, 502, 'upstream 502') into v_status;
  assert v_status = 'pending', format('attempt 1 of 8 must retry, got %s', v_status);

  select next_attempt_at into v_next from delivery where id = v_id;
  -- backoff(1) = 30s · 3 = 90s
  assert v_next between now() + interval '80 seconds' and now() + interval '100 seconds',
         'a failed attempt must be rescheduled on delivery_backoff(attempts)';
  assert (select last_status from delivery where id = v_id) = 502,
         'fail_delivery must record the HTTP status the console shows';

  -- A transition only fires from the state it expects.
  select fail_delivery(v_id, 1, v_key, 500, 'late response') into v_status;
  assert v_status is null, 'fail_delivery must be a no-op on a row that is not delivering';

  /* --- complete -------------------------------------------------------- */

  select id, idempotency_key into v_id2, v_key2 from delivery where lead_id = v_lead order by id desc limit 1;
  assert complete_delivery(v_id2, 1, v_key2, 200), 'complete_delivery must apply to a delivering row';
  assert (select status from delivery where id = v_id2) = 'done', 'completed row must be done';
  assert (select delivered_at from delivery where id = v_id2) is not null,
         'a done row must carry delivered_at — the client report prints it';
  assert complete_delivery(v_id2, 1, v_key2, 200) = false,
         'complete_delivery must be a no-op the second time';

  /* --- sweeper: a dead invocation must not strand a lead --------------- */

  -- Asserted on the row, not on the sweeper's return count: `sweep_stuck_
  -- deliveries()` is database-wide, so counting its result would make this file
  -- pass only against an empty database — which is exactly the claim in the
  -- header that it can be run anywhere.
  update delivery set status = 'delivering', next_attempt_at = now() - interval '1 minute'
   where id = v_id;
  perform sweep_stuck_deliveries();
  assert (select status from delivery where id = v_id) = 'pending',
         'the sweeper must reclaim a row whose lease expired';

  -- ...and must not touch one whose lease is still running.
  update delivery set status = 'delivering', next_attempt_at = now() + interval '5 minutes'
   where id = v_id;
  perform sweep_stuck_deliveries();
  assert (select status from delivery where id = v_id) = 'delivering',
         'the sweeper must leave a live lease alone';

  /* --- fencing: a superseded claim must not decide the outcome ----------
   *
   * The interleaving the whole system produces on its own: an invocation hangs
   * past its lease, the sweeper reclaims, the drain re-claims as a new attempt,
   * and only then does the original invocation answer. Without a fence it wins,
   * and either the row reads 'done' with nothing delivered, or a stale failure
   * pushes a live claim back to 'pending' and the lead goes out twice.
   */

  update delivery set status = 'pending', attempts = 0, next_attempt_at = now()
   where id = v_id;
  perform claim_deliveries(1, v_lead);          -- episode 1: attempts = 1
  update delivery set next_attempt_at = now() - interval '1 minute' where id = v_id;
  perform sweep_stuck_deliveries();
  update delivery set next_attempt_at = now() where id = v_id;
  perform claim_deliveries(1, v_lead);          -- episode 2: attempts = 2
  assert (select attempts from delivery where id = v_id) = 2, 'setup: expected a second claim';

  assert complete_delivery(v_id, 1, v_key, 200) = false,
         'a completion from a superseded claim must not mark the row done';
  assert (select status from delivery where id = v_id) = 'delivering',
         'the live claim must still own the row after a stale completion';

  select fail_delivery(v_id, 1, v_key, 500, 'stale failure') into v_status;
  assert v_status is null, 'a failure from a superseded claim must not requeue the row';
  assert (select status from delivery where id = v_id) = 'delivering',
         'the live claim must still own the row after a stale failure';
  assert (select last_error from delivery where id = v_id) is distinct from 'stale failure',
         'a superseded claim must not overwrite what the console shows';

  assert complete_delivery(v_id, 2, v_key, 200), 'the live claim must be able to complete its own row';

  /* --- dead letter ----------------------------------------------------- */

  update delivery set status = 'delivering', attempts = 1 where id = v_id;
  select fail_delivery(v_id, 1, v_key, 500, 'still down', 1) into v_status;
  assert v_status = 'dead', format('attempts past the ceiling must go dead, got %s', v_status);

  /* --- manual re-send rotates the idempotency key ---------------------- */

  select idempotency_key into v_key from delivery where id = v_id;
  assert resend_delivery(v_id), 'a dead row must be re-sendable';
  assert (select status from delivery where id = v_id) = 'pending', 're-send must requeue';
  assert (select attempts from delivery where id = v_id) = 0, 're-send must reset attempts';
  assert (select idempotency_key from delivery where id = v_id) <> v_key,
         'a manual re-send must mint a NEW key, or the receiver dedupes it into a no-op';

  -- ...and the reset of `attempts` is exactly why the fence cannot be `attempts`
  -- alone. Re-claiming after a re-send hands out attempts = 1 again — the same
  -- number an episode before the re-send was given — so a stale answer from
  -- that episode would match on the number and decide an outcome it does not
  -- own. The idempotency key is what separates the generations.
  update delivery set next_attempt_at = now() where id = v_id;
  perform claim_deliveries(1, v_lead);
  assert (select attempts from delivery where id = v_id) = 1,
         'setup: a re-sent row is claimed as attempt 1 again';
  assert complete_delivery(v_id, 1, v_key, 200) = false,
         'a pre-resend key must not complete a post-resend claim, even at the same attempt number';
  assert (select status from delivery where id = v_id) = 'delivering',
         'the post-resend claim must still own the row';

  /* --- Art. 18: restriction cancels what has not gone out yet ---------- */

  -- Put one row in each state that matters, so the assertions below can tell
  -- "cancels pending" from "cancels everything".
  update delivery set status = 'pending' where id = v_id;
  update delivery set status = 'done', delivered_at = now() where id = v_id2;

  update lead set restricted = true where id = v_lead;
  assert (select status from delivery where id = v_id) = 'cancelled',
         'restricting a lead must cancel its pending deliveries';
  -- A delivered lead was already handed over; retracting the record would tell
  -- the operator something untrue about what the client received.
  assert (select status from delivery where id = v_id2) = 'done',
         'restriction must not retract a delivery that already went out';

  assert resend_delivery(v_id2) = false,
         'a restricted lead must not be re-sendable — it would park in pending forever';

  update delivery set status = 'pending', next_attempt_at = now() where lead_id = v_lead;
  select count(*) into v_n from claim_deliveries(10, v_lead);
  assert v_n = 0, 'a restricted lead must never be claimed, even with pending rows';

  -- cancel_pending_on_restrict fires on `restricted` OR `deleted_at` (§3.1 rule
  -- 5), and everything above has only ever driven the `restricted` branch.
  -- Rebuild the same shape — v_id genuinely pending, v_id2 genuinely done —
  -- right before deleted_at is set, or the trigger finds nothing pending to
  -- cancel and the assertion below would pass whether or not the deleted_at
  -- branch exists at all. v_id is already pending here: the reset two lines
  -- up put every row for this lead back to pending, and the claim attempt
  -- just above found nothing to claim (restricted was still true), so it
  -- never left pending. v_id2 needs putting back explicitly, since that same
  -- reset also caught it.
  update delivery set status = 'done', delivered_at = now() where id = v_id2;

  update lead set restricted = false, deleted_at = now() where id = v_lead;
  assert (select status from delivery where id = v_id) = 'cancelled',
         'soft-deleting a lead must cancel its pending deliveries — the deleted_at branch of cancel_pending_on_restrict';
  -- Same mirror as the restricted case above: a delivery already handed over
  -- must not be retracted by a deletion any more than by a restriction.
  assert (select status from delivery where id = v_id2) = 'done',
         'soft-deletion must not retract a delivery that already went out';

  select count(*) into v_n from claim_deliveries(10, v_lead);
  assert v_n = 0, 'a soft-deleted lead must never be claimed';

  /* --- a disabled target stops dispatching ----------------------------- */

  update lead set deleted_at = null where id = v_lead;
  update delivery_target set enabled = false where client_id = v_client;
  update delivery set status = 'pending', next_attempt_at = now() where lead_id = v_lead;
  select count(*) into v_n from claim_deliveries(10, v_lead);
  assert v_n = 0, 'a disabled target must not be dispatched to';

  /* --- backoff shape ---------------------------------------------------- */

  assert delivery_backoff(0) = interval '30 seconds', 'backoff(0) must be 30s';
  assert delivery_backoff(7) = interval '12 hours',   'backoff must cap at 12h';
  assert delivery_backoff(99) = interval '12 hours',  'backoff must stay capped';

  /* --- rate limiter ------------------------------------------------------ */

  -- Keyed per run like every other fixture in this file. A shared literal key
  -- cannot corrupt anything (the upsert takes a row lock and the whole file
  -- rolls back), but two concurrent runs would serialise on that one row while
  -- nothing else here does.
  v_rlkey := 'check:rl:' || gen_random_uuid();
  assert rate_hit(v_rlkey, 2, 60000) = true,  'first hit under the ceiling must pass';
  assert rate_hit(v_rlkey, 2, 60000) = true,  'second hit at the ceiling must pass';
  assert rate_hit(v_rlkey, 2, 60000) = false, 'the hit past the ceiling must be refused';

  -- Each bucket is judged by its OWN window. Testing every bucket against the
  -- current caller's window is what made the hourly mail cap resettable by any
  -- unauthenticated request to /api/events.
  update rate_bucket set window_start = now() - interval '2 minutes' where key = v_rlkey;
  assert rate_hit(v_rlkey, 2, 60000) = true, 'an expired window must reset the count';
  assert (select count from rate_bucket where key = v_rlkey) = 1,
         'a window reset must restart the count at 1, not keep accumulating';

  raise notice 'state-machine check: all assertions passed';
end $$;

rollback;
