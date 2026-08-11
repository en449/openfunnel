/**
 * End-to-end render + navigation test using happy-dom. This exercises the real
 * controller and renderers against a synthetic funnel that touches every step
 * type, verifying the state machine, branching, form capture, piping into the
 * success screen, and the event stream.
 */
import { test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

beforeAll(() => {
  if (globalThis.document) return;
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
  // Enable reduced motion so option taps advance synchronously (no highlight
  // delay) and transitions are skipped — makes DOM assertions deterministic.
  g.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
});

/** @returns {any} */
function funnelFixture() {
  return {
    id: "t",
    slug: "t",
    settings: { persist: false, transition: "none" },
    steps: [
      { id: "q1", type: "choice", headline: "Pick", options: [
        { id: "x", label: "X", next: "form" },
        { id: "y", label: "Y" },
      ] },
      { id: "skip", type: "content", headline: "Skipped unless Y", ctaLabel: "Go" },
      { id: "form", type: "form", headline: "You", submitLabel: "Send", fields: [
        { name: "name", type: "name", required: true },
        { name: "email", type: "email", required: true },
      ] },
      { id: "done", type: "success", headline: "Thanks {{name}}", redirectUrl: "https://example.com", buttonLabel: "Go" },
    ],
  };
}

async function freshEngine() {
  // Import after DOM is registered.
  const { createFunnel } = await import("../src/index.js");
  document.body.innerHTML = '<div id="app"></div>';
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  /** @type {any[]} */
  const events = [];
  const controller = createFunnel(app, funnelFixture(), {
    trackEvents: false,
    resume: false,
    onEvent: (e) => events.push(e),
  });
  return { app, controller, events };
}

test("mounts and fires funnel_start + first step_view", async () => {
  const { app, events } = await freshEngine();
  expect(app.querySelector(".of-topbar")).toBeTruthy();
  expect(app.querySelector(".of-headline")?.textContent).toBe("Pick");
  expect(events.map((e) => e.type)).toEqual(["funnel_start", "step_view"]);
});

test("tapping an option with a branch jumps to the branch target", async () => {
  const { app } = await freshEngine();
  const optX = /** @type {HTMLButtonElement} */ (app.querySelectorAll(".of-option")[0]);
  optX.click();
  // 'x' branches straight to the form, skipping the content step.
  expect(app.querySelector(".of-headline")?.textContent).toBe("You");
  expect(app.querySelector(".of-form")).toBeTruthy();
});

test("linear fall-through visits the next step when no branch is set", async () => {
  const { app } = await freshEngine();
  const optY = /** @type {HTMLButtonElement} */ (app.querySelectorAll(".of-option")[1]);
  optY.click();
  expect(app.querySelector(".of-headline")?.textContent).toBe("Skipped unless Y");
});

test("form blocks submit on invalid input, then captures + advances + pipes", async () => {
  const { app, events } = await freshEngine();
  /** @type {HTMLButtonElement} */ (app.querySelectorAll(".of-option")[0]).click();

  const form = /** @type {HTMLFormElement} */ (app.querySelector(".of-form"));
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

  // Empty → still on the form, an error is shown.
  submit();
  expect(app.querySelector(".of-form")).toBeTruthy();
  expect(app.querySelector(".of-field.has-error")).toBeTruthy();

  // Fill in valid values.
  const name = /** @type {HTMLInputElement} */ (form.querySelector('[name="name"]'));
  const email = /** @type {HTMLInputElement} */ (form.querySelector('[name="email"]'));
  name.value = "Jamie"; name.dispatchEvent(new Event("input", { bubbles: true }));
  email.value = "jamie@x.co"; email.dispatchEvent(new Event("input", { bubbles: true }));
  submit();

  // On the success screen, with the name piped into the headline.
  expect(app.querySelector(".of-success")).toBeTruthy();
  expect(app.querySelector(".of-headline")?.textContent).toBe("Thanks Jamie");
  expect(events.some((e) => e.type === "lead")).toBe(true);
  expect(events.some((e) => e.type === "complete")).toBe(true);
});

test("back button returns to the previous step", async () => {
  const { app } = await freshEngine();
  /** @type {HTMLButtonElement} */ (app.querySelectorAll(".of-option")[1]).click(); // → content step
  expect(app.querySelector(".of-headline")?.textContent).toBe("Skipped unless Y");
  const back = /** @type {HTMLButtonElement} */ (app.querySelector(".of-back"));
  back.click();
  expect(app.querySelector(".of-headline")?.textContent).toBe("Pick");
});

// AGPL-3.0 §13: a networked modified version must offer its Corresponding Source
// to the visitors interacting with it. `branding.hidden` suppresses the "Powered
// by" attribution, which the licence does not require — it must never take the
// source link with it, or turning off the badge silently ends compliance.
test("the source link survives every way of hiding the branding", async () => {
  const { createFunnel } = await import("../src/index.js");
  document.body.innerHTML = '<div id="app"></div>';
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const funnel = funnelFixture();
  funnel.branding = { hidden: true, sourceLabel: "Quellcode" };
  localStorage.setItem("of.branding.hidden", "true");
  createFunnel(app, funnel, { trackEvents: false, resume: false, hideBranding: true });
  localStorage.removeItem("of.branding.hidden");

  expect(app.querySelector(".of-branding-link")).toBe(null);
  const link = /** @type {HTMLAnchorElement} */ (app.querySelector(".of-source-link"));
  expect(link).not.toBe(null);
  expect(link.textContent).toBe("Quellcode");
  expect(link.getAttribute("href")).toMatch(/^https:\/\/\S+$/);
});

test("progress bar advances as steps are completed", async () => {
  const { app } = await freshEngine();
  const fill = /** @type {HTMLElement} */ (app.querySelector(".of-progress-fill"));
  const startWidth = fill.style.width; // step 1 of 4 → 25%
  /** @type {HTMLButtonElement} */ (app.querySelectorAll(".of-option")[0]).click(); // → form (step 3)
  expect(fill.style.width).not.toBe(startWidth);
});
