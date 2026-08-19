/**
 * @file The public funnel surface: the rendered page and the read-only JSON API.
 *
 * These routes are deliberately unauthenticated — `/f/:slug` is what a cold ad
 * click lands on. Everything they return goes through `publicFunnel()`, which
 * strips the webhook URL, its secret and any stray API key, because the whole
 * document is readable with View Source once it reaches a browser.
 *
 * They are also the two surfaces the serve-time legal gate binds to, which is why
 * they read through `loadFunnelForVisitor` and every other caller does not. See
 * the gate's own header in `lib/funnels.js` for why it refuses here rather than at
 * a publish step, and why ingest is deliberately exempt.
 */

import { DEV } from "../lib/config.js";
import { funnelCsp } from "../lib/csp.js";
import { listFunnels, loadFunnel, loadFunnelForVisitor, publicFunnel } from "../lib/funnels.js";
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
    const { funnel, blocked } = await loadFunnelForVisitor(path.slice(3));
    if (!funnel) return html("<h1>404 — funnel not found</h1>", 404);
    if (blocked) return unavailable(path.slice(3), blocked);
    return html(funnelPage(funnel), 200, { "content-security-policy": funnelCsp(funnel) });
  }

  // The console's funnel switcher and dashboard read this instead of holding a
  // hardcoded list — drop a JSON file in FUNNELS_DIR and it shows up.
  //
  // The gate deliberately does NOT filter this list, and that is a decision
  // rather than an omission. This endpoint returns a directory — slug, name,
  // colour, step count — never the document, so nothing here renders a page
  // without an Impressum; the obligation is about the page a visitor lands on,
  // and `/f/:slug` and `/api/funnels/:slug` are both refused. Filtering here
  // would instead break the console: the funnel grid is drawn FROM this list,
  // and a gated funnel dropping out of it takes its own "why is this down"
  // badge with it — hiding exactly the funnel the operator has to go fix.
  // (That the list is public at all is a separate, pre-existing question; it is
  // already 404 on a mapped client domain, which is where it would matter.)
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
    const slug = path.slice("/api/funnels/".length);
    const { funnel, blocked } = await loadFunnelForVisitor(slug);
    if (!funnel) return json({ error: "not_found" }, 404);
    // The document IS the page — the engine mounts from it. Serving it here while
    // refusing `/f/:slug` would leave the gate one fetch wide.
    if (blocked) return json({ error: "unavailable" }, 503, { "x-robots-tag": "noindex" });
    // Public route: the builder fetches the full document through the
    // authenticated /api/builder surface instead.
    return json(publicFunnel(funnel), 200, {
      "cache-control": DEV ? "no-store" : "public, max-age=60",
    });
  }

  return null;
}

/**
 * The refusal a visitor sees when the gate is closed.
 *
 * Not the 404 an absent funnel gets. A gated funnel exists and was very likely
 * live an hour ago, so "not found" would send the operator looking for a deleted
 * row and tell a crawler to drop the URL; 503 says what is true, which is that
 * this is temporary and someone has to fix it. It says nothing about *which*
 * requirement is missing — that would publish which client has not signed an AVV
 * to anyone who asks. The console is where the reason lives.
 *
 * German, with no language switch, because the gate only binds on a deployment
 * with a database — Enno's — and every funnel behind it serves a German market.
 *
 * @param {string} slug
 * @param {string} reason
 * @returns {Response}
 */
function unavailable(slug, reason) {
  console.warn(`[runtime] funnel "${slug}" refused by the legal gate: ${reason}`);
  return html(
    `<!doctype html><html lang="de"><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Nicht verf\u00fcgbar</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#334155">` +
      `<p>Diese Seite ist derzeit nicht verf\u00fcgbar.</p>`,
    503,
    { "x-robots-tag": "noindex" },
  );
}
