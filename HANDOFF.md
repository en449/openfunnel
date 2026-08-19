# OpenFunnel — Handoff

> Updated 2026-08-20. **Start here** when the next session is about OpenFunnel, then open
> `PHASE-2-PLAN.md` §4. This file is the short version; the long records are
> `PROJECT-MEMORY.md` (history + decision log) and `PLAN.md` (architecture, DSGVO §8, phases).
> Replace this file's "State" and "Next" sections when they stop being true — do not stack entries.

## State (2026-08-20)

Branch `phase-1-delivery-queue`, head `d153a51`, pushed, clean tree. `main` untouched —
merging is Enno's call. **Seven of the eight migrations are applied to the live Supabase
project.** The eighth is D3's and exists only in git — see below.

Done: Phase 1 complete. Phase 2 §1 asset upload, §2 custom domains, §3 the client report link
`/r/:token`. Phase 2 §4: **D1, D2 and D3** (`fa009da`, `7dc3bb9`, `d153a51`).

- **D1** — `legal` on the funnel document (`impressumUrl`, `privacyUrl`, optional label
  overrides); the engine renders both as footer links on every step, before the AGPL source
  link, not suppressed by `branding.hidden`. `consent.policyUrl` still wins when set but now
  falls back to `legal.privacyUrl`, so there is one canonical privacy URL rather than two that
  can disagree. Console fields in Settings. Live self-tested, `screenshots/d1-legal-footer-*.png`.
- **D2** — the serve-time gate. `/f/:slug` and `GET /api/funnels/:slug` answer **503** when
  `legal.impressumUrl`/`legal.privacyUrl` is missing or unparseable, or the owning client's
  `avv_signed_at` is null. Binds only when `dbConfigured()`; the AVV half binds only for a
  document that came from the `funnel` table. The 503 names no reason — the console does, on
  the funnel card and in a banner over the builder, fed by `GET /api/admin/funnel-gates`.
- **D3** — `subject_matches` / `find_subject` / `erase_subject` plus an
  `event (funnel_id, session_id)` index, in
  `supabase/migrations/20260819100000_subject_rights.sql`. 21 scenarios / 67 assertions in
  `supabase/tests/subject-rights.sql`, green under `scripts/db-test.sh` with the
  `check_asserts` tripwire active. Reviewer PASS on the third pass; the first two each found a
  real bug, both recorded below.

### The three things a next session most needs to know

1. **D3's migration is NOT applied to the live project.** `supabase db push` is the next
   database action and it needs Enno's confirmation. Until then `find_subject` and
   `erase_subject` do not exist on the live database, so D4's endpoints would answer errors.
   `supabase migration list --linked` will show local ahead by one.
2. **D2 could not verify one thing against live Supabase:** the PostgREST embed reading
   `avv_signed_at` (`select=…,client(avv_signed_at)` in `loadFromDb`). It is the same form as
   `report.js`'s `TOKEN_SELECT`, which is live and self-tested, but this change was exercised
   only against a stub — an agent cannot source `.env` (`~/.claude/settings.json` denies
   `Read(//**/.env.*)`, and that blocks the shell read too). Confirm it on the first live run:
   a failed embed makes `loadFromDb` catch, return null, and fall back to disk silently.
3. **Three of the four `examples/*.json` will 503 on the live deployment** until they gain a
   `legal` block. `lead-gen.json` has one. That is the gate working, and it will look like a bug
   the first time it is seen.

### Two D2 decisions that will otherwise be re-litigated

The funnel LIST (`GET /api/funnels`) is deliberately NOT gated: it returns a directory and never
a document, and the console's grid is drawn from it, so filtering would hide the very funnel the
operator has to go fix. And a disk funnel on a db-configured deployment is still gated on the
LEGAL half — only the AVV half needs a client row — which is why `examples/lead-gen.json` gained
one.

### D3's two review findings, because both would be re-derived wrongly

A `sessionId` is minted per mounted funnel, **not per human**, and `event` has no lead foreign
key — `payload->>'sessionId'` is the only join there is. That cut both ways, and code review
found each by running the code against a live schema rather than reasoning about it:

- **Two people can share one session** (a tablet on a trade-fair stand, a kiosk reset between
  visitors), so erasing one deleted the other's whole event trail. The deletion is KEPT
  deliberately — the trail is partly about the person who asked, nothing in the data can split
  it, and a stranger's behavioural event is not worth failing an Art. 17 request over. Doing it
  quietly was the bug, so it is counted into `erase_subject`'s `shared_sessions`.
- **One person can have two leads on one session** — a resubmit after `dedupeKey()`'s 10-minute
  window rolls over. That made `find_subject` report a stranger where `erase_subject`, which
  excludes its own targets, correctly reported none. So `session_shared` carries
  `not subject_matches(o.payload, p_needle)`, the condition that makes it the same question
  `shared_sessions` asks.

**`deleted_at` is deliberately not consulted on either side**: a lead erased by an earlier
request still means a second visitor used that session. Do not "fix" either side to match the
other without reading both comments — an earlier version of one comment said "NON-erased", which
implied a `deleted_at` filter that is not there and would have caused exactly that.

Also from D3, and generalised into Claude memory: a `count = N` assertion pins nothing without a
zero case beside it. `shared_sessions = 1` on a genuinely shared fixture passes just as happily
when the subquery self-matches and reports every session as shared.

Not started: **D4–D8**. Enno authorised the whole D1–D8 scope on 2026-08-17.

## Next: D4–D8, in this order

| # | Work order | Tier | Notes |
| --- | --- | --- | --- |
| D4 | `GET\|DELETE /api/admin/subjects` + the console Subjects view | Sonnet | depends on D3 being APPLIED to the live database; decisions already made, below |
| D5 | Retention purge via `pg_cron`: events 90d, leads per `client.retention_months`, hard-delete soft-deleted rows past 24h, logged run | Opus | depends on D3. It is what completes Art. 17 — `erase_subject` only soft-deletes |
| D6 | Consent bar: equal prominence, a withdrawal affordance, `consent.textVersion` onto `lead.consent` | Sonnet | — |
| D7 | Datenschutzerklärung module generated from the funnel's own configuration | Sonnet | depends on D1 |
| D8 | Docs: CLAUDE.md invariants, PLAN.md §10 lines, Löschkonzept + breach runbook one-pagers | Sonnet | last |

Build Workflow applies per work order: write → `code-reviewer` + `qa` in parallel
(`run_in_background: true`) → parent applies the fixes → re-run if non-trivial. Done means
reviewer PASS, qa PASS, and for anything visitor-facing a live self-test with a screenshot.
On D1–D3 the reviewer found a real bug on five of six passes — do not treat it as a formality.

### D4 — the decisions already made, so they are not re-made

A fuller work order is preserved at `.tmp/WO-D4.md` (gitignored). The load-bearing parts:

- `GET /api/admin/subjects?client=<uuid>&q=<needle>` returns the `find_subject` rows with
  `cache-control: no-store`. `DELETE /api/admin/subjects` with `{ client, q, confirm }` returns
  the `erase_subject` receipt, and **the server requires `confirm` to equal `q` exactly**,
  answering 400 otherwise — so a mis-wired console button cannot delete on click.
- Both live in `routes/admin.js`, privileged by where they live. `dbConfigured()` false → 503.
- **The needle never reaches a log line** — it is a named person's email or phone number. Log the
  client id and the counts only, per the `errSummary` convention.
- No separate export endpoint: the console downloads what the GET already returned. A second
  server surface returning the same personal data is a second thing to secure.
- The console shows the receipt IN FULL — `leads_without_session` and `shared_sessions` each with
  one line saying what it means, plus the 24h soft-delete window and that backups sit outside it
  (PLAN.md §8.7). An operator writing a statutory reply has to read the truth off that screen.
- Show the flags, never filter on them: `find_subject` returns soft-deleted, restricted and spam
  rows on purpose, because the data subject is entitled to know a record exists and is restricted.

## Environment facts that cost time when forgotten

- **Local Postgres for SQL tests:** six assertion files now, `subject-rights.sql` being the
  largest. The throwaway cluster needs a short socket path —
  `initdb` + `pg_ctl -o "-k /tmp/ofpg -h 127.0.0.1 -p 54399"`. The default socket dir is too long
  and the cluster refuses to start. `scripts/db-test.sh` owns a database named `of_test` and
  refuses every other name.
- **Verifying a deployment means running the runtime LOCALLY against live Supabase.** The Vercel
  preview is behind SSO and answers 302 to everything without the bypass header. Source `.env`
  (never print it), `bun run apps/runtime/server.js` on a spare port, curl + browser-harness against
  `127.0.0.1`, screenshot into `screenshots/`, then **kill the server** and revoke any credential
  the test minted — `page_info()` puts a URL, and therefore a token, into the transcript.
- Local `bun` is 1.3.13 against the pinned 1.3.14, which is the one expected test failure
  (`refuses an oversized body`, 413-vs-400). **Do not `bun upgrade`** — five workspace projects
  share that binary.
- **Check CI after any push touching `supabase/`.** The SQL job runs against a bare Postgres with
  no `storage` schema; it was red for two commits once with two green jobs beside it.
- Migrations go through `supabase db push` only, never the Supabase SQL editor. The CLI **is**
  authenticated.
- `npx vercel` for previews, never `--prod`. Free tiers, so **synthetic test data only** and the
  console never on a production domain.

## User-owned, blocking nothing here

- `.env.example` — an agent cannot edit it (`~/.claude/settings.json:45` denies
  `Read(//**/.env.*)`, which matches the checked-in template, and the deny blocks Edit too).
  `REPORT_LANG`, `REPORT_TZ`, `REPORT_TTL_DAYS` still need adding by hand; the values are in
  `PHASE-2-PLAN.md` §3.
- `NOTIFY_EMAIL` unset, so the dead-letter alert has nobody to mail. `BREVO_FROM` on a verified
  sending domain. The signed AVV. Merge to `main`. The `dub1` function region.
- Supabase Pro + Vercel Pro — they gate the two remaining Phase 1 "Done means" items (a PITR
  restore test, an off-platform uptime monitor) and the DPA/SCC/TIA phase-exit item.
