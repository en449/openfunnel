-- ===========================================================================
-- Phase 1 schema — "never lose a lead".
--
-- Design and rationale: PHASE-1-PLAN.md §2. Tables here are only the ones
-- Phase 1 code actually touches; asset / domain / report_token / funnel_daily
-- / funnel_version are Phase 2-3 and get their own migration when the code
-- that reads them exists.
--
-- Rollback (only ever needed against a database holding real leads; before
-- that, `supabase db reset` is the down):
--   drop table if exists otp, rate_bucket, event, delivery, delivery_target,
--                        lead, funnel, client cascade;
-- ===========================================================================

-- gen_random_uuid() is core since PG13; no extension needed.

/* ========================================================================== *
 *  Tenancy-shaped from day one, even with a single operator.
 *
 *  `client_id` sits on every table that holds client data because it is needed
 *  today for the client report and for deletion, and it is the column a future
 *  tenancy layer keys off. A nullable column plus a single-value backfill is a
 *  trivial migration; retrofitting the key to a live lead table is not.
 * ========================================================================== */

create table client (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  contact_email    text not null,
  vertical         text,                          -- galabau | shk | dental | immo | …
  -- GATE (PLAN.md §8.9): publishing a funnel is refused while this is null.
  avv_signed_at    timestamptz,
  retention_months int  not null default 12,      -- lead auto-purge horizon (§8.7)
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

/* ========================================================================== *
 *  Funnels
 *
 *  `doc` is the JSON contract defined in packages/engine/src/types.js. Moving
 *  it out of FUNNELS_DIR is what stops client copy being committed into a
 *  public repo — the default funnel directory is `examples/`, inside the
 *  published tree.
 * ========================================================================== */

create table funnel (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references client(id),
  slug         text not null unique,              -- SLUG_RE in lib/config.js, unchanged
  name         text not null,
  doc          jsonb not null,
  status       text not null default 'draft'
               check (status in ('draft', 'live', 'paused', 'archived')),
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index funnel_client_idx on funnel (client_id);

/* ========================================================================== *
 *  Leads — the product
 *
 *  `payload` is { lead, answers }. The contact fields used to be stored twice,
 *  in `lead` and again in `answers.contact` (REALITY-CHECK.md §7); they are
 *  collapsed here, because duplicated personal data in a record that has to be
 *  provably deletable is two places to miss.
 *
 *  `ip_hash` is a salted hash computed in the runtime, never the raw address.
 *  `restricted` is Art. 18: it blocks delivery and export without deleting.
 *  `deleted_at` is a soft delete; the retention sweeper hard-deletes (§8.7).
 * ========================================================================== */

create table lead (
  id             uuid primary key default gen_random_uuid(),
  funnel_id      uuid not null references funnel(id),
  -- Denormalised from funnel.client_id and set by ingest_lead(), never by the
  -- request: /api/lead is public, so a client_id from the body is a way to
  -- write into another client's inbox.
  client_id      uuid not null references client(id),
  payload        jsonb not null,
  utm            jsonb,                            -- utm_*, gclid, fbclid, ttclid, ref
  consent        jsonb,                            -- { signal, at, text_version } — §8.4 evidence
  email_verified boolean not null default false,   -- re-derived server-side, never trusted
  ip_hash        bytea,
  user_agent     text,
  dedupe_key     text,
  spam_score     int  not null default 0,
  is_spam        boolean not null default false,
  restricted     boolean not null default false,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- A double submit is a live path, not a hypothetical: engine/src/leads.js posts
-- with sendBeacon AND a keepalive fetch fallback. Partial, because most rows
-- will carry no key.
create unique index lead_dedupe_idx  on lead (dedupe_key) where dedupe_key is not null;
create index        lead_funnel_idx  on lead (funnel_id, created_at desc);
create index        lead_client_idx  on lead (client_id, created_at desc);
-- Art. 15 subject access: find every record belonging to one person.
create index        lead_payload_idx on lead using gin (payload jsonb_path_ops);

/* ========================================================================== *
 *  Delivery targets — where a client's leads go
 *
 *  `funnel_id` null means every funnel of that client. Per-funnel targets are
 *  an existing capability, not a new one: forwardWebhook() already reads
 *  integrations.webhookUrl off the funnel document.
 *
 *  `config` carries secrets (webhook secret, API keys). It is read by the
 *  dispatcher and must never be returned by a console API.
 * ========================================================================== */

create table delivery_target (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references client(id),
  funnel_id  uuid references funnel(id),
  -- sms/whatsapp are Phase 3. Widening this constraint is one line; a target
  -- kind nothing dispatches is a silent black hole for a client's leads.
  kind       text not null check (kind in ('email', 'webhook', 'sheet')),
  config     jsonb not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
create index delivery_target_client_idx on delivery_target (client_id) where enabled;

/* ========================================================================== *
 *  The queue. This table is the reason the project exists.
 *
 *  One row per (lead, target), and the row IS the desired end state rather
 *  than a log entry — which is why (lead_id, target_id) is unique. Today a
 *  failed forward is a console.warn and the lead is gone.
 *
 *  Two column semantics worth knowing, both deliberate:
 *
 *  `attempts` counts CLAIMS, not responses. It is incremented inside the
 *  claiming UPDATE, so an invocation that dies mid-send still burns an attempt
 *  — because the receiver may already have processed it. Counting only on
 *  failure means a hung send never counts and the row retries forever.
 *
 *  `next_attempt_at` means "not before" while pending and "lease expires"
 *  while delivering. A separate claimed_at column plus its own index buys
 *  nothing: the sweeper is then one predicate over one partial index.
 * ========================================================================== */

create table delivery (
  id              bigserial primary key,
  lead_id         uuid not null references lead(id) on delete cascade,
  target_id       uuid not null references delivery_target(id),
  status          text not null default 'pending'
                  check (status in ('pending', 'delivering', 'done', 'dead', 'cancelled')),
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- errSummary() output only, truncated. Never an error object: Bun puts the
  -- full request URL on err.path and a webhook URL routinely carries a token
  -- in its path. The console displays this field.
  last_error      text,
  last_status     int,
  idempotency_key uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (lead_id, target_id)
);

-- Serves both the claim (status = 'pending') and the stuck sweeper
-- (status = 'delivering'). Partial, so it stays small: terminal rows, which are
-- eventually almost the whole table, are not in it.
create index delivery_due_idx on delivery (status, next_attempt_at)
  where status in ('pending', 'delivering');

/* ========================================================================== *
 *  Drop-off events. High volume — purged at 90 days by pg_cron, rolled up in
 *  Phase 2.
 * ========================================================================== */

create table event (
  id         bigserial primary key,
  funnel_id  uuid not null references funnel(id) on delete cascade,
  session_id text not null,
  type       text not null,                        -- view | step | answer | submit | drop
  step_id    text,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index event_funnel_idx on event (funnel_id, created_at);

/* ========================================================================== *
 *  State that used to be an in-process Map
 *
 *  On serverless every invocation may be a fresh instance, so a Map does not
 *  bind at all: rate limiting silently stops applying, an OTP sent by one
 *  instance cannot be verified by another, and the mail cap becomes
 *  unenforceable — which turns the operator's sending domain into an open
 *  relay. Neither of these tables is an optimisation.
 * ========================================================================== */

create table rate_bucket (
  key          text primary key,                   -- "ingest:<ip_hash>", "mail:global", …
  -- Each bucket judges itself by its OWN window (the M2 fix, carried over):
  -- testing every bucket against the current caller's window is what made the
  -- hourly mail cap resettable by any request to /api/events.
  window_ms    int  not null,
  window_start timestamptz not null default now(),
  count        int  not null default 0
);
create index rate_bucket_gc_idx on rate_bucket (window_start);

-- `consumed_at` within the verified-TTL doubles as the verified-email record,
-- so there is no second table. Verification is per-email in the existing code,
-- which is why funnel_id is nullable and informational.
create table otp (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  funnel_id   uuid references funnel(id),
  code_hash   bytea not null,                      -- never the code itself
  attempts    int  not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index otp_live_idx     on otp (email, expires_at desc);
create index otp_verified_idx on otp (email, consumed_at desc) where consumed_at is not null;

/* ========================================================================== *
 *  Nothing is reachable with the anon key.
 *
 *  Supabase exposes PostgREST publicly and the anon key is designed to be
 *  public, so a table with RLS disabled is world-readable — and `lead` is the
 *  entire product plus personal data under Art. 4. RLS is enabled with NO
 *  policies on purpose: that denies anon and authenticated outright, while
 *  service_role (the only key the runtime uses) bypasses RLS.
 *
 *  The grant revocation below is a second, independent layer. Either one alone
 *  refuses; both have to be wrong to expose a row.
 * ========================================================================== */

alter table client          enable row level security;
alter table funnel          enable row level security;
alter table lead            enable row level security;
alter table delivery_target enable row level security;
alter table delivery        enable row level security;
alter table event           enable row level security;
alter table rate_bucket     enable row level security;
alter table otp             enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables    in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on tables    from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
  end if;
end $$;
