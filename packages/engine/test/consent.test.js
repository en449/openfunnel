/**
 * Consent gating. The point of these assertions is that a funnel which asks for
 * consent shares nothing with a third party until the visitor accepts — while a
 * funnel that does not ask keeps behaving exactly as it did before consent
 * existed, so turning the feature on is the only thing that changes anything.
 */
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { installDom } from "./dom-setup.js";

beforeAll(installDom);

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

/* ===== webfonts ========================================================== *
 *  These used to assert that a Google font was requested only after consent.
 *  The families the presets name are now self-hosted (PHASE-1-PLAN.md §4.9), so
 *  what is asserted is stronger and simpler: mounting a funnel adds no third-
 *  party stylesheet at all, on any consent path. There is no longer a decision
 *  that changes the answer, which is the whole point of the change.
 *
 *  The assertion is deliberately "no external stylesheet", not "no Google
 *  stylesheet". Re-introducing the loader against a different CDN would be the
 *  same leak, and a test naming Google would pass through it.
 * ========================================================================== */

/** @returns {number} `<link>` tags in the head pointing at another origin. */
const externalLinkCount = () =>
  [...document.head.querySelectorAll("link[href]")].filter((l) => {
    const href = l.getAttribute("href") || "";
    return /^(https?:)?\/\//.test(href);
  }).length;

/** The head is shared across tests in this file; start each check from empty. */
const clearFontLinks = () => {
  document.head.innerHTML = "";
};

/**
 * @param {boolean} consentEnabled
 * @param {string} [font]
 */
const themedFunnel = (consentEnabled, font) => ({
  ...funnelWith(consentEnabled),
  theme: font ? { font } : undefined,
});

const PRESET_FONT = "'Plus Jakarta Sans', system-ui, sans-serif";

test("a funnel with no theme requests no webfont", async () => {
  const { Controller } = await import("../src/controller.js");
  clearFontLinks();
  const container = document.createElement("div");
  document.body.appendChild(container);

  const ctrl = new Controller(container, themedFunnel(false), { trackEvents: false });
  ctrl.mount();

  expect(externalLinkCount()).toBe(0);
  ctrl.destroy();
});

test("a preset webfont makes no third-party request, before or after consent", async () => {
  const { Controller } = await import("../src/controller.js");
  clearFontLinks();
  const container = document.createElement("div");
  document.body.appendChild(container);

  const ctrl = new Controller(container, themedFunnel(true, PRESET_FONT), { trackEvents: false });
  ctrl.mount();

  expect(externalLinkCount()).toBe(0);

  // Accepting is what used to trigger the font request. It must now change
  // nothing about the page's outbound requests.
  /** @type {any} */ (container.querySelector(".of-consent-accept")).click();

  expect(externalLinkCount()).toBe(0);
  ctrl.destroy();
});

test("a preset webfont makes no third-party request when there is no consent bar", async () => {
  const { Controller } = await import("../src/controller.js");
  clearFontLinks();
  const container = document.createElement("div");
  document.body.appendChild(container);

  // The path that leaked: no bar means nothing was ever holding the request
  // back, so a preset funnel hotlinked Google on page view.
  const ctrl = new Controller(container, themedFunnel(false, PRESET_FONT), { trackEvents: false });
  ctrl.mount();

  expect(externalLinkCount()).toBe(0);
  ctrl.destroy();
});

test("declining leaves the page just as free of third-party requests", async () => {
  const { Controller } = await import("../src/controller.js");
  clearFontLinks();
  const container = document.createElement("div");
  document.body.appendChild(container);

  const ctrl = new Controller(container, themedFunnel(true, PRESET_FONT), { trackEvents: false });
  ctrl.mount();
  /** @type {any} */ (container.querySelector(".of-consent-decline")).click();

  expect(externalLinkCount()).toBe(0);
  ctrl.destroy();
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

/* ===== navigable-URL guard =============================================== *
 *  Shared by `Controller.redirect` and the consent bar's policy link. The
 *  interesting cases are the ones a naive `startsWith("/")` waves through.
 * ========================================================================== */

test("isNavigableUrl accepts only http(s) and true same-origin paths", async () => {
  const { isNavigableUrl } = await import("../src/dom.js");

  for (const good of ["https://example.com/p", "http://example.com", "/privacy", "/a/b?c=1"]) {
    expect(isNavigableUrl(good)).toBe(true);
  }
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.com", // protocol-relative: the browser reads this as https://evil.com
    "/\\evil.com", // same hop, backslash spelling
    "",
    "   ",
    null,
    undefined,
  ]) {
    expect(isNavigableUrl(/** @type {any} */ (bad))).toBe(false);
  }
});

test("the consent bar drops a policy link it would not navigate to", async () => {
  const { buildConsentBar } = await import("../src/consent.js");
  localStorage.clear();

  const hostile = buildConsentBar(
    { ...funnelWith(true), consent: { enabled: true, policyUrl: "javascript:alert(1)" } },
    () => {}
  );
  expect(hostile?.querySelector(".of-consent-link")).toBeNull();

  const relative = buildConsentBar(
    { ...funnelWith(true), consent: { enabled: true, policyUrl: "//evil.com" } },
    () => {}
  );
  expect(relative?.querySelector(".of-consent-link")).toBeNull();

  const good = buildConsentBar(
    { ...funnelWith(true), consent: { enabled: true, policyUrl: "https://example.com/privacy" } },
    () => {}
  );
  expect(good?.querySelector(".of-consent-link")?.getAttribute("href")).toBe("https://example.com/privacy");
});
