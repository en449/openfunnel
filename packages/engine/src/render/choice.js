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

  /** @type {number | null} */
  let draggedIndex = null;

  step.options.forEach((opt, idx) => {
    const btn = el("button", {
      type: "button",
      class: "of-option" + (opt.image ? " of-option-image" : "") + (ctrl.isEditor ? " is-draggable" : ""),
      role: "radio",
      "aria-checked": "false",
      draggable: ctrl.isEditor ? "true" : undefined,
      "data-option-idx": String(idx),
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
      ctrl.isEditor ? el("span", { class: "of-drag-handle-canvas", text: "⋮⋮", title: "Drag to reorder on canvas" }) : null,
      opt.badge ? el("span", { class: "of-option-badge", text: opt.badge }) : null,
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

    if (ctrl.isEditor) {
      btn.addEventListener("dragstart", (e) => {
        draggedIndex = idx;
        btn.classList.add("is-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(idx));
        }
      });

      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = btn.getBoundingClientRect();
        const isAfter = e.clientY > rect.top + rect.height / 2;
        btn.classList.toggle("drop-after", isAfter);
        btn.classList.toggle("drop-before", !isAfter);
        btn.classList.add("drag-over");
      });

      btn.addEventListener("dragleave", () => {
        btn.classList.remove("drag-over", "drop-before", "drop-after");
      });

      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        const rect = btn.getBoundingClientRect();
        const isAfter = e.clientY > rect.top + rect.height / 2;
        btn.classList.remove("drag-over", "drop-before", "drop-after");

        if (draggedIndex === null) return;
        let targetIdx = isAfter ? idx + 1 : idx;
        const movedOpts = [...step.options];
        const [movedItem] = movedOpts.splice(draggedIndex, 1);
        if (draggedIndex < targetIdx) targetIdx--;
        movedOpts.splice(targetIdx, 0, movedItem);

        step.options = movedOpts;
        if (window.parent && window.parent !== window) {
          // Same-origin builder only — never "*", or any site that frames this
          // funnel would receive the message too.
          window.parent.postMessage(
            { type: "of_reorder_options", stepId: step.id, options: movedOpts },
            window.location.origin
          );
        }
        ctrl.refresh();
      });

      btn.addEventListener("dragend", () => {
        btn.classList.remove("is-dragging", "drag-over", "drop-before", "drop-after");
        draggedIndex = null;
      });
    }

    list.appendChild(btn);
  });

  return list;
}
