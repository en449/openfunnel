# OpenFunnel — Open Tasks

> Written 2026-08-21. **What is left**, in the order it unblocks things. What is
> DONE lives in [HANDOFF.md](HANDOFF.md) (state + the last work orders) and
> [PLAN.md](PLAN.md) §10 (the phase checklist). This file holds only open items.
>
> Phase 2 §4 — the six DSGVO gates, work orders D1–D8 — is **code-complete as of
> 2026-08-21**. Three of those gates are not yet true on the live project, and that
> is the whole of section A below. Nothing in section B is blocked by section A.

---

## A. Enno's, and blocking — the compliance gates are code-only until these run

These are the difference between "the deletion path is written" and "a data subject's
erasure request can actually be executed." An agent cannot do them: two need a
confirmation before touching the live database, and one needs a file agents are
denied read access to.

1. **`supabase db push` — TWO migrations are unapplied.**
   `20260819100000_subject_rights.sql` (D3) and `20260819140000_retention_purge.sql` (D5).
   `supabase migration list --linked` will show local ahead by two. Until this runs:
   `find_subject` / `erase_subject` / `purge_expired` do not exist on the live database,
   the console's **Subjects view answers a database error** for a real client, and
   **nothing is being purged on any schedule**.
   *The CLI is authenticated; an old note saying it hangs is stale.*

2. **Then, in the same sitting: schedule `openfunnel-purge`.**
   `supabase/cron.sql` is deliberately not a migration — it is run by hand.
   Its statement also unschedules the old inline `openfunnel-event-purge`. Run it once,
   completely. **Do not leave both jobs scheduled**: the events get deleted by the old
   job, `purge_run.events_expired` then reads 0 every night, and a working purge looks
   exactly like a broken one.

3. **Confirm the `avv_signed_at` PostgREST embed on the first live run.**
   `loadFromDb`'s `select=…,client(avv_signed_at)` (`lib/funnels.js`) has only ever been
   exercised against a stub — an agent cannot source `.env`. It is the same form as
   `report.js`'s live `TOKEN_SELECT`, so the risk is low, but a **failed embed makes
   `loadFromDb` catch, return null and fall back to disk silently** — which would turn
   the AVV gate off with nothing in the logs.

4. **`.env.example` additions.** `REPORT_LANG`, `REPORT_TZ`, `REPORT_TTL_DAYS`.
   Agents are denied read on `.env*` by `~/.claude/settings.json`, and that deny blocks
   editing the checked-in template too. Hand-edit.

5. **`NOTIFY_EMAIL` is unset**, so the dead-letter digest has nobody to mail. Per
   [BREACH-RUNBOOK.md](BREACH-RUNBOOK.md) §1 this is one of the only automated signals
   the system produces, and right now it does not reach anyone.

6. **`BREVO_FROM` on a verified sending domain** (SPF/DKIM), plus the Brevo AVV and its
   subprocessor disclosure (PLAN.md §8.3, §8.9).

7. **The AVV itself**, per client, and the paperwork around it — AVV template, TOM
   appendix, Art. 30(2) record, subprocessor list, **reviewed by a Fachanwalt or external
   DSB before client #1** (PLAN.md §10, §8.9). D2's gate refuses to serve a funnel whose
   client has no `avv_signed_at`, so this is also a functional blocker for the first
   real client.

8. **Three of four `examples/*.json` have no `legal` block** — `agency-landing`,
   `fitness`, `real-estate`. On a database-configured deployment they will **503**.
   That is the D1/D2 gate working correctly, and it will look like a bug to anyone who
   has not read this line. `lead-gen.json` has one.

---

## B. Infrastructure, before the first real client funnel goes live

Standing rule while on the Free tiers (PLAN.md §2.1): **no real personal data**, and the
console never on a production domain.

9. **Vercel Pro + Supabase Pro.** This is the gate PLAN.md §10 marks
   *"DPAs in force, SCCs in place, TIA written"* — **Vercel's DPA binds on Pro and
   Enterprise only**, so the gate is not passable from Hobby at all. On the Supabase side
   Pro is what makes PITR available (item 11).

10. **`regions` in `vercel.json`.** There is no `regions` key today, so the functions run
    in Virginia by default and EU lead data is processed in the US. `dub1` (Dublin) is the
    intended value. → the general lesson is in Claude memory as
    *"Vercel functions run in the US by default"*.

11. **PITR window set explicitly, and one verified restore.** [LOESCHKONZEPT.md](LOESCHKONZEPT.md)
    states the backup window as an open item precisely because no number is configured —
    "we deleted it except in backups" is only defensible when the window is written down
    and bounded. Set it, then write the number into the Löschkonzept.

12. **Two Vercel projects** — public `funnel`, `console` behind Vercel Authentication,
    **verified logged-out**. Still one project today: console and funnel share an origin,
    and the whole preview sits behind SSO, which protects the preview and not the console
    on a production domain.

13. **Uptime monitor on a real funnel URL, off-platform.**

14. **Merge `phase-1-delivery-queue` → `main`.** Enno's call; `main` is untouched since
    the fork. CI is green on the branch.

---

## C. Build work still open in Phase 2

Nothing here is a compliance gate. Roughly in the order the plan lists them.

15. **Weekly client summary email** — PLAN.md §10; the report link `/r/:token` exists,
    this is the scheduled sender that points at it.
16. **Spam scoring + duplicate detection.**
17. **`funnel_daily` rollup + drop-off view** — also what makes the 90-day event purge
    non-destructive to analytics, since the rollup is what survives it.
18. **A per-client PIN on top of the report token** — named in PHASE-2-PLAN.md §3's own
    "not in scope".
19. **Google Sheets target.** `DerivedTarget` is `webhook | email` only. Note the shape
    of the hole: `delivery_target`'s check constraint already accepts `'sheet'`, and
    `lib/delivery.js` has **no dispatcher** for it, so such a row dead-letters every lead
    permanently. `lib/privacy.js` deliberately discloses no Google transfer for it and
    warns instead. Building this means the privacy notice's `sheet` branch changes too.
20. **Art. 16 — edit-with-audit-entry.** Out of scope by decision (PHASE-2-PLAN.md §4):
    it needs an audit log, which is a Phase 3 line. Art. 15/17/18/20 are covered.
21. **Vercel edge rate limiting** on the public project. Every ceiling is application-side
    today; there is no firewall rule and nothing in `vercel.json`.
22. **Measure real-device LCP on a preset funnel over 4G** — 22 unbundled module requests
    per page load. This is the measurement that decides whether the no-build-step
    invariant still pays (REALITY-CHECK.md §6).
23. **The console's lead inbox and analytics have no Postgres path.**
    `GET /api/admin/leads` ([admin.js:124](apps/runtime/routes/admin.js#L124)) and
    `computeStats` ([admin.js:762-763](apps/runtime/routes/admin.js#L762-L763)) read the
    JSONL sink and *nothing else*; [app.js:900-902](apps/app/app.js#L900-L902) is the only
    consumer. So on **Vercel the operator's inbox and analytics already read empty**, and
    have since the serverless move — `DATA_DIR` resolves under the repo root, which is
    read-only there, and `appendJsonl` warns once and gives up. Item 25 makes that true on
    a Postgres self-host too. The DB-backed surfaces that exist today are D4's Subjects
    view and `/r/:token`, neither of which is an inbox. Overlaps item 17: the rollup is
    the right source for the analytics half, a plain `lead` select for the inbox half.
    **Do not close this by making the sink unconditional again** (CLAUDE.md invariant).

24. **`apps/app` is not type-checked.** `bun run typecheck` covers the engine and
    `apps/runtime` only. The console is ~5k lines of untyped JS, and the last time
    coverage was added to a directory here it surfaced a real bug on the first run.

---

## D. Two defects found while writing the Löschkonzept — one fixed, one open

Both are documented in [LOESCHKONZEPT.md](LOESCHKONZEPT.md) §4 rather than silently
carried. Neither affects Enno's own Vercel deployment; both affect a self-hoster.
**25 is done (2026-08-27); 26 is still open.** 25 is kept here rather than moved to
HANDOFF.md because the two things it deliberately left undone are the parts a later
session would otherwise re-file as bugs.

25. **The JSONL sink is outside every deletion mechanism.** ~~`persist()` writes
    `.data/*.jsonl` unconditionally.~~ **DONE 2026-08-27.** `persist()` now writes the
    sink only when nothing durable took the record, so it is the store of last resort
    PLAN.md §2.4 always described rather than a shadow copy outside `erase_subject` /
    `purge_expired`. **The predicate is a THIRD field, `durable`, and not `!fanOut` —
    the first version used `fanOut` and review caught it as a Critical.** A lead
    Postgres commits with no `delivery_target` row has `fanOut: true` (nothing will
    deliver it) and `durable: true` (the row exists), and since nothing creates target
    rows until WO12 that is *every* lead on *every* Postgres deployment today — so the
    first version closed almost nothing. See CLAUDE.md's fan-out section. PLAN.md §8.7's false claim is corrected
    in place, LOESCHKONZEPT.md §4 is rewritten, and README gains a
    *"Real personal data needs a database"* boundary.
    **Two things this deliberately did NOT do**, so they are not re-derived as bugs:
    a database outage still writes the sink (dropping that write loses the lead when no
    delivery target is configured), so those records are outside both deletion functions
    until cleared by hand — the runtime warns once per process naming the directory; and
    a no-Postgres install still has no subject-rights mechanism, which is now documented
    as an unsupported-for-real-data boundary rather than engineered around. Building it
    would mean a JS matcher duplicating `subject_matches()` — the shape of the bug that
    erases the wrong person's inbox — plus a streaming rewrite, the unread `.jsonl.1`,
    and a scheduler where there is no `pg_cron`.

26. **Deleting a funnel does not delete its Storage assets.** `removeFunnel()` never
    calls `deleteAsset()` — the only caller is `DELETE /api/admin/assets`, one object
    at a time from the console. PHASE-2-PLAN.md §4 Decision 2 reads as though the
    cascade exists. Today those objects are the operator's own marketing photography,
    not lead data, so this is an orphaned-storage problem and not a DSGVO one —
    **but that is only true while no lead-supplied file ever reaches Storage.**
    The engine's `FieldType` union still lists `"file"` with nothing implementing it.

---

## Standing constraints — do not re-derive these

- Migrations only via `supabase db push`, **never** the Supabase SQL editor.
  `seed.sql` and `cron.sql` are not migrations.
- `npx vercel` for previews, **never `--prod`**. Verify `.vercel/project.json`'s
  projectId first — `prj_FT1fAFoec9oD5rT4jYyoxCuqT27A`, team `enno-s-projects`.
- The `pg_cron` drain targets the **branch alias**
  `openfunnel-git-phase-1-delivery-queue-enno-s-projects.vercel.app`, never a deployment
  hash, and needs the Vercel bypass header: a protected preview answers 302 and `pg_net`
  does not call that a failure, so a drain without it looks healthy forever and delivers
  nothing.
- Synthetic test data only while on the Free tiers.
- `gh` in this working copy answers for the **upstream** repo. Use
  `gh api repos/en449/openfunnel/actions/runs` or pass `-R en449/openfunnel`.
- The Build Workflow's review step is not a formality here: across D1–D7 the reviewer
  found a real bug on nearly every pass, including on code already self-reviewed and
  browser-tested. Every fix gets red-checked — watch the assertion fail under a break
  that could actually catch it — before it is called done.
