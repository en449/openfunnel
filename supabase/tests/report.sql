-- ===========================================================================
-- Client report check — WO C1.
--
-- Same shape as state-machine.sql and otp.sql: one transaction ending in
-- ROLLBACK, every check an `assert` naming the rule it broke, runnable against
-- any database carrying this schema including a live one.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/report.sql
--
-- What is worth asserting here is not "a valid token returns a client". It is
-- the ways a report link stops being a control:
--
--   * a token that outlives its expiry, its revocation, or its client;
--   * a report that shows a lead the data subject has had deleted, restricted
--     (Art. 18 blocks export, and a report IS an export) or that is spam;
--   * a counter and a list that disagree, so a client reads "14 Anfragen" above
--     a table of 11;
--   * one client's leads reachable with another client's token — the failure
--     the whole `client_id` column exists to prevent.
--
-- None of these is visible from the runtime: `routes/report.js` only ever sees
-- "a row came back" or "it did not".
-- ===========================================================================

begin;

do $$
declare
  v_client_a  uuid;
  v_client_b  uuid;
  v_gone      uuid;
  v_funnel_a  uuid;
  v_funnel_b  uuid;
  v_tag       text := 'report-check-' || substr(gen_random_uuid()::text, 1, 8);
  -- The runtime hashes the token before it gets here (lib/report.js), so these
  -- stand in for sha256(token) exactly the way otp.sql's fixtures do.
  v_live      bytea := sha256('live-token'::bytea);
  v_expired   bytea := sha256('expired-token'::bytea);
  v_revoked   bytea := sha256('revoked-token'::bytea);
  v_orphan    bytea := sha256('deleted-client-token'::bytea);
  v_unknown   bytea := sha256('never-issued'::bytea);
  v_client_id uuid;
  v_seen      timestamptz;
  v_report    jsonb;
  v_n         int;
begin
  /* --- fixtures -------------------------------------------------------- */

  insert into client (name, slug, contact_email)
       values ('Client A', v_tag || '-a', 'a@example.invalid') returning id into v_client_a;
  insert into client (name, slug, contact_email)
       values ('Client B', v_tag || '-b', 'b@example.invalid') returning id into v_client_b;
  insert into client (name, slug, contact_email, deleted_at)
       values ('Gone', v_tag || '-gone', 'gone@example.invalid', now()) returning id into v_gone;

  insert into funnel (client_id, slug, name, doc)
       values (v_client_a, v_tag || '-fa', 'Funnel A', '{"steps":[]}'::jsonb) returning id into v_funnel_a;
  insert into funnel (client_id, slug, name, doc)
       values (v_client_b, v_tag || '-fb', 'Funnel B', '{"steps":[]}'::jsonb) returning id into v_funnel_b;

  -- Four leads for A: one ordinary, and one of each kind that must not appear.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a, v_client_a, '{"lead":{"email":"ok@example.invalid"}}'::jsonb);
  insert into lead (funnel_id, client_id, payload, deleted_at)
       values (v_funnel_a, v_client_a, '{"lead":{"email":"deleted@example.invalid"}}'::jsonb, now());
  insert into lead (funnel_id, client_id, payload, restricted)
       values (v_funnel_a, v_client_a, '{"lead":{"email":"restricted@example.invalid"}}'::jsonb, true);
  insert into lead (funnel_id, client_id, payload, is_spam)
       values (v_funnel_a, v_client_a, '{"lead":{"email":"spam@example.invalid"}}'::jsonb, true);

  -- One for B, which A's token must never be able to see.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_b, v_client_b, '{"lead":{"email":"b-only@example.invalid"}}'::jsonb);

  insert into report_token (client_id, token_hash, expires_at)
       values (v_client_a, v_live,    now() + interval '180 days');
  insert into report_token (client_id, token_hash, expires_at)
       values (v_client_a, v_expired, now() - interval '1 day');
  insert into report_token (client_id, token_hash, expires_at, revoked_at)
       values (v_client_a, v_revoked, now() + interval '180 days', now());
  insert into report_token (client_id, token_hash, expires_at)
       values (v_gone,     v_orphan,  now() + interval '180 days');

  /* --- resolving ------------------------------------------------------- */

  select r.client_id into v_client_id from resolve_report_token(v_live) r;
  assert v_client_id = v_client_a,
         'a live token must resolve to its own client';

  select t.last_seen_at into v_seen from report_token t where t.token_hash = v_live;
  assert v_seen is not null,
         'resolving must stamp last_seen_at — a link nobody opens has to be visible as such';

  -- The four refusals. Each returns NOTHING, and the runtime answers the same
  -- 404 to all of them: a report link that distinguishes "expired" from "never
  -- existed" tells a prober which half of a guess was right.
  select count(*) into v_n from resolve_report_token(v_expired);
  assert v_n = 0, 'an expired token must not resolve';

  select count(*) into v_n from resolve_report_token(v_revoked);
  assert v_n = 0, 'a revoked token must not resolve';

  -- Nobody revoked this one. The join to `client` is what stops a deleted
  -- client's links working, without anyone having to remember to.
  select count(*) into v_n from resolve_report_token(v_orphan);
  assert v_n = 0, 'a token belonging to a deleted client must not resolve';

  select count(*) into v_n from resolve_report_token(v_unknown);
  assert v_n = 0, 'an unknown digest must not resolve';

  -- A refusal must not stamp anything either: last_seen_at is the operator's
  -- signal that a link is in use, and a walker would otherwise light up every
  -- row they missed.
  select t.last_seen_at into v_seen from report_token t where t.token_hash = v_expired;
  assert v_seen is null, 'a refused token must not be stamped as seen';

  /* --- the report ------------------------------------------------------ */

  v_report := client_report(v_client_a);

  assert (v_report->>'total')::int = 1,
         format('deleted, restricted and spam leads must all be excluded from the count, got %s',
                v_report->>'total');
  assert jsonb_array_length(v_report->'leads') = 1,
         'the list must exclude exactly what the count excludes';

  -- The failure this shape exists to prevent: a counter and a list built from
  -- two copies of the predicate, drifting, so the client reads a number that
  -- does not match the rows under it.
  assert (v_report->>'total')::int = jsonb_array_length(v_report->'leads'),
         'below the cap, the count and the list must agree';

  assert v_report->'leads'->0->'payload'->'lead'->>'email' = 'ok@example.invalid',
         'the surviving lead must be the ordinary one';

  -- Art. 18 in particular: `cancel_pending_on_restrict` already stops the
  -- queue, and this is the same rule on the read side.
  assert not (v_report::text like '%restricted@example.invalid%'),
         'a restricted lead must not appear in an export';
  assert not (v_report::text like '%deleted@example.invalid%'),
         'a soft-deleted lead must not appear in a report';
  assert not (v_report::text like '%spam@example.invalid%'),
         'a spam lead must not appear in a report';

  /* --- isolation ------------------------------------------------------- */

  assert not (v_report::text like '%b-only@example.invalid%'),
         'one client''s report must never contain another client''s lead';

  v_report := client_report(v_client_b);
  assert (v_report->>'total')::int = 1 and v_report::text like '%b-only@example.invalid%',
         'client B must see its own lead and only its own';
  assert not (v_report::text like '%ok@example.invalid%'),
         'client B must not see client A''s lead';

  -- The per-funnel breakdown is scoped the same way. A funnel list that leaked
  -- would be a directory of the operator's other clients, which is the same
  -- reason `/api/funnels` is refused on a custom domain.
  assert not (client_report(v_client_b)::text like '%Funnel A%'),
         'the per-funnel breakdown must not name another client''s funnel';

  /* --- the breakdown adds up ------------------------------------------- */

  -- Archiving a funnel does not unmake the enquiries it produced, so its leads
  -- still count towards the total — and a breakdown that dropped the funnel
  -- would therefore stop summing to the number printed above it. An archived
  -- funnel with nothing to show is still hidden.
  update funnel set status = 'archived' where id = v_funnel_a;
  insert into funnel (client_id, slug, name, doc)
       values (v_client_a, v_tag || '-fempty', 'Archived Empty', '{"steps":[]}'::jsonb);
  update funnel set status = 'archived' where slug = v_tag || '-fempty';

  v_report := client_report(v_client_a);
  select coalesce(sum((f->>'total')::int), 0) into v_n
    from jsonb_array_elements(v_report->'funnels') f;
  assert v_n = (v_report->>'total')::int,
         format('the per-funnel breakdown must sum to the total, %s vs %s', v_n, v_report->>'total');
  assert not (v_report::text like '%Archived Empty%'),
         'an archived funnel with no leads must not be listed';

  update funnel set status = 'draft' where id = v_funnel_a;

  /* --- the cap --------------------------------------------------------- */

  -- Three more for A, then ask for two. The list is bounded; the numbers are
  -- not — a report that capped its own counter would tell a client they had
  -- fewer enquiries than they have.
  insert into lead (funnel_id, client_id, payload)
       select v_funnel_a, v_client_a, jsonb_build_object('lead', jsonb_build_object('email', i || '@example.invalid'))
         from generate_series(1, 3) i;

  v_report := client_report(v_client_a, 2);
  assert (v_report->>'total')::int = 4,
         format('the cap must bound the list, never the count, got %s', v_report->>'total');
  assert jsonb_array_length(v_report->'leads') = 2,
         'the cap must bound the list';

  raise notice 'report.sql: all assertions passed';
end $$;

rollback;
