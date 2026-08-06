# Security Policy

OpenFunnel handles real personal data — names, email addresses, phone numbers
and quiz answers submitted by people who are not the operator, plus the ad
attribution that links them to a campaign. It is also designed to be
self-hosted, which means a bug here becomes someone else's breach. Please treat
it accordingly, and so will we.

## Reporting a vulnerability

**Use [GitHub's private vulnerability reporting](https://github.com/luispdoesai/openFunnel/security/advisories/new).**
It is enabled on this repository. The report stays private until a fix ships,
and it gives us a place to work with you on the advisory.

Please do **not** open a public issue for a security bug.

What helps, roughly in order:

1. What an attacker gets — read a lead, write a funnel document, run script on
   the console origin, reach the internal network, send mail as the operator.
2. The preconditions. Especially whether `ADMIN_TOKEN` is set, whether the
   deployment is behind a proxy with `TRUST_PROXY`, and whether
   `ALLOW_CUSTOM_SCRIPTS` is on — several controls behave differently across
   those, and the risky combinations are the ones worth reporting.
3. Steps to reproduce against a local `bun run dev`, ideally as a `curl` or a
   short script.

We will acknowledge within a few days and tell you either what the fix is or
why we think it is not exploitable. If you would like credit in the advisory,
say so and how you want to be named.

### Out of scope

- Anything requiring the operator's own admin token, which is total access by
  design. There is no privilege model below "admin" yet.
- Missing hardening on the **legacy** UIs in `apps/builder` and `apps/admin`
  (mounted at `/_builder/*`, `/_admin/*`). They are superseded by `apps/app` and
  are on the way out. Still tell us if one of them can be used to attack the
  main console.
- Reports that a self-hoster can configure this insecurely (running it public
  with no `ADMIN_TOKEN`, pointing a webhook somewhere hostile). Documented
  footguns are bugs in the docs; tell us about those too, just not as embargoed
  vulnerabilities.
- Findings from a scanner with no demonstrated impact.

## Supported versions

This project is pre-1.0 and moves fast. Only `main` is supported — fixes land
there and are not backported. If you are running a fork, rebase before
reporting.

## What this project already does, and where the sharp edges are

Read this before deploying, and before assuming something is a bug.

**The threat model.** Two untrusted inputs matter: the **visitor** (everything
in a `/api/lead` or `/api/events` body, plus URL parameters and headers) and an
**imported funnel document** (operators are told to import templates and JSON
from other people). The **operator** is trusted. A funnel document is treated as
operator-authored — the engine renders `step.consent` as HTML — which is only
sound because the write path behind `/api/builder/*` is not forgeable. That is
why the CSRF check on privileged routes is load-bearing rather than defensive.

**Controls that exist.** Privileged routes (`/api/admin/*`, `/api/builder/*`,
`/api/ai/*`) sit behind one gate — the router dispatches them inside the branch
that runs the cross-site check and `requireAdmin`, so a handler is unreachable
without both. Loopback trust validates the `Host` header, which is what stops
DNS rebinding into the console.

Outbound webhook targets are resolved and vetted against loopback, private,
link-local and cloud-metadata ranges. An `http://` target is then **pinned** to
the address that was vetted, carrying the original `Host` — so the resolver
cannot answer differently between the check and the socket. An `https://` target
is deliberately **not** pinned and is still connected by hostname; the reasoning
is that TLS already defeats the harmful case, since a rebound address cannot
present a valid certificate for the operator's configured name. If you think
that reasoning is wrong, that is a report we want.

Funnel pages carry a strict CSP with `script-src` pinned to the SHA-256 of the
boot script. Operator-pasted `<script>` is refused unless
`ALLOW_CUSTOM_SCRIPTS=1`. Even then the policy never becomes `'unsafe-inline'`,
but "allowed by hash" is only half of it: **inline** scripts are allowed by the
SHA-256 of their exact bytes, while **external** (`src=`) scripts are allowed by
**origin**, added to both `script-src` and `connect-src`. `CUSTOM_SCRIPT_ORIGINS`
adds further origins with no hash at all. So with the flag on, an allowed origin
can serve arbitrary changing script — which is inherent to loading a third-party
tag, and worth knowing before you enable it.

Ingest cannot fail a visitor. Secrets are never echoed by the settings API, and
no outbound `fetch` error is ever logged as an object, because Bun puts the
request URL — and any credential in it — on `err.path`.

**Sharp edges worth knowing.**

- **Rate limits and OTP state are in-memory and per-process.** Run more than one
  instance and every ceiling multiplies by your replica count, and OTP
  verification fails intermittently. See the README.
- **The console has no multi-user model.** `ADMIN_TOKEN` is all-or-nothing, and
  there is no audit log.
- **`/f/:slug` shares an origin with the console.** That is why custom scripts
  are off by default: a script on a funnel page can read `of.adminToken` out of
  `localStorage`. Serving funnels from a separate origin would be a real
  improvement and is not done yet.
- **Direct SMTP is not implemented.** Setting only `SMTP_*` sends nothing.

**Where a reviewer's time is best spent**, if you are looking for somewhere to
start: the privileged gate and its cross-site check; the webhook egress guard;
the CSP and custom-code hashing; the preview predicate, which decides whether a
lead is persisted at all and has been the subject of a real bug in both
directions; and the boundary between what the client asserts and what the
server re-derives (`email_verified`, the consent signal, the webhook
destination).

## A note on this project's security history

The commit log carries a lot of `fix(security)`, several found by audit or by
re-reviewing earlier fixes. That is worth reading honestly: it means real
problems existed, and it means the first pass was not security-first. The fixes
are real and each one is documented at the code it protects, along with the
failure it prevents — but a codebase that needed them is a codebase that
deserves independent review, which it has not yet had. If you are deciding
whether to put this in front of real traffic and real people's data, weigh that.
