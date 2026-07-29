# OpenFunnel

An open-source, mobile-first quiz/lead funnel platform — a self-hostable alternative to Perspective.co.

A funnel is just a JSON document. The engine turns it into a fast, swipe-through mobile experience with branching logic, form capture, answer piping, and pixel tracking. No bundler, no framework, no runtime dependencies.

```
packages/engine   the funnel runtime — zero dependencies, ~1.8k lines, framework-agnostic
apps/app          the console — build, preview, measure and read leads in one place
apps/runtime      single-file Bun server serving funnels, the console, and ingest
apps/builder      superseded by apps/app; kept only under /_builder/
apps/admin        superseded by apps/app; kept only under /_admin/
examples/         complete funnel documents (lead-gen, fitness, real-estate)
demo/             zero-build browser demo of the engine
```

## Quick start

```bash
bun install

bun run dev     # http://localhost:3000 — launch OpenFunnel
bun test        # 33 tests across 3 suites
```

- **Visual Funnel Builder**: [http://localhost:3000/builder](http://localhost:3000/builder)
- **Lead Inbox & Analytics**: [http://localhost:3000/admin](http://localhost:3000/admin)
- **Live Mobile Funnel**: [http://localhost:3000/f/lead-gen](http://localhost:3000/f/lead-gen)

## How a funnel works

Everything is data. A step declares its type and content; the engine handles rendering, transitions, validation, persistence, and analytics.

```json
{
  "id": "lead-gen",
  "slug": "lead-gen",
  "theme": { "primary": "#4f46e5", "mode": "light", "radius": "18px" },
  "steps": [
    {
      "id": "goal",
      "type": "choice",
      "headline": "What are you looking for?",
      "options": [
        { "id": "grow", "label": "Grow my business", "icon": "📈" },
        { "id": "advice", "label": "Get expert advice", "icon": "🧭", "next": "budget" }
      ]
    },
    {
      "id": "contact",
      "type": "form",
      "headline": "Your plan is ready!",
      "fields": [{ "name": "email", "type": "email", "label": "Email", "required": true }]
    },
    { "id": "done", "type": "success", "headline": "You're all set, {{name}}! 🎉" }
  ]
}
```

**Step types** — `content`, `choice`, `multiselect`, `form`, `loader`, `success`.

**Branching** — any option (or step) can set `next` to a step id; otherwise the funnel falls through in order.

**Piping** — `{{name}}` in any headline interpolates an earlier answer or form value.

**Theming** — every color, radius, and font in `styles.css` reads from an `--of-*` custom property, so a funnel is fully re-skinnable from its `theme` block alone. The runtime inlines those variables on `<html>` so the first paint is already branded.

Full type definitions live in [packages/engine/src/types.js](packages/engine/src/types.js).

## Embedding the engine

The engine mounts into any element and mutates nothing outside it, so it drops into an existing React/Vue/Astro page as easily as a bare HTML file.

```js
import { createFunnel } from "@openfunnel/engine";
import "@openfunnel/engine/styles.css";

const funnel = createFunnel(document.getElementById("app"), config, {
  onEvent: (e) => console.log(e),
  leadEndpoint: "/api/lead",
});
```

## The runtime

[apps/runtime/server.js](apps/runtime/server.js) is one dependency-free file:

| Route | Purpose |
| --- | --- |
| `GET /f/:slug` | the funnel page — HTML shell with the config inlined |
| `GET /api/funnels` | every funnel with its name, colour and step count |
| `GET /api/funnels/:slug` | raw funnel JSON |
| `POST /api/builder/save` | write a funnel document back to `FUNNELS_DIR` |
| `POST /api/lead` | lead capture |
| `POST /api/events` | analytics ingest |
| `GET /api/admin/leads` | captured leads, newest first |
| `GET /api/admin/stats` | totals plus distinct visitors per step; `?funnel=<slug>` to scope |
| `GET /_of/*` | the engine's ES modules and stylesheet, served raw |
| `GET /healthz` | liveness probe |

The console itself is served at `/`, and each of its views (`/builder`, `/leads`,
`/analytics`, `/templates`, `/settings`) resolves to the same shell so links and
refreshes work.

Because the engine is zero-dependency ESM, the browser imports it directly — the critical path is one HTML document, one stylesheet, and a handful of small modules. Put a CDN in front of `/f/:slug` and `/_of/*` and there is nothing left to build.

**Configuration** (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | listen port |
| `FUNNELS_DIR` | `examples/` | directory of `<slug>.json` funnel documents |
| `DATA_DIR` | `.data/` | where `leads.jsonl` and `events.jsonl` are appended |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | — | also insert leads/events into Supabase |

Ingest is best-effort by design: writes happen off the response path and failures are logged, never surfaced. A visitor's funnel must never break because an analytics call failed.

## Analytics and pixels

Two independent sinks, on purpose:

- **Your backend** — `POST /api/lead` and `/api/events`, using `sendBeacon` so events survive a redirect or unload.
- **Ad platforms** — Meta Pixel, GTM `dataLayer`, and GA4 are wired in [analytics.js](packages/engine/src/analytics.js), which maps internal events (`funnel_start`, `step_view`, `lead`, `complete`) to each vendor's names. Each vendor block is self-contained — delete the ones you don't use.

Server-side Conversions API is intentionally *not* implemented client-side; keep the access token in your own edge function and forward from there.

## Building your first funnel

1. **Install and start**

   ```bash
   bun install
   bun run dev
   ```

   The console is at [http://localhost:3000](http://localhost:3000).

2. **Start from something that works** — open **Templates** and pick one, or hit
   **New funnel** for a blank three-step draft.

3. **Edit in the builder.** The left rail is the funnel's step sequence; the
   inspector on the right edits the selected step. The phone in the middle
   re-renders as you type, before you save anything.

4. **Wire up tracking.** **Pixels** takes your Meta, GTM, GA4 or TikTok IDs and a
   webhook URL. **Theme** sets the colour and shape visitors see — the console
   picks up that same colour to mark everything belonging to the funnel.

5. **Save**, then open the live URL shown in the top-right of the tab bar. Once
   real visitors move through it, **Analytics** shows how many distinct people
   reached each step and where they left.

Press `⌘K` for the command palette, or `1`–`6` to jump between views.

---

## 🔒 Security Best Practices & Self-Hosting Protection

OpenFunnel is built with local-first security and path-traversal protection. When deploying to production, follow these recommended guidelines to ensure your instance stays protected:

1. **Environment & Access Controls**
   - Keep your runtime server behind a secure reverse proxy (like Nginx, Caddy, or Cloudflare).
   - If hosting publicly, protect administrative endpoints (`/api/builder/save`, `/api/admin/*`) behind an authentication layer or IP whitelist.

2. **API Keys & Secrets**
   - Do **NOT** expose server secrets or `SUPABASE_SERVICE_ROLE_KEY` in frontend client code.
   - The **Settings** view keeps an API key in that browser's `localStorage` only — convenient for a single operator, but it is readable by any script on the page. On a shared or public instance, set the key as a server environment variable instead.

3. **Input Sanitization & Data Protection**
   - OpenFunnel validates all funnel slugs (`SLUG_RE`) and normalizes file paths (`targetPath.startsWith(FUNNELS_DIR)`) to strictly prevent Directory Traversal attacks.
   - All lead submissions and CRM records are automatically escaped to prevent Cross-Site Scripting (XSS) when viewing the Lead Inbox.

---

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
