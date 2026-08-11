/**
 * @file Tiny DOM helpers. Zero dependencies — this keeps the runtime bundle
 * minuscule (a big part of hitting sub-second loads). Nothing here is clever;
 * it just removes the `document.createElement` boilerplate from the renderers.
 */

/** Stand-in origin for resolving a relative URL without needing `location`. */
const RELATIVE_BASE = "https://openfunnel.invalid";

/**
 * May this string be used as a navigation target or an `href`?
 *
 * Accepts absolute http(s) and URLs that stay on the page's own origin, and
 * nothing else. Funnel documents are operator-written, so this is not a
 * privilege boundary — it is here so a document that arrives by some other route
 * cannot turn a "redirect on completion" field into `javascript:` execution or
 * an open redirect that lends the operator's domain to a phishing hop.
 *
 * **Resolved, not pattern-matched.** This used to be three `startsWith` tests
 * against `//` and `/\`, which is a check on the string a human reads rather
 * than the one the browser acts on. The URL parser removes every ASCII tab,
 * newline and carriage return from ANYWHERE in the input before resolving it, so
 * `/⇥/evil.tld/x` — a one-character `\t` in a JSON string — reads as a path here
 * and arrives as `https://evil.tld/x` there. Every textual variant of this check
 * loses that race; resolving the URL and asking the parser what it became is the
 * only version that cannot drift from the browser's answer.
 *
 * Rejecting is the safe direction, so anything unparseable is refused.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isNavigableUrl(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url, RELATIVE_BASE);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  // An absolute http(s) URL may point anywhere. Anything else had to resolve
  // relative to the base, so landing on another origin means it was absolute in
  // disguise — which is exactly what the tab trick above produces.
  if (/^https?:/i.test(url.trim())) return true;
  return parsed.origin === RELATIVE_BASE;
}

/**
 * Does this URL stay on the origin the funnel is running on?
 *
 * Stricter than `isNavigableUrl`, which permits absolute URLs to anywhere. Used
 * for `integrations.leadEndpoint`, where "anywhere" is the whole attack: a funnel
 * document that names its own lead destination sends every captured lead there,
 * and the operator's inbox reads zero with nothing logged. Resolved against the
 * real `location` when there is one, so an embedded engine judges against the
 * page it is embedded in rather than a sentinel.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isSameOriginUrl(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  const base = typeof location !== "undefined" && location.href ? location.href : RELATIVE_BASE;
  try {
    const origin = new URL(base).origin;
    // Every opaque origin — a sandboxed iframe without `allow-same-origin`, a
    // `data:`/`about:`/`file:` host page — serialises to the string "null", so
    // comparing two of them reads as a match between unrelated contexts. Refuse
    // instead: the embedder's own `options.leadEndpoint` still applies, and that
    // is code rather than a field out of a document.
    if (origin === "null") return false;
    return new URL(url, base).origin === origin;
  } catch {
    return false;
  }
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

/** Hosts whose player pages may be framed. Exact match, never a substring. */
const EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
]);

/**
 * Resolve a video URL to something safe to put in an `iframe src`, or null when
 * it is not an embeddable player at all (so the caller falls back to `<video>`).
 *
 * The check this replaces was `/youtube\.com|youtu\.be|vimeo\.com|player\./.test(src)`
 * — unanchored, so it matched anywhere in the string. `javascript:alert(1)//player.`
 * passed, and an iframe `src` executes on load with nothing to click. It was also
 * the one URL field in the engine that never reached `isNavigableUrl`.
 *
 * Parsing instead of matching closes both: a `javascript:` URL has no hostname to
 * compare, and the hostname is compared by equality against a fixed set rather
 * than by "does it appear somewhere".
 *
 * @param {unknown} src
 * @returns {string|null}
 */
export function embedUrl(src) {
  let url;
  try {
    url = new URL(String(src ?? ""));
  } catch {
    return null; // relative or malformed — not a player, and not framable
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();
  if (!EMBED_HOSTS.has(host)) return null;

  // Normalise the two share URLs people actually paste into their embed form.
  const isYouTube = host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com");
  if (isYouTube) {
    const id = host === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") || "";
    if (/^[\w-]{6,20}$/.test(id)) return `https://www.youtube.com/embed/${id}`;
  }
  return url.href;
}

/* ========================================================================== *
 *  Rich text from a funnel document
 * ========================================================================== */

/** Inline markup an operator legitimately writes into consent copy. */
const RICH_TEXT_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "s", "small", "br", "span", "p"]);

/** Elements whose *text* must go too — script and style bodies are not copy. */
const RICH_TEXT_DROP = new Set(["script", "style", "noscript", "template", "title"]);

/**
 * Rebuild a fragment of operator HTML from an allowlist.
 *
 * `step.consent` is the one funnel field rendered as markup rather than text,
 * because a consent line needs a link to the privacy policy. That made it the
 * engine's only HTML sink, and funnel documents travel: they come from
 * templates, bug reports and shared packs, and the console previews an imported
 * one in a same-origin, unsandboxed iframe. `<img onerror>` in that field read
 * `of.adminToken` out of localStorage and owned the console. On the served
 * `/f/:slug` page the CSP stops the script from running, but the engine ships
 * standalone with no CSP at all, and one header should not be the only layer
 * under an attacker-supplied string.
 *
 * Rebuilds rather than scrubs in place: every node in the result is one this
 * function created, so no attribute survives except an `href` that passed
 * `isNavigableUrl`. A disallowed tag is unwrapped and its text kept, so
 * unexpected markup degrades to plain copy instead of vanishing.
 *
 * @param {unknown} html
 * @returns {DocumentFragment}
 */
export function richText(html) {
  const source = document.createElement("template");
  source.innerHTML = String(html ?? "");
  const out = document.createDocumentFragment();
  copyRichText(source.content, out, 0);
  return out;
}

/**
 * How deep the copy will recurse before abandoning the rest of the subtree.
 *
 * Consent copy is a sentence with a link; nothing legitimate comes close. The
 * limit is not about tidiness: the walk is recursive, so ~30k nested `<div>` in
 * a `consent` field — about 330KB of JSON — overflowed the stack, and the throw
 * escapes `renderForm` into `Controller._render`, which is uncaught. One crafted
 * field therefore blanked the entire funnel for every visitor, not just the
 * consent line.
 *
 * Beyond the limit the subtree is dropped rather than flattened to its text:
 * `textContent` is itself recursive in some DOM implementations, so reading it
 * here would re-introduce the overflow at the exact point that exists to avoid
 * it. Losing the tail of a document nested 32 deep is not a real cost.
 */
const RICH_TEXT_MAX_DEPTH = 32;

/**
 * @param {Node} from
 * @param {Node} to
 * @param {number} depth
 */
function copyRichText(from, to, depth) {
  if (depth > RICH_TEXT_MAX_DEPTH) return;
  for (const node of from.childNodes) {
    if (node.nodeType === 3) {
      to.appendChild(document.createTextNode(node.nodeValue || ""));
      continue;
    }
    if (node.nodeType !== 1) continue; // comments and the rest carry nothing to show

    const tag = /** @type {Element} */ (node).tagName.toLowerCase();
    if (RICH_TEXT_DROP.has(tag)) continue;
    if (!RICH_TEXT_TAGS.has(tag)) {
      copyRichText(node, to, depth + 1); // unwrap: keep the words, lose the element
      continue;
    }

    const copy = document.createElement(tag);
    if (tag === "a") {
      const href = /** @type {Element} */ (node).getAttribute("href");
      if (isNavigableUrl(href)) {
        copy.setAttribute("href", String(href));
        copy.setAttribute("target", "_blank");
        copy.setAttribute("rel", "noopener noreferrer");
      }
    }
    copyRichText(node, copy, depth + 1);
    to.appendChild(copy);
  }
}

/**
 * Create an element with attributes/props and children in one call.
 *
 * @param {string} tag
 * @param {Record<string, any>} [attrs]  `class`, `text`, `html`, `on*` handlers,
 *                                        `dataset`, or any HTML attribute.
 *                                        `html` is `innerHTML` — pass it string
 *                                        literals only. Anything out of a funnel
 *                                        document goes through `richText()` and
 *                                        arrives as a child node, not as `html`.
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
