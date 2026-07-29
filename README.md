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
| **Smart Branching & Logic** | ✅ Yes | ✅ Yes (Target steps by answer ID) |
| **Dynamic Answer Piping** | ✅ Yes | ✅ Yes (Inject `{{name}}`, `{{goal}}` into any headline) |
| **Automatic UTM & Ad Tracking** | ⚠️ Limited | ✅ **Full** (`utm_source`, `utm_campaign`, `gclid`, `fbclid`, `ttclid`, etc.) |
| **Zapier, Make & CRM Webhooks** | ✅ Yes | ✅ **Full** (Server-side + Client-side Webhook forwarding) |
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
- **Webhooks (Zapier, Make.com, GoHighLevel, HubSpot, n8n)**: Forward leads directly via server-side or client-side POST requests.
- **CSV Export with Attribution**: Export leads in one click with full UTM columns for direct import into Google Sheets or CRMs.
- **Supabase Cloud Sync**: Sync lead records and analytics directly into your PostgreSQL database.
- **Local JSONL Storage**: Zero-database setup storing leads locally in `.data/leads.jsonl`.

### 3. Native Ad Pixels & Conversions API
- **Meta (Facebook) Pixel & CAPI**: Pre-mapped `Lead`, `ViewContent`, and `CompleteRegistration` events.
- **Google Tag Manager & GA4**: Automatically populates `dataLayer` on step views and form submissions.
- **TikTok Pixel**: Track mobile conversion events seamlessly.

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
- **Question Steps**: Single-choice options with icons (`📈`, `🧭`, `💡`).
- **Multi-Select**: Allow users to pick multiple preferences.
- **Interactive Loader**: Show an animated *"Calculating your customized results..."* screen to build anticipation.
- **Form Capture**: Collect name, email, phone number with instant validation.
- **Dynamic Piping**: Insert previous answers into headlines like `"Great news, {{name}}! Here is your custom plan"`.

### Step 4: Configure Webhooks & Pixels
In the **Pixels & Tracking** tab, paste your Webhook URL (Zapier/Make/GoHighLevel) and your Meta/GTM Pixel IDs.

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
   bun test
   ```

---

### Connecting External Tools via Webhooks

To forward leads to **Zapier**, **Make.com**, **GoHighLevel**, **HubSpot**, or a custom CRM, set your webhook URL in your environment:

```bash
# In your .env.local file
WEBHOOK_URL="https://hooks.zapier.com/hooks/catch/123456/abcdef"
```

Or configure it per-funnel directly in the Visual Builder under **Pixels & Tracking → Webhook URL**.

---

### Environment Variables Reference

Copy `.env.example` to `.env.local`:

```env
# Runtime Configuration
PORT=3000
FUNNELS_DIR=examples/
DATA_DIR=.data/

# Global Webhook Forwarding (Zapier, Make, GoHighLevel, CRMs)
WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/...

# Supabase Sync (Optional)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Tracking Pixels (Optional)
NEXT_PUBLIC_META_PIXEL_ID=
META_CAPI_ACCESS_TOKEN=
NEXT_PUBLIC_GTM_ID=
NEXT_PUBLIC_GA4_MEASUREMENT_ID=
```

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

- **Local Data Ownership**: Leads and events remain on your server inside `.data/leads.jsonl` unless explicitly routed outward.
- **Sanitized Outputs**: XSS protection for Lead Inbox views and path-traversal validation (`SLUG_RE`) for all funnel document loads.
- **GDPR Compliant**: Collect zero invasive third-party tracking cookies by default.

---

## 📜 License

This project is licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

AGPL v3 ensures OpenFunnel remains free and open-source forever. Anyone hosting a modified version as a public service must release their source code back to the open-source community.
