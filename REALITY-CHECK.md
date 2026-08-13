# Reality Check — running OpenFunnel for the first time

> 2026-08-10. Spike before Phase 1, per [PLAN.md](PLAN.md). The plan was built entirely from
> reading code; nobody had ever started this server. This records what actually happened.
> Local only, loopback only, nothing deployed, no commits.
>
> Screenshots: [screenshots/](screenshots/) — `spike-funnel-mobile-1.png`,
> `spike-funnel-preset-googlefonts.png`, `spike-console-builder.png`.

**Verdict: the plan holds. Two findings make it more urgent, one makes it cheaper.**

---

## 1. CRITICAL — Google Fonts fires with no consent, and it is the default state

The plan (§8.2) assumed the Google Fonts fetch was consent-gated and the fix was "self-host to
remove a dependency". Reproduced live, that is **wrong in the direction that matters**:

Loading `/f/agency-landing` on a cold profile, with no consent bar shown and no consent given:

```
[GET] https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap  → 200
[GET] https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yygg_vb.woff2   → 200
```

The visitor's IP reaches Google on page load. This is precisely the LG München I
(3 O 17493/20) fact pattern.

**Root cause — the gate only protects funnels that opt in.** All four shipped examples have
`consent: {}`, i.e. consent is *not enabled*. With consent disabled there is no gate to fail, so
`allowRemote` is effectively true and the font loads immediately. The protection described in
`CLAUDE.md` is real, but it only exists for a funnel that turns consent on. **A funnel without a
consent block is the unprotected case, and it is the default.**

Scope, verified:

| Funnel | `theme` | Google Fonts on load? |
| --- | --- | --- |
| `agency-landing` | `preset: midnight-glass` | **yes** |
| `fitness` | `preset: sunset-coral` | **yes** (same mechanism) |
| `real-estate` | `preset: warm-editorial` | **yes** (same mechanism) |
| `lead-gen` | no preset, `primary` + `mode` only | no |

All eight presets in `theme.js` name a Google-hosted family — Plus Jakarta Sans, Space Grotesk,
Playfair Display, Inter. Only a funnel that sets no preset escapes.

**Second, independent problem:** the CSP on **every** funnel page pre-authorises Google, including
`lead-gen`, which never makes the request:

```
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src  'self' https://fonts.gstatic.com data:;
```

**Plan changes (both into Phase 1):**
1. Self-host the preset families as WOFF2 and delete the Google Fonts path — as planned, now
   with higher priority.
2. Remove `fonts.googleapis.com` / `fonts.gstatic.com` from the default `funnelCsp`. A CSP that
   permits the transfer is a bad answer to "does this site send data to Google".

---

## 2. CONFIRMED — a lead is lost silently, exactly as described

Configured `WEBHOOK_URL=https://crm-of-the-client.invalid/hook` (a target that cannot resolve),
then submitted a lead:

```
CLIENT SEES: HTTP 202 in 0.004872s
SERVER LOG:  [runtime] refusing webhook to blocked target: crm-of-the-client.invalid
```

The visitor sees success. The funnel behaves perfectly. And:

- the forward never happens and **nothing retries it**
- the stored record carries **no delivery state at all** — reading the sink cannot tell you which
  leads were forwarded and which were not
- the only trace is one line on stdout, which in production is journald, rotated at 14 days

Reproduced twice. This is the failure mode the whole build exists to remove, and it is now a
demonstrated fact rather than an argument. Phase 1 ordering is correct.

---

## 3. CONFIRMED — raw IP stored in plaintext — **CLOSED 2026-08-13**

Every record in `.data/leads.jsonl` used to read:

```json
{"funnelId":"lead-gen","lead":{...},"received_at":"...","ip":"127.0.0.1","user_agent":"curl/8.7.1"}
```

The plan's requirement to store a salted hash (§6 item 15) was closing a real gap, not a
theoretical one — and the gap was wider than this file's one example. Closed in two passes
(WO4 2026-08-12, the rest 2026-08-13): `lead.ip_hash` is a salted digest, omitted entirely when
no salt is set; `persist()` strips `ip` before the sink above and `readJsonlRecords()` strips it
again on read, so an older file stops leaking too; `rate_hit` receives a salted digest instead of
`ingest:<ip>` / `otp-send:<email>`, which became durable rows when the buckets moved to Postgres;
and one shared `outboundPayload()` strips the address off every outbound payload. That last one
was the real find: only the queue path had been stripping, so the **direct fan-out** — the path
every install without a database runs — was posting the raw IP to the operator's webhook. See
PLAN.md §10 and the "Nothing stores a raw IP" invariant in CLAUDE.md.

**`user_agent` is still retained in full**, in the sink and in its own column. That is a
separate decision, not an oversight — it is the one signal left for telling a bot submission
from a real one — but it belongs in the Datenschutzerklärung and in the Löschkonzept (§8.7).

---

## 4. GOOD NEWS — the console is far better than the codebase description suggests

The codebase map calls `apps/app` "vanilla-JS console SPA, no components, no build step — fine to
add a view, painful to reskin", which reads as a liability. Running it, it is a **working
three-pane product UI**: step list with drag handles and type badges, live phone/tablet/desktop
preview, tabbed inspector (Content / Design / Blocks / Logic), piping-token chips, hero-layout
presets, command palette, a Leads badge showing the live count.

Zero console errors in the builder. One 404 on `/favicon.ico`, cosmetic.

**This strengthens two plan decisions:**
- "Extend `apps/app`, do not rewrite it" — confirmed, and by a wider margin than assumed.
- **Phase R (engine rewrite) should stay deferred.** The rendered output is genuinely
  good — the `midnight-glass` landing page reads as a real product, not a template. Rewriting
  this is 3–6 weeks spent replacing the strongest part of the system.

---

## 5. Audit fixes verified live

Everything patched on 2026-08-10 behaves as intended against a running server:

| Fix | Check | Result |
| --- | --- | --- |
| M4 bind address | boot banner | `bound: 127.0.0.1` |
| M3 sink permissions | `stat .data/leads.jsonl` | `-rw-------` (0600) |
| B3 legacy UIs | `GET /_builder/`, `/_admin/` | 404, 404 |
| proxy-header trust | `GET /api/admin/leads` with `x-forwarded-for: 1.2.3.4` | **401** `admin_token_required` |
| loopback trust | same, no forged header | 200 |
| SSRF egress guard | webhook to an unresolvable host | refused and logged |

---

## 6. Performance — fast, with one caveat

| Measurement | Value |
| --- | --- |
| `/f/lead-gen` HTML | 5,942 bytes, 1.3 ms |
| `POST /api/lead` | HTTP 202 in ~5 ms |
| `/healthz` | 3.9 ms |
| Full funnel walkthrough | 21 events captured for drop-off |

**Caveat:** a funnel page pulls **22 separate unbundled ES module requests** (`/_of/index.js`,
`/_of/controller.js`, `/_of/render/*.js`, …). "No build step" is a deliberate invariant and on
HTTP/2 the cost is modest, but it is 22 round trips on a cold 4G connection, on the one page where
speed converts. **Not a fix — a measurement item.** Measure real-device Largest Contentful Paint
before deciding whether the invariant is still earning its keep.

---

## 7. End-to-end works

Walked `/f/lead-gen` at a 390×844 viewport: landing → 3 choice steps → multiselect → form →
submit. Everything captured correctly:

```json
{"funnelId":"lead-gen",
 "lead":{"name":"Klaus Bergmann","email":"klaus.bergmann@example.de","phone":"+49 511 4455667"},
 "answers":{"goal":"Grow my business","timeline":"Right away","budget":"$2,000+",
            "challenges":["Not enough leads"],"contact":{...}}}
```

Accessibility is sound out of the box — proper `radiogroup`/`radio`/`checkbox` roles, labelled
textboxes, a working back button, auto-advance on single choice.

Minor: the contact fields are stored twice, in `lead` and again in `answers.contact`. Harmless,
but it is duplicated personal data in a record that has to be deletable — worth collapsing when
the Postgres schema lands.

---

## 8. Test baseline reconfirmed

```
127 pass, 1 fail, 424 expect() calls, 128 tests across 9 files
bun run typecheck                      → clean
bun run scripts/check-no-deps.mjs      → OK: no runtime dependencies
bun run scripts/check-engine-imports.mjs → OK: every engine import relative and extension-qualified
```

The one failure is the known Bun 1.3.13-vs-pinned-1.3.14 difference, not this codebase.

---

## What changed in the plan

1. **§8.2 escalated.** The consent gate does not cover a funnel with no consent block, which is
   every shipped example. Self-hosting the fonts moves up, and the Google entries come out of the
   default CSP.
2. **Phase 1 gains one line:** strip `fonts.googleapis.com` / `fonts.gstatic.com` from `funnelCsp`.
3. **Phase R stays deferred, with evidence** rather than argument. The engine and console are the
   strongest parts of the system.
4. **New measurement item:** real-device LCP on a preset funnel over 4G, to decide whether the
   no-build-step invariant still pays.

Nothing in the plan was invalidated. Nothing was built. Server stopped, port free.
