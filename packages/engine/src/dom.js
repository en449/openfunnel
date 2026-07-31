/**
 * @file Tiny DOM helpers. Zero dependencies — this keeps the runtime bundle
 * minuscule (a big part of hitting sub-second loads). Nothing here is clever;
 * it just removes the `document.createElement` boilerplate from the renderers.
 */

/**
 * May this string be used as a navigation target or an `href`?
 *
 * Accepts absolute http(s) and same-origin paths, and nothing else. Two traps
 * this closes, both of which a naive `startsWith("/")` check waves through:
 *
 *   //evil.com    protocol-relative — the browser reads it as https://evil.com
 *   /\evil.com    the same thing; browsers normalise the backslash to a slash
 *
 * Funnel documents are operator-written, so this is not a privilege boundary —
 * it is here so a document that arrives by some other route cannot turn a
 * "redirect on completion" field into `javascript:` execution or an open
 * redirect that lends the operator's domain to a phishing hop.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isNavigableUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  // Same-origin path only: one leading slash, not two, and no backslash trick.
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\");
}

/**
 * Is `preview=1` or `admin=1` genuinely set as a query parameter?
 *
 * Parsed, never substring-matched. `location.search.includes("preview=1")` also
 * fires on `?utm_campaign=spring-preview=1-sale`, and this flag decides whether a
 * lead is suppressed — so a competitor who circulates a link with those nine
 * characters buried anywhere in it would silently destroy the operator's leads.
 *
 * Accepts a full URL or a bare query string.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasPreviewFlag(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const params = new URL(value, "http://openfunnel.invalid").searchParams;
    return params.get("preview") === "1" || params.get("admin") === "1";
  } catch {
    return false;
  }
}

/**
 * Create an element with attributes/props and children in one call.
 *
 * @param {string} tag
 * @param {Record<string, any>} [attrs]  `class`, `text`, `html`, `on*` handlers,
 *                                        `dataset`, or any HTML attribute.
 * @param {Array<Node|string|null|undefined>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Remove all children of a node. @param {Element} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Generate a short, non-cryptographic id. Used for session ids and event ids.
 * (Cryptographic randomness isn't needed here and `crypto.randomUUID` may be
 * unavailable in some embed contexts.)
 * @returns {string}
 */
export function uid() {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `${rnd()}${rnd()}`;
}

/** @returns {boolean} */
export function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
