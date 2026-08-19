-- ===========================================================================
-- Phase 2 WO D3 — data subject rights: find one person, erase one person.
--
-- Design and rationale: PHASE-2-PLAN.md §4 Decisions 2 and 3, PLAN.md §8.6 and
-- §8.7. Art. 15 (Auskunft) and Art. 17 (Löschung) are one mechanism used twice:
-- find every lead belonging to one person within one client. Built once, as
-- `subject_matches`, and both entry points call it.
--
-- WHY ONE MATCHER AND NOT TWO
-- Building the search and the deletion separately is how the two come to
-- disagree about what "everything held" means — and a subject-rights tool whose
-- search finds three records while its delete removes two is a one-month
-- statutory deadline that cannot be met. `find_subject` is what the operator
-- reads before pressing the button, so it has to be the same question the button
-- asks. Every predicate lives in `subject_matches`.
--
-- WHY THE MATCH IS EQUALITY AND NEVER A SUBSTRING
-- This matcher DELETES. A substring needle of `%`, or `@`, or one common digit
-- would match every lead the client has, and the tool built to honour one
-- person's rights would erase the client's entire inbox on a sloppy search.
-- So: case-folded equality for a text value, digits-only equality for a phone
-- (minimum 6 digits, so a short number cannot sweep), and a needle under three
-- characters matches nothing at all — enforced inside the matcher as well as at
-- both entry points, because the entry points are what a later edit adds a third
-- of. There is no `like`, no `ilike` and no `position()` in this file.
--
-- The cost of that choice, stated rather than discovered later: a phone number
-- submitted as `+49 170 1234567` and searched as `01701234567` does NOT match,
-- because one carries a country code and the other a national zero and there is
-- no way to reconcile them that is not a guess. Search with the form the lead
-- submitted; email is the reliable identifier. A country-code normaliser can be
-- added when there are real cases to write it against — inventing one now would
-- put a heuristic inside a function that deletes.
--
-- WHY THE GIN INDEX DOES NOT HELP
-- `lead_payload_idx` is `gin (payload jsonb_path_ops)`, which supports
-- containment and nothing else — no case folding, no digit stripping, no
-- match-at-any-depth. This walk is a sequential scan over one client's leads
-- whatever we write, and at Free-tier volume that is fine. It is scoped by
-- `client_id`, which `lead_client_idx` does serve, so the scan is over one
-- client's rows and never the whole table.
--
-- WHY STORAGE IS NOT PART OF THE WALK
-- Nothing links a Storage object to a data subject. The ingest path stores no
-- uploads at all — `file` is absent from the console's field types — so every
-- object under `funnel/<slug>/` is the OPERATOR's marketing photography, put
-- there by the console (PHASE-2-PLAN.md §1). Walking Storage per subject is not
-- merely hard, it has no meaning. If a funnel ever gains a real upload field,
-- that is the moment a Storage object becomes subject data and this decision has
-- to be reopened in the same change.
--
-- WHY `event` IS REACHED THROUGH THE PAYLOAD
-- `event` carries `session_id text` and no lead foreign key. `storeLead()`
-- strips only `ip` / `user_agent` / `utm` / `referer` before `ingest_lead`, so
-- `payload->>'sessionId'` survives on the lead row and is the only join there
-- is. A lead whose payload has no `sessionId` — an older row, a direct API post
-- — leaves its events behind, and `erase_subject` RETURNS THAT COUNT rather than
-- claiming a completeness it does not have.
--
-- An EMPTY `sessionId` is no session, and that is enforced here rather than
-- upstream. `/api/lead` performs no validation on `record.sessionId` at all — the
-- lead payload is the public request body minus four fields — so `sessionId: ""`
-- reaches this table whenever someone posts it. Every read of the field in this
-- file therefore goes through `nullif(…, '')`. `/api/events` does refuse an empty
-- session id, so no `event` row can carry one today; relying on that would make
-- this function's correctness depend on a guard in a JavaScript file it cannot
-- see, and a second write path to `event` would break it silently.
--
-- A SESSION IS NOT A PERSON, AND THE RECEIPT SAYS SO
-- `sessionId` is minted once per mounted funnel and lives for that browsing
-- session — not per human. Two people can share one: a tablet on a trade-fair
-- stand, a shared family browser, a kiosk reset between visitors. Both submits
-- become two `lead` rows with two different email addresses and ONE session, and
-- the events under that session are then a mixture of two people's behaviour that
-- nothing in the data can separate.
--
-- Erasing one of them deletes that whole mixed trail. That is the deliberate
-- choice: the trail is partly about the person who asked, there is no way to
-- split it, and a behavioural event the other visitor never asked to keep is not
-- worth failing an Art. 17 request over. What is NOT acceptable is doing it
-- quietly, so `erase_subject` counts those sessions into `shared_sessions` and
-- `find_subject` flags them per row with `session_shared`. The operator writing
-- the reply can then see that a number covers more than one visitor, which is the
-- whole reason the search and the delete are the same query.
--
-- WHAT THIS DELETE IS, AND WHAT IT IS NOT YET
-- `erase_subject` SOFT-deletes: it stamps `lead.deleted_at`. That is deliberate
-- and it is also incomplete on its own. The hard delete of soft-deleted rows past
-- 24h is WO D5, which does not exist yet — until it does, the payload is still in
-- the table after this function returns. Two things do happen immediately: the
-- `lead_restrict_cancels_pending` trigger (20260811120100) cancels every
-- `pending` delivery the moment `deleted_at` goes non-null, so the outbound queue
-- stops with no extra code here; and the row leaves every reader, because each
-- one already excludes `deleted_at is not null`. Rows already `delivering` are
-- deliberately NOT cancelled — a lease is in flight and the receipt must not
-- claim otherwise.
--
-- Backups and PITR are out of scope by PLAN.md §8.7's own decision. The
-- Löschkonzept names the window; a receipt must name it too rather than implying
-- the data is gone from everywhere.
--
-- NOT `security definer`, for the same reason as every sibling: the runtime calls
-- these with the service-role key, which bypasses RLS already, and a definer
-- function taking a `p_client_id` argument is a cross-tenant reader waiting for
-- the day something else gains execute.
--
-- Rollback:
--   drop function if exists erase_subject(uuid, text);
--   drop function if exists find_subject(uuid, text);
--   drop function if exists subject_matches(jsonb, text);
--   drop index if exists event_session_idx;
-- ===========================================================================

-- Both the subject walk and D5's retention purge delete events by
-- (funnel_id, session_id). `event_funnel_idx` is (funnel_id, created_at) and
-- cannot serve that, so both would scan a funnel's whole event history.
create index if not exists event_session_idx on public.event (funnel_id, session_id);

-- ---------------------------------------------------------------------------
-- The matcher. One function, called by the search and by the delete.
--
-- `jsonb_path_query(payload, '$.**')` yields every value at every depth, so a
-- field nested inside an object the console will add in some future step is
-- covered without this function knowing the payload's shape. Only scalars are
-- compared: an object or array that happens to stringify to the needle is not a
-- person's email address.
-- ---------------------------------------------------------------------------
create or replace function subject_matches(p_payload jsonb, p_needle text)
returns boolean
language sql
immutable
as $$
  with needle as (
    select
      lower(btrim(coalesce(p_needle, '')))                                as as_text,
      nullif(regexp_replace(coalesce(p_needle, ''), '\D', '', 'g'), '')   as as_digits
  )
  select
    -- Defence in depth against a caller that skipped the guard: a one- or
    -- two-character needle matches nothing, so it can never sweep an inbox.
    length((select as_text from needle)) >= 3
    and exists (
      select 1
        from jsonb_path_query(coalesce(p_payload, '{}'::jsonb), '$.**') v
        cross join needle n
       where jsonb_typeof(v) in ('string', 'number')
         and (
               lower(btrim(v #>> '{}')) = n.as_text
               or (
                    n.as_digits is not null
                and length(n.as_digits) >= 6
                and nullif(regexp_replace(v #>> '{}', '\D', '', 'g'), '') = n.as_digits
                  )
             )
    );
$$;

comment on function subject_matches(jsonb, text) is
  'Does this lead payload belong to the person named by this needle? Equality only — this predicate also deletes (WO D3).';

-- ---------------------------------------------------------------------------
-- Art. 15 / Art. 20 — what is held about one person, within one client.
--
-- Returns soft-deleted, restricted and spam rows as well, WITH their flags, and
-- that is the opposite of what `client_report` does on purpose. A report link is
-- an export to the CLIENT, where Art. 18 restriction blocks disclosure and a
-- soft-deleted row must not reappear. This is the operator answering the DATA
-- SUBJECT, who is entitled to know what is held about them including the fact
-- that it is restricted or pending deletion. Do not "fix" this to match the
-- report's exclusions — they answer different questions for different people.
-- ---------------------------------------------------------------------------
create or replace function find_subject(p_client_id uuid, p_needle text)
returns table (
  lead_id        uuid,
  funnel_id      uuid,
  funnel_slug    text,
  created_at     timestamptz,
  deleted_at     timestamptz,
  restricted     boolean,
  is_spam        boolean,
  email_verified boolean,
  session_id     text,
  session_shared boolean,
  event_count    bigint,
  payload        jsonb,
  utm            jsonb,
  consent        jsonb
)
language plpgsql
stable
as $$
begin
  if p_client_id is null then
    raise exception 'find_subject: a client id is required';
  end if;
  -- Refused rather than answered with zero rows: "nothing is held about this
  -- person" and "you searched for nothing" must not look the same to an operator
  -- who is about to write a reply with a statutory deadline on it.
  if length(btrim(coalesce(p_needle, ''))) < 3 then
    raise exception 'find_subject: the search term must be at least 3 characters';
  end if;

  return query
    select
      l.id,
      l.funnel_id,
      f.slug,
      l.created_at,
      l.deleted_at,
      l.restricted,
      l.is_spam,
      l.email_verified,
      nullif(l.payload ->> 'sessionId', ''),
      -- True when a lead THIS SEARCH DOES NOT MATCH carries the same session, so
      -- the count beside it describes more than one visitor. Not a filter — the
      -- operator has to SEE it, because the alternative is a number in a
      -- statutory reply that quietly belongs to two people.
      --
      -- `not subject_matches(o.payload, p_needle)` is the condition that makes
      -- this the same question `erase_subject`'s `shared_sessions` asks, and it is
      -- load-bearing rather than an optimisation. `o.id <> l.id` alone was wrong:
      -- one person resubmitting on the same browsing session after
      -- `dedupeKey()`'s 10-minute window rolls over is TWO leads with one session
      -- and one email, so every row flagged the other and the search reported a
      -- shared session where `erase_subject` — which excludes its own targets —
      -- correctly reported none. Search and delete disagreeing about one person is
      -- the failure this whole file is built as one matcher to avoid.
      --
      -- `deleted_at` is deliberately NOT consulted on either side. A lead erased
      -- by an earlier, separate request still means a second visitor used that
      -- session, and gating on it would make the flag go stale the moment
      -- somebody's request was honoured.
      --
      -- ponytail: `subject_matches` runs per candidate row here, and the session
      -- comparison is a computed expression so no index serves it. The candidate
      -- set is one client's leads in one funnel on one session, which is tiny; if
      -- a client's lead table ever gets big enough for this to show up, hoist the
      -- search's own matches into a CTE and anti-join against it.
      exists (
        select 1
          from lead o
         where o.client_id = p_client_id
           and o.funnel_id = l.funnel_id
           and o.id <> l.id
           and nullif(l.payload ->> 'sessionId', '') is not null
           and nullif(o.payload ->> 'sessionId', '') = nullif(l.payload ->> 'sessionId', '')
           and not subject_matches(o.payload, p_needle)
      ),
      (
        select count(*)
          from event e
         where e.funnel_id = l.funnel_id
           and nullif(l.payload ->> 'sessionId', '') is not null
           and e.session_id = nullif(l.payload ->> 'sessionId', '')
      ),
      l.payload,
      l.utm,
      l.consent
      from lead l
      join funnel f on f.id = l.funnel_id
     where l.client_id = p_client_id
       and subject_matches(l.payload, p_needle)
     order by l.created_at desc;
end $$;

comment on function find_subject(uuid, text) is
  'Art. 15/20: every lead held about one person within one client, flags included (WO D3).';

-- ---------------------------------------------------------------------------
-- Art. 17 — erase one person, within one client, in one transaction.
--
-- The return value is the receipt, and every number in it is counted rather than
-- assumed. `leads_without_session` is the honest part: those leads' events cannot
-- be reached, so the reply to the subject says what was removed instead of
-- claiming everything was.
-- ---------------------------------------------------------------------------
create or replace function erase_subject(p_client_id uuid, p_needle text)
returns table (
  leads_deleted         int,
  leads_already_deleted int,
  events_deleted        int,
  leads_without_session int,
  shared_sessions       int
)
language plpgsql
volatile
as $$
begin
  if p_client_id is null then
    raise exception 'erase_subject: a client id is required';
  end if;
  if length(btrim(coalesce(p_needle, ''))) < 3 then
    raise exception 'erase_subject: the search term must be at least 3 characters';
  end if;

  -- ONE statement, so every number in the receipt describes one snapshot — that
  -- part is Postgres giving a single top-level statement one snapshot, not the
  -- `materialized` keyword. `materialized` is here for cost: `targets` is
  -- referenced five times and its `subject_matches` scan should run once.
  --
  -- This was a temporary table first. A `create temporary table` inside the
  -- function makes a second call in the SAME transaction fail on the name — which
  -- is every SQL assertion file here, since they all run inside one
  -- begin/rollback, and would also be any future caller erasing two subjects
  -- together.
  return query
    with targets as materialized (
      select l.id, l.funnel_id, nullif(l.payload ->> 'sessionId', '') as session_id, l.deleted_at
        from lead l
       where l.client_id = p_client_id
         and subject_matches(l.payload, p_needle)
    ),
    -- Sessions this erasure is about to empty that a lead OUTSIDE ITS OWN TARGET
    -- SET also sits on — the same question `find_subject.session_shared` answers,
    -- and it has to stay the same question. "Outside the target set" is not
    -- "not deleted": `deleted_at` is deliberately not consulted, because a lead
    -- erased by an earlier request still means a second visitor used that session,
    -- and gating on it would make the count go stale as soon as somebody's request
    -- was honoured.
    --
    -- Reads `lead` in the same statement as the update below and therefore sees
    -- the pre-update rows — Postgres gives every sub-statement of a `with` query
    -- the snapshot taken at the start of the top-level statement.
    shared as (
      select count(distinct t.session_id)::int as n
        from targets t
       where t.session_id is not null
         and exists (
           select 1
             from lead o
            where o.client_id = p_client_id
              and o.funnel_id = t.funnel_id
              and nullif(o.payload ->> 'sessionId', '') = t.session_id
              -- `not exists` rather than `not in`: a single NULL anywhere in a
              -- `not in` subquery makes the predicate NULL for every row, so the
              -- count would silently become 0. `targets.id` is a non-null primary
              -- key so it cannot happen today — this form does not ask the reader
              -- to go and confirm that.
              and not exists (select 1 from targets x where x.id = o.id)
         )
    ),
    events_gone as (
      delete from event e
       using targets t
       where e.funnel_id = t.funnel_id
         and t.session_id is not null
         and e.session_id = t.session_id
      returning e.id
    ),
    -- Soft delete. `lead_restrict_cancels_pending` cancels the outbound queue off
    -- this update; the hard delete is WO D5's sweeper. The `deleted_at is null`
    -- guard makes a second erasure of the same person report itself honestly
    -- instead of re-stamping a timestamp that has already been reported.
    leads_gone as (
      update lead l
         set deleted_at = now()
        from targets t
       where l.id = t.id
         and l.deleted_at is null
      returning l.id
    )
    select
      (select count(*) from leads_gone)::int,
      (select count(*) from targets where deleted_at is not null)::int,
      (select count(*) from events_gone)::int,
      (select count(*) from targets where session_id is null)::int,
      (select n from shared);
end $$;

comment on function erase_subject(uuid, text) is
  'Art. 17: soft-delete every lead held about one person within one client, and delete their events. Returns a counted receipt, including how many of the emptied sessions another lead also sat on (WO D3).';

-- ---------------------------------------------------------------------------
-- Close the three new doors.
--
-- `alter default privileges` in 20260811120000 only covers functions created
-- later BY THE SAME ROLE, which is a weaker promise than "a future migration
-- cannot reopen this" — so the guarantee is this explicit revoke, and every
-- sibling migration that adds a function carries it. Review caught it missing
-- from one of them once already.
--
-- It matters more here than anywhere else in the schema: `erase_subject` takes a
-- client id as an argument and deletes. Left callable with the deliberately
-- public `anon` key, it is a button that empties any client's inbox, walkable by
-- guessing UUIDs. The tables' RLS-with-no-policies would still refuse today —
-- that is the point of two layers, and it is not a reason to ship one.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from public, anon, authenticated';
    execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
  end if;
end $$;
