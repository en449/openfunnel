/**
 * @file `content` step — a VSL / storytelling / social-proof screen. All of its
 * substance lives in `step.blocks` (video, reviews, list…); this renderer just
 * adds the single continue CTA below them.
 */

import { el } from "../dom.js";

/**
 * @param {import('../types.js').ContentStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
export function renderContent(step, ctrl) {
  return el("div", { class: "of-content" }, [
    el("div", { class: "of-actions" }, [
      el("button", {
        type: "button",
        class: "of-cta",
        text: step.ctaLabel || "Continue",
        onclick: () => ctrl.advance({}),
      }),
    ]),
  ]);
}
