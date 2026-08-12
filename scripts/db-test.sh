#!/usr/bin/env bash
# ===========================================================================
# Runs the SQL assertions in supabase/tests/*.sql against a throwaway
# database, applying supabase/migrations/*.sql first.
#
# Why this exists: PHASE-1-PLAN.md §4.8. The assertions in supabase/tests/
# shipped with WO1 and have been correct the whole time — nothing had run
# them since. The local dev cluster drifted two migrations behind with
# nobody noticing, because the only way to run these files was a five-command
# README recipe against a cluster someone had to remember to start by hand.
# This script is that recipe, made runnable from a cold start and from CI.
#
# It always owns a database named of_test: drops it, recreates it, applies
# every migration, runs every assertion file, and drops nothing else. Running
# the assertions against a database the Supabase CLI manages (of_dev, or a
# live project) is a decision for a human and stays the manual `psql -f`
# recipe in supabase/README.md — this script refuses to touch anything but
# its own database, on purpose (see the guard below).
#
#   OF_TEST_PG_URL=postgres://postgres@127.0.0.1:54399/postgres ./scripts/db-test.sh
#
# ===========================================================================

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SERVER_URL="${OF_TEST_PG_URL:-postgres://postgres@127.0.0.1:54399/postgres}"
TEST_DB="of_test"

# The test-database URL is the server URL with its dbname swapped for
# of_test, not "$SERVER_URL -d of_test": psql treats a positional URI as the
# whole conninfo, so a second -d after it doesn't override the URI's dbname —
# it shifts the URI into the NEXT positional slot (username) instead, and the
# connection silently falls back to a default local socket.
#
# The URL is matched apart rather than trimmed with ${...%/*}, which was the
# first version and was wrong on two shapes a person could reasonably paste.
# With no dbname segment at all, "%/*" strips back into the scheme's own "//"
# and postgres://postgres@127.0.0.1:54399 became postgres://of_test — host,
# port and user gone. With a trailing slash it produced .../postgres/of_test,
# a dbname containing a slash. Both died loudly a few steps later rather than
# touching the wrong database, but "died loudly three steps after the script
# said everything was fine" is not the standard for the guard that decides
# WHICH database gets dropped. Anything that does not parse is refused here,
# named, and never spliced.
if [[ ! "$SERVER_URL" =~ ^(postgres(ql)?://[^/?#]+)/([^/?#]+)(\?.*)?$ ]]; then
  # The value is deliberately NOT echoed back. Masking it was the first
  # version and it only masked a URI: psql equally accepts libpq's
  # keyword/value form, so `host=… password=hunter2 dbname=…` does not match
  # the `//…@` shape and was printed to stderr verbatim — into a terminal's
  # scrollback and, if this ever runs in CI against a credentialed server,
  # into a retained log. A refusal message does not need the secret to be
  # useful; naming the variable and the expected shape is the whole
  # diagnostic.
  echo "db-test: OF_TEST_PG_URL does not parse (its value is not printed — a DSN can" >&2
  echo "carry a password). Expected postgres://[user[:password]@]host[:port]/<dbname>[?params]:" >&2
  echo "a SERVER url naming any database except ${TEST_DB}, which this script creates itself." >&2
  exit 1
fi
TEST_URL="${BASH_REMATCH[1]}/${TEST_DB}${BASH_REMATCH[4]:-}"

# Never echo the URL itself: it is a DSN, and a DSN carries a password
# whenever it points at anything but a trust-auth cluster. This is the same
# rule CLAUDE.md states for outbound fetch errors — Bun puts the full request
# URL on err.path, so logging the object logs the credential in it. A test
# script is not exempt: the terminal it prints to has a scrollback, and CI has
# a log. Everything user-facing below prints this form, never $SERVER_URL.
#
# Masked out of the AUTHORITY only, not the whole string. The glob is greedy
# and runs to the last @, so over the whole URL a query string carrying one
# (?token=abc@def) swallowed the host and dbname with it — safe, since the
# password can never survive a match that spans at least the real separator,
# but it hid which server the run actually targeted. BASH_REMATCH[1] cannot
# contain a query string, so confining it there removes the case entirely.
safe_authority="${BASH_REMATCH[1]//\/\/*@///***@}"
SAFE_URL="${safe_authority}/${BASH_REMATCH[3]}${BASH_REMATCH[4]:-}"

# psql takes a URL as its single positional dsn argument, and
# -v ON_ERROR_STOP=1 is on every call below so a failing statement stops the
# script rather than getting buried in scrollback.
psql_server() { psql "$SERVER_URL" -v ON_ERROR_STOP=1 "$@"; }
psql_test()   { psql "$TEST_URL" -v ON_ERROR_STOP=1 "$@"; }

# --- guard: never drop the database we are connected through -------------
#
# The script's whole job is DROP DATABASE + CREATE DATABASE + apply
# migrations against of_test. If OF_TEST_PG_URL already points AT of_test,
# step one is dropping the database the connection is using, which Postgres
# refuses — but refusing loudly here, before anything runs, is clearer than
# letting that surface as a psql error three lines in. It also stops someone
# pointing this at of_dev or a live project by editing the URL's database
# name instead of using a server URL, which is the one thing §4.8 Decision 1
# says this script exists to make unreachable.
current_db="$(psql "$SERVER_URL" -Atqc 'select current_database()')"
if [[ "$current_db" == "$TEST_DB" ]]; then
  echo "db-test: OF_TEST_PG_URL already names the $TEST_DB database — point it at a" >&2
  echo "server URL instead (e.g. .../postgres), so this script can drop and recreate" >&2
  echo "$TEST_DB itself. Refusing to drop the database it is connected through." >&2
  exit 1
fi

echo "db-test: (re)creating $TEST_DB on $SAFE_URL"
psql_server -c "drop database if exists ${TEST_DB};"
psql_server -c "create database ${TEST_DB};"

# --- tripwire: prove plpgsql assertions are actually checked --------------
#
# plpgsql.check_asserts is a session GUC. With it off, every `assert` in
# every file below is a silent no-op: each file still prints its "all
# assertions passed" notice and psql still exits 0. Measured in §4.8 Decision
# 2, not assumed. So before trusting a single green result from this
# database, deliberately fail an assertion and require psql to exit non-zero
# for it. If it exits zero, the mechanism the entire rest of this script
# leans on is off, and every result below would be meaningless.
#
# It requires the assertion's own MESSAGE, not merely a non-zero exit. Its
# first version tested the exit code alone, and psql exits non-zero for
# everything — a bad password, an unreachable host, a database that does not
# exist. So a run that could not connect at all read as "tripwire ok —
# assertions are checked" and only fell over three steps later, at the
# migrations. A guard that the rest of the script leans on has to fail for its
# own reason or it is not a guard.
echo "db-test: tripwire (plpgsql.check_asserts must be on)"
tripwire_out="$(psql_test -c "do \$\$ begin assert false, 'tripwire'; end \$\$;" 2>&1)" && tripwire_rc=0 || tripwire_rc=$?
if [[ $tripwire_rc -eq 0 ]]; then
  echo "db-test: TRIPWIRE FAILED — 'assert false' exited 0. plpgsql.check_asserts" >&2
  echo "is off (or equivalent), so every assertion in supabase/tests/ is a no-op" >&2
  echo "and this whole run would report success while checking nothing." >&2
  exit 1
fi
if ! grep -q "tripwire" <<<"$tripwire_out"; then
  echo "db-test: TRIPWIRE INCONCLUSIVE — psql exited $tripwire_rc without raising the" >&2
  echo "assertion. That is a connection or permission failure, not a checked" >&2
  echo "assertion, so nothing below would mean anything. psql said:" >&2
  echo "$tripwire_out" >&2
  exit 1
fi
echo "db-test: tripwire ok — assertions are checked"

# --- migrations -------------------------------------------------------------
#
# In filename order, which is why every migration is timestamp-prefixed.
# seed.sql and cron.sql are deliberately excluded: neither is a migration
# (seed.sql is dev fixtures, cron.sql needs pg_cron/pg_net this cluster
# doesn't have), and every assertion file builds the fixtures it needs.
echo "db-test: applying migrations"
for f in supabase/migrations/*.sql; do
  echo "  -> $f"
  psql_test -f "$f"
done

# --- assertion files ---------------------------------------------------------
#
# Two independent failure signals per file, because either one alone is not
# enough: a non-zero exit is the obvious failure, but a file that exits 0
# WITHOUT printing its own "all assertions passed" notice returned early —
# an exception swallowed by an outer `begin/exception` block, a stray
# `return`, anything that skips the final `raise notice` — and a bare exit
# code would read that as a pass.
declare -a failed_files=()
for f in supabase/tests/*.sql; do
  echo "db-test: running $f"
  out="$(psql_test -f "$f" 2>&1)" && rc=0 || rc=$?
  echo "$out"
  if [[ $rc -ne 0 ]]; then
    echo "db-test: FAIL $f (psql exited $rc)"
    failed_files+=("$f")
  elif ! grep -q "all assertions passed" <<<"$out"; then
    echo "db-test: FAIL $f (exited 0 but never printed 'all assertions passed' — returned early)"
    failed_files+=("$f")
  else
    echo "db-test: PASS $f"
  fi
done

# --- skip locked: needs two sessions, so it cannot live in a .sql file ------
#
# supabase/tests/state-machine.sql already proves a claimed row cannot be
# claimed again — but that is one psql connection, and `for update of d skip
# locked` only has an observable effect ACROSS two: a second, concurrent
# claimer must skip a row the first is holding, not queue up behind it. One
# session is not enough to see the difference between "skip locked" and
# plain "for update", because a single session never contends with itself.
#
# What would actually go wrong without it: the cron drain, the inline first
# attempt and an operator's re-send are all claim_deliveries callers that can
# overlap by design (§4.8 Decision 3, hole 3). Without SKIP LOCKED the second
# one blocks on the first's row lock instead of moving past it to the OTHER
# pending row — so a drain that in fact worked spends its budget waiting
# instead of delivering, and can read as a timeout to whatever is watching
# `pg_net`'s 55s ceiling.
skip_locked_ok=1
echo "db-test: skip locked (two-session check)"

# A client, a funnel and two enabled targets (one client-wide webhook, one
# funnel-scoped email — same shape as the fixture at the top of
# state-machine.sql), then ingest_lead() so the lead has exactly two pending
# delivery rows. This has to be separate top-level statements, not one CTE:
# a single statement's sub-parts all run against the SAME snapshot and
# "cannot see one another's effects" (the Postgres manual's own words for
# WITH queries) — ingest_lead's read of delivery_target would miss targets
# inserted earlier in the same statement. Plain sequential statements
# auto-commit as they go, so each one sees what came before it.
lead_id="$(psql_test -Atq <<'SQL' | tr -d '[:space:]'
insert into client (name, slug, contact_email)
  values ('SkipLocked Check', 'skip-locked-' || gen_random_uuid(), 'nobody@example.invalid')
  returning id as cid \gset
insert into funnel (client_id, slug, name, doc, status)
  values (:'cid', 'skip-locked-' || gen_random_uuid(), 'Skip Locked', '{}'::jsonb, 'live')
  returning id as fid, slug as fslug \gset
insert into delivery_target (client_id, funnel_id, kind, config)
  values (:'cid', null, 'webhook', '{"url":"https://a.invalid/h"}'::jsonb);
insert into delivery_target (client_id, funnel_id, kind, config)
  values (:'cid', :'fid', 'email', '{"to":"nobody@example.invalid"}'::jsonb);
select l.lead_id
  from ingest_lead(:'fslug', '{"lead":{"email":"skip-locked@example.invalid"}}'::jsonb,
                   null, null, false, null, null, 'skip-locked-dedupe') l;
SQL
)"

if [[ -z "$lead_id" ]]; then
  echo "db-test: FAIL skip-locked fixture — no lead id returned"
  failed_files+=("skip-locked-check")
else
  # Session A: claims one of the two pending rows and HOLDS the transaction
  # open for ~5s — standing in for an in-flight delivery attempt (the inline
  # first attempt, say, still running when the cron drain ticks). Its own
  # output goes to a scratch file so it doesn't interleave with session B's
  # timing below; it's read back after B is done.
  #
  # 5s, and B is judged against 1000ms, because the two numbers have to leave
  # room on BOTH sides or the check quietly stops checking. B passes in ~40ms
  # locally, so the pass side has 25x of headroom for a slow CI runner. The
  # fail side is what the first version got wrong: A slept 3s, B started at 1s
  # and was judged against 2000ms, so a blocked B came back at 2006ms — six
  # milliseconds of margin. A `sleep 1` that overshoots by that much on a busy
  # runner would have let a claim_deliveries with no SKIP LOCKED pass as
  # healthy, which is the one outcome this check exists to prevent. Now a
  # blocked B waits ~4s against a 1s ceiling.
  a_out="$(mktemp)"
  # A holds a row lock for five seconds and writes to a temp file, so both have
  # to be cleaned up on ANY exit from here on, not only the happy one — see the
  # guard on B's command substitution below for the path that used to skip
  # them.
  trap 'kill "${a_pid:-}" 2>/dev/null || true; rm -f "${a_out:-}"' EXIT
  psql_test -Atq -c "begin; select count(*) from claim_deliveries(1, '${lead_id}'); select pg_sleep(5); commit;" \
    >"$a_out" 2>&1 &
  a_pid=$!

  sleep 1   # give A time to be inside its transaction, holding the row lock

  # Session B: a second, concurrent claimer — the drain and the inline
  # attempt really do overlap like this. With SKIP LOCKED it must move past
  # A's locked row and claim the OTHER pending one, fast. Wall time is
  # measured with date(1), not psql's own `\timing`, because a quick print
  # only proves psql was quick to print — not that the server didn't block
  # first, which is exactly the failure mode this check exists to catch.
  #
  # Guarded with `|| b_count=""` rather than left bare: under `set -e` a failed
  # command substitution exits the script on the spot, which here means exiting
  # BEFORE the `wait` below — leaving session A orphaned, still inside its
  # transaction, still holding the row lock, for as long as its pg_sleep runs.
  # A connection reset or a "too many connections" blip is exactly when that
  # would happen, i.e. exactly when a stray lock holder is least welcome.
  b_start_ns=$(date +%s%N)
  b_count="$(psql_test -Atq -c "select count(*) from claim_deliveries(1, '${lead_id}');")" || b_count=""
  b_end_ns=$(date +%s%N)
  b_elapsed_ms=$(( (b_end_ns - b_start_ns) / 1000000 ))

  wait "$a_pid" || true
  cat "$a_out"
  rm -f "$a_out"
  trap - EXIT

  if [[ -z "$b_count" ]]; then
    echo "db-test: FAIL skip-locked — session B's claim did not complete, so the check" \
         "could not be made (this is an error, not a pass)"
    skip_locked_ok=0
  elif [[ "$b_count" != "1" ]]; then
    echo "db-test: FAIL skip-locked — session B claimed $b_count rows, expected 1" \
         "(the row session A is holding must be skipped, not returned)"
    skip_locked_ok=0
  elif [[ "$b_elapsed_ms" -ge 1000 ]]; then
    echo "db-test: FAIL skip-locked — session B took ${b_elapsed_ms}ms, expected well under 1000ms" \
         "(it blocked on session A's lock instead of skipping it)"
    skip_locked_ok=0
  else
    echo "db-test: PASS skip-locked — session B claimed 1 row in ${b_elapsed_ms}ms while A held the other"
  fi
fi

if [[ $skip_locked_ok -eq 0 ]]; then
  failed_files+=("skip-locked-check")
fi

# --- summary -----------------------------------------------------------------
if [[ ${#failed_files[@]} -eq 0 ]]; then
  echo "db-test: all checks passed"
  exit 0
else
  echo "db-test: FAILED — ${failed_files[*]}"
  exit 1
fi
