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
| **Interactive Screen Types** | ✅ Yes | ✅ Yes (Single-choice, Multi-select, Form, Loader, Content, Success) |
| **Option Image Cards & Media** | ✅ Yes | ✅ **Full** (Image cards, grid layout & step hero media) |
| **Email Alerts & Autoresponders** | ✅ Paid Addon | ✅ **Built-in** (HTML alerts via Resend or an HTTP relay) |
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
- **Instant Email Alerts & Autoresponders**: Send formatted HTML email alerts to the business owner (`NOTIFY_EMAIL`) with full lead answers & UTM parameters, plus personalized welcome emails to leads. Delivery goes through the **Resend API** or an **HTTP relay** (`SMTP_RELAY_URL`) — direct SMTP is not implemented yet.
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

---

## 🎨 How to Build & Launch Your Funnel

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  1. Launch App  │ ──► │  2. Pick Template│ ──► │ 3. Edit Questions│ ──► │ 4. Set Integrations│
└─────────────────┘     └──────────────────┘     └──────────────────┘     └──────────────────┘
                                                                                   │
                                                                                   ▼
                                                                          ┌──────────────────┐
                                                                          │ 5. Collect Leads │
                                                                          └──────────────────┘
```

### Step 1: Open the Console
Start OpenFunnel on your server or local environment and open your admin console at `/app`.

### Step 2: Pick a Proven Industry Template
Choose from pre-built funnel templates optimized for high conversion:
- 📈 **Lead Generation**: Agency & service business client qualification.
- 🏋️ **Fitness & Wellness**: Calorie/plan calculation quizzes.
- 🏡 **Real Estate**: Homebuyer and seller criteria capture.

### Step 3: Edit Steps in the Visual Builder
Use the live mobile editor (`/builder`) to customize:
- **Question Steps**: Single-choice options with icons (`📈`, `🧭`, `💡`) or **Image Cards** with photo grid layouts.
- **Step Hero Media**: Attach high-res hero photos or video blocks to step headers.
- **Multi-Select**: Allow visitors to pick multiple preferences with instant feedback.
- **Interactive Loader**: Show an animated *"Calculating your customized results..."* screen to build anticipation.
- **Form Capture**: Collect name, email, phone number with instant validation.
- **Dynamic Piping**: Insert previous answers into headlines like `"Great news, {{name}}! Here is your custom plan"`.

### Step 4: Configure Email Alerts & Webhooks
In **Settings**, set your admin notification email (`NOTIFY_EMAIL`) and a Resend API key to receive instant HTML lead alerts and trigger personalized autoresponders. In **Pixels & Tracking**, paste your Webhook URL (Zapier/Make/GoHighLevel), an optional webhook secret, and your Meta/GTM Pixel IDs.

Webhook delivery is server-side, so your endpoint and secret are never exposed in the funnel page. If you set a secret, each delivery carries it as an `X-Webhook-Secret` header for your automation to check.

Optionally enable **email verification** on a form step (`"verifyEmail": true`). The visitor receives a 6-digit code and the funnel only records `email_verified: true` once the server confirms it — a fake address cannot claim to be verified.

### Step 5: Publish & Collect Leads
Share your live funnel link (`/f/your-funnel-slug`). Review submitted leads in your **Lead Inbox** (`/leads`) or download them via **Export CSV**.

---

## 💻 For Developers & Self-Hosters

### Quick Start (Local Development)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/luispdoesai/openFunnel.git
   cd openFunnel
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
   - **Lead Inbox**: `/leads`
   - **Analytics Dashboard**: `/analytics`
   - **Live Mobile Demo**: `/f/lead-gen`

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

# Admin access — REQUIRED once this server is reachable off-host.
# Guards the lead inbox, the funnel editor and your mail credentials.
# Generate with: openssl rand -hex 32
# Leave blank and those routes accept localhost only (fine for local dev).
ADMIN_TOKEN=

# Absolute ceiling on outbound mail per hour, across all callers — covers both
# the OTP challenge and the lead autoresponder. Both mail an address taken from
# a public request body, and their per-IP limits key off x-forwarded-for, which
# the caller sets. This cap is the one a caller cannot rotate past. Default 500.
MAIL_MAX_PER_HOUR=

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
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_123456789...
RESEND_FROM="OpenFunnel Leads <leads@yourdomain.com>"

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
```

> **Browser pixels are not configured here.** Meta, GA4/GTM and TikTok pixel ids
> live in each funnel document under `integrations` — set them per funnel in the
> console's Pixels modal. There are no `NEXT_PUBLIC_*` pixel variables; the
> engine reads pixel ids from the funnel JSON, never from the environment.

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

### What the runtime does for you

- **Local data ownership**: leads and events stay in `.data/leads.jsonl` unless you route them outward.
- **Credentials are never echoed back**: the settings API reports *whether* a Resend or SMTP secret is set, never its value.
- **Outbound destinations are operator-owned**: webhook targets come from your environment or your funnel document, never from a visitor's request, and loopback / private / cloud-metadata addresses are refused.
- **Signed webhooks**: set a webhook secret and every delivery carries an `X-Webhook-Secret` header your automation can check.
- **Email verification that actually verifies**: six-digit codes from a CSPRNG, five attempts, ten-minute expiry, never returned to the browser — and the server re-derives `email_verified` rather than believing the client.
- **Abuse limits**: the ingest, OTP and mail endpoints are rate-limited per address and per caller, and every outbound mail path — the OTP challenge, the autoresponder and the lead notification — additionally passes a global hourly ceiling (`MAIL_MAX_PER_HOUR`), each in its own bucket — the per-caller key comes from `x-forwarded-for`, which a caller can rotate, so it cannot be the only bound.
- **The console's APIs refuse cross-site browser requests**: privileged routes reject a cross-site `Origin`/`Sec-Fetch-Site` before authenticating, and CORS is scoped to the public ingest paths only. Without this, a page you merely visit could drive the console on a default local install, where the admin gate trusts loopback.
- **The console cannot be framed**: `X-Frame-Options: DENY` plus `frame-ancestors 'none'` on every
  operator-facing page, so a lure page cannot overlay an invisible console and borrow your session.
  Funnel pages deliberately stay framable — being embeddable is the point.
- **Escaped output**: lead data is escaped into notification emails, the lead inbox, and the funnel HTML shell.
- **Path-traversal validation** (`SLUG_RE` plus an `isInside()` containment check that requires a path separator, so a sibling directory sharing the root's name cannot be reached) on every route that touches a file.
- **Outbound destinations are filtered**: webhook targets are refused for loopback, private, link-local, CGNAT and cloud-metadata addresses, including IPv4-mapped IPv6 and the decimal/hex IP spellings.
- **No third-party sharing until you configure it**: pixels fire only for the ids
  you put in a funnel's `integrations`, and the Meta Conversions API forward is
  inert unless you set `META_PIXEL_ID` and `META_CAPI_TOKEN`. A funnel on the
  default theme makes no external request at all; one on a built-in preset theme
  fetches that preset's webfont from Google unless the consent bar gates it.
- **Consent is enforced, not decorative**: turn on the consent bar for a funnel
  and pixels stay uninstalled, the webfont stays unrequested, and the CAPI forward
  is skipped until the visitor accepts. The server reads `consent.enabled` from
  your funnel document, so stripping the field out of a request does not turn the
  gate off. See [Third-party data sharing](#third-party-data-sharing).

### Third-party data sharing

Three things send visitor data off your server. All three are opt-in, and all
three are worth understanding before you enable them:

| Feature | What leaves | Turned on by |
| --- | --- | --- |
| Browser pixels (Meta, GA4/GTM, TikTok) | Whatever the platform's script collects in the visitor's browser, including cookies it sets | Pixel ids in a funnel's `integrations`, via the console's Pixels modal |
| Meta Conversions API | Visitor **IP address** and **user-agent**, server-side, per lead and per event | `META_PIXEL_ID` + `META_CAPI_TOKEN` in the environment |
| Google Fonts webfont | Visitor **IP address**, **user-agent** and **Referer** (the funnel URL) sent to `fonts.googleapis.com` by the browser | A `theme.font` naming a non-system family — which every built-in preset theme does. The default theme requests nothing |

An IP address is personal data under GDPR, so the CAPI forward and the webfont
request are both third-party transfers you need a lawful basis to make — neither
is covered by "we set no cookies."

To gate all three on consent, enable the consent bar on the funnel (Settings →
GDPR & Privacy Consent Bar, saved onto the funnel document as `consent.enabled`).
Then:

- **Gated** — browser pixels are not installed at all until the visitor accepts,
  the webfont is not requested until then either (colours and layout apply
  immediately; the font swaps in on accept), and the server skips the CAPI
  forward for any record that is not an explicit grant.
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
> token is all-or-nothing access. Direct SMTP is not implemented — use Resend or
> an HTTP relay via `SMTP_RELAY_URL`.

---

## 📜 License

This project is licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

AGPL v3 ensures OpenFunnel remains free and open-source forever. Anyone hosting a modified version as a public service must release their source code back to the open-source community.
