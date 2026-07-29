/**
 * @file Branching resolution — decide which step comes next.
 *
 * Precedence (highest first):
 *   1. An explicit branch target passed by the interaction (e.g. the tapped
 *      choice option's `next`).
 *   2. The current step's own `next`.
 *   3. The next step in document order (linear fall-through).
 *
 * A `next` of `null` explicitly ends the funnel. A `next` string is a step id.
 */

/**
 * @param {import('./types.js').Step[]} steps
 * @param {number} currentIndex
 * @param {string|null|undefined} [optionNext]  Branch target from the interaction.
 * @returns {number} Index of the next step, or -1 to end the funnel.
 */
export function resolveNext(steps, currentIndex, optionNext) {
  const current = steps[currentIndex];
  const target = optionNext !== undefined ? optionNext : current?.next;

  if (target === null) return -1; // explicit end
  if (typeof target === "string") {
    const idx = steps.findIndex((s) => s.id === target);
    if (idx === -1) {
      console.warn(`[openfunnel] branch target "${target}" not found; falling through.`);
    } else {
      return idx;
    }
  }
  // Linear fall-through.
  return currentIndex + 1 < steps.length ? currentIndex + 1 : -1;
}
