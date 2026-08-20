-- ===========================================================================
-- Retention purge check — WO D5.
--
-- Same shape as subject-rights.sql: one transaction ending in ROLLBACK, every
-- check an `assert` naming the rule it broke, runnable against any database
-- carrying this schema including a live one.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/purge.sql
--
-- What is worth asserting here is not "purge_expired() deletes old rows". It
-- is the ways this job stops being safe to run unattended, on a schedule,
-- with nobody watching: a horizon computed from the wrong client, a floor
-- that stops protecting a slipped `retention_months = 0`, a restriction it
-- was supposed to honour, a hard delete that reaches a session another lead
-- still needs, a run that silently skips logging itself. Each rule below is
-- pinned to a sentence in the migration's own header, not to whatever the
-- code happens to do today — see 20260819140000_retention_purge.sql.
--
-- One structural fact this file leans on throughout: `now()` is the
-- TRANSACTION's start time in Postgres, frozen for every statement inside
-- this one `begin ... rollback`. A fixture stamped `now() - interval '25
-- hours'` stays exactly 25 hours old no matter how many of this file's own
-- `purge_expired()` calls run before it is checked — there is no wall-clock
-- drift to account for, and none of the interval margins below are a race.
-- ===========================================================================

begin;

do $$
declare
  v_tag                    text := 'purge-' || substr(gen_random_uuid()::text, 1, 8);

  v_client_a                uuid;
  v_client_b                uuid;
  v_client_zero              uuid;
  v_client_capped            uuid;
  v_funnel_a                 uuid;
  v_funnel_b                 uuid;
  v_funnel_zero               uuid;
  v_funnel_capped             uuid;
  v_target                   uuid;

  v_lead_a_expired            uuid;
  v_lead_a_fresh               uuid;
  v_lead_b_sameage              uuid;
  v_lead_a_restricted            uuid;
  v_lead_zero_recent              uuid;
  v_delivery_a_expired            bigint;

  v_lead_soft23                  uuid;
  v_lead_hard25                   uuid;
  v_delivery_hard25                bigint;
  v_lead_hard25_restricted          uuid;
  v_lead_shared_victim               uuid;
  v_lead_shared_survivor              uuid;
  v_lead_nosession                     uuid;
  v_lead_emptysession                   uuid;

  v_lead_capped1                         uuid;
  v_lead_capped2                          uuid;

  -- scratch: the receipt from whichever purge_expired() call just ran
  v_events_expired int;
  v_leads_expired  int;
  v_leads_erased   int;
  v_events_erased  int;
  v_sessions_kept  int;
  v_capped         boolean;

  -- scratch: the purge_run row that call is supposed to have written
  v_pr_events_expired int;
  v_pr_leads_expired  int;
  v_pr_leads_erased   int;
  v_pr_events_erased  int;
  v_pr_sessions_kept  int;
  v_pr_capped         boolean;

  v_n           int;
  v_n2          int;
  v_deleted_at  timestamptz;
  v_status      text;
begin
  /* ======================================================================
   * FIXTURES — clients and funnels shared by every scenario below. Four
   * clients because the horizon test needs two DIFFERENT retention_months
   * values live at once, and the floor test needs a third set to exactly 0
   * (the console does not write this field today, but a slip in a future
   * settings form is precisely the scenario the header calls out).
   * ==================================================================== */

  insert into client (name, slug, contact_email, retention_months)
       values ('Purge Client A', v_tag || '-a', 'a@example.invalid', 3)
       returning id into v_client_a;
  insert into client (name, slug, contact_email, retention_months)
       values ('Purge Client B', v_tag || '-b', 'b@example.invalid', 24)
       returning id into v_client_b;
  insert into client (name, slug, contact_email, retention_months)
       values ('Purge Client Zero', v_tag || '-zero', 'zero@example.invalid', 0)
       returning id into v_client_zero;
  insert into client (name, slug, contact_email, retention_months)
       values ('Purge Client Capped', v_tag || '-capped', 'capped@example.invalid', 1)
       returning id into v_client_capped;

  insert into funnel (client_id, slug, name, doc)
       values (v_client_a, v_tag || '-fa', 'Funnel A', '{"steps":[]}'::jsonb)
       returning id into v_funnel_a;
  insert into funnel (client_id, slug, name, doc)
       values (v_client_b, v_tag || '-fb', 'Funnel B', '{"steps":[]}'::jsonb)
       returning id into v_funnel_b;
  insert into funnel (client_id, slug, name, doc)
       values (v_client_zero, v_tag || '-fzero', 'Funnel Zero', '{"steps":[]}'::jsonb)
       returning id into v_funnel_zero;
  insert into funnel (client_id, slug, name, doc)
       values (v_client_capped, v_tag || '-fcapped', 'Funnel Capped', '{"steps":[]}'::jsonb)
       returning id into v_funnel_capped;

  insert into delivery_target (client_id, funnel_id, kind, config)
       values (v_client_a, null, 'webhook', '{}'::jsonb) returning id into v_target;

  /* ======================================================================
   * CALL 0 — an empty run still logs a row.
   *
   * Nothing has been inserted into `lead` or `event` yet in this
   * transaction (and every other test file's fixtures were rolled back
   * before this one began), so this is a genuinely empty table. The header
   * of `purge_run`'s own comment: "an empty table cannot distinguish a
   * database with nothing to purge from a cron job that was never
   * scheduled" — which is exactly the bug a conditional insert (only write
   * the row when something happened) would reintroduce.
   * ==================================================================== */

  select events_expired, leads_expired, leads_erased, events_erased,
         sessions_kept, capped
    into v_events_expired, v_leads_expired, v_leads_erased, v_events_erased,
         v_sessions_kept, v_capped
    from purge_expired();

  assert v_events_expired = 0 and v_leads_expired = 0 and v_leads_erased = 0
     and v_events_erased = 0 and v_sessions_kept = 0 and v_capped = false,
         format('a run against empty tables must report all zeros, got events_expired=%s leads_expired=%s leads_erased=%s events_erased=%s sessions_kept=%s capped=%s',
                v_events_expired, v_leads_expired, v_leads_erased, v_events_erased, v_sessions_kept, v_capped);

  select count(*) into v_n from purge_run;
  assert v_n = 1,
         format('purge_run must gain exactly one row for a call that deleted nothing, got %s rows total after the first call', v_n);

  /* ======================================================================
   * SECTION A fixtures — step 1 (events at 90 days) and step 2 (leads past
   * their client's horizon), including the trigger that must fire when
   * step 2 stamps deleted_at.
   * ==================================================================== */

  -- #A1/#A2: the 90-day event boundary. Neither session id is used by any
  -- lead below, so step 3's session logic (a later call in this same
  -- transaction) can never touch these — this pair tests step 1 in
  -- isolation.
  insert into event (funnel_id, session_id, type, created_at)
       values (v_funnel_a, 'sess-90day-old-' || v_tag, 'view', now() - interval '91 days');
  insert into event (funnel_id, session_id, type, created_at)
       values (v_funnel_a, 'sess-90day-recent-' || v_tag, 'view', now() - interval '89 days');

  -- #A3: past client A's own 3-month horizon. Carries a pending delivery so
  -- the same fixture also proves the trigger side of step 2.
  insert into lead (funnel_id, client_id, payload, created_at)
       values (v_funnel_a, v_client_a, '{}'::jsonb, now() - interval '4 months')
       returning id into v_lead_a_expired;
  insert into delivery (lead_id, target_id, status)
       values (v_lead_a_expired, v_target, 'pending') returning id into v_delivery_a_expired;

  -- #A4: well inside client A's 3-month horizon — the negative control for
  -- #A3, same client, must survive.
  insert into lead (funnel_id, client_id, payload, created_at)
       values (v_funnel_a, v_client_a, '{}'::jsonb, now() - interval '1 month')
       returning id into v_lead_a_fresh;

  -- #A5: the same AGE as #A3 (4 months) but under client B, whose horizon is
  -- 24 months. This is the pair the header's "own horizon" sentence exists
  -- for — a query that forgot the join to `client` and used one global
  -- interval would expire this lead too.
  insert into lead (funnel_id, client_id, payload, created_at)
       values (v_funnel_b, v_client_b, '{}'::jsonb, now() - interval '4 months')
       returning id into v_lead_b_sameage;

  -- #A6: ancient (5 years) AND restricted. Age alone would expire this many
  -- times over; only the restriction is standing between it and step 2.
  insert into lead (funnel_id, client_id, payload, restricted, created_at)
       values (v_funnel_a, v_client_a, '{}'::jsonb, true, now() - interval '5 years')
       returning id into v_lead_a_restricted;

  -- #A7: client Zero's retention_months is 0. Without `greatest(…, 1)` the
  -- horizon collapses to `now() - interval '0 months'`, i.e. everything the
  -- client has ever received — so a lead created a minute ago must still
  -- survive on the strength of the one-month floor alone.
  insert into lead (funnel_id, client_id, payload, created_at)
       values (v_funnel_zero, v_client_zero, '{}'::jsonb, now() - interval '1 minute')
       returning id into v_lead_zero_recent;

  select events_expired, leads_expired, leads_erased, events_erased,
         sessions_kept, capped
    into v_events_expired, v_leads_expired, v_leads_erased, v_events_erased,
         v_sessions_kept, v_capped
    from purge_expired();

  -- #A1/#A2: exactly the 91-day event is gone, the 89-day one is not.
  assert v_events_expired = 1,
         format('step 1 must expire exactly the 91-day-old event, got events_expired=%s', v_events_expired);
  select count(*) into v_n from event where funnel_id = v_funnel_a and session_id = 'sess-90day-old-' || v_tag;
  assert v_n = 0, 'an event older than 90 days must actually be gone, not merely counted as gone';
  select count(*) into v_n from event where funnel_id = v_funnel_a and session_id = 'sess-90day-recent-' || v_tag;
  assert v_n = 1, 'an event at 89 days must survive — the 90-day cutoff is not a "close enough" horizon';

  -- #A3/#A4/#A5/#A6/#A7: exactly one lead (client A's 4-month-old one) is
  -- stamped this call.
  assert v_leads_expired = 1,
         format('step 2 must stamp exactly client A''s expired lead, got leads_expired=%s', v_leads_expired);

  -- The stamped lead is SOFT-deleted, and — the header's own sentence — "the
  -- same run never both expires and erases the same lead": it still exists
  -- as a row when the function returns.
  select deleted_at into v_deleted_at from lead where id = v_lead_a_expired;
  assert v_deleted_at is not null,
         'a lead past its client''s horizon must be soft-deleted (deleted_at stamped), not left untouched';
  select count(*) into v_n from lead where id = v_lead_a_expired;
  assert v_n = 1,
         'a lead expired by step 2 must still exist as a row when purge_expired() returns — step 3 in the SAME call must not also erase it';

  select deleted_at into v_deleted_at from lead where id = v_lead_a_fresh;
  assert v_deleted_at is null, 'a lead younger than its client''s horizon must be untouched';

  select deleted_at into v_deleted_at from lead where id = v_lead_b_sameage;
  assert v_deleted_at is null,
         'the SAME age lead under client B (24-month horizon) must stay fresh while client A''s same-age lead expires — each client gets its own horizon in the one run';

  select deleted_at into v_deleted_at from lead where id = v_lead_a_restricted;
  assert v_deleted_at is null,
         'a restricted lead must NEVER be stamped by the retention sweep, however old it is (Art. 18)';

  select deleted_at into v_deleted_at from lead where id = v_lead_zero_recent;
  assert v_deleted_at is null,
         'retention_months = 0 must not mean "delete everything" — the one-month floor must protect a lead created minutes ago';

  -- The trigger: client A's expired lead had one PENDING delivery, and step
  -- 2's UPDATE ... SET deleted_at = now() is exactly the transition
  -- `cancel_pending_on_restrict()` (20260811120100) fires on.
  select status into v_status from delivery where id = v_delivery_a_expired;
  assert v_status = 'cancelled',
         format('a pending delivery for a lead the retention sweep just soft-deleted must be cancelled by lead_restrict_cancels_pending, got %s', v_status);

  -- No hard deletes or event-erasure happened this call — nothing was
  -- already soft-deleted more than 24h ago yet.
  assert v_leads_erased = 0 and v_events_erased = 0 and v_sessions_kept = 0,
         format('step 3 must have nothing to do yet this call, got leads_erased=%s events_erased=%s sessions_kept=%s',
                v_leads_erased, v_events_erased, v_sessions_kept);
  assert v_capped = false, format('nothing in this fixture should hit the default limit, got capped=%s', v_capped);

  -- The logged row must agree with the receipt this call returned — the
  -- console reads one, an operator running this by hand reads the other.
  select events_expired, leads_expired, leads_erased, events_erased, sessions_kept, capped
    into v_pr_events_expired, v_pr_leads_expired, v_pr_leads_erased, v_pr_events_erased, v_pr_sessions_kept, v_pr_capped
    from purge_run order by id desc limit 1;
  assert v_pr_events_expired = v_events_expired and v_pr_leads_expired = v_leads_expired
     and v_pr_leads_erased = v_leads_erased and v_pr_events_erased = v_events_erased
     and v_pr_sessions_kept = v_sessions_kept and v_pr_capped = v_capped,
         'the purge_run row logged for this call must carry the exact same counts as the receipt it returned';

  select count(*) into v_n from purge_run;
  assert v_n = 2, format('purge_run must have exactly 2 rows after 2 calls, got %s', v_n);

  /* ======================================================================
   * SECTION B fixtures — step 3: the soft deletes old enough to erase.
   * ==================================================================== */

  -- #B1: soft-deleted 23 hours ago — younger than the 24h window, must
  -- survive this call.
  insert into lead (funnel_id, client_id, payload, deleted_at)
       values (v_funnel_a, v_client_a, '{}'::jsonb, now() - interval '23 hours')
       returning id into v_lead_soft23;

  -- #B2: soft-deleted 25 hours ago, sole occupant of its session. Carries a
  -- delivery row so the hard delete's cascade is exercised for real, not
  -- assumed from the `on delete cascade` clause alone.
  insert into lead (funnel_id, client_id, payload, deleted_at)
       values (v_funnel_a, v_client_a,
               ('{"sessionId":"sess-alone-' || v_tag || '"}')::jsonb, now() - interval '25 hours')
       returning id into v_lead_hard25;
  insert into delivery (lead_id, target_id, status)
       values (v_lead_hard25, v_target, 'pending') returning id into v_delivery_hard25;
  insert into event (funnel_id, session_id, type)
       values (v_funnel_a, 'sess-alone-' || v_tag, 'view');

  -- #B3: soft-deleted 25 hours ago AND restricted. The header is explicit
  -- that step 3 does NOT re-check the flag — a deleted_at already set was
  -- either an Art. 17 erasure (which outranks the restriction) or step 2's
  -- own check, already applied.
  insert into lead (funnel_id, client_id, payload, restricted, deleted_at)
       values (v_funnel_a, v_client_a, '{}'::jsonb, true, now() - interval '25 hours')
       returning id into v_lead_hard25_restricted;

  -- #B4/#B5: the shared-session pair — two leads, one funnel, one session,
  -- one being hard-deleted and one still alive. This is the conservative
  -- choice the header commits to: the session must be KEPT, not emptied,
  -- because a surviving lead still sits on it.
  insert into lead (funnel_id, client_id, payload, deleted_at)
       values (v_funnel_a, v_client_a,
               ('{"sessionId":"sess-shared-' || v_tag || '"}')::jsonb, now() - interval '25 hours')
       returning id into v_lead_shared_victim;
  insert into lead (funnel_id, client_id, payload, created_at)
       values (v_funnel_a, v_client_a,
               ('{"sessionId":"sess-shared-' || v_tag || '"}')::jsonb, now())
       returning id into v_lead_shared_survivor;
  insert into event (funnel_id, session_id, type)
       values (v_funnel_a, 'sess-shared-' || v_tag, 'view');

  -- #B6: a matching victim with NO sessionId key at all.
  insert into lead (funnel_id, client_id, payload, deleted_at)
       values (v_funnel_a, v_client_a, '{"lead":{"email":"nosession-purge@example.invalid"}}'::jsonb, now() - interval '25 hours')
       returning id into v_lead_nosession;

  -- #B7: a matching victim whose sessionId is the empty string — reaches
  -- this table because /api/lead validates nothing about it (the same
  -- fixture shape subject-rights.sql uses for erase_subject). An unrelated
  -- event carries the SAME empty string as its own session_id (inserted
  -- directly — /api/events refuses one, but the SQL must not lean on a
  -- guard that lives in a JavaScript file it cannot see). Without the
  -- `nullif(…, '')` wrapper in step 3's `victims` CTE, this lead's
  -- "session" reads as '' rather than NULL, and '' = '' would wrongly claim
  -- this stranger's event as belonging to it — two absences agreeing where
  -- nothing was ever shared.
  insert into lead (funnel_id, client_id, payload, deleted_at)
       values (v_funnel_a, v_client_a,
               '{"lead":{"email":"emptysession-purge@example.invalid"},"sessionId":""}'::jsonb, now() - interval '25 hours')
       returning id into v_lead_emptysession;
  insert into event (funnel_id, session_id, type)
       values (v_funnel_a, '', 'view');

  select events_expired, leads_expired, leads_erased, events_erased,
         sessions_kept, capped
    into v_events_expired, v_leads_expired, v_leads_erased, v_events_erased,
         v_sessions_kept, v_capped
    from purge_expired();

  -- Nothing new for steps 1/2 this call.
  assert v_events_expired = 0 and v_leads_expired = 0,
         format('no new step-1/step-2 candidates were added this call, got events_expired=%s leads_expired=%s',
                v_events_expired, v_leads_expired);

  -- #B2, #B3, #B4 (victim), #B6, #B7 = 5 hard deletes. #B1 (23h) and #B5
  -- (never soft-deleted) are excluded.
  assert v_leads_erased = 5,
         format('step 3 must erase exactly the five soft-deletes older than 24h, got leads_erased=%s', v_leads_erased);

  -- Only #B2's session ("sess-alone") is emptied; #B4/#B5's shared session
  -- must be KEPT because #B5 is still alive, and #B6/#B7 have no session to
  -- reach at all — so exactly one event is actually deleted.
  assert v_events_erased = 1,
         format('only the sole-occupant session''s single event may be deleted, got events_erased=%s', v_events_erased);
  assert v_sessions_kept = 1,
         format('the shared session must be counted as kept, not silently dropped from the receipt, got sessions_kept=%s', v_sessions_kept);
  assert v_capped = false, format('this fixture is far under the default limit, got capped=%s', v_capped);

  -- #B1: survives, untouched.
  select count(*) into v_n from lead where id = v_lead_soft23;
  assert v_n = 1, 'a lead soft-deleted only 23 hours ago must survive — the 24h window is not a "close enough" grace period';

  -- #B2: gone, and its delivery went with it via `on delete cascade` — not
  -- merely because nothing else references it.
  select count(*) into v_n from lead where id = v_lead_hard25;
  assert v_n = 0, 'a lead soft-deleted 25 hours ago must be hard-deleted';
  select count(*) into v_n from delivery where id = v_delivery_hard25;
  assert v_n = 0, 'a hard-deleted lead''s delivery rows must go with it via the cascade, not linger as orphans';
  select count(*) into v_n from event where funnel_id = v_funnel_a and session_id = 'sess-alone-' || v_tag;
  assert v_n = 0, 'the sole occupant''s events must actually be gone once its session is emptied, not merely counted as gone';

  -- #B3: gone despite `restricted = true` — step 3 does not re-check the
  -- flag once deleted_at is already set.
  select count(*) into v_n from lead where id = v_lead_hard25_restricted;
  assert v_n = 0,
         'a lead already soft-deleted must be hard-deleted after 24h even when restricted is true — step 3 deliberately does not re-check Art. 18';

  -- #B4/#B5: the victim is gone, the survivor and the shared session's
  -- event are both untouched.
  select count(*) into v_n from lead where id = v_lead_shared_victim;
  assert v_n = 0, 'the shared session''s hard-deleted lead must actually be gone';
  select deleted_at into v_deleted_at from lead where id = v_lead_shared_survivor;
  assert v_deleted_at is null,
         'the OTHER lead on a shared session must be completely untouched — a shared SESSION is left alone, never a stranger''s LEAD';
  select count(*) into v_n from event where funnel_id = v_funnel_a and session_id = 'sess-shared-' || v_tag;
  assert v_n = 1,
         'a shared session''s events must be KEPT when a surviving lead still sits on it — this is the deliberate conservative choice, and the assertion most likely to pass by accident if step 3 deletes events unconditionally';

  -- #B6/#B7: gone, and the call did not crash reaching for a session that
  -- was never there.
  select count(*) into v_n from lead where id = v_lead_nosession;
  assert v_n = 0, 'a victim lead with no sessionId key at all must still be hard-deleted, with no event claimed on its behalf';
  select count(*) into v_n from lead where id = v_lead_emptysession;
  assert v_n = 0, 'a victim lead with sessionId = "" must be hard-deleted the same way — an empty string is not a session to reach';
  select count(*) into v_n from event where funnel_id = v_funnel_a and session_id = '';
  assert v_n = 1,
         'an unrelated event that happens to carry session_id = '''' must survive the empty-sessionId victim''s hard delete — two absences are not the same session, and losing the nullif(…, '''') wrapper is exactly the bug that would delete it';

  select events_expired, leads_expired, leads_erased, events_erased, sessions_kept, capped
    into v_pr_events_expired, v_pr_leads_expired, v_pr_leads_erased, v_pr_events_erased, v_pr_sessions_kept, v_pr_capped
    from purge_run order by id desc limit 1;
  assert v_pr_leads_erased = v_leads_erased and v_pr_events_erased = v_events_erased
     and v_pr_sessions_kept = v_sessions_kept,
         'the purge_run row logged for the step-3 call must carry the same counts as its receipt';

  select count(*) into v_n from purge_run;
  assert v_n = 3, format('purge_run must have exactly 3 rows after 3 calls, got %s', v_n);

  /* ======================================================================
   * SECTION C — `capped`, and calling purge_expired() twice in the same
   * transaction.
   *
   * Two leads, both past client Capped's 1-month horizon, called with
   * p_limit = 1: only one may be stamped, and the receipt must say so.
   * ==================================================================== */

  insert into lead (funnel_id, client_id, payload, created_at)
       values (v_funnel_capped, v_client_capped, '{}'::jsonb, now() - interval '2 months')
       returning id into v_lead_capped1;
  insert into lead (funnel_id, client_id, payload, created_at)
       values (v_funnel_capped, v_client_capped, '{}'::jsonb, now() - interval '2 months')
       returning id into v_lead_capped2;

  select events_expired, leads_expired, leads_erased, events_erased,
         sessions_kept, capped
    into v_events_expired, v_leads_expired, v_leads_erased, v_events_erased,
         v_sessions_kept, v_capped
    from purge_expired(1);

  assert v_leads_expired = 1,
         format('p_limit = 1 against two eligible leads must stamp exactly one, got leads_expired=%s', v_leads_expired);
  assert v_capped = true,
         format('hitting p_limit on step 2 must set capped = true, got %s', v_capped);

  select count(*) into v_n from lead
   where id in (v_lead_capped1, v_lead_capped2) and deleted_at is not null;
  assert v_n = 1,
         format('the run must have deleted (soft-deleted) at most the limit — expected exactly 1 of the 2 eligible rows stamped, got %s', v_n);

  -- Calling purge_expired() again, immediately, in the SAME transaction:
  -- the previous work order shipped a sibling function that used `create
  -- temporary table` in its body, which raises "relation already exists" on
  -- a second call inside one transaction — and every assertion file in this
  -- repo IS one transaction. This call also happens to drain the backlog
  -- the capped run above left behind, which is the header's own point about
  -- a capped run: "the backlog clears a limit at a time", nothing more.
  select events_expired, leads_expired, leads_erased, events_erased,
         sessions_kept, capped
    into v_events_expired, v_leads_expired, v_leads_erased, v_events_erased,
         v_sessions_kept, v_capped
    from purge_expired();

  assert v_leads_expired = 1,
         format('a second purge_expired() call in the same transaction must succeed and pick up the leftover capped lead, got leads_expired=%s', v_leads_expired);
  assert v_capped = false,
         format('the second call is under the default limit, so capped must be false, got %s', v_capped);

  select count(*) into v_n from lead
   where id in (v_lead_capped1, v_lead_capped2) and deleted_at is not null;
  assert v_n = 2,
         format('after the second call both capped-fixture leads must be stamped, got %s', v_n);

  select count(*) into v_n from purge_run;
  assert v_n = 5, format('purge_run must have exactly 5 rows after 5 calls — one per call, no more, no fewer, got %s', v_n);

  raise notice 'purge.sql: all assertions passed';
end $$;

rollback;
