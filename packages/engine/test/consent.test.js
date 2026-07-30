/**
 * Consent gating. The point of these assertions is that a funnel which asks for
 * consent shares nothing with a third party until the visitor accepts — while a
 * funnel that does not ask keeps behaving exactly as it did before consent
 * existed, so turning the feature on is the only thing that changes anything.
 */
import { test, expect, beforeAll, beforeEach } from "bun:test";
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
});

const KEY = "quiz";

/** @param {boolean} enabled */
const funnelWith = (enabled) => ({
  id: KEY,
  slug: KEY,
  consent: enabled ? { enabled: true } : undefined,
  steps: [{ id: "one", type: "content", headline: "Hi" }],
});

beforeEach(() => {
  localStorage.clear();
});

test("a funnel without a consent bar shares as before", async () => {
  const { consentRequired, marketingAllowed, consentSignal } = await import("../src/consent.js");
  const funnel = funnelWith(false);

  expect(consentRequired(funnel)).toBe(false);
  expect(marketingAllowed(funnel, KEY)).toBe(true);
  // No signal at all, so the server keeps forwarding for existing deployments.
  expect(consentSignal(funnel, KEY)).toBeUndefined();
});

test("consent required and undecided blocks third-party sharing", async () => {
  const { marketingAllowed, consentSignal } = await import("../src/consent.js");
  const funnel = funnelWith(true);

  expect(marketingAllowed(funnel, KEY)).toBe(false);
  expect(consentSignal(funnel, KEY)).toBe("pending");
});

test("accepting allows sharing, declining keeps it blocked", async () => {
  const { marketingAllowed, consentSignal, writeDecision } = await import("../src/consent.js");
  const funnel = funnelWith(true);

  writeDecision(KEY, "granted");
  expect(marketingAllowed(funnel, KEY)).toBe(true);
  expect(consentSignal(funnel, KEY)).toBe("granted");

  writeDecision(KEY, "denied");
  expect(marketingAllowed(funnel, KEY)).toBe(false);
  expect(consentSignal(funnel, KEY)).toBe("denied");
});

test("the bar renders only while a decision is outstanding", async () => {
  const { buildConsentBar, writeDecision } = await import("../src/consent.js");

  expect(buildConsentBar(funnelWith(false), () => {})).toBeNull();

  const bar = buildConsentBar(funnelWith(true), () => {});
  expect(bar).not.toBeNull();
  expect(bar?.querySelectorAll("button").length).toBe(2);

  writeDecision(KEY, "denied");
  expect(buildConsentBar(funnelWith(true), () => {})).toBeNull();
});

test("pressing accept records the decision and reports it once", async () => {
  const { buildConsentBar, readDecision } = await import("../src/consent.js");
  /** @type {string[]} */
  const decisions = [];
  const bar = buildConsentBar(funnelWith(true), (d) => decisions.push(d));
  const accept = bar?.querySelector(".of-consent-accept");

  /** @type {any} */ (accept).click();

  expect(decisions).toEqual(["granted"]);
  expect(readDecision(KEY)).toBe("granted");
});

test("the controller withholds pixels until consent is granted", async () => {
  const { Controller } = await import("../src/controller.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  const ctrl = new Controller(container, funnelWith(true), { trackEvents: false });
  ctrl.mount();

  // The bar is on screen asking, and nothing is permitted yet.
  const { marketingAllowed } = await import("../src/consent.js");
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();
  expect(marketingAllowed(funnelWith(true), KEY)).toBe(false);

  const accept = container.querySelector(".of-consent-accept");
  /** @type {any} */ (accept).click();

  // Decision recorded, bar gone, and marketing is now permitted.
  expect(container.querySelector(".of-consent-bar")).toBeNull();
  expect(marketingAllowed(funnelWith(true), KEY)).toBe(true);

  ctrl.destroy();
});
