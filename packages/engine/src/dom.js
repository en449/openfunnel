/**
 * @file Tiny DOM helpers. Zero dependencies — this keeps the runtime bundle
 * minuscule (a big part of hitting sub-second loads). Nothing here is clever;
 * it just removes the `document.createElement` boilerplate from the renderers.
 */

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
