-- ===========================================================================
-- Delivery-target sync check (WO12a).
--
-- Same shape as state-machine.sql and otp.sql: one transaction ending in
-- ROLLBACK, every check an `assert` naming the rule it broke, runnable against
-- any database carrying this schema including a live one.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/targets.sql
--
-- What is worth asserting here is not "a row appears". It is the four ways this
-- function could quietly break a client's delivery: disabling a target the
-- operator wrote by hand, DELETING a target that a delivery row still points
-- at, leaving two enabled webhooks so every lead is sent twice, and — the one
-- this whole work order exists for — a funnel with a target where `ingest_lead`
-- still queues nothing.
-- ===========================================================================

begin;

do $$
declare
  v_client   uuid;
  v_funnel   uuid;
  v_slug     text := 'targets-check-' || replace(gen_random_uuid()::text, '-', '');
  v_n        int;
  v_enabled  int;
  v_manual   uuid;
  v_webhook  uuid;
  v_lead     uuid;
  v_queued   int;
  v_config   jsonb;
begin
  insert into client (name, slug, contact_email)
  values ('Targets Check', v_slug, 'check@example.invalid')
  returning id into v_client;

  insert into funnel (client_id, slug, name, doc)
  values (v_client, v_slug, 'Targets Check', '{"steps":[{"type":"form"}]}'::jsonb)
  returning id into v_funnel;

  -- A hand-written target, which the sync must never touch. Same funnel, same
  -- kind as one it will later manage: if it matched on (funnel_id, kind) alone
  -- it would disable the operator's own row the first time a document did not
  -- happen to mention that kind.
  insert into delivery_target (client_id, funnel_id, kind, config, source)
  values (v_client, v_funnel, 'email', '{"to":"manual@example.invalid"}'::jsonb, 'manual')
  returning id into v_manual;

  /* --- one webhook ------------------------------------------------------- */

  v_enabled := sync_delivery_targets(v_slug, '[{"kind":"webhook","config":{"url":"https://a.example.invalid/h"}}]'::jsonb);
  assert v_enabled = 1, 'one configured target should leave one enabled';

  select id into v_webhook from delivery_target
   where funnel_id = v_funnel and source = 'funnel' and kind = 'webhook';
  assert v_webhook is not null, 'the webhook target should have been created';

  /* --- the lead actually queues now -------------------------------------- */

  -- The reason for the whole work order. Before targets existed this returned
  -- queued = 0 for every deployment, so /api/lead fell through to the legacy
  -- fan-out and the durable queue stayed empty.
  select queued into v_queued
    from ingest_lead(v_slug, '{"lead":{"email":"q@example.invalid"}}'::jsonb,
                     null, null, false, null, null, null);
  assert v_queued = 2, format('a lead should queue one delivery per enabled target (2), got %s', v_queued);

  select l.id into v_lead from lead l where l.funnel_id = v_funnel limit 1;
  assert exists (select 1 from delivery where lead_id = v_lead and target_id = v_webhook),
    'the webhook target should have a delivery row';
  assert exists (select 1 from delivery where lead_id = v_lead and target_id = v_manual),
    'the hand-written target should have one too — the sync does not own who delivers';

  /* --- idempotence ------------------------------------------------------- */

  v_enabled := sync_delivery_targets(v_slug, '[{"kind":"webhook","config":{"url":"https://b.example.invalid/h"}}]'::jsonb);
  select count(*) into v_n from delivery_target
   where funnel_id = v_funnel and source = 'funnel' and kind = 'webhook';
  assert v_n = 1, format('a second sync must update the webhook target, not add one (%s rows)', v_n);

  select config into v_config from delivery_target where id = v_webhook;
  assert v_config->>'url' = 'https://b.example.invalid/h', 'the config should have been updated in place';

  /* --- a kind that is no longer configured ------------------------------- */

  v_enabled := sync_delivery_targets(v_slug, '[{"kind":"email","config":{"to":"kunde@example.invalid"}}]'::jsonb);
  assert v_enabled = 1, 'the email target replaced the webhook, so one is enabled';

  assert (select enabled from delivery_target where id = v_webhook) = false,
    'a target the document no longer names must stop delivering';
  -- Disabled, never deleted: `delivery.target_id` references it, and the row
  -- above proves at least one delivery does.
  assert exists (select 1 from delivery_target where id = v_webhook),
    'a target with delivery history must be disabled rather than deleted';

  assert (select enabled from delivery_target where id = v_manual) = true,
    'the hand-written target must survive a sync that does not mention it';
  select count(*) into v_n from delivery_target
   where funnel_id = v_funnel and kind = 'email';
  assert v_n = 2, 'the managed email target is a separate row from the manual one';

  /* --- coming back ------------------------------------------------------- */

  v_enabled := sync_delivery_targets(v_slug,
    '[{"kind":"webhook","config":{"url":"https://c.example.invalid/h"}},{"kind":"email","config":{"to":"kunde@example.invalid"}}]'::jsonb);
  assert v_enabled = 2, 'both kinds configured means both enabled';
  assert (select enabled from delivery_target where id = v_webhook) = true,
    're-adding a webhook must revive the existing row, not orphan its history';

  /* --- nothing configured ------------------------------------------------ */

  v_enabled := sync_delivery_targets(v_slug, '[]'::jsonb);
  assert v_enabled = 0, 'an empty list disables every managed target';
  assert (select enabled from delivery_target where id = v_manual) = true,
    'even an empty list must not reach a hand-written target';

  /* --- a caller sending the same kind twice ------------------------------ */

  -- ON CONFLICT DO UPDATE cannot touch one row twice in a statement, so without
  -- the DISTINCT this raises a cardinality error instead of the last one winning.
  v_enabled := sync_delivery_targets(v_slug,
    '[{"kind":"webhook","config":{"url":"https://d.example.invalid/h"}},{"kind":"webhook","config":{"url":"https://e.example.invalid/h"}}]'::jsonb);
  assert v_enabled = 1, 'a duplicated kind is still one target';

  raise notice 'targets check: all assertions passed';
end $$;

-- An unknown slug is PT404, not a generic 500: PostgREST maps its own PTxxx
-- range onto HTTP status codes, and the runtime branches on that to tell "no
-- such funnel" from "the database is unreachable".
do $$
declare
  v_code text;
begin
  begin
    perform sync_delivery_targets('no-such-funnel-' || gen_random_uuid(), '[]'::jsonb);
    assert false, 'syncing an unknown funnel must raise';
  exception when others then
    get stacked diagnostics v_code = returned_sqlstate;
    assert v_code = 'PT404', format('expected PT404 for an unknown funnel, got %s', v_code);
  end;
  raise notice 'targets check: unknown funnel raises PT404';
end $$;

rollback;
