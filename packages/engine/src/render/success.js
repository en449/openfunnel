/**
 * @file `success` step — terminal thank-you screen. Fires the `complete` event
 * on view, shows a big redirect CTA, and optionally auto-redirects after a delay.
 */

import { el } from "../dom.js";

/**
 * @param {import('../types.js').SuccessStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
export function renderSuccess(step, ctrl) {
  const go = () => ctrl.redirect(step.redirectUrl);

  const wrap = el("div", { class: "of-success" }, [
    el("div", { class: "of-success-check", "aria-hidden": "true", html: successMark() }),
    step.redirectUrl
      ? el("div", { class: "of-actions" }, [
          el("button", { type: "button", class: "of-cta", text: step.buttonLabel || "Continue", onclick: go }),
        ])
      : null,
  ]);

  if (step.redirectUrl && step.autoRedirectMs != null) {
    ctrl.after(step.autoRedirectMs, go);
  }
  return wrap;
}

/** Inline SVG so the success state never depends on an external asset. */
function successMark() {
  return `<svg viewBox="0 0 52 52" width="72" height="72" role="img" aria-label="Success">
    <circle class="of-check-circle" cx="26" cy="26" r="24" fill="none"/>
    <path class="of-check-path" fill="none" d="M14 27 l8 8 l16 -18"/>
  </svg>`;
}
