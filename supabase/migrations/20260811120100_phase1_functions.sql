-- ===========================================================================
-- Phase 1 functions — the delivery state machine, ingest, and the rate limiter.
--
-- Design and rationale: PHASE-1-PLAN.md §3.
--
-- WHY THESE ARE SQL AND NOT JAVASCRIPT
-- The repo has a CI-enforced zero-runtime-dependency invariant, so the runtime
-- talks to Postgres over PostgREST with plain fetch and there is no SQL driver
-- to hold a transaction open across statements. One PostgREST request is one
-- transaction, so anything that needs a transaction or FOR UPDATE SKIP LOCKED
-- is a function called as POST /rest/v1/rpc/<name>.
--
-- The consequence is the useful part: state transitions live here and dispatch
-- lives in JavaScript. The JS side never writes a status string by hand, so
-- there is exactly one place a delivery can change state and it is not
-- reachable from a route handler that forgot a rule.
--
-- WHY SECURITY INVOKER (the default, stated because it is load-bearing)
-- A SECURITY DEFINER function reachable by `anon` over /rpc/ is a complete
-- bypass of the RLS in the schema migration. With invoker semantics the worst
-- case of a botched revoke below is "RLS denies it", not "full access".
--
-- Rollback: drop function/type in reverse order; see the end of this file.
-- ===========================================================================

/* ========================================================================== *
 *  Retry schedule
 *
 *  30s · 90s · 4.5m · 13.5m · 40m · 2h · 6h · 12h  →  ~21h of grace over eight
 *  attempts. A formula rather than a lookup table so the inline first attempt
 *  and the cron drain cannot drift apart — a table in JS and a table in SQL
 *  eventually disagree, and the disagreement is invisible.
 *
 *  The first two steps collapse to "next tick" in practice, because pickup is
 *  bounded by the one-minute cron interval. That is fine: the FIRST attempt is
 *  inline and never on this schedule, so this only governs recovery.
 * ========================================================================== */

-- The exponent is clamped as well as the result. `least()` cannot save you here:
-- the multiplication is evaluated first, and 30s · 3^99 overflows the interval
-- type and raises before any cap applies. Saturation is at seven (30s · 3^7 is
-- already past twelve hours), so clamping there changes no schedule.
create or replace function delivery_backoff(p_attempts int) returns interval
language sql immutable as $$
  select least(interval '12 hours',
               interval '30 seconds' * power(3, least(greatest(p_attempts, 0), 7)));
$$;

/* ========================================================================== *
 *  Claiming
 *
 *  Everything a dispatch needs comes back in one row, so there is no N+1 read
 *  between claiming and sending.
 * ========================================================================== */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'claimed_delivery') then
    create type claimed_delivery as (
      delivery_id     bigint,
      lead_id         uuid,
      attempts        int,
      idempotency_key uuid,
      kind            text,
      config          jsonb,
      funnel_slug     text,
      payload         jsonb,
      utm             jsonb,
      consent         jsonb,
      lead_created_at timestamptz
    );
  end if;
end $$;

-- THE one claim path. The inline first attempt passes p_lead_id, the cron
-- drain passes null; both go through the same FOR UPDATE SKIP LOCKED. A second
-- claim path written by hand is exactly how the inline attempt and the drain
-- come to double-send the same lead, so there is not one.
create or replace function claim_deliveries(p_limit int default 25, p_lead_id uuid default null)
returns setof claimed_delivery
language sql volatile as $$
  with picked as (
    select d.id
      from delivery d
      join lead l            on l.id = d.lead_id
      join delivery_target t on t.id = d.target_id
     where d.status = 'pending'
       and d.next_attempt_at <= now()
       and (p_lead_id is null or d.lead_id = p_lead_id)
       -- Art. 18 restriction and soft deletion both stop delivery. Checked here
       -- as well as by the trigger that cancels pending rows, because this one
       -- is a legal guarantee and one mechanism is one thing to get wrong.
       and l.restricted = false
       and l.deleted_at is null
       and t.enabled
     order by d.next_attempt_at, d.id      -- id breaks the tie, so the order is total
       for update of d skip locked
     limit p_limit
  ),
  claimed as (
    update delivery d
       set status          = 'delivering',
           attempts        = d.attempts + 1,
           -- The lease. Five minutes is Vercel's maximum function duration on
           -- Fluid compute, so a lease cannot expire under a still-running send.
           next_attempt_at = now() + interval '5 minutes'
     where d.id in (select id from picked)
    returning d.*
  )
  select c.id, c.lead_id, c.attempts, c.idempotency_key,
         t.kind, t.config, f.slug, l.payload, l.utm, l.consent, l.created_at
    from claimed c
    join lead l            on l.id = c.lead_id
    join funnel f          on f.id = l.funnel_id
    join delivery_target t on t.id = c.target_id;
$$;

/* ========================================================================== *
 *  Transitions
 *
 *  `attempts` IS THE FENCING TOKEN, and passing it is not optional.
 *
 *  `and status = 'delivering'` alone is not enough, and the difference is not
 *  theoretical. The system's own recovery machinery produces the interleaving:
 *  an invocation hangs past its five-minute lease, the sweeper (every minute)
 *  returns the row to 'pending', the drain (every minute) re-claims it as
 *  attempts = 2 — and then the ORIGINAL invocation finally returns. It finds a
 *  row that is 'delivering' and completes it. The live attempt's real outcome
 *  is then a silent no-op, so the row reads 'done' while nothing may have
 *  arrived; in the mirror case a stale failure stomps a live claim back to
 *  'pending' and the lead is sent twice.
 *
 *  Vercel's `after()` does not stop on abort, which is precisely how an
 *  invocation outlives the lease it was given.
 *
 *  So every transition presents the attempts value it was handed by
 *  `claim_deliveries`, and an update from a superseded episode matches nothing.
 *
 *  THE TOKEN IS THE PAIR (attempts, idempotency_key), NOT attempts ALONE.
 *  `attempts` separates claim episodes within one delivery generation, but
 *  `resend_delivery` rewinds it to zero — so an answer from before a
 *  dead-letter-then-resend cycle carries the same number the post-resend claim
 *  was handed, and would match. The idempotency key is what separates
 *  generations: it is minted once per generation and rotated by exactly that
 *  resend. Together the pair is unique across the row's whole life, and both
 *  halves already come back from `claim_deliveries` at no extra cost.
 * ========================================================================== */

create or replace function complete_delivery(
  p_id bigint, p_attempt int, p_key uuid, p_status int default null
) returns boolean language sql volatile as $$
  with u as (
    update delivery
       set status = 'done', delivered_at = now(), last_status = p_status, last_error = null
     where id = p_id and status = 'delivering'
       and attempts = p_attempt and idempotency_key = p_key
    returning 1
  ) select exists (select 1 from u);
$$;

-- Returns the resulting status, so the caller knows when it has just produced a
-- dead letter and has to alert. Returns null when nothing matched — a
-- superseded claim, or a row that is no longer delivering — in which case the
-- caller must NOT alert and must not retry: whoever holds the current claim
-- owns the outcome.
create or replace function fail_delivery(
  p_id bigint, p_attempt int, p_key uuid, p_status int, p_error text, p_max_attempts int default 8
) returns text language sql volatile as $$
  update delivery
     set status = case when attempts >= p_max_attempts then 'dead' else 'pending' end,
         next_attempt_at = case when attempts >= p_max_attempts
                                then next_attempt_at
                                else now() + delivery_backoff(attempts) end,
         last_status = p_status,
         last_error  = left(p_error, 500)
   where id = p_id and status = 'delivering'
     and attempts = p_attempt and idempotency_key = p_key
  returning status;
$$;

-- Runs as pure SQL on a pg_cron tick — no HTTP call, deliberately. A Vercel
-- outage must not also take out the mechanism that recovers from a Vercel
-- timeout. Without this, a function that dies mid-batch strands its claimed
-- rows in 'delivering' forever, which is the exact failure this system exists
-- to prevent, wearing a different hat.
create or replace function sweep_stuck_deliveries() returns int
language sql volatile as $$
  with s as (
    update delivery
       set status = 'pending', next_attempt_at = now() + delivery_backoff(attempts)
     where status = 'delivering' and next_attempt_at < now()
    returning 1
  ) select coalesce(count(*), 0)::int from s;
$$;

-- Manual re-send from the console. Rotates the idempotency key on purpose: an
-- automatic retry may be hitting a receiver that already succeeded, which is
-- what the key is for — but an operator clicking "re-send" wants the lead to
-- actually land, and reusing the key would let the receiver dedupe the re-send
-- into a no-op.
--
-- Refuses while the lead is restricted or deleted. `claim_deliveries` would
-- refuse to dispatch it anyway, so this is not what stops the send — it stops
-- the row being parked in 'pending' forever, which looks to the operator like a
-- re-send that worked and then vanished.
create or replace function resend_delivery(p_id bigint) returns boolean
language sql volatile as $$
  with u as (
    update delivery d
       set status          = 'pending',
           attempts        = 0,
           next_attempt_at = now(),
           idempotency_key = gen_random_uuid(),
           last_error      = null,
           last_status     = null
     where d.id = p_id
       and d.status in ('dead', 'done', 'cancelled')
       and exists (select 1 from lead l
                    where l.id = d.lead_id and l.restricted = false and l.deleted_at is null)
    returning 1
  ) select exists (select 1 from u);
$$;

/* ========================================================================== *
 *  Art. 18 / deletion — cancelling what has not gone out yet
 *
 *  A trigger rather than a call in the restrict handler, because it then fires
 *  no matter which code path restricts or deletes the lead, including the ones
 *  Phase 2 has not written yet. Only 'pending' rows are cancelled: a
 *  'delivering' row is in flight and cannot be recalled, and lying about that
 *  would be worse than the delay.
 * ========================================================================== */

create or replace function cancel_pending_on_restrict() returns trigger
language plpgsql as $$
begin
  if (new.restricted and not old.restricted)
     or (new.deleted_at is not null and old.deleted_at is null) then
    update delivery set status = 'cancelled'
     where lead_id = new.id and status = 'pending';
  end if;
  return new;
end $$;

drop trigger if exists lead_restrict_cancels_pending on lead;
create trigger lead_restrict_cancels_pending
  after update of restricted, deleted_at on lead
  for each row execute function cancel_pending_on_restrict();

/* ========================================================================== *
 *  Ingest — the lead and its delivery rows in ONE transaction
 *
 *  PLAN.md §2.6 step 3: after this returns, either the lead exists with every
 *  delivery row it needs, or nothing was written at all. Nothing is ever in
 *  flight without a row to record it.
 *
 *  An unknown slug raises rather than returning a null row, because PostgREST
 *  maps the PT404 SQLSTATE to HTTP 404 and the runtime needs to tell "this funnel does not
 *  exist" (nowhere to deliver, log loudly, still answer the visitor 202) apart
 *  from "Supabase is unreachable" (degrade forward: deliver inline, skip the
 *  queue).
 *
 *  DELIBERATELY NOT FILTERED ON `funnel.status`. An earlier draft of this
 *  resolved only 'live' and 'draft' funnels, which reads as tidy and is the
 *  wrong trade: a visitor who loaded the page seconds before the operator
 *  paused or archived the funnel then submits into a refusal, and their lead is
 *  gone. That is the exact failure this phase exists to remove, traded away for
 *  a check that stops nothing an attacker cares about — a direct POST against
 *  an archived slug only reaches that client's own delivery targets. Which
 *  statuses are SERVED is `/f/:slug`'s decision; which are STORED is not.
 * ========================================================================== */

create or replace function ingest_lead(
  p_slug           text,
  p_payload        jsonb,
  p_utm            jsonb   default null,
  p_consent        jsonb   default null,
  p_email_verified boolean default false,
  p_ip_hash        bytea   default null,
  p_user_agent     text    default null,
  p_dedupe_key     text    default null
) returns table (lead_id uuid, queued int, deduped boolean)
language plpgsql volatile as $$
declare
  v_funnel  funnel%rowtype;
  v_lead_id uuid;
  v_queued  int := 0;
begin
  select * into v_funnel from funnel where slug = p_slug;
  if not found then
    -- PT404, not P0002. PostgREST maps its own PTxxx range onto HTTP status
    -- codes; a plain P0002 (no_data_found) falls through to a generic 500,
    -- which reads to the runtime as "the database is down" and would fire the
    -- degrade-forward path for a funnel that has no targets to deliver to.
    raise exception 'unknown_funnel' using errcode = 'PT404';
  end if;

  insert into lead (funnel_id, client_id, payload, utm, consent,
                    email_verified, ip_hash, user_agent, dedupe_key)
  values (v_funnel.id, v_funnel.client_id, p_payload, p_utm, p_consent,
          coalesce(p_email_verified, false), p_ip_hash, p_user_agent, p_dedupe_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_lead_id;

  -- Conflict fired: the same lead within the dedupe window. Return the row that
  -- already exists and queue nothing, so a double-tapped submit costs one
  -- delivery rather than two.
  if v_lead_id is null then
    select l.id into v_lead_id from lead l where l.dedupe_key = p_dedupe_key;
    return query select v_lead_id, 0, true;
    return;
  end if;

  insert into delivery (lead_id, target_id)
  select v_lead_id, t.id
    from delivery_target t
   where t.client_id = v_funnel.client_id
     and t.enabled
     and (t.funnel_id is null or t.funnel_id = v_funnel.id);
  get diagnostics v_queued = row_count;

  return query select v_lead_id, v_queued, false;
end $$;

-- Events carry no delivery, so this is an insert with a slug lookup and nothing
-- else. Separate from ingest_lead because /api/events runs at ten times the
-- rate and must stay as cheap as it looks.
create or replace function ingest_event(
  p_slug text, p_session_id text, p_type text,
  p_step_id text default null, p_meta jsonb default null
) returns bigint language plpgsql volatile as $$
declare
  v_funnel_id uuid;
  v_id        bigint;
begin
  select id into v_funnel_id from funnel where slug = p_slug;
  if not found then
    -- PT404, not P0002. PostgREST maps its own PTxxx range onto HTTP status
    -- codes; a plain P0002 (no_data_found) falls through to a generic 500,
    -- which reads to the runtime as "the database is down" and would fire the
    -- degrade-forward path for a funnel that has no targets to deliver to.
    raise exception 'unknown_funnel' using errcode = 'PT404';
  end if;

  insert into event (funnel_id, session_id, type, step_id, meta)
  values (v_funnel_id, p_session_id, p_type, p_step_id, p_meta)
  returning id into v_id;
  return v_id;
end $$;

/* ========================================================================== *
 *  Rate limiting
 *
 *  Was a Map in one process's heap. On serverless that does not bind at all,
 *  so every ceiling in the runtime — including the global mail cap, the one
 *  keyed on something a caller cannot rotate — was effectively absent the
 *  moment the first function instance scaled out.
 *
 *  ponytail: fixed window, not sliding. A burst straddling the boundary can
 *  reach 2× max within any sliding window. That is the standard trade for one
 *  atomic statement instead of an array of timestamps per key, and 2× a
 *  deliberately generous abuse ceiling is still a bounded ceiling. Move to a
 *  timestamp array only if a real ceiling is ever actually exceeded.
 * ========================================================================== */

-- Expiry is judged against the window STORED ON THE BUCKET, never the window
-- the current caller passed. That distinction is the M2 finding in a new place:
-- when the prune tested every bucket against whichever window the current call
-- happened to carry, the hourly mail cap — the one ceiling whose key a caller
-- cannot rotate — became resettable by any unauthenticated request to a
-- different endpoint. Nothing shares a key across windows today; the point is
-- that doing so later must not silently widen a ceiling.
--
-- The caller's window is adopted only when the bucket rolls over, so a changed
-- configuration still takes effect — one window late, which is the correct
-- direction to be wrong in.
create or replace function rate_hit(p_key text, p_max int, p_window_ms int)
returns boolean language plpgsql volatile as $$
declare
  v_count int;
begin
  insert into rate_bucket as b (key, window_ms, window_start, count)
       values (p_key, p_window_ms, now(), 1)
  on conflict (key) do update
     set count        = case when b.window_start < now() - make_interval(secs => b.window_ms / 1000.0)
                             then 1 else b.count + 1 end,
         window_start = case when b.window_start < now() - make_interval(secs => b.window_ms / 1000.0)
                             then now() else b.window_start end,
         window_ms    = case when b.window_start < now() - make_interval(secs => b.window_ms / 1000.0)
                             then p_window_ms else b.window_ms end
  returning b.count into v_count;

  return v_count <= p_max;
end $$;

/* ========================================================================== *
 *  Nothing here is callable with the anon key.
 *
 *  Supabase grants EXECUTE on public functions to PUBLIC by default, and anon
 *  and authenticated inherit from it. Without this block, /rpc/ingest_lead and
 *  /rpc/claim_deliveries are open to anyone holding the (deliberately public)
 *  anon key.
 *
 *  The default-privileges line covers functions created LATER BY THE SAME ROLE
 *  — that is what `alter default privileges` means, and it is a weaker promise
 *  than "a future migration cannot reopen this". Migrations all run as the same
 *  Supabase migration role today, so it holds; if that ever stops being true,
 *  the guarantee is the explicit revoke, not the default. Re-running this block
 *  is safe and is the fix.
 * ========================================================================== */

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from public, anon, authenticated';
    execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
  end if;
end $$;

-- Rollback, in dependency order:
--   drop trigger if exists lead_restrict_cancels_pending on lead;
--   drop function if exists cancel_pending_on_restrict, rate_hit, ingest_event,
--        ingest_lead, resend_delivery, sweep_stuck_deliveries, fail_delivery,
--        complete_delivery, claim_deliveries, delivery_backoff;
--   drop type if exists claimed_delivery;
