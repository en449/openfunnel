/**
 * @file The public funnel surface: the rendered page and the read-only JSON API.
 *
 * These routes are deliberately unauthenticated — `/f/:slug` is what a cold ad
 * click lands on. Everything they return goes through `publicFunnel()`, which
 * strips the webhook URL, its secret and any stray API key, because the whole
 * document is readable with View Source once it reaches a browser.
 */

import { DEV } from "../lib/config.js";
import { funnelCsp } from "../lib/csp.js";
import { listFunnels, loadFunnel, publicFunnel } from "../lib/funnels.js";
import { funnelPage } from "../lib/html.js";
import { html, json } from "../lib/http.js";

/**
 * @param {Request} req
 * @param {{ path: string }} ctx
 * @returns {Promise<Response|null>} null when no funnel route matched.
 */
export async function handleFunnels(req, ctx) {
  const { path } = ctx;

  // --- The funnel page itself ---------------------------------------------
  if (path.startsWith("/f/")) {
    const funnel = await loadFunnel(path.slice(3));
    if (!funnel) return html("<h1>404 — funnel not found</h1>", 404);
    return html(funnelPage(funnel), 200, { "content-security-policy": funnelCsp(funnel) });
  }

  // The console's funnel switcher and dashboard read this instead of holding a
  // hardcoded list — drop a JSON file in FUNNELS_DIR and it shows up.
  if (path === "/api/funnels") {
    const slugs = await listFunnels();
    const funnels = [];
    for (const slug of slugs) {
      const funnel = await loadFunnel(slug);
      if (!funnel) continue;
      funnels.push({
        slug,
        name: funnel.name || slug,
        primary: funnel.theme?.primary || null,
        mode: funnel.theme?.mode || "light",
        steps: funnel.steps.length,
      });
    }
    return json({ funnels });
  }

  if (path.startsWith("/api/funnels/")) {
    const funnel = await loadFunnel(path.slice("/api/funnels/".length));
    if (!funnel) return json({ error: "not_found" }, 404);
    // Public route: the builder fetches the full document through the
    // authenticated /api/builder surface instead.
    return json(publicFunnel(funnel), 200, {
      "cache-control": DEV ? "no-store" : "public, max-age=60",
    });
  }

  return null;
}
