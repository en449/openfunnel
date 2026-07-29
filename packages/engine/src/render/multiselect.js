/**
 * @file `multiselect` step — pick one or more options, then tap continue.
 * Enforces optional `min`/`max`. The continue button stays disabled until the
 * selection is valid, so the visitor always knows when they can proceed.
 */

import { el } from "../dom.js";

/**
 * @param {import('../types.js').MultiSelectStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
export function renderMultiSelect(step, ctrl) {
  const layout = step.layout || "list";
  const min = step.min ?? 1;
  const max = step.max ?? step.options.length;

  /** @type {Set<string>} */
  const selected = new Set();

  const submit = el("button", {
    type: "button",
    class: "of-cta",
    disabled: true,
    text: step.submitLabel || "Continue",
    onclick: () => {
      const values = step.options
        .filter((o) => selected.has(o.id))
        .map((o) => o.value ?? o.label);
      ctrl.answer(values, {});
    },
  });

  const syncSubmit = () => {
    const ok = selected.size >= min && selected.size <= max;
    /** @type {HTMLButtonElement} */ (submit).disabled = !ok;
  };

  const list = el("div", {
    class: `of-options of-layout-${layout}`,
    role: "group",
    "aria-label": step.headline || "Select all that apply",
  });

  step.options.forEach((opt) => {
    const btn = el("button", {
      type: "button",
      class: "of-option of-option-multi",
      role: "checkbox",
      "aria-checked": "false",
      onclick: () => {
        const on = selected.has(opt.id);
        if (on) {
          selected.delete(opt.id);
          btn.classList.remove("is-selected");
          btn.setAttribute("aria-checked", "false");
        } else {
          if (selected.size >= max) return; // respect max
          selected.add(opt.id);
          btn.classList.add("is-selected");
          btn.setAttribute("aria-checked", "true");
        }
        syncSubmit();
      },
    }, [
      opt.icon ? el("span", { class: "of-option-icon", text: opt.icon }) : null,
      el("span", { class: "of-option-body" }, [
        el("span", { class: "of-option-label", text: opt.label }),
        opt.subtext ? el("span", { class: "of-option-sub", text: opt.subtext }) : null,
      ]),
      el("span", { class: "of-option-box", "aria-hidden": "true" }),
    ]);
    list.appendChild(btn);
  });

  return el("div", { class: "of-multiselect" }, [list, el("div", { class: "of-actions" }, [submit])]);
}
