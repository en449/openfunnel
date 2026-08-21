# Löschkonzept

> Written 2026-08-21, closing PHASE-2-PLAN.md §4 WO D8. Design and legal basis:
> [PLAN.md](PLAN.md) §8.7. This document describes what the code in this repository
> actually does today, not what §8.7 predicted before D3/D5 were built — two
> predictions turned out wrong (Storage needed no per-subject walk; the JSONL sink
> is a fifth store the plan said would not exist) and are corrected below.
>
> **The single fact that matters most: the mechanisms below are code-complete and
> tested against a local Postgres, but the two migrations that create them —
> `20260819100000_subject_rights.sql` and `20260819140000_retention_purge.sql` —
> are NOT applied to the live Supabase project, and the cron schedule that runs
> the purge automatically has NOT been started.** Until `supabase db push` runs and
> `supabase/cron.sql` is executed by hand against the live project, nothing in this
> document is true of a real client's data — it describes a deletion path that
> exists in git, not yet in production. See `HANDOFF.md` for the exact commands.

Enno is **Auftragsverarbeiter** (processor, Art. 28 DSGVO) for every client's leads;
each client is **Verantwortlicher**. This concept is Enno's operational answer to
Art. 17 (Löschung) and to the client's own retention obligations — it is not the
client's Datenschutzerklärung, which is generated separately per funnel
(`GET /api/admin/privacy-notice`, `apps/runtime/lib/privacy.js`).

---

## 1. The stores — every place personal data lands, and what empties each one

| # | Store | What it holds | Deletion mechanism | Retention | Live status |
|---|-------|----------------|---------------------|-----------|-------------|
| 1 | `lead` (Postgres) | contact fields, free-text answers, IP hash, consent record | `erase_subject()` (on request, soft) → `purge_expired()` step 3 (hard, 24h later) | per client `retention_months` (default 12, floor `greatest(., 1)`) via `purge_expired()` step 2 | **Not scheduled/callable yet** — migration unapplied |
| 2 | `event` (Postgres) | step/drop-off events, `session_id` | `erase_subject()` deletes events on a shared session on request; `purge_expired()` step 1 deletes on age; step 3 deletes a soft-deleted lead's events if the session is then empty | 90 days, fixed and global (not per client) | **Not scheduled/callable yet** — migration unapplied |
| 3 | `.data/*.jsonl` (JSONL sink) | the same lead/event records, written a second time as the operator's own copy | **none** — see §4 | rotates at 64MB by file size, not by age | Written **only** where the process has a writable filesystem; see §4 |
| 4 | Supabase Storage (`funnel-assets` bucket) | operator-uploaded funnel images (hero photos, gallery items) | `DELETE /api/admin/assets`, one object at a time, by the console | none automatic | live since 2026-08-13; **not linked to lead deletion** — see §2 |
| 5 | Backups / PITR | a point-in-time copy of everything in Postgres | not deletable per-row | **not configured** — see §5 | Free tier |
| 6 | Vercel function logs | request path, IP, status; never a lead body if the no-raw-IP invariant holds | Vercel's own retention | not independently set by this project | disclosed platform log, not a store this project controls |

---

## 2. Deletion on request — Art. 15 / 17 / 20, `erase_subject` and `find_subject`

`supabase/migrations/20260819100000_subject_rights.sql` (WO D3). One matcher,
`subject_matches(payload, needle)`, used by both functions so a search and a
deletion can never disagree about what "everything held" means.

**The match is exact, never a substring.** Case-folded equality for text, a
digits-only comparison for a phone number (minimum 6 digits), and a needle under
3 characters matches nothing. A substring search in a function that deletes would
let `%`, `@`, or one common digit erase a client's entire inbox — this is why
there is no `like`/`ilike`/`position()` anywhere in the file. The cost, stated
rather than discovered later: a phone submitted as `+49 170 1234567` will not be
found by searching `01701234567` — search with the form the lead was submitted
in; email is the reliable identifier.

**`find_subject(client_id, needle)`** (Art. 15/20 — Auskunft/Portabilität) returns
every matching lead with its flags shown, not filtered: soft-deleted, restricted
and spam rows are included, because the data subject is entitled to know a record
exists and is restricted. It also flags `session_shared` per row — true when a
lead this search does **not** match sits on the same browsing session, so the
operator can see a number belongs to more than one visitor before writing a
statutory reply. Exposed at `GET /api/admin/subjects?client=&q=` (console: Subjects
view, search → read → export JSON client-side; no separate export endpoint, so
there is only one server surface holding this data).

**`erase_subject(client_id, needle)`** (Art. 17 — Löschung) soft-deletes every
matching `lead` (`deleted_at = now()`) and deletes their `event` rows in the same
transaction. Exposed at `DELETE /api/admin/subjects`, gated behind the operator
retyping the search needle into a `confirm` field that must match exactly — checked
before the database is touched. The receipt it returns, and what each number means:

| Receipt field | Meaning |
|---|---|
| `leadsDeleted` | leads just soft-deleted by this call |
| `leadsAlreadyDeleted` | matching leads that were already soft-deleted (a repeat request, or an earlier retention/erase pass) |
| `eventsDeleted` | event rows removed |
| `leadsWithoutSession` | matching leads with no `sessionId` on their payload (an older row, or a direct API post) — **their events cannot be reached and are not counted as deleted**; the receipt says so rather than claiming completeness |
| `sharedSessions` | sessions this erasure emptied that another lead — one this search did **not** match — also sat on; that lead's own events were left alone |

**Why this is a soft delete, and why that is not the end of it.** The row survives
with `deleted_at` set. Two things happen immediately anyway:
`lead_restrict_cancels_pending` (migration `20260811120100`) cancels every
`pending` outbound delivery the moment `deleted_at` goes non-null, and the row
disappears from every reader, which already excludes `deleted_at is not null`. A
delivery already `delivering` is **not** cancelled — a lease is in flight, and the
receipt does not claim otherwise. The row is only physically gone once
`purge_expired()`'s step 3 runs, 24 hours later at the earliest (§3).

**Why Storage is not walked per subject.** Corrected from the plan: nothing links
a Storage object to a data subject. Ingest stores no file uploads at all — `file`
is absent from the console's field types (`FIELD_TYPES`, CLAUDE.md) — so every
object under `funnel/<slug>/` is the *operator's* marketing photography, uploaded
through the console (PHASE-2-PLAN.md §1), never something a lead submitted.
Walking Storage per subject would have no meaning.

**The trap that makes this reversible without anyone noticing:** the engine's
`FieldType` union in `packages/engine/src/types.js` still lists `"file"`, left over
from upstream. Nothing renders it and nothing uploads for it — the console cannot
create such a field and the engine has no handler — so it is inert today. But it
means implementing lead file uploads would look like filling in a type that already
exists rather than adding a new store of personal data. **If a funnel ever gains a
real file-upload field, this section is wrong the moment that ships and must be
reopened in the same change.**

**Why `event` is only reachable through the payload, and what that costs.** `event`
has `session_id text` and no foreign key to `lead`; `payload->>'sessionId'` is the
only join there is, because `storeLead()` strips only `ip`/`user_agent`/`utm`/`referer`
before the row is written. A `sessionId` is minted once per mounted funnel, not once
per human — a tablet on a trade-fair stand, a kiosk reset between visitors, a shared
family browser all produce one session shared by more than one person. Erasing one
of those people deletes the whole mixed trail; nothing in the data can split it, and
a stranger's drop-off events are not worth failing an Art. 17 request over. That is a
deliberate choice, and `sharedSessions`/`session_shared` exist so it is a visible one
rather than a silent one.

**Backups are explicitly out of this mechanism's reach** — see §5. Do not tell a
data subject their data is gone from every store; tell them it is gone from every
*reachable* one and name the backup window once §5 has a number in it.

---

## 3. Automatic retention — `purge_expired()`, scheduled and logged

`supabase/migrations/20260819140000_retention_purge.sql` (WO D5). One function,
three steps in one transaction, called `select purge_expired();` once a day at
`40 3 * * *` (03:40, in the database's configured timezone — UTC by Postgres
default, not independently overridden here) by `supabase/cron.sql`'s
`openfunnel-purge` job — **once that job is actually started; see the box at the
top of this document.**

1. **Events past 90 days** are deleted outright — the global horizon, not
   per-client (`event` carries no `client_id`, and 90 days is what the generated
   Datenschutzerklärung states).
2. **Leads past their client's own horizon** (`greatest(client.retention_months, 1)`
   months — the floor exists because the column has no check constraint and a `0`
   would mean "every lead this client has ever received, tonight") are
   **soft**-deleted, not hard-deleted, and only if not `restricted`. Art. 18
   restriction means *store it, do not process it* — the retention sweep skips a
   restricted lead entirely, on purpose.
3. **Soft deletes older than 24 hours** — from step 2 above, **or from
   `erase_subject`** — are hard-deleted, along with their events where no other
   surviving lead still sits on that session. Step 3 does **not** re-check
   `restricted`: a `deleted_at` already set was set deliberately, by a person's own
   Art. 17 request or by a previous run of step 2, and re-checking would strand an
   Art. 17 erasure of a restricted lead as a soft delete forever.

**Why the 24-hour window exists at all**, for both the automatic and the on-request
path: a wrong `retention_months` (or a mis-typed search that somehow matched) stays
recoverable for a day instead of being unrecoverable the instant it happens.

**`purge_run`** gets one logged row per call — including a call that deleted
nothing. That is deliberate: an empty log cannot tell a database with nothing to
purge apart from a cron job nobody scheduled, which is exactly the failure mode of
assuming a schedule runs because it was written down. Check it with:

```sql
select started_at, events_expired, leads_expired, leads_erased, events_erased,
       sessions_kept, capped
  from purge_run order by started_at desc limit 14;
```

**The `capped` flag** is true when any step hit its per-call limit (default
20,000 rows). A capped run is not an error — it means there was more to do than
one run's ceiling allowed, and the backlog clears one limit at a time on the next
run. If `capped` is true on consecutive days, the schedule or the limit is too
small for the volume; nothing about this self-corrects, so it needs a human to
raise the limit or run it more often.

---

## 4. The JSONL sink — the store the plan said would not exist

`apps/runtime/lib/store.js`'s `persist()` writes every lead and event to
`.data/leads.jsonl` / `.data/events.jsonl` **unconditionally, whether or not
Postgres is configured** — "the JSONL sink is written either way," in the code's
own words. PLAN.md §8.7 said the Vercel+Supabase design has "one fewer" store than
a VPS design "because there is no JSONL sink." That is not what shipped, and this
document corrects it rather than repeating it:

- **On Vercel** (Enno's actual deployment target), the filesystem outside `/tmp`
  is read-only. `appendJsonl()`'s own `mkdir` throws, is caught, and after one
  warning per process the sink is silently off — nothing is lost (Postgres already
  holds the lead, or the fan-out delivered it), but no second copy accumulates on
  disk there either. **On this deployment, §8.7's original premise holds in
  practice, for a reason the plan did not state.**
- **On a self-hosted Bun deployment with a writable `DATA_DIR`**, the sink *is*
  written, and it is real personal data at rest on that machine's disk. **Neither
  `erase_subject` nor `purge_expired` touches it — both are Postgres-only.** A
  self-hoster running Postgres alongside a writable `DATA_DIR` has a copy of every
  erased or purged lead sitting in a `.jsonl` file that the mechanisms in §2 and §3
  do not know exists.
- **A self-hoster running with *no* database at all** has the JSONL sink as their
  *only* lead store. There is no `find_subject`, no `erase_subject`, no
  `purge_expired` for that deployment — `GET`/`DELETE /api/admin/subjects` both
  answer `503 db_not_configured`. Deletion there is manual: edit or truncate the
  file. This is not a defect to silently accept — it is the honest boundary of
  what this concept currently covers, and it belongs in any self-hosting
  documentation this project publishes.

---

## 5. What is honestly not reachable

- **A lead already delivered** to the client's inbox, CRM or Sheet is theirs to
  delete. Enno cannot reach it, and no mechanism in this repo tries to.
- **Backups / PITR.** Supabase is on the **Free tier**, and the PITR window is
  **not configured** — there is no number to state here, which is itself the
  finding: §8.7 asks for the window to be written down explicitly rather than
  inherited silently, and right now there is nothing configured to write down.
  This is open until Supabase Pro is purchased (PLAN.md §8.10, §9) and a window is
  set and recorded here.
- **Vercel function logs.** Disclosed as a platform log (§8.1), not a store this
  project independently configures. Retention follows Vercel's own plan terms;
  the exact number has not been confirmed against the dashboard and is not stated
  here to avoid printing a figure nobody checked.
- **Supabase's CDN cache of a deleted Storage object.** Measured 2026-08-13: after
  a `DELETE` call on an asset — confirmed gone via `POST /object/list`, which is
  authoritative — the public URL still answered `200` with the file for a while.
  "Deleted" is true at the origin and not immediately true at the edge.
- **A funnel's Storage assets are not deleted with the funnel.** `removeFunnel()`
  (`apps/runtime/lib/funnels.js`, called by `POST /api/builder/delete`) removes the
  funnel's document and cache entry only; nothing calls `deleteAsset()` for the
  images that funnel uploaded. Deleting a client's images today is manual, one
  object at a time, through the same `DELETE /api/admin/assets` route the console
  uses per-field. This is a gap against the client-level deletion PHASE-2-PLAN.md
  §4 Decision 2 describes ("delete the funnel, delete its assets") — the mechanism
  for the second half does not exist yet.
- **A lead whose payload has no `sessionId`** (an older row, or a direct API post
  bypassing the engine) has events that `erase_subject` cannot find and does not
  count as deleted — `leadsWithoutSession` in the receipt names this rather than
  hiding it.
