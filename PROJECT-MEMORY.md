# OpenFunnel — Project Memory

> Full state for the OpenFunnel project: conversations, decisions, and tasks.
> **Deliberately project-local.** Global auto-memory only holds a one-line pointer here
> (`project_openfunnel.md`, type `reference`) so this does not load into every session.
> Read this file when the work is about OpenFunnel; otherwise skip it.
>
> Companion docs in this folder:
> - [security-audit/SUMMARY.md](security-audit/SUMMARY.md) — audit verdict + all findings (read this before re-auditing anything)
> - [security-audit/audit-A-malicious.md](security-audit/audit-A-malicious.md) · [audit-B-client.md](security-audit/audit-B-client.md) · [audit-C-runtime.md](security-audit/audit-C-runtime.md) — full track reports
> - [reference/postgres-tenant-isolation.md](reference/postgres-tenant-isolation.md) — RLS tenant isolation + HTTP retry-safety patterns
>
> Update protocol: append to the Session Log, move tasks between sections, add to the
> Decision Log with a date and a reason. Never delete a decision — supersede it and say so.

---

## Resume here (updated 2026-08-10, second session)

**The SaaS question is answered. See [PLAN.md](PLAN.md) — that is now the primary document
for anything forward-looking.** This file keeps the history, the audit outcome and the
decision log; PLAN.md holds the architecture, the feature scope and the phases.

Decisions taken 2026-08-10 (session 2), after a revised pre-mortem:

1. **Shape: done-for-you funnels, not a SaaS.** Enno operates funnels for clients; the
   platform is delivery infrastructure. No self-serve signup, no billing, no multi-tenancy.
   This supersedes the "Planned — only if the SaaS goes ahead" list below: items 5, 7 and 11
   (auth/user model, RLS tenancy, billing) move to a Phase 4 that is not scheduled and has an
   external trigger. Items 6, 8, 9 (Postgres, asset storage, durable delivery) are Phase 1–2
   and are now the core of the build.
2. **AGPL: clean-room rewrite of the engine — deferred to Phase R**, after a client is live.
   Recommendation recorded in PLAN.md §11: publishing the fork discharges AGPL §13 in about an
   hour, so the rewrite buys optionality rather than compliance, and the engine is the one part
   that already works. Also flagged: a rewrite by someone who has just audited the source is
   not clean-room — it needs a specifier/implementer split, described in §11.
3. **DSGVO is a hard constraint, not a section.** PLAN.md §8 is the binding treatment, with
   gates that block phases. The two that change existing code: **self-host the preset fonts**
   (all 8 presets hotlink Google Fonts — LG München I 3 O 17493/20; verified live, it fires with
   no consent because the shipped examples have consent off), and **drop Resend** (US processor;
   **Brevo** is the researched replacement).
4. **Infrastructure: Vercel + Supabase, not a Hetzner VPS** (decided session 3, supersedes the
   original §2). Two Vercel projects — public `funnel`, private `console` behind Vercel
   Authentication — against one Supabase Postgres in `eu-west-1` (Ireland; project created 2026-08-11, the plan had said Frankfurt and Supabase cannot move a project after creation — Ireland is EU/EEA so nothing in §8 changes). **DSGVO consequence accepted
   explicitly (PLAN.md §8.0): both are US companies in EU regions, lawful under SCCs + DPAs, but
   the "kein US-Anbieter / Hosting in Deutschland" positioning is withdrawn.** Do not put it in
   sales copy. Three things move into Phase 1 that the VPS design deferred: the `Bun.serve` → 
   handler port, rate limits/OTP/mail cap into Postgres (in-process `Map`s do not bind on
   serverless), and a `pg_cron` retry drain replacing the worker loop.

**Pre-mortem gate: SATISFIED 2026-08-10.** Enno confirmed all four points — the failure analysis
stands, PLAN.md is the direction, the kill switches in PLAN.md §13 are real, and code may start.
Building is unblocked.

Decisions taken 2026-08-11 (session 4) — **Phase 0 is done, Phase 1 is next**:

5. **Build on Vercel Free + Supabase Free; upgrade to both Pro tiers before the first client
   funnel goes live.** Rewritten into PLAN.md §2.1 with the evidence. The two reasons recorded
   in session 3 were wrong — Hobby's 10s function cap applies only to pre-2025-04-23 projects
   without Fluid compute (Fluid Hobby is 300s), and the daily-cron limit never applied because
   the drain runs on `pg_cron`. What actually blocks client work: **Vercel's DPA covers Pro and
   Enterprise only** (so the §8.0 gate is unpassable on Hobby), Hobby is contractually
   non-commercial, and Hobby cannot protect a production domain — which the console's
   no-login-of-our-own design depends on. Supabase Free is lawful (DPA auto-incorporated on
   every tier) but has no backups. **Standing rule while on Free: no real personal data.**
6. **Local Postgres on an external SSD: rejected for production, fine for dev.** Vercel
   functions reach the database from Vercel's network; a Mac-attached SSD needs a tunnel, and
   then a sleeping laptop loses leads. Use the Supabase CLI locally (same Postgres, `pg_cron`,
   `pg_net`, same migrations, `supabase db push` to go live) — no schema drift, no rewrite.
7. **AGPL: fork published, obligations closed, Phase R still deferred.** §13's requirement runs
   to *the funnel's visitors*, not to Enno — so publishing the repo alone was not enough and an
   in-page source link now ships. Enno's stated trigger for the clean-room rewrite: **wanting to
   sell the software or give clients direct access to it.** Until then the licence costs one
   footer link. The repo can go private any time nothing is deployed; while funnels are live the
   source of *that version* must stay publicly reachable. Client funnel documents, leads and
   credentials are data, never covered — but `FUNNELS_DIR` defaults to `examples/`, inside the
   published tree, so Phase 1's move to Postgres is also what keeps client copy out of GitHub.

The kill switches he agreed to, repeated here because they are the part with teeth:
no live funnel 6 weeks after Phase 1 completes → stop · one lead confirmed lost in production →
all feature work stops until the cause is closed · Phase 1 over 6 weeks → cut to leads + email +
retries and ship · two months of building with zero client work → stop and reassess ·
any DSGVO gate that cannot be met → that capability does not ship.

The four housekeeping items below are unchanged and are Phase 0 in PLAN.md:

1. **Delete the legacy UIs.** `git rm -r apps/builder apps/admin`. The routes and config
   constants are already gone, so this only removes dead files. Undo:
   `git checkout 4164afd -- apps/builder apps/admin`.
2. **Add three vars to `.env.example`.** The agent cannot touch `.env*` (hook policy), so
   paste this under the `# Runtime Configuration` block — it mirrors what README.md already
   documents:
   ```env
   # Interface to bind. Loopback by default; the console trusts loopback callers when
   # ADMIN_TOKEN is unset, so 0.0.0.0 must be a deliberate choice.
   HOST=127.0.0.1

   # Ceiling per JSONL sink in bytes (default 64MB). At the cap the file rotates to
   # <name>.jsonl.1. Ingest is public, so without this a stranger sizes your disk.
   MAX_SINK_BYTES=

   # Most bytes an admin reader pulls into memory from a sink (default 8MB, newest tail).
   MAX_READ_BYTES=
   ```
3. **Decide whether to commit.** Everything is uncommitted on `4164afd`. Suggested split if
   you want reviewable history: one commit per finding (M3, M2, M4, M1, B1, B2, B3), or one
   "harden per security audit" commit plus a separate one for the docs. AGPL-3.0, so if this
   ever ships to users the source has to be offered.
4. **Answer the actual open question:** is the SaaS happening? Nothing below this line
   proceeds until that is decided — see Open questions at the bottom.

Verify at any point (all four should stay green, bar the known Bun failure):
```bash
bun test          # 127 pass / 1 fail — the 1 is Bun 1.3.13 vs pinned 1.3.14
bun run typecheck
bun run scripts/check-no-deps.mjs
bun run scripts/check-engine-imports.mjs
```

Do NOT re-derive the audit: `security-audit/SUMMARY.md` has every finding, and the Decision
Log below records what was fixed, what was deliberately left, and why.

---

## Status

**Phase: evaluation, now with the security findings patched.** Enno chose on 2026-08-10 to
fix the audit findings rather than decide the SaaS question first. M1–M4 and B1–B3 are
fixed in the working tree; the SaaS question itself is still open and nothing beyond the
patches has been built.

Changed since the audit: `bun install` HAS now been run (devDeps only — `happy-dom` +
`typescript`, the two the audit cleared, installed with `--frozen-lockfile`). The suite
and the typecheck run locally. Still **no commits** — the fixes sit as uncommitted working
tree changes on `4164afd`.

**Test baseline: 127 pass / 1 fail.** The failure is `ingest > refuses an oversized body
without buffering it` (expects 413, gets 400) and is NOT this codebase's: installed Bun is
1.3.13, `package.json` pins `bun@1.3.14`, whose changelog fixes exactly that path (chunked
body over `maxRequestBodySize` with a pending-Promise handler). Confirmed identical on the
pristine `4164afd`. Run the pinned Bun before investigating it.

---

## What this is

`AI Stuff/OpenFunnel` = clone of `github.com/luispdoesai/openFunnel` at commit `4164afd`
(2026-08-07), cloned 2026-08-09.

Self-hostable alternative to Perspective.co / Typeform / Outgrow — mobile-first quiz and
lead funnels aimed at paid traffic. AGPL-3.0 (matters: shipping a modified version to users
obliges you to offer source).

- **Provenance caveat:** repo was 10 days old at audit time (first commit 2026-07-29), one
  author (Luis Padilla), heavily AI-assisted. No track record, no upstream second pair of
  eyes. Not a security finding, but relevant to betting a business on it.
- Local git tree is clean at `4164afd`. `security-audit/`, `reference/` and this file are
  **untracked additions**, not upstream content.

---

## Codebase map (established 2026-08-09)

| Part | LOC | Verdict |
| --- | --- | --- |
| `packages/engine` | ~5k | **Build on it.** Zero-dep browser ESM, JSDoc-typed, embeddable in React/Vue/Next/Astro via `createFunnel(container, config, opts)`. |
| `apps/runtime` | 2949 | **Keep it.** Bun server, no framework. Holds funnel rendering, CSP hash-pinning, SSRF egress guard, Meta CAPI, funnel-tied OTP — nothing else gives you these. |
| `apps/app` | 3953 JS + 1101 HTML + 2101 CSS | **Replace, don't extend.** Vanilla-JS console SPA, no components, no build step. Fine to add a view; painful to reskin. |
| `apps/builder`, `apps/admin` | 518 + 171 | **Unmounted 2026-08-10**, directories still on disk pending manual `git rm`. Legacy standalone UIs; finding B3 lived here. |

Key seams and facts:

- **Already speaks PostgREST.** `supabaseInsert()` is 20 lines of raw `fetch` against
  `${URL}/rest/v1/${table}` ([apps/runtime/lib/store.js:37-53](apps/runtime/lib/store.js#L37-L53)).
  No SDK, no coupling → any Postgres backend swaps in near-free.
- **No user model.** One shared `ADMIN_TOKEN` ([apps/runtime/lib/auth.js](apps/runtime/lib/auth.js)).
  This is the single biggest gap for productizing.
- **No asset storage.** Which is why `CLAUDE.md:418` warns templates must render with zero
  assets — a shipped empty `src` drew a black player and broken image boxes.
- **Single-instance by design.** Rate limits, OTP store, mail cap are in-process `Map`s.
  Correctly documented in the README and printed as a boot warning under
  `NODE_ENV=production`. Autoscaling silently multiplies every ceiling by replica count.
- **Its `CLAUDE.md` is a 532-line extension manual** — `Common tasks` gives exact
  file-touch chains (add step type / content block / console view / pixel / template), plus
  a `Known gaps` list naming UI controls the console writes that nothing reads
  (`theme.btnStyle`, `googleAdsId`, `of.globalCode`, `of.ai.brandVoice`).
- **No design system doc.** Implicit only: `.of-*` namespace + ~170 `--of-*` CSS custom
  properties in one 1054-line `styles.css`, 8 presets in `theme.js`. No tokens file, no
  component spec, no Storybook.

---

## Decision Log

### 2026-08-09 — Repo is safe to keep. ACCEPTED.
Three parallel audit tracks, read-only, nothing executed. Not malicious: zero runtime
dependencies, no install/postinstall hooks, no obfuscation, no undisclosed egress, no
`eval`/`child_process`, no credential or filesystem probing, no prompt injection aimed at an
agent reading the repo, no typosquatted packages, CI least-privilege. Cloned to
`AI Stuff/OpenFunnel`.

### 2026-08-09 — Safe to run locally. Not safe on an untrusted LAN. ACCEPTED with conditions.
Locally fine on a trusted single-user machine; do not import funnel JSON you have not read
(M1/B1), note `0644` on PII files. Public exposure: confidentiality holds with
`ADMIN_TOKEN` + TLS + correct `TRUST_PROXY` — no remote-unauthenticated path to leads,
funnel writes, console script execution or the internal network was found. Availability does
not hold; M3 then M2 must be fixed first, and never run more than one replica.

### 2026-08-09 — InsForge rejected as the backend. REJECTED.
Evaluated `github.com/InsForge/InsForge` (Apache-2.0, v2.3.0) at Enno's request as a
backend for a productized OpenFunnel. Rejected on four grounds:

1. **Inverts auditability.** The OpenFunnel verdict was possible *because* it is 15k LOC with
   zero deps. InsForge is 65k LOC backend + 68k LOC dashboard + 43 runtime deps + Docker.
   "Bulletproof" and "unaudited 133k-LOC dependency holding lead PII" don't coexist.
2. **Lacks the one thing needed.** No org/tenant table — one project per running instance.
   Multi-tenancy is the hard part of the SaaS, and it stays undone.
3. **Differentiator is cloud-only.** The MCP transport is not in the repo (no
   `@modelcontextprotocol/sdk`, no tool dispatch); docs point at hosted
   `mcp.insforge.dev`. CLI + Skills are "cloud only" per their own README, Compute is
   private preview, client SDK sources absent, cloud functions couple to Deno Deploy
   Subhosting. Net: self-host the commodity, depend on their cloud for the good part.
4. **Maturity.** ~1 year old, small team. Zero `TODO`/`FIXME` across 133k LOC reads as
   scrubbed or generated, not as a quality signal.

License was clean (plain unmodified Apache-2.0, no BUSL/Commons-Clause). Clone deleted after
extracting two patterns → [reference/postgres-tenant-isolation.md](reference/postgres-tenant-isolation.md).

### 2026-08-09 — Recommended stack if the SaaS proceeds. PROPOSED, not decided.
Boring, proven, individually replaceable:

- **Postgres** — managed (Supabase / Neon / RDS). OpenFunnel's PostgREST seam makes Supabase
  a near-zero-work swap for lead storage today.
- **Auth** — Supabase Auth, Clerk, or WorkOS. Closes the biggest gap.
- **Storage** — S3 or R2. Unblocks real images/video in funnels.
- **Queue** — Redis + BullMQ, or SQS. This is what makes lead delivery bulletproof.
- **Keep `apps/runtime`** as the funnel engine and public ingest layer.

Reasoning: same three capabilities as InsForge, minus the Docker fleet and the unaudited
surface, plus a hosted option and a real escape hatch.

### 2026-08-10 — Patched all audit findings. DONE.
Fixed in the working tree, in the planned order. Each fix and the reason it takes the shape
it does is written into the code it changes; the short version:

| Finding | Fix |
| --- | --- |
| M3 disk/memory exhaustion | `.jsonl` sinks rotate at `MAX_SINK_BYTES` (64MB) to `<name>.jsonl.1`; readers take only the newest `MAX_READ_BYTES` (8MB) tail; malformed lines skipped instead of aborting the read; files created 0600. |
| M2 rate-limiter prune | Buckets store their own `windowMs`; the prune judges each by its own window, so public `/api/events` traffic can no longer delete the hourly mail cap. |
| M4 bind address | New `HOST` env, default `127.0.0.1`. Banner prints the real bind and flags `0.0.0.0`. |
| M1 `leadEndpoint` hijack | `publicFunnel()` keeps the field only as a same-origin path and logs anything else; the `connect-src` widening in `funnelCsp` is gone. |
| B1 `step.consent` innerHTML | New `richText()` in `dom.js` rebuilds the fragment from a tag allowlist — no attribute survives except an `href` that passes `isNavigableUrl`. |
| B2 iframe `src` bypass | New `embedUrl()` parses the URL and matches hostname by equality; both call sites (`blocks.js`, `landing.js`) share it instead of each carrying a copy of the regex. |
| B3 `postMessage(doc, "*")` | `/_builder/*` and `/_admin/*` unmounted, `BUILDER_DIR`/`ADMIN_DIR` removed. **Directory deletion still pending** — see Tasks. |
| minor | Lead/event files now 0600 rather than 0644. |

Two new test files assert the vulnerabilities rather than the implementations:
`apps/runtime/test/hardening.test.js` and `packages/engine/test/sanitize.test.js`. Each was
checked against the pre-fix code first and fails there, so they are regression tests and
not tautologies — the reviewer re-verified this independently by running them against a
scratch copy with the old `dom.js`/`funnels.js` swapped back in (13/13 fail).

**The first review round FAILED this patch set, and the finding was real.** The M1 and B1
fixes originally validated URLs by pattern (`startsWith("/")`, `!startsWith("//")`,
`!startsWith("/\\")`). The WHATWG URL parser deletes every ASCII tab, newline and carriage
return from anywhere in the input *before* resolving, so `"/\t/evil.tld/collect"` — one JSON
escape — passed all three tests and still resolved to `https://evil.tld/collect`. Verified
directly: `new URL("/\t/evil.com/c", "https://operator.example/f/x").href` is
`https://evil.com/c`. That defeated the leadEndpoint guard and the `href` filter in
`richText` with the same character. All three validators now construct a `URL` and compare
`origin`. Generalised in [[feedback_url_validation_parse_not_match]] — the lesson is not
OpenFunnel-specific.

Three more things came out of that round and are fixed:

- `Controller.submitForm` re-checks `leadEndpoint` with `isSameOriginUrl` itself. The
  server strips the field from the copy it serves, but the engine also mounts standalone in
  someone else's page where no redaction and no CSP apply.
- `richText` has a recursion depth cap. ~30k nested `<div>` in a `consent` field overflowed
  the stack, and the `RangeError` escapes into an uncaught `Controller._render` — one
  crafted field blanked the whole funnel, not just the consent line. The deep subtree is
  dropped rather than flattened, because `textContent` is itself recursive in happy-dom and
  re-created the overflow at the guard.
- `appendJsonl` no longer swallows rotation or append failures.

Also reverted from the first attempt: `isNavigableUrl` gating on `<video src>`/`poster`. A
`<video src>` cannot execute, so that was not B2 — it only turned a `data:` URI into a
silently empty player. Only the iframe path is gated.

Second review round: **PASS**, no Critical, no Major. QA both rounds: **PASS** (127/1, the
one failure pre-existing — see below).

Deliberately NOT done in this pass, and why:

- `ALLOW_CUSTOM_SCRIPTS` left exactly as it is. Unset is already the safe state and the
  standing constraint says leave it unset; changing the opt-in semantics is a redesign.
- ReDoS in `validate.js` (`new RegExp(field.pattern)` from funnel data), the Oracle/IPv6
  metadata gaps in the SSRF blocklist, `test-email` being exempt from `MAIL_HOURLY_CAP`,
  OTP codes printed to stdout on a no-transport install. All from the audit's "minor /
  operational" list, none of them reachable without either an admin token or an imported
  document, and each is a separate small change.
- B4 (secrets in cleartext `localStorage`) stands. It is a property of the console's
  design, not a bug in a line — closing it means the real user model, task 5.

### 2026-08-09 — Engine is a foundation, console is a reference implementation. ACCEPTED.
If building a real product UI: keep `packages/engine` + `apps/runtime`, drop all three
`apps/*` UIs, build fresh against the documented funnel JSON contract in
`packages/engine/src/types.js` (515 lines of JSDoc typedefs, the single source of truth).
That path is well-supported. Shipping their console with new branding means 6k lines of
vanilla JS/CSS with no component boundaries.

---

## The real bulletproofing gaps

Not solved by choosing any backend. These are the actual roadmap:

1. **No durable delivery.** `persist()` uses `Promise.allSettled`, so a failed webhook or
   email is a `console.warn` and the lead forward is silently gone. For a lead-capture
   product this is the worst failure mode: customer paid for the click, lead was captured,
   it never reached their CRM. Needs a durable queue with retries and a dead-letter path.
   Retry-safety classification is written up in
   [reference/postgres-tenant-isolation.md](reference/postgres-tenant-isolation.md) §5.
2. **Single-instance ceilings.** Horizontal scale needs a shared OTP store (Redis or a
   Postgres table) and edge rate limiting (Cloudflare / load balancer) before a second
   replica exists.
3. **No tenancy.** Per-account scoping of funnels and leads. Do it in Postgres with RLS so a
   forgotten `WHERE account_id = ?` cannot leak another tenant's leads — pattern in
   [reference/postgres-tenant-isolation.md](reference/postgres-tenant-isolation.md) §1-4.
4. **No billing.** Neither repo has any.

---

## Tasks

### Done
- [x] 2026-08-09 — Security audit, 3 parallel tracks (malicious/supply-chain, client-side, runtime server). Read-only; no repo code executed, no deps installed.
- [x] 2026-08-09 — Cloned repo to `AI Stuff/OpenFunnel` at `4164afd`.
- [x] 2026-08-09 — Wrote `security-audit/` (SUMMARY + 3 track reports).
- [x] 2026-08-09 — Answered "does it have UI instructions to build software from" — yes for extension/architecture (`CLAUDE.md`), no for visual design system.
- [x] 2026-08-09 — Evaluated InsForge as backend; rejected; extracted 2 patterns; deleted the 110 MB clone.
- [x] 2026-08-09 — Wrote `reference/postgres-tenant-isolation.md`.
- [x] 2026-08-09 — Set up this project-local memory; global memory reduced to a pointer.
- [x] 2026-08-10 — Patched the runtime findings M3 → M2 → M4 → M1.
- [x] 2026-08-10 — Patched the client findings B1, B2; B3 closed by unmounting the legacy UIs.
- [x] 2026-08-10 — Ran `bun install --frozen-lockfile` (devDeps only) so the suite runs.
- [x] 2026-08-10 — Added regression tests for every patched finding.

- [x] 2026-08-11 — Enno ran `git rm -r apps/builder apps/admin` (the classifier refuses it for
  the agent, every time — do not retry it, hand him the command).
- [x] 2026-08-11 — Committed the patch set as `b3526dd` (38 files) and pushed to a new public
  fork, `github.com/en449/openfunnel`. `origin` = the fork, `upstream` = `luispdoesai/openFunnel`.
- [x] 2026-08-11 — Closed the three AGPL obligations in `1064bdf`: full licence text in
  `LICENSE` (§4), modification notice in `README.md` (§5a), and a source link on every funnel
  page (§13).

### Open right now
- [ ] Mirror `HOST`, `MAX_SINK_BYTES` and `MAX_READ_BYTES` into `.env.example`. **Enno's to
  run** — `.env*` is unreadable to the agent through two independent layers (the
  `Read(//**/.env.*)` deny rule and the secrets regex in `guard.sh`), and `.env.example`
  matches both. The paste block is in the Phase 0 list above; the README env block documents
  all three already.

### Planned — SUPERSEDED 2026-08-10 by [PLAN.md](PLAN.md) §10
Kept for the record. The shape decision (done-for-you, not SaaS) reorders this: 6/8/9 became
Phase 1–2, 5/7/11 became an unscheduled Phase 4, 4 was answered (extend `apps/app`, do not
rewrite it), and 10 stays a standing constraint rather than a task.

4. [ ] Decide: extend `apps/app` or build a new frontend against `types.js`.
5. [ ] Add auth + a real user model (currently one shared `ADMIN_TOKEN`).
6. [ ] Move leads/events off JSONL to Postgres via the existing PostgREST seam.
7. [ ] Add tenancy with RLS (see reference doc).
8. [ ] Add asset storage (S3/R2) so funnels can use images/video.
9. [ ] Add a durable delivery queue for webhooks + email.
10. [ ] Then, and only then, revisit horizontal scale (shared OTP store + edge rate limit).
11. [ ] Billing.

### Standing constraints
- Leave `ALLOW_CUSTOM_SCRIPTS` unset. Opting in hashes whatever the *document* carries, not
  what the operator pasted — so importing a funnel becomes console takeover.
- Never run more than one instance until #10 is done.
- Reading an imported funnel JSON before use is still the right habit, but M1 and B1 — the
  two findings that made it mandatory — are fixed.
- `.data/` is a buffer, not an archive: the sinks rotate under load, so anything that must
  be kept gets forwarded (Supabase, webhook) rather than left there.
- AGPL-3.0: a modified version shipped to users obliges offering source.

### Open questions for Enno
All three below were answered on 2026-08-10 — kept so the answers stay attached to the questions.
- ~~Is this actually going ahead?~~ → Yes, as **done-for-you infrastructure**, not a SaaS.
- ~~Own frontend, or reskin `apps/app`?~~ → **Extend `apps/app`.** Ugly and working beats
  rewritten and three weeks away when there is exactly one user, who wrote it.
- ~~Hosted Postgres or self-hosted?~~ → **Self-hosted on the same Hetzner box.** Managed
  Postgres (EU region) is the documented upgrade, triggered by a second box or a failed
  restore test.

Still open → [PLAN.md](PLAN.md) §12. The blocking ones: Phase R placement, the EU mail
provider, the domain strategy, and where the control-plane code lives (a Phase R implementer
must not be inside this repo).

---

## Session Log

### 2026-08-12 (session 6) — The transport lands: Brevo behind a seam, and dead letters reach a person

WO12b and WO13, both on `phase-1-delivery-queue`. Design written into
[PHASE-1-PLAN.md](PHASE-1-PLAN.md) §4.6 and §4.7 before any code, per the Build Workflow.

**WO12b — Brevo.** Filed as a DSGVO gate (Resend is a US processor), but since the deployment it
was also the reason nothing arrived: every attempt ended `no_transport`, so the queue retried
perfectly and delivered nothing. `sendEmail()` no longer knows who the provider is — an
`API_TRANSPORTS` table holds one entry per JSON-API provider (`resend`, `brevo`), each supplying
the key it reads and the request for one message, and `sendEmail` owns the deadline, the abort,
the success test, the error mapping and the logging rule. An addition, not a migration: the Resend
and `SMTP_RELAY_URL` paths are byte-identical in behaviour, and Resend is declared first so an
install carrying only `RESEND_API_KEY` resolves exactly as before. `brevoApiKey` joined
`SECRET_ENV` / `WRITABLE_EMAIL_KEYS` / `SERVER_ONLY_INTEGRATIONS`; the two-way ternary in
`saveEmailSettings` that decided which env var a secret came from became a table, because a third
secret would have made it silently wrong for one of them.

**WO13 — dead-letter alerting.** `drainOnce` collects what died in a pass and sends ONE message
after the loop rather than one per row — alerting inside `settle` would have put an awaited mail
send on the delivery path inside a drain `pg_net` abandons at 55s. Global `notifyEmail` only,
never `notifyEmailFor` (which can resolve a *client's* address, and a dead delivery is the
operator's infrastructure failing), deliberately not gated on `notifyEnabled`, own hourly bucket
(`DEAD_LETTER_MAX_PER_HOUR`, default 10), never throws, and carries no target URL and no secret.

Three test files that drive the drain now blank the mail environment and point `DATA_DIR` at a
path that does not exist — a machine whose environment names a notification address would
otherwise record an extra outbound call in every stub and fail there and nowhere else.

Verified: 235 pass / 1 fail (the known Bun 1.3.13 413-vs-400), typecheck and all three check
scripts green. Both new behaviours red-checked by reverting them and watching the tests fail — the
provider precedence (3 red), the alert itself (2 red), the alert's ceiling (1 red).

**Deployed and self-tested** (`2fbe1a1`). One thing to know before the next deploy: **the branch
alias belongs to the deployment the GitHub integration builds from the push, not to a `npx vercel`
CLI run.** Both happened here, nine seconds apart, and `vercel inspect` on the alias resolved to
the Git one — so the CLI deployment was a second, unaliased preview and the pg_cron drain would
have kept hitting whatever the alias pointed at. Push is the deploy; verify with
`npx vercel inspect <branch-alias>` rather than assuming. On the alias: `/healthz` →
`{"ok":true,"supabase":true}`, the Settings panel offers "Brevo API (EU, recommended)" and reveals
its two fields on select (`screenshots/wo12b-brevo-settings-preview.png`), and `/delivery` renders
and says "This browser has no admin token for this hostname" — correct, the token is per-ORIGIN.

Still Enno's: the Brevo account, the verified sending domain (SPF/DKIM), the signed AVV, and
`BREVO_API_KEY` in the Vercel Preview environment. Until that variable exists the deployed runtime
still answers `no_transport` — the code path is there, the credential is not.

### 2026-08-10 (session 3) — Gate confirmed, spike run, two research tracks landed

Enno confirmed the pre-mortem. **Gate satisfied, building unblocked.** First action was
deliberately not Phase 1 but a spike: the entire plan had been derived from reading code, and
nobody had ever started this server. Written up in [REALITY-CHECK.md](REALITY-CHECK.md).

Three findings that changed the plan:

1. **Google Fonts is worse than §8.2 assumed.** The consent gate only protects a funnel that
   *enables* consent. All four shipped examples carry `consent: {}` — off — so there is no gate to
   fail and the font loads on page view. Loading `/f/agency-landing` cold fired
   `fonts.googleapis.com` + `fonts.gstatic.com` with no bar shown and no consent given. The
   unprotected case is the *default* case. Separately, the default `funnelCsp` pre-authorises both
   Google hosts on every funnel page, including ones that never request them. Both now Phase 1 gates.
2. **Lead loss reproduced, twice.** `WEBHOOK_URL` pointed at an unresolvable host: visitor got
   `202` in 5 ms, funnel looked perfect, forward never happened, nothing retried, and the stored
   record carries **no delivery state** — so reading the sink cannot tell you which leads never
   arrived. Phase 1 ordering confirmed by demonstration rather than argument.
3. **The console is much better than the codebase map suggests.** A working three-pane builder
   with live phone preview, tabbed inspector, piping chips, command palette, zero console errors.
   The rendered `midnight-glass` landing page reads as a real product. This strengthens both
   "extend `apps/app`, don't rewrite" and **keeping Phase R deferred** — the engine and console are
   the strongest parts of the system, not the weakest.

Also verified live: raw IP stored in plaintext in the sink (the hashing requirement closes a real
gap); every audit fix behaves correctly against a running server (`bound: 127.0.0.1`, sinks 0600,
`/_builder` + `/_admin` 404, forged `x-forwarded-for` → 401, SSRF guard refuses); baseline holds at
127 pass / 1 fail with typecheck and both invariant checks clean. New measurement item: a funnel
page pulls 22 unbundled ES module requests, so real-device LCP over 4G decides whether the
no-build-step invariant still pays.

Second research track answered the mail-provider gate →
[reference/eu-mail-providers-2026-08-10.md](reference/eu-mail-providers-2026-08-10.md).
**Brevo recommended** (Paris, OVHcloud FR/DE, self-serve DPA, JSON send API, free tier covers the
volume; caveat: backups touch Google Cloud Belgium, disclose it). Runner-up Scaleway TEM at ~€1/mo
pending one DPA check. Disqualified: rapidmail/CleverReach/mailbox.org (no JSON API),
Mailjet/Mailgun/SendGrid/Postmark (US entity in the mail path). Not a drop-in — `SMTP_RELAY_URL`
posts a fixed `{to, subject, html, text}` body, so an adapter is needed.

Then Enno changed the infrastructure: **GitHub repo → Vercel → Supabase**, not a Hetzner VPS. That
is a real architectural change, not a hosting preference, and PLAN.md §2, §5, §7.1, §8, §9 and the
phases were rewritten for it. What it costs: the `Bun.serve` router must become a request handler
(cheap — route modules already return `Response`); the `setInterval` delivery worker cannot exist,
so it becomes an inline `after()` first attempt plus a `pg_cron`/`pg_net` retry drain; and the
in-process `Map`s for rate limits, OTP and the mail cap break on day one rather than "later",
because serverless is multi-instance by default. All three move to Postgres in Phase 1, which
grew from 2–3 to 3–4 weeks. What it buys: Vercel's Domains API for client custom domains (better
than the Caddy design), Supabase Storage with URL transformations (no image library on serverless),
and PITR backups (kills the untested-`pg_dump` risk). Console access becomes a second Vercel
project behind Vercel Authentication — still zero auth code, and the public project has no admin
code deployed to it at all.

**The DSGVO trade was put to Enno explicitly and he accepted it** (PLAN.md §8.0): Vercel Inc. and
Supabase Inc. are US companies in EU regions, lawful under DPAs + SCCs + a TIA, but the
"Hosting in Deutschland, kein US-Anbieter" wedge is withdrawn — that was one of the four stated
reasons to build rather than rent, and it is now table stakes instead. What survives is narrower:
own AVV per client, no Google Fonts, no unnecessary third party on the funnel page, a working
deletion path.

Server stopped, port free. **Nothing built, nothing installed, no commits.**

### 2026-08-10 (session 2) — Product plan written (Opus 5 inline, Sonnet 5 research)

Enno asked for a plan to build software out of this: backend, features, integrations, user
setup, admin access. Explicitly decoupled from the 30-day sprint, the web dev business and JV
brokering — this runs parallel to those and inherits none of their plans.

Pre-mortem gate ran first (mandatory, CLAUDE.md). Nine failure modes. The rankings that
mattered: most *probable* was building instead of selling; most *dangerous* was PII liability
landing on a natural person, with the AGPL trap second because it is retroactive. The biggest
pre-assumption was that this should be a self-serve SaaS at all — and Enno's answer removed it:
**done-for-you, one operator**. The pre-mortem was then revised, since its Phase 0 validation
steps and half its kill switches were built on agency pitch counts that no longer apply.

A Sonnet research agent ran in parallel on Perspective.co and the category
(`scratchpad/research-perspective.md`). Two findings changed the plan rather than decorating
it: **German Handwerk software (STREIT, HERO, mfr, Smarthandwerk, TAIFUN) has no confirmed
public API** — which deletes the entire vertical-CRM integration workstream in favour of
email/webhook/Sheets/Zapier — and **"DSGVO-konform, Hosting in Deutschland" is used as an
explicit selling point by every German player except Perspective**, which only carries a
generic "GDPR-Compliant" bullet.

Enno then added that everything must be DSGVO-conform. That was upgraded from a section to a
binding constraint with phase-blocking gates. Two of them change existing code: all eight theme
presets hotlink Google Fonts (consent-gated, but LG München I 3 O 17493/20 makes this the
highest-frequency German complaint — self-host instead), and Resend is a US processor so it
cannot be the default lead-notification path.

Deliverable: [PLAN.md](PLAN.md). Nothing built, nothing installed, no commits. The plan is
**awaiting Enno's explicit go** — the pre-mortem gate is not satisfied without it.

One recommendation recorded against Enno's stated choice, for the record: he picked a
clean-room engine rewrite, and the plan carries it as Phase R but **deferred** rather than
first. Reasoning in PLAN.md §11 — under a DFY shape the AGPL obligation is dischargeable in
about an hour by publishing the fork, the engine is the only part that already works and has
been audited, and a rewrite by someone who has just spent two days inside the source is not
clean-room unless the specifier and the implementer are actually separated.

### 2026-08-10 — Patched every audit finding (Opus 5 inline, Sonnet 5 reviewer + qa)
Enno picked "patch the security findings" over the other three options (run it locally,
build the SaaS, use it for one real funnel). No pre-mortem gate: this is bounded bug-fixing
against an existing diagnosis, not a new build.

Worked the planned order M3 → M2 → M4 → M1, then B1 → B2 → B3, inline rather than delegated
— the fixes are small but each one is a security boundary, and the audit had already done
the expensive part (locating them). Two shared helpers came out of it, `richText()` and
`embedUrl()` in `dom.js`, because B2 existed twice: `blocks.js` and `landing.js` each
carried their own copy of the same unanchored regex, which is how one of them would have
been fixed and the other forgotten.

The M4 default changed behaviour deliberately: the server now binds `127.0.0.1` instead of
every interface. A container or proxy deploy needs `HOST=0.0.0.0` set explicitly. That is a
real break for anyone who was relying on the old default, and it is the point — the old
default handed a token-less console to the local network.

`bun install` was run for the first time (devDeps only, `--frozen-lockfile`), because the
engine tests need `happy-dom` and there was no way to verify the B1/B2 fixes without it.

Deletion of `apps/builder` / `apps/admin` was blocked by the permission classifier, so the
routes were unmounted instead and the directories left for Enno to remove by hand. B3 is
unreachable either way; the files are just dead weight until then.

The `code-reviewer` / `qa` pair ran twice. Round one came back **FAIL** on a genuine
Critical — the tab/newline URL bypass above, which my own tests had asserted around rather
than at. Worth remembering as evidence the reviewer step earns its keep on security work:
the first patch set looked correct, passed its own tests, and was bypassable by one
character. Round two passed both agents clean.

### 2026-08-09 — Audit, clone, backend evaluation (Opus 5 orchestrating, Sonnet 5 + Opus 5 subagents)
Enno asked for a security audit of `luispdoesai/openFunnel`, a copy into
`AI Stuff/OpenFunnel` if safe, then had follow-up questions. Three agents ran in parallel:
Sonnet on the malware/supply-chain sweep, Sonnet on the browser code, Opus on the runtime
server. Verdict clean → cloned.

Then: *"does it have UI instructions if I'd want to build software out of this?"* → yes as
an extension manual (`CLAUDE.md` `Common tasks` recipes, `Known gaps` list, path-addressed
inspector), no as a design system; console is a reference implementation, not a foundation.

Then: *"would this repo help build the backend"* re `InsForge/InsForge` → cloned it, ran a
Sonnet capability inventory, answered: partially, for auth + Postgres + storage, but not as
"the backend".

Then Enno pushed harder — *"the backend would need to be bullet proof"* — and asked for a
straight yes/no. Answer: **no**, with the four grounds in the Decision Log, plus the point
that bulletproofing here is mostly not a component-selection problem: M1, B1, M2 and the
missing durable delivery stay yours regardless of backend.

Enno: *"grab the things you'd like to grab and leave the rest."* → extracted the RLS tenant
isolation pattern and the HTTP retry-safety classification into `reference/`, deleted the
110 MB InsForge clone.

Enno then asked for this project-local memory file, with global memory reduced to a
reference pointer so it doesn't load every session.

Note: `AGENT_STATE.md` had been written by a parallel session the same day (config audit vs
`claude-code-best-practice`); that entry was demoted rather than overwritten, and the
Higgsfield block collapsed to a memory pointer to keep the file to one screen.

**Nothing installed. Nothing run. No commits made anywhere.**
