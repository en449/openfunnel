# OpenFunnel — Handoff

> Updated 2026-08-21. **Start here** when the next session is about OpenFunnel, then open
> `TASK-HANDOFF.md` for what is still open. This file is the short version of what is DONE and
> why it is shaped the way it is; the long records are `PROJECT-MEMORY.md` (history + decision
> log) and `PLAN.md` (architecture, DSGVO §8, phases).
> Replace this file's "State" section when it stops being true — do not stack entries.

## State (2026-08-27)

**Since 2026-08-21:** TASK-HANDOFF.md item 25 (the JSONL sink, WO D-24) is done. `persist()`
writes `.data/*.jsonl` only when nothing durable took the record, so it is no longer a second
copy of every lead sitting outside `erase_subject` / `purge_expired`. **The predicate is a THIRD
field, `durable`, and NOT `!fanOut`** — the first version used `fanOut`, and review caught it as
a Critical: `ingest_lead` commits the lead row before it inserts any `delivery` row, so a client
with no `delivery_target` gets `queued: 0` with the lead durably stored and `queueOwnsIt: false`,
which is *every* lead on *every* Postgres deployment until WO12. Four review passes, each of the
first three finding something real. Details and the two things it deliberately left undone are in
TASK-HANDOFF.md item 25; the deletion story is LOESCHKONZEPT.md §4.

**Section A below is unchanged and still Enno's** — the two migrations and the cron step. Nothing
in D-24 touched the database.

## State (2026-08-21)

Branch `phase-1-delivery-queue`, head `2c3d4bb`, clean tree, CI green on the fork. `main`
untouched — merging is Enno's call. **Seven of the NINE migrations are applied to the live
Supabase project.** The two that are not are D3's and D5's, and they exist only in git.

**Phase 2 §4 — the six DSGVO gates — is CODE-COMPLETE. D1 through D8 are all committed.**
Three of those gates are not yet true on the live project, and that gap is the first section of
`TASK-HANDOFF.md`: until `supabase db push` runs, `find_subject` / `erase_subject` /
`purge_expired` do not exist on the live database, so the Subjects view answers an error for a
real client and nothing is being purged on a schedule.

Done: Phase 1 complete. Phase 2 §1 asset upload, §2 custom domains, §3 the client report link
`/r/:token`. Phase 2 §4: **D1–D8** (`fa009da`, `7dc3bb9`, `d153a51`, `062a80b`, `5d81e41`,
`9e53895`, `7766379`, `2c3d4bb`), plus review fixes on top of D4/D5 (`a568146`, `3c676ba`,
`5018c0a`) and one unrelated hardening commit found while running the suite (`7682858`).

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
- **D4** — `GET|DELETE /api/admin/subjects` and the console's Subjects view: pick a client,
  search by the email or phone the person submitted, read what is held, export it as JSON
  client-side, erase it behind a typed confirmation. Verified in a browser against a stubbed
  PostgREST with two clients (`screenshots/d4-subjects-erase-receipt.png`). Two review Majors
  are recorded below — both were about the Erase button acting on state that no longer
  described the screen.
- **D6** — the consent bar. Accept and Decline share one CSS rule and differ in nothing a visitor
  can see; the withdrawal control lives in the branding footer (the bar cannot host it — it stops
  rendering once a decision exists); and `consent.textVersion` reaches `lead.consent` as
  `{ signal, at, text_version }`. Withdrawing a GRANT on a funnel with a pixel also reloads,
  because clearing localStorage cannot unload `gtm.js` — with three exemptions written into
  `_withdrawConsent`. `screenshots/d6-consent-*.png`.
- **D5** — `purge_expired(p_limit)` + the `purge_run` log, in
  `supabase/migrations/20260819140000_retention_purge.sql`; `supabase/cron.sql` now schedules
  `openfunnel-purge` in place of the inline `openfunnel-event-purge` delete. 42 assertions in
  `supabase/tests/purge.sql`, red-checked against 13 deliberate breaks. This is what completes
  Art. 17 — `erase_subject` only soft-deletes.
- **D7** — `GET /api/admin/privacy-notice?slug=` (`lib/privacy.js`, pure `privacyNotice(facts)`)
  builds a German Datenschutzerklärung building block out of what the funnel actually does: its
  form fields, the pixels it embeds, the mail transport that would really send, its delivery
  targets, the client's retention period and AVV, and the function region. Rendered in the
  console's Settings behind a button, because it costs a database round trip. `screenshots/
  d7-privacy-notice-baustein.png`. **The rule the module is built on — it may not claim anything
  the configuration does not do — is now a CLAUDE.md invariant**, because two review findings were
  exactly that failure (see below).
- **D8** — the docs pass. Five invariants into CLAUDE.md, PLAN.md §10's six DSGVO gate lines
  rewritten to say what shipped (**three of them `[~]`, not `[x]`** — see State above), and two
  new one-pagers: `LOESCHKONZEPT.md` (§8.7) and `BREACH-RUNBOOK.md` (§8.8). Writing the
  Löschkonzept surfaced two defects the plan had wrong; both are open items in
  `TASK-HANDOFF.md` §D rather than quietly fixed in prose.

### The three things a next session most needs to know

1. **TWO migrations are NOT applied to the live project** — D3's (`20260819100000_subject_rights`)
   and D5's (`20260819140000_retention_purge`). `supabase db push` is the next database action
   and it needs Enno's confirmation. Until then `find_subject` / `erase_subject` / `purge_expired`
   do not exist on the live database, so D4's Subjects view answers errors and nothing is being
   purged on a schedule. `supabase migration list --linked` will show local ahead by two.
   `supabase/cron.sql`'s new `openfunnel-purge` job is a MANUAL step after that push, and it
   replaces `openfunnel-event-purge` — unschedule the old one in the same sitting or the events
   are deleted by two jobs and `purge_run.events_expired` reads 0, which looks exactly like a
   purge that stopped working.
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

All of **D1–D8** shipped. Enno authorised the whole D1–D8 scope on 2026-08-17.

## Next

**`TASK-HANDOFF.md`** — every open item, ordered by what it unblocks. The short version: the
compliance gates are code-only until `supabase db push` and the `openfunnel-purge` cron step run,
and both are Enno's. Nothing else in Phase 2 is blocked by them.

Build Workflow applies per work order: write → `code-reviewer` + `qa` in parallel
(`run_in_background: true`) → parent applies the fixes → re-run if non-trivial. Done means
reviewer PASS, qa PASS, and for anything visitor-facing a live self-test with a screenshot.
On D1–D3 the reviewer found a real bug on five of six passes — do not treat it as a formality.

### D6's shape, because three parts of it look optional and are not

- **`record.meta.consent` is a plain string and must stay one.** `lib/capi.js` compares it to
  `"granted"` to decide whether the Meta CAPI forward may fire, so an object there would make that
  comparison false for every lead and disable conversion tracking with no error anywhere. The
  §8.4 evidence therefore rides as a SECOND field, `meta.consentRecord`, and `routes/ingest.js`
  maps that into `p_consent` after validating it — `/api/lead` is public.
- **The stored decision is now JSON (`{ d, at, v }`) and still reads the old bare string.**
  Drop that compatibility and every visitor who already decided is asked again, which is itself a
  consent-UX regression.
- **Withdrawing a grant RELOADS, and the three exemptions are load-bearing.** Clearing
  localStorage re-gates future `_pixel()` calls but cannot unload `gtm.js` / `fbevents.js` — they
  keep firing on their own triggers, so without the reload the button withdraws nothing. It is
  skipped for a decline, for a funnel with no pixel, and inside the builder's preview iframe
  (`isEditor`), where a reload re-fetches the funnel ON DISK and flashes the operator's unsaved
  edits away. A visitor with unsubmitted input is asked first, because `saveState()` only runs on
  advance/back — declining that question still withdraws, it only skips the cleanup.
- **Equal prominence meant deleting the primary fill, not strengthening Decline.** An outlined
  button beside a filled one still reads as secondary. Both buttons share one rule now; the
  classes remain only as hooks.

### D4's two review findings, both about the same thing

Both were the Erase button acting on state that no longer described the screen. `subjectsCanErase()`
is now the single gate and it requires four things: a search has run and found rows, the confirm
field equals that search's needle, `state.subjectsState === "ready"`, and **the client dropdown
still shows the client the search ran against**. Without the last one, switching the dropdown and
retyping the confirmation erased the FIRST client's data while the only client-identifying control
on the page named someone else. The matching half is `resetSubjectSearch()`, called on all three
branches of `loadSubjectClients()` — the first version reset only the success branch, so a 500 or
an expired token on the way into the view left the previous client's rows live behind an error panel.

### D7's three review findings, because each one published something false

All three were the module stating a fact the configuration did not support, and all three passed
the tests that existed — the AVV assertions checked only `warnings`, never `text`.

- **The Art. 28 sentence was unconditional.** Every notice claimed a signed
  Auftragsverarbeitungsvertrag, including for a client with `avv_signed_at` null and for a
  self-hosted install with no processor at all. Now three branches: signed states the date,
  unsigned carries an inline `[ACHTUNG — NICHT VERÖFFENTLICHEN]` marker, no client claims nothing.
- **`delivery_target` was queried by `client_id` alone.** Those rows are per funnel — the
  predicate `ingest_lead` queues with is `(funnel_id is null or funnel_id = <this funnel>)`. A
  client with two funnels got the first one's webhook disclosed in the second one's notice: a
  published legal document naming a recipient that receives nothing from that funnel.
- **A `sheet` target was described as a live transfer to Google.** That kind has no dispatcher
  in `lib/delivery.js` and dead-letters every lead. The paragraph is gone and a warning says
  where those leads actually went. Note the direction of the error: it flattered the
  configuration, which is why nobody would have reported it.

The general rule is now a CLAUDE.md invariant: a warning lives in the console, and this text gets
pasted into a document by someone who may never open that panel — so a defect the operator must
act on goes in the TEXT, not only in `warnings`.

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

- **Local Postgres for SQL tests:** seven assertion files now (`purge.sql` joined on D5), with
  `subject-rights.sql` the largest. The throwaway cluster needs a short socket path —
  `initdb -D /tmp/of-pgdata -U postgres --auth=trust` then
  `pg_ctl -D /tmp/of-pgdata -o "-p 54399 -k /tmp/of-pgsock -h 127.0.0.1" start`, with
  `PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH` in front. The default socket dir is too long
  and the cluster refuses to start. `scripts/db-test.sh` owns a database named `of_test` and
  refuses every other name.
- **`browser-harness` can be blocked by a popup only a human can click** — Chrome wants "Allow
  remote debugging for this browser instance" at `chrome://inspect/#remote-debugging`, and the
  daemon dies on a handshake timeout until someone clicks it. Playwright MCP is the documented
  fallback and was what verified D4.
- **The console can be click-tested with no database at all.** Start a `Bun.serve` stand-in for
  PostgREST answering `/rest/v1/client` and `/rest/v1/rpc/<fn>`, then run the runtime with
  `SUPABASE_URL=http://127.0.0.1:<stub> SUPABASE_SERVICE_ROLE_KEY=anything ADMIN_TOKEN=""` — the
  empty `ADMIN_TOKEN` is what makes loopback trusted, so the browser needs no token in
  `localStorage`. That is how D4's two-client erase flow was verified without touching real data.
- **Verifying a deployment means running the runtime LOCALLY against live Supabase.** The Vercel
  preview is behind SSO and answers 302 to everything without the bypass header. Source `.env`
  (never print it), `bun run apps/runtime/server.js` on a spare port, curl + browser-harness against
  `127.0.0.1`, screenshot into `screenshots/`, then **kill the server** and revoke any credential
  the test minted — `page_info()` puts a URL, and therefore a token, into the transcript.
- Local `bun` is 1.3.13 against the pinned 1.3.14. **Do not `bun upgrade`** — five workspace
  projects share that binary. The suite is fully green on 1.3.13 as of 2026-08-21: the
  `refuses an oversized body` failure that used to be written off as a Bun bug turned out to be
  a real missing cap in `readJson`, fixed in `7682858`. If a test ever starts passing only on
  one Bun version again, suspect the code before the runtime.
- **`gh` resolves to the UPSTREAM repo, not this fork.** `gh run list` in this directory answers
  for `luispdoesai/openFunnel` and shows runs that stop in August on `main` — it looks exactly
  like a fork whose Actions are switched off. Pass the fork explicitly:
  `gh api repos/en449/openfunnel/actions/runs --jq '.workflow_runs[] | "\(.head_branch) \(.conclusion) \(.head_sha[0:7])"'`.
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
