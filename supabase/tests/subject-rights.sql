-- ===========================================================================
-- Subject-rights check — WO D3.
--
-- Same shape as report.sql: one transaction ending in ROLLBACK, every check an
-- `assert` naming the rule it broke, runnable against any database carrying
-- this schema including a live one.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/subject-rights.sql
--
-- What is worth asserting here is not "a matching lead is found or erased". It
-- is the ways this tool stops being safe to press: a needle that sweeps past
-- one client into another's inbox, a wildcard that turns "search" into
-- "delete everything", a digit comparison loose enough to collide, an erase
-- that quietly re-runs and re-reports what it already did. Each rule below is
-- pinned to a sentence in the migration's own header, not to whatever the
-- code happens to do today — see 20260819100000_subject_rights.sql.
-- ===========================================================================

begin;

do $$
declare
  v_tag                    text := 'subject-rights-' || substr(gen_random_uuid()::text, 1, 8);

  v_client_a                uuid;
  v_client_b                uuid;
  v_funnel_a1                uuid;
  v_funnel_a2                uuid;
  v_funnel_b1                uuid;

  v_lead_twin_a              uuid;
  v_lead_twin_b              uuid;
  v_lead_klaus                uuid;
  v_lead_deep                uuid;
  v_lead_nonscalar            uuid;
  v_lead_phone                uuid;
  v_lead_5digit                uuid;
  v_lead_count                uuid;
  v_lead_flag_ok               uuid;
  v_lead_flag_deleted          uuid;
  v_lead_flag_restricted       uuid;
  v_lead_flag_spam             uuid;
  v_lead_scope                 uuid;
  v_lead_queue                 uuid;
  v_lead_nosession             uuid;
  v_lead_c1                    uuid;
  v_lead_c2                    uuid;

  v_lead_emptysession           uuid;
  v_lead_shared_a                uuid;
  v_lead_shared_b                uuid;
  v_lead_resubmit_a               uuid;
  v_lead_resubmit_b               uuid;

  v_target_webhook             uuid;
  v_target_email               uuid;
  v_delivery_pending           bigint;
  v_delivery_delivering        bigint;

  -- scratch
  v_n           int;
  v_n2          int;
  v_n3          int;
  v_n4          int;
  v_lead_id     uuid;
  v_bool        boolean;
  v_text        text;
  v_deleted_at  timestamptz;
  v_deleted_at2 timestamptz;
  v_leads_deleted         int;
  v_leads_already_deleted int;
  v_events_deleted        int;
  v_leads_without_session int;
  v_shared_sessions       int;
  v_status_pending        text;
  v_status_delivering     text;
begin
  /* ======================================================================
   * FIXTURES — two clients, three funnels, one lead per scenario.
   * ==================================================================== */

  insert into client (name, slug, contact_email)
       values ('Client A', v_tag || '-a', 'a@example.invalid') returning id into v_client_a;
  insert into client (name, slug, contact_email)
       values ('Client B', v_tag || '-b', 'b@example.invalid') returning id into v_client_b;

  insert into funnel (client_id, slug, name, doc)
       values (v_client_a, v_tag || '-fa1', 'Funnel A1', '{"steps":[]}'::jsonb) returning id into v_funnel_a1;
  insert into funnel (client_id, slug, name, doc)
       values (v_client_a, v_tag || '-fa2', 'Funnel A2', '{"steps":[]}'::jsonb) returning id into v_funnel_a2;
  insert into funnel (client_id, slug, name, doc)
       values (v_client_b, v_tag || '-fb1', 'Funnel B1', '{"steps":[]}'::jsonb) returning id into v_funnel_b1;

  -- #1/#2/#15: identical email on both clients. This is the pair the whole
  -- client_id column exists for — a needle that leaked across it would find,
  -- and then erase, a stranger's inbox.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"twin@example.invalid"},"sessionId":"sess-twin-a"}'::jsonb)
       returning id into v_lead_twin_a;
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_b1, v_client_b,
               '{"lead":{"email":"twin@example.invalid"},"sessionId":"sess-twin-b"}'::jsonb)
       returning id into v_lead_twin_b;
  insert into event (funnel_id, session_id, type)
       values (v_funnel_b1, 'sess-twin-b', 'view');

  -- #3b/#4: an email carrying both an "@" and a ".de" substring, so a matcher
  -- that was actually `ilike '%'||needle||'%'` would find it for wildcards
  -- that must match nothing.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"klaus@example.de"}}'::jsonb)
       returning id into v_lead_klaus;

  -- #5: the needle is buried inside an object inside an array inside an
  -- object. jsonb_path_query('$.**') is what makes this reachable without the
  -- matcher knowing the payload's shape.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"contact":{"channels":[{"type":"email","value":"buried@example.invalid"}]}}}'::jsonb)
       returning id into v_lead_deep;

  -- #6: an object and an array whose own jsonb text representation is chosen
  -- to equal the needle used below. Only reachable if the typeof('string',
  -- 'number') filter is ever dropped.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               ('{"lead":{"email":"nonscalar-holder@example.invalid"},'
               || '"meta":{"note":"private@example.invalid"},'
               || '"tags":["contact@example.invalid"]}')::jsonb)
       returning id into v_lead_nonscalar;

  -- #7: a phone number as the lead actually submitted it — country code, no
  -- leading zero.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"phone":"+49 170 1234567"}}'::jsonb)
       returning id into v_lead_phone;

  -- #8: five digits, differently punctuated in the needle than in the value.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"other":"12-345"}}'::jsonb)
       returning id into v_lead_5digit;

  -- #11: three events on one (funnel, session) pair, to prove event_count
  -- counts rather than assumes.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"count-check@example.invalid"},"sessionId":"sess-count-check"}'::jsonb)
       returning id into v_lead_count;
  insert into event (funnel_id, session_id, type)
       select v_funnel_a1, 'sess-count-check', t from unnest(array['view','step','submit']) t;

  -- #10: one email, four leads — ordinary, soft-deleted, restricted, spam.
  -- find_subject is the operator's OWN answer to "what is held about this
  -- person" and has to show all four, flags included, unlike client_report.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"flagged@example.invalid"}}'::jsonb)
       returning id into v_lead_flag_ok;
  insert into lead (funnel_id, client_id, payload, deleted_at)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"flagged@example.invalid"}}'::jsonb, now())
       returning id into v_lead_flag_deleted;
  insert into lead (funnel_id, client_id, payload, restricted)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"flagged@example.invalid"}}'::jsonb, true)
       returning id into v_lead_flag_restricted;
  insert into lead (funnel_id, client_id, payload, is_spam)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"flagged@example.invalid"}}'::jsonb, true)
       returning id into v_lead_flag_spam;

  -- #12: same session id in two funnels. Only `event_session_idx`'s own
  -- funnel_id column stops the delete from reaching the wrong funnel's rows.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"scope-check@example.invalid"},"sessionId":"sess-scope"}'::jsonb)
       returning id into v_lead_scope;
  insert into event (funnel_id, session_id, type)
       select v_funnel_a1, 'sess-scope', t from unnest(array['view','submit']) t;
  insert into event (funnel_id, session_id, type)
       values (v_funnel_a2, 'sess-scope', 'view');

  -- #14: a lead with one pending and one in-flight delivery, so erasing it
  -- exercises lead_restrict_cancels_pending (20260811120100) for real.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"queue-check@example.invalid"}}'::jsonb)
       returning id into v_lead_queue;
  insert into delivery_target (client_id, funnel_id, kind, config)
       values (v_client_a, null, 'webhook', '{}'::jsonb) returning id into v_target_webhook;
  insert into delivery_target (client_id, funnel_id, kind, config)
       values (v_client_a, null, 'email', '{}'::jsonb) returning id into v_target_email;
  insert into delivery (lead_id, target_id, status)
       values (v_lead_queue, v_target_webhook, 'pending') returning id into v_delivery_pending;
  insert into delivery (lead_id, target_id, status)
       values (v_lead_queue, v_target_email, 'delivering') returning id into v_delivery_delivering;

  -- #16: a matching lead with no sessionId at all — an older row, or a direct
  -- API post. Its events (there are none reachable) must not be claimed.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"nosession-check@example.invalid"}}'::jsonb)
       returning id into v_lead_nosession;

  -- #18: `sessionId: ""` reaches this table because /api/lead validates
  -- nothing about it. The event carries the same empty string, inserted
  -- directly — /api/events refuses one, but the SQL must not lean on a guard
  -- that lives in a JavaScript file it cannot see.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"emptysession-check@example.invalid"},"sessionId":""}'::jsonb)
       returning id into v_lead_emptysession;
  insert into event (funnel_id, session_id, type)
       values (v_funnel_a1, '', 'view');

  -- #19/#20: two different people, one funnel-minted session — a kiosk reset
  -- between visitors. Both rows are needed to prove the flag/count reads the
  -- OTHER lead, not itself.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"shareda@example.invalid"},"sessionId":"sess-shared"}'::jsonb)
       returning id into v_lead_shared_a;
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"sharedb@example.invalid"},"sessionId":"sess-shared"}'::jsonb)
       returning id into v_lead_shared_b;
  insert into event (funnel_id, session_id, type)
       select v_funnel_a1, 'sess-shared', t from unnest(array['view','submit']) t;

  -- #21: the SAME person, twice — a resubmit on the same browsing session
  -- after dedupeKey()'s 10-minute window rolls over (apps/runtime storeLead
  -- path). One email, one session, two lead rows. Neither `find_subject` nor
  -- `erase_subject` may call this "shared" — the only other lead on the
  -- session is this same search's own other result, not a stranger.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"resubmit@example.invalid"},"sessionId":"sess-resubmit"}'::jsonb)
       returning id into v_lead_resubmit_a;
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a,
               '{"lead":{"email":"resubmit@example.invalid"},"sessionId":"sess-resubmit"}'::jsonb)
       returning id into v_lead_resubmit_b;
  insert into event (funnel_id, session_id, type)
       select v_funnel_a1, 'sess-resubmit', t from unnest(array['view','submit']) t;

  -- #17: two more, erased back-to-back with no gap between the calls.
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"callone-check@example.invalid"}}'::jsonb)
       returning id into v_lead_c1;
  insert into lead (funnel_id, client_id, payload)
       values (v_funnel_a1, v_client_a, '{"lead":{"email":"calltwo-check@example.invalid"}}'::jsonb)
       returning id into v_lead_c2;

  /* ======================================================================
   * #1 — Client scoping on the search.
   * ==================================================================== */

  select count(*), bool_or(lead_id = v_lead_twin_b)
    into v_n, v_bool
    from find_subject(v_client_a, 'twin@example.invalid');
  assert v_n = 1 and coalesce(v_bool, false) = false,
         format('client A''s search must return only its own lead, got %s rows and client B leaked = %s',
                v_n, v_bool);

  /* ======================================================================
   * #2 / #13 — Client scoping on the DELETE, and the delete is SOFT.
   *
   * The hard delete of a soft-deleted row past 24h is WO D5, which does not
   * exist yet — this migration only ever stamps deleted_at.
   * ==================================================================== */

  select leads_deleted, leads_already_deleted, events_deleted, leads_without_session
    into v_leads_deleted, v_leads_already_deleted, v_events_deleted, v_leads_without_session
    from erase_subject(v_client_a, 'twin@example.invalid');
  assert v_leads_deleted = 1, format('erasing client A''s twin must delete exactly 1 lead, got %s', v_leads_deleted);

  select deleted_at into v_deleted_at from lead where id = v_lead_twin_a;
  assert v_deleted_at is not null,
         'erase_subject must SOFT-delete: the row stays, only deleted_at is stamped';

  select deleted_at into v_deleted_at from lead where id = v_lead_twin_b;
  assert v_deleted_at is null,
         'client B''s identical lead must be completely untouched by client A''s erase — this is what client_id is for';
  select count(*) into v_n from event where funnel_id = v_funnel_b1 and session_id = 'sess-twin-b';
  assert v_n = 1, 'client B''s events must survive client A''s erase call intact';

  /* ======================================================================
   * #3 — Equality, never substring.
   *
   * subject_matches() called directly: an "@" or a "." is a character every
   * email contains, so a substring interpretation here is not a rare edge
   * case, it is the common one.
   * ==================================================================== */

  select subject_matches('{"lead":{"email":"klaus@example.de"}}'::jsonb, '%')      into v_bool;
  assert v_bool = false, 'a bare "%" must match nothing, not every lead in the client''s inbox';
  select subject_matches('{"lead":{"email":"klaus@example.de"}}'::jsonb, '@')      into v_bool;
  assert v_bool = false, 'a bare "@" must match nothing, not every lead that has an email address';
  select subject_matches('{"lead":{"email":"klaus@example.de"}}'::jsonb, '%@%')    into v_bool;
  assert v_bool = false, '"%@%" must not ilike-match an email containing "@" — there is no ilike here';
  select subject_matches('{"lead":{"email":"klaus@example.de"}}'::jsonb, '___')    into v_bool;
  assert v_bool = false, 'three underscores must not wildcard-match a three-character run inside the email';
  select subject_matches('{"lead":{"email":"klaus@example.de"}}'::jsonb, '%.de')   into v_bool;
  assert v_bool = false, '"%.de" must not suffix-match every .de address — that is every German lead at once';

  -- The needles above that clear the 3-character guard, run for real through
  -- erase_subject against a client whose leads DO contain "@" and ".de". If
  -- the matcher were ever "fixed" into an ilike, this is where the inbox
  -- disappears.
  select count(*) into v_n from lead where client_id = v_client_a and deleted_at is null;
  select leads_deleted into v_leads_deleted from erase_subject(v_client_a, '%@%');
  assert v_leads_deleted = 0, format('"%%@%%" must delete nothing, deleted %s', v_leads_deleted);
  select leads_deleted into v_leads_deleted from erase_subject(v_client_a, '%.de');
  assert v_leads_deleted = 0, format('"%%.de" must delete nothing, deleted %s', v_leads_deleted);
  select count(*) into v_n2 from lead where client_id = v_client_a and deleted_at is null;
  assert v_n = v_n2,
         format('a wildcard needle must leave the client''s inbox exactly as large as it was, %s before vs %s after',
                v_n, v_n2);

  /* ======================================================================
   * #4 — Case folding and surrounding whitespace.
   * ==================================================================== */

  select count(*), bool_or(lead_id = v_lead_klaus)
    into v_n, v_bool
    from find_subject(v_client_a, '  KLAUS@Example.DE  ');
  assert v_n >= 1 and v_bool,
         'a needle padded with spaces and mixed case must still find "klaus@example.de" — the operator retyping a name should not be the reason a request goes unanswered';

  /* ======================================================================
   * #5 — Depth.
   * ==================================================================== */

  select bool_or(lead_id = v_lead_deep) into v_bool
    from find_subject(v_client_a, 'buried@example.invalid');
  assert v_bool, 'a value nested object-in-array-in-object must be reached, so a payload shape the console adds later is not a blind spot on day one';

  /* ======================================================================
   * #6 — A non-scalar is not a match.
   * ==================================================================== */

  select count(*) into v_n
    from find_subject(v_client_a, '{"note": "private@example.invalid"}');
  assert v_n = 0,
         'an object that happens to stringify to the needle must not match — an object is not a person''s email address';
  select count(*) into v_n
    from find_subject(v_client_a, '["contact@example.invalid"]');
  assert v_n = 0,
         'an array that happens to stringify to the needle must not match, for the same reason';

  /* ======================================================================
   * #7 — Phone: formatting differences match, a different digit string does not.
   * ==================================================================== */

  select bool_or(lead_id = v_lead_phone) into v_bool
    from find_subject(v_client_a, '+49-170-1234567');
  assert v_bool, 'hyphenated punctuation around the same digits must still match the stored "+49 170 1234567"';

  select bool_or(lead_id = v_lead_phone) into v_bool
    from find_subject(v_client_a, '(49) 170 1234567');
  assert v_bool, 'parenthesised punctuation around the same digits must still match';

  select count(*) into v_n
    from find_subject(v_client_a, '01701234567');
  assert v_n = 0,
         'a national "0" in place of the "+49" country code is a DIFFERENT digit string and must not match — this is the documented limitation, not a bug to "fix" into a suffix match';

  /* ======================================================================
   * #8 — The 6-digit floor on the digit comparison.
   * ==================================================================== */

  select count(*) into v_n
    from find_subject(v_client_a, '1.2.3.4.5');
  assert v_n = 0,
         'a 5-digit needle must not digit-match "12-345" even though the digits are identical — under the 6-digit floor this comparison is never attempted, it does not merely fail';

  /* ======================================================================
   * #9 — Short needles are refused, not answered empty.
   * ==================================================================== */

  begin
    perform find_subject(v_client_a, 'ab');
    assert false, 'find_subject must RAISE on a 2-character needle — "nothing is held" and "you searched for nothing" must not look the same';
  exception when others then
    null;
  end;

  begin
    perform erase_subject(v_client_a, 'ab');
    assert false, 'erase_subject must RAISE on a 2-character needle for the same reason, at the button that actually deletes';
  exception when others then
    null;
  end;

  /* ======================================================================
   * #10 — find_subject returns soft-deleted, restricted and spam rows, WITH
   * their flags. The deliberate opposite of client_report, which excludes
   * all three: that function answers the CLIENT, this one answers the DATA
   * SUBJECT, who is entitled to know a row is restricted or pending deletion.
   * ==================================================================== */

  select count(*),
         count(*) filter (where deleted_at is not null),
         count(*) filter (where restricted),
         count(*) filter (where is_spam)
    into v_n, v_n2, v_n3, v_n4
    from find_subject(v_client_a, 'flagged@example.invalid');
  assert v_n = 4, format('all four leads sharing this email must come back, got %s', v_n);
  assert v_n2 = 1, 'the soft-deleted row must appear, flagged as deleted';
  assert v_n3 = 1, 'the restricted row must appear, flagged as restricted';
  assert v_n4 = 1, 'the spam row must appear, flagged as spam';

  /* ======================================================================
   * #11 — event_count.
   * ==================================================================== */

  select event_count into v_n
    from find_subject(v_client_a, 'count-check@example.invalid');
  assert v_n = 3,
         format('event_count must equal the actual number of event rows for this lead''s (funnel_id, session_id), got %s', v_n);

  /* ======================================================================
   * #12 — Events are deleted, scoped by funnel.
   * ==================================================================== */

  select events_deleted, shared_sessions into v_events_deleted, v_shared_sessions
    from erase_subject(v_client_a, 'scope-check@example.invalid');
  assert v_events_deleted = 2, format('the 2 events in the lead''s own funnel must be deleted, got %s', v_events_deleted);
  -- The negative control for #19, and it belongs here rather than there: nobody
  -- else sits on this lead's session, so the count MUST be zero. Without this
  -- line #19's `shared_sessions = 1` passes just as happily when the `shared` CTE
  -- self-matches and reports every session as shared — the buggy and the correct
  -- answer coincide on a genuinely shared fixture. A positive assertion about a
  -- counter needs a zero beside it or it pins nothing.
  assert v_shared_sessions = 0,
         format('nobody shares this lead''s session, so shared_sessions must be 0, got %s', v_shared_sessions);

  select count(*) into v_n from event where funnel_id = v_funnel_a1 and session_id = 'sess-scope';
  assert v_n = 0, 'events in the erased lead''s own funnel must be gone';
  select count(*) into v_n from event where funnel_id = v_funnel_a2 and session_id = 'sess-scope';
  assert v_n = 1,
         'an event carrying the SAME session id in a DIFFERENT funnel must survive — nothing but the payload joins a lead to its events, and that join is scoped by funnel_id';

  /* ======================================================================
   * #14 — The outbound queue stops, through the existing trigger.
   * ==================================================================== */

  perform erase_subject(v_client_a, 'queue-check@example.invalid');

  select status into v_status_pending    from delivery where id = v_delivery_pending;
  select status into v_status_delivering from delivery where id = v_delivery_delivering;
  assert v_status_pending = 'cancelled',
         format('a pending delivery for an erased lead must be cancelled by lead_restrict_cancels_pending, got %s', v_status_pending);
  assert v_status_delivering = 'delivering',
         format('a delivery already in flight must NOT be cancelled — the lease is live and the receipt must not claim otherwise, got %s', v_status_delivering);

  /* ======================================================================
   * #15 — Idempotence.
   * ==================================================================== */

  select deleted_at into v_deleted_at from lead where id = v_lead_twin_a;
  select leads_deleted, leads_already_deleted
    into v_leads_deleted, v_leads_already_deleted
    from erase_subject(v_client_a, 'twin@example.invalid');
  assert v_leads_deleted = 0,
         format('a second erase of the same person must delete nothing new, got leads_deleted = %s', v_leads_deleted);
  assert v_leads_already_deleted = 1,
         format('a second erase must report the lead as already deleted, got %s', v_leads_already_deleted);
  select deleted_at into v_deleted_at2 from lead where id = v_lead_twin_a;
  assert v_deleted_at = v_deleted_at2,
         'a second erase must not re-stamp deleted_at — the receipt would then imply a second deletion event that never happened';

  /* ======================================================================
   * #16 — leads_without_session is counted honestly.
   * ==================================================================== */

  select leads_deleted, events_deleted, leads_without_session
    into v_leads_deleted, v_events_deleted, v_leads_without_session
    from erase_subject(v_client_a, 'nosession-check@example.invalid');
  assert v_leads_deleted = 1, 'the payload-less-session lead must still be deleted';
  assert v_leads_without_session = 1,
         format('a matching lead with no sessionId must be counted honestly rather than silently dropped, got %s', v_leads_without_session);
  assert v_events_deleted = 0,
         'a lead with no reachable session must not have events claimed as deleted on its behalf — there is nothing to reach';

  /* ======================================================================
   * #17 — erase_subject can be called twice in ONE transaction.
   *
   * The first draft used `create temporary table` inside the function body,
   * which dies on the table name the second time it runs in the same
   * transaction — exactly the shape every file in supabase/tests/ has, since
   * each one is itself one begin/rollback. This whole file has already called
   * erase_subject six times above; these two calls, back to back with nothing
   * between them, are the assertion made explicit.
   * ==================================================================== */

  select leads_deleted into v_leads_deleted from erase_subject(v_client_a, 'callone-check@example.invalid');
  assert v_leads_deleted = 1, 'the first of two same-transaction erase_subject calls must succeed';
  select leads_deleted into v_leads_deleted from erase_subject(v_client_a, 'calltwo-check@example.invalid');
  assert v_leads_deleted = 1,
         'the second same-transaction erase_subject call must also succeed — a temporary-table body would have raised "relation already exists" here';

  /* ======================================================================
   * #18 — An empty sessionId counts as no session.
   *
   * `/api/lead` validates nothing about `record.sessionId`, so `""` reaches
   * this table. Without the `nullif(…, '')` wrappers it read as "has a
   * session", which under-counted leads_without_session and let an empty
   * string equal itself against an equally-empty event.session_id — a join
   * that looks like completeness and is actually two absences agreeing.
   * ==================================================================== */

  select session_id, event_count into v_text, v_n
    from find_subject(v_client_a, 'emptysession-check@example.invalid');
  assert v_text is null,
         format('an empty sessionId must read back as NULL, not the empty string, got %L', v_text);
  assert v_n = 0, format('a lead with no reachable session must report event_count = 0, got %s', v_n);

  select leads_deleted, events_deleted, leads_without_session
    into v_leads_deleted, v_events_deleted, v_leads_without_session
    from erase_subject(v_client_a, 'emptysession-check@example.invalid');
  assert v_leads_deleted = 1, 'the empty-sessionId lead must still be deleted';
  assert v_leads_without_session = 1,
         format('an empty sessionId must be counted as NO session, got leads_without_session = %s', v_leads_without_session);
  assert v_events_deleted = 0,
         'an empty sessionId must not be treated as a join key — nothing may be claimed as deleted on its behalf';

  select count(*) into v_n from event where funnel_id = v_funnel_a1 and session_id = '';
  assert v_n = 1,
         'an event that happens to carry session_id = '''' in the same funnel must survive — two absences are not the same session';

  /* ======================================================================
   * #19 — A shared session is counted, not hidden.
   *
   * Two people, one funnel-minted session. Erasing one deletes the whole
   * mixed trail — deliberately: the trail is partly about the person who
   * asked, there is no way to split it, and a stranger's behavioural event is
   * not worth failing an Art. 17 request over. What must not happen quietly
   * is the OTHER person's lead row being touched, or the operator never
   * learning the number covers more than one visitor.
   * ==================================================================== */

  select leads_deleted, shared_sessions, events_deleted
    into v_leads_deleted, v_shared_sessions, v_events_deleted
    from erase_subject(v_client_a, 'sharedb@example.invalid');
  assert v_leads_deleted = 1, 'erasing person B must delete exactly their own lead row';
  assert v_shared_sessions = 1,
         format('the emptied session is sat on by person A''s still-live lead and must be counted, got shared_sessions = %s', v_shared_sessions);
  assert v_events_deleted = 2,
         format('the shared session''s events must be deleted along with person B''s trail — this is the deliberate choice, not a bug, got %s', v_events_deleted);

  select count(*) into v_n from event where funnel_id = v_funnel_a1 and session_id = 'sess-shared';
  assert v_n = 0, 'the shared session''s events must actually be gone, not merely counted as gone';

  select deleted_at into v_deleted_at from lead where id = v_lead_shared_a;
  assert v_deleted_at is null,
         'person A''s own lead row must be untouched — a shared SESSION is erased, never a stranger''s LEAD';

  /* ======================================================================
   * #20 — find_subject flags a shared session, per row.
   *
   * `session_shared` doesn't gate on deleted_at, so it still reads correctly
   * for a lead this file has already erased — the operator may re-read a
   * request after acting on it, and the flag must not go stale.
   * ==================================================================== */

  select session_shared into v_bool from find_subject(v_client_a, 'shareda@example.invalid');
  assert v_bool, 'person A''s row must be flagged session_shared — their session is also on person B''s (erased) lead';

  select session_shared into v_bool from find_subject(v_client_a, 'sharedb@example.invalid');
  assert v_bool, 'person B''s row must be flagged session_shared too, even after being erased earlier in this file';

  select session_shared into v_bool from find_subject(v_client_a, 'scope-check@example.invalid');
  assert v_bool = false,
         'a lead whose session nobody else shares must read session_shared = false, not merely unset';

  /* ======================================================================
   * #21 — find_subject and erase_subject AGREE, including on the one
   * fixture that made them disagree in review: one person, two leads, one
   * session (a resubmit after the dedupe window rolls over). This is not
   * "assert each side separately" — a fixture where the two functions
   * answered the SAME question DIFFERENTLY (session_shared = true here while
   * shared_sessions = 0) is the exact failure this assertion exists to
   * catch, and it only shows up by checking both against one fixture.
   * ==================================================================== */

  select count(*), count(*) filter (where session_shared)
    into v_n, v_n2
    from find_subject(v_client_a, 'resubmit@example.invalid');
  assert v_n = 2, format('both resubmitted leads must come back, got %s', v_n);
  assert v_n2 = 0,
         format('neither resubmit row may be flagged session_shared — the only other lead on the session is this same search''s own other result, not a stranger, got %s flagged', v_n2);

  select leads_deleted, shared_sessions
    into v_leads_deleted, v_shared_sessions
    from erase_subject(v_client_a, 'resubmit@example.invalid');
  assert v_leads_deleted = 2, format('erasing this person must delete both of their lead rows, got %s', v_leads_deleted);
  assert v_shared_sessions = 0,
         format('the emptied session belongs entirely to this erasure''s own targets, so shared_sessions must be 0, got %s — a search that says "shared" while the delete says "not shared" about the same session is the bug find_subject.session_shared exists to not have', v_shared_sessions);

  raise notice 'subject-rights.sql: all assertions passed';
end $$;

rollback;
