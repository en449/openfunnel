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
| 8 | pg_cron + pg_net jobs (§3.3, §4.5), secret in Vault | **Opus** | 7 | ✅ both parts live on the project; drain proven by attempts 1 → 4 with nobody watching
| 9 | Rate limits → `rate_hit` RPC; `lib/ratelimit.js` keeps its signature | Sonnet | 2 | ✅
| 10 | OTP + verified-email → Postgres; `MAIL_HOURLY_CAP` via `rate_hit` | Sonnet | 2, 9 | ✅ (§4.1, delivered with 9)
| 11 | `Bun.serve` → `handleRequest(req)`, two entry points (§4.2) | **Opus** | 3–10 | ✅
| 12a | Something creates `delivery_target` rows (§4.3) — pulled out of 12 | **Opus** | 3, 5 | ✅ (migration NOT pushed to the live project yet)
| 12 | Delivery-log view in the console + manual re-send (§4.4) | **Opus** (routes) + Sonnet (console) | 5, 12a | ✅
| 13 | Dead-letter alerting to Enno | Sonnet | 5 |
| 14 | Tests: state machine (claim/lease/sweep/dead), dedupe, rate window, cancelled-on-restrict | Sonnet | 5–10 |

Opus keeps 4, 6, 7 and 11 — each one is either the ingest invariant, the privileged-gate
structure, or a decision about what breaks when the process dies between requests. Everything
else is mechanical once the shape above is fixed.

**DSGVO gates (block the phase's exit, not its start):** self-host the eight preset fonts and
delete the Google Fonts path; strip `fonts.googleapis.com` / `fonts.gstatic.com` from the default
`funnelCsp`; swap Resend for Brevo behind an adapter. Flagged when reached, per PLAN.md §10.

---

## 4.1 WO9 + WO10 — the last in-process state moves into Postgres

**Delivered as one work order, not two.** WO9 makes `rateLimit` async and WO10 awaits it at
the OTP call sites; splitting them means two agents editing `lib/email.js`, `routes/otp.js` and
`routes/ingest.js` at the same time for one coherent change.

### Why this is not a cleanup task

`lib/ratelimit.js` and the two `Map`s in `lib/email.js` are correct for exactly one long-lived
server, which is what the project has today and is not what WO11 is porting it to. On a platform
that gives each request its own process, every one of them stops binding — silently, which is the
part that matters:

- **`MAIL_HOURLY_CAP` is the open-relay bound.** `/api/otp/send` and the lead autoresponder both
  mail an address taken from a public request body. Their per-address and per-IP limits are the
  everyday guards, but the per-IP key comes from `clientIp`, which honours caller-supplied
  `x-forwarded-for` — rotate it and only the global cap is left. Per-process, that cap is
  `N × configured` across N instances and effectively absent on serverless.
- **The OTP store breaks the feature outright**, not just its ceiling. A code issued by one
  invocation cannot be found by the next, so a visitor is told their valid code is invalid.
- **`verifiedEmails` fails in the dangerous direction.** `isEmailVerified` answers false for an
  address that just passed the challenge, so `routes/ingest.js` writes `email_verified: false`
  onto a lead that *was* verified and logs the visitor as a liar. The lead is not lost, but the
  operator's data is quietly wrong and nothing indicates it.
- **The ingest limiter** stops bounding how much a script can push into the operator's Postgres.

### The shape

`rate_hit(p_key, p_max, p_window_ms)` already exists in `0002` and is already tested. The three
OTP functions land in `20260811130000_otp_functions.sql` (written, in tree, unreviewed): the
attempt counter has to be incremented under `for update`, because a select-then-update from the
runtime is a lost update and a lost update on that counter turns a five-guess cap into an
unbounded one.

Three decisions that are not the executor's to make:

1. **`rateLimit` becomes `async` and keeps its name, its parameters and its meaning.** One
   limiter, not a fast local one plus a shared one — the moment there are two, a new endpoint
   gets the weak one by accident, and this is the function whose whole job is to bound abuse.
2. **A database failure falls back to the in-process bucket. It never throws and never blocks.**
   Ingest must never fail a visitor, and a rate limiter that 500s under database trouble is a
   worse outage than the abuse it prevents. Degrading to a per-process ceiling is exactly the
   status quo, so the fallback is never worse than today.
3. **Postgres-backed OTP requires a salt.** With `OTP_HASH_SALT` (falling back to `IP_HASH_SALT`)
   unset, the in-memory store stays in use and a warning is logged once. This mirrors the existing
   `IP_HASH_SALT` rule for `lead.ip_hash`: a six-digit code has a million preimages, so an
   unsalted digest in a table is the code wearing a disguise, and storing one would be worse than
   the per-process store it replaces.

### Known cost, accepted

Every rate-limited request gains one PostgREST round trip. `/api/lead` already awaits
`ingest_lead`, so it goes from one to two; `/api/events` already awaits `ingest_event` and does
the same. The alternative — folding the rate check into those two RPCs — saves a round trip on
the hot path and is worth doing if the free tier's connection ceiling is ever actually reached.
Not before: it would put the limiter in two places, and the point of decision 1 is that there is
one.

`/api/otp/send` is the worst case, at **five sequential round trips** before the response — four
ceilings plus `issue_otp` — each bounded by `DB_TIMEOUT_MS` individually and by nothing in
aggregate. Accepted rather than overlooked: they are sequential *because* each one is allowed to
short-circuit the next, which is the behaviour that keeps a refused caller from reaching the mail
path at all, and this route is a deliberate human speed bump rather than the hot path. If it ever
needs bounding, the fix is one `rate_hit_many` RPC taking an array, not a shared deadline — a
partial check is a ceiling that did not bind.

---

## 4.2 WO11 — one router, two entry points

The router is currently the `fetch` callback of a `Bun.serve` call, and everything it needs
that is not the `Request` comes from Bun's `server` object. Vercel hands a function a `Request`
and nothing else. So the port is not "move the code into a function" — it is deciding what the
runtime does when the two things Bun gives it for free are gone: **an identity for the caller's
socket, and a process that is still alive after the response is written.**

### The shape

`apps/runtime/handler.js` exports `handleRequest(req, opts)`, holding the router exactly as it
is today — same route order, same two structural gates, same dispatch-inside-the-branch rule.
Two entry points call it:

- `apps/runtime/server.js` — the Bun entry. Keeps `Bun.serve`, `HOST`/`PORT`, the boot banner
  and `maxRequestBodySize` (a transport-level ceiling only Bun offers). Passes `server`.
- `api/index.js` — the Vercel entry, `export default { fetch }`. That is the documented Web
  Handler form that takes every method in one function, which is what a router needs; the
  named `GET`/`POST` exports would need one per method and would still not cover the rest.

`opts` is `{ server, waitUntil }` and both are optional. Nothing else in `lib/` or `routes/`
learns which platform it is on — `ctx` keeps carrying `server`, it is simply `undefined` on
Vercel, and the two helpers that read it are the two decisions below.

### Decision 1 — no `server` means no loopback trust, and that is the whole removal

`requireAdmin` falls back to `isLoopbackRequest(req, server)` when `ADMIN_TOKEN` is unset. On
Vercel there is no socket to inspect, so the honest answer is "this caller is not local" and
`isLoopbackRequest` returns false the moment `server` is absent. The consequence is deliberate
and is what PLAN.md §7.1 means by *loopback trust is removed*: a Vercel deployment with no
`ADMIN_TOKEN` refuses every privileged request, from everyone, including the operator.

The alternative — inferring "local" from a header, or treating a missing `server` as
permissive — would hand `/api/admin/*` to the internet on the first deploy where someone
forgot an environment variable. A gate that fails open on a platform it has not met yet is not
a gate. `server?.requestIP` optional chaining would produce exactly that failure quietly, so
the check is explicit and reads as a refusal.

### Decision 2 — `clientIp` without a socket collapses every per-IP ceiling into one

`clientIp(req, server)` returns the socket address unless `TRUST_PROXY` is set. With no
`server` and no `TRUST_PROXY` it can only return null, and every per-IP key then becomes
`ingest:unknown` — one shared bucket for all traffic, which is a self-inflicted outage the
first time two visitors submit in the same minute, not a security win.

`TRUST_PROXY=1` is therefore **required** on Vercel (PLAN.md §7.1 already says so, for the
narrower reason that Vercel is always in front). What is new here is that the runtime says so
itself: the first request that arrives with no socket identity and no `TRUST_PROXY` logs it
once, naming the variable. Silent is the failure mode that costs a day.

### Decision 3 — `waitUntil` is a seam, and its fallback is slow rather than lossy

`/api/lead` answers 202 and then does two things without awaiting them: `persist()` (the JSONL
sink, the CAPI forward, and — when the queue did not take the lead — the direct fan-out) and
the inline `drainOnce`. On Bun the process is still there. On Vercel the invocation can be
frozen the moment the response is written, and the one of those that must not be lost is the
**fan-out on the degraded path**: when `queueOwnsIt` is false, nothing else will ever deliver
that lead, and on Vercel the JSONL sink it would otherwise sit in does not exist either.

So deferred work goes through `opts.waitUntil`:

- Bun entry: fire-and-forget with a `catch`, which is exactly today's behaviour.
- Vercel entry: the platform's own `waitUntil`, read off the request-context global that
  `@vercel/functions` itself reads. If it is not there, the entry **awaits** the deferred work
  before returning the response.

The fallback is the point. Taking the dependency would be one line, but the invariant is zero
runtime dependencies and the cost of the internal symbol disappearing is then a slower
`/api/lead`, never a lost lead — the failure direction that is allowed. A `ponytail:` comment
names the upgrade path (`@vercel/functions`) at the call site.

### Decision 4 — `supportsCancellation` stays off, and that is load-bearing

Vercel only aborts `request.signal` on client disconnect when a function opts in
with `"supportsCancellation": true`. `vercel.json` does not, deliberately: the
inline first delivery attempt runs after the 202 and is handed `req.signal`, so
turning cancellation on would abort it the moment the visitor's connection ends
— every lead's first attempt lost to the cron drain instead, which is a delivery
a minute late rather than a delivery now, and it would look like nothing at all
was wrong. Turn it on only together with dropping `req.signal` from that call.

### Decision 5 — the error net moves in, and the Bun one stays

`Bun.serve`'s `error()` callback is the last thing between an unhandled throw and a socket
reset. Vercel has no equivalent, so `handleRequest` wraps its own body: an unhandled throw is
logged through `errSummary` and answered `500 {"error":"internal"}` — the same body Bun's
handler returns today. Bun's `error()` stays as the second net for throws outside the handler.

### What the first deploy actually found (2026-08-12)

Every route answered **500**, funnel pages included, and the reason was one line: `lib/config.js`
computed `REPO_ROOT` from `import.meta.dir`, which is Bun's — on Node it is `undefined`, so
`resolve(undefined, …)` threw while the module graph was still loading. Directly behind it,
`lib/static.js` called `Bun.file`, which would have taken the console and the entire `/_of/*`
engine mirror down the moment the first crash was fixed.

Neither was visible to 219 passing tests, because the tests run on Bun and so does every local
check. `scripts/check-portable-runtime.mjs` now fails CI on `Bun.*` or `import.meta.dir` anywhere
`api/index.js` can reach; `server.js` is exempt, since `Bun.serve` is its whole job. The guard was
red-checked against the two files that shipped broken.

The general form is worth keeping: **the two entry points do not share a runtime, so "the tests
pass" says nothing about the one that is not Bun.**

### Unverified until the first deploy, and named so nobody assumes otherwise

`vercel.json` rewrites every path to the one function and declares
`includeFiles: "{apps/app,packages/engine/src,examples}/**"`. That last part is
load-bearing and untested: `lib/static.js` reads the console shell and the engine
source off disk at request time with computed paths, which Vercel's file tracing
cannot follow — without the glob, `/f/:slug` and `/_app/*` are 404s in production
and pass every test locally. `regions` is deliberately absent; setting the
function region to `dub1` is Enno's call (PLAN.md §2) and belongs with the
project's own settings.

### Known to be broken on Vercel, and deliberately not fixed here

Two things write to the filesystem and will fail on a read-only one: the JSONL sinks in
`lib/store.js` and `email_settings.json` in `lib/email.js`. Both already degrade — `persist`
swallows through `allSettled`, `getEmailSettings` falls back to the environment — so neither
loses a lead, and both are PLAN.md §2.2's job rather than this one. One change is in scope
because it is one line: the `mkdir` in `appendJsonl` currently throws *before* the append's own
`try`, so a read-only mount is the one sink failure that logs nothing at all. It gets logged.

---

## 4.3 WO12a — something has to create `delivery_target` rows

Pulled out of WO12 and ahead of it. Nothing in the system creates a target, so `ingest_lead`
returns `queued = 0` for every real deployment, the route falls through to the legacy fan-out,
and the queue this phase was built for stays empty. "Never lose a lead" is currently true only
for an operator who hand-writes SQL.

### Decision 1 — targets are derived from the configuration the fan-out already reads

Not authored separately. A webhook destination already lives in `WEBHOOK_URL` or the funnel
document's `integrations.webhookUrl`, and `forwardWebhook` resolves it with a precedence chain.
If targets were configured somewhere else, the two would drift — and the fan-out is the
*fallback* the queue degrades to, so the day they disagree is the day a Supabase outage starts
delivering leads to the wrong place. One resolver, exported from `lib/webhook.js`, used by both.

The sync runs where the document is written (`saveFunnel`, inside the `dbConfigured()` branch)
and is idempotent. It never deletes a row — `delivery.target_id` references it — it disables.

### Decision 2 — a `source` column, so the sync cannot disable someone else's row

`delivery_target` gains `source text not null default 'manual'`. The sync owns exactly the
rows with `source = 'funnel'` and this `funnel_id`; anything hand-written is invisible to it.
A partial unique index on `(funnel_id, kind) where source = 'funnel'` makes the upsert an
`on conflict` rather than a select-then-write, which is what stops two concurrent saves
creating two webhook targets for one funnel.

One migration, `20260812…_delivery_target_sync.sql`: the column, the index, and
`sync_delivery_targets(p_slug text, p_targets jsonb)` — resolve slug → funnel + client, upsert
the given kinds, disable the managed rows whose kind is no longer in the list, return the count
enabled. One round trip, atomic, and the disable/enable decision is made in one place.

**It resolves the funnel `for update`, which is correctness rather than tidiness** — review
round 1's second Major. The upsert and the disabling UPDATE take row locks on `delivery_target`
in whatever order each caller's kinds happen to produce, so a save carrying `[webhook]` and a
concurrent `syncAllFunnelTargets()` carrying `[email]` lock the two rows in opposite orders and
Postgres resolves it by aborting one. The loser is swallowed into a warning, so the console
would report a save whose delivery configuration silently did not apply. Locking the funnel row
serialises every sync of one funnel; `saveFunnel`'s own UPDATE of that row runs in a separate
PostgREST transaction holding no `delivery_target` locks, so it can wait but never deadlock.
Measured on a local Postgres 17: a second session's sync waited 1604 ms behind a transaction
holding the row, rather than racing it.

### Decision 3 — every channel the fan-out delivers to gets a queue equivalent

This is the trap in turning the queue on. `persist()` with `fanOut: true` does three outbound
things: the webhook, the operator's "new lead" notification, and the visitor autoresponder. The
moment one target exists, `queueOwnsIt` is true, `fanOut` is false, and any of those three
without a queue equivalent goes **silently dark** — the same class of failure as the
`queued === 0` bug that reached review in WO4.

- **Webhook** → `kind: 'webhook'`, `config: { url, secret }`. Already dispatched.
- **Operator notification** → `kind: 'email'`, `config: { to }`, resolved by `notifyEmailFor()`
  in `lib/email.js` from `integrations.notifyEmail` on the funnel document, falling back to the
  global notification address. Already dispatched (`deliverEmail` sends exactly
  `leadNotificationEmail`).

  **That resolver is shared with the fan-out, and the first version was not.** Review round 1
  caught it: reading the funnel-level address only while deriving a target meant the console's
  new field did nothing at all on a deployment with no database — where `fanOut` is
  unconditionally true — and nothing on a Postgres install for any lead that degraded to the
  fan-out. `persist()` now resolves the funnel document ONCE and hands it to both
  `forwardWebhook` and `notifyOperatorOfLead`, so the queue and the path it degrades to cannot
  mail two different addresses. `notifyEnabled` is the master switch and gates both; an override
  that is not a valid address resolves to nothing rather than falling back, because falling back
  would redirect a client's leads into the operator's own inbox over a typo.

  That one lookup is the only `await` in `persist()` before its `Promise.allSettled`, which
  review round 2 caught as a regression in a guarantee rather than a live bug: had it rejected,
  the two `tasks.push` lines below it would never run — losing the fan-out for that lead — and
  on the Vercel entry point the rejection goes to the platform's `waitUntil` with nothing to
  catch it. It carries its own `.catch`, so "never throws" is a property of `persist()` again
  and not an assumption about what `lib/funnels.js` happens to swallow today.
- **Autoresponder** → not a delivery of the lead at all. It is a courtesy mail to the visitor,
  per-install rather than per-target, and it has never been retried. It moves OUT of the
  `fanOut` branch and runs on every lead, which is both simpler than a third target kind and
  the only version that cannot double-send.

The global notification address is mutable through `/api/admin/email-settings`, and a row
holding a copy of it would keep mailing the old address after a change — so that route
re-syncs. `syncAllFunnelTargets()` walks the non-archived funnels and re-derives; it is also
the backfill for funnels that already exist, exposed as `POST /api/admin/targets/sync` inside
the privileged branch (the only new route, and WO12's console view will call it).

### Decision 4 — an operator-supplied URL is vetted before it becomes a target

`isSafeWebhookTarget` refuses loopback, the private ranges and cloud metadata textually before
a webhook target is written. The dispatcher checks again at send time and that check is the
load-bearing one, but a row that can never deliver should not be created in the first place —
it would sit in the dead-letter list looking like an outage. Refusing at sync time names the
funnel in the log instead.

### Not in scope

The clients view, per-client target management and the delivery log are still WO12/Phase 2.
The console gains exactly one field (`integrations.notifyEmail` in the Integrations modal),
because the field is what makes per-funnel email delivery reachable without hand-editing JSON —
and a server-side consumer with no console field is the mirror of the gap this repo already
tracks.

---

## 4.4 WO12 — the delivery log, and a re-send the operator can actually click

"Never lose a lead" is only half a promise while nobody can see which leads went out. WO4–WO7
made delivery durable and WO12a gave it somewhere to deliver to; this work order makes the queue
legible in the console and gives the operator one action on it.

**No new migration.** `resend_delivery(p_id bigint)` already exists (§3.2) — it resets a terminal
row to `pending`, zeroes `attempts`, **rotates the idempotency key** (an operator clicking re-send
wants the lead to land, so letting the receiver dedupe it into a no-op would be a lie), and refuses
while the lead is `restricted` or `deleted_at` — Art. 18 outranks the button.

### Decision 1 — the log is a read of the queue, not a second copy of it

`GET /api/admin/deliveries?status=<status>&limit=<n>` reads `delivery` through PostgREST with
embeds for the lead, its funnel and the target's kind.

```
{ deliveries: [ { id, status, attempts, lastError, lastStatus,
                  nextAttemptAt, createdAt, deliveredAt,
                  kind, leadId, funnelId, funnelSlug, leadCreatedAt } ] }
```

**`funnelSlug` comes from the server, and the first version of this section was wrong about that.**
It said the console could label a row from `funnelId` itself. It cannot: `/api/funnels` returns
slugs, `funnel.id` is a UUID the console never sees anywhere else, and a client-side lookup by id
would have labelled every row with a raw UUID forever. The nested embed (`lead(…, funnel(slug))`)
is the price of a legible log.

**`delivery_target.config` is never selected.** It holds the webhook secret, and §2's own comment
says it must never be returned by a console API — so the select names `kind` and nothing else from
that table. `last_error` is already `errSummary()` output, truncated, never an error object.

No status counts. The list is filtered and limited, and a count needs either its own round trip per
status or an unbounded scan; WO13 needs a server-side dead-letter count anyway and can bring one
with it.

Without a database this answers `503 { error: "db_not_configured" }` rather than an empty list —
an empty log and no queue at all are opposite situations, and a deployment running on the legacy
fan-out should not be told its delivery log is fine.

### Decision 2 — re-send attempts the delivery immediately, and says what happened

`POST /api/admin/deliveries/resend` with `{ id }`:

1. Read the row first, so an unknown id is `404` and a row in a state `resend_delivery` refuses is
   `409 { error: "not_resendable" }` — including `delivering`, where a lease is still out and a
   second dispatch would double-send.
2. Call `resend_delivery`. It returns false for the same reasons, and that is the authoritative
   answer: the read above races the drain.
3. `drainOnce({ leadId })`, awaited. The operator gets the outcome in the response instead of
   watching a row sit in `pending` until `pg_cron` fires; the dispatcher's own timeouts bound it.

Capped at 30/hour per client address like `/api/admin/test-email`, for the same reason: the route
is authenticated, but a leaked token that can trigger unbounded outbound egress is worth a ceiling.

Two refinements from review, both about telling the operator the truth. `resend_delivery` answers
one boolean for two unrelated situations, so a refusal now looks up whether the lead is restricted
or deleted and says so — Art. 18 is permanent, and an operator told "the state changed" just clicks
again. And the inline drain carries a `limit` and a 20s `deadline`: `claim_deliveries` takes every
due row for the lead, not only the one that was clicked, so without a bound the operator's wait is
a function of something this route cannot see. Accelerating a sibling row that was already due is
harmless; waiting an unbounded number of chunks for it is not.

### Decision 3 — the console panel is read-mostly and boring

One panel in `apps/app`, listing the rows newest-first with a status filter, a re-send button on
terminal rows only, and the existing `POST /api/admin/targets/sync` behind a "re-sync targets"
button (WO12a shipped that route with no caller). No polling loop, no live tail — a refresh button.
A dead delivery is not an emergency the console has to animate; WO13 is what makes it reach Enno.

`/delivery` joins `APP_ROUTES` in `lib/config.js`. Without it the tab works while clicking around
the SPA and 404s on a hard refresh — which is exactly the state someone hits after bookmarking the
page they were told to check when a lead does not arrive.

### Unverified until the first deploy

The PostgREST embed grammar. Local Postgres has no PostgREST, and the live project is not a test
target on a free tier holding synthetic data, so the select is asserted against a stubbed `fetch`
only: the tests pin the columns this code asks for and the shape it returns, not that PostgREST
answers them. If the grammar is wrong the log answers `503 db_unavailable` and says so — the read
path cannot lose a lead, which is why this is allowed to be verified late.

---

## 4.5 WO8 — the drain runs unattended, and what the deployment changed about it

`supabase/cron.sql` was written in WO7 against an assumption that turned out to be wrong: that a
deployed URL is a reachable URL. It is not, and the difference is the whole work order.

### Decision 1 — the schedule splits in two, because half of it never needed a deployment

**Part A** — the stuck-delivering sweeper and the three housekeeping jobs — is pure SQL and can run
today. The sweeper especially: it is what returns rows stranded in `delivering` by a function that
died mid-batch, so making it wait for the thing that strands them has the dependency backwards.

**Part B** is the retry drain, the only job that leaves Postgres.

### Decision 2 — a protected preview answers 302, and pg_net does not call that a failure

Vercel Authentication guards preview deployments, which is exactly why the console is allowed to
live there at all. It also answers `302` to every machine caller — verified against the branch
alias — and `net.http_post` records that as a completed request. A drain scheduled today would look
healthy in `cron.job_run_details` and deliver nothing, forever.

So the drain job carries `x-vercel-protection-bypass`, read from Vault like the drain secret itself,
and the header goes away when the drain is served by an unprotected project. The alternative —
deploying to production so the machine can reach it — would put the console on an unprotected
domain, which is the one thing the Free-tier rule forbids outright.

### Decision 3 — the job targets the branch alias, not a deployment URL

`openfunnel-git-<branch>-<team>.vercel.app` follows the newest deployment of the branch.
A `openfunnel-<hash>-…` URL pins the drain to one build and its environment variables, so a rotated
secret takes delivery down with nothing anywhere reporting it.

### Applied, and proven rather than assumed (2026-08-12)

Part A first: `pg_cron` + `pg_net` enabled, four jobs `active`. Then both secrets into Vault and the
drain scheduled. The one-shot `net.http_post` came back
`200 {"ok":true,"claimed":0,...,"passes":1,"ms":144}`, and the proof that matters arrived a few
minutes later — the queued test delivery had gone from **1 attempt to 4**, backing off, with nobody
touching it. That is the queue running unattended, which is what Phase 1 promised.

`no_transport` is still the error on every attempt: no mail provider key exists on Vercel, so
nothing can actually be delivered until the Brevo adapter lands.

### Not done here

Splitting into a public `funnel` project and a private `console` project (PLAN.md §2) is what
finally removes the bypass header. It belongs with the Pro upgrade that has to happen before a
client funnel goes live, not before it.

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
