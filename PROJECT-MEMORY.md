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

### 2026-08-13 (session 9) — the checklist told the truth, and two gates closed behind it

Two pieces of work, in that order, both inside Free tier.

**PLAN.md §10 Phase 1, re-ticked against the code** (`d96b7b6`, docs only). Nine shipped items were
still unticked. More useful than the ticks: six lines describe something that shipped in a different
shape than they asked for, and now say so — the router port also passes `waitUntil` in, rate limits
kept the in-process bucket as a fallback while OTP fails closed, loopback trust was made unreachable
off Bun rather than removed, migrations carry a commented rollback block rather than a runnable down,
only leads are transactional with their delivery rows (events have no targets), and the inline first
attempt has no abort polling because `supportsCancellation` is deliberately off. Two lines were
part-shipped and split rather than ticked: Google Sheets as a delivery target was never built, and
the Brevo gate was half closed.

**Then the two gates that were cheap and genuinely open.**

*Resend off the default path.* The adapter has been live since session 6, but `resend` was the first
entry in `API_TRANSPORTS` — and that table's order IS the default path, so an install with both keys
and no `EMAIL_PROVIDER` still sent a German client's leads through a US processor. Brevo leads now.
The trap worth remembering: the decision has **two halves**, the table order and the inference chain
in `getEmailSettings`, and reverting only the chain in the red-check was enough to turn the test red
— so a future edit that flips one and not the other would have the warning naming one provider while
another sends. An install with only `RESEND_API_KEY` is untouched; Resend stays supported.

*No raw IP anywhere.* The lead column has been a salted hash since WO4, which is what made this look
done. It was not, and the gap was not where the reality-check had recorded it — the address was in
**four** other places, one of which was not a store at all but an egress:

- **The direct fan-out's webhook posted the whole record**, `ip` / `referer` / `user_agent` included,
  to the operator's CRM. The queue path had stripped them since WO5 and `forwardWebhook` never did,
  so the one path that runs on every install *without* a database — the self-hoster's entire
  deployment — was shipping the field the rest of the system hashes, to a third party, in the clear.
  Caught by the reviewer, not by me: I had traced the datum to every *store* and stopped there.
  There is one stripper now, `outboundPayload()` in `lib/webhook.js`, called by both paths, because
  the fan-out is what the queue degrades to and two copies of that field list would drift.

And three stores:

- `.data/*.jsonl`, written from the record verbatim. That is the only lead store a deployment with
  no database has, so the "we hash the IP" claim was false for exactly the self-hoster it mattered
  to. Stripped in `persist()`, not at the call site: `record.ip` still has an in-process consumer in
  the opt-in Meta CAPI forward.
- `rate_bucket.key` in Postgres. Every per-IP and per-address ceiling puts its subject in the key —
  `ingest:<ip>`, `otp-send:<email>` — and WO9 moved those buckets out of a heap and into a table
  without anyone noticing that the key had become durable personal data. `rateLimit` now hashes on
  the way out. Nothing ever reads a key back, so the digest costs the limiter nothing. The salt
  policy differs from the lead column on purpose: no salt degrades to an unsalted digest rather than
  storing nothing, because a bucket that is not written is a ceiling that does not bind.
- The console's lead drawer, which printed `lead.ip || "127.0.0.1"` — so the moment the stores went
  clean it started displaying a **fabricated** address in a panel labelled raw metadata.

Two smaller things went with it: `readJsonlRecords` strips `ip` on the way out too, so a sink written
before today stops feeding addresses to the admin readers without rewriting a file the operator may
be tailing; and the provider default stopped being two facts in two places — `getEmailSettings` now
derives its order from `Object.keys(API_TRANSPORTS)` instead of re-listing it in a ternary.

The general lesson, and it is the same shape as session 8's fifth font hotlink: **a privacy claim
written about one store is a claim about one store.** Grep for the datum, not for the control. The
reviewer found the egress leak precisely because it was told the goal ("no raw IP written anywhere")
rather than the diff.

**Named and left:** two paths still print a raw email address to the server log — the `logged`
transport's `console.log` in `lib/email.js`, and the `unverified lead claimed email_verified`
warning in `routes/ingest.js`, which exists to surface a client lying about verification. Neither is
new and "nothing logs a raw email" is not an invariant here today; if it becomes one, those two are
the sites. Written down so the next reader knows it was seen, not missed.

Red-checked every fix by reverting it and watching the exact new assertion fail: raw record to the
sink, plain key to `rate_hit`, the inference chain back to Resend-first, the raw record to
`forwardWebhook`, the unstripped read path, and a `SECRET_ENV` key renamed so the transport table
drifts from it — and, for the email derivation, by inserting a bogus first entry in
`API_TRANSPORTS` and confirming the inference followed the table. Reviewer round 1
FAIL (the egress leak) → fixed → round 2. qa PASS both rounds: 244 pass / 1 fail (the known Bun
1.3.13 413-vs-400), typecheck and all three check scripts green, plus a production-mode run that
submitted a synthetic lead and confirmed the written record carries neither an `ip` field nor the
address.

### 2026-08-12 (session 8) — the DSGVO font gate, and the reason it does not reach everyone yet

The phase-exit gate from PLAN.md §8.2: self-host the preset fonts, delete the Google Fonts path,
strip both hosts from `funnelCsp`. Design written to [PHASE-1-PLAN.md](PHASE-1-PLAN.md) §4.9 first,
two work orders — G1 (Sonnet: fetch the fonts, write the generator) and G2 (Opus: the consent gate,
the CSP, the deletions).

**The gate as written was one leak short.** It named the engine's `theme.font` loader. It did not
name `apps/app/index.html`, which loaded Inter and JetBrains Mono from Google for the operator
console with two `preconnect`s in front of them. Same transfer, different file. Closed in the same
change and the widening flagged rather than done quietly.

**Deleted rather than repointed.** `loadThemeFont`, `ensureGoogleFontLoaded`, `remoteFontFamily`,
`LOCAL_FAMILIES` and the `allowRemote` option are gone, along with the `loadThemeFont()` call in
`_grantConsent()`. Keeping the consent gate around a now-same-origin request would have left a
comment in the code claiming to protect something it no longer protects. `theme.font` naming a
family the page does not have now falls down the CSS stack to a system font — no request, no 404.

The four consent tests changed shape, not just content: they used to assert "a Google link appears
only after accept" and now assert **no external stylesheet is created on any consent path**, matched
by shape (`^(https?:)?//`) rather than by hostname. A loader re-introduced against a different CDN
fails them too. Red-checked: re-inserting a `<link>` in `applyTheme` fails all four.

`scripts/check-engine-imports.mjs` grew a second half — it now resolves `url()` targets in engine
CSS and fails on both off-origin and missing files. A wrong `url()` in an `@font-face` does not
throw, it silently renders a system font, which is precisely the invisible-404 class that script
already existed for. Red-checked both directions, and `stripComments` runs first so a comment
documenting the old URL cannot fail CI.

Reviewer round 1 came back **FAIL** on one Major: `packages/engine/types/index.d.ts` still told
consumers the consent decision gated the webfont. That file was named in §4.9's own work-order
table and I had not touched it. Fixed, plus two of its three Minors (the comment-stripping above,
and a `funnelCsp` assertion that no font host is pre-authorised — red-checked by restoring the old
policy string). The third is recorded in `packages/engine/src/fonts/README.md`: `styles.css` asks
for weights up to 850, past the top of Space Grotesk's axis (700), so a variable font clamps. Same
result the old Google request produced; written down so it does not read as a bug later.

**What the live self-test found — [PHASE-1-PLAN.md](PHASE-1-PLAN.md) §4.9.1.** A cold load is
clean: zero third-party requests bar Vercel's own preview toolbar, the WOFF2 comes from our origin,
`document.fonts` reports the family loaded. A **warm** load on the same alias still fired the exact
Google URL the change deleted — from the browser's cache, because `serveEngine` sends
`immutable, max-age=31536000` on URLs that carry no version. The deployed bytes are correct (a
`cache: "reload"` fetch of `/_of/theme.js` has neither `googleapis` nor `loadThemeFont`); the
visitor's copy is not. Pre-existing, not font-specific, and it means **no** engine change reaches a
returning visitor. Logged as a PLAN.md task with the design (a versioned path segment, not a query
string — relative sibling imports do not inherit a query) rather than fixed inside a font commit,
because the fix interpolates into `FUNNEL_BOOT_SCRIPT`, whose bytes the CSP hashes.

Verified: 237 pass / 1 fail (the known Bun 413-vs-400), typecheck, all three check scripts, CI, and
a live self-test on the branch alias with screenshots in `screenshots/`. One toast on the console
screenshot — "Could not open agency-landing" — is a 401 from `/api/builder/funnel/*` on an origin
that holds no admin token, not a regression.

### 2026-08-12 (session 8b) — the engine path is versioned, so a fix now reaches a returning visitor

Straight continuation of what the font gate's self-test found. `serveEngine` sent
`max-age=31536000, immutable` on URLs with no version, so the browser kept last deploy's engine for
a year. Engine URLs now carry `/_of/v-<12 hex>/`, and — the part that is actually the fix — the
cache header follows the **URL shape** rather than `DEV`: unversioned gets `no-cache`.

Three things worth carrying:

- **A path segment, not `?v=`.** Engine modules import their siblings relatively, so a query on the
  entry point never reaches `./theme.js` — which is the exact module that stayed stale.
- **The version must be per-DEPLOY, not per-process.** A serverless deploy is many instances; a
  per-process value changes the URL on every cold start and buys no caching at all. Chain is
  `ENGINE_VERSION` → `VERCEL_DEPLOYMENT_ID` → `VERCEL_GIT_COMMIT_SHA` → `VERCEL_URL` → `Date.now()`,
  and reaching the floor **warns once in production** — the reviewer's Major, and correctly raised:
  the symptom is otherwise silent, because nothing breaks, the caching simply never happens.
  Measured live: the served segment is `sha256(VERCEL_DEPLOYMENT_ID).slice(0,12)`, so this project
  is on the good branch.
- **`FUNNEL_BOOT_SCRIPT` now interpolates**, which CLAUDE.md forbade. The rule is restated as
  "nothing that varies *within* a deploy": `ENGINE_BASE` resolves once at import, so the hash covers
  the bytes every page serves. qa verified the CSP `sha256-` against the served script byte for byte.

The production-mode test spawn is the point worth copying: DEV caches nothing, so a test against the
default server passes either way — which is precisely how the original bug survived every local run.
Reviewer PASS (containment holds: `isInside` runs on the resolved absolute path and never sees the
stripped prefix), qa PASS, CI green, warm load on the failing browser now clean.

### 2026-08-12 (session 7) — WO14: the tests were already there, and nothing ran them

The work order read "tests: state machine (claim/lease/sweep/dead), dedupe, rate window,
cancelled-on-restrict". Reading before writing found all of it already in the tree:
`supabase/tests/state-machine.sql` is 55 assertions covering every item on that line, plus
`otp.sql` (19) and `targets.sql` (22). They shipped with WO1 in `f882a2c` and the work order
stayed open behind them. Design for the corrected scope written into
[PHASE-1-PLAN.md](PHASE-1-PLAN.md) §4.8 before any code, per the Build Workflow.

**The rot was measurable, not theoretical.** The local `of_dev` cluster was two migrations behind
— no `otp` functions, no `delivery_target.source` — so every schema change since 2026-08-11 had
landed without these files running once. A `postgrest` process from 2026-08-11 17:29 was still
holding a connection to it. Rebuilt from the four migrations, all three files pass, and
`supabase/tests/db-integration.mjs` passes against a real PostgREST too. The assertions were
honest all along; they were invisible.

**So WO14 became a runner and a CI job, not a test suite.** `scripts/db-test.sh` owns a database
named `of_test` and refuses every other name — it applies migrations, and applying migrations to a
database the Supabase CLI manages breaks the ledger exactly the way the SQL editor does. `bun test`
stays Postgres-free; the assertions get their own CI job on a `postgres:17` service container.

**A suite built on `assert` needs a tripwire.** `plpgsql.check_asserts` is a session GUC, and with
it off every assertion in all three files is a no-op while each still prints
`all assertions passed` and exits 0. Measured, not inferred. The runner's first act is now a
deliberately failing assertion of its own — and it requires the assertion's own *message*, because
psql also exits non-zero for an unreachable host or a missing database, so the first version
printed "tripwire ok — assertions are checked" for a run that had not connected at all.

**Three holes closed, each one a branch that could be deleted from a migration with every existing
assertion still passing:** the `deleted_at` half of `cancel_pending_on_restrict` (soft-delete must
cancel pending rows, and only the claim-time join was covering it); `ingest_lead` on a funnel with
no enabled target (`queued = 0` with a real lead id — the `queueOwnsIt` bug class, pinned in SQL
for the first time); and `for update of d skip locked`, which no single-session test can see at all
— the file's second claim returns 0 because the row is `delivering`, which `status = 'pending'`
alone would produce. It lives in the runner, which is the only place with two connections.

**Two rounds of review, both FAIL, both on real findings — all in the runner, none in the SQL.**
Round 1: the `${...%/*}` URL splicing broke on a server URL with no dbname
(`postgres://postgres@host:5432` became `postgres://of_test`) and on a trailing slash; the
connection URL was echoed, which is this repo's own never-log-a-DSN rule applied to a test script;
and under `set -e` a failed command substitution exited before `wait`, orphaning a psql session
still holding a row lock. Round 2 caught that the fix's credential mask only masks a *URI* — psql
accepts libpq's keyword/value form just as readily, so `host=… password=… dbname=…` was printed
verbatim on the refusal path. The refusal now prints no value at all: a message does not need the
secret to be useful.

Every fix red-checked by breaking the thing it defends: the trigger branch, `ingest_lead`'s count,
`skip locked` removed from `claim_deliveries` (session B blocks at 4008ms against a 1000ms
ceiling; 36ms when it is present), the tripwire against an unreachable host, and session B pointed
at a function that does not exist. Migrations byte-identical to HEAD afterwards each time.

**One timing bug was mine to catch rather than the reviewer's.** The first `skip locked` check had
session A hold for 3s, B start at 1s and be judged against 2000ms — so a *blocked* B came back at
2006ms. Six milliseconds of margin. A `sleep 1` overshooting on a loaded runner would have passed a
`claim_deliveries` with no `SKIP LOCKED` as healthy, which is the one outcome the check exists to
prevent. A holds 5s now and B is judged against 1000ms.

Verified: 236 pass / 1 fail (the known Bun 1.3.13 413-vs-400), typecheck and all three check
scripts green, and the runner green across 20+ consecutive runs. One non-reproducing failure was
reported by an executor mid-development (`expected 2 delivery rows, got 1` in two files at once)
and did not recur in any run against the final script; noted rather than hidden.

**Then the new CI job found something none of the local runs could.** CI had never run on this
branch at all — the workflow triggers on pushes to `main` and on pull requests, so a feature branch
runs nothing, and the last run of any kind was 2026-08-10 on `main`. Dispatched by hand
(`gh workflow run CI --repo en449/openfunnel --ref phase-1-delivery-queue`), the new
`db-assertions` job passed — which is also what proves `psql` is on `ubuntu-latest` and the service
container's health check works — while `test + typecheck` came back **219 pass / 18 fail on a commit
that is 236 / 1 locally**, every failure carrying `ReferenceError: localStorage is not defined`.

Nothing was wrong with the code under test. **Each engine test file carried its own `beforeAll`
guarded by `if (globalThis.document) return;`, and each installed a different subset of globals.**
Bun runs the files in one process, so the first file to reach its `beforeAll` won and every later
file skipped its own setup — including the parts the winner never installed. `sanitize.test.js`
sets four globals; `consent`, `render` and `landing` need eleven. Local file order put a complete
file first; the runner's put `sanitize` first. The suite's colour was a function of file order, and
had been since those files were written — `main` is green only because it drew a lucky order.

Reproducible in one command, which is also the red-check:
`bun test packages/engine/test/sanitize.test.js packages/engine/test/consent.test.js` — red before,
green after, green in either order. Fixed at the shared cause in `6e092ff`: one
`packages/engine/test/dom-setup.js` the four files import, installing the union. Patching
`sanitize.test.js` alone would have left the guard meaning "the first file wins", so the next file
added with a partial set brings it straight back. 60 lines of duplicated setup deleted, 11 added.
CI then went green on all three jobs. Generalised in [[feedback_order_dependent_test_setup]].

**Worth knowing before the next live test.** `POST /api/admin/targets/sync` cannot give `fitness`,
`agency-landing` or `real-estate` delivery targets: `syncAllFunnelTargets()` selects from the
`funnel` table, so a funnel existing only as `examples/*.json` is invisible to it. The row has to
be created first (`saveFunnel` does it and syncs in the same call) — and a row is still not a
target, because `deriveTargets` returns nothing without a webhook URL or a notification address,
and `NOTIFY_EMAIL` is unset.

Still Enno's, unchanged: `BREVO_FROM` on a verified sending domain, `NOTIFY_EMAIL`, the signed AVV,
whether to merge this branch into `main`, and the `dub1` function region.

**Next is the phase-exit DSGVO gate**, flagged and deliberately not started: self-host the eight
preset fonts, delete the Google Fonts path in `packages/engine/src/theme.js`, and strip
`fonts.googleapis.com` / `fonts.gstatic.com` from the default `funnelCsp`.

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

**Then the key went in and the transport answered.** `BREVO_API_KEY` was first uploaded as
`Brevo_API_KEY`, which on Linux is a different variable and resolved to `undefined` — worth knowing
because nothing about it looks wrong in the Vercel UI. Re-added correctly,
`npx vercel redeploy <alias-holder>` applied it (a redeploy keeps the branch alias; a fresh
`npx vercel` does not), and a synthetic lead through `/api/lead` on the alias answered 202 and
produced, in the runtime log, the first real provider response this project has ever had:

```
[email] brevo error: 401 {"code":"unauthorized","message":"We have detected you are using an
unrecognised IP address 54.197.4.33 …"}
```

`no_transport` is gone. The seam, the key, the headers and the body shape are all correct — Brevo
is refusing on its **authorised IPs** setting, which cannot be satisfied by allowlisting because a
serverless function's egress address changes per invocation. It has to be turned OFF at
app.brevo.com/security/authorised_ips. Generalised in [[feedback_brevo_authorised_ips]].

**That log line also dated the DSGVO question.** 54.197.4.33 is AWS `us-east-1` — the function
region is `iad1`, so the runtime that receives and hashes lead PII currently executes in Virginia
before anything reaches Supabase in Ireland or Brevo in France. PLAN.md §8.0's argument was about
the vendors being US *companies*; this is the processing *location*, which is a separate and
weaker position. Setting `regions: ["dub1"]` was filed as a latency choice and is now also the
DSGVO one.

Also visible and expected: `cannot create /var/task/.data (ENOENT) — the JSONL sinks are off`. The
read-only filesystem, named in §4.2 as known and deliberately not fixed. Leads are in Postgres;
the console's JSONL lead inbox reads empty on Vercel.

**Mail works. Proven end to end, same session.** Enno first authorised the refused address, then
the next one; the deciding measurement was six `/api/otp/send` calls fired in the same second —
three warm instances came back 200 on the authorised address, three cold ones were refused with
three *new* addresses at once (`98.92.148.107`, `54.211.126.166`, `98.83.164.192`). Seven distinct
`us-east-1` egress addresses inside the hour. It is not a restart or a region change that breaks an
allowlist here — two simultaneous visitors do. Enno then deactivated the restriction, and the same
six parallel sends came back clean; the queued `lead-gen` lead drained across `15:57` and `15:58`
with no warning logged, which under this code means the sends succeeded. Brevo also **accepted**
mail from the unverified `leads@openfunnel.dev` rather than refusing it — so `BREVO_FROM` is a
deliverability problem (no SPF/DKIM alignment, spam folder) and not the 400 predicted above.

One gap surfaced by the same test: only `lead-gen` exists in the `funnel` table. `fitness`,
`agency-landing` and `real-estate` answer `PT404` from `ingest_lead` and fall through to the direct
fan-out, so they have no `delivery_target` rows at all — run `POST /api/admin/targets/sync` before
WO14 or half the fixtures never touch the queue.

DSGVO, asked and answered in-session: a US egress IP is not by itself unlawful. Vercel states DPF
certification and additionally relies on SCC + UK Addendum, so the transfer has a basis — but the
legacy `privacyshield.gov` record for Vercel Inc. still reads `Inactive - Lapse` (that is the old
Privacy Shield entry, not the DPF one; the DPF list is a JS app that cannot be fetched), so the
listing wants verifying before anyone leans on adequacy. The binding blocker is not the region at
all: Art. 28 needs an AVV, Vercel's DPA is Pro-only and Hobby's ToS is non-commercial, so real
leads on Hobby fail regardless of where the function runs. `dub1`/`fra1` removes the third-country
transfer from the runtime path; platform logs stay US-side either way, so nothing should log lead
PII. Generalised in [[feedback_vercel_function_region_us_default]].

Still Enno's: `BREVO_FROM` (verified sending domain), `NOTIFY_EMAIL` (unset, so WO13's dead-letter
alert still has nobody to mail), the signed AVV, and the `dub1` region.

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
