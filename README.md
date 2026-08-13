# OpenFunnel 🚀

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Engine: Zero Dependencies](https://img.shields.io/badge/Engine-Zero_Dependencies-success.svg)](#-for-developers--self-hosters)

> **The open-source, self-hostable alternative to Perspective.co, Typeform, and Outgrow.**  
> Build mobile-first, high-converting interactive quiz funnels designed specifically for paid traffic (Facebook, Instagram, TikTok, Google Ads).

---

## ⚡ OpenFunnel vs. Perspective.co

| Feature | Perspective.co ($99+/mo) | OpenFunnel (Free & Open Source) |
| :--- | :---: | :---: |
| **Mobile-First Quiz Engine** | ✅ Yes | ✅ Yes (Swipe transitions, <100ms response) |
| **Landing Pages** | ✅ Yes | ✅ **Yes** (5 hero layouts, background image/video, sticky CTA, nav & footer) |
| **Page Sections / Blocks** | ✅ Yes | ✅ **20 block types** (features, pricing, FAQ, stats, comparison, gallery…) |
| **Interactive Screen Types** | ✅ Yes | ✅ Yes (Landing, Single-choice, Multi-select, Form, Loader, Content, Success) |
| **Option Image Cards & Media** | ✅ Yes | ✅ **Full** (Image cards, grid layout & step hero media) |
| **Proven Industry Templates** | ✅ Yes | ✅ **20 built-in** across 7 categories, editable as plain JSON |
| **Theming** | ✅ Yes | ✅ 8 presets + custom colour, font, radius & button style |
| **AI Funnel Copilot** | ✅ Yes | ✅ **Bring your own key** (OpenAI, Claude, Gemini, DeepSeek or any compatible API) |
| **Email Alerts & Autoresponders** | ✅ Paid Addon | ✅ **Built-in** (HTML alerts via Brevo, Resend or an HTTP relay) |
| **Email Verification (OTP)** | ✅ Yes | ✅ **Built-in** (6-digit code, verified server-side) |
| **Smart Branching & Logic** | ✅ Yes | ✅ Yes (Target steps by answer ID) |
| **Dynamic Answer Piping** | ✅ Yes | ✅ Yes (Inject `{{name}}`, `{{goal}}` into any headline) |
| **Automatic UTM & Ad Tracking** | ⚠️ Limited | ✅ **Full** (`utm_source`, `utm_campaign`, `gclid`, `fbclid`, `ttclid`, etc.) |
| **Zapier, Make & CRM Webhooks** | ✅ Yes | ✅ **Full** (Signed server-side forwarding, endpoint never exposed) |
| **Meta Pixel, CAPI, GTM, GA4** | ✅ Yes | ✅ **Built-in** (Pre-wired event mapping) |
| **Monthly Lead Limits** | ❌ Tiered Caps | ✅ **Unlimited Leads** |
| **Data Privacy & Self-Hosting** | ❌ Vendor Lock-in | ✅ **100% Local / Self-Hostable** (JSONL files or Supabase) |
| **Price** | ~$1,200+/year | **$0 / Free Forever** |

---

## 📈 Real Marketing & Attribution Capabilities

OpenFunnel is engineered from the ground up for growth marketers, performance media buyers, and agencies running paid ad campaigns:

### 1. Automatic UTM & Ad Click Attribution
Every visitor who enters your funnel brings their ad parameters with them. OpenFunnel automatically captures and attaches these details to every lead submission:
- `utm_source` (e.g. `facebook`, `google`, `tiktok`, `newsletter`)
- `utm_medium` (e.g. `cpc`, `paid_social`, `email`)
- `utm_campaign` (e.g. `summer_promo_2026`)
- `utm_content` & `utm_term`
- `gclid` (Google Ads Click ID)
- `fbclid` (Facebook Ads Click ID)
- `ttclid` (TikTok Ads Click ID)
- `ref` (Custom Referral Code)

### 2. Multi-Channel Lead Integrations
Send your leads anywhere automatically:
- **Instant Email Alerts & Autoresponders**: Send formatted HTML email alerts to the business owner (`NOTIFY_EMAIL`) with full lead answers & UTM parameters, plus personalized welcome emails to leads. Delivery goes through the **Brevo API** (EU), the **Resend API** or an **HTTP relay** (`SMTP_RELAY_URL`), chosen with `EMAIL_PROVIDER` — direct SMTP is not implemented yet.
- **Webhooks (Zapier, Make.com, GoHighLevel, HubSpot, n8n)**: Every lead is forwarded server-side, optionally signed with an `X-Webhook-Secret` header. Your endpoint is never exposed to visitors.
- **CSV Export with Attribution**: Export leads in one click with full UTM columns for direct import into Google Sheets or CRMs.
- **Supabase Cloud Sync**: Sync lead records and analytics directly into your PostgreSQL database.
- **Local JSONL Storage**: Zero-database setup storing leads locally in `.data/leads.jsonl`.

### 3. Native Ad Pixels & Conversions API
- **Meta (Facebook) Pixel & CAPI**: Pre-mapped `Lead`, `ViewContent`, and `CompleteRegistration` events.
- **Google Tag Manager & GA4**: Automatically populates `dataLayer` on step views and form submissions.
- **TikTok Pixel**: Track mobile conversion events seamlessly.

---

## 🌐 How to Use OpenFunnel: Local vs. Cloud Deployment

OpenFunnel is designed to run in two modes depending on your workflow:

### 💻 1. Local Mode (Designing, Building & Testing)
- **Best for:** Designing new funnels, testing question logic, trying templates offline, and local development.
- **How it works:** You run `bun run dev` on your computer. Access the console locally at `localhost:3000/app`.
- **Integrations:** Even while running locally on your laptop, submitting a lead will forward data to external webhooks (Zapier/Make) if your computer is connected to the internet.

### ☁️ 2. Cloud Production Mode (24/7 Live Marketing & CRM Sync)
- **Best for:** Running live paid ad traffic (Facebook, TikTok, Google Ads), capturing real leads 24/7, and streaming data into your CRM.
- **Where to host:** Deploy on any cloud platform or VPS:
  - **PaaS Hosts:** [Render](https://render.com), [Railway](https://railway.app), [Fly.io](https://fly.io), [DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform)
  - **VPS Hosting:** AWS, Hetzner, Linode, Vultr running Ubuntu + Bun
- **How it works:** Point your custom domain (e.g., `https://quiz.yourdomain.com`) to your server.
- **Live Tool Sync:** Operates 24/7 without needing your personal computer open. Automatically pushes leads to Zapier, GoHighLevel, HubSpot, and Supabase.
- **⚠️ Required before going live:** set `ADMIN_TOKEN` (and `TRUST_PROXY=1` if your host terminates TLS in front of you) in your server environment, or the console APIs stay locked to localhost and you will not be able to reach your lead inbox remotely. See [Security & Privacy](#-security--privacy).

> **⚠️ Run exactly one instance, or plan for shared state first.**
>
> Rate limits, OTP challenges, the verified-email record and the hourly mail cap
> are all plain `Map`s in the server process. They are not shared between
> replicas and they reset on restart. That is fine — good, even — for one
> instance, which is what most self-hosters need. It breaks in two specific ways
> the moment you scale out, and neither one throws:
>
> - **Email verification fails intermittently.** An OTP issued by instance A is
>   not in instance B's memory, so a visitor who gets load-balanced between
>   requests is told their correct code is invalid.
> - **Every ceiling silently multiplies by your replica count.** Three instances
>   means three times the configured `MAIL_MAX_PER_HOUR` and three independent
>   sets of per-IP rate-limit buckets. Your limits are still "on"; they are just
>   three times looser than the number you set.
>
> Before you add a second instance you need an edge rate limit (Cloudflare,
> your load balancer) and a shared OTP store (Redis, or a Supabase table). The
> server prints this same warning at boot when `NODE_ENV=production`.
>
> **Autoscaling counts as scaling out.** A PaaS that quietly adds a replica
> under load puts you here without a deploy — pin the instance count to 1 on
> Render/Railway/Fly unless you have done the above.

---

## 🎨 How to Build & Launch Your Funnel

```
┌───────────────┐   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
│ 1. Launch App │──►│ 2. Pick        │──►│ 3. Build the   │──►│ 4. Edit the    │
│               │   │    Template    │   │    Landing Page│   │    Questions   │
└───────────────┘   └────────────────┘   └────────────────┘   └───────┬────────┘
                                                                      │
        ┌────────────────┐   ┌────────────────┐   ┌────────────────┐  │
        │ 7. Collect     │◄──│ 6. Alerts &    │◄──│ 5. Theme It    │◄─┘
        │    Leads       │   │    Webhooks    │   │                │
        └────────────────┘   └────────────────┘   └────────────────┘
```

### Step 1: Open the Console
Start OpenFunnel on your server or local environment and open your admin console at `/app`.

### Step 2: Pick a Proven Industry Template
20 pre-built funnels, filterable by category in `/templates`. Each is modelled on
a paid-traffic pattern rather than a feature demo — a landing page that sells the
click, two to four qualifying questions, a "warming" loader, then the form:

- 📈 **Lead Gen** (6): agency qualifier, lead magnet, insurance quote, mortgage pre-approval, social recruiting, newsletter.
- 📅 **Booking** (1): high-ticket application call, with branches that *disqualify* on budget and revenue so your calendar stays clean.
- 🛒 **E-commerce** (2): product-finder quiz, launch waitlist with countdown.
- 💻 **SaaS** (2): trial & demo with an enterprise branch, free ROI audit calculator.
- 🏡 **Local Services** (6): home valuation, solar savings, med spa, home improvement, car trade-in, gym trial.
- 🎯 **Coaching** (2): 1:1 application, 6-week body challenge.
- 🎟️ **Webinar** (1): live masterclass registration.

### Step 3: Build the Landing Page
A cold ad click is not ready for question 1. The `landing` step is a full
marketing page rendered as the first step of the funnel, so its CTAs advance
straight into the quiz — one document, no second page builder:

- **5 hero layouts**: centred, left, split (media beside copy), full-bleed, minimal.
- **Backgrounds**: image or muted looping video behind an adjustable scrim, or a flat colour / CSS gradient.
- **Chrome**: top nav with logo and links, sticky CTA bar that follows the scroll, footer for your imprint and privacy links.
- **Proof**: star rating, face pile, eyebrow badge, scroll hint.
- **20 section blocks** below the hero: heading, feature cards, how-it-works steps, stat row, FAQ accordion, pricing plans, image gallery, us-vs-them comparison, pull quote, trust badges, countdown, calculator, checklist, mid-page CTA, divider, spacer, image, video, paragraph, review cards.

Every section is an ordinary content block, so the same 20 types are available on
*any* step — a choice step can carry a testimonial above its options. A landing
step hides the progress bar by default (it is a page, not question 1 of 6), and
`width: "wide"` breaks it out of the 9:16 phone frame on desktop.

### Step 4: Edit Steps in the Visual Builder
Use the live mobile editor (`/builder`) featuring a **clean 4-Tab Inspector** (`Content`, `Design`, `Blocks`, `Logic`) to customize:
- **Conversion Step Archetype Library**: 1-click add 8 pre-built conversion step templates (Single-Choice Quiz with auto-advance, Multi-Select, Lead Capture Form with Anti-Spam OTP, VSL Video, ROI Calculator, Testimonials & Reviews, Pricing Comparison, Landing Page).
- **Visual Drag & Drop Editor**: Drag step rows in the spine, choice options, or content blocks with glowing drop target lines (`drop-before`/`drop-after`) and explicit `⋮⋮ Drag` grab handles.
- **Palette Drag-to-Add**: Drag content block chips directly from the palette onto any step.
- **Dual Reordering & Duplication**: Every list supports both **drag-and-drop** AND **1-click Up/Down arrow buttons** plus 1-click **Step & Option Duplication**.
- **Auto-Advance Toggle**: 1-click toggle on choice steps for instant single-choice quiz progression.
- **Dynamic Variable Piping**: Insert previous answers with 1-click token chips (`{{name}}`, `{{email}}`, `{{answers.budget}}`, `{{score}}`).
- **Question Steps**: Single-choice options with icons (`📈`, `🧭`, `💡`) or **Image Cards** with photo grid layouts, plus conversion badges (*"🔥 Popular"*, *"⭐ Best Value"*, *"⚡ Recommended"*).
- **Form Capture & Anti-Spam OTP**: Collect contact info with built-in 6-digit email OTP verification.
- **Branching & Disqualification**: Direct option branching targets to route qualified prospects to calendar booking and disqualified leads to exit pages.
- **Live Device Preview**: Phone / tablet / desktop switching with instant iframe preview updates. `Cmd/Ctrl+K` opens the command palette, `Cmd/Ctrl+S` saves, `1`–`6` switch views.

### Step 5: Theme It
The **Theme** modal gives you 8 presets (`midnight-glass`, `neo-brutalist`,
`warm-editorial`, `saas-gradient`, `clean-light`, `emerald-glow`,
`violet-pulse`, `sunset-coral`) plus a custom accent colour, font, corner radius,
light/dark mode and three button styles (`flat`, `glow`, `pressable-3d`).

**Settings** holds the funnel-level behaviour flags — back button, swipe
navigation, resume-on-return and the GDPR consent bar. These are saved onto the
funnel *document*, not your browser, which is what lets them reach a real
visitor. **Hide OpenFunnel Branding** removes the "Powered by OpenFunnel"
attribution. It does **not** remove the source link beside it: AGPL-3.0 §13
requires a networked modified version to offer its Corresponding Source to the
visitors interacting with it, so that link ships on every funnel with no off
switch. Set `branding.sourceLabel` to translate it ("Quellcode"); put it in the
same footer as your Impressum and Datenschutz links, which a German deployment
needs regardless.

> **Preset fonts are self-hosted.** Every built-in preset names a non-system
> font family, and those files ship with OpenFunnel and are served from your own
> domain — a funnel page makes no request to Google, with or without a consent
> bar. A `theme.font` naming some other family falls back to a system font
> rather than fetching it; add it to `packages/engine/src/fonts/` if you want it.

### Step 6: Configure Email Alerts & Webhooks
In **Settings**, set your admin notification email (`NOTIFY_EMAIL`) and a Resend API key to receive instant HTML lead alerts and trigger personalized autoresponders. In **Pixels & Tracking**, paste your Webhook URL (Zapier/Make/GoHighLevel), an optional webhook secret, and your Meta/GTM Pixel IDs.

Webhook delivery is server-side, so your endpoint and secret are never exposed in the funnel page. If you set a secret, each delivery carries it as an `X-Webhook-Secret` header for your automation to check.

Optionally enable **email verification** on a form step (`"verifyEmail": true`). The visitor receives a 6-digit code and the funnel only records `email_verified: true` once the server confirms it — a fake address cannot claim to be verified.

### Step 7: Publish & Collect Leads
Share your live funnel link (`/f/your-funnel-slug`). Review submitted leads in your **Lead Inbox** (`/leads`) or download them via **Export CSV**.

---

## 💻 For Developers & Self-Hosters

### Quick Start (Local Development)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/en449/openfunnel.git
   cd openfunnel
   ```

2. **Install dependencies with [Bun](https://bun.sh):**
   ```bash
   bun install
   ```

3. **Start the local server:**
   ```bash
   bun run dev
   ```

4. **Explore local routes (default port `3000`):**
   - **Unified App Console**: `/app`
   - **Visual Builder**: `/builder`
   - **Template Library**: `/templates`
   - **Lead Inbox**: `/leads`
   - **Analytics Dashboard**: `/analytics`
   - **Settings**: `/settings`
   - **Live Mobile Demo**: `/f/lead-gen`
   - **Landing Page Demo**: `/f/agency-landing`

5. **Run test suite:**
   ```bash
   bun test          # engine + runtime, including security regression tests
   bun run typecheck # JSDoc types across the engine
   ```

Running locally needs no configuration: the console APIs accept callers on
`localhost` without a token. Setting `ADMIN_TOKEN` becomes necessary the moment
the server is reachable from anywhere else.

---

### Connecting External Tools via Webhooks & Email

To forward leads to **Zapier**, **Make.com**, **GoHighLevel**, **HubSpot**, or a custom CRM, set your webhook URL in your environment:

```bash
# In your .env.local file
WEBHOOK_URL="https://hooks.zapier.com/hooks/catch/123456/abcdef"
```

Or configure it per-funnel directly in the Visual Builder under **Pixels & Tracking → Webhook URL**.

Set `WEBHOOK_SECRET` (or the per-funnel secret) and every delivery carries it as an `X-Webhook-Secret` header — compare it on your side before trusting a payload. Forwarding runs on the server, so neither the URL nor the secret ever appears in the funnel page, and OpenFunnel refuses to POST to loopback, private-network or cloud-metadata addresses.

---

### Environment Variables Reference

Copy `.env.example` to `.env.local`:

```env
# Runtime Configuration
PORT=3000
FUNNELS_DIR=examples/
DATA_DIR=.data/

# Interface to bind. Loopback by default, so a fresh install is not reachable
# from the rest of the network — which matters because with ADMIN_TOKEN unset
# the console trusts loopback callers. Set 0.0.0.0 in a container or behind a
# proxy, and set ADMIN_TOKEN when you do.
HOST=127.0.0.1

# Ceiling per JSONL sink, in bytes (default 64MB). At the cap the file rotates
# to <name>.jsonl.1 and a fresh one starts, so the pair is bounded and the
# newest records always survive. Ingest is public and unauthenticated, so
# without this a stranger decides how much of your disk it uses.
MAX_SINK_BYTES=

# Most bytes an admin reader pulls into memory from a sink (default 8MB, newest
# tail). The lead inbox and the stats page read these files; unbounded, the same
# stranger decides how much your dashboard allocates.
MAX_READ_BYTES=

# Admin access — REQUIRED once this server is reachable off-host.
# Guards the lead inbox, the funnel editor and your mail credentials.
# Generate with: openssl rand -hex 32
# Leave blank and those routes accept localhost only (fine for local dev).
ADMIN_TOKEN=

# Custom domains: host=slug pairs, comma separated. A hostname listed here
# serves ONLY that funnel — the console, the funnel list and every admin route
# answer 404 on it, which is what keeps your console off a client's domain when
# both are served by the same deployment. With Supabase configured the `domain`
# table does the same job and the console can edit it; the two are merged and
# the table wins a conflict. The DNS and the platform's own domain settings are
# still yours to configure.
#
# Behind a reverse proxy, the Host header must reach this server UNCHANGED
# (nginx: `proxy_set_header Host $host;`). A proxy that rewrites it makes every
# mapping miss, and a hostname whose mapping misses serves the console — the
# thing this setting exists to prevent. There is deliberately no
# x-forwarded-host fallback: that header is set by the caller, so trusting it
# would let anyone claim any mapping.
FUNNEL_DOMAINS=

# Absolute ceiling on outbound mail per hour, across all callers — covers both
# the OTP challenge and the lead autoresponder. Both mail an address taken from
# a public request body, and their per-IP limits key off x-forwarded-for, which
# the caller sets. This cap is the one a caller cannot rotate past. Default 500.
MAIL_MAX_PER_HOUR=

# Dead-letter alerts: how many mails per hour may leave when deliveries give up
# permanently (default 10). Its own bucket, so an outage cannot exhaust the
# lead-alert budget. ALERT_TIMEOUT_MS (default 5000) bounds that send — it is
# tighter than EMAIL_TIMEOUT_MS on purpose, because it runs inside the drain.
DEAD_LETTER_MAX_PER_HOUR=

# Set to 1 ONLY if this server really sits behind a proxy/CDN that rewrites the
# client address (Render, Railway, Fly, nginx, Cloudflare). x-forwarded-for is a
# request header anyone can send, so it is ignored unless you opt in — otherwise
# every per-IP limit would be bypassed by rotating a string. Deploy behind a
# proxy without this and all traffic shares one rate-limit bucket; the first
# forwarded request logs a warning telling you so.
TRUST_PROXY=

# Extra hostnames allowed to use loopback trust when ADMIN_TOKEN is unset. Only
# needed if you reach the console by a name other than localhost without a token.
# Anything unlisted is refused — this is what stops a DNS-rebinding page from
# driving the console through your own browser.
ALLOWED_HOSTS=

# Email Notifications & Autoresponders
NOTIFY_EMAIL=owner@yourdomain.com

# EMAIL_PROVIDER picks the transport. Brevo (Brevo SAS, Paris) is the EU
# provider this project prefers, for a German client's leads; Resend and
# SMTP_RELAY_URL below still work unchanged. With two provider keys configured
# and no EMAIL_PROVIDER set, the runtime warns once and keeps using Resend.
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_123456789...
RESEND_FROM="OpenFunnel Leads <leads@yourdomain.com>"
BREVO_API_KEY=xkeysib-...
BREVO_FROM="Leads <leads@yourdomain.com>"

# Optional HTTP-to-SMTP relay. Every message is POSTed here as JSON.
# Env-only by design: a relay URL settable through the API would let an
# attacker redirect every lead notification to themselves.
SMTP_RELAY_URL=

# Stored for a future direct-SMTP transport. Setting only these sends nothing.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM="OpenFunnel <noreply@yourdomain.com>"

# Global Webhook Forwarding (Zapier, Make, GoHighLevel, CRMs)
WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/...
# Legacy alias for WEBHOOK_URL, still read as a fallback.
ZAPIER_WEBHOOK_URL=
# Sent as the X-Webhook-Secret header so your automation can verify the sender.
WEBHOOK_SECRET=

# Supabase Sync (Optional)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Meta Conversions API — server-side conversion forwarding (Optional).
# Both are server-only. Never expose the token to the browser: it can write
# conversions into your ad account. Sends visitor IP and user-agent to Meta,
# so see "Third-party data sharing" below before enabling it.
META_PIXEL_ID=
META_CAPI_TOKEN=

# AI copilot (Optional) — fallback key for the admin-only /api/ai/* routes.
# The console can supply its own key per request, in which case this is unused.
OPENAI_API_KEY=

# "production" enables the 60s funnel cache and long-lived asset caching.
# Anything else (including unset) is treated as development, where the funnel
# cache is disabled so editing a JSON and reloading just works.
NODE_ENV=

# Execute <script> pasted into a funnel's Custom head/body fields. OFF by
# default: funnel pages share an origin with the console, so a script here can
# read your admin token. Opting in allows only the exact scripts you pasted
# (by SHA-256) — never a blanket 'unsafe-inline'. See "Custom Code Injection".
ALLOW_CUSTOM_SCRIPTS=
# Extra origins a pasted loader pulls further scripts from (space/comma list).
CUSTOM_SCRIPT_ORIGINS=
```

> **The AI copilot falls back silently.** With no usable key, `/api/ai/generate`
> returns a **hardcoded built-in funnel** rather than an error — a `200` does not
> mean a model ran. If the generated funnel looks generic, check the key before
> assuming the model ignored your prompt. The built-in generator is also the
> default (`Built-in generator — no key needed`), so this is the expected path
> until you configure a provider.

> **Browser pixels are not configured here.** Meta, GA4/GTM and TikTok pixel ids
> live in each funnel document under `integrations` — set them per funnel in the
> console's Pixels modal. There are no `NEXT_PUBLIC_*` pixel variables; the
> engine reads pixel ids from the funnel JSON, never from the environment.

---

### AI Copilot — Bring Your Own Model

**Settings → AI & Global Injection** picks the provider, model and key. The
routes are admin-only, and the key travels from the console to your own server —
never to the funnel page.

| Provider | Key format | Default model |
| :--- | :--- | :--- |
| **Built-in generator** (default) | none | — returns a fixed 5-step funnel |
| **OpenAI** | `sk-…` | `gpt-4o` |
| **Anthropic Claude** | `sk-ant-…` | `claude-3-7-sonnet-20250219` |
| **Google Gemini** | Google AI Studio key | `gemini-2.0-flash` |
| **DeepSeek** | DeepSeek key | `deepseek-chat` |
| **Custom / BYO** | any | falls through to the OpenAI-compatible chat-completions shape |

The model field is free text with suggestions, so any identifier your provider
accepts works — routing is decided by the provider you pick, with the model
prefix (`claude-`, `gemini-`, `deepseek-`) and key prefix (`sk-ant-`) as
fallbacks. Two admin-only routes use it: `/api/ai/generate` builds a whole funnel
from a prompt, and `/api/ai/improve-copy` powers **Suggest headlines** in the
step inspector.

> The console stores your API key in that browser's `localStorage`. It is a
> per-browser convenience credential, not shared server config — on a shared
> machine, clear it when you are done.

### Custom Code Injection

**Pixels & Tracking** has three fields written onto the funnel document
(`customCss`, `customHead`, `customBody`) and injected into the published funnel
page. What actually survives is governed by the funnel page's strict CSP:

| Field | Injected into | Default |
| :--- | :--- | :--- |
| **Custom CSS** | a `<style>` in `<head>` | ✅ Applied |
| **Custom `<head>` HTML** | end of `<head>` | ✅ Markup (meta, link) — `<script>` needs the opt-in below |
| **Custom `<body>` HTML** | end of `<body>` | ✅ Markup — `<script>` needs the opt-in below |

**Scripts are refused until you opt in**, and that default is load-bearing rather
than an oversight: a funnel page is served from the **same origin as the
console**, and your admin token lives in that origin's `localStorage`. A script
running on a funnel page can therefore read it and drain `/api/admin/*` — your
whole lead database. Funnel documents also get imported from templates and bug
reports (see [Treat a funnel document as code](#treat-a-funnel-document-as-code-not-as-data)),
so executing whatever a document carries would turn "I imported a funnel JSON"
into console takeover.

To enable it:

```bash
ALLOW_CUSTOM_SCRIPTS=1
# Optional: origins a pasted loader pulls *further* scripts from, which cannot
# be read off the snippet itself.
CUSTOM_SCRIPT_ORIGINS="https://www.clarity.ms https://static.hotjar.com"
```

Opting in does **not** drop the policy to `'unsafe-inline'`. Each inline script
is allowed by the SHA-256 of its exact bytes, and each external one by its own
origin (granted on both `script-src` and `connect-src`, so the script can beacon
home rather than loading and silently reporting nothing). Only what you pasted
runs — an injected `step.consent`, or an XSS in a future renderer, still cannot
execute, because their content was never hashed into the policy.

> **With the flag off, a funnel carrying script logs a warning server-side** at
> request time naming the funnel and the number of tags refused. It used to fail
> completely silently: a CSP violation in the visitor's console, nothing on the
> server, and a field that saved as if it had worked.

For Meta / GA4 / GTM / TikTok, prefer the first-class **Pixels** fields — they
add their own origins to the policy and need no opt-in. Note that anything GTM
loads at runtime is subject to the same policy, so a container pulling arbitrary
vendor tags will need those origins in `CUSTOM_SCRIPT_ORIGINS`.

---

### Embedding the Engine in External Applications

The core engine (`packages/engine`) has **zero dependencies** and can be mounted into any HTML page, React, Vue, Next.js, or Astro project:

```html
<div id="funnel-container"></div>

<script type="module">
  import { createFunnel } from "./packages/engine/src/index.js";
  
  const funnelConfig = {
    id: "lead-gen",
    slug: "lead-gen",
    theme: { primary: "#4f46e5", mode: "light" },
    steps: [
      {
        id: "home",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Free 60-second quiz",
        headline: "We find the leaks in your ad account",
        subtext: "Answer three questions and get a personalised breakdown.",
        background: { gradient: "linear-gradient(160deg,#4f46e5,#020617)", ink: "light" },
        cta: { label: "Start my free audit", note: "No credit card" },
        stickyCta: true,
        // `blocks` on a landing step is the page body below the hero.
        blocks: [
          { type: "stats", items: [{ value: "4.8×", label: "Median ROAS" }] },
          { type: "faq", items: [{ q: "Is it free?", a: "Yes." }] }
        ]
      },
      {
        id: "q1",
        type: "choice",
        headline: "What is your main business goal?",
        options: [
          { id: "grow", label: "Increase Sales", icon: "📈" },
          { id: "leads", label: "Get More Leads", icon: "🎯" }
        ]
      }
    ]
  };

  createFunnel(document.getElementById("funnel-container"), funnelConfig, {
    leadEndpoint: "/api/lead",
    onEvent: (event) => console.log("Funnel Event:", event),
  });
</script>
```

---

## 🔒 Security & Privacy

### ⚠️ Set `ADMIN_TOKEN` before you put this on the internet

Your console reads real people's names, emails and phone numbers. Every console
API — the lead inbox, the funnel editor, and your mail credentials — is
protected by a single shared secret:

```bash
# generate one
openssl rand -hex 32

# then set it in your server environment
ADMIN_TOKEN=<the value you generated>
```

Paste the same value into the console under **Settings → Admin API token**.

**If you leave it blank**, the server still refuses those routes to everyone
except callers on `localhost` — so `bun run dev` works with no setup, and a
public deployment fails closed instead of quietly exposing your leads. A request
arriving through a proxy is never treated as local, so putting nginx or a CDN in
front does not accidentally grant access.

### ⚠️ Terminate HTTPS in front of it

This server speaks plain HTTP — it has no TLS of its own, by design, because
every recommended host already terminates TLS for you. That means **you must not
expose it directly on a public IP over `http://`**. Two things travel in the
clear if you do:

- your `ADMIN_TOKEN`, sent as an `Authorization: Bearer` header on every console
  request — anyone able to observe the traffic gets your whole lead inbox;
- the leads themselves: names, emails and phone numbers, in request bodies.

On Render, Railway, Fly.io or DigitalOcean App Platform this is handled for you —
just set `TRUST_PROXY=1` so per-IP limits see the real client address, and
`HOST=0.0.0.0` so the container's port is reachable at all. On a bare VPS, put
nginx, Caddy or Cloudflare in front with a certificate (Caddy issues one
automatically) and leave `HOST` at its `127.0.0.1` default so this process is
only reachable through the proxy.

### What the runtime does for you

- **Local data ownership**: leads and events stay in `.data/leads.jsonl` unless you route them outward.
- **Credentials are never echoed back**: the settings API reports *whether* a Brevo, Resend or SMTP secret is set, never its value.
- **Outbound destinations are operator-owned**: webhook targets come from your environment or your funnel document, never from a visitor's request, and loopback / private / cloud-metadata addresses are refused.
- **Signed webhooks**: set a webhook secret and every delivery carries an `X-Webhook-Secret` header your automation can check.
- **Email verification that actually verifies**: six-digit codes from a CSPRNG, five attempts, ten-minute expiry, never returned to the browser — and the server re-derives `email_verified` rather than believing the client.
- **Abuse limits**: the ingest, OTP and mail endpoints are rate-limited per address and per caller, and every outbound mail path — the OTP challenge, the autoresponder and the lead notification — additionally passes a global hourly ceiling (`MAIL_MAX_PER_HOUR`), each in its own bucket — the per-caller key comes from `x-forwarded-for`, which a caller can rotate, so it cannot be the only bound.
- **The console's APIs refuse cross-site browser requests**: privileged routes reject a cross-site `Origin`/`Sec-Fetch-Site` before authenticating, and CORS is scoped to the public ingest paths only. Without this, a page you merely visit could drive the console on a default local install, where the admin gate trusts loopback.
- **The console cannot be framed**: `X-Frame-Options: DENY` plus `frame-ancestors 'none'` on every
  operator-facing page, so a lure page cannot overlay an invisible console and borrow your session.
  Funnel pages deliberately stay framable — being embeddable is the point.
- **Escaped output**: lead data is escaped into notification emails, the lead inbox, and the funnel HTML shell.
- **Request bodies are capped at 64KB** at the transport layer, so a public
  endpoint cannot be made to buffer a large body — with the cap left to the JSON
  parser alone, a chunked request sends no `Content-Length` and the whole body is
  read into memory before anything can reject it.
- **Path-traversal validation** (`SLUG_RE` plus an `isInside()` containment check that requires a path separator, so a sibling directory sharing the root's name cannot be reached) on every route that touches a file.
- **Outbound destinations are filtered**: webhook targets are refused for loopback, private, link-local, CGNAT and cloud-metadata addresses, including IPv4-mapped IPv6 and the decimal/hex IP spellings.
- **No third-party sharing until you configure it**: pixels fire only for the ids
  you put in a funnel's `integrations`, and the Meta Conversions API forward is
  inert unless you set `META_PIXEL_ID` and `META_CAPI_TOKEN`. A funnel page with
  no pixels configured makes **no** external request at all — including for
  fonts, which are self-hosted, on any theme.
- **Consent is enforced, not decorative**: turn on the consent bar for a funnel
  and pixels stay uninstalled and the CAPI forward
  is skipped until the visitor accepts. The server reads `consent.enabled` from
  your funnel document, so stripping the field out of a request does not turn the
  gate off. See [Third-party data sharing](#third-party-data-sharing).

### Treat a funnel document as code, not as data

A funnel JSON is **operator-authored input that the engine trusts**. One field is
rendered as raw HTML on purpose — a form step's `consent`, so you can put a link
to your privacy policy in it — and nothing sanitises it.

That is safe for funnels you wrote, and it is why the write path is locked down
(admin gate + cross-site refusal). It has two consequences worth knowing:

- **Don't import a funnel JSON you didn't write** — from a gist, a template pack,
  or a bug report — without reading it first. On a page served by this runtime the
  strict CSP stops it executing script, so the realistic damage is injected markup
  (a phishing link, a third-party tracking pixel) rather than code execution.
- **If you embed the engine in your own page** (the section above), that CSP is
  *yours* to set, and without one an untrusted `consent` field is straightforward
  XSS on your origin. Serve embedded funnels with a `script-src` that does not
  include `'unsafe-inline'`, or only embed documents you control.

Anyone who can reach the console can write a funnel document, which is the real
reason `ADMIN_TOKEN` matters — see above.

### Third-party data sharing

Two things send visitor data off your server. Both are opt-in, and both are
worth understanding before you enable them:

| Feature | What leaves | Turned on by |
| --- | --- | --- |
| Browser pixels (Meta, GA4/GTM, TikTok) | Whatever the platform's script collects in the visitor's browser, including cookies it sets | Pixel ids in a funnel's `integrations`, via the console's Pixels modal |
| Meta Conversions API | Visitor **IP address** and **user-agent**, server-side, per lead and per event | `META_PIXEL_ID` + `META_CAPI_TOKEN` in the environment |

Fonts are **not** in this table: the preset families are self-hosted and served
from your own domain, so a funnel page loads no third-party asset of any kind.

An IP address is personal data under GDPR, so the CAPI forward is a third-party
transfer you need a lawful basis to make — it is not covered by "we set no
cookies."

To gate both on consent, enable the consent bar on the funnel (Settings →
GDPR & Privacy Consent Bar, saved onto the funnel document as `consent.enabled`).
Then:

- **Gated** — browser pixels are not installed at all until the visitor accepts,
  and the server skips the CAPI forward for any record that is not an explicit
  grant.
- **Not gated** — lead capture (`/api/lead`) and your own drop-off analytics
  (`/api/events`). The visitor filled the form in and pressed submit; dropping
  that would be a broken funnel, not a private one, and those records stay on
  your server.

The decision is stored first-party in `localStorage` and is not re-prompted. A
funnel with no consent bar behaves exactly as it did before this existed, so
enabling it is the only thing that changes behaviour.

> **Scope note.** Rate limits and OTP state live in memory, so they are
> per-process — run more than one instance and you want an edge rate limit and a
> shared store. The console has no multi-user accounts or audit log; the admin
> token is all-or-nothing access. Direct SMTP is not implemented — use Brevo,
> Resend or an HTTP relay via `SMTP_RELAY_URL`.

### Known gaps — settings that exist in the UI but nothing reads yet

The console will happily save these. They are honest TODOs, not working
features, and are listed here so you don't ship a campaign depending on one:

- **Google Ads and LinkedIn pixel fields** (Pixels & Tracking). Saved onto the
  funnel document, but the engine's pixel layer only implements Meta, GA4, GTM
  and TikTok — nothing fires for either. (A Pinterest handler exists in the
  console's code with no input field to drive it, so that one is inert twice
  over.)
- **Custom `<head>` / `<body>` scripts** — injected, but not executed until you
  set `ALLOW_CUSTOM_SCRIPTS=1`. This one is a deliberate default rather than a
  TODO; see [Custom Code Injection](#custom-code-injection) above for why.
- **Workspace currency, language, notification email and "global code"**
  (Settings). Stored in that browser's `localStorage` only. They are per-browser
  values, so they can never reach a visitor — anything visitor-facing has to live
  on the funnel document, the way the consent bar and the branding toggle now do.
- **The `select` and `file` form field types.** The engine renders `select`, but
  the console has no editor for its options, so it is deliberately absent from
  the field-type dropdown rather than offered as an empty dropdown. Nothing in
  the ingest path stores an uploaded file.

---

## 📜 License

This project is licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

AGPL v3 ensures OpenFunnel remains free and open-source forever. Anyone hosting a modified version as a public service must release their source code back to the open-source community.

### Modified version — notice of changes (AGPL-3.0 §5(a))

This repository is a **modified fork** of
[luispdoesai/openFunnel](https://github.com/luispdoesai/openFunnel), branched at
commit `4164afd` (2026-08-07). Upstream is unaffiliated with these changes and
carries no responsibility for them.

Changes made in this fork:

- **2026-08-10 — security hardening** following an independent audit of the
  upstream tree (findings and reasoning in [`security-audit/`](security-audit/)):
  the server binds `HOST` rather than every interface, lead/read sinks are
  size-capped, `x-forwarded-for` is only honoured behind `TRUST_PROXY`, webhook
  targets are resolved and pinned before the request, URL checks parse instead of
  pattern-matching, and funnel-document fields that reach markup, iframes or
  endpoints are filtered by the engine itself.
- **2026-08-10 — the legacy standalone UIs `apps/builder` and `apps/admin` were
  deleted.** They were superseded by `apps/app`, and `builder.js` broadcast the
  whole funnel document — `webhookSecret` included — with `postMessage(doc, "*")`.
- **2026-08-11 — licence compliance:** the full AGPL-3.0 text now ships in
  [`LICENSE`](LICENSE) (§4), this notice was added (§5(a)), and every funnel page
  renders a source link to the deployment's Corresponding Source (§13).

### Running a modified version publicly

If you deploy your own fork, §13 applies to you the same way: point `SOURCE_URL`
in [`packages/engine/src/controller.js`](packages/engine/src/controller.js) at
**your** published tree. It ships pointing at this one, and a link to somebody
else's source satisfies nothing.

Client funnel documents, leads and credentials are data, not part of the Program
— the licence never asks you to publish those. Keep them out of the tree you
publish; `FUNNELS_DIR` defaults to `examples/`, which is inside it.
