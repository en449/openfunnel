# Funnel Platform — Build Plan

> Status: **PLAN ONLY — nothing built.** Written 2026-08-10 by Claude (Opus 5).
> Gate: pre-mortem run 2026-08-10, revised after Enno's three decisions. Awaiting explicit go.
> Companion docs: [PROJECT-MEMORY.md](PROJECT-MEMORY.md) (state + decision log),
> [security-audit/SUMMARY.md](security-audit/SUMMARY.md) (all findings),
> [reference/postgres-tenant-isolation.md](reference/postgres-tenant-isolation.md) (RLS + HTTP retry-safety),
> [reference/market-research-2026-08-10.md](reference/market-research-2026-08-10.md) (Perspective.co, competitors, DSGVO positioning, German SMB integrations).
>
> **This project is standalone.** No coupling to the 30-day sprint, the web dev business, or JV
> brokering. Knowledge from those is reusable; their plans and action items are not.

---

## 0. Decisions that shape everything below

Taken 2026-08-10:

| Question | Decision |
| --- | --- |
| Product shape | **Done-for-you funnels.** Enno operates funnels for clients. The platform is delivery infrastructure, not a self-serve product. |
| AGPL-3.0 | **Clean-room rewrite of the engine** — planned as Phase R, deliberately deferred (see §11). |
| Scope now | **Single operator, single account.** Build the full design, implement only what one operator needs. Everything skipped keeps its seam. |
| Relationship to other work | **Standalone.** No coupling to the 30-day sprint, the web dev business, or JV brokering. Knowledge from those is reusable; their plans are not. |

**Hard constraint, overrides everything below: DSGVO conformity.** Not a section, not a phase, not a
launch checklist item — a property every design decision is checked against. Enno is a processor
(Auftragsverarbeiter) holding German consumers' personal data on behalf of clients. Where a technical
choice and a compliance requirement conflict, the compliance requirement wins and the technical choice
changes. §8 is the full treatment; the rules there bind §2 (architecture), §4 (integrations),
§5 (access) and every phase in §10. Anything that cannot be made conform does not ship.

Non-goals, stated so they stop coming back:

- Not a self-serve SaaS. Nobody signs up. There is no pricing page, no trial, no billing.
- Not a Perspective competitor. Competing on features with a Berlin GmbH holding 5,000+ customers is a losing frame at one person.
- Not a CRM. Leads leave the system; they do not live in it.
- Not multi-region. One region, `dub1` / `eu-west-1` (Ireland). The project was created there 2026-08-11 and Supabase cannot move a project afterwards; Ireland is EU/EEA, so DSGVO applies unchanged and §8.0's analysis — which is about the processors being US *companies*, not about which datacentre — is untouched. Vercel functions go in `dub1` to sit next to the database rather than paying ~25-30ms per round trip to Frankfurt. (Multi-*instance* is no longer a choice — serverless makes it the default, which is why §2.2 moves three in-memory stores to Postgres in Phase 1.)

---

## 1. What the product actually is

A funnel is a mobile page a cold ad click lands on: marketing hero → 3–6 qualifying questions → contact form → thank-you. The visitor's answers plus their contact details are a **lead**. The lead's only job is to reach the client fast and never be lost.

Three surfaces, three audiences:

| Surface | Who | Reachable from |
| --- | --- | --- |
| **Funnel** (`/f/:slug`, client custom domains) | ad traffic, the public | the open internet |
| **Console** (builder, leads, delivery log, settings) | Enno, alone | private network only — never the public internet |
| **Client report** (`/r/:token`) | the paying client, read-only | the internet, via a signed expiring link, no login |

That split is the whole security model and it is why this needs almost no auth code (§8).

### What makes it worth building rather than renting

Renting Perspective Base is €59/mo for 2 live funnels. Ten clients = the Expand tier at €297–369/mo plus a €67–84/mo white-label add-on, and lead overage at €0.25 each. Heyflow Growth is €89/mo for 250 responses. So the rent scales with client count and lead volume — exactly the two numbers a DFY business wants to grow.

But cost is the weak reason. The real ones, in order:

1. **Lead delivery you control.** Every complaint pattern the research surfaced against both incumbents is the same shape: leads that did not arrive, or arrived worthless, and a support desk that answered in a week. When you are the DFY operator, a lost lead is your fault regardless of whose platform dropped it. Owning the delivery path is owning the one thing the client is actually paying for.
2. **Speed-to-lead.** For trades, the vendor who calls back first wins the job. A lead sitting in an inbox for four hours is a lost job. This is a delivery-latency problem, and it is precisely the gap in the current code (`Promise.allSettled`, failures are a `console.warn`).
3. **Production line.** Your throughput is funnels-per-week. A builder tuned to *your* templates and *your* verticals beats a general-purpose builder tuned for a stranger's first funnel.
4. ~~**DSGVO story.**~~ **Withdrawn 2026-08-10** — see §8.0. On Vercel + Supabase the infrastructure is EU-region but US-processor under SCCs, the same position as the incumbents. What survives is narrower and still real: your own AVV per client, no Google Fonts, no unnecessary third party on the funnel page, and a deletion path that actually works. Do not sell "kein US-Anbieter".

### What the market research changes in the plan

From [reference/market-research-2026-08-10.md](reference/market-research-2026-08-10.md), the findings that actually alter build decisions:

- **Handwerk software has no confirmed public APIs.** STREIT, HERO, mfr, Smarthandwerk, TAIFUN — no market-share data, no developer docs found. **Consequence: build zero vertical CRM integrations.** Email + webhook + Google Sheets + Zapier/Make covers every case, and the long tail is Zapier's problem, not yours. This deletes an entire workstream.
- **onOffice** (real estate, 42% DACH claimed) has a public API and a Zapier app — the one named vertical CRM worth a direct integration, and only if a real estate client exists.
- **Dampsoft** (dental, ~35%) is partner-gated via Dr. Flex. Not integrable. Dental leads go by email.
- Category meters on **completions**, not visitors. Irrelevant for pricing here (no billing), but it confirms the unit the client cares about is a delivered lead — so that is the unit the client report shows.
- Both incumbents draw complaints about **billing/cancellation friction** and **slow support**. Not applicable to you now, and worth remembering as the two things not to reproduce if this ever productizes.

---

## 2. Architecture

> **Revised 2026-08-10 (session 3): Vercel + Supabase, not a Hetzner VPS.** Enno's call. The DSGVO
> consequence is accepted explicitly — see §8.0. The previous design (single Debian box, Postgres on
> the same machine, Caddy on-demand TLS, Tailscale-only console) is superseded; it is recorded in
> the git history of this file, not repeated here.

### 2.1 Shape

Two Vercel projects against one Supabase Postgres. The split is the security model: the public
project has no admin code deployed to it at all.

```
                         Internet
                            │
        ┌───────────────────┴────────────────────┐
        ▼                                        ▼
┌───────────────────────────┐          ┌──────────────────────┐
│  PROJECT: funnel  (public)│          │ PROJECT: console     │
│  region dub1, Node runtime│          │ region dub1          │
│                           │          │ Vercel Authentication│
│  kunde.de                 │          │ (SSO) on the whole   │
│  *.f.enno.de  (wildcard)  │          │ deployment           │
│                           │          │                      │
│  GET  /f/:slug            │          │  builder SPA         │
│  GET  /_of/*              │          │  /api/admin/*        │
│  POST /api/lead           │          │  /api/builder/*      │
│  POST /api/events         │          │  /api/ai/*           │
│  POST /api/otp/*          │          │                      │
│  GET  /r/:token           │          │                      │
│  POST /api/internal/drain │          │                      │
└─────────────┬─────────────┘          └──────────┬───────────┘
              │                                   │
              └─────────────┬─────────────────────┘
                            ▼
              ┌──────────────────────────────┐
              │  Supabase — eu-west-1        │
              │  Postgres  (leads, queue,    │
              │             rate limits, OTP)│
              │  Storage   (funnel assets)   │
              │  pg_cron + pg_net → drain    │
              └──────────────────────────────┘
```

**Plan tiers — build on Free, upgrade at the first real client (decided 2026-08-11).**
Vercel Pro + Supabase Pro is ~€45/month and is where this lands, but not until a client's
leads are involved.

The two reasons originally given here were wrong and are corrected for the record:
Hobby's 10s function cap applies only to projects deployed before 2025-04-23 without
Fluid compute — with Fluid (default on new projects) Hobby is **300s default and max**.
And Vercel's daily-only cron limit never applied, because the retry drain runs on
`pg_cron` inside Supabase (§5.3), deliberately.

The reasons that do bind, all three at the moment a real lead arrives:

| | Hobby / Free | Why it blocks client work |
| --- | --- | --- |
| Vercel DPA | **Pro and Enterprise only** — the DPA's own scope line | No Art. 28 processor contract, so the §8.0 gate cannot be met at all. Decisive. |
| Vercel ToS | "non-commercial, personal use only" (fair-use guidelines) | Client funnels are commercial. Suspension risk on the page the ads point at. |
| Deployment Protection | Standard Protection only — "your production domain remains publicly accessible" | The console has no login of its own by design (§5.2). On Hobby it would be world-readable. |
| Supabase Free | no automatic backups, 500 MB, 5 GB egress, pauses after 7 days idle | A lead database with no backups is the failure this project exists to prevent. |

Supabase's DPA is auto-incorporated on every tier, so Free is lawful — its limits are
operational, not legal. `pg_cron` and `pg_net` are not tier-gated either.

**So the build runs on Free with one rule: no real personal data.** Synthetic test leads
only, console never on a production domain (run it locally or as a preview deployment),
and the upgrade to both Pro tiers happens *before* the first client funnel goes live —
not after.

### 2.2 What this costs in porting work

Three things in the current code do not survive serverless. All three are Phase 1.

**1. `Bun.serve` is a long-running server.** `apps/runtime/server.js` owns route order and the
privileged gate, then delegates to `routes/*.js` — and those modules are already
`handle<Name>(req, ctx) → Response | null`, which is Web-standard. So the port is small: extract the
router into `handleRequest(req)` and give it two entry points — a Vercel function for production,
and a thin `Bun.serve` wrapper for local dev. One router, two shells, no logic duplicated.

**Node runtime, not Edge.** `resolveSafeTarget()` resolves DNS and then connects to the vetted IP
carrying the original `Host`. Edge has no `dns` module and no socket control, so the SSRF guard
would have to be weakened to run there. That is not a trade worth making.

**2. There is no process to run a worker in.** The `setInterval` delivery loop cannot exist. It is
replaced by two mechanisms that together give both speed and durability:

- **Inline first attempt.** After the 202, the same invocation attempts delivery via Vercel's
  `after()`. This preserves speed-to-lead at ~2s, which is the product claim.
  **Known gotcha:** Vercel's `after()` ignores abort — poll `assertNotAborted()` between pipeline
  steps or a cancelled request keeps burning function time.
- **Cron-driven retry drain.** `pg_cron` in Supabase fires every minute and `pg_net` POSTs to
  `/api/internal/drain` with a shared secret. The claim query is unchanged —
  `FOR UPDATE SKIP LOCKED` is a Postgres feature and does not care what runs it.

Scheduling from Postgres rather than Vercel Cron is deliberate: the schedule lives next to the
queue it drains, it survives a bad Vercel deploy, and it does not depend on the Pro cron tier.

**3. In-process `Map`s break on day one, not "later".** Rate limits, the OTP store and
`MAIL_HOURLY_CAP` are per-process. On serverless every invocation may be a fresh instance, so:
rate limiting silently stops binding, an OTP sent by one instance cannot be verified by another,
and the mail cap becomes unenforceable — which turns the operator's sending domain into an open
relay. The plan's old standing constraint (*never run more than one instance*) is violated by the
first deploy.

**All three move to Postgres in Phase 1.** Non-negotiable. Additionally, put Vercel's edge rate
limiting in front for volumetric abuse — that is the correct layer for it and it is configuration,
not code. Postgres keeps the limits that must be *exact* (the per-address and global mail caps).

### 2.3 What gets better

- **Custom domains.** Vercel's Domains API attaches a client hostname to the funnel project and
  issues TLS with no config file. A wildcard on `*.f.enno.de` covers every subdomain client with
  one certificate and zero per-client API calls. This is better than the Caddy design it replaces.
- **Supabase covers four needs at once** — Postgres, Storage, Auth (if the console ever needs it),
  and RLS for the day tenancy arrives. `supabaseInsert()` already speaks PostgREST against
  `${URL}/rest/v1/${table}` with no SDK, so lead storage is nearly free.
- **Backups.** Supabase Pro does point-in-time recovery. That removes the single largest ops risk
  in the previous design — an untested `pg_dump` cron. **A restore test is still required**; PITR
  you have never exercised is a belief, not a backup.
- **Image handling.** Supabase Storage does transformations on the URL, so responsive sizes and
  WebP need no image library and no native binary — which is what the serverless move took away.

### 2.4 What gets worse, and the accepted mitigations

- **No write-ahead fallback.** The old design wrote a JSONL sink when Postgres was unreachable.
  Serverless has no durable filesystem, so that safety net is gone. **Mitigation, ~10 lines:** if
  the transactional insert fails, attempt delivery to the client's targets *inline and directly*,
  skipping the queue. The lead still reaches the client even when it cannot be stored. Log it
  loudly. `ponytail: no durable spill. Add one (Upstash/Vercel Blob) only if a real Supabase
  outage actually loses a lead.`
- **Cold starts** on the ingest path. Measure it; `/f/:slug` and `/api/lead` are the money paths.
- **Worst-case retry latency** rises from ~5s to ~60s, bounded by the cron interval. Only affects
  retries — the first attempt is still inline.
- **Two vendors instead of one box**, both of them US companies. §8.0.

### 2.5 Data model

Sketch, not final DDL. `client_id` on everything from day one — it is needed today for the client report and for deletion, and it is the column a future tenancy layer keys off.

```sql
-- The businesses Enno runs funnels for.
create table client (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  contact_email text not null,
  vertical      text,                    -- galabau | shk | dental | immo | …
  avv_signed_at timestamptz,             -- GATE: publish is refused while this is null (§8.9)
  retention_months int not null default 12,  -- lead auto-purge horizon (§8.7)
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- A funnel document. `doc` is the JSON contract from packages/engine/src/types.js.
create table funnel (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references client(id),
  slug         text not null unique,     -- SLUG_RE, as today
  name         text not null,
  doc          jsonb not null,
  status       text not null default 'draft',   -- draft | live | paused | archived
  published_at timestamptz,
  created_at   timestamptz not null default now()
);

-- Every save is a version. Rollback is a copy, never a destructive edit.
create table funnel_version (
  id         bigserial primary key,
  funnel_id  uuid not null references funnel(id),
  doc        jsonb not null,
  note       text,
  created_at timestamptz not null default now()
);

-- The product. One row per submitted contact.
create table lead (
  id           uuid primary key default gen_random_uuid(),
  funnel_id    uuid not null references funnel(id),
  client_id    uuid not null references client(id),
  payload      jsonb not null,           -- form fields + answers
  utm          jsonb,                    -- utm_*, gclid, fbclid, ttclid, ref
  consent      jsonb,                    -- { signal, at, text_version } — §8.4, evidence
  email_verified boolean not null default false,
  ip_hash      bytea,                    -- salted hash, never the raw IP
  user_agent   text,
  dedupe_key   text,                     -- hash(funnel, email|phone, 10-min bucket)
  spam_score   int not null default 0,
  is_spam      boolean not null default false,
  restricted   boolean not null default false,  -- Art. 18: blocks delivery and export
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz               -- soft delete; the sweeper hard-deletes within 24h (§8.7)
);
-- Search index for Art. 15 subject access: find every record for one person.
create index on lead using gin (payload jsonb_path_ops);
create unique index on lead (dedupe_key) where dedupe_key is not null;

-- Where a client's leads go. Several per client is normal.
create table delivery_target (
  id        uuid primary key default gen_random_uuid(),
  client_id uuid not null references client(id),
  kind      text not null,               -- email | webhook | sheet | sms | whatsapp
  config    jsonb not null,              -- secrets encrypted at rest, never returned by any API
  enabled   boolean not null default true,
  created_at timestamptz not null default now()
);

-- The queue. One row per (lead, target). This IS the durable-delivery fix.
create table delivery (
  id              bigserial primary key,
  lead_id         uuid not null references lead(id),
  target_id       uuid not null references delivery_target(id),
  status          text not null default 'pending',  -- pending | delivering | done | dead
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  last_status     int,
  idempotency_key uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index on delivery (status, next_attempt_at) where status = 'pending';

-- Drop-off. High volume, so it rolls up nightly and the raw rows expire.
create table event (
  id         bigserial primary key,
  funnel_id  uuid not null references funnel(id),
  session_id text not null,
  type       text not null,              -- view | step | answer | submit | drop
  step_id    text,
  created_at timestamptz not null default now()
);
create table funnel_daily (
  funnel_id  uuid not null references funnel(id),
  day        date not null,
  views      int not null default 0,
  starts     int not null default 0,
  completes  int not null default 0,
  per_step   jsonb not null default '{}',
  primary key (funnel_id, day)
);

create table asset (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references client(id),
  key        text not null,              -- object storage key
  mime       text not null,
  bytes      int  not null,
  width      int, height int,
  created_at timestamptz not null default now()
);

create table domain (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references client(id),
  hostname    text not null unique,
  funnel_id   uuid references funnel(id),   -- null = hostname root serves a chooser/404
  verified_at timestamptz
);

-- Was an in-process Map. On serverless it must be shared state or it does not bind at all.
create table rate_bucket (
  key          text primary key,        -- e.g. "lead:<ip_hash>", "mail:<addr>", "mail:global"
  window_ms    int  not null,           -- each bucket judges itself by its own window (the M2 fix)
  window_start timestamptz not null,
  count        int  not null default 0
);

-- Same reason. Send on one instance, verify on another — an in-memory store cannot do this.
create table otp (
  id         uuid primary key default gen_random_uuid(),
  funnel_id  uuid not null references funnel(id),
  email      text not null,
  code_hash  bytea not null,            -- never the code itself
  attempts   int  not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on otp (email, expires_at);

-- Read-only client access. No login, no user row.
create table report_token (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references client(id),
  token_hash bytea not null,             -- store the hash, never the token
  label      text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
```

Deliberately absent, with the reason: `account`/`tenant` (one operator — a nullable column plus a single-value backfill is a trivial migration later), `user`/`session`/`role` (§8), `subscription`/`invoice`/`plan` (no billing), `organization` (same as tenant).

### 2.6 The ingest path — the one hot path that matters

Today: `/api/lead` returns 202 and fans out with `Promise.allSettled`; a failed webhook is a warning on stdout and the lead forward is gone. That is failure mode 4 from the pre-mortem and it is the single change that justifies the whole build.

New path:

```
POST /api/lead
  1. validate + rate-limit                                   (existing code)
  2. reject preview traffic via isPreviewRecord              (existing invariant, keep)
  3. BEGIN
       insert lead
       insert one delivery row per enabled target for that client
     COMMIT                                                  ← atomic. nothing is in flight yet.
  4. return 202
```

Then, in the **same invocation**, inside Vercel `after()`: attempt every pending delivery for that
lead immediately. That is what keeps speed-to-lead at ~2s without a worker process. Poll
`assertNotAborted()` between steps — Vercel's `after()` does not stop on abort by itself.

If step 3 throws (Supabase unreachable), there is no durable spill on serverless. **Degrade
forward instead:** attempt delivery to the client's targets directly, inline, skipping the queue,
and log loudly. The lead reaches the client even though it could not be stored. Still return 202 —
the visitor must never see a failure.

Retry drain — `pg_cron` every minute, `pg_net` POSTs `/api/internal/drain` with a shared secret:

```
claim:  UPDATE delivery SET status='delivering', attempts=attempts+1
        WHERE id IN (SELECT id FROM delivery
                     WHERE status='pending' AND next_attempt_at <= now()
                     ORDER BY next_attempt_at
                     FOR UPDATE SKIP LOCKED LIMIT 25)
        RETURNING *;

send:   dispatch by target.kind, always with header
        Idempotency-Key: <delivery.idempotency_key>

ok   →  status='done', delivered_at=now()
fail →  attempts < 8 ? status='pending', next_attempt_at = now() + backoff(attempts)
                     : status='dead'  + alert Enno
```

Backoff: 5s, 30s, 2m, 10m, 30m, 2h, 6h, 12h. Eight attempts ≈ 21 hours of grace. The first
attempt is inline so the backoff schedule only governs retries; worst-case retry pickup is bounded
by the one-minute cron tick.

`/api/internal/drain` must finish inside the function timeout. Batch of 25, and it is idempotent —
a run that dies mid-batch leaves rows in `delivering`, so a sweeper returns anything stuck in that
state for more than 5 minutes back to `pending`. Without that sweeper a timeout silently strands
leads, which is the exact failure this system exists to prevent.

Retry safety, from `reference/postgres-tenant-isolation.md` §5: the receiver may have succeeded on a request that timed out. Every outbound delivery therefore carries a stable `Idempotency-Key`, and the client-facing webhook docs state that the same key means the same lead. Email delivery is naturally at-least-once and a duplicate notification is acceptable; a duplicate CRM row is not, which is why the key is mandatory on webhooks.

**Delivery is visible.** The console shows, per lead, every target and its state. The client report shows "delivered at 14:32" per lead. Nothing about a failed delivery is discoverable only in a log.

**Delivery is alarmed.** Any transition to `dead`, or more than N failures in an hour, sends Enno an email and (later) a push. A silent failure is the failure.

### 2.7 What happens to the existing code

| Part | Fate |
| --- | --- |
| `packages/engine` | Keep, unchanged, until Phase R replaces it. It works and it is audited. |
| `apps/runtime` | Keep the `lib/` + `routes/` structure; they already return `Response`. Extract the router from `Bun.serve` into `handleRequest(req)` with two entry points (Vercel function, local Bun dev shell). Add: Postgres store, delivery drain endpoint, assets, domains, report tokens, Postgres-backed rate limits/OTP/mail cap. Remove: JSONL sinks (no durable FS). Keep and extend `supabaseInsert` — it is now the store, not an optional forward. |
| `apps/app` (console) | Extend, do not rewrite — **confirmed by running it**, see [REALITY-CHECK.md](REALITY-CHECK.md) §4. It is a working three-pane builder with live preview and zero console errors. New views (delivery log, clients, assets) follow the documented `VIEWS`/`ROUTES`/`APP_ROUTES` recipe. Deploys as the private Vercel project. |
| `apps/builder`, `apps/admin` | Delete. Already unmounted; `git rm -r apps/builder apps/admin` is still pending from the audit. |

---

## 3. Feature set

Everything the finished product would have, marked by whether it gets built now.

**BUILD** = needed by one operator with real clients. **SKIP** = only exists to serve strangers; the seam column says what keeps it cheap later.

### 3.1 Funnel engine (visitor-facing)

| Feature | Now | Note |
| --- | --- | --- |
| Landing step (hero, sections, sticky CTA) | BUILD | exists |
| Choice / multiselect / form / content / loader / success steps | BUILD | exists |
| 20 content block types | BUILD | exists |
| Conditional branching | BUILD | exists |
| `{{token}}` piping | BUILD | exists |
| Theming (8 presets, ~170 CSS vars) | BUILD | exists |
| Consent bar + third-party gating | BUILD | exists, and it is the DSGVO story |
| Email OTP verification | BUILD | exists; keep for high-value verticals |
| localStorage resume | BUILD | exists |
| Calculator step | BUILD | exists |
| `select` field type + file upload | SKIP | engine renders `select` but no console editor; file upload has no storage path. Add with the options editor, together, when a funnel needs it. |
| A/B testing | SKIP | with 1–10 clients there is no traffic for significance. Seam: funnel variants are two `funnel` rows plus a split on the domain route. |
| Dynamic headlines / smart personalization | SKIP | Perspective gates this at €297+. Nothing here needs it. |
| Multi-language funnels | SKIP | German only. Seam: `doc` is JSON; a `lang` key and a second doc covers it. |

### 3.2 Lead handling — the core

| Feature | Now | Note |
| --- | --- | --- |
| Durable delivery queue + retries + dead-letter | **BUILD — first** | §2.4. This is the reason the project exists. |
| Per-lead delivery log, operator-visible | BUILD | |
| Delivery failure alerting | BUILD | |
| Idempotency keys on webhooks | BUILD | duplicate CRM rows are a client-facing bug |
| Leads in Postgres | BUILD | JSONL rotates at 64MB; it is a buffer |
| Duplicate detection | BUILD | `dedupe_key`; trades get the same person twice |
| Spam scoring + quarantine | BUILD | honeypot field, time-to-submit floor, disposable-domain list, obvious-garbage heuristics. A client paying for leads notices bot fills immediately. |
| Lead export CSV | BUILD | one endpoint, and it is also the DSGVO portability answer |
| Manual re-send of a delivery | BUILD | one button; saves an incident |
| Lead scoring / enrichment | SKIP | speculative |
| Built-in CRM / pipeline | SKIP | leads leave the system. This is Perspective's product, not ours. |

### 3.3 Client-facing

| Feature | Now | Note |
| --- | --- | --- |
| Signed report link (`/r/:token`) — leads, delivery state, funnel performance | BUILD | the DFY differentiator, and it is cheap: one read-only route |
| Weekly summary email to the client | BUILD | "12 Anfragen diese Woche" retains clients better than any feature |
| Lead notification within seconds — email | BUILD | speed-to-lead is the value proposition |
| Lead notification — SMS | BUILD (phase 3) | Twilio or a German provider; trades read SMS |
| Lead notification — WhatsApp | LATER | Meta WhatsApp Business API needs template pre-approval and a verified business. Real work, real delay. Not a phase-1 promise. |
| Client login / self-serve dashboard | SKIP | the signed link replaces it. Seam: `report_token` becomes a session if it ever needs one. |
| Client-editable funnels | SKIP | it is a done-for-you service. If the client edits it, it is not. |

### 3.4 Operator (console)

| Feature | Now | Note |
| --- | --- | --- |
| Funnel builder (existing SPA) | BUILD | extend, do not rewrite |
| Client list + per-client view | BUILD | new view |
| Delivery log view | BUILD | new view |
| Asset library + upload | BUILD | new view |
| Domain management | BUILD | new view |
| Funnel versioning + rollback | BUILD | one bad save on a live funnel during an ad flight is expensive |
| Template library, vertical-specific | BUILD | the production line — §7.3 |
| Clone + rebrand flow | BUILD | throughput is revenue |
| Preview on a real phone (QR) | BUILD | ~20 lines, and mobile is the whole product |
| Per-funnel analytics + drop-off | BUILD | events already exist; add the rollup |
| AI copilot in the builder | SKIP | you have Claude Code. An in-product copilot duplicates a tool you already have and is strictly worse. |
| Command palette, keyboard shortcuts | BUILD | already exists in `apps/app`, free |
| Onboarding wizard, product tour, empty states | SKIP | one user, who wrote it |
| Team seats, roles, permissions | SKIP | one user |
| Audit log | BUILD (minimal) | who-changed-what on funnels and delivery targets. Cheap now, and DSGVO likes it. |

### 3.5 Platform / ops

| Feature | Now | Note |
| --- | --- | --- |
| Custom domain per client + auto TLS | BUILD | Vercel Domains API + a wildcard. Client trust and ad quality both depend on it. |
| Asset storage + WebP + responsive sizes | BUILD | Supabase Storage + URL transformations. Funnels for real trades need real photos — a hard blocker today. |
| PITR + **tested** restore | BUILD | untested backups are not backups |
| Uptime monitoring on `/f/:slug` | BUILD | monitor the money path, not `/healthz` |
| DSGVO deletion path per data subject | BUILD | must be designed in, not bolted on |
| Retention policy + auto-purge | BUILD | `event` rows expire at 90 days, leads on a per-client schedule |
| Billing (Stripe, plans, quotas, invoices, dunning) | SKIP | no customers of the platform. Seam: `client` already exists; a `subscription` table joins to it. |
| Self-serve signup, verification, password reset | SKIP | one account, seeded by hand |
| Multi-tenancy + RLS | SKIP | one operator. Seam: `client_id` is on every table already, RLS policies are additive, the pattern is in `reference/`, and Supabase makes RLS the native path when it arrives. |
| Shared OTP store + edge rate limit | **BUILD — Phase 1** | was Phase 4 on a single box. Serverless scales horizontally by default, so these are day-one requirements, not later ones (§2.2). |
| Status page / SLA | SKIP | you are the status page |
| Public API for third parties | SKIP | |
| SSO / SCIM | SKIP | |
| Marketing site, pricing page | SKIP | |

### 3.6 The skip list, summarized

Skipping billing, tenancy, self-serve auth, seats, A/B testing, an in-product CRM, an AI copilot, WhatsApp, a client dashboard, i18n, scale-out, and the marketing surface removes roughly **60–70% of what a comparable SaaS is** — and none of it touches the parts a paying client can see. That is the entire point of the DFY shape.

---

## 4. Integrations

Deliberately short. The research is clear that the German trades software the target clients use has no confirmed public API, so integrating "into their system" is mostly a fiction. What actually works:

**Outbound (lead delivery) — build all four:**

1. **Email** — **Brevo (recommended) via an adapter, not Resend** (§8.3). Formatted lead notification to one or more recipients per client. Two existing gotchas: direct SMTP is not implemented (only `RESEND_API_KEY` and `SMTP_RELAY_URL` work), and `SMTP_RELAY_URL` posts a fixed `{to, subject, html, text}` body that no provider accepts as-is.
2. **Webhook** — POST JSON to any URL, through the existing `resolveSafeTarget()` SSRF guard, with `Idempotency-Key`. This is the universal adapter: it is how Zapier, Make, n8n, and anything a client's own developer builds receives leads. Where the client points it is the client's decision and their disclosure.
3. **Google Sheets** — append a row via a service account. Unglamorous and the single most-requested thing a small business actually wants. **US transfer: opt-in per client, named in their AVV and privacy notice, never a default** (§8.3).
4. **SMS** (phase 3) — for speed-to-lead where the client does not read email fast. **EU provider with an AVV, or it does not ship.**

**Inbound / tracking — keep what exists:**

5. **Meta Pixel + Conversions API** — already implemented server-side, consent-gated correctly. Per-funnel config. The token-in-URL-query behaviour is deliberate and documented; do not "fix" it.
6. **GA4 / GTM, TikTok Pixel, LinkedIn Insight** — engine handles the first three; LinkedIn is on the known-gaps list (console writes it, nothing reads it). Wire on demand.
7. **Google Ads conversion** — on the known-gaps list too (`googleAdsId`/`googleAdsLabel` written, never read). Wire when a client runs Google Ads.

**Deferred, with the trigger that unblocks it:**

8. **onOffice** — real API, Zapier app. Build if a real estate client signs. Until then Zapier covers it.
9. **WhatsApp Business API** — build when a client explicitly asks and accepts the template-approval delay.
10. **Everything else** — Zapier/Make consume the webhook. There is no reason to build a second connector.

**Explicitly not building:** any Handwerk ERP connector (STREIT, HERO, mfr, Smarthandwerk, TAIFUN — no public API found), Dampsoft (partner-gated), an in-product Zapier app, or a public integrations marketplace.

---

## 5. Access model

Three surfaces, three completely different access mechanisms. This is deliberate and it is what removes most of the auth work.

### 5.1 Public — funnel + ingest

Open to the internet. No authentication, by definition — it is an ad landing page.

Protections, all already in the code and all kept: strict CSP with the boot-script hash pinned, rate limits per IP and per funnel, `MAIL_HOURLY_CAP` as an absolute ceiling the caller cannot rotate, `isPreviewRecord` on both sides, `richText()` / `embedUrl()` / `isSameOriginUrl` parsing rather than pattern-matching.

Two changes forced by the move to Vercel:

- **`TRUST_PROXY=1` is now correct**, because Vercel is always in front. `clientIp()` reads the forwarded header. This is a real weakening — the header is caller-supplied — so the mail caps and anything else that must be exact are keyed on something the caller cannot rotate, and Vercel's edge rate limiting handles volumetric abuse in front of the function.
- **Rate limits and the OTP store live in Postgres**, not process memory (§2.2). Without that they simply do not bind.

`/api/admin/*`, `/api/builder/*` and `/api/ai/*` are **not deployed to the public project at all**, so there is nothing on this surface to refuse. The `PRIVILEGED_PREFIXES` gate stays in the code anyway — the one thing the audit proved is that a single check gets bypassed.

### 5.2 Operator (admin) — console

**The console is a separate Vercel project behind Vercel Authentication. Still no login page of
our own, and still zero auth code.**

- The console deploys as its own Vercel project with **Deployment Protection → Vercel
  Authentication** enabled. Every request to that deployment must carry a valid Vercel SSO session
  for Enno's account. Unauthenticated traffic never reaches the function.
- **The public project has no admin code deployed to it at all.** `/api/admin/*`,
  `/api/builder/*` and `/api/ai/*` exist only in the console project's build. This is stronger
  than a runtime gate: an unrouted handler cannot be reached by any request, forged or not.
- `ADMIN_TOKEN` stays required on those API routes as a second layer, and the existing
  `PRIVILEGED_PREFIXES` + `isCrossSiteRequest` gate stays as a third. Three independent refusals.
- Loopback trust is **removed**, not relied on. There is no loopback on Vercel, and a request
  carrying `x-forwarded-for` is now the normal case rather than the suspicious one — the old
  heuristic would be actively wrong here. `TRUST_PROXY=1`, and `clientIp()` reads Vercel's
  forwarded header.
- Break-glass: Vercel's own dashboard and a direct `psql` against Supabase.

Why this instead of building auth: the console can read every lead in the system. A hand-written
login page would be an internet-facing surface protecting the highest-value asset, built by one
person, needing sessions, reset flows, brute-force protection and MFA to be honest about it.
Vercel Authentication is zero code and is somebody else's job to keep correct.

It also closes audit finding **B4** (secrets in cleartext `localStorage`): with auth at the edge
there is no reason for the browser to hold `of.adminToken` or provider keys, so those settings move
server-side into `delivery_target.config` and a settings table, encrypted at rest.

**Seam for later:** a second operator means either adding them to the Vercel team, or — if real
per-user identity is needed — Supabase Auth, which is already in the stack. Neither is blocked by
anything here.

### 5.3 Client — read-only report

- One `report_token` per client, issued from the console. The token is shown once; only its hash is stored.
- URL form: `https://f.<domain>/r/<token>`. No login, no account, no password to forget — which is the correct UX for a 55-year-old GaLaBau owner.
- Scope is hard-bound to one `client_id`, read-only, and enforced server-side. It can reach nothing else.
- Expires (default 180 days), renewable, revocable, with `last_seen_at` so a dead link is visible.
- Rate-limited, `noindex`, and it never exposes another client's data because the query is parameterised on the token's own `client_id`.

Token entropy is the whole access control, so it is a TOM commitment under Art. 32: **256 bits from a CSPRNG**, constant-time comparison against the stored hash, and rate-limited so the endpoint cannot be walked. A guessable report link would be a reportable breach.

Risk accepted and stated: a leaked link exposes that client's leads. Mitigations: expiry, revocation, no lead payload in the URL, `noindex` plus `Referrer-Policy: no-referrer` so the token cannot leak through a click-out, and the option to require a per-client PIN if a specific client's data warrants it. Compared to the alternative — building account management for people who will not use it — this is the right trade at this scale. Note that the report shows the *controller* their own data, so it is not a third-party disclosure; the requirement it has to meet is Art. 32 security, not a separate legal basis.

---

## 6. Security carried forward from the audit

The patched findings and the invariants they produced are **requirements of the new system**, not history. Any new code, and the Phase R rewrite in particular, must satisfy all of these. They are recorded here because they were expensive to learn.

1. **URL checks parse, never pattern-match.** The WHATWG parser strips tab/LF/CR from anywhere before resolving, so `"/\t/evil.tld/x"` defeats every `startsWith` test. Construct a `URL`, compare `origin`.
2. **Privileged routes are gated structurally**, by living inside the gated branch, not by their author remembering to check.
3. **Cross-site browser requests are refused on privileged routes** before authentication runs. CORS headers belong only to the public ingest paths.
4. **`x-forwarded-for` is not trusted** unless `TRUST_PROXY` is set.
5. **Outbound targets are resolved, vetted, then pinned** — DNS rebinding is closed, not documented.
6. **Never log a `fetch` error object** — Bun puts the full URL, including any token, on `err.path`.
7. **Ingest never fails a visitor** — 202 immediately, persist behind it.
8. **Preview traffic never pollutes analytics**, and ingest and the admin readers use the *same* predicate.
9. **A funnel document is operator-authored, not operator-trusted** — every field reaching a markup, iframe, or endpoint sink is filtered by the engine itself.
10. **Operator-pasted script stays opt-in** (`ALLOW_CUSTOM_SCRIPTS` unset) and never `'unsafe-inline'`.
11. **Outbound mail has an absolute cap** the caller cannot rotate.
12. **Path containment uses `isInside()`**, not a prefix test.
13. **Secrets never travel outward** — settings reads redact, writes go through an allowlist, a blank secret means "keep".

New requirements this plan adds:

14. **Delivery target secrets are encrypted at rest** in `delivery_target.config` and never returned by any API, redaction-style, same as email settings today.
15. **IPs are stored hashed with a salt**, never raw. There is no product reason to hold a raw visitor IP.
16. **Report tokens are stored hashed.** A database read must not yield working client links.
17. **Every deletion is a real deletion.** Soft-delete for undo, then a sweeper that hard-deletes from Postgres and Supabase Storage — see §8.7.
18. **No non-EU host in the default funnel path.** Self-hosted fonts, no CDN outside the EU, no third-party request a consenting visitor did not opt into. Verified in devtools on a cold cache, per release — not asserted from reading the code.
19. **No lead data reaches a model, ever.** No AI in the ingest, delivery, or storage path.
20. **No error-tracking service.** A captured exception can carry a request body. Logs stay on the box.

---

## 7. Setup and operating flows

### 7.1 Operator setup — one-time, the server

1. **GitHub repo** — the control plane. Public if the AGPL fork is published there too (Phase 0);
   otherwise a private repo plus a separate public fork mirror.
2. **Supabase project**, region `eu-west-1` (Ireland) — created 2026-08-11, ref `guzvadxfoufsetkrvbfj`. **Pro** for PITR before any client funnel. Record the region for
   the DSGVO statement. Enable `pg_cron` and `pg_net`.
3. **Schema + migrations** applied (§2.5). A dedicated role for the app — not the service role for
   anything the public project touches.
4. **Supabase Storage bucket** for assets, public-read, with upload restricted to the console.
5. **Vercel project `funnel`** — public. Region `dub1`, **Node runtime**, connected to the repo.
   Wildcard domain `*.f.enno.de`.
6. **Vercel project `console`** — private, same repo, different entry point/build. Region `dub1`.
   **Deployment Protection → Vercel Authentication ON.** Verify by loading it in a logged-out
   browser and confirming the SSO wall before anything else is configured.
7. **Env vars**, per project, in Vercel (never in the repo): `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` (console only), `SUPABASE_ANON_KEY`, `ADMIN_TOKEN`, `BREVO_API_KEY`,
   `IP_HASH_SALT`, `DRAIN_SECRET`, `TRUST_PROXY=1`.
8. **`pg_cron` jobs**: minutely drain (`pg_net` → `/api/internal/drain`, `DRAIN_SECRET` header),
   the stuck-`delivering` sweeper, the nightly retention purge, the nightly `funnel_daily` rollup.
9. **PITR window set explicitly** and written into the Löschkonzept. **Then restore it once into a
   scratch project** — PITR you have never exercised is a belief, not a backup.
10. **Uptime monitor**, off-platform, hitting a real `/f/:slug` — not `/healthz` — with an alert
    channel that reaches a phone. A Vercel-hosted checker cannot tell you Vercel is down.
11. **Vercel edge rate limiting** configured on the public project for volumetric abuse.
12. **Smoke test:** submit a lead through a real funnel on a real phone on mobile data, and watch it
    arrive at every configured target. Then kill a target and watch the retry drain deliver it.

### 7.2 Client onboarding — repeatable, and the gate is non-negotiable

1. **Intake.** Business details, service area, the offer, 5–10 photos, logo, brand colours, who receives leads and how, DSGVO contact.
2. **AVV signed** (Auftragsverarbeitungsvertrag — Enno is the processor, the client is the controller). `client.avv_signed_at` is set. **No funnel goes live for a client without this date.** Same shape as the delivery-gate rule that already exists in the web dev business ops.
3. **Create client + delivery targets** in the console.
4. **Build the funnel** from the vertical template, personalised (§7.3).
4a. **Legal URLs.** Collect the client's Impressum and Datenschutzerklärung URLs into `legal.*` on the funnel document — publish is refused without them (§8.5). Hand over the generated Datenschutzerklärung module naming this platform's hoster, retention period, delivery targets and any pixel, so the client's notice actually matches what happens. If the client has no privacy notice at all, that is a blocker they have to resolve, not something to paper over.
5. **Domain.** Either a subdomain on Enno's domain (`kunde.f.enno.de`, covered by the wildcard, zero client action) or the client's own (`angebot.kunde.de`, requires one CNAME from them and one call to the Vercel Domains API). Vercel issues the certificate.
6. **Tracking**, only if they run ads: Meta pixel + CAPI, GA4, Google Ads conversion.
7. **End-to-end test lead** — submitted from a phone, confirmed arriving at every target, latency measured. This is a hard gate: a funnel does not go live until a real test lead has landed in the client's inbox or CRM.
8. **Issue the report link**, send it with a two-line explanation.
9. **Live**, plus a 48-hour watch: first-lead alert, drop-off check, mobile render check on at least one real Android and one real iPhone.

### 7.3 The production line — how a funnel gets built fast

Throughput is the business. The flow:

```
vertical template  →  clone  →  personalise  →  preview on phone  →  publish
   (GaLaBau,          (one       (name, photos,    (QR from the       (status=live,
    SHK, dental,       click)     colours, offer,   console)           version snapshot)
    Immo)                         questions)
```

- Templates live in `apps/app/templates.js` (`FUNNEL_TEMPLATES`) — an existing, documented extension point. Each template must render with zero assets: the file header warns about it and two shipped templates already violated it, drawing a black video player and broken image boxes.
- Personalisation is a form over a handful of keys, not a full builder session. Target: **a new client funnel live in under 90 minutes**, most of it spent on copy and photos rather than on the tool.
- Every publish writes a `funnel_version` row. Rollback is one click.

### 7.4 Incident flow — a lead did not arrive

The single most likely support conversation, so it gets a designed path:

1. Console → Delivery log → filter by client. Every attempt, status, and error is there.
2. Delivery `dead` → read `last_error`, fix the target, press Re-send. The lead was never lost; it was queued.
3. No lead row at all → check the funnel's event stream. Did the visitor reach the submit step? This distinguishes "delivery broke" from "the funnel is not converting", which are completely different conversations with the client.
4. Postgres was down → the degrade-forward path (§2.6) delivered it directly without storing it. The lead reached the client; the console will not show it. Check the logs for the loud failure line.

---

## 8. DSGVO — the binding constraint

Enno is **Auftragsverarbeiter** (processor) per Art. 28 DSGVO; each client is **Verantwortlicher**
(controller). The data is German consumers' names, phone numbers, email addresses and free-text
answers about their homes and finances — arriving from paid advertising, which draws attention.
The pre-mortem ranked a PII incident the single worst outcome in the plan.

Everything in this section is a build requirement, not a compliance to-do list. Items marked
**GATE** block a phase from being called done.

### 8.0 The accepted trade — US processors under SCCs

**Decided 2026-08-10.** The stack is Vercel + Supabase. Both are **US companies** (Vercel Inc.,
Supabase Inc.), running in EU regions (`dub1`, `eu-west-1` — Ireland). Enno chose this knowingly. What it
means, stated plainly so nobody rediscovers it later:

- **It is lawful.** Both offer a DPA incorporating Standard Contractual Clauses. Both must be named
  as subprocessors in every client AVV, and a Transfer Impact Assessment is required for each.
- **It is no longer a differentiator.** The earlier design's *"Hosting in Deutschland, kein
  US-Anbieter"* line is withdrawn. §1's fourth reason-to-build is reduced from a wedge to table
  stakes: EU region, US processor, SCCs — which is what Perspective and most competitors also have.
  Do not put a claim in sales copy that the infrastructure does not support.
- **The distinction that survives** is the one worth keeping: Vercel and Supabase are *necessary*
  processors under contract with SCCs and a DPA. Google Fonts (§8.2) is an *unnecessary* transfer
  to a party with no contract, triggered without consent. Removing the second is still worth doing
  and is still provable in devtools — the first is disclosed, not eliminated.
- **Reconsider only on a trigger:** a client who contractually refuses US processors, or
  productization where the positioning has to be true. Keeping the data model plain Postgres (no
  Supabase-only features beyond Storage and, later, Auth) keeps that migration open.

### 8.1 Data flow — every place personal data lands

| Where | What | Legal basis | Processor / location |
| --- | --- | --- | --- |
| Funnel page in the visitor's browser | answers, contact details, localStorage resume | Art. 6(1)(b) — pre-contractual, at the visitor's request | visitor's device (TTDSG §25 — see 8.4) |
| Funnel page delivery + function execution | request data, IP | Art. 6(1)(b)/(f) | **Vercel Inc., `dub1` Ireland — US processor, SCCs** |
| `POST /api/lead` → Postgres | lead record | Art. 6(1)(b) | **Supabase Inc., `eu-west-1` Ireland — US processor, SCCs** |
| `POST /api/events` → Postgres | step/drop-off events, session id | Art. 6(1)(f) — first-party, no profiling | Supabase, Ireland |
| Supabase Storage | funnel assets only — **never lead data**. Live since 2026-08-13 (PHASE-2-PLAN.md §1): a **public** bucket, so an uploaded image is readable by anyone with the URL, and a photo of an identifiable person is personal data on Art. 6(1)(f)/the client's own basis. Deleting an object leaves it in Supabase's CDN cache for a while, so §8.7 cannot call a deletion complete at the delete call | n/a for the asset itself; the client's basis for any person depicted | Supabase, Ireland |
| Email delivery target | lead notification to the client | Art. 28 processing | **Brevo SAS, France/Germany (OVHcloud)** — see 8.3 |
| Webhook delivery target | lead to the client's own system | Art. 28, then the client's own responsibility | client's choice; disclosed in their notice |
| Google Sheets delivery target | lead row | Art. 28 | **Google Ireland/LLC — US transfer, opt-in only, see 8.3** |
| SMS delivery target | name + phone | Art. 28 | provider TBD, EU required |
| Meta Pixel + Conversions API | hashed contact data, event | Art. 6(1)(a) — **consent only** | Meta, US transfer |
| GA4 / GTM / TikTok / LinkedIn | behavioural | Art. 6(1)(a) — **consent only** | US transfer |
| Backups (PITR) | everything in Postgres | as above | Supabase, Ireland |
| Function + platform logs | IP, user agent, paths | Art. 6(1)(f) — security | Vercel, retention per plan |

Revised rule, replacing the old "nothing leaves Germany" (§8.0): **personal data stays in EU regions
throughout, and every US-parent processor in the path is under a DPA with SCCs, named in the client
AVV, and covered by a TIA.** Beyond that, nothing leaves the contracted set without either explicit
consent (the ad pixels) or an explicit client decision they were told about (their own webhook,
their own Sheet).

Note the new exposure the old design did not have: **Vercel sees every funnel request**, including
the POST body of `/api/lead`, in transit. That is inherent to hosting there and is exactly what the
DPA and SCCs are for — but it must be disclosed, not glossed.

### 8.2 Google Fonts — fix this in the engine

`theme.js` fetches a non-system `theme.font` from Google Fonts, and **every one of the eight built-in
presets names such a family**. In Germany specifically this is the highest-frequency DSGVO problem on
the web: LG München I, 3 O 17493/20 (20 Jan 2022) awarded damages for hotlinking Google Fonts because
it transmits the visitor's IP to Google without consent, and it set off a mass-Abmahnung wave that
German SMB owners have heard of.

**Verified live 2026-08-10 — worse than assumed. See [REALITY-CHECK.md](REALITY-CHECK.md) §1.**
The gate only protects a funnel that *enables* consent. All four shipped examples have
`consent: {}` — consent off — so there is no gate to fail and the font loads on page view. Loading
`/f/agency-landing` on a cold profile fired `fonts.googleapis.com` and `fonts.gstatic.com` with no
consent bar shown and no consent given. **The unprotected case is the default case.**

Second, independent problem found in the same run: the default `funnelCsp` pre-authorises
`https://fonts.googleapis.com` in `style-src` and `https://fonts.gstatic.com` in `font-src` on
**every** funnel page — including ones that never make the request. A CSP that permits the transfer
is a bad answer to "does this site send data to Google".

**GATE (Phase 1), two parts:**
1. **Self-host the fonts.** Ship the preset families from Enno's own origin as WOFF2, drop the
   Google Fonts path entirely. Removes a whole class of complaint, removes a consent dependency,
   and makes the funnel faster on 4G — the engine's whole design goal.
2. **Remove the Google entries from the default CSP.**

The honest sales line after §8.0 is narrower than the earlier draft, and still worth having:
*keine Google Fonts, kein unnötiger Drittanbieter auf der Funnel-Seite* — provable in devtools in
five seconds. The infrastructure claim ("kein US-Anbieter") is withdrawn; do not use it.

### 8.3 Subprocessors — resolve before client #1

Every third party touching lead data is a subprocessor, must be named in the AVV, and the client has
a right to object to changes.

- **Vercel Inc.** (US, `dub1` Ireland execution) — DPA with SCCs required, TIA required, named in
  every client AVV. Sees every funnel request including lead submissions in transit.
- **Supabase Inc.** (US, `eu-west-1` Ireland) — DPA with SCCs required, TIA required, named in
  every client AVV. Holds every lead at rest, plus the backups.
- **Mail provider — GATE. Researched 2026-08-10 →
  [reference/eu-mail-providers-2026-08-10.md](reference/eu-mail-providers-2026-08-10.md).**
  Resend is US-based and out. **Recommendation: Brevo** (Brevo SAS, Paris) — passes all five hard
  requirements: OVHcloud FR/DE hosting, self-serve DPA in the ToS, a real transactional product,
  a clean JSON send API (`POST https://api.brevo.com/v3/smtp/email`), free tier ~9,000/month.
  One asterisk: database *backups* touch Google Cloud Belgium — not the live send path, but it
  must be disclosed in the subprocessor list. Runner-up **Scaleway TEM** (~€1/month, French,
  Iliad-owned) — cheaper and cleaner on paper, but no DPA link was found; one check settles it.
  Disqualified on no-JSON-API: rapidmail, CleverReach, mailbox.org. Disqualified on a US entity in
  the mail path: Mailjet (Sinch names Mailgun Technologies Inc. as a subprocessor), Mailgun,
  SendGrid, Postmark. **Not zero-code:** `SMTP_RELAY_URL` posts a fixed
  `{to, subject, html, text}` body, so whichever provider wins needs a small adapter.
- **Google Sheets** — Google Ireland Ltd. as controller-side contract, data may still reach the US.
  It stays on the menu because clients ask for it, but it is **opt-in per client, named in their AVV,
  and disclosed in their privacy notice**. Never a default.
- **SMS provider** — EU-based, AVV, or it does not ship.
- **Monitoring** — the uptime check hits a funnel URL and sees no personal data. Keep it that way:
  **no error-tracking service** (Sentry and similar) in the lead path, because a captured exception
  can carry a request body. Vercel's own function logs are inside the existing Vercel DPA; do not
  add a second observability vendor.
- **No AI in the lead path.** The console's AI copilot is already on the skip list; this makes it a
  rule rather than a scope decision. No lead data is ever sent to a model.

### 8.4 Consent and TTDSG

Two separate legal questions that get confused, so both are stated:

- **TTDSG §25** governs storing or reading anything on the visitor's device, regardless of whether it
  is personal data. `persist.js` writes funnel progress to localStorage. Position: this is *unbedingt
  erforderlich* — it exists solely to let the visitor resume the form they themselves are filling in,
  it is first-party, and it is never read for any other purpose. Documented in the privacy notice as
  technically necessary; no consent required. Anything added to localStorage later that is **not**
  strictly necessary needs consent first.
- **Art. 6(1)(a) DSGVO** governs the pixels and the CAPI forward. The existing consent bar gates them
  in two independent places — the client-side `_pixel()` check and the server re-deriving the gate from
  the funnel document rather than trusting `record.meta.consent`. Both halves stay.

The consent bar itself has to be conform, which is a UI requirement, not just a code path:
**GATE (Phase 2)** — reject must be exactly as easy as accept (same level, same prominence, no
dark pattern), nothing pre-ticked, granular per purpose, withdrawable as easily as given, and no
non-essential loading before the choice is made. The current bar needs an audit against this before
any funnel with pixels goes live.

**Consent evidence.** Store on the lead: the signal, the timestamp, and a **version identifier for the
consent text that was shown**. Without the text version, a consent record proves nothing two years
later. This is a schema addition — `lead.consent` gains `text_version`.

### 8.5 Every funnel page needs an Impressum and a Datenschutzerklärung

A funnel is a *geschäftsmäßiges Telemedium*: §5 DDG requires an Impressum and Art. 13 DSGVO requires
a privacy notice at the point of collection. They are the **client's**, not Enno's — the client is the
controller. Enno's role is to make it impossible to publish a funnel without them.

**GATE (Phase 2):** the funnel document carries `legal.impressumUrl` and `legal.privacyUrl`, the engine
renders both as persistent footer links on every step including the landing step, and **publish is
refused if either is empty.** Not a warning — a refusal. Missing Impressum is the single most common
Abmahnung trigger in Germany and the client will not notice it themselves.

The privacy notice must name what this platform actually does: the hoster, the retention period, the
delivery targets configured for that client, and any pixel in use. **Deliverable: a fill-in-the-blanks
Datenschutzerklärung module** Enno hands the client for their notice, generated from the funnel's
actual configuration. This is a product feature, not paperwork — it makes the client's compliance a
by-product of the setup instead of homework they will skip.

### 8.6 Data subject rights — Art. 15–21, one month

As processor, Enno's obligation is to *support* the client (Art. 28(3)(e)). In practice the request
lands with Enno because Enno holds the system. Each has to be executable, not theoretical:

| Right | Mechanism |
| --- | --- |
| Auskunft (15) | search leads by email/phone across a client, export as JSON + PDF |
| Berichtigung (16) | edit a lead record, with the change in the audit log |
| Löschung (17) | the deletion path in 8.7 |
| Einschränkung (18) | a `restricted` flag that blocks further delivery and export |
| Portabilität (20) | the CSV/JSON export already needed for other reasons |
| Widerspruch (21) | same as deletion for this data set |

**GATE (Phase 2):** a console search across all of a client's leads by email or phone, returning
everything held. Without that, a subject access request cannot be answered inside the one-month
deadline and there is no way to *find* what needs deleting.

### 8.7 Löschkonzept — deletion that is actually complete

Personal data lives in four places under the Vercel + Supabase design — one fewer than the VPS
design, because there is no JSONL sink. A deletion that misses one is not a deletion.

1. `lead` row in Postgres — soft delete, then hard delete on the sweeper's next run (24h)
2. `event` rows keyed to that session
3. Supabase Storage — only if lead file uploads are ever added; they are on the skip list today,
   and this is a reason to keep them there
4. **Backups / PITR** — surgical deletion inside a point-in-time-recovery window is not feasible
   and not required. The Löschkonzept states the **PITR retention window Supabase is configured
   for** (set it explicitly; do not inherit the default silently), after which the copy is gone.
   Write the number down — "we deleted it except in backups" is only defensible when the window is
   documented and bounded.

Also: **Vercel function logs** may contain an IP and a path, though never a lead body if the
logging rules in §6 hold. Retention is Vercel's, per plan, and it belongs in the Löschkonzept as a
disclosed platform log rather than as a deletable store.

Plus the honest part told to the client in writing: **a lead already delivered to their inbox, their
CRM or their Sheet is theirs to delete.** Enno cannot reach it.

Automatic retention, enforced by a job, not by intention:

- `event` rows: 90 days, then only the `funnel_daily` rollup (which holds no personal data)
- `lead` rows: per-client setting, **default 12 months** — set by what the client can justify, not by
  what is convenient. A GaLaBau enquiry has no purpose 24 months later.
- platform logs: Vercel's retention, disclosed
- backups: the configured Supabase PITR window

The purge job is another `pg_cron` entry — it does not need Vercel at all.

**GATE (Phase 2):** the purge job runs, is logged, and a test proves a deleted subject is gone from
`lead`, `event`, and Storage.

### 8.8 Breach — Art. 33, and the clock is the client's

As processor, Enno notifies the **client** *unverzüglich* (Art. 33(2)); the client then has 72 hours
to notify the Aufsichtsbehörde. Enno's job is speed and completeness, not the filing.

**Deliverable (Phase 2): a one-page runbook** — how it is detected, who is called, what the client is
told (nature of the breach, categories and approximate number of data subjects, likely consequences,
measures taken), and the evidence that gets preserved. Written before it is needed, because it will be
needed at the worst possible moment.

### 8.9 Documents — Enno's own paperwork

- **AVV per client**, Art. 28, signed **before the first lead**. `client.avv_signed_at` in the schema
  exists so the system can refuse to publish without it. **GATE (Phase 2): publish is blocked when
  `avv_signed_at` is null.**
- **TOM appendix** — encryption in transit and at rest, access control (console behind Vercel SSO, admin code not deployed to the public project, no public
  admin surface), pseudonymisation (hashed IPs, hashed report tokens), availability, restorability
  (tested restores), deletion, and a review interval. Two pages, and the design above already satisfies
  every line — which is the point of designing it in.
- **Verzeichnis von Verarbeitungstätigkeiten**, Art. 30(2) — the processor's version. One document.
- **Subprocessor list** with the client's right to object to changes.
- **TIA** for any remaining US transfer (the pixels, Google Sheets if used) — short, but it has to exist
  if the transfer exists.
- **Datenschutzbeauftragter:** likely not required (the threshold is ≥20 people regularly processing,
  Enno is one). Re-check if the answer changes; the *core-activity* test under Art. 37(1)(b) is worth a
  professional's opinion given the data is collected systematically at scale.

### 8.10 What is Enno's, not the plan's

Flagged because the pre-mortem ranked it rank 1 for danger, not because it blocks code:

- **Legal form.** Processing thousands of consumers' contact details commercially as a natural person
  is unlimited personal liability. GmbH/UG is a conversation with a Steuerberater.
- **Cyber liability insurance**, covering a data incident and the legal costs around it.
- **A Fachanwalt or external DSB reviews the AVV, the TOM and the Löschkonzept once** before client #1.
  Templates from the internet are a starting point, not a signature.

These three are the only items in this plan where the correct action is to pay a professional rather
than build something.

---

## 9. Ops

| Concern | Answer |
| --- | --- |
| Backups | Supabase PITR, window set explicitly. **Quarterly restore test, calendared.** An untested backup is a belief, not a backup. |
| Monitoring | Uptime check on a real funnel URL, **off-platform**, alerting to a phone. Plus: delivery `dead` count, queue depth, rows stuck in `delivering`, cron last-success timestamp. |
| Deploys | `git push` → Vercel builds both projects. Preview deployments per branch. The existing GitHub Actions CI (typecheck, suite, the two invariant checks) is the gate. |
| Rollback | Vercel instant rollback to the previous deployment. Funnel content rollback is `funnel_version`. Schema rollback is a down-migration, written at the same time as the up. |
| Logs | Vercel function logs. Never an error object from a `fetch` — Bun/Node put the full URL on `err.path`. |
| Secrets | Vercel env vars, per project. `SUPABASE_SERVICE_ROLE_KEY` exists **only** in the console project. Not in the repo, not in `localStorage`. |
| Scale ceiling | Serverless scales horizontally by default, which is why rate limits, the OTP store and the mail cap **must** be in Postgres from day one (§2.2). Once they are, there is no instance ceiling — but the drain must stay single-flight: `FOR UPDATE SKIP LOCKED` plus the stuck-row sweeper is what makes concurrent drains safe. |

---

## 10. Phases

Ordered by what kills the business, not by what is interesting. Each phase ends in something usable — no six-month cliff.

### Phase 0 — Housekeeping (hours) — **DONE 2026-08-11**
- [x] `git rm -r apps/builder apps/admin`
- [ ] `HOST`, `MAX_SINK_BYTES`, `MAX_READ_BYTES` into `.env.example` — **the one item still open**
- [x] Commit the security patch set — `b3526dd`, 38 files
- [x] Fork vs downstream: **fork.** `github.com/en449/openfunnel`, public; `upstream` remotes at `luispdoesai/openFunnel`
- [x] **Pushed to GitHub**, and the licence obligations closed with it (`1064bdf`):
  - §4 — the full AGPL text ships in `LICENSE` (it was a 24-line notice pointing at gnu.org)
  - §5(a) — modification notice in `README.md`: branch point `4164afd`, every change dated
  - §13 — every funnel page renders a source link, **not suppressible by `branding.hidden`**
    (that flag governs the "Powered by" badge, which the licence does not require).
    `SOURCE_URL` lives in `packages/engine/src/controller.js`; `branding.sourceLabel`
    translates the label. A test asserts the link survives all three hide paths.
- **Done means:** clean tree, CI green (128 pass / 1 known Bun failure), repo pushed, licence obligations satisfied. ✅

**Correction to the §13 reading recorded earlier:** publishing the repo is necessary but not
sufficient on its own. §13 requires the offer be made *to the users interacting with the
program remotely* — the funnel's visitors, not the operator. Hence the in-page link. Put it in
the same footer as Impressum and Datenschutz, which a German funnel needs regardless, and it
costs nothing extra in design.

### Phase 1 — Never lose a lead (3–4 weeks)
The reason the project exists. Sized up from 2–3 weeks: the serverless port and moving three
in-memory stores to Postgres are real work the VPS design did not need.

Checklist state verified against the code on 2026-08-13, item by item — not from the session log.
Where something shipped in a different shape than this list described, the line says so instead of
just carrying a tick.

*Port*
- [x] Extract the router from `Bun.serve` into `handleRequest(req, opts)`; two entry points — `api/index.js` (Vercel, Node runtime, `maxDuration: 60` in `vercel.json`) and `apps/runtime/server.js` (Bun, local). Done 2026-08-12, WO11, PHASE-1-PLAN.md §4.2. One seam this list did not anticipate: `waitUntil` is passed in alongside `server`, because Vercel may freeze the invocation the moment the response is written
- [x] **Rate limits, OTP store and `MAIL_HOURLY_CAP` into Postgres** — `rate_hit`, `issue_otp`, `verify_otp`, `is_email_verified` (WO9 + WO10, PHASE-1-PLAN.md §4.1); `MAIL_HOURLY_CAP` goes through the same `rate_hit`. Different shape than "into Postgres" reads: the in-process bucket stays as the fallback for an install with no database and for an RPC that throws, so a database blip degrades the ceiling rather than failing the request. OTP is the deliberate exception — `verifyOtpCode` / `isEmailVerified` fail **closed**
- [x] `TRUST_PROXY=1`, `clientIp()` reads Vercel's forwarded header (`lib/config.js`, `lib/http.js`; the variable is set on the Preview environment, and the code warns once when a forwarded header shows up without it). Loopback trust was **not removed** — it is structurally unreachable off Bun instead: `isLoopbackRequest` returns false the moment there is no `server` object, so the Vercel entry point has no loopback trust at all while the local Bun shell keeps it (§4.2 Decision 1)
- [ ] Vercel edge rate limiting on the public project — untouched. No firewall rule, nothing in `vercel.json`; every ceiling is application-side

*Durable delivery*
- [x] Postgres schema + migrations (§2.5) — four files in `supabase/migrations/`. **Down is not a runnable migration:** each file carries a commented `drop` block in dependency order, because `supabase db push` has no down step. Reversing one means pasting that block
- [x] Lead writes in one transaction with their delivery rows — `ingest_lead`. Events are deliberately **not** part of this: `ingest_event` writes the row and stops, because an event has no delivery targets to write
- [x] Inline first attempt — `drainOnce({ leadId, signal: req.signal })`, deferred through the `waitUntil` seam rather than Vercel's `after()`. No `assertNotAborted()` polling: `supportsCancellation` is off in `vercel.json` on purpose (§4.2 Decision 4), so a client disconnect never aborts that attempt on Vercel. Turn it on only together with dropping `req.signal` from this call
- [x] Degrade-forward path (§2.6) — `persist(kind, record, { fanOut })`. `storeLead()` returns `{ leadId, queueOwnsIt }`, and the fan-out reads `queueOwnsIt`; inferring it from `Boolean(leadId)` sent duplicates in one direction and went silently dark in the other
- [x] `pg_cron` + `pg_net` retry drain → `/api/internal/drain`, `INTERNAL_SECRET` in Supabase Vault — `supabase/cron.sql`, which is deliberately not a migration. Proven unattended on the live project, attempts 1 → 4 with nobody watching (WO8, §4.5)
- [x] Stuck-`delivering` sweeper — `sweep_stuck_deliveries()` against a 5-minute lease, scheduled every minute
- [x] Targets: email (Brevo adapter, WO12b) and webhook with `Idempotency-Key` — derived from the funnel document by `lib/targets.js` and written through `sync_delivery_targets`
- [ ] Google Sheets target — not built. `DerivedTarget` is `webhook | email` only; nothing has needed a sheet yet
- [x] Delivery log view in the console + manual re-send (§4.4) — the log names its columns and never selects `delivery_target.config`, and a re-send refuses a row still in `delivering`
- [x] Dead-letter alerting to Enno (§4.7) — one digest per drain pass, on its own rate bucket, carrying no secret. `NOTIFY_EMAIL` is still unset, so it currently has nobody to mail (Enno's, §8.10)

*Deploy + safety*
- [ ] Two Vercel projects, `funnel` public and `console` behind Vercel Authentication — **verified logged-out** (§5.2). Still one project: console and funnel share an origin, and the whole preview sits behind Vercel SSO — which protects the preview, not the console on a production domain
- [ ] Supabase Pro, `eu-west-1`, PITR window set explicitly + **one verified restore** — needs the Pro upgrade (Enno's, §8.10)
- [ ] Uptime monitor on a real funnel URL, off-platform

*DSGVO gates*
- [x] **GATE — self-host the preset fonts, remove the Google Fonts path entirely** (§8.2) — done 2026-08-12, PHASE-1-PLAN.md §4.9. The console's own Inter/JetBrains Mono hotlink was found in the same pass and went with it
- [x] **GATE — strip `fonts.googleapis.com` / `fonts.gstatic.com` from the default `funnelCsp`** (§8.2, found in the spike) — done 2026-08-12, same change
- [x] **GATE — Brevo wired, Resend removed from the default path** (§8.3) — adapter 2026-08-12 (WO12b, PHASE-1-PLAN.md §4.6), default path 2026-08-13. `brevo` is now the first entry in `API_TRANSPORTS` and the first branch of the inference chain in `getEmailSettings`, which are the two halves of that decision; the table order *is* the default. Only one deployment changes behaviour — both keys configured and `EMAIL_PROVIDER` unset — and it already warned. An install with only `RESEND_API_KEY` still sends through Resend, which stays supported. Mail is proven end to end on the live preview, which holds a Brevo key and no Resend key. **Still Enno's, and outside this box:** `BREVO_FROM` on a verified sending domain (SPF/DKIM), and the Brevo AVV + its subprocessor disclosure (§8.3, §8.9)
- [ ] **GATE — Vercel + Supabase DPAs in force, SCCs in place, TIA written** (§8.0, §8.3). Neither is signed in the classic sense: Supabase's is auto-incorporated on acceptance of the terms on every tier, Vercel's binds on entering the agreement **but covers Pro and Enterprise only** — so this gate is not passable while the build sits on Hobby (§2.1). Action is: upgrade, archive both PDFs with their acceptance dates, then write the TIA and name both processors in every client AVV
- [x] IP hashing with a salt; no raw IP written anywhere ([REALITY-CHECK.md](REALITY-CHECK.md) §3) — column 2026-08-12 (WO4), the other three stores 2026-08-13. `hashIp()` writes `lead.ip_hash` salted with `IP_HASH_SALT` (set on Preview) and stores **nothing** when the salt is missing; one shared `outboundPayload()` strips `ip` / `referer` / `user_agent` off every outbound payload — the queue path had that and the **direct fan-out did not**, so the webhook on every database-less install was posting the address to the operator's CRM in the clear; `persist()` strips `ip` before the JSONL sink, which was the only lead store such an install has, and `readJsonlRecords()` strips it again on read so a sink written earlier stops feeding the admin readers; and `rateLimit()` sends `rate_hit` a salted digest instead of the key, because `ingest:<ip>` and `otp-send:<email>` became rows in Postgres when the buckets moved there. The console's lead drawer stopped printing an IP too — it fell back to a hardcoded `127.0.0.1`, so it had been showing a fabricated address. What is left in the clear: nothing at rest. The address stays in this process for rate limiting, and reaches Meta only through the opt-in, consent-gated CAPI forward
- [x] **Version the `/_of/*` path** (`/_of/v-<hash>/…`) — done 2026-08-12. `serveEngine` used to send `max-age=31536000, immutable` on URLs with no version, so a returning visitor ran the engine from the deploy they first saw; measured on the live preview, where a warm load still fired the deleted Google Fonts request. The header now follows the URL shape, so only a versioned URL is pinned. Design in PHASE-1-PLAN.md §4.9.1
- [ ] Measure real-device LCP on a preset funnel over 4G — 22 unbundled module requests per page load, decide whether the no-build-step invariant still pays ([REALITY-CHECK.md](REALITY-CHECK.md) §6)

**Done means:** a lead submitted on a real phone reaches every configured target in under 5 seconds; killing a target for an hour loses nothing and the drain delivers it on recovery; the console is unreachable logged-out; a PITR restore produces a working database; and **a funnel page on a cold cache makes zero third-party requests** — verified in devtools, not by reading the code.

### Phase 2 — Client-ready (2–3 weeks)
- [x] Asset upload to Supabase Storage — done 2026-08-13, PHASE-2-PLAN.md §1. **Not via Storage transformations:** those are Pro-only, so the console downscales to a 1920px WebP in a `<canvas>` before uploading, which is better here anyway — the bytes stored are the bytes served. One size, not a `srcset`; the 4G measurement item below decides whether a second one is worth it. The bytes never pass through the server (signed upload URL), and the bucket is public-read with no write policy
- [~] Custom domains — the **runtime half is done** 2026-08-13 (PHASE-2-PLAN.md §2): the `domain` table, `FUNNEL_DOMAINS` for database-less installs, and a third structural gate in `handler.js` so a mapped host serves that one funnel and answers 404 to the console shell, the funnel LIST and every privileged and internal route. That gate is the prerequisite, not the feature: without it a client's hostname also serves the operator's console and admin API, same-origin, with only `ADMIN_TOKEN` in the way. **The Vercel attachment is deliberately not automated** — on Hobby a domain is only public when attached to Production, and adding one fails until a successful production deployment exists, which is a standing No-Go while the console ships in the same handler (`reference/vercel-custom-domains-2026-08-13.md` §Q7). The operator attaches the domain in the dashboard; the console shows what the client's DNS needs. Wildcard `*.f.enno.de` needs the zone's nameservers delegated to Vercel — a DNS decision, not code
- [x] Client report link `/r/:token` — done 2026-08-14, PHASE-2-PLAN.md §3. Server-rendered HTML with **no report API and no JavaScript**: the token is the whole credential, so the route reads it out of its own path and answers in one request rather than a client-side page holding it and sending it on every subrequest. The token itself is never stored — only `sha256(token)` — and is looked up **by that digest**, so there is no comparison left to make constant-time. `resolve_report_token` decides validity in SQL, in one place; the route's entire authorisation logic is "did a row come back". Every refusal — expired, revoked, never existed, one character off — is the same 404 with the same body. §3.3 lists delivery state as part of the report; it is deliberately **not** shown: it is the operator's plumbing, the client can do nothing with `attempts: 3, last_error: ECONNREFUSED`, and a red row would generate a phone call about a lead that already arrived. Still open, and named in PHASE-2-PLAN.md §3's own "not in scope": a per-client PIN on top of the token, and the weekly summary email (next line)
- [ ] Weekly client summary email
- [ ] Spam scoring + duplicate detection
- [ ] `funnel_daily` rollup + drop-off view
- [~] **DSGVO GATE — deletion path per data subject, proven across `lead`, `event` and Storage** (§8.7) — the **mechanism is code-complete and tested**, done 2026-08-19 (PHASE-2-PLAN.md §4 WO D3): `find_subject`/`erase_subject` in `supabase/migrations/20260819100000_subject_rights.sql`, 21 scenarios / 67 assertions in `supabase/tests/subject-rights.sql`, green under `scripts/db-test.sh` against a local Postgres with the `check_asserts` tripwire on. Storage turned out to need no walk at all — corrected from the plan's original design (PHASE-2-PLAN.md §4 Decision 2): nothing links a Storage object to a data subject, because ingest stores no uploads (`file` is absent from the console's field types) and every object under `funnel/<slug>/` is the operator's own marketing photography, put there by the console, not lead data. The Löschkonzept is written down as `LOESCHKONZEPT.md` (WO D8). **Not true on the live project yet**: this migration is committed and has **not been pushed** — `find_subject`/`erase_subject` do not exist on the live Supabase database, so a deletion request cannot actually be executed against a real client until `supabase db push` runs. That push is Enno's to do, not code's
- [~] **DSGVO GATE — retention purge job running and logged** (events 90d, leads per-client default 12 months) — the **function is code-complete and tested**, done 2026-08-20 (WO D5): `purge_expired()` in `supabase/migrations/20260819140000_retention_purge.sql` does the three deletions §8.7 promises (events at 90 days, leads at `greatest(client.retention_months, 1)`, a soft delete turned hard 24h later) and logs every run — including one that deleted nothing — into `purge_run`. 42 assertions in `supabase/tests/purge.sql`, red-checked against 13 deliberate breaks. **Not running anywhere yet**: same blocker as the line above, this migration is not pushed to the live project, and even after it is, `supabase/cron.sql`'s `openfunnel-purge` schedule (which also retires the old inline `openfunnel-event-purge` delete in the same statement, so the two jobs cannot double-count) is a **manual step against the live project that nobody has run**. Both the push and the cron step are Enno's
- [~] **DSGVO GATE — subject search by email/phone across a client's leads** (§8.6) — the console half is done 2026-08-20 (WO D4): `GET /api/admin/subjects` + the Subjects view — pick a client, search, read what is held (soft-deleted, restricted and spam rows shown with their flags, not filtered out, because the data subject is entitled to know a record exists), export as JSON client-side. Verified in a browser against a stubbed PostgREST with two clients (`screenshots/d4-subjects-erase-receipt.png`). **Blocked by the same unpushed migration as the line above**: the search calls `find_subject`, which does not exist on the live database — until D3's migration is pushed this view answers a database error for a real client, not results
- [x] **DSGVO GATE — publish refused when `legal.impressumUrl` or `legal.privacyUrl` is empty** (§8.5) — done 2026-08-19 (WO D1 + D2), and needed no migration: `legal` lives on the funnel document, not a new column, so this line is not behind the D3/D5 push above. There is no publish action in this codebase (PHASE-2-PLAN.md §4 Decision 1), so the gate binds at SERVE time instead of at a publish step that does not exist: `/f/:slug` and `GET /api/funnels/:slug` answer 503 when the URL is missing or fails the engine's own `isNavigableUrl` check — a textual check was rejected here for the same reason CLAUDE.md gives everywhere else — and only when `dbConfigured()`, since a self-hoster serving `examples/*.json` is their own controller. 11 tests in `apps/runtime/test/funnels-gate.test.js`. One thing D2's own commit message flags as **not verified live**: the PostgREST embed reading `client(avv_signed_at)` was exercised only against a stub, not the live database — same form as `report.js`'s already-live `TOKEN_SELECT`, so low risk, but unconfirmed
- [x] **DSGVO GATE — publish refused when `client.avv_signed_at` is null** (§8.9) — done 2026-08-19, the same change as the line above (WO D2): the AVV half of the same serve-time gate, binding only for a funnel document that came from the `funnel` table — a disk funnel (`examples/*.json`) has no client row to check. The refusal reason is never sent to the visitor (naming it would disclose which client has not signed); the console shows it on the funnel card and in a banner over the builder, fed by `GET /api/admin/funnel-gates`. Same live-verification gap as above: the `client(avv_signed_at)` embed is untested against the live database
- [x] **DSGVO GATE — consent bar audited: reject as easy as accept, nothing pre-ticked, granular, withdrawable** (§8.4) — done 2026-08-21 (WO D6), no migration needed (`lead.consent` was already `jsonb`). Equal prominence: Accept and Decline now share one CSS rule and differ in nothing a visitor can see — an outlined Decline beside a filled Accept was the first attempt and was rejected as still reading secondary, the exact dark pattern the gate names. Withdrawable: a footer control (the bar itself cannot host it — it returns null once a decision exists) clears the decision and brings the bar back; withdrawing a GRANT on a funnel with a pixel also reloads the page, because clearing localStorage cannot unload `gtm.js`/`fbevents.js`, with three exemptions (decline, no pixel, builder preview) so the reload never fires where it would do harm instead of good. Nothing pre-ticked and granular-per-purpose both hold as before, by construction. Verified in a browser on a consent-enabled funnel (`screenshots/d6-consent-*.png`)
- [x] Consent evidence: store the consent text version alongside the signal and timestamp — done 2026-08-21, same change as the line above (WO D6): `consent.textVersion` on the funnel document travels into `lead.consent` as `{ signal, at, text_version }`, the shape the schema comment promised since Phase 1 while the column actually held a bare string. Ships as a SECOND field, `meta.consentRecord`, beside the pre-existing bare-string `meta.consent` — merging them was rejected because `lib/capi.js` compares the bare string to `"granted"` directly (CLAUDE.md invariant)
- [~] Art. 15/16/18/20 mechanisms: export, edit-with-audit-entry, `restricted` flag — **`restricted` (18) was already enforced end to end before this work order**, per the recon table in PHASE-2-PLAN.md §4. D3 + D4 (2026-08-19/20) add search (15) and JSON export (15/20): `find_subject` plus the console's client-side download of what the GET already returned — no separate export endpoint, so there is only one server surface returning this personal data. **Still not built**: Art. 16 edit-with-audit-entry, explicitly out of scope per PHASE-2-PLAN.md §4 ("it needs an audit log, which is a Phase 3 line"). And the search/export half carries the same live-migration blocker as the DSGVO GATE lines above — not usable against the live database until D3's migration is pushed
- [x] Datenschutzerklärung module generated from the funnel's actual configuration (§8.5) — done 2026-08-21 (WO D7): `GET /api/admin/privacy-notice?slug=` in `apps/runtime/lib/privacy.js`, rendered in the console's Settings behind a button (it costs a database round trip). Built to the rule CLAUDE.md now states — it may not claim anything the configuration does not do — and two review findings were exactly that: an unconditional Art. 28 sentence claiming an AVV that does not exist for an unsigned client, and a `sheet` delivery target described as delivering when it has no dispatcher and dead-letters every lead sent to it. Both defects now carry an inline `[ACHTUNG — NICHT VERÖFFENTLICHEN]` marker in the generated TEXT itself, not only in the console's `warnings`, because a warning lives in the console and this text gets pasted into a document by someone who may never open that panel. No migration; reads existing `client` and `delivery_target` rows, so — unlike the two D3/D5-gated lines above — this is live-usable today wherever those tables already are
- [x] Breach runbook, one page (§8.8) — `BREACH-RUNBOOK.md`, written 2026-08-21 (WO D8, this docs pass): detection, who is called, the five Art. 33(3) items named to the client, what evidence gets preserved, and the *unverzüglich*-to-the-client / 72-hours-is-the-client's-to-file split §8.8 specifies
- [ ] AVV template + TOM appendix + Art. 30(2) record + subprocessor list — **reviewed by a Fachanwalt or external DSB before client #1** (Enno-owned)
- **Done means:** one real client is live on their own domain, with real photos, receiving leads, and can see their own numbers without asking — **and a deletion request for one named person can be executed end to end and verified, and no funnel can go live with a missing Impressum or an unsigned AVV.**

### Phase 3 — Production line (1–2 weeks)
- [ ] Vertical templates (GaLaBau first — AQUARIS and the Verdant template are existing proof)
- [ ] Clone + rebrand flow
- [ ] `funnel_version` + rollback
- [ ] Phone preview via QR
- [ ] Per-funnel pixel/CAPI config in the console
- [ ] SMS notification target
- [ ] Minimal audit log
- **Done means:** a new client funnel goes from template to live in under 90 minutes.

### Phase R — Engine rewrite (3–6 weeks, deferred) — see §11

### Phase 4 — Productize (only if triggered)
Not scheduled. The trigger is external: someone who is not Enno wants to log in and pay.
- accounts/tenancy with RLS · real auth + sessions · billing · self-serve onboarding · seats and roles · public marketing surface · horizontal scale (shared OTP store, edge rate limiting) · status page

---

## 11. Phase R — Clean-room engine rewrite

Enno's decision. Recorded with its cost, its correct method, and my recommendation on when.

### Why it is deferred rather than first

- The engine is the **one part that already works and has been audited across three tracks**. The parts that are broken — delivery, storage, assets — are all outside it. Rewriting the working part first delays every revenue-relevant phase by 3–6 weeks.
- The AGPL obligation it removes is dischargeable in an hour by publishing the fork (Phase 0). Under the DFY shape there is no proprietary code whose secrecy is worth 3–6 weeks.
- The interface between the engine and everything else is the funnel JSON contract plus the ingest endpoints. Both are stable. So swapping engines later is cheap, and building the control plane first costs nothing extra.
- Deferring it also lets the rewrite be **informed by real funnels**. Six weeks of running client funnels will show which of the 20 block types and 8 themes are actually used. Rewriting first means rewriting all of it blind.

### If it happens: how to do it so it is actually clean-room

A rewrite by someone who has just spent two days inside the source is not clean-room; it is a derivative-risk rewrite with extra steps. The separation has to be real:

1. **Specifier** (agent A, Opus) reads the AGPL source and writes a *behavioural specification*: what each step type renders, what each block type contains, the branching precedence rules, the piping rules, the theme variable surface, the event contract, the security requirements from §6. No code, no file structure, no naming taken from the source.
2. **Implementer** (agent B, Sonnet, fresh context) implements only from that specification and from `types.js` as an interface description. It never reads `packages/engine/src`.
3. **Verifier** (agent C) runs both engines against the same funnel documents and diffs the rendered DOM and emitted events.
4. Written record of who saw what and when, kept with the code.

The funnel JSON contract itself is an interface. Re-implementing against the same format is standard practice and it is what keeps every existing funnel, template and example working through the swap.

**Scope of the rewrite:** 6 step types, 20 content blocks, branching, piping, validation, ~170 theme variables and 8 presets, ~1050 lines of CSS, analytics/pixels, consent gating, localStorage resume, lead submission. Plus every item in §6 as an explicit requirement — the rewritten engine starts with none of those lessons unless the specification carries them.

**Recommendation:** run Phase R after Phase 2, once at least one client has been live for a month. Reassess then — including the option of skipping it, if publishing the fork has turned out to cost nothing.

---

## 12. Open decisions

Blocking, in rough order:

1. **Phase R placement** — deferred as planned, or first? Deferring is my recommendation; the phase is self-contained either way.
2. ~~**Mail provider**~~ — **researched, recommendation ready: Brevo** (§8.3). Needs your yes, plus one check on Scaleway TEM's DPA if you want the cheaper option. Either way a small adapter is required.
3. **Domain strategy.** Client subdomains on one Enno-owned domain via the `*.f.enno.de` wildcard (zero client action, shared reputation — note the Heyflow Trustpilot complaint about a shared domain being blocked by Vodafone) versus client-owned domains (one CNAME from them, isolated reputation, better trust). My read: offer both, default to client-owned for anyone running paid traffic.
4. **Repo layout.** One repo, two Vercel projects, is the simplest thing that works — same codebase, two entry points and two build configs. But a Phase R clean-room implementer must not be inside a repo containing the AGPL engine. Recommendation: one repo now; carve the engine out to its own package or repo only when Phase R actually starts.
7. **Supabase PITR window** — pick a number, write it into the Löschkonzept (§8.7). It is a legal document input, not just a setting.
5. **Legal form, cyber liability, and one professional review** of the AVV / TOM / Löschkonzept before client #1 (§8.10) — not technical decisions, but they gate holding real PII at volume.
6. **First vertical.** GaLaBau has existing proof (AQUARIS demo, Verdant template, galabau-barbian). Not a technical question, but it decides which template gets built first in Phase 3.

Non-blocking, decide later: managed Postgres upgrade trigger; whether the client report gets a per-client PIN; SMS provider; whether `apps/app` eventually gets rewritten.

---

## 13. Kill switches

Revised — the pre-mortem's original set was tied to agency pitch counts, which no longer apply.

- **No real funnel live 6 weeks after Phase 1 completes** → stop. The infrastructure is not the bottleneck; having no client is. Building Phase 2 for nobody is the pre-mortem's failure mode 2 arriving on schedule.
- **A lead is confirmed lost in production after Phase 1** → stop all feature work until the cause is found and closed. That is the one defect this system exists to prevent.
- **Phase 1 exceeds 6 weeks** → the scope was wrong. Cut to: Postgres leads + email delivery + retries, nothing else, and ship it.
- **Two consecutive months of building with zero client work** → the tool has become the project. Stop and reassess.
- **Any client PII incident** → stop, disclose to the affected client *unverzüglich* per the runbook, and do not resume until the legal and insurance items in §8.10 are resolved.
- **Any DSGVO gate in §8 cannot be met** → that capability does not ship, and if the gate is structural (no EU mail provider, no workable deletion path) the phase does not close. A funnel taking real leads without a signed AVV, without an Impressum, or with a non-EU host in the default path is the one state this project must never be in.

---

## 14. Delegation plan

Per `~/.claude/CLAUDE.md` tier policy, and only once the plan is confirmed.

| Work | Tier | Why |
| --- | --- | --- |
| Schema design, delivery-queue semantics, security boundaries, Phase R specification, phase orchestration, reviewing subagent output | **Opus** | correctness is the product; a wrong call here is a lost lead or a leaked list |
| Route modules, console views, template authoring, migrations from an agreed schema, Vercel/Supabase config, test writing | **Sonnet** | separable work orders against a written spec |
| Renames, boilerplate, log scanning, formatting | **Haiku** | mechanical |

Build Workflow applies to every non-trivial change: write, then `code-reviewer` and `qa` in parallel, parent applies fixes, re-run if the fixes were non-trivial. The audit already proved the reviewer step earns its keep on security work — round one of the patch set looked correct, passed its own tests, and was bypassable by a single tab character.
