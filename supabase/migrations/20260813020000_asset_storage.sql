-- ===========================================================================
-- Phase 2 WO A1 — the bucket funnel images live in.
--
-- Design and rationale: PHASE-2-PLAN.md §1.
--
-- Until now every image in a funnel was a URL the operator pasted, so a live
-- client funnel meant hotlinking someone else's server or hosting the files
-- somewhere first. This is the bucket those files go into.
--
-- WHY PUBLIC READ
-- A funnel page is public and heavily cached, so a signed READ url would expire
-- and leave the page with broken images. Public is therefore not a shortcut, it
-- is the only shape that works — and it is a disclosure: everything uploaded is
-- world-readable by URL, and a photo of an identifiable person is personal data
-- (PLAN.md §8.1), which is why Storage has to be walked by the deletion path in
-- §8.7. The console says so at the upload control.
--
-- WHY NO WRITE POLICY AT ALL
-- Uploads are authorised one at a time by a signed upload URL, minted by
-- `POST /api/admin/assets/sign` behind the admin gate. That token authorises its
-- own request, so `anon` and `authenticated` need no insert/update/delete here —
-- and not granting it is what keeps "who may upload" answerable in one place
-- instead of in two that can disagree. Same posture as PRIVILEGED_PREFIXES in
-- lib/auth.js: structural, not remembered.
--
-- Rollback:
--   drop policy if exists "funnel assets are publicly readable" on storage.objects;
--   delete from storage.buckets where id = 'funnel-assets';
--   -- objects must be deleted through the Storage API first; the FK will
--   -- otherwise refuse the delete, which is the safe direction.
-- ===========================================================================

-- `on conflict do nothing`, not `do update`: re-running a migration must never
-- silently flip an existing bucket's visibility or limits underneath the objects
-- already in it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'funnel-assets',
  'funnel-assets',
  true,
  -- 8MB. The console downscales to a 1920px WebP before uploading (~400KB in
  -- practice), so this is the ceiling for the untouched cases — an SVG logo, a
  -- pre-optimised PNG — and a second line of defence behind the route's own
  -- declared-size check, on the side the browser cannot talk its way around.
  8388608,
  array['image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Read, and only read. `storage.objects` has RLS enabled by Supabase; without a
-- select policy the public URL 400s, which looks exactly like a broken upload.
drop policy if exists "funnel assets are publicly readable" on storage.objects;
create policy "funnel assets are publicly readable"
  on storage.objects for select
  to public
  using (bucket_id = 'funnel-assets');

-- No insert/update/delete policy is created on purpose. See the header: the
-- signed upload URL carries its own authorisation, and deletes go through the
-- service role in `routes/admin.js`, which bypasses RLS by design. Adding a
-- write policy here would open a second door with a different lock.
