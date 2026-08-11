# OpenFunnel — Security Audit Summary

**Date:** 2026-08-09
**Commit audited:** `4164afd` (2026-08-07)
**Source:** https://github.com/luispdoesai/openFunnel.git
**Method:** static read-only review of all 85 files + full 38-commit history. No repo code
was executed, no dependencies installed.

Detail reports: [audit-A-malicious.md](audit-A-malicious.md) (supply chain / malware),
[audit-B-client.md](audit-B-client.md) (browser code), [audit-C-runtime.md](audit-C-runtime.md)
(Bun server).

---

## Verdict

| Question | Answer |
| --- | --- |
| Is it malicious? | **No.** Clean on every axis checked. |
| Safe to clone/keep on disk? | **Yes.** |
| Safe to run locally on your own machine? | **Yes, with two caveats** (see below). |
| Safe to expose on an untrusted LAN? | **No, as shipped** — binds `0.0.0.0`, not changeable without editing source. |
| Safe to expose publicly? | **Confidentiality yes** (with `ADMIN_TOKEN` + TLS). **Availability no** — fix M3 and M2 first. |

Overall this is a competent, security-first codebase, not security theatre. 38 commits in
10 days, roughly half of them genuine security fixes with accurate commit messages. The
hard parts — auth gating, DNS rebinding, CSRF, path containment, SSRF egress, CSP hash
pinning, OTP — are done correctly. `SECURITY.md` candidly documents its own past bugs.

Caveat on provenance: repo is 10 days old, single author, and reads as heavily
AI-assisted. That is not a security finding, but it means there is no track record and no
second pair of eyes upstream.

---

## Not found (the things that would have made it unsafe to copy)

- No `eval` / `new Function` / `child_process` / `vm` / dynamic non-literal `import()`.
  The math-formula evaluator is a hand-rolled tokenizer, not `eval`.
- No obfuscation: no base64-decode-and-run, no minified blobs, no hidden unicode.
- No install / postinstall / preinstall / prepare lifecycle scripts anywhere.
- `bun.lock` contains only `happy-dom` + `typescript` + legitimate transitive deps.
  Zero runtime dependencies. Nothing typosquatted.
- No undisclosed outbound traffic. Every hardcoded domain (Meta CAPI, Resend, OpenAI /
  Anthropic / DeepSeek / Gemini, Google Fonts, GTM/GA4/TikTok, YouTube) is an opt-in
  integration gated behind admin auth or an env var. All frontend `fetch` calls are
  same-origin literal `/api/...` paths.
- No access to `~/.ssh`, `~/.aws`, keychain or browser profiles. All file I/O is
  path-contained.
- No prompt injection in `CLAUDE.md` or `README.md` aimed at an AI agent reading the repo.
- CI (`ci.yml`): least-privilege permissions, pinned trusted actions, no
  `pull_request_target`, no `curl | sh`.
- No binary files ever committed.

---

## Findings (vulnerabilities in the app, ranked)

No Critical severity at the "someone attacks you by you cloning this" level. Everything
below requires you to run the server, and most require you to expose it or to import a
funnel JSON you did not write.

### Fix before any public deployment

**M3 — unauthenticated disk/memory exhaustion.** `/api/events` accepts 300 req/min/IP ×
64 KB persisted verbatim ≈ 28 GB/day from a single IP. No record cap, no rotation, no
retention. `readJsonlRecords` then reads the whole file into one string and parses per
line; `/api/admin/stats` does it twice. Attacker fills the disk, and the *operator* OOMs
the process by opening their own lead inbox.

**M2 — rate limiter logic bug** (`apps/runtime/lib/ratelimit.js:35-39`). Prune tests every
bucket against the *caller's* `windowMs` rather than the bucket's own — windows are never
stored. An exhausted bucket stops advancing its timestamp, so ~60s later any `ingest:`
call (60s window) deletes the hourly buckets. Net effect: `MAIL_HOURLY_CAP` (500/hr) — the
one ceiling the design calls load-bearing, because every other key is rotatable — can be
reset roughly once a minute, giving ~30k mails/hr.

**M4 — binds `0.0.0.0` with no override.** No `hostname` in `Bun.serve`, no `HOST` env
var, and the boot banner says "localhost". `README.md:530` instructs operators to bind to
`127.0.0.1`, which is impossible without editing source. The author already fixed exactly
this in `scripts/serve.mjs:28` and did not carry it over.

**M1 — `integrations.leadEndpoint` hijack** (`lib/csp.js:242`, `lib/funnels.js:89`,
`packages/engine/src/controller.js:189`). An imported funnel document can set
`leadEndpoint` to any origin. It overrides the server-supplied `/api/lead`, is
deliberately not stripped by `publicFunnel()`, and `funnelCsp()` explicitly adds its origin
to `connect-src`. All three defences step aside for it. Every lead silently goes to the
attacker; the operator's inbox shows zero; no server-side trace. Same structural gap that
`webhookUrl` was already fixed for. README understates imported-doc risk as "a phishing
link or tracking pixel".

### Client-side

**B1 — unescaped HTML sink** (`packages/engine/src/render/form.js:199`):
`el("p", {html: step.consent})` renders an attacker-controlled funnel field through raw
`innerHTML`. It is the only funnel field rendered unescaped anywhere in the engine; every
sibling renderer uses `text:`/`textContent`. Chain: malicious imported funnel → previewed
in the console's same-origin, non-sandboxed iframe → `<img onerror>` → reads
`localStorage` (`of.adminToken`, `of.ai.key`) → admin API takeover.
*Mitigated on the shipped `/f/:slug` route* by the strict hash-pinned CSP, which Track C
independently verified as sound (no `unsafe-inline` in `script-src`, script-tag regex
fails closed). But it is a single point of failure, `packages/engine` ships with zero
protection when embedded elsewhere, and `demo/index.html` has no CSP at all.

**B2 — iframe `src` bypass** (`render/blocks.js:459-475`, `render/landing.js:149-165`).
YouTube/Vimeo detection uses an unanchored regex `.test()`, so any string merely
*containing* `player.` passes. Unlike every other URL field in the codebase this one skips
`isNavigableUrl()`, allowing a `javascript:` iframe src — which auto-executes, no click
needed.

**B3 — `postMessage(funnelDoc, "*")`** (`apps/builder/builder.js:467-474`). The only `"*"`
targetOrigin in the codebase; every other call correctly uses `location.origin`. Leaks the
entire funnel JSON, including `webhookSecret`, to whatever origin the preview iframe
currently displays. Triggerable by ordinary use: a redirect-to-Calendly success step
navigates the iframe, then any further edit broadcasts to Calendly's origin.

**B4 — secrets in cleartext `localStorage`** (`apps/app/app.js`): `of.adminToken`,
`of.ai.key`, `of.webhookSecret`. Never placed in a URL or log, only sent same-origin as a
Bearer header — but readable by anything that executes on-origin, i.e. exactly what B1
would grant.

### Minor / operational

- `ALLOW_CUSTOM_SCRIPTS=1` hashes whatever the *document* carries, not what the operator
  pasted — so importing a funnel becomes console takeover.
- `leads.jsonl` and plaintext `email_settings.json` written at mode `0644`.
- OTP codes printed to stdout on the default no-transport install, contradicting the
  comment two lines above.
- `test-email` route exempt from `MAIL_HOURLY_CAP`, against the rule `ratelimit.js` states.
- SSRF egress blocklist misses `192.0.0.192` (Oracle metadata) and `::7f00:1`.
- `validate.js:34-38`: `new RegExp(field.pattern)` compiled from funnel data and run
  against visitor input — ReDoS. `try/catch` guards compile errors, not runtime hangs.
- Preview iframes are same-origin and unsandboxed (deliberate — editor drag/drop needs
  bidirectional postMessage), which is why B1's CSP is the only layer rather than one of
  several.
- Doc drift (non-security): `CLAUDE.md` says the AI route "only calls OpenAI"; the code and
  README correctly support multiple providers.

---

## Verified genuinely correct

Worth recording, because it is what separates this from a typical vibe-coded project:

- **Privileged route gate is structural**, not per-route — tried `//api/admin/`, case
  variants, `%2f`, dot-segments, trailing slash; every variant matches both the gate and
  the handler, or neither.
- **`timingSafeEqual` with length pre-check** on the admin token. No timing attack.
- **DNS rebinding into the console is closed** by `Host` validation — the full attack was
  worked through: the socket check and `Sec-Fetch-Site: same-origin` both pass, and
  `Host: evil.tld:3000` is what stops it.
- CSRF check ordered *before* auth; header-based tokens, not cookies; CORS scoped to 4
  paths with bare-204 preflights elsewhere.
- `isInside()` requires the separator (not naive `startsWith`); single-decode blocks
  double-encoding; `DATA_DIR`, `.env` and `.git` are unreachable over HTTP.
- **SSRF egress TOCTOU pin for `http://` is real**, and the reasoning for leaving `https://`
  unpinned is correct — a rebound address cannot present a valid cert, so the handshake
  fails before any request bytes leave.
- CSP hash-pinned; no `unsafe-inline` in `script-src`; the script-tag regex fails closed
  against constructed parser differentials.
- CSV formula injection guarded in **both** exporters (`admin.js` and `app.js`).
- No stored XSS from public ingest into the console — every lead-derived value goes
  through `esc()`.
- Prototype pollution unreachable (`Object.create(null)` used deliberately in
  `computeStats`).
- OTP: CSPRNG, attempts burned before compare, 25 guesses/hr against a 1e6 space, no
  enumeration oracle.
- All `esc()` implementations escape `& < > " '` and are applied consistently.
- `isNavigableUrl()` blocks `javascript:`, `data:` and protocol-relative URLs everywhere
  except B2.
- `consent.js` gates only third-party pixels and webfonts, never first-party lead capture.
- Example funnel JSON and `templates.js` carry no script or HTML payloads.
- Single-instance limitation (all limits are per-process `Map`s) is correctly documented
  in the README **and** printed as a boot warning under `NODE_ENV=production`.

---

## If you want to use it

1. **Local only, own machine:** fine as-is. Do not import funnel JSON you have not read
   (M1, B1). Note `0644` on PII files.
2. **Before any deployment:** fix M3, then M2, then M4. Set `ADMIN_TOKEN`
   (`openssl rand -hex 32`), TLS in front, correct `TRUST_PROXY`, and pin the instance
   count to 1.
3. **Leave `ALLOW_CUSTOM_SCRIPTS` unset.**
4. Fixes for M1/M4 and B1/B2/B3 are each a handful of lines — this is a fork-and-patch
   job, not a rewrite.
