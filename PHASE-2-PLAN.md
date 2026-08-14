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

---

## 3. Client report link `/r/:token`

**The problem it solves.** A client whose funnel is running has exactly one question — *did
anything come in?* — and today the only way to answer it is to ask Enno. PLAN.md §3.3 calls the
signed report the DFY differentiator and §5.3 specifies it; it is also what removes the case for
ever building client accounts, because the alternative to a link is a login page, a password reset
flow and a session store for people who will use it twice a month.

### Decision 1 — the page is server-rendered HTML, and there is no report API

The obvious build is another view in the console SPA, fetching `/api/report/...` with the token.
Do not: the token **is** the credential, so a client-side page has to hold it and send it on every
request, which puts it in `history`, in every `Referer` this page's subresources generate, and in
whatever the browser syncs. One route that reads the token out of its own path, renders the answer
and returns it means the token appears in exactly one request and one server log line that never
records it.

It also means there is no second surface to gate. `/api/report/*` would be a public API needing its
own auth, its own rate limits and its own place in the route order — three things to get right for
a page with no interactivity in it. The report is a table, a few numbers, and `tel:`/`mailto:`
links a phone can act on. No JavaScript at all.

### Decision 2 — the token is looked up BY its hash, so there is no comparison left to time

PLAN.md §5.3 asks for a constant-time comparison against the stored hash. Storing
`sha256(token)` and *selecting on that digest* is strictly better and simpler: the secret is never
loaded into the process to be compared, and an index equality test on a digest is not a signal an
attacker can use without already holding a preimage. So the constant-time requirement is satisfied
by not having a comparison, not by writing one.

256 bits from `crypto.getRandomValues`, base64url, 43 characters. The digest is `bytea`, matching
the way `otp.code_hash` and `lead.ip_hash` are already stored.

### Decision 3 — the scope is the token's own `client_id`, and it is never a parameter

Every query the page runs filters on the `client_id` that came back with the token row. Nothing in
the URL, the query string or a header names a client, a funnel or a lead — so there is no
parameter to tamper with, and the isolation is a property of the shape rather than of a check
someone remembers to write. This is the same posture as `ingest_lead` setting `client_id` from the
funnel rather than from the request body.

Three classes of row are excluded, and each for its own reason:

- `deleted_at is not null` — a soft-deleted lead is deleted (§8.7); the sweeper has just not run yet.
- `restricted` — Art. 18 says restricted processing blocks delivery **and export**. A report is an
  export. `cancel_pending_on_restrict` already stops the queue; this is the same rule on the read side.
- `is_spam` — not a legal requirement, a product one: the report is what makes a client trust the
  funnel, and three casino bots at the top of the list do the opposite.

### Decision 4 — a token in a URL is a credential in the leakiest place there is

Everything that follows is one control each, and none of them is optional:

- `noindex, nofollow` and `Referrer-Policy: no-referrer` — the shared `BASE_HTML_HEADERS` sends
  `strict-origin-when-cross-origin`, which is right for a funnel page and not enough here, because
  the secret is in the *path* and a click-out would carry it. `no-referrer` on this route only.
- A CSP allowing nothing off-origin. The page has no script, no font, no image and no third party;
  there is nothing to allow, so nothing is.
- Expiry (default 180 days), revocation, and `last_seen_at` stamped on every view — so a link
  nobody has opened in three months is visible as such before it is renewed.
- Rate limited. Token entropy is the whole access control, which makes it a TOM commitment under
  Art. 32, and an endpoint that can be walked defeats the entropy. The per-IP ceiling is on
  **misses**: a client refreshing their own report is not the thing to limit, and a caller
  producing 404s at that path is doing exactly one thing. The limiter hashes its own key
  (`lib/ratelimit.js`), so keying a bucket on a token does not write the token into `rate_bucket`.
- The token is never logged. A warn on this route names the reason, never the path.

Accepted and stated in PLAN.md §5.3: a leaked link exposes that client's leads. The mitigations are
expiry, revocation and one link per client, and the alternative — account management for people who
will not use it — is worse at this scale.

### Decision 5 — the report is 404 on a mapped funnel host, and that is already true

`handleFunnelHost` is an allowlist, so a new route is refused on client domains by default and
nothing needs to be added for this one. Recorded here so nobody "fixes" it later: the report is the
*operator's* surface for one client. Published on a client's own ad domain it would be one wrong
mapping away from serving one client's leads on another client's brand, and the funnel host exists
to make exactly that impossible.

### Decision 6 — validity is decided in SQL, in one function

`resolve_report_token(p_hash bytea)` checks the digest, the expiry, the revocation and the client's
own `deleted_at`, stamps `last_seen_at`, and returns the client — or nothing. One round trip, and
the rules live in the same place as the delivery state machine rather than as four `&&` in a route
handler that a later edit can reorder. The route's whole authorisation logic becomes *did this
return a row*.

**Every refusal is the same 404 with the same body.** Expired, revoked, never existed, off by one
character — a report link that distinguishes them tells a prober which half of the guess was right.

### Decision 7 — leads and numbers, not delivery state

PLAN.md §3.3 lists "leads, delivery state, funnel performance". Delivery state is deliberately left
out: `attempts: 3, last_error: ECONNREFUSED` is the operator's plumbing, the client can do nothing
with it, and a red row in a client's report generates a phone call about a lead that arrived. What
ships is the count this week / 30 days / total, a per-funnel breakdown, and the leads themselves
newest first with their contact fields and answers.

`ponytail: 200 most recent leads, no paging, no CSV. Add paging when a client's report actually
runs past it — at 200 leads a month this is a different conversation about the whole product.`

### Decision 8 — Postgres only

No database, no report: `/r/:token` 404s and the issuing route answers 503. The JSONL sink has no
`client_id` and never will — it is the operator's own buffer (CLAUDE.md), not a per-client store —
so there is nothing to scope a report to on that path. A self-hoster with no Supabase has one
client, themselves, and the console.

### Decision 9 — the token is shown exactly once, and revoking keeps the row

`POST /api/admin/report-tokens` returns the token and the full URL in that one response and never
again; the list route returns label, expiry, last seen and revoked state, never the digest and
never the token. `DELETE` sets `revoked_at` rather than removing the row — who had access to a
client's personal data, and until when, is the kind of thing Art. 30/32 asks about, and a deleted
row cannot answer it.

### Work orders

| # | Work order | Tier | Depends on |
| --- | --- | --- | --- |
| C1 | Migration: `report_token` + `resolve_report_token()` + RLS, matching the sibling tables | **Opus** (it defines what "authorised" means) | — |
| C2 | `lib/report.js` — mint/hash a token, resolve one to a client, load that client's leads and counts | **Opus** (the whole access control) | C1 |
| C3 | `routes/report.js` + the dispatch line in `handler.js` — the public page, its headers, its rate limits | **Opus** (new public surface) | C2 |
| C4 | `GET\|POST\|DELETE /api/admin/report-tokens` | Sonnet | C2 |
| C5 | Console: a Reports section — issue a link, copy it once, list and revoke | Sonnet | C4 |
| C6 | Docs: CLAUDE.md invariant + route table, README, PLAN.md §10 checklist line | Sonnet | C1–C5 |

**Acceptance criteria.** A token issued for client A opens a page listing A's leads and A's numbers;
a token issued for client B shows only B's, verified with two clients in one database. An expired
token, a revoked token, a token that never existed and a correct token with one character changed
all return byte-identical 404s. A restricted, soft-deleted or spam-flagged lead does not appear.
The page loads with zero third-party requests and no JavaScript. The token appears in no log line.
`/r/<token>` answers 404 on a mapped funnel host. Reviewer + qa PASS, and the live self-test is a
real token opened against the branch alias with a screenshot.

### Decided while building this, and not in the design above

- **The page speaks one language, chosen by `REPORT_LANG`.** The repo's default is English, matching
  `funnel.lang || "en"`; Enno's deployment sets `de`. Eleven strings in a table, not a locale
  framework — but the alternative (English only) was a report that could not be sent to the client
  it was built for.
- **`REPORT_TZ` matters more than it looks.** Vercel runs UTC, so an unset timezone shows a German
  client every lead one or two hours before it arrived. That reads as a broken report, not as a
  timezone. Defaults to `TZ`, then `UTC`.
- **The wide rate limit answers 429; only the miss bucket answers the silent 404.** The wide one
  fires *before* the token is resolved, so it says the same thing to a valid link and an invented
  one and leaks nothing — while a 404 there would tell a client behind an office NAT that their
  link is dead when it is merely busy, which is the one support call this feature exists to prevent.
- **A contact value is only linked when the URL PARSER says it is only an address.** `mailto:` takes
  header parameters after a `?`, so an "email" of `a@b.c?cc=attacker@evil.invalid` would silently
  copy a stranger on the client's reply to their own customer, and any anonymous visitor can type
  it into the public lead form. The first fix tested the value against `EMAIL_RE` — and **review
  found that green over a live bypass**: percent-encode the second address
  (`victim@example.com?cc=attacker%40evil.invalid`) and the pattern sees no second `@`, no
  whitespace and a dot, while the browser resolves the `%40` back when the link is clicked. The
  working check builds the URL and asks what came out (`url.search`, `url.hash`, `url.pathname`
  must equal the input) — the rule CLAUDE.md already states for every other URL check in this repo,
  arrived at here the expensive way. The phone number is *rebuilt* from its digits rather than
  checked, which reaches the same place by a different route: nothing of the input survives to
  carry a parameter.
- **An archived funnel is hidden from the breakdown only while it has nothing to show.** The
  obvious `status <> 'archived'` filter broke the rule the single-CTE design exists to keep:
  archiving a funnel does not unmake the enquiries it produced, so its leads still count towards
  the total and the breakdown stopped adding up to the number printed above it. Pinned in both
  directions by `supabase/tests/report.sql`.

### Reviewer findings, and what happened to them

Round 1 was a **FAIL** with two Majors, both fixed in the same change:

- The `mailto:` bypass above. The lesson generalises past this route: a check written as a pattern
  over a string that a parser will later interpret is a check on a different value than the one
  that matters.
- **The migration created two functions without re-running the `revoke execute on all functions`
  block** that every other function-adding migration here carries. RLS-with-no-policies on the
  tables would still have refused, so nothing leaked — which is exactly the argument for two
  layers, not a reason to ship one. `client_report` takes a client id as an argument, so callable
  with the (deliberately public) anon key it is a lead reader needing no token at all.

Two Minors accepted rather than fixed, both stated here so they are decisions rather than misses:

- With no resolvable client address (serverless without `TRUST_PROXY`), both rate-limit buckets
  collapse to one shared `unknown` key, so a burst of guesses could 429 every client's report for
  the hour. That is `clientIp`'s documented systemic behaviour, not this route's, it warns once
  naming the fix, and the deployment sets `TRUST_PROXY=1`. A special case here would only make
  this one route disagree with every other ceiling in the runtime.
- The "token resolved but the database then failed" path skips the miss bucket, so it does one
  fewer async write than a genuinely invalid token — a timing differential under a 30/hour ceiling
  and network jitter. Not worth a compensating write on an error path.

### Found while building this, and not fixed here

The mapped-host assertion was **vacuous in its first version** and passed with the gate
deliberately broken: with no database configured the route answers 404 on every host, so
"the report is 404 on a funnel host" was true no matter what the code did. It now renders the
report on the console host in the same test, with a stubbed database, so the two halves are one
assertion. Worth generalising: a refusal-shaped assertion proves nothing until the same fixture is
shown succeeding somewhere.

### Not in scope, deliberately

- The weekly summary email (PLAN.md §10, the next line). It is a different job — a scheduled sender
  — and it shares only the query this work order writes. Doing it here would mean building a
  scheduler inside a page route.
- A per-client PIN on top of the token (PLAN.md §5.3's option). It is a second credential to
  distribute and support, and no client's data has yet warranted it. The seam is one column.
- CSV/PDF export, date-range pickers, charts. The client's question is "did anything come in".
