# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**OpenFunnel** — an open-source, self-hostable alternative to Perspective.co /
Typeform. It renders JSON funnel documents into mobile-first, swipe-through quiz
funnels built for paid traffic, captures leads, and reports drop-off.

Bun workspace monorepo, AGPL-3.0-or-later, **zero runtime dependencies** (the
only `devDependencies` are `happy-dom` and `typescript`).

## Commands

```bash
bun install            # install workspaces
bun run dev            # runtime server with --watch on :3000  (apps/runtime)
bun run start          # runtime server, no watch
bun test               # full suite (engine + runtime smoke tests)
bun run typecheck      # tsc over the engine's JSDoc types + tsconfig.base.json
bun run demo           # zero-build static demo on :4321 (scripts/serve.mjs)

bun run scripts/check-no-deps.mjs         # no runtime deps in any workspace pkg
bun run scripts/check-engine-imports.mjs  # every engine import browser-resolvable
bun run scripts/check-portable-runtime.mjs # no Bun-only API on the Vercel path
```

Run a single test file: `bun test packages/engine/test/logic.test.js`.

CI (`.github/workflows/ci.yml`) runs typecheck, the suite, and those two
invariant checks on every push and PR. The checks exist because both failures
they catch are invisible locally — Bun resolves a bare specifier and an
extensionless import happily, and the 404 only lands on a visitor's phone.

`bun test` and `bun run typecheck` both pass — keep it that way. The count moves
with the branch (128 on `main`, 202 on `phase-1-delivery-queue`), so compare
against the last recorded run rather than a number in this file. Several tests log expected warnings (`branch target "nope" not found`, an
invalid-URL `submitLead` failure, a refused non-path `leadEndpoint`, a sink
rotation); those are assertions about failure tolerance, not breakage.

That "known Bun failure" was this codebase's after all (2026-08-21). `ingest >
refuses an oversized body without buffering it` returned 400 instead of 413 on Bun
1.3.13, and the note here wrote it off as a bug the pinned 1.3.14 fixes. Probed
directly, 1.3.13 does not apply `maxRequestBodySize` to a chunked body at all: a
256KB stream reached the handler in full against a 64KB limit. The status code was
the symptom; the missing cap was the finding, and CI was green only because it runs
the version where the transport happens to refuse it. `readJson` now caps the body
stream itself — the check both entry points share — and the test accepts either
layer refusing, since which one does is a Bun detail. Lesson worth keeping: a
security property that holds on one runtime version and not another was never being
tested, whatever the suite said.

## Layout

```
packages/engine/     the funnel runtime — zero-dep browser ESM, no build step
apps/runtime/        the only backend — server.js (router) + lib/ + routes/
apps/app/            the console SPA (dashboard, builder, leads, analytics)
examples/*.json      funnel documents — this is the funnel "database"
demo/                offline zero-build demo page
.data/               JSONL lead/event sinks (gitignored)
```

### packages/engine

The engine mounts into any container in any framework and mutates nothing else.

- `src/types.js` — **JSDoc typedefs only, no runtime code.** This is the single
  source of truth for the funnel JSON contract. Change the contract here first.
- `src/controller.js` — the state machine. Owns `index`, `history`, `answers`,
  `lead`; mounts chrome; runs transitions; emits events; persists progress.
- `src/render/index.js` — builds the shared header, then dispatches on
  `step.type` to `choice` / `multiselect` / `form` / `content` / `loader` /
  `success`. `landing` is the one exception and returns *before* the header is
  built — see below.
- `src/render/landing.js` — the `landing` step: a full marketing page (hero,
  background media, nav, sticky CTA, sections, footer) whose CTAs advance into
  the quiz. It is what a cold ad click lands on, so a funnel is "landing page →
  questions → lead" in one document. Two rules it breaks on purpose:
  it owns the whole screen (no shared header — the hero draws its own eyebrow /
  headline / subtext, and drawing both prints the headline twice), and
  `step.blocks` is the page body *below* the hero rather than content above an
  interaction. Every section a page could want is therefore an ordinary
  `ContentBlock`, not a landing-only field, so adding one benefits every step
  type at once. The progress bar defaults to hidden on a landing step
  (`progress: true` overrides), and `width: "wide"` breaks the 9:16 phone frame
  on desktop via `data-width` on the root.
- `src/branching.js` — `resolveNext()`. Precedence: the interaction's `next` →
  the step's own `next` → linear fall-through. `null` ends the funnel.
- `src/piping.js` — `{{token}}` substitution from `lead` first, then `answers`.
  Unknown tokens render empty; a visitor must never see raw `{{...}}`.
- `src/analytics.js` — **ad-platform pixels only** (Meta, GA4/GTM, TikTok).
- `src/leads.js` — **your own backend only** (`/api/lead`, `/api/events`).
  Also captures UTM and click-id params (`gclid`, `fbclid`, `ttclid`, `ref`).
  These two files are separate on purpose; don't merge them.
- `src/theme.js` — funnel `theme` JSON → `--of-*` CSS custom properties, plus the
  eight `THEME_PRESETS` (`midnight-glass`, `neo-brutalist`, `warm-editorial`,
  `saas-gradient`, `clean-light`, `emerald-glow`, `violet-pulse`,
  `sunset-coral`). It used to be the only file in the engine that made a
  third-party request — a non-system `theme.font` was fetched from Google. The
  four families the presets name are now self-hosted in `src/fonts/`
  (PHASE-1-PLAN.md §4.9), so `loadThemeFont`, `ensureGoogleFontLoaded` and the
  `allowRemote` option are gone and the engine reaches nowhere off-origin.
  `theme.font` naming a family the page does not already have now resolves down
  the stack to a system font instead of summoning a third party.
- `src/consent.js` — the consent bar and the `marketingAllowed()` / `consentSignal()`
  gate for third-party sharing. Its header defines what is and is not gated.
- `src/persist.js` — localStorage resume. Fails silently by design.

### apps/runtime

No framework. `handler.js` is the router and nothing else: it owns the order
routes are tried in and both gates, and delegates to `lib/` and `routes/`. It is
called by two entry points — `server.js` (Bun) and `api/index.js` (Vercel) — and
knows which one it is on only through `opts`.

```
handler.js           handleRequest(req, opts) — route order + both gates
server.js            the Bun entry: Bun.serve, HOST/PORT, banner, body ceiling
../../api/index.js   the Vercel entry: export default { fetch }
lib/config.js        paths, env, SLUG_RE, isInside — imports nothing else
lib/log.js           oneLine, errSummary
lib/http.js          responses, CORS surface, readJson, clientIp
lib/ratelimit.js     the buckets, tooMany, MAIL_HOURLY_CAP
lib/auth.js          safeEqual, loopback trust, requireAdmin, PRIVILEGED_PREFIXES
lib/funnels.js       load/list/cache + publicFunnel redaction
lib/preview.js       hasPreviewFlag, isPreviewRecord
lib/db.js            PostgREST client + the error classification callers branch on
lib/delivery.js      dispatch a claimed delivery, report the outcome, drainOnce()
lib/targets.js       derive delivery_target rows from the funnel doc + mail settings
lib/webhook.js       egress guard (resolveSafeTarget) + the direct fan-out delivery
lib/domains.js       host → funnel slug: which funnel a custom domain serves
lib/storage.js       Supabase Storage: sign an upload, delete an object
lib/capi.js          Meta Conversions API forward
lib/email.js         settings, transports, OTP, lead notifications
lib/html.js          esc, jsonScript, themeVars, funnelPage
lib/csp.js           FUNNEL_BOOT_SCRIPT, its hash, custom code, funnelCsp
lib/static.js        console + engine asset serving
lib/ai.js            provider calls, parseJsonFromAiText
routes/*.js          one module per surface; each returns null to fall through
```

`lib/config.js` is the bottom of the dependency graph and imports nothing from
the runtime — keep it that way and import cycles cannot start.

A route module exports `handle<Name>(req, ctx)` where `ctx` is
`{ url, path, server }`, returning a `Response` or `null` to fall through.
Adding a route means adding it to the right module; adding a *surface* means a
new module plus one dispatch line in `server.js`.

Routes:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /f/:slug` | public | funnel page — HTML shell with the funnel JSON inlined |
| `GET /_of/[v-<hash>/]*` | public | engine source served raw, mirroring `packages/engine/src`; the optional version segment decides the cache header |
| `GET /_app/*`, `/`, `/builder`, `/leads`, … | public | console shell (see `APP_ROUTES`) |
| `GET /api/funnels`, `/api/funnels/:slug` | public | funnel list / document |
| `GET /r/:token` | public | one client's read-only report; the token in the path is the credential |
| `POST /api/lead`, `/api/events` | public, rate-limited | ingest → the Postgres delivery queue, or the direct fan-out + the JSONL sink when it did not take the record |
| `POST /api/otp/send`, `/api/otp/verify` | public, rate-limited | email verification challenge |
| `POST /api/internal/drain` | **INTERNAL_SECRET** | delivery-queue drain, called by pg_cron via pg_net |
| `GET /healthz` | public | liveness |
| `POST /api/builder/save\|delete\|duplicate` | **admin** | writes JSON into `FUNNELS_DIR` |
| `GET /api/admin/leads`, `/api/admin/stats` | **admin** | console data, preview-filtered |
| `GET\|POST /api/admin/email-settings` | **admin** | mail config; secrets never returned |
| `POST /api/admin/targets/sync` | **admin** | re-derive every funnel's delivery targets |
| `GET /api/admin/deliveries` | **admin** | delivery log; never selects `delivery_target.config` |
| `POST /api/admin/deliveries/resend` | **admin** | `resend_delivery` + an inline attempt; refuses `delivering` |
| `GET\|POST\|DELETE /api/admin/domains` | **admin** | the host → funnel mapping; refuses to map the console's own host |
| `POST /api/admin/assets/sign` | **admin** | mint a signed Storage upload URL; the bytes never come here |
| `DELETE /api/admin/assets` | **admin** | delete one uploaded object |
| `GET /api/admin/clients` | **admin** | the client list, for the report-link picker |
| `GET\|POST\|DELETE /api/admin/report-tokens` | **admin** | issue / list / revoke a client's report link; the token is returned once, at creation |
| `POST /api/admin/test-email` | **admin** | send a test message |
| `POST /api/ai/generate`, `/api/ai/improve-copy` | **admin** | copilot (OpenAI optional) |

Only the console shell is public; every API behind it is not — with one
narrow exception. The `/f/:slug` page, the ingest endpoints and `GET /r/:token`
are the entire public API surface, and the third of those is public in name
only: it carries no `Authorization` header, but the 256-bit token in its own
path is the credential, checked the same way a bearer token would be.

**Meta Conversions API.** `persist()` also forwards to Meta server-side via
`forwardMetaCapi`, opt-in through `META_PIXEL_ID` + `META_CAPI_TOKEN` (env only,
never per funnel, never from the request body).

The token goes in the **URL query string**, because that is the only form Meta
documents for a JSON payload to this endpoint. Moving it into the JSON body or an
`Authorization` header looks tidier and was tried — but neither is verified for
`/events`, and a silent `400` would disable conversion tracking with nothing but
a status code in the log. Do not "fix" this.

That puts a credential in the URL, so the containment is entirely on the logging
side and is **not optional**: a fetch failure is logged through `errSummary(err)`,
never as the error object, because Bun puts the full request URL on `err.path` and
`console.warn("…", err)` would print the token. `forwardWebhook`, the relay, the
Resend and Supabase calls all follow the same rule for the same reason.

### apps/app

Client-routed SPA. Views are `<section id="view-*">` blocks in `index.html`;
state is one working funnel document (`state.funnel`) edited in the builder,
previewed live in an iframe via `postMessage`, and saved back through
`/api/builder/save`. `Cmd/Ctrl+K` opens the command palette, `Cmd/Ctrl+S` saves, and a number key
switches views by POSITION in `VIEWS` — so inserting a view renumbers every one
below it. The palette's `hint` labels are derived from `VIEWS` for that reason;
they were hand-written once and taught three wrong shortcuts.

Workspace-level settings (workspace name, domain, currency, language, lead
notification email, global head/CSS injection, GDPR bar, AI provider/model/key/
brand voice) live in `localStorage` under `of.*` keys, listed in the `SETTINGS`
table in `app.js`. They are per-browser, not per-funnel and not server-side.

## Invariants — do not break these

**No build step.** The browser imports engine source directly. Every import in
`packages/engine/src` must be a relative, browser-resolvable ESM specifier, and
the engine must never gain an npm dependency. This is the whole reason a funnel
is fast on 4G.

**Ingest must never fail a visitor.** `/api/lead` and `/api/events` answer `202`
whatever happens downstream — a dead webhook, an unknown funnel or a Supabase
outage is a `console.warn`, never a `500`. Client-side, `leads.js` uses
`sendBeacon` with a `keepalive` fetch fallback and swallows errors.

The invariant is that ingest never *fails* a visitor, not that it never waits.
With a database configured, `/api/lead` **awaits** the `ingest_lead` RPC before
answering: one round trip to Postgres in the same region, against the
alternative of an insert that only ever existed in an invocation the platform
froze the moment the response was written.

**A lead is delivered by the queue or by the fan-out, never by both.**
`persist(kind, record, { fanOut })` is where that is decided. When `ingest_lead`
succeeded, its delivery rows own the outbound calls — retried, backed off,
dead-lettered, readable — so `fanOut` is `false` and the old `Promise.allSettled`
path stays out of it. Every other outcome (database unreachable, unknown slug, a
row the schema refused) passes `fanOut: true` and delivers the old way *now*: a
degraded delivery beats a lost lead. Both at once is the operator receiving
every lead twice, which is why the flag is passed explicitly rather than derived
inside `store.js` from `dbConfigured()`.

The JSONL sink is decided by a THIRD field, `durable`, not by `fanOut` (WO D-24).
It used to be written on every path, which made `.data/*.jsonl` a second copy of
every lead on a deployment that has Postgres — and `erase_subject` and
`purge_expired` are both Postgres-only, so an erased lead went on sitting in that
file with nothing able to reach it. It is now written only when nothing durable
took the record, which makes it the store of LAST RESORT that PLAN.md §2.4 always
described.

**`durable` is not `fanOut` inverted, and the first version of D-24 shipped that
bug into review.** `ingest_lead` commits the lead row BEFORE it inserts any
`delivery` row and returns the id on every success path, so a client with no
`delivery_target` gets `queued: 0` with the lead durably stored: `queueOwnsIt` is
false (nothing will deliver it, so the legacy fan-out must run) while `durable` is
true (Art. 17 can reach the row). Nothing creates `delivery_target` rows until
WO12, so that is not an edge case — it is every lead on every Postgres deployment
today, and reading the sink off `fanOut` reproduced the exact defect D-24 removed.

So `storeLead()` returns three fields for three questions, and answering two of
them with one value has cost something every single time:

    leadId      — is there anything to DRAIN right now?
    queueOwnsIt — will anything else DELIVER this lead?
    durable     — did a store erase_subject can reach actually TAKE it?

Do not "fix" this back to unconditional to repopulate the console's lead inbox.
That inbox reads the sink and only the sink (`/api/admin/leads`,
`computeStats`), which is why it is empty on Vercel today and empty on a
Postgres self-host now — the answer is a Postgres-backed inbox
(TASK-HANDOFF.md), not a personal-data store nothing can delete from.

`fanOut` answers "will anything else deliver this lead?", and it is deliberately
NOT `Boolean(leadId)`. Those came apart in both directions, and both reached the
operator:

- A **deduped** resubmit has no rows to drain — the first submit queued them —
  but the queue does own the delivery. Inferring it from a null lead id fanned
  out a second copy, so a double-tapped submit button sent the CRM and the alert
  inbox the same lead twice.
- A lead stored with **`queued === 0`** has a lead id and nobody to deliver it.
  Inferring it from a truthy id suppressed the fan-out and took the operator's
  webhook and lead alert silently dark. That is the state every deployment is in
  the moment it configures Postgres, because nothing creates `delivery_target`
  rows yet — the console gains that in WO12.

So `storeLead()` returns `{ leadId, queueOwnsIt }` and the two are read
separately: `queueOwnsIt` decides the fan-out, `leadId` decides the drain.
`apps/runtime/test/ingest-queue.test.js` pins both, and it is the only test that
exercises this route with a database configured — which is why the first version
of it shipped broken.

**Delivery targets are DERIVED, and every channel the fan-out had needs one.**
`lib/targets.js` builds `delivery_target` rows from the funnel document plus the
mail settings, and `saveFunnel` writes them through the `sync_delivery_targets`
RPC (PHASE-1-PLAN.md §4.3). Two rules hold this together:

- **One resolver.** The webhook destination comes from `webhookConfigFor()` in
  `lib/webhook.js`, shared with `forwardWebhook`. A second resolver would drift,
  and the fan-out is what the queue *degrades to* — so the day they disagree is
  the day an outage starts delivering leads somewhere else.
- **Creating the first target switches the fan-out off**, so anything it used to
  send that has no target goes silently dark. The webhook and the operator's
  "new lead" alert are targets. The visitor autoresponder is not a delivery of
  the lead at all, so it moved OUT of the `fanOut` branch in `persist()` and runs
  on every lead — leaving it inside was exactly that failure. Adding a new
  outbound channel to the fan-out means adding its target kind in the same
  change, or it works until a funnel gets configured and then never again.
- **The lead-alert address has one resolver too**, `notifyEmailFor()` in
  `lib/email.js`, used by `deriveTargets` AND by the fan-out's own
  `notifyOperatorOfLead`. Reading `integrations.notifyEmail` only in the first of
  those meant the console field did nothing on a deployment with no database
  (where `fanOut` is always true) and nothing for any lead that degraded to the
  fan-out. `persist()` resolves the funnel document once and passes it to both
  outbound channels — do not re-load it per channel, and do not read that field
  anywhere else.

`integrations.notifyEmail` (per-funnel alert address) is server-only and is in
`SERVER_ONLY_INTEGRATIONS`: the whole document is inlined into the funnel page,
so leaving it in publishes a client's address to everyone who clicks the ad.

**`delivery_target` rows are per FUNNEL, not per client — query them with the
predicate `ingest_lead` queues with.** A client with two funnels can have two
different webhooks, one per funnel, plus targets with `funnel_id is null`
meaning "every funnel of this client." So any query about "this funnel's
targets" — not just the queue's own dispatch — has to carry
`(funnel_id is null or funnel_id = <this funnel>)` (`phase1_functions.sql`,
`ingest_lead`), never `client_id = <this client>` alone. `lib/privacy.js`'s
caller in `routes/admin.js` got this wrong first: filtering on `client_id`
only described a sibling funnel's webhook in the notice for a funnel it does
not deliver to — a published legal document naming a recipient that receives
nothing. Reuse the predicate rather than re-deriving it; the day a second copy
drifts from `ingest_lead`'s is the day a query and a delivery disagree about
which funnel a target belongs to.

**A generated privacy notice may never claim anything the configuration does
not do — and where the configuration is non-compliant, the defect goes in the
TEXT, not only in the console's `warnings`.** `lib/privacy.js`'s `privacyNotice()`
is pure and switches every paragraph on something real in the `facts` it is
handed; two of its bugs, both found in review, were the module asserting a
safeguard that was not actually there: an unconditional Art. 28 sentence
publishing an AVV date for a client with no signed AVV, and a `sheet` delivery
target described as a live transfer to Google when that kind has no dispatcher
and dead-letters every lead sent to it. A `warnings` entry is not enough for
either case, because a warning lives in the console and this text gets pasted
into a document by an operator who may never open that panel — so the pixel-
without-consent case and the unsigned-AVV case both carry an inline
`[ACHTUNG — NICHT VERÖFFENTLICHEN]` marker in the body itself. Extending this
module to a new fact means gating its paragraph on that fact being true, not
on the feature merely existing.

**The router runs on two entry points, and both of Bun's gifts are passed in
rather than assumed.** `handleRequest(req, { server, waitUntil })` — see
PHASE-1-PLAN.md §4.2. Bun supplies a `server` object and a process that is still
alive after the response; Vercel supplies neither. Three rules follow:

- **No `server` means no loopback trust.** `isLoopbackRequest` returns false the
  moment `server` is absent, so a deployment with no `ADMIN_TOKEN` refuses every
  privileged request from everyone. That is the intended posture (PLAN.md §7.1)
  and it is why the check is explicit: `server?.requestIP?.(req)` would produce
  the same value with none of the meaning, and a gate that reads an unfamiliar
  platform as permission hands `/api/admin/*` to the internet on the first
  deploy where a variable was forgotten.
- **`clientIp` needs `TRUST_PROXY=1` there**, or it returns null and every
  per-IP ceiling collapses into one bucket shared by all callers — an outage,
  not a safe default. It warns once, naming the variable.
- **Work that outlives the response goes through `waitUntil`.** On Bun that is
  fire-and-forget. On Vercel it is the platform's own, read off the
  request-context global (the same place `@vercel/functions` reads it) with an
  **awaited fallback** if that is ever gone: the degraded-path fan-out is the
  only delivery a lead the queue refused will get, so `/api/lead` may become
  slower and must never become lossy.

**Nothing stores a raw IP** — and "nothing" is four places, because the address
arrives on the record and every store downstream had to be closed separately.

- `routes/ingest.js` hashes it with `IP_HASH_SALT` into `lead.ip_hash`, and with
  no salt set it stores nothing at all rather than an unsalted hash — the IPv4
  space is 2^32, so an unsalted digest is the address wearing a disguise.
- `persist()` strips `ip` before the JSONL sink. `.data/*.jsonl` was written from
  the record verbatim, so the one lead store a deployment with no database has
  was the one still holding the address in the clear. The record keeps `ip`
  in-process for `forwardMetaCapi`, which is opt-in and consent-gated.
- `lib/ratelimit.js` sends `rate_hit` a salted digest of the key, never the key
  itself. Every per-IP and per-address ceiling puts its subject in that string
  (`ingest:<ip>`, `otp-send:<email>`), and once the buckets moved into Postgres
  those became rows rather than a `Map` in one heap. Here a missing salt degrades
  to an unsalted digest instead of storing nothing — a bucket that is not written
  is a ceiling that does not bind. Nothing reads a key back, so the digest costs
  the limiter nothing.
- **Outbound payloads go through `outboundPayload()` in `lib/webhook.js`** —
  `ip`, `referer` and `user_agent` are dropped, because a body leaving the
  server is the one copy that cannot be recalled. It is a shared helper for a
  reason: the queue path (`recordOf` in `lib/delivery.js`) stripped them and the
  direct fan-out (`forwardWebhook`) did not, so the address the rest of this
  list takes care to hash was posted to the operator's CRM in the clear — on
  every install running without a database, which is the fan-out's whole
  purpose, and on every lead that degraded to it. Any new outbound channel calls
  this helper rather than re-listing the fields.
- `readJsonlRecords()` strips `ip` on the way out as well, so a sink written
  before all of the above stops feeding addresses to the admin readers.

The console shows no IP either, and did not simply hide the field: the lead
drawer printed `lead.ip || "127.0.0.1"`, so once nothing stored an address it
displayed a fabricated one in a panel labelled raw metadata.

The pattern behind all of it: a privacy claim written about one store is a claim
about one store. When you add a datum to the record, grep for the datum and find
every sink it reaches — the control you added is not the audit.

**An upload never passes through this server, and its path is never a filename.**
`POST /api/admin/assets/sign` mints a Storage token scoped to ONE object path and
the console PUTs the bytes straight to Supabase (PHASE-2-PLAN.md §1). Two reasons
it is built that way, and both are load-bearing: `Bun.serve` caps every request
body at `MAX_BODY` (64KB) **process-wide**, so an upload route that accepted the
file would have to raise that ceiling for public, anonymous `/api/lead` as well;
and Vercel caps a function body at 4.5MB, which a phone photo clears.

`assetPath()` builds `funnel/<slug>/<16 random bytes>.<ext>` where the extension
comes from the declared **content type**, never from the uploaded filename — the
browser owns that filename, it is often a person's name, and the bucket is
world-readable. The bucket has a public read policy and **no write policy at
all**: every upload is authorised by its own signed token, which keeps "who may
upload" answerable in one place. A deleted object can still be served from
Supabase's CDN for a while — verified, 2026-08-13 — so a deletion under Art. 17
is not complete at the moment the delete call returns.

**The request-body ceiling is `readJson`'s, not `Bun.serve`'s.** `maxRequestBodySize`
in `server.js` looks like the cap and is not one: it is enforced against
`content-length`, and a request sent with `Transfer-Encoding: chunked` carries no
`content-length` at all — verified on Bun 1.3.13, where a 256KB chunked body
reached the handler in full against a 64KB `maxRequestBodySize`, on `/api/lead`,
public and unauthenticated. `readCapped()` in `lib/http.js` counts bytes off the
stream itself as they arrive and aborts past `MAX_BODY`, which is the only ceiling
both entry points (Bun and Vercel) actually share — `maxRequestBodySize` doesn't
exist on the Vercel path at all. Any new route that reads a body relies on
`readJson`/`readCapped` for its size limit, never on a platform-level setting.

**Preview traffic must never pollute analytics.** Two independent guards, and
new code needs both: `Controller._emit()` bails when `isPreview` or
`?preview=1` / `?admin=1`, and the server's `isPreviewRecord()` filters records
out of `/api/admin/*`. The builder iframe depends on this.

`isPreviewRecord` parses the query string; it must never substring-match.
`referer.includes("preview=1")` also fires on
`?utm_campaign=spring-preview=1-sale`, and because this predicate decides whether
a lead is persisted at all, anyone circulating a link with those nine characters
buried in it silently destroyed every lead that came through — no log, and a 202
back to the visitor so the funnel looked fine. It is also type-guarded, because
`meta.url` is attacker-supplied JSON and an unguarded `.includes` returned a 500
from public ingest. `hasPreviewFlag()` exists on both sides (server and
`dom.js`) for exactly this; use it rather than writing the check again.

Ingest and the admin readers must use the SAME predicate. They drifted once: the
ingest short-circuit checked three markers while `isPreviewRecord` checked six,
so a record marked only via `isPreview` / `meta.isPreview` / a `meta.url`
containing `preview=1` was persisted and fanned out to the webhook, the alert
inbox and the autoresponder — then filtered out of the console. A stranger could
inject records the operator could never see. Both sides now call
`isPreviewRecord`.

**Privileged routes are gated structurally.** `PRIVILEGED_PREFIXES` in
`lib/auth.js` is the single definition of what "privileged" means
(`/api/admin/*`, `/api/builder/*`, `/api/ai/*`). The router checks it, runs
`isCrossSiteRequest` then `requireAdmin`, and dispatches `handleBuilder` /
`handleAdmin` / `handleAi` **inside that branch** — so those handlers are
unreachable except through both checks. A new endpoint in one of those modules
is protected by where it lives, not by its author remembering.

This used to be an early `if` with the handlers following it in file order:
correct, but only for as long as nobody added a handler above it. Do not move a
privileged handler out of the branch, do not add a privileged route under a
different prefix, and do not weaken the gate: with `ADMIN_TOKEN` set it requires
a bearer token, and without one it allows only direct loopback callers. A request
carrying `x-forwarded-for` is never treated as loopback — otherwise anyone
reaching a reverse-proxied deployment would inherit localhost's privileges.

A test sweeps every privileged endpoint against both refusal modes (proxied →
401, cross-site → 403) and asserts public ingest is *not* caught by the gate, so
a route that escapes the branch fails CI rather than production.

**`/api/internal/*` is a second structural gate, with a second secret.**
`INTERNAL_PREFIXES` + `requireInternal` in `lib/auth.js`, built exactly like the
privileged branch and dispatched inside it for the same reason. It guards the
delivery drain, whose caller is a `pg_cron` job going out through `pg_net` — not
a browser and not the operator. It does **not** use `ADMIN_TOKEN`: that token
lives in the operator's browser and is rotated when a laptop is lost, while
`INTERNAL_SECRET` lives in Supabase Vault and is rotated when the database is
re-provisioned. Share them and rotating either one silently stops the queue
draining — which looks exactly like a queue with nothing in it.

With `INTERNAL_SECRET` unset the route answers **404, not 401**, including to a
caller presenting a guess: an unconfigured endpoint must not advertise that it
exists and is worth guessing at. Loopback is not trusted here either — there is
no developer convenience to buy, and `pg_net` never arrives over loopback.
`/api/internal/*` is never added to `PUBLIC_CORS_PATHS`.

**A mapped custom domain is a THIRD structural gate, and it is an allowlist.**
`funnelHostSlug()` in `lib/domains.js` answers what a hostname is, and
`handleFunnelHost` in `handler.js` is entered before any other dispatch. A mapped
host serves exactly one funnel — `/`, its own `/f/:slug` and `/api/funnels/:slug`,
the engine assets, and the ingest endpoints the page posts to. Everything else
answers **404**: the console shell, `/api/funnels` (the LIST), and every
privileged and internal prefix.

It is not a routing nicety. The console, the builder and the whole privileged API
ship in this same handler, so a client's hostname pointed at this project serves
all of it — and because a page on that host is *same-origin with itself*,
`isCrossSiteRequest` passes and `ADMIN_TOKEN` is the only thing left in the way.
The funnel LIST is refused for its own reason: it returns every funnel's slug,
name and colour, which on a client's domain is a directory of the operator's
other clients.

The gate runs **before** the `OPTIONS` reply and before `/healthz`, so "before
any dispatch" is literal. `OPTIONS` is answered by the same `corsPreflight()` on
both hosts — identical bytes, so it reveals nothing about which routes exist
where — and `/healthz` answers 404 there like everything else: an uptime probe
belongs on the console host, and a client's domain has no reason to report
whether a database is configured.

It requires the `Host` header to reach the process **unmodified**. A reverse
proxy that rewrites it (nginx `proxy_pass` without `proxy_set_header Host
$host;`) makes every mapping miss, and a hostname whose mapping misses serves
the console. There is no `x-forwarded-host` fallback on purpose: that header is
caller-supplied, and trusting it would let anyone claim any mapping with one
header.

Three rules follow. The branch is an **allowlist**, so a route added later does
not appear on client domains by default — invert it and every new endpoint is
published on every client's brand until someone remembers. The host is matched
**exactly**, after a normalisation that only ever removes (case, port, one
trailing dot): `Host` is attacker-controlled, and a suffix test is satisfied by
`client.de.attacker.tld`. And `POST /api/admin/domains` refuses to map the host
the request arrived on, because every admin route is 404 on a mapped host — so
that mistake can only be undone by deleting a row in the database.

Every mapping carries **where it came from**, and the delete path refuses an
`env` one. A PostgREST `DELETE` that matches no row still succeeds, so a Remove
button on a `FUNNEL_DOMAINS` entry reported a client's domain disconnected while
it was still serving, and the row came back on the next refresh. The console
shows those as read-only; `listDomains()` is what carries the distinction.

Loopback trust also validates the `Host` header against `LOOPBACK_HOST_RE` (plus
`ALLOWED_HOSTS`). Without that, DNS rebinding walks straight through every other
gate: a page served from `http://evil.tld:3000`, whose A record the attacker then
flips to `127.0.0.1`, arrives over loopback AND is same-origin with itself — so
the socket check passes, `Sec-Fetch-Site` reads `same-origin`, and being
same-origin the page can read the response. `Host` is the only signal left that
separates the operator's console from a rebound attacker origin.

**The client report link is a credential in a URL, and everything about
`/r/:token` follows from that (PHASE-2-PLAN.md §3).** There is no
`Authorization` header and no session — the 256 bits after `/r/` are the whole
access control, minted by `crypto.getRandomValues`, and the database stores
only `sha256(token)`, looked up **by that digest**. That is deliberate rather
than an oversight of PLAN.md §5.3's "constant-time comparison" requirement: an
equality test on an indexed digest column is not a timing side-channel an
attacker can use without already holding a preimage, so the constant-time
requirement is satisfied by having no comparison to time, not by writing a
careful one.

**Every refusal is the same 404 with the same body.** Expired, revoked, never
existed, one character off a real token — a report link that answers any of
those differently tells a prober which half of a guess was right. `routes/report.js`
builds the 404 once (`notFound()`) and every failure path returns that same
value; do not add a message, a status code or a header that varies by reason.

**Validity is decided by `resolve_report_token` in SQL, in one place.** It
checks the digest, the expiry, the revocation and the client's own
`deleted_at`, and stamps `last_seen_at`, all in one round trip — so the route's
entire authorisation logic is "did a row come back". A second check written in
JavaScript on top of that would be a second answer to the same question, and
the day they disagree is the day one of them is wrong silently.

**The page is server-rendered with no JavaScript and no report API, on
purpose.** The obvious build is a console-SPA view fetching `/api/report/...`
with the token — but the token IS the credential, so a client-side page would
have to hold it and send it on every subrequest, putting it in `history`, in
every `Referer` its subresources generate, and in whatever the browser syncs.
One route that reads the token out of its own path and renders the answer
means the token appears in exactly one request. It also means there is no
second surface (`/api/report/*`) needing its own auth, its own rate limits and
its own place in the route order.

`Referrer-Policy: no-referrer` on this route **overrides** the shared
`strict-origin-when-cross-origin` every other page sends, because the secret is
in the PATH here — a `strict-origin` policy still leaks the origin on a
click-out, but on `/r/:token` the path *is* what must never leave, so even that
much is too much.

**The report is 404 on a mapped custom domain because `handleFunnelHost` is an
allowlist and nothing added it — do not add `/r/` to that allowlist.** The
report is the operator's surface for reading about ONE client; published on
that client's own ad domain it would be one wrong mapping away from serving
one client's leads on another client's brand, which is exactly what the
funnel-host allowlist exists to make impossible. This is pinned by
`apps/runtime/test/report.test.js`'s "the report is absent on a mapped funnel
host, and present on the console host" test, which renders the SAME token on
the console host in the same assertion — so the 404 on the mapped host proves
the gate is doing the refusing, not a fixture that was never going to render
anywhere.

**The token never reaches a log line.** A database failure between resolving
the token and building the report is logged (`console.warn`), but only with
the client id — never the token, never a URL built from it. Same rule the rest
of the runtime applies to `err.path`.

**The deletion/restriction/spam exclusions live in ONE CTE inside
`client_report`, shared by the counter and the list.** `deleted_at is not
null`, `restricted` (Art. 18 blocks export, and a report is an export) and
`is_spam` are each excluded for a different reason, but they are excluded ONCE,
in the `visible` CTE the SQL function builds — both the `total`/`d7`/`d30`
counters and the `leads` array read from it. Two separate queries carrying two
copies of that predicate is how a client ends up reading "14 Anfragen" above a
table of 11: the day the counter's copy and the list's copy drift is invisible
until someone counts.

**Privileged routes also refuse cross-site browser requests.** Authentication is
not enough on its own: with no `ADMIN_TOKEN` the gate trusts loopback, so a page
the operator merely *visits* was able to drive the console. `readJson` ignores
`Content-Type`, so `fetch(…, {mode:"no-cors", headers:{"content-type":
"text/plain"}})` was a CORS *simple* request — no preflight to stop it — that
wrote a funnel document, and a funnel renders on the console's own origin where
`of.adminToken` lives. `isCrossSiteRequest()` now rejects any privileged request
carrying a cross-site `Origin` or `Sec-Fetch-Site`, checked *before*
`requireAdmin`. Two rules follow:

- CORS headers and the `OPTIONS` reply belong only to `PUBLIC_CORS_PATHS`
  (`/api/lead`, `/api/events`, `/api/otp/*`). Answering `OPTIONS` with
  `Allow-Origin: *` for every path green-lit the preflight for privileged
  routes. Do not widen that set.
- A funnel document is operator-authored and the engine renders one field of it
  as markup (`step.consent`). That is now filtered through `richText()`, but a
  forgeable write path is still a stored-content hole on the console origin, so
  anything that weakens the CSRF check matters regardless.

**`x-forwarded-for` is not trusted unless `TRUST_PROXY` is set.** It is a request
header, so honouring it unconditionally made every per-IP limit bypassable by
rotating a string. `clientIp()` returns the socket address by default and warns
once if a forwarded header shows up without the flag. Anything keyed on a client
address inherits this — do not read the header directly.

**Webhook targets are resolved, vetted, and then pinned.** `resolveSafeTarget()`
rejects a hostname whose DNS answer lands on loopback, a private range,
link-local or cloud metadata — and for `http://` it aims the request at the
address it actually vetted, carrying the original `Host` so virtual-host routing
still works. That closes DNS rebinding rather than documenting it: the resolver
cannot answer differently between the check and the socket, because the socket no
longer consults it. `https://` is deliberately left on the hostname — TLS already
defeats the harmful case, since a rebound address cannot present a valid
certificate for the operator's configured name, and overriding SNI would trade a
closed hole for an untestable one. Use `resolveSafeTarget()` for any new outbound
call to an operator-supplied URL; `isSafeWebhookTarget()` alone is the textual
check only.

**Its lookup is bounded, because `dns.lookup()` is not.** That call takes no
signal and no timeout — it hands off to getaddrinfo and returns when the OS
resolver is done, which against a nameserver that drops queries rather than
refusing them can be effectively never. It sits on the delivery path *before*
any per-attempt signal exists, so nothing else bounds it: not
`DELIVERY_TIMEOUT_MS`, not `DRAIN_BUDGET_MS`, not the caller's own abort. One
such target inside a drain chunk holds up the whole batch and can carry the cron
invocation past `pg_net`'s 55s timeout. It is now raced against `DNS_TIMEOUT_MS`,
and a timed-out lookup is treated exactly like a failed one — so the bound can
only ever make the guard refuse MORE, never less. The delivery is retried, not
dead-lettered: a resolver that is slow now may not be in thirty seconds.

The two failure modes of `resolveSafeTarget` returning null are NOT the same and
callers must not merge them. A URL it rejects on sight (loopback literal, private
range, a scheme that is not HTTP) can never start working, so `lib/delivery.js`
dead-letters it. A name it could not resolve may work on the next attempt, so
that retries. Merging them meant one DNS blip dead-lettered every webhook in the
system on its first attempt.

**Operator-pasted script is opt-in, and never `'unsafe-inline'`.** A funnel's
`customHead` / `customBody` are injected raw, but script inside them is refused
unless `ALLOW_CUSTOM_SCRIPTS=1`. The default is load-bearing: `/f/:slug` is served
from the SAME ORIGIN as the console, and `of.adminToken` lives in that origin's
`localStorage` — so a script on a funnel page reads the token and drains
`/api/admin/*`. Funnel documents are imported from templates and bug reports, so
executing what a document carries turns an import into console takeover.

When enabled, `funnelCsp` allows each inline script by the SHA-256 of its exact
bytes and each external one by its origin (added to `script-src` *and*
`connect-src` — an origin that can load but not beacon is a script that silently
reports nothing). `step.consent` and any future renderer XSS stay blocked,
because their content was never hashed in. Two rules:

- `funnelPage()` and `funnelCsp()` must read the fields through `customCode()`.
  They ran the same `||` chain separately at first; the moment those drift, the
  hash covers different bytes than are served and every pasted script is refused
  with nothing logged.
- With the flag off, a document carrying script logs a warning naming the funnel.
  Do not remove it — the failure was previously invisible server-side, and the
  operator only saw a CSP violation in the *visitor's* console.

**Engine URLs carry a version segment, and only they are cached hard.**
`/_of/v-<hash>/index.js`, built from `ENGINE_BASE` in `lib/config.js`. The
segment is decorative to the lookup — `serveEngine` strips it and serves what is
on disk, so an old cached page keeps working after a deploy — and load-bearing to
the cache: it is what makes a URL safe to pin forever. The `immutable` header
therefore follows the URL *shape*, not the environment, and an unversioned
`/_of/theme.js` gets `no-cache` instead. Sending `immutable` on an unversioned
URL is the bug this replaced: it pinned every browser that had ever loaded a
funnel page to that deploy's engine for a year, so no engine fix reached a
returning visitor — found live when a deleted Google Fonts request kept firing
from cache (PHASE-1-PLAN.md §4.9.1). A query string does not work here: engine
modules import their siblings relatively, so `?v=` on the entry point never
reaches `./theme.js`.

**Funnel pages carry a strict CSP.** `script-src` is pinned to the SHA-256 of the
inline boot script, which is why `FUNNEL_BOOT_SCRIPT` must carry nothing that
varies *within* a deploy — put a funnel value in it and every funnel page stops
running its own JavaScript, silently, with nothing thrown server-side.
`ENGINE_BASE` is interpolated into it and is safe for exactly that reason: it is
resolved once at import time, so the hash is computed from the bytes every page
in this deploy serves. A test recomputes the
digest from the served bytes. Third-party script origins are added only for the
pixels a funnel configures, and `frame-ancestors` is deliberately absent because
funnels are embedded and the builder previews them in an iframe.

**Outbound mail is capped by something the caller cannot rotate.** `/api/otp/send`
and the lead autoresponder both mail an address taken from a public request body.
Their per-address and per-IP limits are the everyday guards, but the per-IP key
comes from `clientIp`, which honours caller-supplied `x-forwarded-for` — rotate
it and the ceiling never binds, turning the operator's domain into an open relay.
Both paths therefore also pass a global `MAIL_HOURLY_CAP` (`MAIL_MAX_PER_HOUR`,
default 500). Any new endpoint that sends mail to a caller-supplied address needs
the same absolute ceiling.

**Nothing logs an error object from an outbound `fetch`.** Bun puts the full
request URL on `err.path`, so `console.warn("…", err)` prints whatever the URL
carried — the Meta CAPI `access_token`, a webhook token in the path, an
`SMTP_RELAY_URL` credential. Log `errSummary(err)` (code/message only); a bare
`res.status` is fine.

**Path containment uses `isInside()`, not `startsWith`.** A bare prefix test also
accepts a sibling that shares the root's name (`/apps/app` vs `/apps/app-legacy`).
`isInside()` requires a separator. The WHATWG URL parser resolves literal and
`%2e`-encoded dot segments before routing, but `%2f` survives to
`decodeURIComponent`, so this check is what actually stops traversal.

**Third-party sharing is consent-gated in two independent places.** A funnel opts
in with `consent.enabled` on the funnel document (never a localStorage setting — a
per-browser value can't reach a visitor). Both halves must stay:

- *Client* — `Controller._pixel()` checks `marketingAllowed()` before every
  `firePixel`, so **every** pixel call site must go through `_pixel()`; a direct
  `firePixel` import in new code silently bypasses the gate. The webfont used to
  ride the same decision; it is self-hosted now (PHASE-1-PLAN.md §4.9) and there
  is nothing left to gate — the gate was removed with the request rather than
  left pointing at a same-origin file, because a gate around a request that
  cannot leak tells the next reader something untrue.
- *Server* — `forwardMetaCapi` re-derives the gate from the funnel document rather
  than trusting `record.meta.consent`: with `consent.enabled` on, only an explicit
  `"granted"` forwards, so a stripped field is a refusal, not permission. When the
  document can't be resolved it warns and falls back to the client signal —
  deliberately not failing closed, which would disable CAPI for funnels whose `id`
  is not their slug.

Gated: browser pixels, the Meta CAPI forward. **Not** gated: lead
capture (`/api/lead`) and first-party drop-off events (`/api/events`) — the
visitor typed their details in and pressed submit, so dropping the lead would be
a broken funnel rather than a private one, and those records stay on the
operator's own server. See the header of `src/consent.js`.

**`record.meta.consent` stays a plain string, forever.** `lib/capi.js` compares
it to `"granted"` directly (`consent !== "granted"`); shaping it into an object
would make that comparison false for every lead and silently turn off the Meta
CAPI forward with nothing thrown anywhere. The §8.4 consent evidence (signal +
timestamp + `consent.textVersion`) therefore rides as a SEPARATE field,
`meta.consentRecord`, which `routes/ingest.js` validates (known keys, a signal
from the three the engine can produce, bounded strings) before mapping it into
`p_consent` — `/api/lead` is public, so that field is attacker-controlled input
until validated. `lead.consent` in Postgres ends up `{ signal, at, text_version }`;
an older engine build sending only the bare string is normalised into the same
shape rather than kept as a second one. Do not merge the two fields, and do not
add a third place consent evidence can live.

**Never trust the client for anything that matters.** Two live examples worth
copying: `email_verified` arrives in the lead payload but is re-derived from
the server's own `verifiedEmails` record before being stored, and the webhook
destination is read only from the environment or the funnel document — never
from the request body, because `/api/lead` is public. Outbound URLs go through
`isSafeWebhookTarget`, which blocks loopback, private ranges and the cloud
metadata address.

**Secrets never travel outward.** `GET /api/admin/email-settings` runs
`redactEmailSettings`, which strips `resendApiKey` / `brevoApiKey` / `smtpPass`
and replaces them with `…Set` booleans; writes go through an allowlist (`WRITABLE_EMAIL_KEYS`)
so an unexpected key cannot be persisted, and a blank secret means "keep the
existing value" rather than wiping it. The HTTP relay URL is env-only and never
settable through the API. The same rule shapes the delivery log: it names its
columns and never selects `delivery_target.config`, which holds the webhook
secret, and the row is rebuilt field by field on the way out — so a select that
one day grows a column still cannot reach the console by accident.

**Path traversal.** Any route that reads or writes a file validates against
`SLUG_RE` *and* checks the resolved path still `startsWith` its root dir. Copy
that pattern for any new file-touching route.

**A funnel document is operator-authored, not operator-trusted.** Documents
arrive from templates, shared packs and bug reports, and the console previews an
imported one in a same-origin, unsandboxed iframe — so any field that reaches a
sink has to be filtered by the engine itself, not by the CSP that only the
`/f/:slug` route sends. Three rules, one per sink that was found open:

- **Markup:** `el(..., { html })` is `innerHTML` and takes string literals only.
  A funnel field rendered as markup goes through `richText()` in `dom.js`, which
  rebuilds the fragment from an allowlist so no attribute survives except an
  `href` that passed `isNavigableUrl`. `step.consent` is the only such field
  today; adding a second means calling `richText`, not widening the allowlist.
- **iframes:** an embed URL goes through `embedUrl()`, which parses and matches
  the hostname by equality. The check it replaced was an unanchored regex, so
  `javascript:alert(1)//player.` satisfied it — and an iframe `src` executes on
  load with nothing to click.
- **Endpoints:** `integrations.leadEndpoint` is honoured only on this origin —
  `publicFunnel()` drops anything else and logs the funnel, and `Controller`
  re-checks with `isSameOriginUrl` because the engine also mounts standalone
  where no redaction or CSP applies. A full URL there sent every lead to that
  origin, and `funnelCsp` used to add the origin to `connect-src`, so the CSP
  certified the exfiltration. Forwarding leads onward is a server-side webhook,
  whose destination comes from the environment or the funnel document and never
  from a visitor's request.

**A URL check resolves the URL. It never pattern-matches the string.**
`isNavigableUrl`, `isSameOriginUrl` and `sameOriginPath` all construct a `URL`
and ask what came out. They used to test `startsWith("//")` and `startsWith("/\\")`,
which reads the string a human sees rather than the one the browser acts on: the
WHATWG parser deletes every ASCII tab, newline and carriage return from anywhere
in the input *before* resolving, so `"/\t/evil.tld/x"` — one JSON escape — passed
all three tests and still arrived as `https://evil.tld/x`. That defeated the
`leadEndpoint` guard and the `href` filter in `richText` with the same character.
Any new check on an operator-supplied URL parses it; a textual test will lose
this race again in a way the test suite reads as correct.

It lost it again in `routes/report.js`, and the second loss is worth keeping
because it looked nothing like a URL check. The client report links a lead's
email as `mailto:<value>`, and the value was validated with `EMAIL_RE` — no
whitespace, one `@`, a dot. `mailto:` takes header parameters after a `?`, so
`victim@example.com?cc=attacker%40evil.invalid` satisfies that pattern (the
second address is percent-encoded, so the regex never sees an `@`) while the
browser resolves it to a link that silently CCs a stranger on the client's reply
to their own customer — planted by any anonymous visitor typing it into the
public lead form. `mailtoHref()` now builds the URL and requires `search` and
`hash` to be empty and `pathname` to equal the input. The rule is not "check
URLs with a parser"; it is **anything a parser will later interpret must be
checked by that parser**, and a scheme with its own grammar (`mailto:`, `tel:`,
`data:`) counts. Where rebuilding the value from scratch is possible — the phone
number is reassembled from its digits — that is stronger still, because nothing
of the input survives to carry a parameter.

**Escaping.** Server-rendered HTML goes through `esc()`; funnel JSON embedded in
a `<script>` goes through `jsonScript()` (which escapes `<`, U+2028, U+2029).
The console has its own `esc()` for the lead inbox. A runtime test asserts a
funnel round-trips through the HTML shell intact.

**Renderers never touch state.** They call the Controller's imperative API
(`answer`, `submitForm`, `advance`, `redirect`, `after`). Use `ctrl.after(ms, fn)`
instead of `setTimeout` so pending callbacks are cancelled on navigation.

**Console fields need a consumer.** The builder will happily persist any key into
`funnel.theme` / `funnel.integrations`, and it will be saved to disk — but it
does nothing until the engine reads it. When adding a field to a settings modal,
wire the consumer in the same change (see the unwired list below).

## Common tasks

**Add a step type:** add the typedef to `src/types.js` and the `Step` union →
create `src/render/<type>.js` → register it in `renderBody()` in
`src/render/index.js` → add the name to `STEP_TYPES` in `apps/app/app.js` so the
builder can create it.

**Add a console view:** add it to `VIEWS` and `ROUTES` in `apps/app/app.js`, add
the path to `APP_ROUTES` in `apps/runtime/lib/config.js` (so a hard refresh on the
URL still serves the shell), and add a `<section id="view-<name>">` to
`apps/app/index.html`.

**Add a pixel:** add the id to the `FunnelIntegrations` typedef in
`src/types.js`, handle it in `installPixels()` / `firePixel()` in
`src/analytics.js` (extend `EVENT_MAP`), then add the input to the Pixels modal
in `apps/app/index.html` and to the `pixelFields` table in `app.js`.

**Add a content block:** add the typedef to `src/types.js` and the `ContentBlock`
union → render it in `renderBlock()` in `src/render/blocks.js` → style it in
`src/styles.css` → add an entry to `BLOCK_SCHEMA` in `apps/app/app.js` so the
section editor can create and edit it → mirror the type into
`packages/engine/types/index.d.ts`.

**Add a funnel:** drop a JSON file in `examples/` — `/api/funnels` lists the
directory, so it appears in the console with no registration step.

**Add a template:** add an entry to `FUNNEL_TEMPLATES` in `apps/app/templates.js`.
Set `category` — the filter pills in `index.html` match on it exactly, and a
template without one only ever appears under "All". Use the field names the
engine actually reads (`ctaLabel`, `submitLabel`, `buttonLabel`/`redirectUrl`);
a `buttonText` key is silently ignored and the button falls back to "Continue".

A template must render with no assets. Both places that shipped an empty `src`
(a hero `media` video, a `gallery` of blank items) drew an empty black player and
three broken image boxes on the operator's first click — the same failure the
file header warns about for hotlinked photography, self-inflicted. Prefer a
gradient, an `faq`, or a `stats` block over an asset placeholder.

The shortlist in the "Create New Funnel" modal is the `BLUEPRINTS` table in
`app.js`, and its `key`s must exist in `FUNNEL_TEMPLATES`. Two of the three used
to name a *category* (`lead-gen`, `fitness`), so `useTemplate()` found nothing and
returned — a dead button with no toast and no console warning. The cards are now
rendered from the table rather than authored in `index.html`, so a card cannot
name a funnel that isn't there, and `useTemplate()` toasts on an unknown key
instead of returning silently. Don't re-hardcode them.

## Style

- JSDoc types throughout, `strict: true`. No `.ts` files in runtime code;
  `packages/engine/types/index.d.ts` is the published surface.
- **`bun run typecheck` covers the engine and `apps/runtime`, not `apps/app`.**
  It runs three projects: `packages/engine/jsconfig.json`,
  `apps/runtime/jsconfig.json` (added 2026-08-13, `allowJs` + `checkJs`, and it
  pulls in `api/index.js` because the Vercel entry point imports straight into
  that directory), and `tsconfig.base.json`, whose only file is the published
  `.d.ts`. Until the runtime project existed every JSDoc annotation under
  `apps/` was decoration — measured with `tsc --listFiles`, 101 errors the day
  it was switched on — so a green typecheck in this repo's history says nothing
  about the runtime before that date.
  Still uncovered: `apps/runtime/test/**` (excluded: `bun:test` has no types
  here, and the suite is exercised by running it) and all of `apps/app`, which
  is browser code with its own globals. `@types/node` is a devDependency;
  `check-no-deps.mjs` only forbids runtime ones.
- Every module opens with a `@file` block explaining *why* it exists, not just
  what it does. Section banners (`/* ===== *`) separate concerns in long files.
  Match this density.
- Double quotes, semicolons, 2-space indent.
- Console DOM lookups use `$("id")`; guard with `if ($("x"))` or `?.` since
  modals share one `index.html` and an element may not exist in every build.
  This is load-bearing in `bindInspector()`, because the inspector is tabbed and
  only one tab's markup exists at a time: `insHeadline` / `insSubtext` / `insType`
  / `insId` / `rewriteBtn` are Content, `insNext` / `deleteStepBtn` are Logic.
  Seven of them predated the tabs and were bound unconditionally, so
  `bindInspector` threw on *every* tab. That throw escapes `renderInspector()`
  into `setWorkingFunnel()`, which is how "Use template", "Blank Funnel" and
  opening a funnel all became clicks that did nothing at all — the builder was
  unreachable and nothing was logged where an operator would look. An unguarded
  lookup here does not degrade one field; it takes out the whole builder.

## Known gaps (UI exists, nothing consumes it yet)

The console writes these, but no engine or server code reads them. Treat them as
TODOs, not working features:

- `theme.btnStyle` (`flat` / `glow` / `pressable-3d`) — not read by `theme.js`
  or `styles.css`.
- `integrations.googleAdsId`, `googleAdsLabel`, `linkedinTagId`,
  `pinterestPixelId` — not in the `FunnelIntegrations` typedef and not handled
  by `analytics.js`.
- `of.globalCode`, `of.notifyEmail`, `of.currency`, `of.language`,
  `of.branding.hidden` — stored in localStorage, never read back.
  `of.globalCode` is the one to be careful with: it is described in the UI as
  injected into every published funnel, so wiring it means injecting operator
  HTML into the funnel page. Do that server-side from the funnel document, not
  from a per-browser localStorage value.
  The consent bar used to be in this list as `of.gdpr.enabled`; it now lives on
  the funnel document as `consent.enabled` and is read by `src/consent.js`. That
  move is the pattern to copy for the rest: a visitor-facing setting has to be in
  the funnel JSON, because that is all the funnel page is rendered from.
  `of.notifyEmail` is still dead, but the working version of it is now
  `integrations.notifyEmail` on the funnel document (Integrations modal → "Lead
  notification email"), read by `lib/targets.js`. Same move, server-side: a
  per-browser value cannot reach the delivery queue either.
- `of.ai.brandVoice` and `of.ai.provider` are saved but never sent;
  `generateFunnel()` still posts a stale `of.ai.tone` key that the settings UI
  no longer writes.

### The mirror image: wired in the engine, not reachable from the console

These work in the engine but the builder cannot create them, so they are reachable
only through a template or hand-edited funnel JSON:

- The `select` form field type — `form.js` renders it, but the console has no
  editor for its `options`, so offering it in `FIELD_TYPES` would only ever
  produce an empty dropdown. Add the options editor and the type together.
  (`file` is likewise absent: nothing in the ingest path stores an upload.)

Content blocks used to sit here too — none of them were reachable outside a
template. The section editor in the inspector (`BLOCK_SCHEMA` +
`renderSectionEditor` in `apps/app/app.js`) now covers all 20 block types on
every step type, `calculator` included. `BLOCK_SCHEMA` is the table to extend
when the engine gains a block; its field `key`s are the JSON keys the engine
reads, so they have to track `ContentBlock` in `types.js` or the console writes
a key nothing consumes.

The landing panel and the section editor both address the step by JSON path
(`data-path="blocks.2.items.0.title"`) through `readPath`/`writePath`, rather
than a named `data-*` attribute per field — which is why adding a field is a
line of schema and no wiring. Two consequences worth knowing: text edits
deliberately do **not** re-render the inspector (it is rebuilt from scratch, so
repainting per keystroke would move focus out of the field being typed in), and
`bindInspector` must drop its previous delegated listeners via `_ofUnbind`.
Those listeners live on `#inspector`, which survives the `innerHTML` swap, so
without that every render adds another set and one click on "add section" fires
once per accumulated listener.

## Gotchas

- `theme.font` is applied as `--of-font` and nothing else. The families the
  presets name are self-hosted in `packages/engine/src/fonts/`, linked from the
  page shell (`lib/html.js`) and the console (`apps/app/index.html`), and
  regenerated by `scripts/fetch-fonts.mjs` — the one place in the repo that still
  talks to Google, on a developer's machine, never in a visitor's browser. A new
  preset naming a family that is not in `fonts.css` does not 404 and does not
  leak: it silently falls back to the next entry in the stack. So adding a preset
  means adding its family to the script's table and re-running it, or the theme
  ships looking like `system-ui`.
- `.data/` and `.tmp/` are gitignored. Runtime tests write into `.tmp/`.
- The builder writes into `FUNNELS_DIR` (default `examples/`), so scratch funnels
  created while testing show up as untracked files there. Don't commit them.
- Dev disables the funnel cache (`CACHE_MS = 0`), so editing a JSON and
  reloading just works. Production caches for 60s.
- `/api/ai/generate` only calls OpenAI, and only when the key starts with `sk-`;
  anything else falls through to a hardcoded built-in generator that always
  returns the same 5-step funnel. A "success" response does not mean a model ran.
- Direct SMTP is **not implemented**. The working transports are the JSON-API
  providers in `API_TRANSPORTS` (`BREVO_API_KEY`, `RESEND_API_KEY`) plus
  `SMTP_RELAY_URL`, selected by `EMAIL_PROVIDER`; a named provider is used even
  with no key configured, so a missing key fails loudly as that provider rather
  than silently sending through another one. **The declaration order of
  `API_TRANSPORTS` is the default path**, and Brevo (EU) is declared first for
  that reason (PLAN.md §8.3) — with both keys and no `EMAIL_PROVIDER`, Brevo
  sends and a one-time warning names the variable. The inference chain in
  `getEmailSettings` runs the same order over the environment; change one and
  you must change the other, or the warning names one provider while another
  sends. Setting only `SMTP_*` logs a
  warning and sends nothing. `sendEmail` reports `ok: false` in that case rather
  than claiming success, so don't "fix" a failing send by making it return true.
- Rate limits and OTP verification are Postgres-backed (`rate_hit`, `issue_otp`,
  `verify_otp`, `is_email_verified` — see PHASE-1-PLAN.md §4.1) when a database
  is configured. `rateLimit` falls back to the old in-process bucket when no
  database is configured, or when the RPC throws for any reason — a database
  blip degrades the ceiling, it never blocks or fails the request. OTP needs
  `OTP_HASH_SALT` on top of that (falls back to `IP_HASH_SALT`, warns once if
  neither is set): without a salt a six-digit code hashed into a table is barely
  disguised, so `sendOtpCode`/`verifyOtpCode`/`isEmailVerified` use the same
  in-process `Map`s they always did rather than write an unsalted digest.
  Unlike the rate limiter, `verifyOtpCode` and `isEmailVerified` FAIL CLOSED on
  a database error — an unreachable database reads as "not verified", never
  "verified", because the wrong direction writes a lie onto a stored lead.
- Supabase is opt-in via env. With nothing configured everything still works
  against local JSONL files and the direct webhook/email fan-out — that path is
  the self-hoster's whole deployment, so it is maintained, not deprecated.
- With Supabase configured, funnel documents live in the `funnel` table and
  `examples/*.json` becomes a FALLBACK for slugs the table does not hold. Not an
  either/or: pointing a running install at a fresh project would otherwise blank
  out every funnel the operator already had. An archived row is a decision, so
  `loadFromDb` returns a sentinel for it rather than null — otherwise the disk
  fallback would serve a funnel the operator had just deleted. `removeFunnel`
  clears both stores for the same reason.
- **Migrations are applied with `supabase db push`, never through the Supabase
  SQL editor.** The CLI is what keeps `supabase/migrations/` and the live schema
  the same sequence of files — a change pasted into the SQL editor happened to
  the database but not to the repo, so the next `db push` either reapplies it
  (if it's idempotent) or the migration history and the live schema have quietly
  forked with no diff anywhere to show it. As of 2026-08-21 the D3 and D5
  migrations (`20260819100000_subject_rights.sql`, `20260819140000_retention_purge.sql`)
  are written, tested and committed but **not yet pushed** to the live project —
  `find_subject` / `erase_subject` / `purge_expired` do not exist there yet, so
  the Subjects view (D4) answers a database error on the live deployment until
  that push happens, and nothing is being purged on a schedule.
- `apps/builder` and `apps/admin` (the legacy standalone UIs at `/_builder/*`
  and `/_admin/*`) are **deleted**. All console work belongs in `apps/app`. Do
  not restore them: `builder.js` broadcast the whole funnel document, including
  `webhookSecret`, with `postMessage(doc, "*")` — the only `"*"` targetOrigin in
  the codebase — to whatever origin the preview iframe had navigated to, which an
  ordinary redirect-to-Calendly success step was enough to trigger.
- The server binds `HOST` (default `127.0.0.1`). It used to pass no `hostname` at
  all, so it took every interface while the banner said "localhost". A default
  install has no `ADMIN_TOKEN` and therefore trusts loopback, which is exactly
  what a 0.0.0.0 bind hands to the local network.
- `.data/*.jsonl` rotates at `MAX_SINK_BYTES` (64MB) to `<name>.jsonl.1`, and
  `readJsonlRecords` reads only the newest `MAX_READ_BYTES` (8MB). Ingest is
  public, so both files are anonymously writable in size; treat this directory as
  a buffer, not an archive, and forward anything you need to keep.
