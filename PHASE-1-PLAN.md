# Phase 1 — Never lose a lead

> Written 2026-08-11 by Claude (Opus 5). **§2 and §3 approved by Enno; work orders 1–7 are
> built and verified.** The SQL in this file is the design record — the migrations under
> `supabase/migrations/` are the truth, and where a snippet here has drifted from them, they
> win. Companion to [PLAN.md](PLAN.md) (§2.5 is the schema sketch this refines, §2.6 the ingest
> path, §10 the phase checklist) and [PROJECT-MEMORY.md](PROJECT-MEMORY.md). Nothing here
> re-opens the security audit — `security-audit/SUMMARY.md` stands.
>
> Two rounds of review are folded in. Round 1 found the fencing hole in the transitions; round 2
> found that the fence could still collide across a re-send, and that two documented claims about
> PostgREST were false. Both are marked in place.

---

## 0. What Phase 1 has to be true at the end

A lead submitted on a real phone reaches every configured target in under 5 seconds. Killing a
target for an hour loses nothing, and the drain delivers it on recovery. Every delivery has a
state a human can read. Nothing about a failure is discoverable only in a log.

Everything below exists to make those four sentences enforceable rather than aspirational.

---

## 1. Four decisions that shape the schema

These are decided, not open. They are recorded because each one closes off an alternative that
looks reasonable from the outside.

### 1.1 All database access goes through PostgREST. No SQL driver.

The repo has a CI-enforced zero-runtime-dependency invariant (`scripts/check-no-deps.mjs`), and
`supabaseInsert()` already speaks PostgREST over plain `fetch`. Adding `pg` or `postgres.js`
would break the invariant in CI, and on serverless it would also drag in connection-pool
management (pgbouncer transaction mode, prepared-statement incompatibility, connection storms on
cold start) that PostgREST removes entirely.

The consequence is the shape of everything below: **anything that needs a transaction or
`FOR UPDATE SKIP LOCKED` is a Postgres function, called as `POST /rest/v1/rpc/<name>`.** One
PostgREST request is one transaction, so an RPC call is the transaction boundary.

So: *state transitions live in SQL, dispatch lives in JavaScript.* The JS side never writes a
status string by hand — it calls `claim_deliveries` / `complete_delivery` / `fail_delivery`.
There is exactly one place a delivery can change state, and it is not reachable from a route
handler that forgot a rule.

### 1.2 RLS on every table, execute revoked on every function.

Supabase exposes PostgREST publicly and the `anon` key is designed to be public. **A table with
RLS disabled is readable with that key.** A `lead` table is the entire product and it is personal
data under Art. 4. So:

- `alter table … enable row level security;` on every table, **with no policies**. That denies
  `anon` and `authenticated` outright; `service_role` bypasses RLS and is the only key the
  server uses.
- Functions are **`SECURITY INVOKER`** (the default — deliberately *not* `SECURITY DEFINER`), and
  `execute` is revoked from `public`, `anon` and `authenticated`. A `SECURITY DEFINER` function
  reachable by `anon` over `/rpc/` is a complete bypass of the RLS above; invoker semantics mean
  the worst case of a botched revoke is "RLS denies it", not "full access".

Two independent layers, and the failure mode of each one alone is refusal.

### 1.3 The funnel document moves into Postgres in this phase.

Not on the five-item list in the brief, but forced by the schema: `lead.funnel_id` is a foreign
key, so a funnel row has to exist before a lead can be stored. It is also what stops client copy
being committed into a public repo — `FUNNELS_DIR` defaults to `examples/`, inside the published
tree (PROJECT-MEMORY decision 7).

Sized honestly: `lib/funnels.js` swaps a directory read for a PostgREST `GET` behind the same
60s cache, and `routes/builder.js` swaps a file write for an upsert. `SLUG_RE`, `publicFunnel()`
redaction and the path-containment checks stay exactly as they are.

### 1.4 `/api/internal/*` is its own structural gate, not part of the admin gate.

The drain is called by `pg_net` from Supabase's network — a machine, no browser, no `Origin`.
It could be squeezed under `PRIVILEGED_PREFIXES`, but that makes the operator's `ADMIN_TOKEN`
the same secret that sits in a Supabase cron job: rotating one silently breaks the other.

So a second branch in the router, built the same way as the first — prefix constant, check, and
the handler dispatched **inside** the branch so it is unreachable except through the check.
`safeEqual()` already exists in `lib/auth.js`. `/api/internal/*` is never added to
`PUBLIC_CORS_PATHS`.

---

## 2. Schema — Phase 1 tables only

Only the tables Phase 1 code actually touches. `asset`, `domain`, `report_token`, `funnel_daily`
and `funnel_version` from PLAN.md §2.5 are Phase 2/3 and are deliberately absent — with the
Supabase CLI a new table is one migration file, and DDL for a table nothing reads is a liability
that looks like foresight.

```sql
-- ===========================================================================
-- 0001_phase1.sql
-- ===========================================================================

-- gen_random_uuid() is core since PG13; no extension needed.

-- --- Tenancy-shaped from day one, even with one operator ------------------

create table client (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  contact_email    text not null,
  vertical         text,
  avv_signed_at    timestamptz,                 -- GATE (§8.9): publish refused while null
  retention_months int  not null default 12,    -- lead auto-purge horizon (§8.7)
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table funnel (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references client(id),
  slug         text not null unique,            -- SLUG_RE, unchanged
  name         text not null,
  doc          jsonb not null,                  -- the JSON contract in engine/src/types.js
  status       text not null default 'draft'
               check (status in ('draft','live','paused','archived')),
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index funnel_client_idx on funnel (client_id);

-- --- The product ----------------------------------------------------------

create table lead (
  id             uuid primary key default gen_random_uuid(),
  funnel_id      uuid not null references funnel(id),
  client_id      uuid not null references client(id),   -- denormalised, set by the RPC
  payload        jsonb not null,                        -- { lead, answers }
  utm            jsonb,
  consent        jsonb,                                 -- { signal, at, text_version }
  email_verified boolean not null default false,
  ip_hash        bytea,                                 -- salted hash. never the raw IP
  user_agent     text,
  dedupe_key     text,
  spam_score     int  not null default 0,
  is_spam        boolean not null default false,
  restricted     boolean not null default false,        -- Art. 18: blocks delivery and export
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz                            -- soft; hard-deleted within 24h (§8.7)
);
create unique index lead_dedupe_idx  on lead (dedupe_key) where dedupe_key is not null;
create index        lead_funnel_idx  on lead (funnel_id, created_at desc);
create index        lead_client_idx  on lead (client_id, created_at desc);
create index        lead_payload_idx on lead using gin (payload jsonb_path_ops);  -- Art. 15

-- --- Where leads go -------------------------------------------------------

create table delivery_target (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references client(id),
  funnel_id  uuid references funnel(id),        -- null = every funnel of this client
  kind       text not null check (kind in ('email','webhook','sheet')),
  config     jsonb not null,                    -- secrets; never returned by any console API
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
create index delivery_target_client_idx on delivery_target (client_id) where enabled;

-- --- The queue. This table is the reason the project exists. --------------

create table delivery (
  id              bigserial primary key,
  lead_id         uuid not null references lead(id) on delete cascade,
  target_id       uuid not null references delivery_target(id),
  status          text not null default 'pending'
                  check (status in ('pending','delivering','done','dead','cancelled')),
  attempts        int  not null default 0,      -- counts CLAIMS, not responses
  next_attempt_at timestamptz not null default now(),   -- pending: not-before. delivering: lease expiry.
  last_error      text,                         -- errSummary() output only, truncated to 500
  last_status     int,
  idempotency_key uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (lead_id, target_id)
);
create index delivery_due_idx on delivery (status, next_attempt_at)
  where status in ('pending','delivering');

-- --- Drop-off -------------------------------------------------------------

create table event (
  id         bigserial primary key,
  funnel_id  uuid not null references funnel(id) on delete cascade,
  session_id text not null,
  type       text not null,                     -- view | step | answer | submit | drop
  step_id    text,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index event_funnel_idx on event (funnel_id, created_at);

-- --- Was an in-process Map. Does not bind on serverless. ------------------

create table rate_bucket (
  key          text primary key,                -- "ingest:<ip_hash>", "mail:global", …
  window_ms    int  not null,                   -- each bucket judges itself by its own window
  window_start timestamptz not null default now(),
  count        int  not null default 0
);
create index rate_bucket_gc_idx on rate_bucket (window_start);

-- Same reason. Send on one instance, verify on another.
create table otp (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  funnel_id   uuid references funnel(id),       -- informational; verification is per-email
  code_hash   bytea not null,                   -- never the code itself
  attempts    int  not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,                      -- doubles as the verified-email record
  created_at  timestamptz not null default now()
);
create index otp_live_idx     on otp (email, expires_at desc);
create index otp_verified_idx on otp (email, consumed_at desc) where consumed_at is not null;

-- --- Nothing is readable with the anon key --------------------------------

alter table client          enable row level security;
alter table funnel          enable row level security;
alter table lead            enable row level security;
alter table delivery_target enable row level security;
alter table delivery        enable row level security;
alter table event           enable row level security;
alter table rate_bucket     enable row level security;
alter table otp             enable row level security;
-- No policies, on purpose. service_role bypasses RLS; anon and authenticated get nothing.
```

### 2.1 What changed from PLAN.md §2.5, and why

| Change | Reason |
| --- | --- |
| `asset`, `domain`, `report_token`, `funnel_daily`, `funnel_version` deferred | Phase 2/3 tables. One migration file each when the code that reads them exists. |
| No `verified_email` table | `otp.consumed_at` within the TTL **is** the verified record. `isEmailVerified()` becomes one indexed lookup. Deletes a whole table from the sketch. |
| `otp.funnel_id` nullable | Verification is per-email in the existing code, not per-funnel. A `not null` here would break a visitor who verified on a different funnel. |
| `delivery_target.funnel_id` added, nullable | `forwardWebhook()` already reads `integrations.webhookUrl` off the funnel document — per-funnel targets are an existing capability, not a new one. Null = client-wide. |
| `delivery.kind` limited to `email\|webhook\|sheet` | `sms`/`whatsapp` are Phase 3. Widening a check constraint is a one-line migration; a target kind nothing dispatches is a silent black hole. |
| `delivery` gains `cancelled` | Art. 18 `restricted` and soft-delete have to stop pending deliveries. Without a terminal state those rows sit `pending` forever and the queue never drains clean. |
| `unique (lead_id, target_id)` | Makes double-enqueue impossible. `leads.js` sends with `sendBeacon` **and** a `keepalive` fetch fallback, so a genuine double-post is a live path, not a hypothetical. |
| `next_attempt_at` doubles as the claim lease | A separate `claimed_at` column plus its own index buys nothing: pending rows read it as "not before", claimed rows as "lease expires". The sweeper is then one predicate. |
| Backoff is a formula, not a table | `least(12h, 30s · 3^attempts)` reproduces the plan's 5s→12h grace (~21h over 8 attempts) as one SQL expression that both the inline path and the drain share. A table in JS drifts from a table in SQL. |
| Index is `(status, next_attempt_at) where status in ('pending','delivering')` | §2.5's `where status='pending'` does not serve the sweeper, so the stuck-row scan would go sequential over a table that is 99% terminal rows. |
| RLS + execute revocation | Absent from §2.5 entirely. See §1.2 — without it the `lead` table is readable with a key that is public by design. |
| `event.meta jsonb` added | The engine's event payload carries more than `step_id`; without a home it would be dropped on the floor at exactly the point drop-off analysis needs it. |
| `lead.payload` is `{ lead, answers }` with `answers.contact` dropped | REALITY-CHECK §7: contact fields are stored twice today. Duplicated personal data in a record that must be provably deletable. Collapse it as the data moves. |

---

## 3. The delivery state machine

One row per `(lead, target)`. The row **is** the desired end state, not a log entry.

```
                       ingest_lead() inserts one row per enabled target
                                        │
                                        ▼
   ┌───────────────────────────────► pending ◄──────────────────────┐
   │                                    │                           │
   │                     claim_deliveries()                         │
   │                (inline via after(), or the cron drain)         │
   │                                    ▼                           │
   │                              delivering ───────────────────────┘
   │                                 │   │            fail_delivery()
   │                                 │   │            attempts < 8
   │                                 │   │            next_attempt_at = now()+backoff
   │      sweep_stuck_deliveries()   │   │
   └──── lease expired (>5 min) ─────┘   │
                                         ├─── complete_delivery() ──►  done   (terminal)
                                         │
                                         └─── fail_delivery(), attempts ≥ 8 ──►  dead  (terminal, alerts Enno)

   pending ──── lead restricted (Art. 18) or soft-deleted ────►  cancelled  (terminal)
   dead    ──── operator re-send in the console ─────────────►  pending  (attempts=0, NEW idempotency_key)
```

### 3.1 Rules the machine holds to

1. **`attempts` counts claims, not responses.** Incremented at claim time, inside the claiming
   `UPDATE`. If the invocation dies mid-send the attempt is still counted — because the receiver
   may already have processed it. Counting only on failure means a hung send never counts and
   the row retries forever.

2. **A claim is a lease, and the lease is `next_attempt_at`.** Claiming sets
   `status='delivering', next_attempt_at = now() + 5 minutes`. The sweeper is exactly
   `status='delivering' AND next_attempt_at < now()`. Five minutes is Vercel's maximum function
   duration on Fluid, so a lease cannot expire under a still-running send.

3. **There is one claim path.** `claim_deliveries(p_limit, p_lead_id)` — the inline first attempt
   passes `p_lead_id`, the cron drain passes null. Both go through the same
   `FOR UPDATE SKIP LOCKED`. A second claim path written by hand is how the inline attempt and
   the drain double-send the same lead, so there is not one.

4. **Automatic retries keep the `idempotency_key`. A manual re-send mints a new one.** A retry
   after a timeout may be hitting a receiver that already succeeded, which is exactly what the
   key is for. An operator clicking "re-send" wants the lead to actually land, so the key rotates
   or the receiver would dedupe the re-send into a no-op.

5. **A restricted or deleted lead never dispatches — checked twice.** The claim query joins
   `lead` and skips `restricted = true` / `deleted_at is not null`; the restrict/delete action
   also flips pending rows to `cancelled` so the queue drains clean. Two mechanisms for one rule
   is overkill everywhere except a legal guarantee, and Art. 18 is a legal guarantee.

6. **`last_error` stores `errSummary()` output, truncated to 500 chars — never an error object.**
   Bun puts the full request URL on `err.path`, and a webhook URL routinely carries a token in
   its path. The console displays this field.

7. **`attempts` is a fencing token, and every transition presents it.** `and status =
   'delivering'` alone is not enough — this was the first draft's rule and it was wrong, caught
   in review and reproduced. The system's own recovery machinery builds the interleaving: an
   invocation hangs past its five-minute lease, the sweeper returns the row to `pending`, the
   drain re-claims it as `attempts = 2`, and only then does the original invocation answer. It
   finds a `delivering` row and completes it, so the row reads `done` while the live attempt's
   real outcome is discarded — or, in the mirror case, a stale failure pushes a live claim back
   to `pending` and the lead is delivered twice. Both are the two outcomes this project exists
   to prevent. Vercel's `after()` not stopping on abort is exactly how an invocation outlives
   its lease.

   **The token is the pair `(attempts, idempotency_key)`, not `attempts` alone** — the second
   half was a review finding on the first fix. `attempts` separates claim episodes within one
   generation, but `resend_delivery` rewinds it to zero, so an answer from before a
   dead-letter-then-resend cycle carries the same number the post-resend claim was handed.
   The idempotency key separates generations: minted once, rotated by exactly that resend.
   Both already come back from `claim_deliveries`, so the fence costs two arguments and no
   schema.

### 3.2 The functions

```sql
-- Retry schedule: 30s, 90s, 4.5m, 13.5m, 40m, 2h, 6h, 12h → ~21h of grace over 8 attempts.
-- Worst-case pickup is bounded by the one-minute cron tick, so the first two steps
-- collapse to "next tick" in practice. The first attempt is inline and not on this schedule.
create function delivery_backoff(p_attempts int) returns interval
language sql immutable as $$
  select least(interval '12 hours',
               interval '30 seconds' * power(3, greatest(p_attempts, 0)));
$$;

-- The ONE claim path. Returns everything a dispatch needs, so there is no N+1 read
-- between claiming and sending.
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

create function claim_deliveries(p_limit int default 25, p_lead_id uuid default null)
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
       and l.restricted = false          -- Art. 18
       and l.deleted_at is null
       and t.enabled
     order by d.next_attempt_at, d.id    -- id breaks the tie so the order is total
       for update of d skip locked
     limit p_limit
  ),
  claimed as (
    update delivery d
       set status = 'delivering',
           attempts = d.attempts + 1,
           next_attempt_at = now() + interval '5 minutes'   -- the lease
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

-- (p_attempt, p_key) is the fencing pair, handed back by the claim. See rule 7 —
-- `status = 'delivering'` alone lets a superseded claim decide the outcome, and
-- `attempts` alone collides across a resend, which rewinds it.
create function complete_delivery(p_id bigint, p_attempt int, p_key uuid, p_status int default null)
returns boolean language sql volatile as $$
  with u as (
    update delivery
       set status = 'done', delivered_at = now(), last_status = p_status, last_error = null
     where id = p_id and status = 'delivering'
       and attempts = p_attempt and idempotency_key = p_key
    returning 1
  ) select exists (select 1 from u);
$$;

-- Returns the resulting status so the caller knows when to alert on a dead letter,
-- and null when nothing matched — a superseded claim, on which the caller must
-- neither alert nor retry: whoever holds the current claim owns the outcome.
create function fail_delivery(
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

-- Runs as pure SQL inside Postgres on a pg_cron tick. No HTTP call, so a Vercel
-- outage cannot also take out the mechanism that recovers from a Vercel timeout.
create function sweep_stuck_deliveries() returns int language sql volatile as $$
  with s as (
    update delivery
       set status = 'pending', next_attempt_at = now() + delivery_backoff(attempts)
     where status = 'delivering' and next_attempt_at < now()
    returning 1
  ) select coalesce(count(*), 0)::int from s;
$$;
```

**Ingest, atomically — the lead and its delivery rows in one transaction (§2.6 step 3):**

```sql
create function ingest_lead(
  p_slug text, p_payload jsonb, p_utm jsonb, p_consent jsonb,
  p_email_verified boolean, p_ip_hash bytea, p_user_agent text, p_dedupe_key text
) returns table (lead_id uuid, queued int, deduped boolean)
language plpgsql volatile as $$ … $$;
-- Resolves slug → funnel — deliberately NOT filtered on status. Refusing a
-- paused or archived funnel drops the lead of a visitor who loaded the page
-- seconds before the operator changed it, which is the failure this phase
-- removes; a direct POST to an archived slug only reaches that client's own
-- targets. Which statuses are SERVED is /f/:slug's call. Then inserts the lead with
-- `on conflict (dedupe_key) do nothing`, then inserts one delivery row per enabled
-- target whose funnel_id is null or matches. Returns deduped=true and queued=0 when
-- the conflict fired, so a double-tapped submit costs nothing.

-- Fixed-window limiter, atomic in one statement.
-- ponytail: fixed window, so a burst straddling the boundary can reach 2× max within a
-- sliding window. Acceptable for abuse ceilings; switch to a timestamp array only if a
-- real ceiling is ever actually exceeded.
create function rate_hit(p_key text, p_max int, p_window_ms int) returns boolean
language plpgsql volatile as $$ … $$;
```

### 3.3 pg_cron schedule

| Job | Cadence | What it does |
| --- | --- | --- |
| `drain` | every minute | `pg_net` POST → `/api/internal/drain`, shared secret from Supabase Vault |
| `sweep` | every minute | `select sweep_stuck_deliveries();` — pure SQL, no HTTP, no timeout risk |
| `rate_gc` | hourly | `delete from rate_bucket where window_start < now() - interval '1 day'` |
| `otp_gc` | hourly | `delete from otp where expires_at < now() - interval '1 day'` |
| `event_purge` | daily | `delete from event where created_at < now() - interval '90 days'` |

The drain endpoint: batch of 25, per-delivery timeout 10s, dispatch concurrency 5 → worst case
~50s, comfortably inside the next tick and far inside the 5-minute lease.

---

## 4. Work orders, in dependency order

Each is sized for one Sonnet 5 subagent and names this file plus its own section. Reviewer + qa
run after every non-trivial one; the parent applies all fixes. Baseline after each piece:
`bun test` (128 pass / 1 known Bun 1.3.13 ingest failure) · `bun run typecheck` ·
`bun run scripts/check-no-deps.mjs` · `bun run scripts/check-engine-imports.mjs`.

| # | Work order | Tier | Depends on |
| --- | --- | --- | --- |
| 1 | Supabase CLI init + `0001_phase1.sql` (§2) + `0002_functions.sql` (§3.2) + seed with a synthetic client/funnel/targets | Sonnet | approval | ✅
| 2 | `lib/db.js` — PostgREST client over `fetch`: `select`, `insert`, `rpc`, `errSummary` logging, no secrets in errors | Sonnet | 1 | ✅
| 3 | Funnels from Postgres: `lib/funnels.js` read + `routes/builder.js` write, cache and redaction unchanged (§1.3) | Sonnet | 2 | ✅
| 4 | Ingest → `ingest_lead` RPC; degrade-forward on insert failure; IP hashing with `IP_HASH_SALT` | **Opus** | 2, 3 | ✅
| 5 | `lib/delivery.js` — dispatch by kind (webhook w/ `Idempotency-Key`, email, sheet) + claim/complete/fail loop | Sonnet | 2 | ✅
| 6 | Inline first attempt after the 202, abort-polled | **Opus** | 4, 5 | ✅
| 7 | `/api/internal/drain` + its own router gate (§1.4) | **Opus** | 5 | ✅
| 8 | pg_cron + pg_net jobs (§3.3), secret in Vault | Sonnet | 7 |
| 9 | Rate limits → `rate_hit` RPC; `lib/ratelimit.js` keeps its signature | Sonnet | 2 |
| 10 | OTP + verified-email → Postgres; `MAIL_HOURLY_CAP` via `rate_hit` | Sonnet | 2, 9 |
| 11 | `Bun.serve` → `handleRequest(req)`, two entry points | **Opus** | 3–10 |
| 12 | Delivery-log view in the console + manual re-send | Sonnet | 5 |
| 13 | Dead-letter alerting to Enno | Sonnet | 5 |
| 14 | Tests: state machine (claim/lease/sweep/dead), dedupe, rate window, cancelled-on-restrict | Sonnet | 5–10 |

Opus keeps 4, 6, 7 and 11 — each one is either the ingest invariant, the privileged-gate
structure, or a decision about what breaks when the process dies between requests. Everything
else is mechanical once the shape above is fixed.

**DSGVO gates (block the phase's exit, not its start):** self-host the eight preset fonts and
delete the Google Fonts path; strip `fonts.googleapis.com` / `fonts.gstatic.com` from the default
`funnelCsp`; swap Resend for Brevo behind an adapter. Flagged when reached, per PLAN.md §10.

---

## 5. Open — needs Enno's answer

1. **Down migrations.** PLAN.md §10 asks for up *and* down. The Supabase CLI is up-only by
   convention; the down for a pre-production database is `supabase db reset`. Proposal: no paired
   down files while there is no live data, and a rollback statement in the header comment of any
   migration that ever runs against a database holding real leads. Say if you want the paired
   files anyway.
2. **Funnel documents into Postgres this phase** (§1.3) — implied by the schema, not on the
   five-item list. Confirm the scope.
3. **Collapse `answers.contact`** so contact fields are stored once (REALITY-CHECK §7). Changes
   what the console's lead inbox reads. Confirm.

## 6. Noted, deliberately deferred

- **`ingest_lead` does not check `client.deleted_at` either**, for the same reason it does not
  check `funnel.status`. Nothing in Phase 1 sets that column; whoever wires client termination
  decides then whether ingest should stop, and it is a different question from whether a page
  is served.
- **`PT404`, not `P0002`.** PostgREST maps its own `PTxxx` SQLSTATE range onto HTTP status
  codes; a plain `P0002`/`no_data_found` arrives as a generic 500, which the runtime would read
  as "database down" and degrade forward for a funnel that has no targets. Verified on the wire,
  and the integration check now asserts the status rather than trusting the comment.
- **401/403 classify as `unavailable`, not `rejected`.** A rotated service-role key answers 401
  to every request; as "the database said no to this record" that would log-and-202 every lead
  for every client, silently and indefinitely. Nothing is wrong with the lead — the connection
  is broken, which is what degrade-forward is for.
