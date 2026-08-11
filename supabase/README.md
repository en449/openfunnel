# supabase/

Phase 1 database. Design and rationale live in [../PHASE-1-PLAN.md](../PHASE-1-PLAN.md) —
§2 for the schema, §3 for the delivery state machine. This file is only how to run it.

```
migrations/
  20260811120000_phase1_schema.sql     tables, indexes, RLS
  20260811120100_phase1_functions.sql  the state machine, ingest, rate limiter
seed.sql                               synthetic client + funnel + targets (dev only)
cron.sql                               pg_cron jobs — run by hand, see the header
postgrest.local.conf                   standalone PostgREST for local dev
tests/state-machine.sql                the queue's behaviour, as assertions
tests/db-integration.mjs               lib/db.js → PostgREST → those functions
```

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
psql -h 127.0.0.1 -p 54399 -U postgres -d of_dev -v ON_ERROR_STOP=1 \
     -f supabase/tests/state-machine.sql
```

The test ends in `ROLLBACK`, so it leaves nothing behind and can be run against any database
carrying this schema, including a live one — every assertion is scoped to the rows it created.
Expected last line:

```
NOTICE:  state-machine check: all assertions passed
```

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
# then cron.sql by hand, once /api/internal/drain is deployed
```

Seed data is **synthetic only**. While the build runs on Vercel Free + Supabase Free the
standing rule is no real personal data anywhere (PLAN.md §2.1).

## Rollback

There are no paired down-migrations. Before this database holds real leads, the down is
`supabase db reset` (or dropping the database locally). Each migration carries the rollback
statements it would need in a comment at its head, for the day that stops being true.
