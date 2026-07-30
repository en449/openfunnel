/**
 * Pre-packaged funnel templates for open-source users.
 * Replicates high-converting SaaS perspectives (Lead-Gen, SaaS Demo, Real Estate, Fitness).
 */
export const FUNNEL_TEMPLATES = {
  "agency-lead": {
    id: "agency-lead",
    slug: "agency-lead",
    title: "Agency Lead Qualifier",
    description: "High-converting quiz funnel to qualify high-ticket agency clients.",
    theme: { preset: "midnight-glass" },
    steps: [
      {
        id: "intro",
        type: "content",
        headline: "Scale Your Business With Paid Media 🚀",
        subtext: "Answer 3 quick questions to see if your business qualifies for our growth program.",
        blocks: [
          { type: "trust", items: ["Trusted by 200+ Brands", "5x Avg ROI", "100% Guaranteed"] }
        ],
        buttonText: "Start Assessment →"
      },
      {
        id: "revenue",
        type: "choice",
        headline: "What is your current monthly revenue?",
        options: [
          { id: "rev_1", label: "Under $10,000/mo", icon: "🌱" },
          { id: "rev_2", label: "$10,000 - $50,000/mo", icon: "⚡" },
          { id: "rev_3", label: "$50,000 - $100,000/mo", icon: "🔥" },
          { id: "rev_4", label: "$100,000+/mo", icon: "👑" }
        ]
      },
      {
        id: "goal",
        type: "choice",
        headline: "What is your primary growth bottleneck?",
        options: [
          { id: "leads", label: "Not enough qualified leads", icon: "🎯" },
          { id: "sales", label: "Low lead-to-close rate", icon: "🤝" },
          { id: "ad_cost", label: "Ad costs are too high", icon: "💸" }
        ]
      },
      {
        id: "contact",
        type: "form",
        headline: "Your Custom Growth Plan is Ready! 🎉",
        subtext: "Where should we send your personalized audit?",
        fields: [
          { name: "name", type: "text", label: "Full Name", required: true },
          { name: "email", type: "email", label: "Work Email", required: true },
          { name: "phone", type: "tel", label: "Phone Number", required: true }
        ],
        buttonText: "Get Free Growth Audit"
      },
      {
        id: "thankyou",
        type: "success",
        headline: "Application Received, {{name}}! 🙌",
        subtext: "Our strategist will review your answers and reach out within 2 hours."
      }
    ]
  },
  "saas-demo": {
    id: "saas-demo",
    slug: "saas-demo",
    title: "SaaS Product Demo Quiz",
    description: "Interactive demo request & feature recommendation funnel.",
    theme: { preset: "saas-gradient" },
    steps: [
      {
        id: "welcome",
        type: "content",
        headline: "Supercharge Your Workflow in 60 Seconds ⚡",
        subtext: "Find out which platform tier fits your team size & requirements.",
        buttonText: "Get Recommended Setup →"
      },
      {
        id: "team_size",
        type: "choice",
        headline: "How many people are on your team?",
        options: [
          { id: "solo", label: "Just me (Solo)", icon: "👤" },
          { id: "small", label: "2 - 10 teammates", icon: "👥" },
          { id: "scale", label: "11 - 50 teammates", icon: "🏢" },
          { id: "enterprise", label: "50+ Enterprise", icon: "🚀" }
        ]
      },
      {
        id: "form_lead",
        type: "form",
        headline: "Claim Your 14-Day Free Access",
        subtext: "No credit card required. Instant account setup.",
        fields: [
          { name: "email", type: "email", label: "Work Email Address", required: true },
          { name: "company", type: "text", label: "Company Name", required: false }
        ],
        buttonText: "Launch Free Workspace"
      },
      {
        id: "complete",
        type: "success",
        headline: "Welcome aboard! 🎉",
        subtext: "We have emailed your magic login link to {{email}}."
      }
    ]
  },
  "real-estate": {
    id: "real-estate",
    slug: "real-estate",
    title: "Real Estate Property Matcher",
    description: "Home valuation and buying preference quiz.",
    theme: { preset: "warm-editorial" },
    steps: [
      {
        id: "start",
        type: "content",
        headline: "Find Your Dream Home Valuation 🏡",
        subtext: "Get an instant neighborhood market report tailored to your zip code.",
        buttonText: "Calculate Home Value →"
      },
      {
        id: "intent",
        type: "choice",
        headline: "What are you looking to do?",
        options: [
          { id: "buy", label: "Buy a new home", icon: "🔑" },
          { id: "sell", label: "Sell my current home", icon: "💰" },
          { id: "both", label: "Buy & Sell simultaneously", icon: "🔄" }
        ]
      },
      {
        id: "lead_info",
        type: "form",
        headline: "Send Me The Market Valuation",
        fields: [
          { name: "name", type: "text", label: "Your Name", required: true },
          { name: "email", type: "email", label: "Email Address", required: true },
          { name: "zipcode", type: "text", label: "Zip Code", required: true }
        ],
        buttonText: "View Neighborhood Report"
      },
      {
        id: "done",
        type: "success",
        headline: "Valuation Ready, {{name}}! 📈",
        subtext: "Your localized real estate report has been generated."
      }
    ]
  },
  "social-recruiting": {
    id: "social-recruiting",
    slug: "social-recruiting",
    title: "Social Recruiting Application",
    description: "Mobile-first applicant funnel replacing traditional resume/CV uploads.",
    theme: { preset: "violet-pulse" },
    steps: [
      {
        id: "intro",
        type: "content",
        headline: "Join Our Fast-Growing Team 🚀",
        subtext: "Apply in 60 seconds without updating your resume or CV.",
        buttonText: "Start 60-Second Application →"
      },
      {
        id: "experience",
        type: "choice",
        headline: "How many years of relevant experience do you have?",
        options: [
          { id: "exp_1", label: "0 - 1 year (Junior)", icon: "🌱" },
          { id: "exp_2", label: "2 - 4 years (Mid-Level)", icon: "⚡" },
          { id: "exp_3", label: "5+ years (Senior / Lead)", icon: "🔥" }
        ]
      },
      {
        id: "availability",
        type: "choice",
        headline: "When could you start?",
        options: [
          { id: "imm", label: "Immediately", icon: "⚡" },
          { id: "notice", label: "Within 2 - 4 weeks", icon: "📅" },
          { id: "flexible", label: "Flexible / Exploring", icon: "🔍" }
        ]
      },
      {
        id: "evaluating",
        type: "loader",
        headline: "Matching your profile...",
        subtext: "Please wait while we evaluate your qualifications",
        items: ["Analyzing experience level...", "Checking team capacity...", "Application match confirmed!"]
      },
      {
        id: "contact",
        type: "form",
        headline: "Great news! You qualify for an interview 🎉",
        subtext: "Enter your contact details so our talent partner can reach out.",
        fields: [
          { name: "name", type: "text", label: "Full Name", required: true },
          { name: "email", type: "email", label: "Email Address", required: true },
          { name: "phone", type: "tel", label: "Phone Number", required: true }
        ],
        buttonText: "Submit Application"
      },
      {
        id: "done",
        type: "success",
        headline: "Application Submitted, {{name}}! 🙌",
        subtext: "Our hiring manager will review your answers and text you shortly."
      }
    ]
  },
  "solar-calculator": {
    id: "solar-calculator",
    slug: "solar-calculator",
    title: "Solar & Home Savings Estimator",
    description: "Interactive home savings & quote calculation funnel.",
    theme: { preset: "emerald-glow" },
    steps: [
      {
        id: "welcome",
        type: "content",
        headline: "Calculate Your Monthly Solar Savings ☀️",
        subtext: "See how much you can save on electricity in 3 simple steps.",
        buttonText: "Estimate Savings →"
      },
      {
        id: "bill",
        type: "choice",
        headline: "What is your average monthly electricity bill?",
        options: [
          { id: "b1", label: "$100 - $200 / mo", icon: "💵" },
          { id: "b2", label: "$200 - $400 / mo", icon: "💰" },
          { id: "b3", label: "$400+ / mo", icon: "🏦" }
        ]
      },
      {
        id: "quote_display",
        type: "content",
        headline: "Estimated Annual Savings:",
        blocks: [
          { type: "calculator", formula: "2400", label: "Potential 25-Year Household Savings:", currency: "$" }
        ],
        buttonText: "Check Roof Eligibility →"
      },
      {
        id: "form",
        type: "form",
        headline: "Where should we send your official quote?",
        fields: [
          { name: "address", type: "address", label: "Home Street Address", required: true },
          { name: "name", type: "text", label: "Full Name", required: true },
          { name: "phone", type: "tel", label: "Phone Number", required: true }
        ],
        buttonText: "Get Official Solar Proposal"
      },
      {
        id: "complete",
        type: "success",
        headline: "Proposal Requested! ☀️",
        subtext: "Your satellite roof assessment is underway. We will text your results to {{phone}}."
      }
    ]
  }
};
