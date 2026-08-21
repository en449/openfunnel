# Breach Runbook

> Written 2026-08-21, closing PHASE-2-PLAN.md §4 WO D8. Legal basis:
> [PLAN.md](PLAN.md) §8.8. One page, on purpose — this is written to be read once,
> calmly, before anything happens, and skimmed in under a minute when something has.
>
> **Enno is the processor (Auftragsverarbeiter, Art. 28). Enno's job is speed and
> completeness toward the client, not filing with a regulator.** Enno notifies
> the affected client **unverzüglich** (without undue delay, Art. 28(3)(f) /
> Art. 33(2)). The client is the Verantwortlicher and owns the 72-hour
> Aufsichtsbehörde filing — that clock and that decision are the client's, not
> Enno's. Do not file anything with an Aufsichtsbehörde on a client's behalf.

## If you are reading this because something is happening right now

1. **Do not delete anything, do not "clean up" the database, do not redeploy to
   hide a bug.** Every one of those destroys evidence you will need in step 5.
2. **Write down the time you noticed it**, in UTC, before you do anything else.
   Everything below gets a timestamp; start the log now, even a text file.
3. **If it is an active exposure** (a leaked key, an open route, a bad deploy) —
   contain first (§2), scope second (§3), notify third (§4). In that order.
4. **If it is a discovered-after-the-fact incident** (a report, a suspicious log
   line, a client asking a question that implies exposure) — go straight to
   scoping (§3); there may be nothing left to contain.

---

## 1. Detection — what signals exist, and what does not

There is **no automated intrusion or error-tracking service** watching this
system — deliberately (PLAN.md §8.3): a captured exception can carry a request
body, and adding one would put lead data in front of a fourth-party vendor. That
means detection is one of:

- A report — from a client, a visitor, a security researcher (`SECURITY.md` gives
  them a private channel), or anyone else.
- Something seen by hand in the **Vercel dashboard** (function logs, unusual
  traffic, an unexpected deploy) or the **Supabase dashboard** (query logs,
  connection spikes, an unfamiliar role).
- A query against this project's own tables: `rate_bucket` for an unusual spike
  under one key (its `key` column reads `"ingest:<ip_hash>"`, `"otp-send:<email>"`
  and similar — action plus subject, not a raw IP or URL path), `otp` for a burst
  of codes, `delivery`/`purge_run` for counts that stopped making sense.

**Known gap, stated rather than hidden:** the dead-letter digest
(`alertDeadLetters()` in `lib/email.js`, called from `lib/delivery.js`,
PLAN.md §4.7) mails a summary of permanently failed deliveries to the operator's
`notifyEmail` setting, which falls back to `NOTIFY_EMAIL` — currently **unset**,
so no mail goes out (a `console.error` per dead row is still written, so it is
visible in the Vercel dashboard logs from §1 above to someone who goes looking —
it just does not push). A pattern of silent delivery failures is not itself a
breach, but it is one of the few automated signals this system produces, and
right now it does not proactively reach anyone. Setting `NOTIFY_EMAIL` is a cheap
improvement to detection, not just to ops.

---

## 2. Contain

Pick what applies; most incidents need only one or two of these.

- **A leaked or suspected-leaked `ADMIN_TOKEN`** — rotate it (Vercel env var,
  every project it is set on) and tell every legitimate holder the old one is
  dead. There is no session to revoke; a new token is the only revocation there is.
- **A leaked `INTERNAL_SECRET`** — rotate the value in Supabase Vault
  (`vault.create_secret`) *and* the `INTERNAL_SECRET` env var together. They must
  match or the drain silently stops running, which looks like this system healing
  itself when it has actually gone dark.
- **A leaked `SUPABASE_SERVICE_ROLE_KEY`** — rotate it in the Supabase dashboard.
  This key lives only in the console project's env (PLAN.md §9); if it turned up
  anywhere else (a log, a repo, a client's screen), that is the incident, not a
  side effect of one.
- **A leaked webhook secret** (`delivery_target.config`) — this column is never
  selected by any route that returns to the console (CLAUDE.md), so a leak here
  means the database itself was read directly. Rotate the client's webhook secret
  with them.
- **A bad deploy is the cause** — Vercel instant rollback to the previous
  deployment (PLAN.md §9). This is reversible and fast; use it before debugging
  live.
- **An open or misbehaving route** — the fix ships as a normal PR, reviewed like
  any other change (`CLAUDE.md`'s Build Workflow), not as a panic edit against
  production.

---

## 3. Scope — what to find out before telling anyone anything

Answer these from the database, not from memory:

1. **Which client(s).** `lead` and `delivery_target` carry `client_id` directly —
   filter on it. `event` does **not**: it carries only `funnel_id`, so scoping
   drop-off events to a client means joining through `funnel.client_id` first
   (the same join `purge_expired()`'s step 1 comment notes has no per-client
   horizon for exactly this reason).
2. **Categories of data.** Check against PLAN.md §8.1's data-flow table for what
   the affected store actually holds: contact fields and free-text answers
   (`lead.payload`), a salted IP hash (never a raw IP, per the CLAUDE.md
   invariant — confirm that invariant actually held here), consent evidence
   (`lead.consent`), or drop-off behaviour (`event`).
3. **Approximate number of data subjects.** A `count(*)` against `lead`/`event`
   scoped to the affected `client_id` and time window. State it as an
   approximation, because a live system's exact count moves under you.
4. **Time window.** When did the exposure start, and is it still live (see §2).

---

## 4. Notify the client — unverzüglich, not once you have a perfect writeup

The client's contact is `client.contact_email` (Postgres) or whatever channel
Enno already uses with them — do not wait for a polished report. **Five things,
matching PLAN.md §8.8 / Art. 33(3):**

1. **The nature of the breach** — what happened, in plain terms.
2. **The categories of data subjects affected** — leads, visitors, both.
3. **The approximate number of data subjects affected** — from §3 above, stated
   as an approximation if it is one.
4. **The likely consequences** — what an affected person could plausibly
   experience (spam, targeted phishing using their real name and enquiry, none
   beyond the exposure itself).
5. **The measures taken or proposed** — what was contained already (§2) and what
   is planned next.

State plainly, in the same message: *this notice does not discharge your own
72-hour obligation to your Aufsichtsbehörde if this qualifies as notifiable under
Art. 33(1) — that assessment and that filing are yours to make.* Do not assess
that threshold on the client's behalf; that is a controller decision, and Enno
is not positioned to make it for them.

---

## 5. Preserve evidence

Before any cleanup, deploy, or database change beyond what containment required:

- Export the relevant **Vercel function logs** — they roll off retention on
  Vercel's own schedule, which this project does not control or extend.
- Export or screenshot the **Supabase logs/dashboard** view that showed the
  anomaly.
- **Do not truncate or purge** `purge_run`, `delivery`, `rate_bucket`, or any
  table relevant to the incident before it is scoped and the client notified.
  Some of these already age out on their own schedule (`rate_bucket` via the
  hourly `openfunnel-rate-gc` cron job, `delivery` rows via cascade when their
  `lead` is hard-deleted) — do not accelerate that during an active
  investigation, and do not assume `purge_run` itself ages out: nothing in this
  codebase prunes that table, so it is safe to export from at any time.
- Record every timestamp from §3 (detected, contained, scoped, notified) in one
  place. This is the record Art. 30/32 asks about later.
- Keep the exact SQL used to produce the scope numbers in §3 — a client reading
  a statutory notice may ask how the number was derived.

---

## 6. After

- Fix the root cause through the normal Build Workflow (code review + qa), not as
  a standing exception.
- Decide whether a Fachanwalt or external DSB needs to review the incident
  (PLAN.md §8.10 — **not yet retained** as of this writing; this is Enno's to
  arrange, not something this repo can automate).
- Check whether cyber liability insurance applies (PLAN.md §8.10 — **no policy is
  in place yet**; if one exists by the time this is needed, this line is stale —
  update it).
- Write down what changed as a result, in this file or beside it, so the next
  incident is faster than this one.
