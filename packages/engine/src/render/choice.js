/**
 * @file `choice` step — single-select quiz question. Tapping an option records
 * the answer and auto-advances (Perspective's core interaction). Options with an
 * `image` render as large "answer boxes"; otherwise as tappable rows/cards.
 */

import { el } from "../dom.js";

/**
 * @param {import('../types.js').ChoiceStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
export function renderChoice(step, ctrl) {
  const autoAdvance = step.autoAdvance !== false;
  const hasImages = step.options.some((o) => o.image);
  const layout = step.layout || (hasImages ? "grid" : "list");

  const list = el("div", {
    class: `of-options of-layout-${layout}`,
    role: "radiogroup",
    "aria-label": step.headline || "Choose an option",
  });

  /** @type {HTMLButtonElement | null} */
  let selectedBtn = null;

  step.options.forEach((opt) => {
    const btn = el("button", {
      type: "button",
      class: "of-option" + (opt.image ? " of-option-image" : ""),
      role: "radio",
      "aria-checked": "false",
      onclick: () => {
        if (selectedBtn) selectedBtn.setAttribute("aria-checked", "false");
        btn.setAttribute("aria-checked", "true");
        btn.classList.add("is-selected");
        selectedBtn = /** @type {HTMLButtonElement} */ (btn);
        const value = opt.value ?? opt.label;
        // Small highlight beat before advancing feels intentional, not janky —
        // but skip it for reduced-motion users so nothing lingers.
        const advance = () => ctrl.answer(value, { optionId: opt.id, next: opt.next });
        if (autoAdvance && !ctrl.reducedMotion) ctrl.after(180, advance);
        else advance();
      },
    }, [
      opt.image
        ? el("img", { class: "of-option-img", src: opt.image, alt: "", loading: "lazy" })
        : opt.icon
          ? el("span", { class: "of-option-icon", text: opt.icon })
          : null,
      el("span", { class: "of-option-body" }, [
        el("span", { class: "of-option-label", text: opt.label }),
        opt.subtext ? el("span", { class: "of-option-sub", text: opt.subtext }) : null,
      ]),
      el("span", { class: "of-option-check", "aria-hidden": "true" }),
    ]);
    list.appendChild(btn);
  });

  return list;
}
