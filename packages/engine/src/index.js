/**
 * @file Public entry point for the OpenFunnel engine.
 *
 * Usage (browser, zero build step):
 *   import { createFunnel } from "@openfunnel/engine";
 *   import "@openfunnel/engine/styles.css";
 *   const funnel = createFunnel(document.getElementById("app"), config, {
 *     onEvent: (e) => console.log(e),
 *   });
 *
 * The engine has no runtime dependencies and mutates only the container you give
 * it, so it embeds safely inside any page or framework.
 */

import { Controller } from "./controller.js";

export { Controller };
export { firePixel, installPixels } from "./analytics.js";
export { consentRequired, marketingAllowed, readDecision, writeDecision } from "./consent.js";
export { submitLead, trackEvent } from "./leads.js";
export { validateField, validateForm } from "./validate.js";
export { pipe } from "./piping.js";

/**
 * Options passed to {@link createFunnel}.
 *
 * @typedef {Object} FunnelOptions
 * @property {(event: import('./types.js').FunnelEvent) => void} [onEvent]
 *   Called for every funnel event. Use for custom analytics or debugging.
 * @property {boolean} [trackEvents]  POST events to `eventEndpoint`. Default true.
 * @property {string} [eventEndpoint] Analytics ingest URL. Default "/api/events".
 * @property {string} [leadEndpoint]  Lead capture URL. Overridden by the funnel's
 *                                    `integrations.leadEndpoint` if set.
 * @property {boolean} [resume]       Resume a persisted session. Default true.
 * @property {boolean} [isPreview]    Preview mode flag inside visual builder.
 *                                    Suppresses analytics; see `Controller._emit`.
 * @property {boolean} [isEditor]     Enable in-canvas editing affordances
 *                                    (drag-to-reorder). Builder-only — never set
 *                                    this from a URL parameter.
 * @property {number} [stepIndex]    Initial active step index.
 * @property {boolean} [hideBranding] Suppress the "Powered by OpenFunnel" footer
 *                                    for this mount. The funnel document's
 *                                    `branding.hidden` does the same thing.
 */

/**
 * Create, mount, and return a funnel controller.
 *
 * @param {HTMLElement} container
 * @param {import('./types.js').Funnel} funnel
 * @param {FunnelOptions} [options]
 * @returns {Controller}
 */
export function createFunnel(container, funnel, options = {}) {
  if (!container) throw new Error("[openfunnel] createFunnel: container element is required.");
  if (!funnel || !Array.isArray(funnel.steps) || funnel.steps.length === 0) {
    throw new Error("[openfunnel] createFunnel: funnel.steps must be a non-empty array.");
  }
  return new Controller(container, funnel, options).mount();
}
