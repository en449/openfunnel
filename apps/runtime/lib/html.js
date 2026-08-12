/**
 * @file Escaping, and the funnel page's HTML shell.
 *
 * `esc()` and `jsonScript()` are exported because they are used well beyond this
 * file — the lead-notification emails escape every visitor-supplied value with
 * the same helper. There are four escapers in this repo (here, the console, and
 * the two legacy UIs) and they are deliberately identical, so that "which
 * escaper was that" is never a question worth asking.
 *
 * `funnelPage` and `funnelCsp` (in ./csp.js) are two halves of one contract:
 * both must read the operator's custom code through `customCode()`, or the
 * hashes in the policy stop matching the bytes on the page.
 */

import { FUNNEL_BOOT_SCRIPT, customCode } from "./csp.js";
import { publicFunnel } from "./funnels.js";

/** Escape a string for safe interpolation into HTML text/attributes. */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Every attribute in this file is double-quoted, so `'` is not strictly
    // required today — it is escaped anyway so that writing `attr='${esc(x)}'`
    // some day is not an XSS. The console's `esc()` already does this; matching
    // them means there is no "which escaper was that" question later.
    .replace(/'/g, "&#39;");
}

/**
 * Serialise JSON for embedding in a <script> tag. Escaping `<` is what stops a
 * funnel's own copy from being able to close the script element.
 */
export function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Inline the funnel's theme as CSS custom properties on <html>. The engine
 * re-applies these on mount; doing it server-side too means the very first
 * paint is already branded — no white flash, no layout shift.
 */
export function themeVars(theme = {}) {
  const map = {
    "--of-primary": theme.primary,
    "--of-primary-text": theme.primaryText,
    "--of-bg": theme.bg,
    "--of-surface": theme.surface,
    "--of-text": theme.text,
    "--of-muted": theme.muted,
    "--of-border": theme.border,
    "--of-radius": theme.radius,
    "--of-font": theme.font,
  };
  return Object.entries(map)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([k, v]) => `${k}:${String(v).replace(/[<>"]/g, "")}`)
    .join(";");
}

/**
 * Render the funnel page. One document, one stylesheet, one module — the entire
 * funnel config ships inline so there is no second round trip before first paint.
 *
 * @param {any} funnel
 */
export function funnelPage(funnel) {
  const first = funnel.steps[0] || {};
  const title = funnel.name || first.headline || "Get started";
  const description = first.subtext || "";
  const dark = funnel.theme?.mode === "dark";
  // Resolved through the same helper `funnelCsp` uses. If these two ever read
  // the fields differently, the hashes in the policy stop matching the bytes on
  // the page and every pasted script is silently refused.
  const { css: customCss, head: customHead, body: customBody } = customCode(funnel);

  return `<!doctype html>
<html lang="${esc(funnel.lang || "en")}" style="${esc(themeVars(funnel.theme))}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="${dark ? "dark" : "light"}" />
    <meta name="robots" content="noindex" />
    <title>${esc(title)}</title>
    ${description ? `<meta name="description" content="${esc(description)}" />` : ""}
    <meta property="og:title" content="${esc(title)}" />
    ${description ? `<meta property="og:description" content="${esc(description)}" />` : ""}
    <link rel="preload" as="script" href="/_of/index.js" crossorigin />
    <link rel="stylesheet" href="/_of/styles.css" />
    <!-- Self-hosted webfaces for the theme presets (PHASE-1-PLAN.md §4.9). A
         separate <link> rather than an @import inside styles.css, which would
         cost a serial round trip before the browser learns the font file exists.
         Each @font-face carries a unicode-range, so a page only downloads the
         faces it actually renders. -->
    <link rel="stylesheet" href="/_of/fonts/fonts.css" />
    <style>body{margin:0;background:var(--of-bg,#eef1f6)}</style>
    ${customCss ? `<style id="of-custom-css">${customCss}</style>` : ""}
    ${customHead ? customHead : ""}
  </head>
  <body>
    <main class="of-stage"><div id="app" class="of-root"></div></main>

    <script id="of-funnel" type="application/json">${jsonScript(publicFunnel(funnel))}</script>
    <script type="module">${FUNNEL_BOOT_SCRIPT}</script>
    ${customBody ? customBody : ""}

    <noscript>
      <p style="font:16px/1.5 system-ui;padding:24px;text-align:center">
        This experience needs JavaScript enabled.
      </p>
    </noscript>
  </body>
</html>`;
}
