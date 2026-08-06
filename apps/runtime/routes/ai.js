/**
 * @file `/api/ai/*` — the funnel copilot.
 *
 * PRIVILEGED. The router runs `isCrossSiteRequest` and `requireAdmin` before
 * dispatching here. That matters more than it looks: both routes accept an
 * `apiKey` in the request body, so without the gate this would be an open proxy
 * to four paid APIs on anyone's key — and to the operator's `OPENAI_API_KEY`
 * when the body omits one.
 *
 * Both routes fall through to an offline generator when no model answers, so a
 * 200 from here does NOT mean a model ran.
 */

import { executeAiRequest, parseJsonFromAiText } from "../lib/ai.js";
import { json, readJson } from "../lib/http.js";

/**
 * @param {Request} req
 * @param {{ path: string }} ctx
 * @returns {Promise<Response|null>} null when no AI route matched.
 */
export async function handleAi(req, ctx) {
  const { path } = ctx;

  if (path === "/api/ai/generate" && req.method === "POST") {
    const body = await readJson(req);
    const prompt = body?.prompt || "fitness lead gen";
    const model = body?.model || "gpt-4o";
    const provider = body?.provider || "openai";
    const apiKey = body?.apiKey || process.env.OPENAI_API_KEY || "";

    if (apiKey) {
      const text = await executeAiRequest({
        provider,
        model,
        apiKey,
        systemPrompt: "You are an expert sales funnel copywriter. Output ONLY valid JSON representing an OpenFunnel document with 'id', 'name', 'theme', and a 'steps' array (containing choice, form, loader, and success steps).",
        userPrompt: `Create an interactive quiz funnel for: ${prompt}`
      });
      if (text) {
        const parsed = parseJsonFromAiText(text);
        if (parsed && Array.isArray(parsed.steps) && parsed.steps.length) {
          return json({ funnel: parsed });
        }
      }
    }

    return json({ funnel: builtInFunnel(prompt) });
  }

  if (path === "/api/ai/improve-copy" && req.method === "POST") {
    const body = await readJson(req);
    const headline = String(body?.headline || "").trim();
    const model = body?.model || "gpt-4o-mini";
    const provider = body?.provider || "openai";
    const apiKey = body?.apiKey || process.env.OPENAI_API_KEY || "";
    if (!headline) return json({ hooks: [] });

    if (apiKey) {
      const text = await executeAiRequest({
        provider,
        model,
        apiKey,
        systemPrompt: "You are a master conversion copywriter. Give 3 high-converting, punchy headline variations as a JSON object: {\"hooks\": [\"variation 1\", \"variation 2\", \"variation 3\"]}",
        userPrompt: `Improve this headline for an interactive quiz: "${headline}"`
      });
      if (text) {
        const parsed = parseJsonFromAiText(text);
        if (parsed?.hooks && Array.isArray(parsed.hooks) && parsed.hooks.length) {
          return json({ hooks: parsed.hooks.slice(0, 3) });
        }
      }
    }

    // Offline reframings only. This fallback never invents a claim the
    // operator has not made — no guarantees, no timeframes, no rankings.
    const core = headline.replace(/[?.!]+$/, "");
    const lower = core.charAt(0).toLowerCase() + core.slice(1);
    const stripped = lower.replace(/^(what|which|how|where|why|when|who)\s+/i, "");

    const hooks = [
      /\?$/.test(headline) ? `First things first — ${lower}?` : `${core}?`,
      `Let's start with ${stripped}.`,
      `Tell us about ${stripped} and we'll take it from there.`,
    ];

    return json({ hooks: [...new Set(hooks)].filter((h) => h && h !== headline).slice(0, 3) });
  }

  return null;
}

/**
 * The built-in generator every `/api/ai/generate` call falls back to.
 *
 * It always returns the same five-step shape with the prompt interpolated into
 * the first headline — deliberately, so the console has something to open when
 * no key is configured. It is not a model, and the response gives the caller no
 * way to tell the difference; see the README's note on this.
 *
 * @param {string} prompt
 */
function builtInFunnel(prompt) {
  const slug = `ai-${prompt.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 20)}-${Date.now().toString(36)}`;
  return {
    id: slug,
    slug: slug,
    name: `AI: ${prompt.slice(0, 25)}`,
    theme: { primary: "#2563eb", mode: "light", radius: "18px" },
    steps: [
      {
        id: "q1",
        type: "choice",
        headline: `What is your primary goal regarding ${prompt}?`,
        subtext: "Select your main focus area to begin.",
        options: [
          { id: "o1", label: "Fastest Results & Growth ⚡", icon: "🚀" },
          { id: "o2", label: "Long-term Sustainable Plan 📈", icon: "🎯" },
          { id: "o3", label: "Expert Guidance & Support 🤝", icon: "💎" }
        ]
      },
      {
        id: "q2",
        type: "choice",
        headline: "What is your biggest obstacle right now?",
        options: [
          { id: "b1", label: "Lack of Time / Schedule ⏳" },
          { id: "b2", label: "Clear Execution Strategy 🗺️" },
          { id: "b3", label: "Accountability & Tracking 📊" }
        ]
      },
      {
        id: "analyzing",
        type: "loader",
        headline: "Analyzing your responses...",
        subtext: "Customizing your personalized recommendation...",
        durationMs: 2500
      },
      {
        id: "contact",
        type: "form",
        headline: "Your customized plan is ready!",
        subtext: "Enter your contact details to receive full access.",
        fields: [
          { name: "name", type: "text", label: "First Name", required: true },
          { name: "email", type: "email", label: "Email Address", required: true },
          { name: "phone", type: "tel", label: "Phone (Optional)" }
        ]
      },
      {
        id: "success",
        type: "success",
        headline: "You're all set, {{name}}! 🎉",
        subtext: "Check your inbox for your custom report."
      }
    ]
  };
}
