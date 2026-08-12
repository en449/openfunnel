-- ===========================================================================
-- WO12a — something has to create `delivery_target` rows.
--
-- Design and rationale: PHASE-1-PLAN.md §4.3.
--
-- Nothing in the system created a target, so `ingest_lead` returned queued = 0
-- for every deployment, `/api/lead` fell through to the legacy fan-out, and the
-- queue this phase exists for stayed empty. The rows are now DERIVED from the
-- same configuration the fan-out already reads — the funnel document and the
-- environment — and this migration is the atomic write for that derivation.
--
-- WHY A FUNCTION AND NOT THREE POSTGREST CALLS
-- The runtime has no SQL driver (zero runtime dependencies), so one PostgREST
-- request is one transaction. Upserting the configured kinds and disabling the
-- ones that are no longer configured has to happen together or a save that
-- swaps a webhook for an email leaves both enabled for a window — which is the
-- operator's lead going to an address they just removed.
--
-- Rollback:
--   drop function if exists sync_delivery_targets(text, jsonb);
--   drop index    if exists delivery_target_synced_idx;
--   alter table delivery_target drop column if exists source;
-- ===========================================================================

/* ========================================================================== *
 *  Who owns a row
 *
 *  The sync owns exactly the rows it wrote, and is blind to everything else. A
 *  hand-written target — the seed's, or one added by SQL during an incident —
 *  must not be disabled because a funnel document does not happen to mention
 *  it. `source` is that boundary, and it is a column rather than a key inside
 *  `config` because `config` holds secrets and is never selected by the console.
 * ========================================================================== */

alter table delivery_target
  add column if not exists source text not null default 'manual'
  check (source in ('manual', 'funnel'));

-- The upsert's conflict target. Partial, so it constrains only managed rows:
-- two hand-written webhooks for one funnel stay legal, two synced ones cannot
-- exist. Without it, two concurrent saves of the same funnel each insert a
-- webhook target and the client's CRM gets every lead twice, permanently.
create unique index if not exists delivery_target_synced_idx
  on delivery_target (funnel_id, kind) where source = 'funnel';

/* ========================================================================== *
 *  The sync
 * ========================================================================== */

-- p_targets is `[{ "kind": "webhook", "config": { … } }, …]` — the full set that
-- SHOULD be enabled for this funnel. Anything managed and absent from it is
-- disabled, never deleted: `delivery.target_id` references this row, so a delete
-- either fails or takes the delivery history of every lead with it.
--
-- Returns the number of managed rows left enabled, which is what the caller logs.
create or replace function sync_delivery_targets(p_slug text, p_targets jsonb)
returns int
language plpgsql volatile as $$
declare
  v_funnel uuid;
  v_client uuid;
  v_kinds  text[];
  v_count  int;
begin
  -- `for update` serialises concurrent syncs of the SAME funnel, and that is a
  -- correctness requirement rather than tidiness. Without it the upsert and the
  -- disabling UPDATE below take row locks on `delivery_target` in whatever order
  -- each caller's kinds happen to produce: a save carrying `[webhook]` locks the
  -- webhook row then reaches for the email row, while a concurrent
  -- `syncAllFunnelTargets()` carrying `[email]` does the exact opposite — and
  -- Postgres resolves that by aborting one of them. The loser is swallowed into
  -- a warning by `syncFunnelTargets`, so the console would report a save whose
  -- delivery configuration silently did not apply.
  --
  -- Locking the funnel row rather than taking an advisory lock: it is the row
  -- this whole function is scoped to, it cannot collide with an unrelated
  -- funnel, and `saveFunnel`'s own UPDATE of it runs in a separate PostgREST
  -- transaction that holds no `delivery_target` locks — so it can wait, never
  -- deadlock.
  select f.id, f.client_id into v_funnel, v_client
    from funnel f
   where f.slug = p_slug
     for update;

  -- PT404, not P0002: PostgREST maps its own PTxxx range onto HTTP status
  -- codes, and a plain no_data_found arrives as a generic 500 that the caller
  -- would read as "the database is down" rather than "that funnel is not here".
  if v_funnel is null then
    raise exception 'funnel not found: %', p_slug using errcode = 'PT404';
  end if;

  select coalesce(array_agg(distinct t->>'kind'), '{}')
    into v_kinds
    from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) t;

  -- `distinct on (kind)` because ON CONFLICT DO UPDATE cannot touch the same row
  -- twice in one statement: a caller sending two webhooks would otherwise get a
  -- cardinality error instead of the last one winning.
  insert into delivery_target (client_id, funnel_id, kind, config, enabled, source)
  select distinct on (t->>'kind')
         v_client, v_funnel, t->>'kind', coalesce(t->'config', '{}'::jsonb), true, 'funnel'
    from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) t
   order by t->>'kind'
  on conflict (funnel_id, kind) where source = 'funnel'
  do update set config = excluded.config, enabled = true;

  update delivery_target
     set enabled = false
   where source = 'funnel'
     and funnel_id = v_funnel
     and enabled
     and not (kind = any(v_kinds));

  select count(*)::int into v_count
    from delivery_target
   where source = 'funnel' and funnel_id = v_funnel and enabled;

  return v_count;
end $$;

-- Re-run the revocation from 0002. `alter default privileges` only covers
-- functions created later by the same role, and relying on that rather than an
-- explicit revoke is how a new function ends up callable with the public anon
-- key — this one writes delivery destinations, so that would be an attacker
-- pointing the operator's leads at themselves.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from public, anon, authenticated';
    execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
  end if;
end $$;
