# Research: Funnel/Quiz Builder SaaS Competitor & Market Landscape
Date: 2026-08-10

## 1. Perspective.co (perspective.co, Berlin)

### Pricing tiers
IMPORTANT CAVEAT: perspective.co/pricing is JS-rendered. WebFetch's HTML→markdown conversion garbled the digits (rendered numbers looked concatenated, e.g. "4759€/Month" and "147184€/Month" for what are almost certainly two adjacent monthly/annual price columns being merged into one string). I could NOT get a clean, verifiably-separated first-party price read. Cross-checked against a third-party pricing-tracker site (thatmarketingbuddy.com) whose figures are internally consistent with the pattern seen in the garbled first-party numbers, so confidence is medium, not high, on exact digits.

Reconstructed pricing (billed annually vs monthly), EUR, net/excl. VAT:
| Tier | Monthly | Annual (per mo, billed yearly) | Live Funnels | Seats |
|---|---|---|---|---|
| Base | €59/mo | €47/mo | 2 | 1 (implied) |
| Grow | €184/mo | €147/mo | 10 | 3 |
| Expand | €369/mo | €297/mo | 20 | 5 |
| Scale | Custom (one first-party fetch showed "€969/Month" as a literal figure, but a secondary source calls Scale "Custom") | — | 60+ | Custom |

Source (secondary, dated): https://thatmarketingbuddy.com/pricing/perspective-funnels — article states "Prices verified Jun 1, 2026 Source: pricing page scrape." Retrieved 2026-08-10.
Source (primary, garbled digits but confirms tier names/order/features): https://www.perspective.co/pricing — retrieved via WebFetch 2026-08-10 (JS rendering issue noted above — **could not fully verify exact price digits from the primary source alone**).

### Per-tier limits (from primary pricing page, feature-bullet text — these bullets parsed cleanly, only the price digits were garbled)
- **Base**: 2 Live Funnels, Unlimited Workspaces, Unlimited Domains, Unlimited Contact Managers, "50+ Premium Features", CRM/Metrics/Email, Live Support, Weekly Live Training, "GDPR-Compliant", Meta Pixel/Zapier/Make.
- **Grow**: 10 live Funnels, 3 team seats, all Base features, Custom Scripts, A/B Testing, Branding Removal, Automation Sequences, "All Basic Integrations". AI features (150 AI credits per a secondary source) gated to Grow+.
- **Expand**: 20 live Funnels, 5 seats, all Grow features, Multiple Lead Recipients, Dynamic Headlines, Smart Personalization, Custom Fonts, WhatsApp Messaging, "All Premium Integrations".
- **Scale**: 60+ live Funnels, custom seats, all Expand features, "All Perspective Suites", Dedicated Customer Success Manager, Role Management, Migration Discount.
- Overage: **€0.25 per extra "Generated Lead" / "Active Contact"** beyond plan quota (Base=100, Grow=500, Expand=1,000 leads per secondary source — not independently confirmed on primary page).
- White-label is sold as a paid **add-on suite** (not bundled even at Expand), per secondary source: "Whitelabel Suite, Premium Block Suite... €67–84/month each." NOT independently confirmed on primary pricing page (add-on suites weren't itemized in the cleanly-parsed bullet list above, only mentioned as "All Perspective Suites" at Scale).
Source: https://www.perspective.co/pricing (retrieved 2026-08-10); https://thatmarketingbuddy.com/pricing/perspective-funnels (retrieved 2026-08-10). Confidence: medium (digits), high (feature/tier structure).

### Feature gating summary
- Gated to Grow+: AI credits/features, A/B testing, custom scripts, removing Perspective branding, automation sequences.
- Gated to Expand+: WhatsApp messaging, multiple lead recipients (routing leads to different people — agency-relevant), dynamic/personalized headlines, custom fonts.
- Gated to Scale only: dedicated CSM, role-based permissions, "all Suites" (implies white-label bundled only at top tier, or still an add-on — unclear, see caveat above).

### What the product contains beyond a funnel builder
- **Built-in CRM**: lightweight, contact/pipeline management, trigger messages from a contact record. Source: https://www.emailvendorselection.com/perspective-funnels-review/ (retrieved 2026-08-10), corroborated by pricing-page bullet "CRM, Metrics & Email" at Base tier.
- **Email + WhatsApp automation**: automated message sequences triggerable from any funnel step; WhatsApp messaging gated to Expand tier. Source: pricing page bullets + https://www.emailvendorselection.com/perspective-funnels-review/.
- **Ads integration**: Meta Pixel & Conversion API, LinkedIn Insight Tag, TikTok Pixel — native, all tiers per Base-tier bullet "Meta Pixel". Source: https://www.perspective.co/integrations (retrieved 2026-08-10).
- **AI**: "AI-powered funnel generation, copy assistance, conversion optimization recommendations" built into editor; described as "describe the funnel you want, minutes later it's live... with hosting, tracking, CRM, and matching email sequences already connected." A dedicated "Perspective MCP" (Model Context Protocol server) was announced for AI-agent-driven funnel building. Sources: https://www.perspective.co/ai-info, https://www.perspective.co/article/perspective-mcp (retrieved 2026-08-10, both unfetched directly — from WebSearch snippet, treat as medium confidence).
- **Analytics**: real-time funnel analytics, step-by-step conversion tracking, drop-off analysis, UTM breakdown. Source: https://www.emailvendorselection.com/perspective-funnels-review/.
- **A/B testing**: yes, gated to Grow tier+. Source: pricing page.
- **Team/agency features**: "For Agencies" landing page exists (https://www.perspective.co/for/agencies, retrieved 2026-08-10) — claims funnel duplication, white-label design, multiple lead recipients as agency differentiators. **No reseller/client-sub-account pricing was published on that page** — it does not describe true multi-client sub-accounts/workspaces with separate billing, just "Unlimited Workspaces" at every tier and white-label as an add-on.

### Integrations — named list (from https://www.perspective.co/integrations, retrieved 2026-08-10)
- Direct/native: GoHighLevel, Zoho CRM, WhatsApp Messaging, Brevo, Hotjar, Cal.com, HubSpot Meetings Embed, GHL Calendar Embed, Meta Pixel & Conversion API, LinkedIn Insight Tag, TikTok Pixel, Google Analytics 4, Google Tag Manager, HubSpot (full CRM), Salesforce, Close, Recruitee, Personio, ActiveCampaign, Klicktipp, Mailchimp, Gmail, Outlook, Airtable, Trello, Monday.com, Calendly, Google Sheets, Custom Scripts (own API app), Domain/SSL.
- Platforms: Zapier ("6,000+ tools" per integrations page; a WebSearch snippet elsewhere said "9,000 apps" and another said "2,000+ app connections" — inconsistent secondary claims, primary page figure "6,000+" preferred as it came from direct WebFetch of perspective.co/integrations), Make.com ("1,000+ apps"), raw Webhooks, own REST API (Contacts & Metrics — fetch/create/update).
- Notable German-market-relevant CRM named: **Personio** (HR/recruiting SaaS, German), **Klicktipp** (German email marketing tool) — both point to a recruiting + German SMB use-case emphasis.
Source: https://www.perspective.co/integrations, retrieved 2026-08-10. Confidence: high for the names, medium for the exact "X,000+ apps" marketing counts (inconsistent across pages).

### Onboarding (signup → first published funnel)
- **14-day free trial**, no credit card required to start; card/subscription begins on day 14 unless cancelled. Source: https://intercom.help/perspective-funnels/en/articles/5276653-how-can-i-use-the-free-trial-period-to-the-best, retrieved 2026-08-10.
- No mandatory demo-call gate to start a trial — self-serve signup with "Try for free" CTAs. An optional demo exists: "a 15-minute express demo" by their Head of Growth (Niels Klement). Source: WebSearch snippet citing perspective.co, retrieved 2026-08-10.
- 20+ pre-built templates, drag-and-drop editor, conditional logic. Source: https://www.emailvendorselection.com/perspective-funnels-review/, retrieved 2026-08-10.
- Free "Academy" (30+ courses) and weekly live training calls included even on Base tier. Source: pricing page bullets + WebSearch snippet, retrieved 2026-08-10.
- Cancel any time from Settings → Subscription → Cancel. Source: WebSearch snippet citing perspective.co help center, retrieved 2026-08-10.

### Stated ICP and positioning
- Tagline: **"Double Your Business with Perspective Funnels™"**. Claims: "700% higher conversion, 42x faster building, 300% better lead quality" (marketing claims, unverified/no methodology given).
- Named use-cases/verticals on-site: recruiting/talent sourcing (application funnels), B2B services (appointment/strategy-call generation), e-commerce, webinar/list-building, and a dedicated "For Agencies" page.
- Customer logos shown: Google, Zalando, DHL, Coca-Cola, Mercedes-Benz, Marriott (these read as large/enterprise brand-recognition logos, likely used as trust signals rather than typical customer profile — could be past clients' clients or aspirational logos; not independently verified which specific product/plan these logos used).
- Testimonials given: recruiting-focused (70% more applicants), webinar funnel (8,000 registrants), one bootstrapped SaaS founder claiming "$10M ARR" success partly attributed to Perspective funnels.
- No explicit "Germany only" / German-SMB-only positioning found — site appears to target English-speaking global market with a German company base (Perspective is headquartered in Berlin per general knowledge, not independently re-confirmed by a fetched page in this session — flagging as **(unverified in this session)**).
Source: https://www.perspective.co/ (homepage), retrieved 2026-08-10.


### Company facts (corrected/verified pricing)
- Perspective = **Perspective Software GmbH**, Müggelstraße 22, D-10247 Berlin, HRB 197136 (Amtsgericht Charlottenburg), managing director Michael Bogner, "5,000+ customers" claimed. Source: https://www.perspective.co/imprint via WebSearch snippet, retrieved 2026-08-10.
- **Verified clean pricing (via r.jina.ai proxy re-fetch of perspective.co/pricing, 2026-08-10, high confidence — digits read cleanly this time, matches thatmarketingbuddy.com independently):**
  - Base: **€59/mo billed monthly, €47/mo billed annually**
  - Grow: **€184/mo billed monthly, €147/mo billed annually**
  - Expand: **€369/mo billed monthly, €297/mo billed annually**
  - Scale: **€969/mo** (annual-equivalent not separately shown; a secondary source calls Scale "custom" — likely €969 is the annual-billed starting price with custom above that)
  - **6 paid Add-On Suites, each €67-84/month** (price varies — likely €67/mo annual vs €84/mo monthly), gate specific feature clusters on top of any base tier: Whitelabel Suite (custom favicon, remove branding from funnels & email, custom fonts, whitelabel lead notifications), Premium Block Suite (loading spinner, HTML block, video question/upload, quiz reveal, address autocomplete), Personalization Suite (advanced page linking, dynamic headlines, smart personalization), Advanced Messaging Suite (automation conditions/delays, email sequences/personalization, WhatsApp automation + chat inbox), Advanced Metrics Suite (A/B testing on first page, significance recommendations, time-on-page, UTM tracking), Premium Integration Suite (lead data export, webhooks, GoHighLevel/Brevo/ActiveCampaign/HubSpot/Zoho/Recruitee/Hotjar/Personio).
  - **This reveals real packaging complexity**: base tier pricing bullets look bundled ("A/B Testing" listed as a Grow-tier feature) but the *same* feature (A/B testing) also appears as part of the paid "Advanced Metrics Suite" add-on — suggests either the tier bullets pre-bundle a lighter version and the Suite unlocks the fuller version, or there is overlap/inconsistency between the flat-tier bullets and the add-on-suite marketing page. Not resolved from public pages — **flagging as an open ambiguity**, not a confirmed fact.
  Source: https://www.perspective.co/pricing (re-fetched via r.jina.ai, 2026-08-10).

---

## 2. Direct competitors

### Heyflow (heyflow.com, Hamburg, Germany)
Company: Heyflow GmbH, Jungfernstieg 49, 20354 Hamburg, HRB 161040, founded 2020 by Amir Bohnenkamp & Dustin Jaacks/Werner (name spelled two ways across sources), rebranded from "Niro" to "Heyflow" in May 2021. Source: https://www.northdata.com/Heyflow%20GmbH,%20Hamburg/HRB%20161040 and https://heyflow.com/blog/niro-is-heyflow/ (via WebSearch, retrieved 2026-08-10).

**Pricing (retrieved via r.jina.ai proxy of heyflow.com/pricing/, 2026-08-10 — direct WebFetch got HTTP 403, proxy succeeded):**
| Tier | Price | Limits |
|---|---|---|
| Growth | €89/mo | 250 responses/month, 10 funnels ("heyflows"), 2 seats |
| Scale | €239/mo | 1,000 responses/month, 20 funnels, 4 seats, native A/B testing |
| Prime (eCommerce-specific) | €199/mo | 25k visitors/month, 10 quiz funnels, 4 seats |
| Enterprise | from €1,100/mo | >5,000 responses/month, unlimited funnels |
| Custom | custom | unlimited visitors/funnels/responses |
| Extra seat add-on | €35/account/mo | — |
- Metering unit note: page states "up to 31%"/"up to 51%" annual savings but doesn't show exact annual digits in the scrape. Overage add-on: "€0.15 per additional response, €8 per additional Heyflow [funnel]" per a WebSearch snippet of the same page (retrieved 2026-08-10) — not independently re-verified digit-by-digit.
- **No "Starter" tier found on the current live pricing page** — third-party aggregators (Capterra pricing page, retrieved 2026-08-10) list an older-looking "Starter €49/Growth €89/Scale €239/Enterprise custom" structure; a WebSearch snippet also mentioned "Starter begins at €19." These are inconsistent with each other and with the live site, likely reflecting a recent pricing overhaul (Heyflow published a blog post titled "Funnel Builder Pricing is Stuck in the Past. Here's How We're Modernizing Ours" — https://heyflow.com/blog/new-pricing/, could not fetch directly, 403). **Treat exact entry-tier price as uncertain; Growth-tier (€89/mo, 250 responses) is the most consistently corroborated current entry point.**
- Metering unit: **"responses"** (=leads/form completions), separately from "visitors" only on the eCommerce-specific Prime plan.

**3 differentiators (from cross-source synthesis):**
1. Positioned as the more "technical/logic-heavy" builder — "plays to its strengths in complex logic and pre-qualification," vs. Perspective's speed focus. Source: handelsblatt.com comparison article via WebSearch snippet, retrieved 2026-08-10.
2. GDPR/hosting: "data centers located exclusively in the EU," ISO 27001 certified since Nov 2022, DPA/AVV auto-included via ToS (no separate signature needed). Source: https://heyflow.com/de/funktionen/datensicherheit/ and https://help.heyflow.com/en/articles/8608215-faq-data-privacy via WebSearch, retrieved 2026-08-10.
3. Strong recruiting/HR use-case: named "conditional logic... for recruiting... guide applicants" as a specific strength in a Trustpilot review; also markets HubSpot lead-scoring/routing app in HubSpot ecosystem marketplace. Source: Trustpilot review quote (see Section 6) + https://ecosystem.hubspot.com/marketplace/apps/heyflow-993605, retrieved 2026-08-10.

### Typeform (typeform.com)
**Pricing — USD is the default/primary currency shown; a German-language pricing URL (typeform.com/de/pricing) still rendered USD-only per direct fetch** ("Plan details and pricing are shown in USD only" — explicit statement on the page). EUR figures below come from a secondary German source (omr.com-sourced WebSearch snippet), medium confidence:
- Free: $0 — 100 responses/mo, 1 user, unlimited typeforms
- Basic: $29/mo ($25/mo annual) — 100 responses/mo, 1 user — EUR secondary figure not found for this tier
- Plus: $59/mo ($50/mo annual) ≈ secondary source states **€55/mo monthly, €46/mo annual** — 1,000 responses/mo, 3 users, branding removal, custom subdomain
- Business: $99/mo ($83/mo annual) ≈ secondary source states **€89/mo monthly, €75/mo annual** — 10,000 responses/mo, 5 users, drop-off/conversion analytics, priority support
- Talent (recruiting-specific): $119/mo — 3,000 responses/mo, video Q&A
- Growth Flow: $379/mo — 10,000 responses/mo + "enrich 1,500 responses/mo," Salesforce integration
- Enterprise: custom
Metering unit: **"responses."**
Sources: https://www.typeform.com/pricing (direct fetch, USD, retrieved 2026-08-10), WebSearch snippet citing omr.com for EUR figures (retrieved 2026-08-10, medium confidence — not independently re-verified on a fetched page).

**3 differentiators:**
1. Design/UX-led positioning — "strong design experience in dialogue" (per handelsblatt comparison), the original conversational-form category creator, not funnel/quiz-marketing-first.
2. Dedicated "Talent" plan/pricing tier for recruiting use-case with video Q&A — a vertical-specific tier, unusual among competitors.
3. Growth Flow tier bundles data enrichment (1,500 responses/mo enriched) + Salesforce integration — positions Typeform higher up the B2B/sales-ops stack than Perspective's SMB-lead-gen framing.

### Involve.me (involve.me)
**Pricing is USD**, not EUR (both direct fetch and a German-language search query still returned USD figures — no evidence of a distinct EUR price list):
- Free: 50 submissions/500 visits per month
- Start: $29/mo billed monthly ($19-49/mo annual depending on source — two secondary sources disagree on exact annual figure, see caveat) — 3 live funnels, 1 user, email automation, built-in CRM, 30+ integrations
- Grow: $69/mo monthly ($49-99/mo annual) — 5 live funnels, 2 users, branding removal, custom domain, HubSpot/Klaviyo integration
- Scale: $139/mo monthly ($119-199/mo annual) — 25 live funnels, 5 users, A/B testing, Salesforce, webhooks, OTP email/SMS verification
- Enterprise: from $499/mo — SSO, SOC 2 Type 2 reports, dedicated onboarding
**Caveat:** two direct/secondary fetches of the same pricing page returned different digits for the annual price column (one said Start annual=$49/mo, another said Start annual=$19/mo) — likely one is reading monthly-billed-monthly vs monthly-billed-annually columns inconsistently, same JS-rendering ambiguity seen with Perspective. Monthly (non-annual) figures ($29/$69/$139/$499) were consistent across both fetches — **higher confidence on those**.
Metering unit: **"submissions"/"live funnels"/"visits" (free tier only).**
Source: https://www.involve.me/pricing (direct WebFetch, retrieved 2026-08-10) + WebSearch cross-check, retrieved 2026-08-10.

**3 differentiators:**
1. Lowest published entry price among all researched competitors ($29/mo for 3 funnels + built-in CRM + email automation bundled at entry tier — Perspective and Heyflow both gate CRM/automation higher or as add-ons).
2. Free plan exists (50 submissions/500 visits) — none of Perspective, Heyflow, Typeform paid-equivalent has a comparably generous always-free tier for funnels specifically (Typeform's free tier is form-only, 100 responses).
3. Enterprise tier explicitly names **SOC 2 Type 2** compliance reporting — a US-enterprise-compliance signal, not a DSGVO/EU-hosting signal (no EU-hosting claim found on involve.me in this research).

### Outgrow (outgrow.co)
**Pricing is USD only** — no EUR pricing page/currency found via search.
- Free Forms/Surveys: $0 — 1 content type, 1,200 leads/yr, 4 pieces, 1 user
- Freelancer Limited: $22/mo ($14/mo annual) — 5 content types, 3,000 leads/yr (250/mo), 5 pieces, 1 user
- Freelancer Pro: $45/mo ($25/mo annual) — 7 content types, 12,000 leads/yr, 7 pieces
- Essentials: $115/mo ($95/mo annual) — 9 content types, 90,000 leads/yr (7,500/mo), unlimited pieces, 3 users
- Business: $720/mo ($600/mo annual) — all 9 content types, 600,000 leads/yr (50,000/mo), unlimited pieces, 10 users, custom domain hosting
- Enterprise: custom — SSO, API access, account manager
Metering unit: **"leads per year"** (unusual — annualized lead quota rather than monthly, plus a parallel "content pieces" limit i.e. number of live quizzes/calculators).
Source: https://outgrow.co/pricing (direct WebFetch, retrieved 2026-08-10).

**3 differentiators:**
1. Metering is on **annual lead quota**, not monthly — unique among researched vendors; smooths seasonal spikes but makes cross-vendor cost comparison harder.
2. Product-type breadth: "Content Types" = Quiz, Assessment, Poll, Calculator, Form, Survey, eCommerce Recommendation, Giveaway, Chatbot, Landing Page — broader format menu than Perspective/Heyflow, which are funnel/form-first.
3. Steepest price jump to enterprise-scale usage: Business tier at $720/mo for 50k leads/mo — implies a much higher per-lead-capacity price than involve.me/Perspective at comparable tiers (rough unit-cost comparison, not independently normalized).

### Leadpages / Unbounce (landing-page anchors, USD)
- **Leadpages** (leadpages.com, retrieved 2026-08-10 direct fetch): two product lines shown — "HTML Pub" (Starter $10/mo/5 pages, Pro $29/mo/25 pages, Business $49/mo/50 pages) and "Leadpages" proper (Grow $99/mo unlimited pages+traffic, Optimize $199/mo adds AI traffic routing/heatmaps, Scale $399/mo adds full auto-optimization + dedicated CSM). All plans claim "no traffic caps." AI-credit metering appears on the HTML Pub line (4K-20K AI credits/mo).
- **Unbounce** (unbounce.com, retrieved 2026-08-10 direct fetch): Starter $29/mo (500 visitors, 5 pages, 1 user, 1 domain) → Build $99/mo (unlimited pages, 20k visitors, 1 domain) → Experiment $149/mo (30k visitors, 3 users, 2 domains) → Optimize $249/mo (50k visitors, 5 users, 3 domains) → Concierge/Agency: custom, starting 100k/50k visitors respectively.
Metering unit for both: **"visitors"/"traffic volume"** (landing-page category meters on traffic, not leads/responses/submissions — a structural difference from the quiz/funnel category above).
No EUR-specific pricing pages were found for either (WebSearch explicitly returned "no EUR search results, only USD/GBP" for both, retrieved 2026-08-10).

### Additional German-market funnel/quiz builders found (not in original question list)
- **FunnelCockpit** (funnelcockpit.com) — German company, servers in Germany, DSGVO-compliant positioning, bundles funnel builder + email marketing + CRM + membership areas "in one system." Pricing (secondary sources only — direct fetch got HTTP 429 rate-limited even via proxy): **Lite €47/mo (€39.95/mo annual), Standard €97/mo (€82.45/mo annual), Business €297/mo**, 15% annual discount. CRM only included from Standard tier up; webinars only from Standard up (unlimited at Business). Source: multiple German SEO/affiliate sites converging on the same numbers (startuprakete.de, funnel-profi.de, kreativeskaos.de) via WebSearch, retrieved 2026-08-10 — **medium confidence, no primary-source price confirmed** (funnelcockpit.com/preise returned 403/429 on both direct and proxied fetch attempts).
- **meetergo** (meetergo.com) — German, positions as "European alternative to Typeform, Jotform, Google Forms," DSGVO-compliant forms hosted on EU servers, explicitly claims "no CLOUD Act risk." Combines scheduling/video/CRM/e-signature with a form builder. Pricing not fetched in this session — flagged as a gap. Source: WebSearch snippet, retrieved 2026-08-10.
- **Visit2Lead** (visit2lead.de) — turns existing websites into "lead machines" without redesign; DSGVO-compliant, ISO 27001 hosting from Germany, integrated Matomo analytics (heatmaps/session recordings). Pricing not fetched. Source: WebSearch snippet, retrieved 2026-08-10.
- **funnerix** (funnerix.com) — German, mobile-first, DSGVO-compliant funnels — but a WebSearch snippet notes it "was scheduled to go offline in November 2025," i.e. likely defunct/discontinued by the time of this research (2026-08-10). Treat as a market-exit data point, not a live competitor. Source: WebSearch snippet, retrieved 2026-08-10 — **not independently confirmed by visiting funnerix.com directly in this session.**
- Perspective's own "alternatives" page (via OMR Reviews) additionally names: EASY2, Kameleoon, Varify.io (GDPR-compliant A/B testing/dynamic landing pages), Brame (gamification), ODOSCOPE, Searchhub, Webflow, VWO, AB Tasty — most of these are CRO/personalization tools adjacent to, not directly competing with, funnel builders. Source: https://omr.com/en/reviews/product/perspective-funnels/alternatives, retrieved 2026-08-10.

---

## 3. Pricing/packaging patterns

**Metering units actually used, per vendor (cross-referenced from Sections 1-2 above):**
- Perspective: **live funnels** (hard cap per tier: 2/10/20/60+) + **"Generated Leads"/"Active Contacts"** (overage €0.25/extra) + **seats** (1/3/5/custom).
- Heyflow: **"responses"** (=completed submissions, monthly cap) + **funnels** ("heyflows," monthly cap) + **seats** (extra seat €35/mo); one eCommerce-specific tier also meters **visitors**.
- Typeform: **"responses"** (monthly cap) + **seats**; forms themselves are unlimited on every tier.
- involve.me: **live funnels** + **submissions** (free tier: 50/mo) + **visits** (free tier: 500/mo) + **seats**.
- Outgrow: **leads per year** (annualized, unusual) + **"content pieces"** (number of simultaneously live quiz/calculator instances) + **seats**.
- Leadpages/Unbounce (landing-page category, for contrast): **visitors/traffic volume** + **pages** + **domains** + **seats** — no lead/response metering at all, confirming landing-page tools meter traffic while funnel/quiz tools meter completions.
- FunnelCockpit: tiered by **feature access** (CRM/webinars gated by tier) more than by a hard usage number, per secondary sources — **projects** cap mentioned ("up to five projects" on Lite) but no lead/response cap found.

**Pattern:** the funnel/quiz-builder category (Perspective, Heyflow, Typeform, involve.me, Outgrow) converges on **completions (leads/responses/submissions)** as the primary metering unit, with a **secondary hard cap on number of live funnels/forms**, and **seats** as a third axis. This is structurally different from classic landing-page tools (Leadpages/Unbounce), which meter **visitor/traffic volume** instead — because a landing page's job is to be seen, while a funnel/quiz's monetizable unit is a completed submission.

**Typical entry price for solo/SMB tier, EUR (or EUR-equivalent), converging across vendors:** roughly **€30-60/month** for a usable paid entry tier (Perspective Base €47-59, Heyflow Growth €89 is somewhat above this band, Typeform Plus ≈€46-55, involve.me Start ≈€19-49, FunnelCockpit Lite ≈€40-47, Outgrow Freelancer ≈€14-22 in USD). **~€40-90/month is the realistic solo/SMB entry-tier band** once trial/promotional pricing is excluded.

**Typical agency/higher tier price, EUR:** roughly **€250-400/month** for the "does everything, several seats, white-label-adjacent" tier before custom/Enterprise pricing kicks in (Perspective Expand €297-369, Heyflow Scale €239, involve.me Scale ≈$139 ≈€130, FunnelCockpit Business €297, Outgrow Business $720/€~660). **Enterprise/Custom tiers above that are uniformly "contact sales," no published price**, seen consistently at Perspective (Scale), Heyflow (Enterprise from €1,100), Typeform (Enterprise), involve.me (Enterprise from $499), Outgrow (Enterprise), Unbounce (Concierge/Agency).

**Who offers white-label / client sub-accounts and at what price:**
- **Perspective**: White-label is a **paid add-on suite**, not bundled even at the Expand tier — "Whitelabel Suite" ≈€67-84/month on top of any base plan (custom favicon, remove branding from funnels & email, whitelabel lead notifications). "Unlimited Workspaces" is included at every tier, but that is not the same as a true reseller/client-sub-account system with separate client billing — no such reseller billing system was found described on perspective.co. Source: Section 1 above, https://www.perspective.co/pricing, retrieved 2026-08-10.
- **Heyflow**: "Branding Removal" appears bundled starting at a mid tier per general funnel-builder comparison patterns; **not independently confirmed via primary source in this session** — flagged as unverified for Heyflow specifically (their pricing bullets fetched didn't explicitly list a "remove branding" line item, unlike Perspective/Typeform/involve.me which do).
- **Typeform**: Branding removal is bundled starting at the **Plus tier** ($59/mo / ≈€46-55/mo) — no separate white-label fee. Source: https://www.typeform.com/pricing, retrieved 2026-08-10.
- **involve.me**: Branding removal bundled starting at the **Grow tier** ($69/mo). Source: https://www.involve.me/pricing, retrieved 2026-08-10.
- **None of the researched vendors publish a dedicated "agency reseller" pricing tier with per-client sub-billing** (i.e. an agency paying one price and reselling isolated branded workspaces to N clients with separate client logins/billing) as a clearly documented, price-listed feature. Perspective's and involve.me's "Enterprise" tiers mention SSO/dedicated onboarding but not reseller/sub-account billing specifically. **This is a gap/finding, not a "not public" — it appears this specific packaging model (true agency white-label reseller with client sub-accounts) is genuinely rare-to-absent in this vendor set based on public pricing pages.**

---

## 4. GDPR / DSGVO angle

- **Heyflow**: explicit and detailed public claims — "data centers located exclusively in the EU," ISO 27001 certified since November 2022, annual penetration tests, DPA/AVV **automatically included** via Terms & Conditions acceptance (no separate signature required). Source: https://heyflow.com/de/funktionen/datensicherheit/, https://help.heyflow.com/en/articles/8608215-faq-data-privacy — both via WebSearch snippet, retrieved 2026-08-10 (not independently re-fetched page-by-page, medium-high confidence given detail/specificity of the quoted claims).
- **Perspective**: pricing page itself lists **"GDPR-Compliant"** as a bulleted feature at every tier including the entry Base tier. Source: https://www.perspective.co/pricing, retrieved 2026-08-10 (high confidence, directly read). No explicit "hosting in Germany/EU" location claim was found in the pages fetched in this session (only the generic "GDPR-Compliant" bullet) — **could not confirm Perspective's specific server/hosting location claim; flagged as a gap**, though the company itself is a German GmbH (Berlin).
- **FunnelCockpit**: WebSearch snippet states "DSGVO-compliant lead generation... German company with servers in Germany." Source: WebSearch snippet (funnel-builder-vergleich.de-adjacent result), retrieved 2026-08-10 — not independently re-verified on a fetched primary page (funnelcockpit.com blocked both direct and proxied fetch in this session).
- **meetergo**: explicitly markets itself as **"the European alternative to Typeform, Jotform, and Google Forms"** with forms "on EU servers without CLOUD Act risk." This is a direct, explicit US-vs-EU sovereignty sales pitch. Source: WebSearch snippet, retrieved 2026-08-10.
- **Visit2Lead**: "DSGVO-compliant ISO 27001 hosting service from Germany," "Privacy by Design," integrated Matomo (a privacy-friendly, self-hostable analytics alternative to Google Analytics) instead of GA4. Source: WebSearch snippet citing visit2lead.de, retrieved 2026-08-10.
- **funnerix**: "mobile-first, DSGVO-compliant... made in Germany" — but flagged above as likely discontinued (Nov 2025). Source: WebSearch snippet, retrieved 2026-08-10.
- **Typeform, involve.me, Outgrow, Leadpages, Unbounce**: **no explicit EU-hosting or DSGVO-specific marketing claim was found for any of these five** in this research session — their pricing/marketing pages surfaced are US/global-SaaS-compliance-flavored (e.g. involve.me's Enterprise tier promotes **SOC 2 Type 2**, a US framework, not EU data-residency). This absence is itself a finding: **"DSGVO-konform + Hosting in Deutschland" is used as an explicit, prominent selling point specifically by the German-market players (Heyflow, FunnelCockpit, meetergo, Visit2Lead, funnerix) and NOT by the US-headquartered international players (Typeform, involve.me, Outgrow, Leadpages, Unbounce)** in the pages surfaced. Perspective (German company) uses the generic "GDPR-Compliant" bullet but — based on what was found in this session — does not appear to lead with an explicit "Hosting in Deutschland" claim the way Heyflow/meetergo/Visit2Lead do; this is a potential positioning gap for Perspective specifically. Confidence: medium (based on the specific pages/snippets surfaced, not an exhaustive crawl of every vendor's legal/security pages).

---

## 5. Integrations that matter for German SMB

### Real estate agents (Immobilienmakler)
- **Market leader: onOffice** — "over 36,000 users," **42% market share in DACH**, independent company (onOffice GmbH, Aachen). Source: WebSearch snippet citing an industry market-share summary, retrieved 2026-08-10 — **secondary source, not a primary onOffice/analyst report; treat market-share % as medium confidence.**
- **#2 tier: Propstack and FLOWFACT**, combined "over 5,300 customers" — Propstack (founded 2016) now reportedly surpassing FLOWFACT in revenue; FLOWFACT was long-time leader with "Performer" product but needed a "technological restart" after acquisition by ImmobilienScout24, relaunched as a cloud platform since 2020. **FIO** also named as central for bank-affiliated brokers. Source: same WebSearch snippet, retrieved 2026-08-10.
- **API/webhook availability**: **onOffice has a documented public API** (onoffice.com/immobiliensoftware/api/) plus a **native Zapier integration** ("onOffice enterprise" on Zapier, with webhook triggers like "Fetch Address"/"Fetch Property," configurable via onOffice's own "Process Manager" webhook step). This is a real, technically integrable target for a lead-delivery product. Source: https://onoffice.com/immobiliensoftware/api/, https://zapier.com/apps/onofficeenterprise/integrations — both via WebSearch, retrieved 2026-08-10.

### Dentists (Zahnärzte)
- **Market leader: Dampsoft (DS-WIN-PLUS/DS-Win)** — reported market share **~35% (34.91%-35.94%)** per KZBV (Kassenzahnärztliche Bundesvereinigung) EDV-Statistik, cited across multiple trade press sources (zm-online.de, zwp-online.info). Source: WebSearch snippets citing KZBV statistics, retrieved 2026-08-10 — **KZBV is the authoritative German dental-billing-statistics body, so this is a relatively credible market-share figure even though I did not fetch the KZBV report directly.**
- **#2: CGM Z1 (CompuGroup Medical)** — "more than 7,000 dentists use CGM Z1 daily," reported ~24% share in one secondary source. Dampsoft + CGM together reported to hold **>55% of conservative-surgical billing volume**.
- **#3: ivoris** — dominant specifically in orthodontics (KFO) billing, 34.6% share of electronically submitted KFO claims in Q4 2023.
- **API/webhook availability**: Dampsoft's online-booking integration is via a **named partner product, "Dr. Flex"** (a third-party appointment-booking layer that syncs into DS-Win), starting at **€29/month**, not a general-purpose open public API for arbitrary lead delivery. Also a separate Dampsoft↔jameda (a German doctor-review/booking portal) data-sync partnership exists. **This suggests dental-practice software in Germany is NOT commonly open via public API for third-party lead-funnel tools — integration realistically requires either a partner-integration route (like Dr. Flex) or manual/CSV lead handoff.** Source: WebSearch snippets citing dampsoft.de and dr-flex.de, retrieved 2026-08-10 — not independently confirmed by fetching Dampsoft's own developer docs (none surfaced in search).

### Trades/Handwerk (GaLaBau landscaping, SHK plumbing-heating)
- **No public market-share statistics were found** for GaLaBau- or SHK-specific handwerker software (unlike real estate and dental, where KZBV/industry reports exist). Named products repeatedly appearing across German "best-of" comparison sites (softwareabc24.de, handwerk-digitalisieren.de, trusted.de — all secondary/affiliate comparison sites, not primary vendor data or independent market research): **STREIT** (ERP for electrical/SHK/refrigeration/roofing), **HERO** (cloud, SHK/electrical/painting/metal), **mfr** (SHK-focused, strong field-service/mobile app), **Smarthandwerk** (roofers/SHK/tile/paint/carpentry/GaLaBau), **TAIFUN** (SHK/electricians/roofers/window/carpentry/dry-construction/GaLaBau), **plancraft** and **Bosch OfficeOn** (also named as tested providers). Source: WebSearch snippets, retrieved 2026-08-10. **Confidence: low-medium** — these are rankings from comparison/affiliate sites (commercial incentive to rank certain vendors), not independent market-share data. **Explicitly NOT PUBLIC**: a quantified market-share breakdown for German Handwerk software (the only general digitalization data found was a Bitkom Research 2025 survey of 504 Handwerk firms on digitalization generally, not software-vendor share specifically — https://www.itsm-gmbh.de/digitalisierung-im-handwerk-bitkom-studie-2025/, via WebSearch, retrieved 2026-08-10).
- **API/webhook availability for these products**: **not established in this research session** — no search specifically surfaced public API/webhook documentation for STREIT, HERO, mfr, Smarthandwerk, or TAIFUN. This is a real gap; flagging as **NOT PUBLIC / not found**, would need direct vendor-by-vendor developer-docs research to resolve.

### Cross-cutting takeaway for Section 5
The clearest, most-evidenced lead-delivery integration targets for a German SMB-focused funnel product are **onOffice (real estate, public API + Zapier)** and, with more friction, **Dampsoft (dental, partner-gated integration only)**. The Handwerk/trades segment (the vertical explicitly named in the task's context — GaLaBau, SHK) has the **weakest public evidence base** of the three: no market-share data and no confirmed public API for the repeatedly-named vendors. This is a genuine research gap, not an assumption either way about whether these tools have APIs.

---

## 6. Failure evidence — public complaints

### Perspective.co
1. "Customers report having 599 visits to their funnel with 0 leads and the company refusing to honour refund guarantees made during sales sessions." — paraphrased complaint pattern from Capterra reviews. Source: WebSearch snippet summarizing Capterra reviews (https://www.capterra.com/p/191980/Perspective-Funnels/reviews/), retrieved 2026-08-10.
2. "Big promises are made about results, with some users feeling completely mis-sold their lead funnel product." — Source: same, retrieved 2026-08-10.
3. "The product does not work as it was sold to them and training and funnel examples do not work as expected." — Source: same, retrieved 2026-08-10.
4. "Disappointing onboarding process where credit card details are required, and cards are charged immediately when the trial ends without warning, with support not answering questions about this issue." — Source: same, retrieved 2026-08-10.
5. "Customization options limited and the pricing relatively high, with occasional reports of bugs and a desire for more direct integrations." — Source: WebSearch snippet aggregating multiple review sources, retrieved 2026-08-10.
6. Design-specific limitation complaints: "Button styling is very restricted, heading styles are limited, and borders and shadows on rows aren't available." — Source: WebSearch snippet, retrieved 2026-08-10.
7. Learning-curve complaint: "New users need 3-5 hours of training" to get comfortable with the builder. — Source: WebSearch snippet, retrieved 2026-08-10.
8. G2 direct review page could not be fetched (blank/CAPTCHA-blocked via both direct and proxied WebFetch) — **could not independently pull G2-specific quotes**, all quotes above trace to Capterra-derived WebSearch summaries, not a directly-fetched primary review page. Flagging this as a methodological limitation.
**Aggregate rating found**: "4.5/5 average across 60 reviews on G2 and Capterra" per a WebSearch snippet — **not independently verified by directly loading either platform's rating widget in this session.**

### Heyflow
Trustpilot **heyflow.app** profile (TrustScore 2.5/5, 11 reviews) — directly fetched via r.jina.ai proxy, retrieved 2026-08-10, https://www.trustpilot.com/review/heyflow.app:
1. (Jan 21, 2026) "Overpriced bs. Don't waste time."
2. (Jun 2, 2025) "You pay per impression (tiers are based on visitors count). Very quickly our cost jumped to over $500/month." — note: this describes a visitor-based metering model, which conflicts with the current heyflow.com pricing page's "responses"-based metering — possibly describes an older pricing scheme or a different plan; flagging the inconsistency rather than resolving it.
3. (Dec 29, 2024) "Absolutely terrible that we cannot edit emails in the PRO version. This is unacceptable."
4. (Apr 5, 2024) "After 1 year of use, the 1 yearly plan/monthly payment auto renewed... they refused" cancellation.
5. (Dec 1, 2023) "Their domain was detected as dangerous and blocked by Vodafone... basically wasting you money." — a technical/deliverability complaint (shared-domain reputation risk).
6. (Mar 11, 2023) "Even after cancellation you only get a customer winback message and they will charge you. Support only reachable within the week."

Trustpilot **heyflow.com** profile (17 reviews, mostly positive per WebSearch summary) — directly fetched via r.jina.ai proxy, retrieved 2026-08-10:
7. (May 27, 2026) "Service is shit, they take days to answer. For the price you'd expect better service..." — support-responsiveness complaint, consistent with the heyflow.app-profile pattern (#6 above) despite being a more recent, generally-positive profile.

Capterra summary (via WebSearch, retrieved 2026-08-10): "4.7 rating from 57 verified reviews... some users mention that while Heyflow is easy to use, it's rather expensive, especially if you have low EPL (earnings per lead) and collect low-quality leads." — i.e. the core complaint pattern is **price-to-lead-quality ratio**, recurring across both Trustpilot profiles and Capterra.

**Cross-vendor pattern in the complaints (both vendors):** (a) billing/cancellation friction — auto-renewal and post-cancellation charging complaints appear for BOTH Perspective and Heyflow; (b) support responsiveness — both vendors have direct quotes about slow/unhelpful support; (c) gap between marketed conversion-rate promises and delivered lead quality/volume — most pronounced in the Perspective complaints (explicit "0 leads" and "mis-sold" language) but echoed in Heyflow's "low-quality leads" framing. These three patterns (billing trust, support speed, promised-vs-actual lead performance) are the most concretely evidenced opportunity areas from this research, not a design recommendation — reporting only.

