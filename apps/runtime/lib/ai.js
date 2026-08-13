/**
 * @file The AI copilot's provider calls and response parsing.
 *
 * Both functions previously lived INSIDE the router's `fetch` handler, which
 * meant they were re-created on every request and sat in the middle of the route
 * table at zero indentation. Nothing depended on that; they are ordinary
 * helpers.
 *
 * The API key can arrive in the request body (the console sends its own, so an
 * operator can use a key the server never stores) or fall back to
 * `OPENAI_API_KEY`. That is only safe because `/api/ai/*` is behind the admin
 * gate — an unauthenticated caller supplying a key would make this an open
 * proxy to four paid APIs.
 */

import { errSummary } from "./log.js";

/**
 * Pull a JSON object out of a model's reply, which may be fenced, prefixed with
 * prose, or carry a trailing comma. Returns null rather than throwing — every
 * caller has a non-AI fallback path.
 * @param {unknown} text
 * @returns {any|null}
 */
export function parseJsonFromAiText(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  // Group 1 is not optional in the pattern above, so a successful match always
  // carries it (possibly empty) — the undefined case is unreachable, but
  // `noUncheckedIndexedAccess` cannot see that from the regex shape.
  if (fenceMatch && fenceMatch[1] !== undefined) cleaned = fenceMatch[1].trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    try {
      const sanitized = match[0].replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

/**
 * Call whichever provider the model/key implies, and return the raw text.
 *
 * Returns null on any failure — no key, a non-ok response, a thrown fetch — so
 * the caller falls through to its offline generator rather than surfacing an
 * error. A "success" response from `/api/ai/generate` therefore does not prove a
 * model ran.
 *
 * @param {{ provider: string, model: string, apiKey: string, systemPrompt: string, userPrompt: string }} params
 *   Every caller (`routes/ai.js`) resolves these with an `||` fallback before
 *   calling in, so they arrive as plain strings — `apiKey` may still be `""`.
 */
export async function executeAiRequest({ provider, model, apiKey, systemPrompt, userPrompt }) {
  if (!apiKey) return null;

  try {
    // Anthropic
    if (provider === "anthropic" || model.startsWith("claude-") || apiKey.startsWith("sk-ant-")) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: model || "claude-3-7-sonnet-20250219",
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      if (res.ok) {
        const data = await res.json();
        return data.content?.[0]?.text || "";
      }
    }

    // DeepSeek
    if (provider === "deepseek" || model.startsWith("deepseek-")) {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: model || "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        })
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message?.content || "";
      }
    }

    // Google Gemini
    if (provider === "google" || model.startsWith("gemini-")) {
      const geminiModel = model || "gemini-2.0-flash";
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }]
        })
      });
      if (res.ok) {
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }
    }

    // Standard OpenAI / OpenAI-compatible API
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: model || "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }
  } catch (err) {
    // The Gemini branch puts the key in the query string, so this must summarise
    // rather than log the error object — `err.path` would carry it.
    console.warn("[ai] api execution error:", errSummary(err));
  }
  return null;
}
