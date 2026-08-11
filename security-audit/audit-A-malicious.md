# Track A — Malicious-code / Supply-chain Audit: OpenFunnel

Target: `/private/tmp/claude-501/-Users-ennolensch-AI-Stuff/da6142aa-620c-4273-b7d4-0d828a5796d1/scratchpad/audit-openfunnel`
Method: read-only (Read/Grep/Bash-grep/git log only — no code executed, no files modified)
Files in scope: 85 non-`.git` files, all read or grep-covered; git history: 38 commits, all inspected

## VERDICT: CLEAN

No malicious code, no obfuscation, no undisclosed exfiltration, no prompt injection, no supply-chain risk. Every outbound network call is a documented, opt-in, expected integration (AI providers with an operator-supplied key, ad-pixel platforms, Resend, Google Fonts, Meta CAPI) gated behind the console's own admin auth or an explicit environment variable. The repo is an unusually well-documented, security-hardened open-source lead-funnel builder (Bun/zero-dependency), with a commit history that is mostly genuine security hardening (the kind you'd want, not the kind that hides something) and a CI pipeline that installs nothing beyond the pinned lockfile.

---

## Outbound URLs / domains — full inventory

| Destination | File:line | What it is | Assessment |
|---|---|---|---|
| `graph.facebook.com/v19.0/.../events` | `apps/runtime/lib/capi.js:109` | Meta Conversions API (server→Meta) | Expected. Opt-in via `META_PIXEL_ID`+`META_CAPI_TOKEN` env vars only, documented in README "Third-party data sharing" table, consent-gated, never fired for preview traffic. |
| `api.resend.com/emails` | `apps/runtime/lib/email.js:169` | Resend transactional email API | Expected. Opt-in via `RESEND_API_KEY`, used for lead notifications/OTP/autoresponder — the product's stated purpose. |
| `api.openai.com/v1/chat/completions` | `apps/runtime/lib/ai.js:116` | OpenAI chat completions | Expected. BYOK AI copilot; key comes from request body (console's own localStorage) or `OPENAI_API_KEY` env; route is admin-gated. |
| `api.anthropic.com/v1/messages` | `apps/runtime/lib/ai.js:56` | Anthropic Claude API | Expected. Same BYOK AI copilot, documented in README's provider table. |
| `api.deepseek.com/v1/chat/completions` | `apps/runtime/lib/ai.js:78` | DeepSeek API | Expected. Same BYOK AI copilot. |
| `generativelanguage.googleapis.com/.../generateContent` | `apps/runtime/lib/ai.js:101` | Google Gemini API | Expected. Same BYOK AI copilot. |
| `fonts.googleapis.com`, `fonts.gstatic.com` | `packages/engine/src/theme.js:215`, `apps/runtime/lib/csp.js:280-281`, `apps/app/index.html:17-19` | Google Fonts webfont | Expected and explicitly disclosed as a privacy consideration in README ("sends visitor IP/UA/Referer to Google") and consent-gated when the funnel's consent bar is enabled. |
| `connect.facebook.net`, `www.facebook.com` | `packages/engine/src/analytics.js:127`, `apps/runtime/lib/csp.js:85-87` | Meta Pixel (client-side) | Expected ad-platform pixel, only loaded when operator sets `metaPixelId` on a funnel. |
| `www.googletagmanager.com`, `www.google-analytics.com`, `*.analytics.google.com` | `packages/engine/src/analytics.js:118,137`, `apps/runtime/lib/csp.js:90-95` | GTM / GA4 | Expected, opt-in per funnel via `gtmId`/`ga4Id`. |
| `analytics.tiktok.com` | `packages/engine/src/analytics.js:147`, `apps/runtime/lib/csp.js:98-99` | TikTok Pixel | Expected, opt-in per funnel via `tiktokPixelId`. |
| `www.youtube.com/embed/...` | `packages/engine/src/render/blocks.js:465`, `render/landing.js:155` | YouTube embed normalization | Expected — only rewrites an operator-supplied YouTube URL into an embed URL for a `<iframe>`. |
| `hooks.zapier.com/hooks/catch/...` | `README.md`, `.env.example`, `apps/app/index.html:850` | Zapier webhook example | Documentation/placeholder text only, not a live call. |
| `your-project.supabase.co` | `README.md:321` | Supabase example placeholder | Documentation only. |
| `github.com/luispdoesai/openFunnel` | `README.md:208`, `SECURITY.md:11` | Project's own repo / security-advisory link | Expected. |
| `bun.sh`, `render.com`, `railway.app`, `fly.io`, `digitalocean.com`, `json.schemastore.org` | README.md, `tsconfig.base.json:2` | Doc links / `$schema` reference (standard `tsconfig` convention, not fetched at runtime by anything in this repo) | Expected, non-functional references. |
| `www.clarity.ms`, `static.hotjar.com` | `.env.example:136`, `README.md:417` | Example values for `CUSTOM_SCRIPT_ORIGINS` env var | Documentation example only, not hardcoded/active. |
| `img.shields.io` | `README.md:3-5` | README badge images | Cosmetic, standard. |
| `evil.com`, `evil.tld`, `attacker.example`, `example.com`, `8.8.8.8`, `169.254.169.254`, `/etc/passwd`, private-IP ranges, etc. | `apps/runtime/test/egress.test.js`, `packages/engine/test/*.js`, `CLAUDE.md`, `SECURITY.md` | Test fixtures / documentation examples for the SSRF/egress-guard and XSS-guard test suites | Expected — these are the negative-test inputs proving the security guards (`resolveSafeTarget`, `isNavigableUrl`) correctly refuse them. Not live calls. |

No telemetry, analytics beacon, or phone-home was found that is undisclosed by the README/CLAUDE.md. The only "always-on by default" third-party requests are the built-in theme presets' Google Fonts hotlink — which the README explicitly calls out under "Third-party data sharing" and gates behind the consent bar when enabled.

---

## Findings by category

### 1. Code execution primitives
Searched the whole tree for `eval(`, `new Function(`, `Function(`, `child_process`, `execSync`, `spawn`, `Bun.spawn`, `require('vm')`, dynamic `import()` with non-literal args, `process.binding`.

- The only `Bun.spawn` hits are in `apps/runtime/test/server.test.js:41,589` — the test suite launching the runtime's own `server.js` as a subprocess to black-box test it. Standard, expected, not reachable from any user-facing code path.
- The only `eval`/`Function` mentions are in a comment in `packages/engine/src/calculator.js:5` stating the formula evaluator deliberately avoids `eval()`/`Function()` — and it does: `evaluateFormula` (lines 109-115) sanitizes to `[0-9.+\-*/() ]` then runs a hand-written tokenizer/recursive-descent parser (lines 13-100). No dynamic code execution anywhere.
- All dynamic `import(...)` calls found use literal string paths (`import("../calculator.js")` in `blocks.js:448`, `import("../src/index.js")` / `import("../src/consent.js")` in test files) — none are attacker- or config-controlled.

**Verdict: clean.**

### 2. Obfuscation
- `Buffer.from(..., "utf8")` usage (`apps/runtime/lib/auth.js:21-22`) is a constant-time string-compare helper (`safeEqual`), not encoding/decoding secrets.
- `createHash("sha256").update(...).digest("base64")` usage (`csp.js`, `test/server.test.js`) computes CSP script-hash pins — a documented, load-bearing security mechanism, not obfuscation.
- No `atob(`, `btoa(`, or suspicious `Buffer.from(<literal>, 'base64')` decode-and-run patterns anywhere.
- No unusually long single-line strings except one 911-char line in `packages/engine/src/analytics.js:147` — this is the verbatim, unminified-in-intent TikTok Pixel bootstrap snippet (vendor boilerplate, matches TikTok's publicly documented pixel loader byte-for-byte), sitting next to an equally-inlined Meta Pixel snippet (`analytics.js:127`) that is standard, recognizable, and consistent with Meta's official snippet.
- Checked for zero-width/RTL-override/homoglyph Unicode across all JS/HTML/JSON/CSS/MD files. One file flagged: `apps/app/templates.js` (lines 382, 813, 887) — these are U+200D (Zero Width Joiner) characters inside emoji sequences (`🧑‍💼`, `👩‍⚕️`), i.e. normal multi-codepoint emoji encoding for "person: office worker" / "woman health worker". Confirmed false positive, not a hidden payload.
- No minified/packed blobs checked into source; all files are readable, commented, JSDoc'd source.

**Verdict: clean.**

### 3. Outbound network
See the URL table above. Every call site was traced to its caller and gating logic; nothing sends data anywhere the README/CLAUDE.md doesn't disclose. Notably:
- The Meta CAPI token and any webhook secret are deliberately kept out of application-level error logs (`errSummary()` in `lib/log.js`, used consistently in `capi.js`, `webhook.js`, `email.js`, `ai.js`) specifically so a `fetch` failure's `err.path` (which Bun populates with the full request URL, credential included) never reaches stdout/log aggregation. This is a hardening measure, the opposite of exfiltration.
- Webhook destinations are DNS/IP-vetted (`resolveSafeTarget` in `webhook.js`) against loopback/private/link-local/CGNAT/cloud-metadata ranges before any request is made, and the operator-configured URL can only come from environment variables or the funnel document — never from a public request body.
- All frontend (`app.js`, `admin.js`, `builder.js`) network calls go exclusively to same-origin, hardcoded relative paths (`/api/...`); verified every `fetch(`/`apiFetch(` call site (grep, ~20 sites) resolves to a literal `/api/...` string, never a variable or externally-influenced URL.

**Verdict: clean.**

### 4. Filesystem / credential access
- No reference to `~/.ssh`, `~/.aws`, keychain, browser profiles, `/etc/passwd` (except as a *refused* test input in `egress.test.js`), `os.userInfo`, or `require('os')` used for host fingerprinting.
- All `readFileSync`/`readFile`/`writeFile` calls operate on paths under the repo (`FUNNELS_DIR`, `DATA_DIR`, the funnel JSON directory) after passing `SLUG_RE` validation and an `isInside()` containment check (not a naive `startsWith`, which the code explicitly notes is exploitable via sibling-directory-name tricks) — see `apps/runtime/lib/config.js:84-87`, used in `funnels.js`, `builder.js`, `static.js`.
- `process.env` reads (config.js, ratelimit.js, csp.js, auth.js, webhook.js, capi.js, ai.js, email.js) are all for the app's own documented configuration (ports, dirs, tokens, provider keys, feature flags) — none is read and then shipped to an unrelated destination. Every secret-bearing env var (`ADMIN_TOKEN`, `RESEND_API_KEY`, `SMTP_PASS`, `META_CAPI_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`) is used only for its own documented API call, never logged, and the settings API explicitly redacts secrets before they leave the process (`redactEmailSettings` in `email.js:84-92`).
- `scripts/serve.mjs` (the offline demo server) restricts serving to three whitelisted directories and refuses any path segment starting with `.` — explicitly closing an earlier real bug (documented in its own header comment) where the whole repo root including `.env`/`.data/leads.jsonl`/`.git` was servable.

**Verdict: clean.**

### 5. Build/CI/tooling attack surface
- `.github/workflows/ci.yml`: triggers on `push`/`pull_request`/`workflow_dispatch` only — no `workflow_run` or `pull_request_target` (the dangerous trigger that runs with base-repo secrets against a fork's code). `permissions: contents: read` (least privilege, no write/secrets scope declared). Two third-party actions, both pinned to major-version tags from trusted publishers: `actions/checkout@v5` (GitHub's own action) and `oven-sh/setup-bun@v2` (Bun's official maintainers) — no unpinned/arbitrary third-party actions, no `curl | sh`, no secret usage anywhere in the workflow. `bun install --frozen-lockfile` — cannot silently pull anything not already in `bun.lock`.
- `scripts/check-engine-imports.mjs` — read in full. Pure static analysis (regex-based import-specifier scanner) that fails CI if the engine imports a non-relative or extension-less path. No execution, no network, no side effects beyond `console.error`/`process.exit(1)`.
- `scripts/check-no-deps.mjs` — read in full. Pure static analysis of `package.json` files across the workspace, asserting no non-`workspace:` runtime dependency exists. No execution, no network.
- `scripts/serve.mjs` — read in full (see §4). Static file server for the offline demo, loopback-bound by default, path-contained. No execution of served content.
- `CLAUDE.md` — read in full (531 lines). This is a detailed, accurate architecture/invariants document written for a coding agent working *on* this repo. It contains extensive security reasoning (why the CSRF check exists, why DNS-rebinding matters, etc.) but **no instructions directed at an AI agent to run arbitrary commands, disable checks, exfiltrate data, or ignore prior instructions**. It reads exactly like what it claims to be: onboarding documentation for future contributors/agents, consistent with the actual code. No prompt-injection patterns found.

**Verdict: clean.**

### 6. Package integrity
- Full-repo grep for `"scripts"` blocks containing `install`/`postinstall`/`preinstall`/`prepare` lifecycle hooks: **none found** in any of the four `package.json` files (root, `apps/runtime`, `packages/engine`). The root `package.json` scripts are `demo`, `dev`, `start`, `test`, `typecheck` only — all direct `bun`/`bunx` invocations of files in this repo, nothing that runs on install.
- `bun.lock` package inventory (every package listed):
  - `@openfunnel/engine` — workspace package (this repo)
  - `@openfunnel/runtime` — workspace package (this repo)
  - `@types/node@26.1.1` — official DefinitelyTyped Node types, transitive dep of `happy-dom`
  - `@types/whatwg-mimetype@3.0.2` — official types, transitive dep of `happy-dom`
  - `@types/ws@8.18.1` — official types, transitive dep of `happy-dom`
  - `buffer-image-size@0.6.4` — small, legitimate, long-published utility; transitive dep of `happy-dom`
  - `entities@7.0.1` — well-known HTML-entity encode/decode library; transitive dep of `happy-dom`
  - `happy-dom@20.11.0` — the declared devDependency (popular DOM-emulation test library)
  - `typescript@5.9.3` — the declared devDependency
  - `undici-types@8.3.0` — official Node/undici types, transitive dep of `@types/node`
  - `whatwg-mimetype@3.0.0` — legitimate, well-known MIME-parsing library; transitive dep of `happy-dom`
  - `ws@8.21.1` — the standard, extremely widely used WebSocket library; transitive dep of `happy-dom`
  
  Every package name matches its well-known real npm package exactly (no `-`/`.`/homoglyph substitutions, no extra namespace tricks). None looks typosquatted. This is exactly the dependency tree `happy-dom` is expected to pull in — nothing unexpected, nothing runtime-facing (all under `devDependencies`, consistent with CLAUDE.md's "zero runtime dependencies" claim, which `scripts/check-no-deps.mjs` enforces in CI).

**Verdict: clean.**

### 7. Git history
- `git log --stat --all` (38 commits total) reviewed in full. Commit history is linear on `main`, authored entirely by one identity (`Luis Padilla <luispdoesai@gmail.com>` / `luispdoesai`), with commit messages that are unusually detailed, technically precise, and internally consistent with the code changes they describe (a strong signal of a genuine, careful author rather than a planted/altered history).
- The bulk of the history is a sequence of real `fix(security)` commits (webhook SSRF, DNS-rebinding, CSRF, preview-record substring bug, credential logging, CSV-formula-injection, OTP hardening, etc.) — each with a clear before/after and rationale, matching what's in the current code and in `SECURITY.md`'s own candid "note on this project's security history" section.
- `git log --all --name-only` — full file list across all 38 commits reconciled against the current 85-file tree: two scratch files (`examples/funnel-mrw1iawr.json`, `examples/test-funnel.json`) were added early and later removed — both are auto-generated test/scratch funnel JSON explicitly called out and fixed in commit `5b76c94` ("chore: close gitignore gaps...") and `9e52f01` ("...Stop the runtime tests writing scratch funnels into the repo's examples/"). No file was added and then suspiciously removed without a documented reason; no binary was ever committed.
- `git log --all --numstat` checked for binary-file markers (`-\t-\t<path>`, git's numstat notation for binary diffs): **zero results** — no binary file has ever existed in this repository's history.
- `git log -p --all -- .github/ scripts/` (594 lines) reviewed — every change to CI/scripts across history is additive/corrective (adding the workflow, pinning action versions, fixing the frozen-lockfile install, documenting a comment-stripping limitation). No secret material, no obfuscated diffs, no addition-then-silent-removal pattern.

**Verdict: clean.**

---

## Things checked and found nothing

- No `eval(`, `new Function(`, `Function(` used for dynamic code execution anywhere in application code (only a doc comment and a `Bun.spawn` of the app's own server for testing).
- No `child_process`, `execSync`, `spawn` of external/attacker-influenced commands.
- No `require('vm')`, no `process.binding`.
- No non-literal dynamic `import()`.
- No `atob`/`btoa`/base64-decode-and-execute patterns.
- No zero-width/RTL-override/homoglyph payloads (one benign emoji-ZWJ false positive investigated and ruled out).
- No hardcoded IP addresses used as live exfil targets (all IP-literal strings found are either CSP `frame-ancestors`/example domains in docs, or test fixtures for the SSRF-blocking test suite).
- No reads of `~/.ssh`, `~/.aws`, OS keychains, browser profile directories, or `/etc/*` (the one `/etc/passwd` reference is a refused test input).
- No writes outside `DATA_DIR`/`FUNNELS_DIR` (both repo-relative or explicitly operator-configured, and path-contained via `isInside()`).
- No `process.env` value is read and then transmitted to a destination other than the one that specific variable is documented to configure.
- No `install`/`postinstall`/`preinstall`/`prepare` lifecycle script in any `package.json`.
- No non-`happy-dom`/`typescript`-derived package in `bun.lock`; no typosquatted package names.
- No `workflow_run`/`pull_request_target` trigger, no unpinned third-party GitHub Action, no `curl | sh` or secret exfiltration in CI.
- No prompt-injection language in `CLAUDE.md`, `README.md`, `SECURITY.md`, or any code comment directed at an AI coding agent (instructions to run commands, disable security checks, exfiltrate data, or disregard prior instructions).
- No binary file has ever been committed to this repository (verified via `git log --numstat` across all history).
- No file was added and later removed without a documented, benign reason in the corresponding commit message.
- `postMessage` usage (`app.js`, `builder.js`, `blocks.js`, `choice.js`, engine boot script in `csp.js`) always targets `window.location.origin` (or is received with an `e.origin === location.origin` check) — never `"*"` — consistent with the project's own documented fix for this exact class of leak.
- `innerHTML`/`html:` sinks in the engine are restricted to two deliberate, documented cases (`step.consent` in `form.js`, a static inline SVG in `success.js`) plus the admin/console UI's own rendering of its own escaped (`esc()`) data — no unescaped attacker-controlled HTML sink found.

---

## Notes (non-security, for completeness)

- `CLAUDE.md` states "`/api/ai/generate` only calls OpenAI," but the actual code in `apps/runtime/lib/ai.js` supports OpenAI, Anthropic, DeepSeek, and Google Gemini (matching `README.md`'s provider table, which is accurate). This is a stale line in one doc file, not a security issue — the AI routes are admin-gated regardless of which provider is used, and each provider call goes only to that provider's own official API endpoint with the key the admin (or the console's own env var) supplied.
