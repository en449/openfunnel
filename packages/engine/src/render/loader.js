/**
 * @file `loader` step — the "warming" screen. An animated progress bar fills
 * while a list of tasks tick over to checkmarks, then the funnel auto-advances.
 * This manufactures perceived value ("we're doing work for you") and is one of
 * Perspective's highest-leverage conversion patterns.
 *
 * All timers go through `ctrl.after`, which the controller clears on navigation,
 * so nothing fires after the visitor has moved on (or hit back).
 */

import { el } from "../dom.js";

/**
 * @param {import('../types.js').LoaderStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
export function renderLoader(step, ctrl) {
  const duration = step.durationMs ?? 2600;
  const items = step.items?.length
    ? step.items
    : ["Analysing your answers", "Matching your options", "Preparing your result"];

  const bar = el("div", { class: "of-loader-fill" });
  const track = el("div", { class: "of-loader-track", role: "progressbar", "aria-label": "Loading" }, [bar]);
  const percent = el("div", { class: "of-loader-percent", text: "0%" });

  const rows = items.map((label) =>
    el("li", { class: "of-loader-item" }, [
      el("span", { class: "of-loader-tick", "aria-hidden": "true" }),
      el("span", { text: label }),
    ]),
  );
  const listEl = el("ul", { class: "of-loader-list" }, rows);

  // Drive the bar with the platform's reduced-motion preference in mind: when
  // motion is reduced we jump straight to done and advance quickly.
  if (ctrl.reducedMotion) {
    bar.style.width = "100%";
    percent.textContent = "100%";
    rows.forEach((r) => r.classList.add("is-done"));
    ctrl.after(400, () => ctrl.advance({}));
  } else {
    // Kick the CSS width transition on the next frame.
    bar.style.transition = `width ${duration}ms linear`;
    requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.width = "100%")));

    // Percent counter.
    const started = ctrl.now();
    const poll = () => {
      const pct = Math.min(100, Math.round(((ctrl.now() - started) / duration) * 100));
      percent.textContent = `${pct}%`;
      if (pct < 100) ctrl.after(80, poll);
    };
    poll();

    // Tick each item over the course of the load.
    rows.forEach((row, i) => {
      ctrl.after(Math.round((duration * (i + 1)) / (rows.length + 0.5)), () => row.classList.add("is-done"));
    });

    ctrl.after(duration + 260, () => ctrl.advance({}));
  }

  return el("div", { class: "of-loader" }, [track, percent, listEl]);
}
