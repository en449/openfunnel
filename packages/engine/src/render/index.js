/**
 * @file Step renderer dispatch. Builds the shared header (headline, subtext,
 * content blocks) then delegates the interactive body to the per-type renderer.
 */

import { el } from "../dom.js";
import { pipe } from "../piping.js";
import { renderBlocks } from "./blocks.js";
import { renderChoice } from "./choice.js";
import { renderMultiSelect } from "./multiselect.js";
import { renderForm } from "./form.js";
import { renderContent } from "./content.js";
import { renderLoader } from "./loader.js";
import { renderSuccess } from "./success.js";

/**
 * @param {import('../types.js').Step} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement} The fully rendered step (header + body).
 */
export function renderStep(step, ctrl) {
  const data = ctrl.data;
  const screen = el("div", { class: `of-step of-step-${step.type}`, "data-step-id": step.id });

  const header = el("header", { class: "of-step-header" }, [
    step.headline ? el("h1", { class: "of-headline", text: pipe(step.headline, data) }) : null,
    step.subtext ? el("p", { class: "of-subtext", text: pipe(step.subtext, data) }) : null,
  ]);
  if (header.childElementCount) screen.appendChild(header);

  if (step.blocks?.length) screen.appendChild(renderBlocks(step.blocks, data));

  screen.appendChild(renderBody(step, ctrl));
  return screen;
}

/**
 * @param {import('../types.js').Step} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
function renderBody(step, ctrl) {
  switch (step.type) {
    case "choice":
      return renderChoice(step, ctrl);
    case "multiselect":
      return renderMultiSelect(step, ctrl);
    case "form":
      return renderForm(step, ctrl);
    case "content":
      return renderContent(step, ctrl);
    case "loader":
      return renderLoader(step, ctrl);
    case "success":
      return renderSuccess(step, ctrl);
    default:
      return el("div", { class: "of-unknown", text: `Unknown step type: ${/** @type {any} */ (step).type}` });
  }
}
