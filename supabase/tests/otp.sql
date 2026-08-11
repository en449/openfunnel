-- ===========================================================================
-- Email-verification challenge check.
--
-- Same shape as state-machine.sql: one transaction ending in ROLLBACK, every
-- check an `assert` naming the rule it broke, runnable against any database
-- carrying this schema including a live one.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/otp.sql
--
-- What is worth asserting here is not "a correct code verifies". It is the
-- four ways the challenge stops being a secret: a code that survives more
-- guesses than the cap allows, a code that can be replayed after it was
-- consumed, an expired code that still works, and a verified-email record that
-- a later `issue_otp` quietly deletes. Each one is a live account takeover for
-- a six-digit number, and none of them is visible from the runtime — the
-- runtime only ever sees a boolean.
--
-- Codes are never stored, so the fixtures below hash a stand-in the same way
-- `hashOtpCode` in lib/email.js does: salted SHA-256, `\x` hex, email folded in.
-- ===========================================================================

begin;

do $$
declare
  v_email    text := 'otp-check-' || gen_random_uuid() || '@example.invalid';
  v_right    bytea := sha256(('salt:' || 'right')::bytea);
  v_wrong    bytea := sha256(('salt:' || 'wrong')::bytea);
  v_attempts int;
  v_n        int;
  v_consumed timestamptz;
begin
  /* --- issuing -------------------------------------------------------- */

  perform issue_otp(v_email, v_right, 600000);
  assert (select count(*) from otp where email = v_email and consumed_at is null) = 1,
         'issue_otp must leave exactly one live challenge';

  -- A second send invalidates the first: two valid codes at once doubles the
  -- guessing surface and buys nothing.
  perform issue_otp(v_email, v_right, 600000);
  assert (select count(*) from otp where email = v_email and consumed_at is null) = 1,
         'a new challenge must replace the previous live one, not stack on it';

  /* --- the attempt cap ------------------------------------------------ */

  -- Five wrong guesses are counted; the sixth destroys the challenge. This
  -- matches OTP_MAX_ATTEMPTS in lib/email.js, and the parity matters — the
  -- fallback path and this one must not disagree about how many guesses a
  -- six-digit number is worth.
  for i in 1..5 loop
    assert verify_otp(v_email, v_wrong, 5) = false, 'a wrong code must not verify';
  end loop;

  select attempts into v_attempts from otp where email = v_email and consumed_at is null;
  assert v_attempts = 5, format('five guesses must burn five attempts, found %s', v_attempts);

  -- The row is gone after the cap is passed, so the RIGHT code no longer works
  -- either. That is the point: exhausting the guesses invalidates the
  -- challenge rather than merely refusing one more guess.
  assert verify_otp(v_email, v_wrong, 5) = false, 'the sixth guess must fail';
  assert (select count(*) from otp where email = v_email and consumed_at is null) = 0,
         'passing the attempt cap must destroy the challenge, not leave it live';
  assert verify_otp(v_email, v_right, 5) = false,
         'a correct code must not verify once the attempt cap destroyed the challenge';

  /* --- the happy path, exactly once ------------------------------------ */

  perform issue_otp(v_email, v_right, 600000);
  assert verify_otp(v_email, v_right, 5) = true, 'the correct code must verify';

  select consumed_at into v_consumed from otp where email = v_email and consumed_at is not null;
  assert v_consumed is not null, 'a successful verification must mark the row consumed';

  -- Replay. The same code presented twice must not verify twice, or a code
  -- read from a mailbox stays usable for the rest of its TTL.
  assert verify_otp(v_email, v_right, 5) = false, 'a consumed code must not verify again';

  /* --- the verified-email record --------------------------------------- */

  assert is_email_verified(v_email, 1800000) = true,
         'a consumed challenge within the TTL is the verified-email record';

  -- A negative TTL puts the cutoff in the future, which is how "the record has
  -- aged out" is expressed without waiting.
  assert is_email_verified(v_email, -1000) = false,
         'a verified record older than the TTL must stop counting as verified';

  assert is_email_verified('someone-else@example.invalid', 1800000) = false,
         'verification must not leak across addresses';

  -- The load-bearing one. `issue_otp` deletes live challenges for the address
  -- so a resend cannot leave two valid codes — and the verified-email record is
  -- a row in the SAME table. If that delete were not scoped to unconsumed rows,
  -- every resend would silently revoke a verification the visitor had already
  -- completed, and ingest would then write email_verified: false onto a lead
  -- that was verified.
  perform issue_otp(v_email, v_wrong, 600000);
  assert is_email_verified(v_email, 1800000) = true,
         'issuing a new challenge must not delete the verified-email record';

  /* --- expiry ---------------------------------------------------------- */

  -- Issued already expired. An expired challenge is invisible to verify_otp,
  -- so the code in a mailbox stops working when it says it does.
  perform issue_otp(v_email, v_right, -1000);
  assert verify_otp(v_email, v_right, 5) = false, 'an expired challenge must not verify';

  select count(*) into v_n from otp where email = v_email;
  assert v_n >= 2, 'the fixtures above should have left both a consumed and an expired row';

  raise notice 'otp check: all assertions passed';
end $$;

rollback;
