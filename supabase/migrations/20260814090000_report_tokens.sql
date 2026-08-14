-- ===========================================================================
-- Phase 2 WO C1 — the client report link.
--
-- Design and rationale: PHASE-2-PLAN.md §3, PLAN.md §5.3.
--
-- A row here is a CREDENTIAL. Whoever holds the token this digest was made from
-- can read every lead belonging to one client, with no login and no second
-- factor — which is the correct UX for the audience (PLAN.md §5.3) and means the
-- token's entropy is the entire access control. That makes it a TOM commitment
-- under Art. 32 rather than a convenience, and it is why the runtime mints 256
-- bits from a CSPRNG and this table never sees the token itself.
--
-- WHY THE DIGEST IS NOT SALTED, WHEN `otp.code_hash` AND `lead.ip_hash` ARE
-- Those two hash a SMALL input space — a six-digit code, and an IPv4 address at
-- 2^32 — so an unsalted digest is the secret wearing a disguise and both carry a
-- salt for that reason. A 256-bit random token has no space to search: a
-- database dump of this table is not a step towards a token, and a rainbow table
-- of every 256-bit value is not a thing. Adding a salt here would buy nothing
-- and would put the pepper in the runtime's environment, where losing it means
-- every client's link stops working at once.
--
-- WHY VALIDITY IS DECIDED HERE AND NOT IN THE ROUTE
-- Four conditions have to hold — the digest matches, the token has not expired,
-- it has not been revoked, and its client has not been deleted — and the route's
-- entire authorisation logic should be "did this return a row". Four `&&` in a
-- handler is four things a later edit can reorder or drop, and each one that
-- goes missing publishes a client's leads. Same doctrine as the delivery state
-- machine: the rule lives in SQL, in one place, and there is no second
-- implementation to drift from it.
--
-- TWO LAYERS, LIKE EVERY OTHER TABLE HERE
-- RLS enabled with NO policies, exactly as `20260811120000_phase1_schema.sql`
-- does: that denies `anon` and `authenticated` outright, while `service_role` —
-- the only key the runtime holds — bypasses RLS. The grant revocation in that
-- migration reaches this table through the default privileges it altered.
--
-- Rollback:
--   drop function if exists resolve_report_token(bytea);
--   drop table if exists public.report_token;
-- ===========================================================================

create table if not exists public.report_token (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references client(id),
  -- sha256 of the token. Unique so that re-issuing cannot collide, and because
  -- the lookup is an equality test on this column and nothing else.
  token_hash   bytea not null unique,
  -- Which link this is, for the operator's own list ("Herr Barbian, WhatsApp").
  -- Never shown to the client — it is the operator's note, not a title.
  label        text,
  -- NOT NULL and with no default: a link that never expires is a credential
  -- with no end, and the default belongs in the code that mints it (180 days,
  -- PLAN.md §5.3) where it is one constant next to the entropy it goes with.
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  -- Stamped by resolve_report_token on every successful view. A link nobody has
  -- opened in three months is visible as such before the operator renews it.
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.report_token is
  'Read-only client access to one client''s leads. The row holds sha256(token), never the token (PHASE-2-PLAN.md §3).';

alter table public.report_token enable row level security;

-- The console lists a client's links; the runtime looks one up by digest, which
-- the unique constraint above already indexes.
create index if not exists report_token_client_idx on public.report_token (client_id);

/* ========================================================================== *
 *  Resolve — the whole authorisation decision, in one place.
 *
 *  Returns at most one row. Returning NOTHING is the only failure signal there
 *  is: expired, revoked, deleted client and "no such token" are indistinguishable
 *  from the outside on purpose, because a report link that tells them apart tells
 *  a prober which half of a guess was right.
 *
 *  `security definer` is deliberately NOT used. The runtime calls this with the
 *  service-role key, which bypasses RLS anyway, so definer rights would only
 *  widen what a future `anon` grant could reach.
 * ========================================================================== */

create or replace function resolve_report_token(p_hash bytea)
returns table (token_id uuid, client_id uuid, client_name text)
language plpgsql volatile as $$
declare
  v_token uuid;
  v_client uuid;
  v_name text;
begin
  -- One statement for the match and the stamp. A select-then-update would read
  -- and write the same row twice for every page view, and the join to `client`
  -- is what enforces the fourth condition: a deleted client's link stops working
  -- without anyone having to remember to revoke it.
  update report_token t
     set last_seen_at = now()
   where t.token_hash = p_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and exists (select 1 from client c where c.id = t.client_id and c.deleted_at is null)
  returning t.id, t.client_id into v_token, v_client;

  if v_token is null then
    return;  -- no row, no reason. See the header.
  end if;

  select c.name into v_name from client c where c.id = v_client;
  return query select v_token, v_client, v_name;
end $$;

comment on function resolve_report_token(bytea) is
  'sha256(token) → the client it may read, or nothing. Stamps last_seen_at. Every refusal is silent by design.';

/* ========================================================================== *
 *  The report itself — one function, one round trip, one definition of
 *  "a lead this client may see".
 *
 *  It returns the numbers AND the list, because the alternative is a stats query
 *  and a list query that each carry their own copy of the exclusion predicate.
 *  Three classes of row are excluded and each has its own reason (PHASE-2-PLAN.md
 *  §3, Decision 3):
 *
 *    deleted_at  a soft-deleted lead IS deleted (§8.7); the sweeper has merely
 *                not run yet, and a report that still shows it makes an Art. 17
 *                confirmation untrue.
 *    restricted  Art. 18 blocks processing INCLUDING export, and a report is an
 *                export. `cancel_pending_on_restrict` already stops the queue;
 *                this is the same rule on the read side.
 *    is_spam     not law, product: the report is what makes a client trust the
 *                funnel, and three casino bots at the top of the list do the
 *                opposite.
 *
 *  The day those three drifted apart between the counter and the list, a client
 *  would read "14 Anfragen" above a table of 11 — so they are one CTE, used by
 *  both halves.
 *
 *  Returns jsonb rather than a row set because it is two shapes at once, and the
 *  runtime speaks PostgREST over fetch: one `rpc()` call and one JSON parse beats
 *  two round trips whose results have to be joined in JavaScript.
 * ========================================================================== */

create or replace function client_report(p_client_id uuid, p_limit int default 200)
returns jsonb
language sql stable as $$
  with visible as (
    select l.id, l.created_at, l.payload, l.funnel_id
      from lead l
     where l.client_id = p_client_id
       and l.deleted_at is null
       and not l.restricted
       and not l.is_spam
  )
  select jsonb_build_object(
    'funnels', coalesce((
      select jsonb_agg(f_stats order by f_stats->>'name')
        from (
          select jsonb_build_object(
                   'slug',  f.slug,
                   'name',  f.name,
                   'total', count(v.id),
                   'd7',    count(v.id) filter (where v.created_at > now() - interval '7 days'),
                   'd30',   count(v.id) filter (where v.created_at > now() - interval '30 days')
                 ) as f_stats
            from funnel f
            left join visible v on v.funnel_id = f.id
           where f.client_id = p_client_id
           group by f.id, f.slug, f.name
          -- An archived funnel is hidden only while it has nothing to show. The
          -- obvious `and f.status <> 'archived'` in the WHERE was the first
          -- version and it broke the rule this function exists to keep: its
          -- leads still count towards `total` (archiving a funnel does not
          -- unmake the enquiries it produced), so the breakdown stopped adding
          -- up to the number printed above it.
          having f.status <> 'archived' or count(v.id) > 0
        ) s
    ), '[]'::jsonb),
    'total', (select count(*) from visible),
    'd7',    (select count(*) from visible where created_at > now() - interval '7 days'),
    'd30',   (select count(*) from visible where created_at > now() - interval '30 days'),
    -- The cap is applied here, so the numbers above stay exact while the list
    -- stays bounded. `shown < total` is what tells the page to say so.
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',        v.id,
               'createdAt', v.created_at,
               'funnel',    f.name,
               -- The slug travels with the row because the page resolves answer
               -- KEYS (which are step ids) to the step headlines the visitor
               -- actually read, and that needs the funnel document this lead
               -- came from — not the one that happens to be open.
               'slug',      f.slug,
               'payload',   v.payload
             ) order by v.created_at desc)
        from (select * from visible order by created_at desc limit greatest(p_limit, 1)) v
        left join funnel f on f.id = v.funnel_id
    ), '[]'::jsonb)
  );
$$;

comment on function client_report(uuid, int) is
  'One client''s report: per-funnel counts, totals, and the most recent leads. Deleted, restricted (Art. 18) and spam rows are excluded once, for both halves.';

-- Re-run the revocation from 0002, as every function-adding migration here does.
-- `alter default privileges` only covers functions created later BY THE SAME
-- ROLE, which is a weaker promise than "a future migration cannot reopen this" —
-- so the guarantee is this explicit revoke, not the default. Two new functions,
-- two new ways in, and `client_report` takes a client id as an argument: left
-- callable with the (deliberately public) anon key, it would be a lead reader
-- that needs no token at all, walkable by guessing UUIDs.
--
-- The table's own RLS-with-no-policies would still refuse today. That is the
-- point of two layers, and it is not a reason to ship one.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from public, anon, authenticated';
    execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
  end if;
end $$;
