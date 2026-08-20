-- ===========================================================================
-- Phase 2 WO D5 — retention purge: the job that makes deletion real.
--
-- Design and rationale: PHASE-2-PLAN.md §4 (work order D5), PLAN.md §8.7. The
-- Löschkonzept promises three things happen without anyone deciding to do them:
-- drop-off events die at 90 days, a client's leads die at that client's own
-- horizon, and a soft delete becomes a real one within 24 hours. Until this
-- file existed only the first was true, as a one-line `delete` inside a cron
-- command — nothing counted it and nothing recorded that it had run.
--
-- WHY THE RETENTION SWEEP SOFT-DELETES INSTEAD OF DELETING
-- A lead past its horizon is stamped `deleted_at` and hard-deleted by the SAME
-- function's third step a day later. That is not indecision, it buys two
-- things that a direct delete cannot:
--
--   * `lead_restrict_cancels_pending` (20260811120100) fires on
--     `after update of restricted, deleted_at` and cancels every pending
--     delivery for that lead. A hard delete cascades the queue rows away
--     instead, so a row already claimed and in flight would have its bookkeeping
--     vanish underneath the invocation delivering it.
--   * A 24-hour window in which a wrong `retention_months` is still recoverable.
--     A client set to 1 by a slip deletes a year of leads on the next run, and
--     "it is a soft delete until tomorrow" is the difference between an
--     apologetic email and a lost business.
--
-- Which means the same run never both expires and erases the same lead: step 2
-- stamps `now()`, step 3 only takes rows stamped more than 24 hours ago.
--
-- WHY `restricted` IS SKIPPED BY THE RETENTION SWEEP AND NOT BY THE HARD DELETE
-- Art. 18 restriction means STORE IT, do not process it — typically because the
-- subject contests the data or needs it for a legal claim. Deleting a
-- restricted lead on a schedule is the one thing the restriction exists to
-- prevent, so step 2 refuses to stamp one. Step 3 does NOT re-check the flag:
-- a `deleted_at` that is already set was set by `erase_subject` (Art. 17, which
-- outranks a restriction the same subject asked for) or by a previous run of
-- step 2, which had already applied the check. Re-checking there would strand
-- an Art. 17 erasure of a restricted lead as a soft delete forever.
--
-- WHY A LEAD'S EVENTS ARE ONLY DELETED WHEN THE SESSION IS EMPTIED
-- `event` carries `session_id text` and no lead foreign key, so the join is
-- `payload->>'sessionId'` — the same one `erase_subject` uses, and the same
-- hazard: a `sessionId` is minted per mounted funnel, not per human, so two
-- people on one trade-fair tablet share one. `erase_subject` deletes the
-- events anyway and RETURNS the count of shared sessions, because a person
-- exercising Art. 17 outranks another visitor's drop-off analytics and an
-- operator is reading that receipt. THIS function is unattended, so it makes
-- the conservative choice instead: a session another surviving lead still sits
-- on is left alone. Nothing is kept indefinitely by that — step 1 removes every
-- event at 90 days regardless of who it belonged to.
--
-- NOT `security definer`, for the same reason as every sibling: the runtime
-- calls this with the service_role key, which bypasses RLS already, and
-- `pg_cron` runs it as the database owner. A definer function would only widen
-- who could delete every lead in the database.
-- ===========================================================================

/* ========================================================================== *
 *  The log. One row per run — GATE (PLAN.md §8.7): "the purge job runs, is
 *  logged, and a test proves a deleted subject is gone".
 *
 *  A run that deleted nothing still writes a row. That is the point: the
 *  question this table answers is "is the retention promise being kept", and
 *  an empty table cannot distinguish a database with nothing to purge from a
 *  cron job that was never scheduled — which is exactly the failure mode of
 *  scheduling deletion and assuming it happens.
 * ========================================================================== */

create table if not exists purge_run (
  id                   bigserial primary key,
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  events_expired       int not null default 0,   -- step 1: past 90 days
  leads_expired        int not null default 0,   -- step 2: past the client's horizon, soft-deleted
  leads_erased         int not null default 0,   -- step 3: soft-deleted over 24h ago, gone
  events_erased        int not null default 0,   -- step 3: their events, where the session emptied
  sessions_kept        int not null default 0,   -- step 3: sessions left alone, a live lead shares them
  -- True when any step hit `p_limit`. A capped run is not an error and not a
  -- failure — it means there was more to do than one run's ceiling, so the
  -- backlog clears a limit at a time. If this is true on consecutive runs, the
  -- schedule or the limit is too small for the volume; nothing self-corrects.
  capped               boolean not null default false
);
create index if not exists purge_run_recent_idx on purge_run (started_at desc);

alter table purge_run enable row level security;

/* ========================================================================== *
 *  The job itself.
 *
 *  `p_limit` bounds EACH step independently. It exists because pg_cron runs
 *  this inside one transaction against a Free-tier instance: an unbounded
 *  delete over a table that has grown for a year is a long lock held on the
 *  product's most-written table, and the first run after a backlog is exactly
 *  when that is worst. A bounded run that reports `capped` is strictly better
 *  than an unbounded one that times out and rolls back — the timed-out version
 *  deletes NOTHING and looks, in cron.job_run_details, like a job that failed
 *  for an unrelated reason.
 * ========================================================================== */

create or replace function purge_expired(p_limit int default 20000)
returns table (
  events_expired int,
  leads_expired  int,
  leads_erased   int,
  events_erased  int,
  sessions_kept  int,
  capped         boolean
)
language plpgsql
volatile
as $$
declare
  v_limit          int := greatest(coalesce(p_limit, 20000), 1);
  v_events_expired int;
  v_leads_expired  int;
  v_leads_erased   int;
  v_events_erased  int;
  v_sessions_kept  int;
  v_capped         boolean;
begin
  -- --- step 1: drop-off events at 90 days (PLAN.md §8.7) -------------------
  -- The horizon is fixed and global, not per client: an `event` row carries no
  -- client_id (only funnel_id), and 90 days is what the Datenschutzerklärung
  -- states. A per-client horizon here would mean a join per row to enforce a
  -- number nobody has been told.
  with doomed as (
    select e.id
      from event e
     where e.created_at < now() - interval '90 days'
     limit v_limit
  ), gone as (
    delete from event e using doomed d where e.id = d.id returning e.id
  )
  select count(*)::int into v_events_expired from gone;

  -- --- step 2: leads past their own client's horizon ------------------------
  -- `greatest(retention_months, 1)`: the column is `not null default 12` with no
  -- check constraint, so a 0 — a plausible slip in a settings form, and the
  -- console does not currently write this field at all — would mean
  -- `now() - interval '0 months'`, i.e. every lead the client has ever received,
  -- deleted on the next run. One month is the floor a retention policy can
  -- meaningfully express; anything shorter is a mistake, not a policy.
  with expiring as (
    select l.id
      from lead l
      join client c on c.id = l.client_id
     where l.deleted_at is null
       and not l.restricted
       and l.created_at < now() - (greatest(c.retention_months, 1) * interval '1 month')
     limit v_limit
  ), stamped as (
    update lead l
       set deleted_at = now()
      from expiring x
     where l.id = x.id
    returning l.id
  )
  select count(*)::int into v_leads_expired from stamped;

  -- --- step 3: the soft deletes that are 24 hours old ----------------------
  -- One statement, so every count describes one snapshot. `delivery` rows go
  -- with the lead through `on delete cascade`; a row still `delivering` a full
  -- day after the soft delete has already been resolved by
  -- `sweep_stuck_deliveries`, which runs every minute.
  with victims as materialized (
    select l.id,
           l.funnel_id,
           nullif(l.payload ->> 'sessionId', '') as session_id
      from lead l
     where l.deleted_at is not null
       and l.deleted_at < now() - interval '24 hours'
     order by l.deleted_at
     limit v_limit
  ),
  -- A session is emptied by this run only when no lead OUTSIDE the victim set
  -- sits on it. `not exists` rather than `not in`: one NULL in a `not in`
  -- subquery makes the whole predicate NULL, which here would silently stop
  -- every event from being deleted.
  emptied as (
    select distinct v.funnel_id, v.session_id
      from victims v
     where v.session_id is not null
       and not exists (
         select 1
           from lead o
          where o.funnel_id = v.funnel_id
            and nullif(o.payload ->> 'sessionId', '') = v.session_id
            and not exists (select 1 from victims x where x.id = o.id)
       )
  ),
  kept as (
    select count(distinct v.session_id)::int as n
      from victims v
     where v.session_id is not null
       and not exists (
         select 1 from emptied e
          where e.funnel_id = v.funnel_id and e.session_id = v.session_id
       )
  ),
  events_gone as (
    delete from event e
     using emptied m
     where e.funnel_id = m.funnel_id
       and e.session_id = m.session_id
    returning e.id
  ),
  leads_gone as (
    delete from lead l using victims v where l.id = v.id returning l.id
  )
  select (select count(*) from leads_gone)::int,
         (select count(*) from events_gone)::int,
         (select n from kept)
    into v_leads_erased, v_events_erased, v_sessions_kept;

  -- Computed once and used twice. The logged row and the returned receipt have
  -- to agree: the console reads one, the operator running this by hand reads the
  -- other, and two copies of this expression is how they come to disagree about
  -- whether there is a backlog.
  v_capped := v_events_expired >= v_limit
           or v_leads_expired  >= v_limit
           or v_leads_erased   >= v_limit;

  insert into purge_run (finished_at, events_expired, leads_expired,
                         leads_erased, events_erased, sessions_kept, capped)
  values (clock_timestamp(), v_events_expired, v_leads_expired,
          v_leads_erased, v_events_erased, v_sessions_kept, v_capped);

  return query
    select v_events_expired, v_leads_expired, v_leads_erased, v_events_erased,
           v_sessions_kept, v_capped;
end $$;

comment on function purge_expired(int) is
  'PLAN.md §8.7: events at 90 days, leads at their client''s horizon (soft), soft deletes older than 24h (hard). Logs one purge_run row per call (WO D5).';

comment on table purge_run is
  'One row per purge_expired() run, including runs that deleted nothing — an empty table means the job is not scheduled.';

-- ---------------------------------------------------------------------------
-- Close the new doors. `alter default privileges` in 20260811120000 only covers
-- objects created later BY THE SAME ROLE, which is weaker than "a future
-- migration cannot reopen this" — so every migration adding a function or table
-- carries this block explicitly.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table purge_run from anon, authenticated';
    execute 'revoke execute on function purge_expired(int) from anon, authenticated';
  end if;
end $$;
