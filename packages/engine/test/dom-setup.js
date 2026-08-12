/**
 * @file The DOM the engine tests run against — installed once, and completely.
 *
 * Every test file used to carry its own `beforeAll`, and each one installed a
 * DIFFERENT subset of globals behind the same guard:
 *
 *   if (globalThis.document) return;
 *
 * Bun runs the files in one process, so the first file to reach its `beforeAll`
 * won and every later file skipped its own setup — including the parts the
 * winner never installed. `sanitize.test.js` set only `window`, `document`,
 * `location` and `HTMLElement`, so any run that reached it first left
 * `consent`, `render` and `landing` with no `localStorage`, no `matchMedia` and
 * no `requestAnimationFrame`: 18 failures, `ReferenceError: localStorage is not
 * defined`, and nothing wrong with the code under test.
 *
 * That made the suite's colour a function of file order. It was green locally
 * and red on the GitHub runner, on the same commit, and it had been latent
 * since the files were written — reproducible in one command:
 *
 *   bun test packages/engine/test/sanitize.test.js packages/engine/test/consent.test.js
 *
 * So the environment is defined in one place and is the union of what every
 * file needs. A test that needs a global nothing else does adds it HERE; a
 * second partial setup somewhere else is the bug coming back.
 */
import { Window } from "happy-dom";

let installed = false;

/**
 * Install the browser globals the engine reads at call time. Idempotent — the
 * flag is module-level and Bun loads this module once per process, so the
 * first file through pays for it and the rest inherit a COMPLETE environment
 * rather than whatever the first file happened to want.
 */
export function installDom() {
  if (installed) return;
  installed = true;

  const w = new Window({ url: "https://test.local/" });
  const g = /** @type {any} */ (globalThis);
  g.window = w;
  g.document = w.document;
  g.navigator = w.navigator;
  g.location = w.location;
  g.localStorage = w.localStorage;
  g.HTMLElement = w.HTMLElement;
  g.Event = w.Event;
  g.Blob = w.Blob;
  g.requestAnimationFrame = (/** @type {Function} */ cb) => w.setTimeout(cb, 0);
  // Reduced motion is reported as ON so an option tap advances synchronously —
  // no highlight delay, transitions skipped — which is what makes the DOM
  // assertions in render.test.js and landing.test.js deterministic rather than
  // dependent on a timer firing before the next expect().
  g.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
}
