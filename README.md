# OpenFunnel 🚀

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Engine: Zero Dependencies](https://img.shields.io/badge/Engine-Zero_Dependencies-success.svg)](#-for-developers--self-hosters)

> **An open-source, mobile-first quiz & lead funnel builder.**  
> Create high-converting interactive funnels in minutes — an open, self-hostable alternative to Perspective.co, Typeform, and Outgrow.

---

## 🤔 What is OpenFunnel?

OpenFunnel is an interactive mobile funnel software designed to turn website visitors into qualified leads and sales. 

Instead of sending paid ad traffic (from Facebook, TikTok, Instagram, or Google) to a boring static landing page, OpenFunnel lets you guide visitors through a **fast, swipeable, step-by-step quiz experience** directly on their mobile phones.

### Why use OpenFunnel?
- 📱 **Blazing Fast on Mobile Phones**: Opens instantly even on slow 3G/4G connections.
- 🎯 **Higher Conversion Rates**: Interactive questions feel like a quiz, keeping visitors engaged until they submit their contact info.
- 🔀 **Smart Branching**: Show different questions based on what visitors answer (e.g. ask business owners about budget, but individuals about goals).
- 💬 **Personalized Copy (Answer Piping)**: Automatically insert a visitor's name or choices into subsequent steps (*"Great news, Sarah! Here is your custom plan..."*).
- 📊 **Built-in Lead Inbox & Analytics**: View captured leads, names, emails, and drop-off rates directly inside your dashboard.
- 💵 **100% Free & Open Source**: No monthly subscriptions, no lead caps, no platform fees.

---

## 🎨 How to Use OpenFunnel (5 Easy Steps)

You don't need to write code to create and publish funnels with OpenFunnel.

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  1. Launch App  │ ──► │  2. Pick Template│ ──► │ 3. Edit Questions│ ──► │ 4. Share Funnel  │
└─────────────────┘     └──────────────────┘     └──────────────────┘     └──────────────────┘
                                                                                   │
                                                                                   ▼
                                                                          ┌──────────────────┐
                                                                          │ 5. Collect Leads │
                                                                          └──────────────────┘
```

### Step 1: Launch the App Console
Start OpenFunnel on your computer or server and open the console in your browser (`http://localhost:3000`).

### Step 2: Choose a Ready-to-Use Template
Go to **Templates** and pick a starter funnel built for your industry:
- 📈 **Lead Generation**: Perfect for agencies, consultants, and service businesses.
- 🏋️ **Fitness & Wellness**: Qualify coaching clients and calculate custom plans.
- 🏡 **Real Estate**: Capture homebuyers and seller criteria effortlessly.

### Step 3: Customize Questions in the Visual Builder
Open the **Builder** tab to edit your funnel:
- **Left Panel**: Add or rearrange your sequence of steps (Question 1, Question 2, Contact Form, Thank You Page).
- **Middle Screen**: Live mobile preview that updates immediately as you type.
- **Right Panel**: Edit headlines, button text, icons, colors, and branching rules.

### Step 4: Add Your Pixels & Branding
- **Theme**: Pick your brand color, dark/light mode, and rounded button styles.
- **Tracking Pixels**: Paste your Meta (Facebook) Pixel ID, Google Tag Manager (GTM), GA4, or TikTok Pixel to track conversions automatically.

### Step 5: Publish & Collect Leads
Save your funnel and share your live link (`http://localhost:3000/f/your-funnel-name`).
Whenever visitors complete your funnel, their submissions appear instantly in your **Lead Inbox** (`/leads`), complete with answers, contact details, and timestamp.

---

## 🛠️ Step Types Included

OpenFunnel comes out of the box with 6 interactive screen types:

1. **Single Choice**: Visitors tap one option to advance (e.g. *"What is your goal?"*).
2. **Multi-Select**: Visitors select all options that apply before clicking Next.
3. **Lead Form**: Capture names, emails, phone numbers, or custom fields with automatic validation.
4. **Content / Info**: Display headlines, images, subheadings, or custom calls-to-action.
5. **Interactive Loader**: An animated calculation screen that builds excitement (*"Analyzing your answers..."*).
6. **Success / Thank You**: Confirm submission, show personalized results, or redirect to a calendar/booking page.

---

## 💻 For Developers & Self-Hosters

If you want to host OpenFunnel on your own server or embed the engine into an existing codebase, here is how to get started:

### Quick Start (Local Setup)

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

4. **Access the endpoints:**
   - **Unified App Console**: `http://localhost:3000/app`
   - **Visual Builder**: `http://localhost:3000/builder`
   - **Lead Inbox**: `http://localhost:3000/leads`
   - **Analytics Dashboard**: `http://localhost:3000/analytics`
   - **Live Mobile Funnel Example**: `http://localhost:3000/f/lead-gen`

5. **Run automated test suite:**
   ```bash
   bun test
   ```

---

### Repository Architecture

```
openFunnel/
├── packages/engine/   The zero-dependency funnel engine (~1.8k lines of vanilla ESM)
├── apps/app/          The unified web console (Builder, Templates, Leads, Analytics)
├── apps/runtime/      Single-file Bun server serving funnels & handling lead ingestion
├── examples/          Pre-configured funnel JSON documents
└── demo/              Zero-build browser playground for testing the engine
```

---

### Embedding the Engine in Existing Sites

The `@openfunnel/engine` package is framework-agnostic. You can mount it directly inside any React, Vue, Astro, or vanilla HTML page:

```html
<div id="funnel-container"></div>

<script type="module">
  import { createFunnel } from "./packages/engine/src/index.js";
  
  const config = {
    id: "my-funnel",
    slug: "my-funnel",
    theme: { primary: "#4f46e5", mode: "light" },
    steps: [
      {
        id: "q1",
        type: "choice",
        headline: "What is your main goal?",
        options: [{ id: "opt1", label: "Grow Sales", icon: "🚀" }]
      }
    ]
  };

  createFunnel(document.getElementById("funnel-container"), config, {
    leadEndpoint: "/api/lead",
    onEvent: (e) => console.log("Funnel Event:", e)
  });
</script>
```

---

### Server Environment Configuration (`.env`)

Copy `.env.example` to `.env.local` to customize runtime options:

```env
PORT=3000
FUNNELS_DIR=examples/
DATA_DIR=.data/

# Optional: Supabase Database Sync
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Optional: Server-side Meta CAPI & Pixel Tracking
NEXT_PUBLIC_META_PIXEL_ID=
META_CAPI_ACCESS_TOKEN=
NEXT_PUBLIC_GTM_ID=
NEXT_PUBLIC_GA4_MEASUREMENT_ID=
```

---

## 🔒 Security & Privacy

- **Local-First Storage**: Leads and analytics events append locally to `.data/leads.jsonl` and `.data/events.jsonl` — your user data never leaves your server unless you explicitly configure external tools.
- **Sanitized Inputs**: Built-in protection against Directory Traversal attacks and XSS output escaping in the Lead Inbox.
- **No Third-Party Cookies Required**: Track funnel conversions natively without violating GDPR / privacy regulations.

---

## 📜 License

This project is licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

AGPL v3 ensures OpenFunnel remains free and open-source forever. Anyone hosting a modified version as a public service must release their source code back to the community.
