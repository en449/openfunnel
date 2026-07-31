/**
 * @file Pre-packaged funnel templates.
 *
 * Each entry is a complete funnel document — the same JSON the builder saves and
 * the engine renders — so "use template" is a copy, never a translation step.
 *
 * They are modelled on the paid-traffic patterns that actually convert rather
 * than on feature demos: a landing page that sells the click, two to four
 * qualifying questions that feel like progress, a "warming" loader before the
 * ask, then the form. Most open with a `landing` step because that is what a
 * cold ad click needs before it is willing to answer anything.
 *
 * Conventions worth keeping when adding one:
 *   - `category` drives the filter pills — set it, or the template only ever
 *     shows under "All".
 *   - Use the field names the engine actually reads: `ctaLabel` (content),
 *     `submitLabel` (form/multiselect), `buttonLabel` + `redirectUrl` (success).
 *     A `buttonText` key is silently ignored and the button reads "Continue".
 *   - Prefer CSS gradients over hotlinked photography. A template that ships a
 *     third-party image URL shows a broken box the day that URL rots, and it
 *     hands the visitor's IP to a host the operator never chose.
 */

/* Shared hero gradients — kept here so a template is a page of copy, not CSS. */
const GRADIENT = {
  indigo: "linear-gradient(160deg, #4f46e5 0%, #1e1b4b 55%, #020617 100%)",
  emerald: "linear-gradient(160deg, #059669 0%, #064e3b 55%, #022c22 100%)",
  sunset: "linear-gradient(160deg, #f97316 0%, #be123c 60%, #4c0519 100%)",
  slate: "linear-gradient(160deg, #334155 0%, #0f172a 60%, #020617 100%)",
  violet: "linear-gradient(160deg, #7c3aed 0%, #4c1d95 55%, #1e1b4b 100%)",
  sky: "linear-gradient(160deg, #0ea5e9 0%, #075985 55%, #082f49 100%)",
  amber: "linear-gradient(160deg, #f59e0b 0%, #b45309 55%, #451a03 100%)",
  rose: "linear-gradient(160deg, #f43f5e 0%, #9f1239 55%, #4c0519 100%)",
};

export const FUNNEL_TEMPLATES = {
  /* ====================================================================== *
   *  Lead generation
   * ====================================================================== */

  "agency-lead": {
    id: "agency-lead",
    slug: "agency-lead",
    title: "Agency Lead Qualifier",
    description: "Landing page → 3 qualifying questions → audit request. The classic high-ticket agency funnel.",
    category: "lead-gen",
    theme: { preset: "midnight-glass" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Free growth audit",
        headline: "We find the leaks in your ad account. You keep the plan.",
        subtext: "Answer three questions and get a personalised breakdown of where your paid spend is going — no call required to receive it.",
        background: { gradient: GRADIENT.indigo, ink: "light" },
        cta: { label: "Start my free audit", note: "Takes 60 seconds · No credit card" },
        proof: { rating: 5, text: "Rated 4.9/5 by 200+ founders" },
        stickyCta: true,
        scrollHint: true,
        blocks: [
          {
            type: "stats",
            columns: 3,
            items: [
              { value: "200+", label: "Brands scaled" },
              { value: "4.8×", label: "Median ROAS" },
              { value: "$41M", label: "Ad spend managed" },
            ],
          },
          { type: "heading", eyebrow: "The problem", value: "Most accounts leak money in the same three places" },
          {
            type: "features",
            columns: 1,
            items: [
              { icon: "🎯", title: "Broad targeting, no exclusions", text: "You pay to reach people who already bought." },
              { icon: "🧊", title: "Cold traffic sent straight to a form", text: "No warming step, so the form does all the persuading — and fails." },
              { icon: "📉", title: "Optimising for clicks, not leads", text: "Cheap traffic that never converts still counts as a win in the dashboard." },
            ],
          },
          {
            type: "compare",
            left: { title: "Before", items: ["£90 cost per lead", "Sales team chasing tyre-kickers", "No idea which ad works"] },
            right: { title: "After", items: ["£23 cost per lead", "Pre-qualified by budget", "Attribution to the creative"] },
          },
          {
            type: "quote",
            rating: 5,
            text: "They found £6k a month we were burning on an audience that had already converted. Paid for itself before the first call.",
            name: "Marcus D.",
            role: "Founder, Northline Fitness",
          },
          {
            type: "faq",
            items: [
              { q: "Is this really free?", a: "Yes. We publish the audit whether or not you ever speak to us — it is how we prove we know what we are doing." },
              { q: "How long does the quiz take?", a: "About 60 seconds. Three multiple-choice questions and your email." },
              { q: "Will I get spammed?", a: "One email with your audit, and one follow-up. Unsubscribe in either." },
            ],
          },
          { type: "cta", label: "Get my free audit", note: "Three questions. Sixty seconds." },
        ],
      },
      {
        id: "revenue",
        type: "choice",
        headline: "What is your current monthly revenue?",
        subtext: "This decides which benchmarks we compare you against.",
        options: [
          { id: "rev_1", label: "Under $10,000/mo", icon: "🌱" },
          { id: "rev_2", label: "$10,000 – $50,000/mo", icon: "⚡" },
          { id: "rev_3", label: "$50,000 – $100,000/mo", icon: "🔥" },
          { id: "rev_4", label: "$100,000+/mo", icon: "👑", badge: "Priority" },
        ],
      },
      {
        id: "goal",
        type: "choice",
        headline: "What is your primary growth bottleneck?",
        options: [
          { id: "leads", label: "Not enough qualified leads", icon: "🎯" },
          { id: "sales", label: "Low lead-to-close rate", icon: "🤝" },
          { id: "ad_cost", label: "Ad costs are too high", icon: "💸" },
          { id: "scale", label: "Can't scale past a ceiling", icon: "📈" },
        ],
      },
      {
        id: "spend",
        type: "choice",
        headline: "What do you spend on ads each month?",
        layout: "grid",
        options: [
          { id: "s1", label: "Under $2k", icon: "🪙" },
          { id: "s2", label: "$2k – $10k", icon: "💵" },
          { id: "s3", label: "$10k – $50k", icon: "💰" },
          { id: "s4", label: "$50k+", icon: "🏦" },
        ],
      },
      {
        id: "analysing",
        type: "loader",
        headline: "Building your audit…",
        durationMs: 2600,
        items: ["Benchmarking your revenue band", "Modelling your cost per lead", "Finding the three biggest leaks"],
      },
      {
        id: "contact",
        type: "form",
        headline: "Your growth plan is ready, where should we send it?",
        subtext: "Delivered instantly. No call required to read it.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Work email", required: true },
          { name: "phone", type: "tel", label: "Phone (optional)" },
        ],
        submitLabel: "Send my free audit",
        consent: "We'll email your audit and occasional growth tips. Unsubscribe anytime.",
      },
      {
        id: "thankyou",
        type: "success",
        headline: "Audit on its way, {{name}} 🙌",
        subtext: "Check your inbox in the next two minutes. Want to walk through it live?",
        buttonLabel: "Book a 15-minute walkthrough",
      },
    ],
  },

  "lead-magnet": {
    id: "lead-magnet",
    slug: "lead-magnet",
    title: "Lead Magnet Opt-In",
    description: "Give away the guide, keep the email. The cheapest top-of-funnel play there is.",
    category: "lead-gen",
    theme: { preset: "clean-light" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "left",
        height: "tall",
        eyebrow: "Free 18-page guide",
        headline: "The 2026 Paid Social Playbook",
        subtext: "Every hook, budget split and creative test we run for clients paying five figures a month. Written down, no gatekeeping.",
        cta: { label: "Send me the playbook", note: "Instant download · No spam" },
        secondaryCta: { label: "See what's inside", variant: "ghost" },
        proof: { text: "Downloaded 12,480 times" },
        stickyCta: true,
        blocks: [
          { type: "heading", eyebrow: "Inside", value: "What you actually get" },
          {
            type: "list",
            items: [
              { text: "The 9 hooks that beat everything else we tested in 2025" },
              { text: "Our exact budget split across prospecting and retargeting" },
              { text: "A creative testing calendar you can copy into Notion" },
              { text: "The three metrics we kill a campaign on" },
            ],
          },
          {
            type: "quote",
            rating: 5,
            text: "I rebuilt our whole testing process from page 11. Cost per lead down 40% in six weeks.",
            name: "Priya N.",
            role: "Head of Growth, Loop",
          },
          { type: "cta", label: "Get the free playbook" },
        ],
      },
      {
        id: "role",
        type: "choice",
        headline: "What best describes you?",
        subtext: "So we send the version that's actually relevant.",
        options: [
          { id: "founder", label: "Founder / owner", icon: "🚀" },
          { id: "marketer", label: "In-house marketer", icon: "📊" },
          { id: "agency", label: "Agency or freelancer", icon: "🧩" },
          { id: "learning", label: "Just learning", icon: "📚" },
        ],
      },
      {
        id: "capture",
        type: "form",
        headline: "Where should we send it?",
        subtext: "Straight to your inbox, no landing page maze.",
        fields: [
          { name: "firstName", type: "text", label: "First name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
        ],
        submitLabel: "Send the playbook",
        consent: "You'll get the guide plus a weekly tactic. Unsubscribe in one click.",
      },
      {
        id: "done",
        type: "success",
        headline: "Sent, {{firstName}} 📬",
        subtext: "It's in your inbox now. Check promotions if you don't see it in two minutes.",
      },
    ],
  },

  "insurance-quote": {
    id: "insurance-quote",
    slug: "insurance-quote",
    title: "Insurance Quote Finder",
    description: "Comparison-style funnel: qualify on cover and age, then hand a warm lead to the broker.",
    category: "lead-gen",
    theme: { preset: "saas-gradient" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Compare in 60 seconds",
        headline: "Most households overpay by $480 a year",
        subtext: "Answer four questions and we'll show you what comparable cover actually costs in your postcode.",
        background: { gradient: GRADIENT.sky, ink: "light" },
        cta: { label: "Compare my cover", note: "Free · No obligation · No hard credit check" },
        proof: { rating: 5, text: "Trusted by 30,000+ households" },
        stickyCta: true,
        blocks: [
          {
            type: "stats",
            columns: 3,
            items: [
              { value: "$480", label: "Average annual saving" },
              { value: "60s", label: "To compare" },
              { value: "24", label: "Insurers checked" },
            ],
          },
          {
            type: "steps",
            items: [
              { title: "Tell us what you need covered", text: "Four multiple-choice questions." },
              { title: "We check 24 insurers", text: "Including the ones that don't advertise." },
              { title: "You get the quotes", text: "By email — talk to a human only if you want to." },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "Does this affect my credit score?", a: "No. Comparing cover is a soft search and leaves no mark." },
              { q: "Will I be cold-called?", a: "Only if you tick the box asking us to call. Otherwise it's email." },
            ],
          },
        ],
      },
      {
        id: "cover",
        type: "choice",
        headline: "What do you need cover for?",
        layout: "grid",
        options: [
          { id: "home", label: "Home", icon: "🏠" },
          { id: "auto", label: "Car", icon: "🚗" },
          { id: "life", label: "Life", icon: "❤️" },
          { id: "health", label: "Health", icon: "🩺" },
        ],
      },
      {
        id: "current",
        type: "choice",
        headline: "Are you insured right now?",
        options: [
          { id: "yes_renew", label: "Yes — renewal is coming up", icon: "📅", badge: "Best savings" },
          { id: "yes_locked", label: "Yes — mid-term", icon: "🔒" },
          { id: "no", label: "No cover at the moment", icon: "🆕" },
        ],
      },
      {
        id: "priority",
        type: "multiselect",
        headline: "What matters most to you?",
        subtext: "Pick as many as apply.",
        min: 1,
        options: [
          { id: "price", label: "Lowest price", icon: "💷" },
          { id: "excess", label: "Low excess", icon: "🛡️" },
          { id: "service", label: "Claims service", icon: "☎️" },
          { id: "flex", label: "Flexible cancellation", icon: "🔄" },
        ],
        submitLabel: "See my quotes",
      },
      {
        id: "searching",
        type: "loader",
        headline: "Checking 24 insurers…",
        durationMs: 2800,
        items: ["Matching your cover type", "Filtering by your priorities", "Ranking by total cost"],
      },
      {
        id: "capture",
        type: "form",
        headline: "Your quotes are ready",
        subtext: "Enter your details and we'll send the full comparison.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "postcode", type: "text", label: "Postcode", required: true },
        ],
        submitLabel: "Show my quotes",
        consent: "By continuing you agree we may share your details with matched insurers.",
      },
      {
        id: "done",
        type: "success",
        headline: "Comparison sent, {{name}} ✅",
        subtext: "Your quotes are in your inbox. They're held for 14 days.",
      },
    ],
  },

  "mortgage-preapproval": {
    id: "mortgage-preapproval",
    slug: "mortgage-preapproval",
    title: "Mortgage Pre-Approval",
    description: "Deposit and income qualification before a broker ever picks up the phone.",
    category: "lead-gen",
    theme: { preset: "warm-editorial" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "split",
        height: "tall",
        eyebrow: "No credit check to check",
        headline: "See what you can borrow before you fall in love with a house",
        subtext: "A soft, four-question check that tells you your realistic budget — and what's holding it back.",
        cta: { label: "Check my budget", note: "Soft search only · No impact on your score" },
        proof: { rating: 5, text: "4.9/5 from 2,100 buyers" },
        stickyCta: true,
        blocks: [
          {
            type: "features",
            columns: 2,
            items: [
              { icon: "🔍", title: "Soft search", text: "Leaves no mark on your file." },
              { icon: "⚡", title: "Instant range", text: "A number, not a brochure." },
              { icon: "🏦", title: "70+ lenders", text: "Including specialist ones." },
              { icon: "🧑‍💼", title: "Human on call", text: "Only when you ask for one." },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "Is this a formal decision in principle?", a: "No — it's an indicative range. A broker turns it into a formal DIP if you want one." },
              { q: "What if I'm self-employed?", a: "Say so in the questions and we'll route you to a specialist lender panel." },
            ],
          },
        ],
      },
      {
        id: "stage",
        type: "choice",
        headline: "Where are you in the process?",
        options: [
          { id: "browsing", label: "Just curious about my budget", icon: "👀" },
          { id: "viewing", label: "Actively viewing properties", icon: "🔑", badge: "Priority" },
          { id: "offer", label: "Offer accepted", icon: "🤝", badge: "Urgent" },
          { id: "remortgage", label: "Remortgaging", icon: "🔄" },
        ],
      },
      {
        id: "deposit",
        type: "choice",
        headline: "How much deposit do you have?",
        layout: "grid",
        options: [
          { id: "d5", label: "5%", icon: "🌱" },
          { id: "d10", label: "10%", icon: "⚡" },
          { id: "d15", label: "15–20%", icon: "🔥" },
          { id: "d25", label: "25%+", icon: "👑" },
        ],
      },
      {
        id: "employment",
        type: "choice",
        headline: "How are you paid?",
        options: [
          { id: "employed", label: "Employed (PAYE)", icon: "💼" },
          { id: "self", label: "Self-employed", icon: "🧾" },
          { id: "contract", label: "Contractor", icon: "📄" },
          { id: "mixed", label: "A mix of the above", icon: "🔀" },
        ],
      },
      {
        id: "calculating",
        type: "loader",
        headline: "Checking lender criteria…",
        durationMs: 2600,
        items: ["Matching your deposit band", "Filtering lenders by income type", "Calculating your range"],
      },
      {
        id: "capture",
        type: "form",
        headline: "Your borrowing range is ready",
        subtext: "We'll email it, plus the two things most likely to increase it.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "phone", type: "tel", label: "Mobile number", required: true },
        ],
        submitLabel: "Show my range",
        consent: "A qualified adviser may call to talk it through. No obligation.",
      },
      {
        id: "done",
        type: "success",
        headline: "On its way, {{name}} 🏡",
        subtext: "Your indicative range is in your inbox. An adviser will follow up within one working day.",
      },
    ],
  },

  "social-recruiting": {
    id: "social-recruiting",
    slug: "social-recruiting",
    title: "Social Recruiting Funnel",
    description: "Hire from paid social: sell the role first, screen on experience and notice period second.",
    category: "lead-gen",
    theme: { preset: "neo-brutalist" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "left",
        height: "tall",
        eyebrow: "Now hiring · Remote-first",
        headline: "Good engineers don't read job boards. So we stopped posting there.",
        subtext: "Four questions, ninety seconds, no CV. If it's a fit we'll call you this week.",
        cta: { label: "See if I'm a fit", note: "No CV needed to start" },
        proof: { text: "Average time to offer: 9 days" },
        stickyCta: true,
        blocks: [
          {
            type: "features",
            columns: 2,
            items: [
              { icon: "🏝️", title: "Fully remote", text: "Anywhere within ±3h of CET." },
              { icon: "💰", title: "Transparent bands", text: "Published before you apply." },
              { icon: "📆", title: "4-day weeks", text: "Every second week of the month." },
              { icon: "🧠", title: "Real ownership", text: "You ship to production week one." },
            ],
          },
          {
            type: "quote",
            text: "The whole process was four questions and two conversations. I had an offer in under two weeks.",
            name: "Jonas W.",
            role: "Joined as Senior Engineer",
          },
        ],
      },
      {
        id: "experience",
        type: "choice",
        headline: "How much experience do you have?",
        options: [
          { id: "exp_1", label: "0 – 1 year (junior)", icon: "🌱" },
          { id: "exp_2", label: "2 – 4 years (mid-level)", icon: "⚡" },
          { id: "exp_3", label: "5+ years (senior / lead)", icon: "🔥", badge: "Hiring now" },
        ],
      },
      {
        id: "availability",
        type: "choice",
        headline: "When could you start?",
        options: [
          { id: "imm", label: "Immediately", icon: "⚡", badge: "Fast track" },
          { id: "notice", label: "Within 2 – 4 weeks", icon: "📅" },
          { id: "flexible", label: "Flexible / exploring", icon: "🔍" },
        ],
      },
      {
        id: "evaluating",
        type: "loader",
        headline: "Matching you to open roles…",
        durationMs: 2400,
        items: ["Checking seniority bands", "Matching your notice period", "Reserving an interview slot"],
      },
      {
        id: "contact",
        type: "form",
        headline: "You're a match — let's talk",
        subtext: "No CV needed yet. We'll set up a 20-minute call.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "phone", type: "tel", label: "Phone number", required: true },
        ],
        submitLabel: "Reserve my interview slot",
      },
      {
        id: "done",
        type: "success",
        headline: "Application in, {{name}} 🙌",
        subtext: "Our hiring manager reviews these daily. Expect a text within 24 hours.",
      },
    ],
  },

  "newsletter-growth": {
    id: "newsletter-growth",
    slug: "newsletter-growth",
    title: "Newsletter Subscribe",
    description: "Minimal one-question opt-in. The fastest funnel in the library, built for cheap traffic.",
    category: "lead-gen",
    theme: { preset: "clean-light" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "minimal",
        height: "full",
        eyebrow: "Every Tuesday · 4-minute read",
        headline: "One tactic a week. Nothing else.",
        subtext: "No news round-ups, no sponsor filler. One thing that worked, and exactly how to copy it.",
        cta: { label: "Subscribe free", icon: "✉️" },
        proof: { rating: 5, text: "24,000 marketers read it" },
        blocks: [
          {
            type: "quote",
            text: "The only newsletter I open the minute it lands.",
            name: "Dana K.",
            role: "CMO, Fieldwork",
          },
          {
            type: "faq",
            items: [
              { q: "How often?", a: "Once a week, Tuesday morning. Never more." },
              { q: "Can I leave?", a: "One click at the bottom of every issue." },
            ],
          },
        ],
      },
      {
        id: "interest",
        type: "choice",
        headline: "What should we send you most of?",
        layout: "grid",
        options: [
          { id: "ads", label: "Paid ads", icon: "📣" },
          { id: "seo", label: "SEO", icon: "🔎" },
          { id: "email", label: "Email", icon: "✉️" },
          { id: "all", label: "All of it", icon: "🎁" },
        ],
      },
      {
        id: "capture",
        type: "form",
        headline: "Where do we send it?",
        fields: [{ name: "email", type: "email", label: "Email address", required: true }],
        submitLabel: "Subscribe",
        consent: "One email a week. Unsubscribe in one click.",
      },
      {
        id: "done",
        type: "success",
        headline: "You're in 🎉",
        subtext: "First issue lands next Tuesday. Reply to it any time — a human reads them.",
      },
    ],
  },

  /* ====================================================================== *
   *  Booking & high-ticket sales
   * ====================================================================== */

  "high-ticket-call": {
    id: "high-ticket-call",
    slug: "high-ticket-call",
    title: "High-Ticket Application Call",
    description: "VSL landing → budget and readiness screening → calendar. Filters out tyre-kickers before they book.",
    category: "booking",
    theme: { preset: "midnight-glass" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "fullBleed",
        height: "full",
        eyebrow: "Applications open · 6 places this month",
        headline: "Add $50k a month without hiring a single salesperson",
        subtext: "Watch the 9-minute breakdown, then apply. We only take six clients a month and we turn most applications down.",
        background: { gradient: GRADIENT.slate, ink: "light" },
        media: { type: "video", src: "", poster: "" },
        cta: { label: "Apply for a strategy call", note: "Applications reviewed within 24 hours" },
        secondaryCta: { label: "Watch the breakdown first", variant: "outline" },
        stickyCta: true,
        blocks: [
          {
            type: "stats",
            columns: 3,
            items: [
              { value: "6", label: "Clients a month" },
              { value: "$50k", label: "Median added MRR" },
              { value: "94%", label: "Renew after 6 months" },
            ],
          },
          { type: "heading", eyebrow: "Who this is for", value: "This works if you already have a product people buy" },
          {
            type: "compare",
            left: { title: "Not a fit", items: ["Pre-revenue", "No sales process at all", "Looking for a done-for-you agency"] },
            right: { title: "A fit", items: ["$30k+/mo already", "A team who can deliver", "Willing to change the offer"] },
          },
          {
            type: "steps",
            items: [
              { title: "Apply", text: "Four questions. Two minutes." },
              { title: "We review", text: "Within 24 hours. Most are declined." },
              { title: "45-minute call", text: "You leave with the plan whether or not you buy." },
            ],
          },
          {
            type: "quote",
            rating: 5,
            text: "We rebuilt the offer on the call itself. Closed $128k in the following quarter off the same ad spend.",
            name: "Rachel O.",
            role: "Founder, Studio Nine",
          },
          { type: "cta", label: "Apply now", note: "Six places. First come, first reviewed." },
        ],
      },
      {
        id: "revenue",
        type: "choice",
        headline: "What's your current monthly revenue?",
        subtext: "Be honest — we decline more applications than we accept.",
        options: [
          { id: "pre", label: "Pre-revenue", icon: "🌱", next: "not_a_fit" },
          { id: "under30", label: "Under $30k/mo", icon: "📈", next: "not_a_fit" },
          { id: "30_100", label: "$30k – $100k/mo", icon: "🔥" },
          { id: "over100", label: "$100k+/mo", icon: "👑", badge: "Priority" },
        ],
      },
      {
        id: "budget",
        type: "choice",
        headline: "What can you invest to fix this?",
        subtext: "Our engagements start at $6,000. This question saves us both a call.",
        options: [
          { id: "under6", label: "Under $6,000", icon: "🪙", next: "not_a_fit" },
          { id: "6_15", label: "$6,000 – $15,000", icon: "💵" },
          { id: "over15", label: "$15,000+", icon: "💰", badge: "Fast track" },
        ],
      },
      {
        id: "timing",
        type: "choice",
        headline: "How soon do you want to start?",
        options: [
          { id: "now", label: "Immediately", icon: "⚡", badge: "Priority" },
          { id: "month", label: "Within a month", icon: "📅" },
          { id: "exploring", label: "Just exploring", icon: "🔍" },
        ],
      },
      {
        id: "reviewing",
        type: "loader",
        headline: "Reviewing your application…",
        durationMs: 3000,
        items: ["Checking revenue fit", "Checking capacity this month", "Reserving a call slot"],
      },
      {
        id: "book",
        type: "form",
        headline: "Approved — book your call",
        subtext: "Pick a slot on the next screen. Bring your ad account.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Work email", required: true },
          { name: "phone", type: "tel", label: "Mobile number", required: true },
          { name: "company", type: "text", label: "Company website" },
        ],
        submitLabel: "Book my strategy call",
        verifyEmail: true,
      },
      {
        id: "booked",
        type: "success",
        headline: "You're approved, {{name}} 🎯",
        subtext: "Pick your slot now — unclaimed slots are released after 24 hours.",
        buttonLabel: "Choose my time",
      },
      {
        id: "not_a_fit",
        type: "success",
        headline: "Not the right time — and that's fine",
        subtext: "Our programme needs an existing offer and a $6k+ budget to work. Take the free playbook instead and come back when you're there.",
        buttonLabel: "Get the free playbook",
      },
    ],
  },

  "coaching-application": {
    id: "coaching-application",
    slug: "coaching-application",
    title: "1:1 Coaching Application",
    description: "Sell the transformation on the page, then screen for commitment before the discovery call.",
    category: "coaching",
    theme: { preset: "violet-pulse" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Applications for Q3 are open",
        headline: "Stop rewriting your plan every Monday",
        subtext: "Twelve weeks, one coach, one plan you actually finish. Apply in ninety seconds.",
        background: { gradient: GRADIENT.violet, ink: "light" },
        cta: { label: "Apply for coaching", note: "Free 20-minute discovery call" },
        proof: { rating: 5, text: "300+ clients coached since 2019" },
        stickyCta: true,
        blocks: [
          {
            type: "steps",
            items: [
              { title: "Week 1–2 · Diagnose", text: "We find the one bottleneck, not the ten symptoms." },
              { title: "Week 3–8 · Build", text: "One change a week, tracked and reviewed." },
              { title: "Week 9–12 · Compound", text: "You keep the system after the coaching ends." },
            ],
          },
          {
            type: "pricing",
            plans: [
              {
                name: "Group",
                price: "$400",
                period: "/mo",
                features: ["Weekly group call", "Community access", "Workbook library"],
                ctaLabel: "Apply for group",
              },
              {
                name: "1:1",
                price: "$1,200",
                period: "/mo",
                badge: "Most results",
                highlight: true,
                features: ["Weekly private session", "Voice-note access", "Custom plan", "Quarterly review"],
                ctaLabel: "Apply for 1:1",
              },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "How long is the commitment?", a: "Twelve weeks. We don't do rolling monthly — it's the reason people don't finish." },
              { q: "What if it isn't working?", a: "Full refund at any point in the first four weeks." },
            ],
          },
        ],
      },
      {
        id: "focus",
        type: "choice",
        headline: "What do you want to change first?",
        options: [
          { id: "career", label: "Career direction", icon: "🧭" },
          { id: "business", label: "Grow my business", icon: "📈" },
          { id: "habits", label: "Habits and focus", icon: "🎯" },
          { id: "confidence", label: "Confidence and voice", icon: "🔊" },
        ],
      },
      {
        id: "tried",
        type: "multiselect",
        headline: "What have you already tried?",
        subtext: "No wrong answers — it tells us what not to repeat.",
        min: 1,
        options: [
          { id: "books", label: "Books and courses", icon: "📚" },
          { id: "coach", label: "Another coach", icon: "🧑‍🏫" },
          { id: "therapy", label: "Therapy", icon: "🛋️" },
          { id: "alone", label: "Figuring it out alone", icon: "🚶" },
        ],
        submitLabel: "Continue",
      },
      {
        id: "commitment",
        type: "choice",
        headline: "How much time can you give this each week?",
        options: [
          { id: "low", label: "Under 1 hour", icon: "⏳", next: "waitlist" },
          { id: "mid", label: "2 – 3 hours", icon: "⏰" },
          { id: "high", label: "4+ hours", icon: "🔥", badge: "Best results" },
        ],
      },
      {
        id: "matching",
        type: "loader",
        headline: "Matching you to a coach…",
        durationMs: 2600,
        items: ["Reading your focus area", "Checking coach availability", "Holding a discovery slot"],
      },
      {
        id: "apply",
        type: "form",
        headline: "Last step — how do we reach you?",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "phone", type: "tel", label: "Mobile number", required: true },
        ],
        submitLabel: "Book my discovery call",
      },
      {
        id: "done",
        type: "success",
        headline: "Application received, {{name}} ✨",
        subtext: "Your coach will email within one working day with two call times.",
        buttonLabel: "Add to calendar",
      },
      {
        id: "waitlist",
        type: "success",
        headline: "Let's wait until you have the time",
        subtext: "Coaching only works with two hours a week to spend on it. We'll put you on the list and check in next quarter.",
      },
    ],
  },

  "medspa-consult": {
    id: "medspa-consult",
    slug: "medspa-consult",
    title: "Med Spa Consultation",
    description: "Aesthetics and clinic funnel: treatment interest, timing, then a booked consult.",
    category: "local",
    theme: { preset: "warm-editorial" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "split",
        height: "tall",
        eyebrow: "New client offer · $99 consultation",
        headline: "Skin that looks like yours, on a good day. Every day.",
        subtext: "Book a consultation with a nurse practitioner and get a treatment plan you're not pressured into.",
        cta: { label: "Book my consultation", note: "$99, credited against your first treatment" },
        proof: { rating: 5, text: "620 five-star reviews" },
        stickyCta: true,
        blocks: [
          {
            type: "features",
            columns: 2,
            items: [
              { icon: "👩‍⚕️", title: "Nurse-led", text: "Every plan reviewed by an NP." },
              { icon: "🧾", title: "No pressure", text: "Written plan, no same-day upsell." },
              { icon: "💳", title: "Credited back", text: "Your $99 comes off treatment one." },
              { icon: "📍", title: "Two clinics", text: "Downtown and Southside." },
            ],
          },
          {
            type: "quote",
            rating: 5,
            text: "First place that told me I didn't need half of what I asked for. Been going two years.",
            name: "Amara T.",
          },
          {
            type: "faq",
            items: [
              { q: "Is the consultation really $99?", a: "Yes, and it comes off your first treatment, so it's effectively free if you proceed." },
              { q: "Will I be pressured to book?", a: "No. You leave with a written plan and no deposit taken." },
            ],
          },
        ],
      },
      {
        id: "interest",
        type: "multiselect",
        headline: "What are you interested in?",
        subtext: "Pick everything that applies.",
        min: 1,
        layout: "grid",
        options: [
          { id: "botox", label: "Wrinkle relaxers", icon: "💉" },
          { id: "filler", label: "Dermal filler", icon: "💧" },
          { id: "laser", label: "Laser & IPL", icon: "✨" },
          { id: "skin", label: "Skin health", icon: "🧴" },
          { id: "body", label: "Body contouring", icon: "🌀" },
          { id: "unsure", label: "Not sure yet", icon: "🤔" },
        ],
        submitLabel: "Continue",
      },
      {
        id: "first_time",
        type: "choice",
        headline: "Have you had treatment before?",
        options: [
          { id: "never", label: "First time", icon: "🌱" },
          { id: "some", label: "A few times", icon: "⚡" },
          { id: "regular", label: "I'm a regular", icon: "🔥", badge: "VIP pricing" },
        ],
      },
      {
        id: "timing",
        type: "choice",
        headline: "When would you like to come in?",
        options: [
          { id: "week", label: "This week", icon: "⚡", badge: "2 slots left" },
          { id: "fortnight", label: "In the next two weeks", icon: "📅" },
          { id: "month", label: "Sometime this month", icon: "🗓️" },
        ],
      },
      {
        id: "booking",
        type: "form",
        headline: "Reserve your consultation",
        subtext: "We'll text you two available times within the hour.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "phone", type: "tel", label: "Mobile number", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
        ],
        submitLabel: "Reserve my slot",
      },
      {
        id: "done",
        type: "success",
        headline: "Reserved, {{name}} 💫",
        subtext: "Watch for a text from us within the hour with your two options.",
      },
    ],
  },

  /* ====================================================================== *
   *  SaaS
   * ====================================================================== */

  "saas-demo": {
    id: "saas-demo",
    slug: "saas-demo",
    title: "SaaS Trial & Demo",
    description: "Product landing page → team size and use case → trial signup routed by segment.",
    category: "saas",
    theme: { preset: "saas-gradient" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "split",
        width: "wide",
        height: "tall",
        eyebrow: "Free 14-day trial",
        headline: "Your team's work, finally in one place",
        subtext: "Projects, docs and reviews without the four-tool tax. Set up in under ten minutes.",
        nav: { brand: "Loop", ctaLabel: "Start free" },
        cta: { label: "Start free trial", note: "No credit card · Cancel anytime" },
        secondaryCta: { label: "Book a demo instead", variant: "outline" },
        proof: { rating: 5, text: "4.8/5 on G2 · 9,000+ teams" },
        stickyCta: true,
        blocks: [
          { type: "trust", items: [{ label: "SOC 2 Type II" }, { label: "GDPR ready" }, { label: "99.98% uptime" }] },
          { type: "heading", eyebrow: "Why teams switch", value: "Four tools, one bill, zero context-switching" },
          {
            type: "features",
            columns: 3,
            items: [
              { icon: "📋", title: "Projects", text: "Boards, timelines and workload in one view." },
              { icon: "📄", title: "Docs", text: "Specs that link straight to the work." },
              { icon: "✅", title: "Reviews", text: "Approvals without the email thread." },
              { icon: "🔌", title: "200+ integrations", text: "Slack, GitHub, Figma, Linear." },
              { icon: "🔐", title: "SSO & SCIM", text: "On every paid plan, not just enterprise." },
              { icon: "📊", title: "Reporting", text: "Where the time actually went." },
            ],
          },
          {
            type: "pricing",
            plans: [
              { name: "Free", price: "$0", period: "/user", features: ["3 projects", "Unlimited docs"], ctaLabel: "Start free" },
              {
                name: "Team",
                price: "$12",
                period: "/user/mo",
                badge: "Popular",
                highlight: true,
                features: ["Unlimited projects", "SSO", "Reporting", "Priority support"],
                ctaLabel: "Start 14-day trial",
              },
              { name: "Enterprise", price: "Custom", features: ["SCIM", "Audit log", "Dedicated CSM"], ctaLabel: "Talk to sales" },
            ],
          },
          {
            type: "quote",
            rating: 5,
            text: "We cancelled three subscriptions the month we moved. Nobody has asked to go back.",
            name: "Tom R.",
            role: "VP Engineering, Vantage",
          },
          {
            type: "faq",
            items: [
              { q: "Do I need a card to trial?", a: "No. The trial ends by itself — we never auto-charge." },
              { q: "Can we migrate our data?", a: "Yes. Importers for Asana, Notion, Jira and Trello ship in the box." },
              { q: "What happens after 14 days?", a: "You drop to the Free plan. Nothing is deleted." },
            ],
          },
        ],
      },
      {
        id: "team_size",
        type: "choice",
        headline: "How many people are on your team?",
        subtext: "This picks your starting workspace template.",
        options: [
          { id: "solo", label: "Just me (solo)", icon: "👤" },
          { id: "small", label: "2 – 10 teammates", icon: "👥" },
          { id: "scale", label: "11 – 50 teammates", icon: "🏢" },
          { id: "enterprise", label: "50+ (enterprise)", icon: "🚀", badge: "Talk to sales", next: "enterprise_form" },
        ],
      },
      {
        id: "use_case",
        type: "choice",
        headline: "What will you use it for first?",
        layout: "grid",
        options: [
          { id: "product", label: "Product & eng", icon: "🛠️" },
          { id: "marketing", label: "Marketing", icon: "📣" },
          { id: "agency", label: "Client work", icon: "🧩" },
          { id: "ops", label: "Operations", icon: "⚙️" },
        ],
      },
      {
        id: "form_lead",
        type: "form",
        headline: "Claim your 14-day trial",
        subtext: "No credit card. Workspace ready in ten seconds.",
        fields: [
          { name: "email", type: "email", label: "Work email address", required: true },
          { name: "company", type: "text", label: "Company name" },
        ],
        submitLabel: "Launch my workspace",
        next: "complete",
      },
      {
        id: "enterprise_form",
        type: "form",
        headline: "Let's scope it properly",
        subtext: "Over 50 seats we'll set up a sandbox with your data in it.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Work email", required: true },
          { name: "company", type: "text", label: "Company", required: true },
          { name: "seats", type: "number", label: "Approximate seats" },
        ],
        submitLabel: "Request a sandbox",
        next: "complete",
      },
      {
        id: "complete",
        type: "success",
        headline: "Welcome aboard 🎉",
        subtext: "We've emailed your magic login link to {{email}}.",
        buttonLabel: "Open my workspace",
      },
    ],
  },

  "saas-roi-audit": {
    id: "saas-roi-audit",
    slug: "saas-roi-audit",
    title: "Free ROI Audit (B2B)",
    description: "Calculator-led funnel: show the number they're losing, then ask for the meeting.",
    category: "saas",
    theme: { preset: "emerald-glow" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Free · No sales call required",
        headline: "How much is manual invoicing costing you?",
        subtext: "Three questions and we'll show you the annual number. Most teams are surprised by it.",
        background: { gradient: GRADIENT.emerald, ink: "light" },
        cta: { label: "Calculate my number", note: "Takes under a minute" },
        proof: { text: "Used by 1,400 finance teams" },
        stickyCta: true,
        blocks: [
          {
            type: "stats",
            columns: 3,
            items: [
              { value: "11h", label: "Median hours lost / week" },
              { value: "$34k", label: "Median annual cost" },
              { value: "3 mo", label: "Median payback" },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "Do I have to talk to sales?", a: "No. The number appears on screen and lands in your inbox either way." },
              { q: "How accurate is it?", a: "It's a model, not an audit — but it uses your inputs, not industry averages." },
            ],
          },
        ],
      },
      {
        id: "team",
        type: "choice",
        headline: "How many people touch invoicing each month?",
        layout: "grid",
        options: [
          { id: "t1", label: "1 – 2", icon: "👤", value: "2" },
          { id: "t2", label: "3 – 5", icon: "👥", value: "4" },
          { id: "t3", label: "6 – 10", icon: "🏢", value: "8" },
          { id: "t4", label: "10+", icon: "🏭", value: "14" },
        ],
      },
      {
        id: "hours",
        type: "choice",
        headline: "Hours a week each, roughly?",
        options: [
          { id: "h1", label: "Under 3 hours", icon: "⏳", value: "2" },
          { id: "h2", label: "3 – 6 hours", icon: "⏰", value: "5" },
          { id: "h3", label: "6 – 12 hours", icon: "🕰️", value: "9" },
          { id: "h4", label: "More than 12", icon: "🔥", value: "15" },
        ],
      },
      {
        id: "result",
        type: "content",
        headline: "Here's what that costs you a year",
        subtext: "Based on your inputs at an average loaded rate of $45/hour.",
        blocks: [
          {
            type: "calculator",
            label: "Annual cost of manual invoicing",
            currency: "$",
            formula: "{{team}} * {{hours}} * 45 * 48",
          },
          { type: "divider", label: "and that's before errors" },
          {
            type: "list",
            items: [
              { text: "Late payments caused by manual chasing" },
              { text: "Rework from data entered twice" },
              { text: "Month-end close taking days, not hours" },
            ],
          },
        ],
        ctaLabel: "Send me the full breakdown →",
      },
      {
        id: "capture",
        type: "form",
        headline: "Where should we send the breakdown?",
        subtext: "A one-page PDF with your numbers and where they go.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "email", type: "email", label: "Work email", required: true },
          { name: "company", type: "text", label: "Company" },
        ],
        submitLabel: "Send my breakdown",
      },
      {
        id: "done",
        type: "success",
        headline: "Sent, {{name}} 📊",
        subtext: "Your one-pager is in your inbox. Want us to walk through it?",
        buttonLabel: "Book 20 minutes",
      },
    ],
  },

  /* ====================================================================== *
   *  E-commerce
   * ====================================================================== */

  "ecom-product-quiz": {
    id: "ecom-product-quiz",
    slug: "ecom-product-quiz",
    title: "Product Finder Quiz",
    description: "Skincare/supplement style: diagnose, recommend, capture the email with the result.",
    category: "ecommerce",
    theme: { preset: "sunset-coral" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "60-second skin quiz",
        headline: "Stop guessing which serum you need",
        subtext: "Four questions about your skin and we'll build a routine from the eleven products we actually make.",
        background: { gradient: GRADIENT.rose, ink: "light" },
        cta: { label: "Take the skin quiz", note: "Free · Get 15% off your routine" },
        proof: { rating: 5, text: "38,000 routines built" },
        stickyCta: true,
        blocks: [
          {
            type: "steps",
            items: [
              { title: "Answer four questions", text: "Skin type, concerns, sensitivity, routine length." },
              { title: "Get your routine", text: "Three to five products, in order, with why." },
              { title: "15% off if you want it", text: "No subscription trap." },
            ],
          },
          {
            type: "quote",
            rating: 5,
            text: "First routine that didn't wreck my skin barrier. The quiz told me to drop two things I was already using.",
            name: "Nadia S.",
          },
        ],
      },
      {
        id: "skin_type",
        type: "choice",
        headline: "How does your skin feel by mid-afternoon?",
        options: [
          { id: "oily", label: "Shiny all over", icon: "💧", value: "Oily" },
          { id: "dry", label: "Tight and flaky", icon: "🏜️", value: "Dry" },
          { id: "combo", label: "Oily T-zone, dry cheeks", icon: "🔀", value: "Combination" },
          { id: "normal", label: "About right", icon: "✨", value: "Normal" },
        ],
      },
      {
        id: "concerns",
        type: "multiselect",
        headline: "What would you fix first?",
        subtext: "Pick up to three.",
        min: 1,
        max: 3,
        layout: "grid",
        options: [
          { id: "acne", label: "Breakouts", icon: "🔴" },
          { id: "lines", label: "Fine lines", icon: "〰️" },
          { id: "tone", label: "Uneven tone", icon: "🎨" },
          { id: "pores", label: "Pores", icon: "🕳️" },
          { id: "dull", label: "Dullness", icon: "🌫️" },
          { id: "redness", label: "Redness", icon: "🌹" },
        ],
        submitLabel: "Continue",
      },
      {
        id: "sensitivity",
        type: "choice",
        headline: "How does your skin handle actives?",
        options: [
          { id: "tough", label: "Fine with anything", icon: "🛡️" },
          { id: "careful", label: "Needs easing in", icon: "🧭" },
          { id: "sensitive", label: "Reacts to most things", icon: "🌡️" },
        ],
      },
      {
        id: "effort",
        type: "choice",
        headline: "How many steps will you actually do?",
        subtext: "Be honest — a routine you skip does nothing.",
        options: [
          { id: "three", label: "Three, max", icon: "⚡" },
          { id: "five", label: "About five", icon: "⏱️" },
          { id: "full", label: "Give me the full ritual", icon: "🛁" },
        ],
      },
      {
        id: "building",
        type: "loader",
        headline: "Building your routine…",
        durationMs: 3000,
        items: ["Matching your skin type", "Removing conflicting actives", "Ordering by absorption"],
      },
      {
        id: "capture",
        type: "form",
        headline: "Your routine is ready",
        subtext: "We'll email it with your 15% code so you can think about it.",
        fields: [
          { name: "firstName", type: "text", label: "First name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
        ],
        submitLabel: "Show my routine",
        consent: "We'll email your routine and occasional skin tips. Unsubscribe anytime.",
      },
      {
        id: "done",
        type: "success",
        headline: "Built for {{skin_type}} skin, {{firstName}} ✨",
        subtext: "Your routine and 15% code are in your inbox — the code lasts 72 hours.",
        buttonLabel: "Shop my routine",
      },
    ],
  },

  "ecom-waitlist": {
    id: "ecom-waitlist",
    slug: "ecom-waitlist",
    title: "Product Launch Waitlist",
    description: "Scarcity-led pre-launch capture with a countdown and early-bird pricing.",
    category: "ecommerce",
    theme: { preset: "neo-brutalist" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "fullBleed",
        height: "full",
        eyebrow: "Launching 14 March",
        headline: "1,000 units. Then we stop.",
        subtext: "Join the list for first access and early-bird pricing. No, there won't be a restock this year.",
        background: { gradient: GRADIENT.amber, ink: "light" },
        cta: { label: "Join the waitlist", note: "First access · Early-bird price" },
        proof: { text: "4,812 people ahead of you" },
        stickyCta: true,
        blocks: [
          { type: "countdown", minutes: 1440, label: "Early-bird pricing ends in" },
          {
            type: "features",
            columns: 2,
            items: [
              { icon: "🥇", title: "First access", text: "24 hours before public launch." },
              { icon: "🏷️", title: "30% off", text: "Early-bird pricing, list only." },
              { icon: "📦", title: "Free shipping", text: "On the first drop." },
              { icon: "🔁", title: "Free returns", text: "60 days, no questions." },
            ],
          },
          {
            type: "gallery",
            layout: "scroll",
            items: [{ src: "", caption: "Front" }, { src: "", caption: "Detail" }, { src: "", caption: "In use" }],
          },
          { type: "cta", label: "Get on the list", note: "Leave any time, one click." },
        ],
      },
      {
        id: "variant",
        type: "choice",
        headline: "Which one are you after?",
        layout: "grid",
        options: [
          { id: "black", label: "Midnight", icon: "⚫" },
          { id: "sand", label: "Sand", icon: "🟤" },
          { id: "olive", label: "Olive", icon: "🟢" },
          { id: "undecided", label: "Not sure yet", icon: "🤷" },
        ],
      },
      {
        id: "capture",
        type: "form",
        headline: "You're nearly on the list",
        subtext: "We'll text the moment it drops — email is too slow for 1,000 units.",
        fields: [
          { name: "firstName", type: "text", label: "First name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "phone", type: "tel", label: "Mobile (for the drop alert)" },
        ],
        submitLabel: "Join the waitlist",
        consent: "We'll only message you about this launch.",
      },
      {
        id: "done",
        type: "success",
        headline: "You're on the list, {{firstName}} 🔥",
        subtext: "You'll get first access 24 hours early, with your 30% code attached.",
        buttonLabel: "Follow us for the countdown",
      },
    ],
  },

  /* ====================================================================== *
   *  Local services & home
   * ====================================================================== */

  "real-estate": {
    id: "real-estate",
    slug: "real-estate",
    title: "Home Valuation",
    description: "Instant valuation hook, intent split between buyers and sellers, then the appraisal booking.",
    category: "local",
    theme: { preset: "warm-editorial" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "left",
        height: "tall",
        eyebrow: "Free · No obligation",
        headline: "What's your home actually worth in this market?",
        subtext: "Not the portal estimate. A local valuation based on what's sold on your street in the last 90 days.",
        cta: { label: "Value my home", note: "Takes 60 seconds · No agent visit required" },
        proof: { rating: 5, text: "1,900 local valuations this year" },
        stickyCta: true,
        blocks: [
          {
            type: "compare",
            left: { title: "Portal estimates", items: ["National averages", "Ignores your street", "Months out of date"] },
            right: { title: "Our valuation", items: ["Last 90 days of local sales", "Adjusted for your property type", "Reviewed by a local agent"] },
          },
          {
            type: "quote",
            rating: 5,
            text: "The portal said £340k. They said £372k and it went for £378k.",
            name: "Helen & Marc",
            role: "Sold in Redland",
          },
          {
            type: "faq",
            items: [
              { q: "Do I have to sell?", a: "No. Most people who use this are just curious. We're fine with that." },
              { q: "Will someone visit?", a: "Only if you ask. The desktop valuation is free and needs no visit." },
            ],
          },
        ],
      },
      {
        id: "intent",
        type: "choice",
        headline: "What are you planning?",
        options: [
          { id: "sell", label: "Sell my current home", icon: "💰", badge: "Priority" },
          { id: "buy", label: "Buy a new home", icon: "🔑" },
          { id: "both", label: "Buy and sell together", icon: "🔄" },
          { id: "curious", label: "Just curious about the value", icon: "👀" },
        ],
      },
      {
        id: "property",
        type: "choice",
        headline: "What type of property is it?",
        layout: "grid",
        options: [
          { id: "house", label: "House", icon: "🏠" },
          { id: "flat", label: "Flat", icon: "🏢" },
          { id: "bungalow", label: "Bungalow", icon: "🏡" },
          { id: "other", label: "Something else", icon: "🏘️" },
        ],
      },
      {
        id: "timing",
        type: "choice",
        headline: "When would you move?",
        options: [
          { id: "asap", label: "As soon as possible", icon: "⚡", badge: "Hot" },
          { id: "6mo", label: "Within 6 months", icon: "📅" },
          { id: "year", label: "Within a year", icon: "🗓️" },
          { id: "noplan", label: "No firm plan", icon: "🤔" },
        ],
      },
      {
        id: "valuing",
        type: "loader",
        headline: "Pulling local sold prices…",
        durationMs: 2800,
        items: ["Finding comparable properties", "Adjusting for property type", "Checking the last 90 days"],
      },
      {
        id: "lead_info",
        type: "form",
        headline: "Your valuation is ready",
        subtext: "Tell us where to send it — we'll include the three comparable sales we used.",
        fields: [
          { name: "name", type: "text", label: "Your name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "address", type: "address", label: "Property address", required: true },
          { name: "phone", type: "tel", label: "Phone number" },
        ],
        submitLabel: "Send my valuation",
      },
      {
        id: "done",
        type: "success",
        headline: "On its way, {{name}} 🏡",
        subtext: "Your valuation and the comparables land in your inbox within minutes.",
        buttonLabel: "Book a free appraisal",
      },
    ],
  },

  "solar-calculator": {
    id: "solar-calculator",
    slug: "solar-calculator",
    title: "Solar Savings Estimator",
    description: "Bill-based calculator that shows a 25-year saving before asking for the address.",
    category: "local",
    theme: { preset: "emerald-glow" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Free savings estimate",
        headline: "Your roof is already earning. You're just not collecting.",
        subtext: "Three questions and we'll model your 25-year saving from your current electricity bill.",
        background: { gradient: GRADIENT.emerald, ink: "light" },
        cta: { label: "Estimate my savings", note: "No installer visit required" },
        proof: { rating: 5, text: "8,400 roofs assessed" },
        stickyCta: true,
        blocks: [
          {
            type: "stats",
            columns: 3,
            items: [
              { value: "$28k", label: "Median 25-year saving" },
              { value: "6.5 yr", label: "Median payback" },
              { value: "25 yr", label: "Panel warranty" },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "Do I need to know my roof size?", a: "No — we take it from satellite imagery once you give us the address." },
              { q: "Is this a hard sell?", a: "You get the estimate by email whether or not you book anything." },
            ],
          },
        ],
      },
      {
        id: "bill",
        type: "choice",
        headline: "What's your average monthly electricity bill?",
        options: [
          { id: "b1", label: "$100 – $200 / mo", icon: "💵", value: "150" },
          { id: "b2", label: "$200 – $400 / mo", icon: "💰", value: "300" },
          { id: "b3", label: "$400 – $600 / mo", icon: "🏦", value: "500" },
          { id: "b4", label: "$600+ / mo", icon: "⚡", value: "750" },
        ],
      },
      {
        id: "own",
        type: "choice",
        headline: "Do you own the property?",
        options: [
          { id: "own", label: "Yes, I own it", icon: "🔑" },
          { id: "rent", label: "I rent", icon: "📄", next: "not_eligible" },
          { id: "landlord", label: "I'm the landlord", icon: "🏘️" },
        ],
      },
      {
        id: "roof",
        type: "choice",
        headline: "Which way does most of your roof face?",
        layout: "grid",
        options: [
          { id: "s", label: "South", icon: "☀️", badge: "Best" },
          { id: "ew", label: "East / West", icon: "🌤️" },
          { id: "n", label: "North", icon: "🌥️" },
          { id: "unsure", label: "No idea", icon: "🤷" },
        ],
      },
      {
        id: "quote_display",
        type: "content",
        headline: "Your estimated 25-year saving",
        subtext: "Modelled from your bill at current tariffs, assuming 4% annual price growth.",
        blocks: [
          {
            type: "calculator",
            formula: "{{bill}} * 12 * 25 * 0.62",
            label: "Potential 25-year household saving",
            currency: "$",
          },
          {
            type: "list",
            items: [
              { text: "Based on offsetting roughly 62% of your current usage" },
              { text: "Excludes any government incentive you may qualify for" },
              { text: "A satellite roof check refines this to within 5%" },
            ],
          },
        ],
        ctaLabel: "Check my roof eligibility →",
      },
      {
        id: "form",
        type: "form",
        headline: "Where should we send the official quote?",
        subtext: "We'll run the satellite roof check and email the exact figure.",
        fields: [
          { name: "address", type: "address", label: "Home street address", required: true },
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "phone", type: "tel", label: "Phone number", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
        ],
        submitLabel: "Get my solar proposal",
      },
      {
        id: "complete",
        type: "success",
        headline: "Proposal requested ☀️",
        subtext: "Your satellite roof assessment is running. We'll text results to {{phone}}.",
      },
      {
        id: "not_eligible",
        type: "success",
        headline: "You'll need your landlord on board",
        subtext: "Panels need the property owner's sign-off. Forward this to them and we'll take it from there.",
      },
    ],
  },

  "home-improvement": {
    id: "home-improvement",
    slug: "home-improvement",
    title: "Home Improvement Quote",
    description: "Roofing, windows and renovation lead capture with job type, urgency and budget screening.",
    category: "local",
    theme: { preset: "clean-light" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "left",
        height: "tall",
        eyebrow: "Free quote · Fully insured",
        headline: "A fixed price before we start. Not a range, a price.",
        subtext: "Tell us the job and we'll send three references from your postcode with the quote.",
        cta: { label: "Get my fixed quote", note: "No deposit to quote" },
        proof: { rating: 5, text: "480 five-star reviews locally" },
        stickyCta: true,
        blocks: [
          {
            type: "features",
            columns: 2,
            items: [
              { icon: "📋", title: "Fixed price", text: "Written, itemised, no 'unforeseen extras'." },
              { icon: "🛡️", title: "Insured & vetted", text: "£5m public liability, DBS-checked crews." },
              { icon: "📍", title: "Local references", text: "Three from your postcode with every quote." },
              { icon: "🗓️", title: "Dated start", text: "A real date, not 'in a few weeks'." },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "Is the quote really free?", a: "Yes, and there's no deposit until you accept it." },
              { q: "How fast can you start?", a: "Most jobs start within three weeks. Emergencies sooner." },
            ],
          },
        ],
      },
      {
        id: "job",
        type: "choice",
        headline: "What needs doing?",
        layout: "grid",
        options: [
          { id: "roof", label: "Roofing", icon: "🏠" },
          { id: "windows", label: "Windows", icon: "🪟" },
          { id: "kitchen", label: "Kitchen", icon: "🍳" },
          { id: "bath", label: "Bathroom", icon: "🛁" },
          { id: "extension", label: "Extension", icon: "🧱" },
          { id: "other", label: "Something else", icon: "🔧" },
        ],
      },
      {
        id: "urgency",
        type: "choice",
        headline: "How soon do you need it done?",
        options: [
          { id: "emergency", label: "It's an emergency", icon: "🚨", badge: "Same-day callback" },
          { id: "month", label: "Within a month", icon: "⚡" },
          { id: "quarter", label: "Next few months", icon: "📅" },
          { id: "planning", label: "Just planning ahead", icon: "🗺️" },
        ],
      },
      {
        id: "budget",
        type: "choice",
        headline: "What budget are you working with?",
        subtext: "It tells us which materials to quote — no answer is too small.",
        layout: "grid",
        options: [
          { id: "b1", label: "Under £5k", icon: "🪙" },
          { id: "b2", label: "£5k – £15k", icon: "💵" },
          { id: "b3", label: "£15k – £40k", icon: "💰" },
          { id: "b4", label: "£40k+", icon: "🏦", badge: "Senior surveyor" },
        ],
      },
      {
        id: "capture",
        type: "form",
        headline: "Where should we send the quote?",
        subtext: "We'll include three local references with it.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "phone", type: "tel", label: "Phone number", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "address", type: "address", label: "Job address", required: true },
        ],
        submitLabel: "Send my fixed quote",
      },
      {
        id: "done",
        type: "success",
        headline: "Quote request received, {{name}} 🔧",
        subtext: "A surveyor will call within one working day to confirm the details.",
      },
    ],
  },

  "auto-tradein": {
    id: "auto-tradein",
    slug: "auto-tradein",
    title: "Car Trade-In Valuation",
    description: "Dealership funnel: value the trade-in first, capture the buyer while the number is on screen.",
    category: "local",
    theme: { preset: "midnight-glass" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Guaranteed for 7 days",
        headline: "We'll beat your online valuation or pay you the difference",
        subtext: "Four questions, a real number, and it's locked for a week. No haggling on the forecourt.",
        background: { gradient: GRADIENT.slate, ink: "light" },
        cta: { label: "Value my car", note: "Free · Takes 90 seconds" },
        proof: { rating: 5, text: "12,000 cars bought last year" },
        stickyCta: true,
        blocks: [
          {
            type: "steps",
            items: [
              { title: "Tell us the car", text: "Make, age, mileage, condition." },
              { title: "Get the number", text: "Locked for seven days." },
              { title: "Bring it in", text: "Or we collect, free, within 30 miles." },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "Is the price guaranteed?", a: "For seven days, subject to the car matching what you told us." },
              { q: "Do I have to buy from you?", a: "No. We buy cars outright too." },
            ],
          },
        ],
      },
      {
        id: "age",
        type: "choice",
        headline: "How old is the car?",
        layout: "grid",
        options: [
          { id: "a1", label: "Under 3 years", icon: "✨", badge: "Best price" },
          { id: "a2", label: "3 – 6 years", icon: "🚗" },
          { id: "a3", label: "7 – 10 years", icon: "🛻" },
          { id: "a4", label: "Over 10 years", icon: "🚙" },
        ],
      },
      {
        id: "mileage",
        type: "choice",
        headline: "Roughly how many miles?",
        layout: "grid",
        options: [
          { id: "m1", label: "Under 30k", icon: "🟢" },
          { id: "m2", label: "30k – 70k", icon: "🟡" },
          { id: "m3", label: "70k – 120k", icon: "🟠" },
          { id: "m4", label: "120k+", icon: "🔴" },
        ],
      },
      {
        id: "condition",
        type: "choice",
        headline: "Honest condition?",
        options: [
          { id: "c1", label: "Excellent — no marks", icon: "💎" },
          { id: "c2", label: "Good — a few scuffs", icon: "👍" },
          { id: "c3", label: "Fair — needs work", icon: "🔧" },
          { id: "c4", label: "Not driveable", icon: "🚧" },
        ],
      },
      {
        id: "next_car",
        type: "choice",
        headline: "What are you moving to?",
        options: [
          { id: "buy_from_us", label: "Buying from you", icon: "🔑", badge: "Extra £500" },
          { id: "elsewhere", label: "Buying elsewhere", icon: "🏬" },
          { id: "selling", label: "Just selling", icon: "💷" },
        ],
      },
      {
        id: "valuing",
        type: "loader",
        headline: "Checking auction data…",
        durationMs: 2600,
        items: ["Matching your age and mileage band", "Checking this week's auction prices", "Applying your condition"],
      },
      {
        id: "capture",
        type: "form",
        headline: "Your valuation is ready",
        subtext: "We'll text it now and hold it for seven days.",
        fields: [
          { name: "name", type: "text", label: "Full name", required: true },
          { name: "phone", type: "tel", label: "Mobile number", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "reg", type: "text", label: "Registration", required: true },
        ],
        submitLabel: "Show my valuation",
      },
      {
        id: "done",
        type: "success",
        headline: "Valuation sent, {{name}} 🚗",
        subtext: "It's locked for seven days. Reply to the text to book a collection.",
        buttonLabel: "Book a collection",
      },
    ],
  },

  /* ====================================================================== *
   *  Webinar & events
   * ====================================================================== */

  "webinar-registration": {
    id: "webinar-registration",
    slug: "webinar-registration",
    title: "Webinar Registration",
    description: "Live masterclass signup with scarcity, agenda and a show-up-rate reminder capture.",
    category: "webinar",
    theme: { preset: "violet-pulse" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "centered",
        height: "tall",
        eyebrow: "Live · Thursday 2pm ET · 500 seats",
        headline: "The 3-email sequence that pays for our ad spend",
        subtext: "Forty-five minutes, live, with the actual copy on screen. Replay only goes to people who show up.",
        background: { gradient: GRADIENT.violet, ink: "light" },
        cta: { label: "Save my seat", note: "Free · Replay for attendees only" },
        proof: { text: "312 of 500 seats taken" },
        stickyCta: true,
        blocks: [
          { type: "countdown", minutes: 2880, label: "Registration closes in" },
          { type: "heading", eyebrow: "Agenda", value: "What we'll cover, in order" },
          {
            type: "steps",
            items: [
              { title: "The welcome that doesn't get ignored", text: "Why the first email should not sell." },
              { title: "The proof email", text: "The exact structure, on screen, that you can copy." },
              { title: "The offer email", text: "And the two lines that do most of the work." },
            ],
          },
          {
            type: "quote",
            rating: 5,
            text: "I rewrote our welcome sequence during the session. Revenue per subscriber went up 31% that month.",
            name: "Chris L.",
            role: "Ecom Director",
          },
          {
            type: "faq",
            items: [
              { q: "Will there be a replay?", a: "Only for people who attend live. It's how we keep the room full." },
              { q: "Is this a pitch?", a: "There's an offer at the end. The first 40 minutes are the content either way." },
            ],
          },
          { type: "cta", label: "Save my seat", note: "500 seats. 312 gone." },
        ],
      },
      {
        id: "role",
        type: "choice",
        headline: "What's your role?",
        subtext: "We tailor the examples to the room.",
        options: [
          { id: "ecom", label: "E-commerce", icon: "🛒" },
          { id: "saas", label: "SaaS", icon: "💻" },
          { id: "agency", label: "Agency", icon: "🧩" },
          { id: "creator", label: "Creator / coach", icon: "🎙️" },
        ],
      },
      {
        id: "list_size",
        type: "choice",
        headline: "How big is your email list?",
        layout: "grid",
        options: [
          { id: "l1", label: "Under 1k", icon: "🌱" },
          { id: "l2", label: "1k – 10k", icon: "⚡" },
          { id: "l3", label: "10k – 50k", icon: "🔥" },
          { id: "l4", label: "50k+", icon: "👑" },
        ],
      },
      {
        id: "register",
        type: "form",
        headline: "Save your seat",
        subtext: "We'll send the link plus two reminders — that's it.",
        fields: [
          { name: "firstName", type: "text", label: "First name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
          { name: "phone", type: "tel", label: "Mobile for the 10-minute reminder (optional)" },
        ],
        submitLabel: "Save my seat",
        consent: "We'll email the link and two reminders. Unsubscribe anytime.",
      },
      {
        id: "done",
        type: "success",
        headline: "Seat saved, {{firstName}} 🎟️",
        subtext: "Check your inbox for the calendar invite — add it now or you'll forget.",
        buttonLabel: "Add to my calendar",
      },
    ],
  },

  /* ====================================================================== *
   *  Fitness & health
   * ====================================================================== */

  "fitness-challenge": {
    id: "fitness-challenge",
    slug: "fitness-challenge",
    title: "6-Week Body Challenge",
    description: "Transformation offer: goal, experience and obstacle screening before the plan and the sale.",
    category: "coaching",
    theme: { preset: "sunset-coral" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "fullBleed",
        height: "full",
        eyebrow: "Next cohort starts Monday",
        headline: "Six weeks. Three sessions a week. No 5am nonsense.",
        subtext: "A plan built around the time you actually have, coached by a human who checks in every week.",
        background: { gradient: GRADIENT.sunset, ink: "light" },
        cta: { label: "Find my plan", note: "Free 90-second assessment" },
        proof: { rating: 5, text: "2,400 people finished the last cohort" },
        stickyCta: true,
        blocks: [
          {
            type: "stats",
            columns: 3,
            items: [
              { value: "6 wk", label: "Programme length" },
              { value: "3×", label: "Sessions a week" },
              { value: "88%", label: "Finish rate" },
            ],
          },
          {
            type: "compare",
            left: { title: "Most programmes", items: ["Generic PDF", "Six days a week", "No accountability", "You quit in week 2"] },
            right: { title: "This one", items: ["Built from your assessment", "Three days a week", "Weekly coach check-in", "88% finish"] },
          },
          {
            type: "quote",
            rating: 5,
            text: "First programme I've ever finished. The weekly check-in is the whole reason.",
            name: "Sam B.",
            role: "Lost 11kg in cohort 14",
          },
          {
            type: "faq",
            items: [
              { q: "Do I need a gym?", a: "No. There's a home-equipment track with the same structure." },
              { q: "What if I miss a week?", a: "The plan reflows. Missing a week is expected, not a failure." },
            ],
          },
          { type: "cta", label: "Take the free assessment" },
        ],
      },
      {
        id: "goal",
        type: "choice",
        headline: "What's the goal?",
        options: [
          { id: "fat", label: "Lose fat", icon: "🔥" },
          { id: "muscle", label: "Build muscle", icon: "💪" },
          { id: "both", label: "Both — recomposition", icon: "⚖️" },
          { id: "health", label: "Feel healthier generally", icon: "🌿" },
        ],
      },
      {
        id: "level",
        type: "choice",
        headline: "How would you describe your fitness now?",
        options: [
          { id: "beginner", label: "Starting from scratch", icon: "🌱" },
          { id: "returning", label: "Coming back after a break", icon: "🔄" },
          { id: "regular", label: "Training regularly already", icon: "🏋️" },
        ],
      },
      {
        id: "obstacle",
        type: "multiselect",
        headline: "What's got in the way before?",
        subtext: "Pick everything that's true. This is the part that decides your plan.",
        min: 1,
        options: [
          { id: "time", label: "No time", icon: "⏰" },
          { id: "motivation", label: "Motivation drops off", icon: "📉" },
          { id: "injury", label: "Injuries or pain", icon: "🩹" },
          { id: "food", label: "Food is the hard part", icon: "🍕" },
          { id: "gym", label: "Gym anxiety", icon: "😰" },
        ],
        submitLabel: "Build my plan",
      },
      {
        id: "days",
        type: "choice",
        headline: "Realistically, how many days a week?",
        layout: "grid",
        options: [
          { id: "d2", label: "2 days", icon: "🗓️" },
          { id: "d3", label: "3 days", icon: "✅", badge: "Recommended" },
          { id: "d4", label: "4 days", icon: "🔥" },
          { id: "d5", label: "5+ days", icon: "🚀" },
        ],
      },
      {
        id: "building",
        type: "loader",
        headline: "Building your 6-week plan…",
        durationMs: 3200,
        items: ["Matching your goal and level", "Working around your obstacles", "Scheduling around your days"],
      },
      {
        id: "capture",
        type: "form",
        headline: "Your plan is ready",
        subtext: "We'll email it now — free, whether or not you join the cohort.",
        fields: [
          { name: "firstName", type: "text", label: "First name", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
        ],
        submitLabel: "Send my plan",
        consent: "You'll get your plan plus cohort details. Unsubscribe anytime.",
      },
      {
        id: "done",
        type: "success",
        headline: "Plan sent, {{firstName}} 💪",
        subtext: "It's in your inbox. The next cohort starts Monday — doors close Sunday night.",
        buttonLabel: "Join the cohort",
      },
    ],
  },

  "fitness-gym-trial": {
    id: "fitness-gym-trial",
    slug: "fitness-gym-trial",
    title: "Gym 7-Day Trial",
    description: "Local gym membership funnel — goal and schedule first, then a trial pass booking.",
    category: "local",
    theme: { preset: "neo-brutalist" },
    steps: [
      {
        id: "landing",
        type: "landing",
        layout: "left",
        height: "tall",
        eyebrow: "7-day trial · No card required",
        headline: "Try the whole gym for a week before you pay anything",
        subtext: "Classes, weights, sauna, the lot. If it's not for you, walk away — we don't take a card to start.",
        cta: { label: "Claim my 7-day pass", note: "No card · No contract to trial" },
        proof: { rating: 5, text: "4.9/5 from 1,100 members" },
        stickyCta: true,
        blocks: [
          {
            type: "features",
            columns: 2,
            items: [
              { icon: "🏋️", title: "Full access", text: "Every class, every machine, all week." },
              { icon: "🧖", title: "Sauna & recovery", text: "Included, not an add-on." },
              { icon: "🕕", title: "5am – 11pm", text: "Seven days a week." },
              { icon: "🚫", title: "No contract", text: "Rolling monthly after the trial." },
            ],
          },
          {
            type: "faq",
            items: [
              { q: "Do I need a card?", a: "No. The trial takes your name and a phone number, nothing else." },
              { q: "What happens after 7 days?", a: "Nothing automatic. You choose whether to join." },
            ],
          },
        ],
      },
      {
        id: "goal",
        type: "choice",
        headline: "What brings you in?",
        layout: "grid",
        options: [
          { id: "strength", label: "Get stronger", icon: "💪" },
          { id: "weight", label: "Lose weight", icon: "🔥" },
          { id: "classes", label: "Classes", icon: "🤸" },
          { id: "social", label: "Somewhere to go", icon: "🫂" },
        ],
      },
      {
        id: "when",
        type: "choice",
        headline: "When would you train?",
        options: [
          { id: "early", label: "Before work", icon: "🌅" },
          { id: "lunch", label: "Lunchtime", icon: "🥗" },
          { id: "evening", label: "After work", icon: "🌆" },
          { id: "weekend", label: "Weekends", icon: "🗓️" },
        ],
      },
      {
        id: "capture",
        type: "form",
        headline: "Claim your 7-day pass",
        subtext: "Show the text at reception — that's the whole process.",
        fields: [
          { name: "firstName", type: "text", label: "First name", required: true },
          { name: "phone", type: "tel", label: "Mobile number", required: true },
          { name: "email", type: "email", label: "Email address", required: true },
        ],
        submitLabel: "Send my pass",
      },
      {
        id: "done",
        type: "success",
        headline: "Pass sent, {{firstName}} 🎟️",
        subtext: "Check your texts. Show it at reception any time this week.",
      },
    ],
  },
};
