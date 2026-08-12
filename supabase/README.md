# supabase/

Phase 1 database. Design and rationale live in [../PHASE-1-PLAN.md](../PHASE-1-PLAN.md) —
§2 for the schema, §3 for the delivery state machine. This file is only how to run it.

```
migrations/
  20260811120000_phase1_schema.sql     tables, indexes, RLS
  20260811120100_phase1_functions.sql  the state machine, ingest, rate limiter
  20260811130000_otp_functions.sql     issue/verify/is-verified for the challenge
  20260812093000_delivery_target_sync.sql  target.source + sync_delivery_targets
seed.sql                               synthetic client + funnel + targets (dev only)
cron.sql                               pg_cron jobs — run by hand, see the header
postgrest.local.conf                   standalone PostgREST for local dev
tests/state-machine.sql                the queue's behaviour, as assertions
tests/otp.sql                          the challenge's behaviour, as assertions
tests/targets.sql                      the target sync's behaviour, as assertions
tests/db-integration.mjs               lib/db.js → PostgREST → those functions
```

`seed.sql` and `cron.sql` are **not** migrations and must never be applied as ones —
`seed.sql` is dev fixtures. `cron.sql` is now two parts: **Part A** (sweeper + housekeeping) is
pure SQL and should be running already, while **Part B** (the retry drain) needs a URL `pg_net`
can reach — a protected preview answers 302, and `net.http_post` does not treat that as a failure,
so a drain scheduled too early looks healthy and delivers nothing.

## Running it locally

The Supabase CLI's local stack (`supabase start`) needs Docker, which is not installed on
this machine. Everything below therefore works against a plain PostgreSQL 17 — which is
enough for the schema, the functions and the tests. Only `pg_cron` and `pg_net` are missing,
and those are exercised on the real project (`cron.sql` is a manual step regardless).

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"   # brew install postgresql@17

# one throwaway cluster, TCP only — the socket path under /private/tmp is longer
# than Postgres's 103-byte limit, so -h 127.0.0.1 is not optional here
initdb -D /tmp/of-pgdata -U postgres --auth=trust
pg_ctl -D /tmp/of-pgdata -o "-p 54399 -k /tmp/of-pgsock -h 127.0.0.1" -l /tmp/of-pg.log start

psql -h 127.0.0.1 -p 54399 -U postgres -c "create database of_dev;"
for f in supabase/migrations/*.sql supabase/seed.sql; do
  psql -h 127.0.0.1 -p 54399 -U postgres -d of_dev -v ON_ERROR_STOP=1 -f "$f"
done
```

That gives you a working `of_dev` to point the runtime at. To check the assertions in
`supabase/tests/*.sql` actually still pass, run `./scripts/db-test.sh` instead of the
manual `psql -f` recipe below — it is the one-command path, and the one CI runs on
every push (§4.8). It reads a **server** URL from `OF_TEST_PG_URL` (defaulting to the
cluster above, `postgres://postgres@127.0.0.1:54399/postgres`), then drops and recreates a
database of its own — always named `of_test` — applies every migration to it, and runs every
assertion file. It never touches `of_dev` or any other database; that separation is load-bearing,
not tidiness, because applying migrations to a database the Supabase CLI owns (`of_dev`, or a
linked live project) breaks the migration ledger the same way pasting SQL into the Supabase
editor does (see below). Pointing `OF_TEST_PG_URL` at `of_test` itself is refused rather than
attempted, since dropping the database you're connected through is not something Postgres
allows anyway.

**Point it at a local cluster.** Nothing stops `OF_TEST_PG_URL` naming a live project's server,
and the invariant still technically holds there — it would create and drop a database called
`of_test` beside the real one and never touch the migration ledger — but running the
one-command path against a production server is not a thing to do by accident. Note also that
the URL is a DSN: if yours carries a password, treat it like any other secret. The script never
echoes it (it prints `***@` in place of the userinfo), but your shell history will.

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
./scripts/db-test.sh
```

Running the assertion files against a database you already have — `of_dev`, or a live
project — stays a deliberately manual decision (§4.8 Decision 1), and the recipe for it is
unchanged:

```bash
psql -h 127.0.0.1 -p 54399 -U postgres -d of_dev -v ON_ERROR_STOP=1 \
     -f supabase/tests/state-machine.sql
psql -h 127.0.0.1 -p 54399 -U postgres -d of_dev -v ON_ERROR_STOP=1 \
     -f supabase/tests/otp.sql
psql -h 127.0.0.1 -p 54399 -U postgres -d of_dev -v ON_ERROR_STOP=1 \
     -f supabase/tests/targets.sql
```

Each file ends in `ROLLBACK`, so it leaves nothing behind and can be run against any database
carrying this schema, including a live one — every assertion is scoped to the rows it created.
Expected last line, whichever way you run them:

```
NOTICE:  state-machine check: all assertions passed
NOTICE:  otp check: all assertions passed
NOTICE:  targets check: all assertions passed
```

Do NOT paste a migration into the Supabase SQL editor instead. It applies the SQL but writes
no row to the migration ledger, so the next `db push` re-runs it and "what is actually applied"
stops being answerable. `supabase migration list` is the check.

## The runtime against a real database

`apps/runtime/test/db.test.js` stubs `fetch`, so it pins how `lib/db.js` behaves and nothing
about whether the SQL agrees with it. For the other half, run PostgREST — the one Supabase
component the runtime actually talks to — directly against the local cluster. No Docker
involved.

```bash
postgrest supabase/postgrest.local.conf &          # brew install postgrest
bun supabase/tests/db-integration.mjs              # expects: all integration checks passed
```

Two differences from Supabase that the runtime absorbs rather than papers over: standalone
PostgREST serves at the root while Supabase mounts it under `/rest/v1` (hence
`SUPABASE_REST_PATH=""`), and it verifies the `Authorization` JWT, so the script mints one
signed with the config's local secret rather than skipping auth. The path exercised is the
production path.

Stop both when done: `pkill -f postgrest` and `pg_ctl -D /tmp/of-pgdata stop`.

## Going to the real project

Needs the Supabase CLI (`brew install supabase/tap/supabase`) but **not** Docker — `db push`
against a linked remote project runs the migrations server-side.

```bash
supabase link --project-ref <ref>
supabase db push
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/state-machine.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/otp.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/targets.sql
# then cron.sql Part A by hand; Part B once /api/internal/drain is REACHABLE (not just deployed)
```

Seed data is **synthetic only**. While the build runs on Vercel Free + Supabase Free the
standing rule is no real personal data anywhere (PLAN.md §2.1).

## Rollback

There are no paired down-migrations. Before this database holds real leads, the down is
`supabase db reset` (or dropping the database locally). Each migration carries the rollback
statements it would need in a comment at its head, for the day that stops being true.
