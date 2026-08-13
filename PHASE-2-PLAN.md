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

---

## 2. Custom domains

**The problem it solves.** A funnel lives at `openfunnel-…vercel.app/f/client-slug`. A client
running paid traffic to that is advertising our vendor URL on their own campaign, and ad platforms
score domain reputation — so `angebot.client-firma.de` is not cosmetic. PLAN.md §2.3 and §10 both
carry it, and the Vercel research is in
[reference/vercel-custom-domains-2026-08-13.md](reference/vercel-custom-domains-2026-08-13.md).

The feature has two halves, and only one of them is buildable today.

### Decision 1 — a funnel host is a routing MODE, not a redirect

The whole product ships in one handler: the console, the builder, the privileged API and the
funnel pages. Attaching `angebot.client-firma.de` to that project without changing anything means
the client's domain also serves `/` (the console shell), `/builder`, `/leads`, and — same-origin,
so `isCrossSiteRequest` passes — the entire `/api/admin/*` surface, held shut by nothing but
`ADMIN_TOKEN`. On a deployment with no token set, loopback trust is the only other gate and a
custom domain is not loopback, so that case refuses; with a token set, the console UI is still
published on a domain the operator does not control, inviting the operator to type their token
into it.

So the host decides what the server is:

| Host | What it serves |
| --- | --- |
| the console host (anything not mapped) | everything, exactly as today |
| a mapped funnel host | **only** that funnel: `/` → its page, `/_of/*`, `/api/lead`, `/api/events`, `/api/otp/*`, and its own `/api/funnels/<slug>` |

Everything else — the console shell, `/api/funnels` (the LIST), `/healthz`, and every privileged and
internal prefix — answers **404**, not 401 — the same posture `/api/internal/*` already takes when
`INTERNAL_SECRET` is unset. A client's domain should not advertise that an admin API exists behind
it.

`/api/funnels` matters more than it looks: it returns every funnel's slug, name and colour. It is
public on every host today. On a client's domain that is a list of the operator's other clients,
which is why it is refused there rather than left alone.

**Order matters, and it is the operator's to get right.** An unmapped host is a console host — that
is what makes the console reachable at all. So a domain attached to the Vercel project BEFORE it is
mapped here serves the console on the client's hostname until someone maps it. Map first, attach
second. (Found by the qa run, not by the design.)

This is built as a THIRD structural gate in `handler.js`, in the same shape as
`PRIVILEGED_PREFIXES` and `INTERNAL_PREFIXES`: the funnel-host branch is checked before dispatch
and returns before the privileged branch is ever reached, so a new privileged route cannot leak
onto a client domain by being added in the wrong file.

The gate sits above the `OPTIONS` reply and above `/healthz` so that "before any dispatch" is
literal rather than nearly true, and the preflight is answered by one shared function on both hosts
— identical bytes either way, so it cannot become a signal for which routes exist where.

It requires the `Host` header to arrive **unmodified**; a reverse proxy that rewrites it makes every
mapping miss, and a hostname whose mapping misses serves the console. No `x-forwarded-host`
fallback: that header is caller-supplied, so trusting it would let anyone claim any mapping.

### Decision 2 — the mapping is a table, with an env fallback

`domain` (host PK, funnel slug, created_at) in Postgres, read through the same PostgREST client as
everything else, cached for 60s in production like the funnel cache and not at all in DEV. A
self-hoster with no database gets `FUNNEL_DOMAINS="angebot.client-firma.de=client-slug"` — same
posture as the rest of the runtime, where Supabase is opt-in and the database-less path is
maintained rather than deprecated.

The host is normalised by PARSING it (`new URL`), not by pattern-matching the string — the rule this
repo already applies to every other URL check, and what makes an internationalised domain work:
`kaufhaus-münchen.de` and its `xn--` form have to normalise to one string, or the console stores a
row no browser's `Host` header can match. A `Host` header is attacker-controlled, so the lookup is
an exact match against a stored string and never a suffix or pattern test.

Each entry carries its **source**, and the delete path refuses an `env` one: a PostgREST `DELETE`
matching no row still succeeds, so a Remove button on a `FUNNEL_DOMAINS` entry told the operator a
client's domain was disconnected while it was still serving.

### Decision 3 — the Vercel attachment is NOT automated in this work order

Vercel's Domains API can attach a hostname to the project in one call, and it is deliberately not
being wired up now. From the research:

- On Hobby, a custom domain is only publicly reachable when it is attached to the **Production**
  environment, and adding one fails with a documented `400` until at least one **successful
  production deployment** exists. This project has never run `vercel --prod`, and doing so on
  Hobby is a standing No-Go while the console ships in the same handler — which is exactly what
  Decision 1 is a prerequisite for fixing.
- Attaching it to the preview branch instead leaves the client's funnel behind Vercel's SSO login
  wall.
- A wildcard (`*.f.enno.de`) needs the whole zone's nameservers delegated to Vercel, which is a
  DNS decision about a domain the operator owns, not a code change.

So this work order builds the half that makes the other half safe, and the operator attaches a
domain in the Vercel dashboard by hand. The console shows what the client's DNS needs, read from
`GET /v6/domains/{domain}/config` at display time rather than hardcoded — the A record and the
per-project CNAME are dynamic values now, and the docs say in as many words not to copy the ones
in a blog post.

### Work orders

| # | Work order | Tier | Depends on |
| --- | --- | --- | --- |
| B1 | `lib/domains.js` — normalise + resolve a host to a slug (table, env fallback, cache) + the `domain` migration | **Opus** (it decides what a request is allowed to be) | — |
| B2 | `handler.js` funnel-host gate + tests: console/list/privileged/internal all 404 on a funnel host, ingest and engine assets still work | **Opus** (structural gate) | B1 |
| B3 | Console: a Domains section — map a host to a funnel, show the DNS records the client must set, delete a mapping | Sonnet | B1 |
| B4 | Docs: CLAUDE.md invariant, README, `.env.example` (`FUNNEL_DOMAINS`), PLAN.md §10 checklist line | Sonnet | B1–B3 |

**Acceptance criteria.** With `FUNNEL_DOMAINS=demo.test=lead-gen` set, a request carrying
`Host: demo.test` to `/` renders the `lead-gen` funnel page; `/builder`, `/api/funnels`,
`/api/admin/leads` and `/api/internal/drain` all answer 404 on that host; `/api/lead` still answers
202 and `/_of/…` still serves the engine. Every one of those is unchanged on the console host. The
same behaviour verified live against the branch alias with an explicit `Host` header, and a
screenshot of the funnel page rendering on a mapped host.

### Not in scope, deliberately

- The Vercel Domains API call, per Decision 3. It needs a production deployment and a
  `VERCEL_API_TOKEN`, and neither is available while this is a Hobby project.
- Wildcard subdomains (`*.f.enno.de`) — nameserver delegation of a zone the operator owns.
- Per-domain TLS, redirects, `www` handling, apex→subdomain rules: all of that is Vercel's, and
  none of it is code in this repo.
