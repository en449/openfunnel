# OpenFunnel — Handoff

> Written 2026-08-19. **Start here** when the next session is about OpenFunnel, then open
> `PHASE-2-PLAN.md` §4. This file is the short version; the long records are
> `PROJECT-MEMORY.md` (history + decision log) and `PLAN.md` (architecture, DSGVO §8, phases).
> Replace this file's "State" and "Next" sections when they stop being true — do not stack entries.

## State (2026-08-20)

Branch `phase-1-delivery-queue`, head `7dc3bb9`, pushed, clean tree. `main` untouched —
merging is Enno's call. All **seven** migrations are applied to the live Supabase project.

Done: Phase 1 complete. Phase 2 §1 asset upload, §2 custom domains, §3 the client report link
`/r/:token`. Phase 2 §4: **D1 and D2 are done** (`fa009da`, `7dc3bb9`).

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

**Two D2 decisions a next session will otherwise re-litigate.** The funnel LIST
(`GET /api/funnels`) is deliberately NOT gated: it returns a directory and never a document,
and the console's grid is drawn from it, so filtering would hide the very funnel the operator
has to go fix. And `examples/lead-gen.json` gained a `legal` block because a disk funnel on a
db-configured deployment is still gated on the legal half — the other three examples will 503
on Enno's deployment until they get one.

**One thing D2 could not verify:** the PostgREST embed that reads `avv_signed_at`
(`select=…,client(avv_signed_at)` in `loadFromDb`). It is the same form as `report.js`'s
`TOKEN_SELECT`, which is live and self-tested, but this change was only exercised against a
stub — the `.env` read needed to run the runtime against live Supabase is denied to an agent
by `~/.claude/settings.json`. Confirm it on the first live run: if the embed does not resolve,
`loadFromDb` catches, returns null, and the funnel silently falls back to disk.

Not started: **D3–D8**. Enno authorised the whole D1–D8 scope on 2026-08-17.

## D3 — the design that was in progress, so it is not re-derived

Four findings from reading the schema and the ingest path. Two of them corrected
`PHASE-2-PLAN.md` §4 (already edited there, 2026-08-17):

1. **Storage is not part of a subject walk.** Nothing links a Storage object to a data subject —
   the ingest path stores no uploads (`file` is absent from the console's `FIELD_TYPES`), so every
   object under `funnel/<slug>/` is the operator's marketing photography. The plan's earlier claim
   that the RPC "returns the Storage object paths for the caller to delete" was wrong and is fixed.
   If a funnel ever gains a real upload field, reopen that decision in the same change.
2. **`event` joins to `lead` only through the payload.** `event` carries `session_id text` and no
   lead FK; `storeLead()` strips just `ip` / `user_agent` / `utm` / `referer`, so
   `payload->>'sessionId'` survives on the lead row and is the join. A lead with no `sessionId`
   leaves its events behind — count what was deleted, do not claim completeness.
3. **The GIN index cannot serve the search.** `lead_payload_idx` is `gin (payload jsonb_path_ops)`:
   containment only, no substring, no case-folding. Match-anywhere is a sequential scan over one
   client's leads whatever we write — fine at Free-tier volume. Walk with
   `jsonb_path_query(payload, '$.**')`.
4. **Match exactly, never by substring — the same function deletes.** A needle of `%` or a single
   common digit would erase the client's whole inbox. Case-folded equality for an email,
   digits-only comparison with a 6-digit minimum for a phone, and refuse an empty or one-character
   needle.

Also free: `lead_restrict_cancels_pending` (`20260811120100`) already cancels every `pending`
delivery when `deleted_at` goes non-null, so `erase_subject`'s soft delete stops the outbound queue
without touching `delivery`. Rows already `delivering` are deliberately not cancelled.

**Do not omit the revoke block.** Every migration that creates a function must re-run
`revoke execute on all functions in schema public from public, anon, authenticated` plus the
`alter default privileges` line, guarded by the `pg_roles` existence check the siblings use —
`alter default privileges` only covers functions created *later* by the same role. Review caught
this being missing once already.

Red-check the SQL assertions: a green `supabase/tests/*.sql` proves nothing until the code it pins
is reverted and the assertion is watched failing. `scripts/db-test.sh` carries the
`plpgsql.check_asserts` tripwire.

## Environment facts that cost time when forgotten

- **Local Postgres for SQL tests:** the throwaway cluster needs a short socket path —
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
