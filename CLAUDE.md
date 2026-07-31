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
```

Run a single test file: `bun test packages/engine/test/logic.test.js`.

`bun test` (74 tests) and `bun run typecheck` both pass on `main` — keep it that
way. Two tests log expected warnings (`branch target "nope" not found`, an
invalid-URL `submitLead` failure); those are assertions about failure tolerance,
not breakage.

## Layout

```
packages/engine/     the funnel runtime — zero-dep browser ESM, no build step
apps/runtime/        single-file Bun server (server.js) — the only backend
apps/app/            the console SPA (dashboard, builder, leads, analytics)
apps/builder/        legacy standalone builder UI  (superseded by apps/app)
apps/admin/          legacy standalone admin UI    (superseded by apps/app)
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
  `success`.
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
  `sunset-coral`). Also the only file in the engine that makes a third-party
  request: `loadThemeFont()` / `applyTheme(root, theme, { allowRemote })` fetch a
  non-system `theme.font` from Google Fonts. It stays independent of `consent.js`
  — the decision is passed in as a boolean.
- `src/consent.js` — the consent bar and the `marketingAllowed()` / `consentSignal()`
  gate for third-party sharing. Its header defines what is and is not gated.
- `src/persist.js` — localStorage resume. Fails silently by design.

### apps/runtime/server.js

One file, `Bun.serve`, no framework. Routes:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /f/:slug` | public | funnel page — HTML shell with the funnel JSON inlined |
| `GET /_of/*` | public | engine source served raw, mirroring `packages/engine/src` |
| `GET /_app/*`, `/`, `/builder`, `/leads`, … | public | console shell (see `APP_ROUTES`) |
| `GET /api/funnels`, `/api/funnels/:slug` | public | funnel list / document |
| `POST /api/lead`, `/api/events` | public, rate-limited | ingest → JSONL + Supabase + webhook |
| `POST /api/otp/send`, `/api/otp/verify` | public, rate-limited | email verification challenge |
| `GET /healthz` | public | liveness |
| `POST /api/builder/save\|delete\|duplicate` | **admin** | writes JSON into `FUNNELS_DIR` |
| `GET /api/admin/leads`, `/api/admin/stats` | **admin** | console data, preview-filtered |
| `GET\|POST /api/admin/email-settings` | **admin** | mail config; secrets never returned |
| `POST /api/admin/test-email` | **admin** | send a test message |
| `POST /api/ai/generate`, `/api/ai/improve-copy` | **admin** | copilot (OpenAI optional) |

Only the console shell is public; every API behind it is not. The `/f/:slug`
page and the ingest endpoints are the entire public API surface.

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
`/api/builder/save`. `Cmd/Ctrl+K` opens the command palette, `Cmd/Ctrl+S` saves,
`1`–`6` switch views.

Workspace-level settings (workspace name, domain, currency, language, lead
notification email, global head/CSS injection, GDPR bar, AI provider/model/key/
brand voice) live in `localStorage` under `of.*` keys, listed in the `SETTINGS`
table in `app.js`. They are per-browser, not per-funnel and not server-side.

## Invariants — do not break these

**No build step.** The browser imports engine source directly. Every import in
`packages/engine/src` must be a relative, browser-resolvable ESM specifier, and
the engine must never gain an npm dependency. This is the whole reason a funnel
is fast on 4G.

**Ingest must never fail a visitor.** `/api/lead` and `/api/events` return `202`
immediately and persist in the background; `persist()` fans out with
`Promise.allSettled` so a dead webhook or Supabase outage is a `console.warn`,
never a `500`. Client-side, `leads.js` uses `sendBeacon` with a `keepalive`
fetch fallback and swallows errors.

**Preview traffic must never pollute analytics.** Two independent guards, and
new code needs both: `Controller._emit()` bails when `isPreview` or
`?preview=1` / `?admin=1`, and the server's `isPreviewRecord()` filters records
out of `/api/admin/*`. The builder iframe depends on this.

**Privileged routes are gated in one place.** A single prefix check in the
router runs `requireAdmin` for `/api/admin/*`, `/api/builder/*` and `/api/ai/*`
before any handler sees the request, so a new endpoint under those prefixes is
protected the moment it exists. Do not add a privileged route outside them, and
do not weaken the gate: with `ADMIN_TOKEN` set it requires a bearer token, and
without one it allows only direct loopback callers. A request carrying
`x-forwarded-for` is never treated as loopback — otherwise anyone reaching a
reverse-proxied deployment would inherit localhost's privileges.

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
- A funnel document is operator-authored and the engine trusts it (`form.js`
  renders `step.consent` as HTML). That trust is only sound while the write path
  is not forgeable, so anything that weakens the CSRF check re-opens stored XSS
  on the console origin.

**`x-forwarded-for` is not trusted unless `TRUST_PROXY` is set.** It is a request
header, so honouring it unconditionally made every per-IP limit bypassable by
rotating a string. `clientIp()` returns the socket address by default and warns
once if a forwarded header shows up without the flag. Anything keyed on a client
address inherits this — do not read the header directly.

**Webhook targets are checked after resolution, not just textually.**
`isSafeWebhookTargetResolved()` rejects a hostname whose DNS answer lands on
loopback, a private range, link-local or cloud metadata. A hostile resolver can
still answer differently between the lookup and the socket (rebinding) and Bun
cannot pin the address, so that residue stands — but the destination is
operator-owned, not visitor-supplied.

**Funnel pages carry a strict CSP.** `script-src` is pinned to the SHA-256 of the
inline boot script, which is why `FUNNEL_BOOT_SCRIPT` must stay free of
interpolation — put a funnel value in it and every funnel page stops running its
own JavaScript, silently, with nothing thrown server-side. A test recomputes the
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
  `firePixel` import in new code silently bypasses the gate. The webfont rides the
  same decision via `applyTheme(..., { allowRemote })`, with `loadThemeFont()`
  called from `_grantConsent()` when the visitor accepts.
- *Server* — `forwardMetaCapi` re-derives the gate from the funnel document rather
  than trusting `record.meta.consent`: with `consent.enabled` on, only an explicit
  `"granted"` forwards, so a stripped field is a refusal, not permission. When the
  document can't be resolved it warns and falls back to the client signal —
  deliberately not failing closed, which would disable CAPI for funnels whose `id`
  is not their slug.

Gated: browser pixels, the Meta CAPI forward, Google Fonts. **Not** gated: lead
capture (`/api/lead`) and first-party drop-off events (`/api/events`) — the
visitor typed their details in and pressed submit, so dropping the lead would be
a broken funnel rather than a private one, and those records stay on the
operator's own server. See the header of `src/consent.js`.

**Never trust the client for anything that matters.** Two live examples worth
copying: `email_verified` arrives in the lead payload but is re-derived from
the server's own `verifiedEmails` record before being stored, and the webhook
destination is read only from the environment or the funnel document — never
from the request body, because `/api/lead` is public. Outbound URLs go through
`isSafeWebhookTarget`, which blocks loopback, private ranges and the cloud
metadata address.

**Secrets never travel outward.** `GET /api/admin/email-settings` runs
`redactEmailSettings`, which strips `resendApiKey` / `smtpPass` and replaces
them with `…Set` booleans; writes go through an allowlist (`WRITABLE_EMAIL_KEYS`)
so an unexpected key cannot be persisted, and a blank secret means "keep the
existing value" rather than wiping it. The HTTP relay URL is env-only and never
settable through the API.

**Path traversal.** Any route that reads or writes a file validates against
`SLUG_RE` *and* checks the resolved path still `startsWith` its root dir. Copy
that pattern for any new file-touching route.

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
the path to `APP_ROUTES` in `apps/runtime/server.js` (so a hard refresh on the
URL still serves the shell), and add a `<section id="view-<name>">` to
`apps/app/index.html`.

**Add a pixel:** add the id to the `FunnelIntegrations` typedef in
`src/types.js`, handle it in `installPixels()` / `firePixel()` in
`src/analytics.js` (extend `EVENT_MAP`), then add the input to the Pixels modal
in `apps/app/index.html` and to the `pixelFields` table in `app.js`.

**Add a funnel:** drop a JSON file in `examples/` — `/api/funnels` lists the
directory, so it appears in the console with no registration step.

## Style

- JSDoc types throughout, `checkJs: true`, `strict: true`. No `.ts` files in
  runtime code; `packages/engine/types/index.d.ts` is the published surface.
- Every module opens with a `@file` block explaining *why* it exists, not just
  what it does. Section banners (`/* ===== *`) separate concerns in long files.
  Match this density.
- Double quotes, semicolons, 2-space indent.
- Console DOM lookups use `$("id")`; guard with `if ($("x"))` or `?.` since
  modals share one `index.html` and an element may not exist in every build.

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
- `of.ai.brandVoice` and `of.ai.provider` are saved but never sent;
  `generateFunnel()` still posts a stale `of.ai.tone` key that the settings UI
  no longer writes.

### The mirror image: wired in the engine, not reachable from the console

These work in the engine but the builder cannot create them, so they are reachable
only through a template or hand-edited funnel JSON:

- The `calculator` content block (`src/calculator.js` + the `CalculatorBlock`
  typedef) — the string `"calculator"` appears nowhere in `apps/app/`. The
  `solar-calculator` template in `templates.js` is the only thing that emits one.
- The `address` form field type — handled by `src/render/form.js`, but
  `FIELD_TYPES` in `apps/app/app.js` is only `["text", "email", "tel"]`, so the
  field-type dropdown cannot produce it (nor `textarea`, `select`, `date`,
  `number`, `file`).

## Gotchas

- `theme.font` is applied as `--of-font` **and** fetched from Google Fonts when it
  names a non-system family — which every built-in preset does, so a preset funnel
  hotlinks Google. Only the first comma-separated segment of the stack counts, and
  generic/system/`ui-*`/`-*` families are refused, so a default-themed funnel
  requests nothing. The request is consent-gated: `applyTheme` skips it unless
  `allowRemote`, and `_grantConsent()` loads it on accept. A new preset naming a
  family Google does not host would leak the visitor for a 404 — check it exists.
- `.data/` and `.tmp/` are gitignored. Runtime tests write into `.tmp/`.
- The builder writes into `FUNNELS_DIR` (default `examples/`), so scratch funnels
  created while testing show up as untracked files there. Don't commit them.
- Dev disables the funnel cache (`CACHE_MS = 0`), so editing a JSON and
  reloading just works. Production caches for 60s.
- `/api/ai/generate` only calls OpenAI, and only when the key starts with `sk-`;
  anything else falls through to a hardcoded built-in generator that always
  returns the same 5-step funnel. A "success" response does not mean a model ran.
- Direct SMTP is **not implemented**. `RESEND_API_KEY` or `SMTP_RELAY_URL` are
  the two working transports; setting only `SMTP_*` logs a warning and sends
  nothing. `sendEmail` reports `ok: false` in that case rather than claiming
  success, so don't "fix" a failing send by making it return true.
- Rate limits and the OTP store are in-memory, so they are per-process and
  reset on restart. Behind more than one instance you need an edge rate limit
  and a shared store.
- Supabase and webhook forwarding are opt-in via env; with nothing configured
  everything still works against local JSONL files.
- `apps/builder` and `apps/admin` are the older standalone UIs still mounted at
  `/_builder/*` and `/_admin/*`. New work belongs in `apps/app`.
