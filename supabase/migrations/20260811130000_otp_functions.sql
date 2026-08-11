-- =========================================================================== --
--  WO10 — the email-verification challenge moves into Postgres.
--
--  The in-process version (`otpStore` / `verifiedEmails` in lib/email.js) is a
--  pair of `Map`s, which is correct for exactly one long-lived server and wrong
--  for every serverless deploy: the code issued by one invocation cannot be
--  verified by the next, so a visitor is told their valid code is invalid, and
--  `isEmailVerified` answers false for an address that just passed the
--  challenge — which silently downgrades `email_verified` on the stored lead.
--
--  The `otp` table (0001) already carries the shape. Three functions rather than
--  client-side reads and writes, for one reason: the attempt counter has to be
--  incremented under a lock. A select-then-update from the runtime is a lost
--  update, and a lost update on this counter turns a five-guess cap into an
--  unbounded one under parallel requests — which is the whole defence for a
--  six-digit secret.
--
--  Rollback:
--    drop function if exists is_email_verified, verify_otp, issue_otp;
-- =========================================================================== --

-- The code itself is never stored. The runtime hashes it with a salt before it
-- gets here, so this function never sees the secret and a database dump does not
-- contain one.
--
-- Issuing invalidates any live challenge for the same address: two valid codes
-- at once doubles the guessing surface for no benefit. CONSUMED rows are left
-- alone — a consumed row within the verified TTL *is* the verified-email record,
-- which is why there is no second table.
create or replace function issue_otp(
  p_email     text,
  p_code_hash bytea,
  p_ttl_ms    int,
  p_funnel_id uuid default null
) returns void language plpgsql volatile as $$
begin
  delete from otp where email = p_email and consumed_at is null;

  insert into otp (email, funnel_id, code_hash, expires_at)
       values (p_email, p_funnel_id, p_code_hash,
               now() + make_interval(secs => p_ttl_ms / 1000.0));

  -- Opportunistic GC, matching `sweepExpired()` in the code this replaces. Rows
  -- only ever stop being interesting; nothing reads a consumed row older than
  -- the verified TTL, and an unconsumed expired one is dead on arrival. A day is
  -- far past both and keeps the table from growing with every unfinished funnel.
  delete from otp where created_at < now() - interval '1 day';
end $$;

-- Returns true exactly once per code: the row is marked consumed, so a replay of
-- the same code answers false. The attempt is burned BEFORE the comparison, so a
-- wrong guess costs the same as a right one — five wrong answers invalidate the
-- challenge outright rather than merely being counted.
--
-- `for update` is the load-bearing word. Two concurrent guesses without it both
-- read `attempts = 0`, both write `attempts = 1`, and the cap never arrives.
--
-- The hash comparison is not constant-time. It does not need to be: the caller
-- supplies a six-digit code, not the digest, so reaching a byte-wise timing
-- signal would already require a preimage of the salted hash.
create or replace function verify_otp(
  p_email        text,
  p_code_hash    bytea,
  p_max_attempts int
) returns boolean language plpgsql volatile as $$
declare
  v_row      otp%rowtype;
  v_attempts int;
begin
  select * into v_row
    from otp
   where email = p_email
     and consumed_at is null
     and expires_at > now()
   order by created_at desc
   limit 1
     for update;

  if not found then return false; end if;

  update otp set attempts = attempts + 1
   where id = v_row.id
   returning attempts into v_attempts;

  if v_attempts > p_max_attempts then
    delete from otp where id = v_row.id;
    return false;
  end if;

  if v_row.code_hash = p_code_hash then
    update otp set consumed_at = now() where id = v_row.id;
    return true;
  end if;

  return false;
end $$;

-- Did this address actually pass a challenge recently? The browser can claim
-- `email_verified` in a lead payload; this is the only thing that decides
-- whether the claim is true.
create or replace function is_email_verified(
  p_email  text,
  p_ttl_ms int
) returns boolean language sql stable as $$
  select exists (
    select 1
      from otp
     where email = p_email
       and consumed_at is not null
       and consumed_at > now() - make_interval(secs => p_ttl_ms / 1000.0)
  );
$$;

-- Re-run the revocation from 0002: `alter default privileges` only covers
-- functions created later by the same role, and relying on that rather than an
-- explicit revoke is how a new function ends up callable with the public anon
-- key. Three new functions, three new ways in, if this is left out.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from public, anon, authenticated';
    execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
  end if;
end $$;
