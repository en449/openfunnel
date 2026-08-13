-- ===========================================================================
-- Phase 2 WO B1 — the host → funnel mapping.
--
-- Design and rationale: PHASE-2-PLAN.md §2.
--
-- A row here changes what the SERVER IS for that hostname: `handler.js` refuses
-- the console shell, the funnel LIST and every privileged and internal route on
-- a mapped host, and serves that one funnel at `/`. So an accidental row is not
-- a cosmetic mistake — it takes a hostname away from the console — and a missing
-- row publishes the console on a client's domain. Both directions are why the
-- host is a primary key rather than a nullable column on `funnel`.
--
-- WHY THE SLUG AND NOT funnel.id
-- `funnel_id` would be the tidier foreign key, and it is wrong here: the runtime
-- resolves a request by SLUG, and a deployment with no `funnel` rows at all
-- (documents on disk in `examples/`, which is the self-hoster's whole setup)
-- still needs its domains to work. A slug that names nothing yet answers 404 on
-- that host, which is the same thing `/f/<unknown>` already does.
--
-- TWO LAYERS, LIKE EVERY OTHER TABLE HERE
-- RLS enabled with NO policies, exactly as `20260811120000_phase1_schema.sql`
-- does for all eight of its tables and for the reason stated there: that denies
-- `anon` and `authenticated` outright, while `service_role` — the only key the
-- runtime holds — bypasses RLS. The grant revocation in that migration is the
-- second, independent layer, and it reaches this table through the default
-- privileges it altered.
--
-- Relying on the grant alone was the first version of this file, and it is one
-- layer where the schema's own doctrine says two: `grant all on all tables in
-- schema public to anon` is a step operators reach for when debugging someone
-- else's RLS problem, and it would hand this table — which decides WHAT THE
-- SERVER IS for a hostname — to the public anon key, past `ADMIN_TOKEN`, past
-- the lockout guard and past the rate limit.
--
-- Rollback:
--   drop table if exists public.domain;
-- ===========================================================================

create table if not exists public.domain (
  -- Stored already normalised (lowercase, no port, no trailing dot) by the
  -- runtime. The check is a second line of defence on the same rule: a row
  -- written by hand in the SQL editor that carries `Client-Firma.DE` would never
  -- match a lookup and the domain would silently serve the console instead.
  host text primary key check (host = lower(host) and host !~ '[:/ ]' and host like '%.%'),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  created_at timestamptz not null default now()
);

comment on table public.domain is
  'Hostname → funnel slug. A row makes that host serve ONLY that funnel: the console, the funnel list and every privileged route answer 404 there (PHASE-2-PLAN.md §2).';

alter table public.domain enable row level security;

-- The console lists by funnel ("which domains point at this one?"), and the
-- runtime looks up by host, which the primary key already covers.
create index if not exists domain_slug_idx on public.domain (slug);
