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
import { renderLanding } from "./landing.js";
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

  // A landing step owns its entire screen: the hero draws its own eyebrow,
  // headline and subtext with layout-specific typography, and `step.blocks` is
  // the page body *below* that hero. Drawing the shared header here as well
  // would print the headline twice and strand the sections above the fold.
  if (step.type === "landing") {
    screen.appendChild(renderLanding(step, ctrl));
    return screen;
  }

  const heroImageSrc = step.image || step.heroImage;
  const headerClass = `of-step-header${step.align ? ` of-align-${step.align}` : ""}`;
  const header = el("header", { class: headerClass }, [
    heroImageSrc ? el("img", { class: "of-hero-image", src: heroImageSrc, alt: step.headline || "", loading: "lazy" }) : null,
    step.headline ? el("h1", { class: "of-headline", text: pipe(step.headline, data) }) : null,
    step.subtext ? el("p", { class: "of-subtext", text: pipe(step.subtext, data) }) : null,
  ]);
  if (header.childElementCount) screen.appendChild(header);

  if (step.blocks?.length) screen.appendChild(renderBlocks(step.blocks, data, step, ctrl));

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
    case "landing":
      // Handled before renderBody; listed so the union stays exhaustive.
      return renderLanding(step, ctrl);
    case "loader":
      return renderLoader(step, ctrl);
    case "success":
      return renderSuccess(step, ctrl);
    default:
      return el("div", { class: "of-unknown", text: `Unknown step type: ${/** @type {any} */ (step).type}` });
  }
}
