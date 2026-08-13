# Phase 2 — implementation plan

Companion to [PLAN.md](PLAN.md) §10 Phase 2, in the same shape as
[PHASE-1-PLAN.md](PHASE-1-PLAN.md): the decisions that shape the code, then work orders sized for
one Sonnet agent each. Written 2026-08-13, after Phase 1 closed.

Constraints that hold for everything below: Vercel Free + Supabase Free, zero runtime
dependencies, no build step, no real personal data, migrations through `supabase db push`, and the
engine is extended rather than rewritten.

---

## 1. Asset upload to Supabase Storage

**The problem it solves.** Every image in a funnel today is a URL the operator pasted into an
`Image URL` field (`BLOCK_SCHEMA` in `apps/app/app.js`). That means either hotlinking someone
else's server — which the template file header already warns about — or the operator hosting files
themselves before they can build a page. A client's own photos are the entire difference between a
demo and a live funnel, so this is the first thing Phase 2 needs.

### Decision 1 — the bytes never touch our server

The obvious build is `POST /api/admin/assets` with the file in the body, server forwards to
Storage. Three things break it, and the third is fatal:

- `Bun.serve` is configured `maxRequestBodySize: MAX_BODY` (64KB) **server-wide**. Raising it for
  an upload route raises it for `/api/lead`, which is public, rate-limited but anonymous — and
  `store.js` already documents that sink growth is an anonymous write primitive. A 4MB ceiling
  there is a 60× larger one.
- Vercel caps a serverless request body at 4.5MB, so the route would refuse a phone photo anyway.
- The bytes would be buffered in an invocation's memory for no reason: Storage can receive them
  directly.

So the admin route mints a **signed upload URL** and returns it; the browser PUTs the file straight
to Supabase. Storage's `POST /storage/v1/object/upload/sign/<bucket>/<path>` returns a token
scoped to that exact path, and the upload it authorises does not carry our service key — the key
stays server-side, as it does everywhere else in this repo.

Consequence worth stating: the console does the upload, so the console needs the admin token to get
the URL (it already has one) and network access to the Supabase origin (it is a browser, and the
console has no CSP of its own).

### Decision 2 — the image is resized in the browser, not by Storage

PLAN.md §10 says "responsive sizes and WebP via Storage transformations (no image library needed)".
**Storage image transformations are a Pro feature**, so on Free that line silently degrades to
serving the original — a 4MB phone photo on a funnel that exists to load fast on 4G.

The replacement is a `<canvas>` downscale in the console before upload: longest edge to 1920px,
exported as WebP at ~0.82 quality. No dependency, no build step, and it is strictly better than the
Pro path for our case because the bytes we pay to store are already the bytes we serve. A file that
is already small and not an image (an SVG logo, say) is uploaded untouched.

`ponytail: one size, not a srcset. Add a second export at 960px if a real funnel measures slow on
4G — the measurement item is already in PLAN.md §10 Phase 1.`

### Decision 3 — the bucket is public-read, and that is a disclosure, not a detail

A funnel page is public and heavily cached, so a signed read URL would expire and break the image.
The bucket is therefore `public = true` and every uploaded object is world-readable by URL.

Two consequences that belong in the docs and in the client paperwork, not in a comment:

- Anything uploaded is published. The console must say so at the upload control.
- A photo of an identifiable person is personal data (§8.1), so Storage joins the Löschkonzept
  (§8.7) and the deletion gate has to walk it. That gate is already a Phase 2 line; this work order
  makes it non-optional rather than adding it.

Object paths are `funnel/<slug>/<random>.<ext>` with a 16-byte random name — not a guessability
control (the bucket is public), but it stops one operator's filename from colliding with another's
and stops a path from carrying the original filename, which is often a person's name.

**Measured on the live bucket, 2026-08-13, and it matters for §8.7:** after `deleteAsset` removed an
object — confirmed gone from `POST /object/list`, which is authoritative — the public URL still
answered `200` with the file. That is Supabase's CDN serving its cached copy of a public object. So
"deleted" is true at the origin and not yet true at the edge, and a deletion request under Art. 17
that includes a photo cannot be reported as complete on the strength of the delete call alone. The
deletion work in §8.7 has to either wait out the cache or purge it; it is written down here because
the failure is invisible from the code.

### Decision 4 — RLS on `storage.objects`, and the bucket is created by a migration

The bucket and its policies are SQL, so they live in `supabase/migrations/` like everything else
(`supabase db push`, never the SQL editor). Public `select` on that bucket; **no** `insert`,
`update` or `delete` for `anon` or `authenticated` — every write goes through a signed URL minted
by the admin route, which is what keeps "who may upload" answerable in one place. This is the same
posture as `PRIVILEGED_PREFIXES`: the permission is structural, not remembered.

### Decision 5 — what the console writes into the document is just a URL

The engine needs no change. `media.src`, a `gallery` item's `src`, `hero.logo` — all of them
already take a URL and the CSP already allows `img-src https:` (`lib/csp.js`), so a Storage URL
renders with nothing new authorised. The upload control sets the same field the paste box sets, and
the paste box stays: an operator with an existing CDN should not be forced through our bucket.

### Work orders

| # | Work order | Tier | Depends on |
| --- | --- | --- | --- |
| A1 | Migration: `funnel-assets` bucket + policies (public select, no anon write) | Sonnet | — |
| A2 | `POST /api/admin/assets/sign` — validate slug + content type + declared size, mint the signed upload URL, return it with the eventual public URL | **Opus** (privileged route, egress) | A1 |
| A3 | Console: canvas downscale + WebP, PUT to the signed URL, write the returned public URL into the field being edited; upload control next to every `kind: "url"` image field | Sonnet | A2 |
| A4 | `DELETE /api/admin/assets` + a "remove" action in the console | Sonnet | A2 |
| A5 | Docs: CLAUDE.md invariant note, README setup line, PLAN.md §8.1 data-flow row for Storage | Sonnet | A1–A4 |

**Acceptance criteria.** An operator picks a 4MB JPEG in the builder, sees it appear in the field,
saves, and the funnel page renders it from the Storage URL — with the stored object under ~400KB
and in WebP. A funnel slug that is not `SLUG_RE` is refused. A content type outside the image
allowlist is refused. The service key never appears in a response, a log, or the console's network
tab. Reviewer + qa PASS, and the live self-test is a real upload on the branch alias with a
screenshot.

### Found while building this, and not fixed here

`bun run typecheck` does not check `apps/` at all — `tsconfig.base.json` has no `include` and no
`allowJs`, so the whole runtime and the whole console are outside it (measured with
`tsc --listFiles`). Every JSDoc annotation there is documentation rather than a checked contract,
and a green typecheck has been saying less than it looks like it says. Turning it on is ~200
errors, most of them `Cannot find name 'process'`, so it needs a `@types/node` devDependency and a
pass over the fallout — its own work order, not a rider on this one. Noted in CLAUDE.md's Style
section so nobody reads the current signal as stronger than it is.

### Not in scope, deliberately

- Video upload. Storage on Free is 1GB and a single video eats it; the `media` block takes a URL
  and YouTube/Vimeo embeds already work.
- An asset library / media browser. A list of what has been uploaded is a second surface, and
  nothing needs it until a client has more than a handful of images.
- Retention or orphan cleanup for assets no funnel references any more. Named here so it is not
  discovered later: it belongs with the §8.7 deletion work, which walks Storage anyway.
