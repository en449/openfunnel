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

/**
 * Run `fn` with `location.reload` replaced by a counter, and give back how many
 * times it was called. happy-dom provides a real `reload`, so without this the
 * withdrawal tests would navigate the test document instead of asserting.
 *
 * @param {() => void} fn
 * @returns {Promise<[number]>}
 */
async function countingReload(fn) {
  const real = location.reload;
  let calls = 0;
  // @ts-ignore -- replaceable under happy-dom; restored in the finally.
  location.reload = () => {
    calls += 1;
  };
  try {
    fn();
  } finally {
    // @ts-ignore
    location.reload = real;
  }
  return [calls];
}

beforeEach(() => {
  localStorage.clear();
  // `installPixels()` appends to `document.head`, which is shared by every test
  // in this file — a leftover tag from the previous test makes the next one's
  // "nothing is installed yet" assertion pass or fail for the wrong reason.
  // This is the cleanup that makes the pixel side effect usable as evidence.
  document.getElementById("of-gtm")?.remove();
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

  // A configured pixel, so "withheld" and "installed" are OBSERVABLE. Asserting
  // `marketingAllowed()` alone — which this test used to do — proves nothing
  // about the controller: it is a pure read of the stored decision and answers
  // the same whether or not `installPixels()` was ever called. The `#of-gtm`
  // script tag is the real side effect the gate is supposed to be holding back.
  const funnel = { ...funnelWith(true), integrations: { gtmId: "GTM-WITHHOLD" } };
  const ctrl = new Controller(container, funnel, { trackEvents: false });
  ctrl.mount();

  // The bar is on screen asking, nothing is permitted, and nothing was loaded.
  const { marketingAllowed } = await import("../src/consent.js");
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();
  expect(marketingAllowed(funnel, KEY)).toBe(false);
  expect(document.getElementById("of-gtm")).toBeNull();

  const accept = container.querySelector(".of-consent-accept");
  /** @type {any} */ (accept).click();

  // Decision recorded, bar gone, marketing permitted — and the pixel is only
  // now in the document.
  expect(container.querySelector(".of-consent-bar")).toBeNull();
  expect(marketingAllowed(funnel, KEY)).toBe(true);
  expect(document.getElementById("of-gtm")).not.toBeNull();

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

/* ===== WO-D6: withdrawal + evidence ======================================= *
 *  §8.4 requires a decision be as easy to withdraw as it was to give, and
 *  evidence of what was actually agreed to. The storage format changed to
 *  carry a timestamp and text version — the tests below pin that a decision
 *  from BEFORE that change still reads correctly, that `consentSignal()`
 *  (trap 1) did not change shape in the process, and that the withdrawal
 *  control does what it says.
 * ========================================================================== */

// The exact key format `consent.js` writes under — hardcoded here (rather than
// imported) to genuinely simulate what a build before this one left behind,
// not what the current module would produce.
const STORAGE_KEY = "openfunnel:consent:" + KEY;

test("an old bare-string decision still reads as a decision, and does not re-prompt", async () => {
  const { readDecision, buildConsentBar, marketingAllowed } = await import("../src/consent.js");
  localStorage.setItem(STORAGE_KEY, "granted"); // the pre-D6 format: no JSON, no timestamp

  expect(readDecision(KEY)).toBe("granted");
  expect(marketingAllowed(funnelWith(true), KEY)).toBe(true);
  // Undecided is the only state that shows the bar — a stored legacy decision
  // must not re-open it.
  expect(buildConsentBar(funnelWith(true), () => {})).toBeNull();
});

test("a new decision round-trips with at and v", async () => {
  const { writeDecision, readDecision, consentEvidence } = await import("../src/consent.js");
  const funnel = { ...funnelWith(true), consent: { enabled: true, textVersion: "v3" } };

  writeDecision(KEY, "granted", funnel);
  expect(readDecision(KEY)).toBe("granted");

  const stored = JSON.parse(/** @type {string} */ (localStorage.getItem(STORAGE_KEY)));
  expect(stored.d).toBe("granted");
  expect(typeof stored.at).toBe("string");
  expect(stored.v).toBe("v3");

  const evidence = consentEvidence(funnel, KEY);
  expect(evidence?.signal).toBe("granted");
  expect(evidence?.at).toBe(stored.at);
  expect(evidence?.text_version).toBe("v3");
});

test("consentEvidence is undefined with no bar, and \"pending\" before a choice", async () => {
  const { consentEvidence } = await import("../src/consent.js");

  expect(consentEvidence(funnelWith(false), KEY)).toBeUndefined();

  const evidence = consentEvidence(funnelWith(true), KEY);
  expect(evidence?.signal).toBe("pending");
  expect(evidence?.at).toBeNull();
  expect(evidence?.text_version).toBeNull();
});

test("after a withdrawal, marketingAllowed() is false again", async () => {
  const { writeDecision, clearDecision, marketingAllowed } = await import("../src/consent.js");
  const funnel = funnelWith(true);

  writeDecision(KEY, "granted", funnel);
  expect(marketingAllowed(funnel, KEY)).toBe(true);

  clearDecision(KEY);
  expect(marketingAllowed(funnel, KEY)).toBe(false);
});

test('consentSignal() still returns a plain string (trap 1)', async () => {
  const { consentSignal, writeDecision } = await import("../src/consent.js");
  const funnel = funnelWith(true);

  writeDecision(KEY, "granted", funnel);
  const signal = consentSignal(funnel, KEY);

  // The Meta CAPI forward (`apps/runtime/lib/capi.js`) compares this value to
  // "granted" directly — an object here would make that comparison silently
  // false for every lead.
  expect(typeof signal).toBe("string");
  expect(signal).toBe("granted");
});

test("the withdrawal control appears only after a decision, and clicking it brings the bar back", async () => {
  const { Controller } = await import("../src/controller.js");
  const { marketingAllowed } = await import("../src/consent.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  const ctrl = new Controller(container, funnelWith(true), { trackEvents: false });
  ctrl.mount();

  // Undecided: the bar is up, and there is nothing to withdraw yet.
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();
  expect(container.querySelector(".of-consent-manage")).toBeNull();

  /** @type {any} */ (container.querySelector(".of-consent-accept")).click();

  // Decided: the bar is gone, the footer now offers a way back.
  expect(container.querySelector(".of-consent-bar")).toBeNull();
  const manage = container.querySelector(".of-consent-manage");
  expect(manage).not.toBeNull();
  expect(marketingAllowed(funnelWith(true), KEY)).toBe(true);

  // This funnel configures no pixel, so the grant put nothing third-party in
  // the page and the withdrawal stays in place: bar back, control gone,
  // marketing blocked again exactly like before any decision existed.
  const [reloads, ] = await countingReload(() => /** @type {any} */ (manage).click());

  expect(reloads).toBe(0);
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();
  expect(container.querySelector(".of-consent-manage")).toBeNull();
  expect(marketingAllowed(funnelWith(true), KEY)).toBe(false);

  ctrl.destroy();
});

test("withdrawing a grant RELOADS when a pixel was actually installed", async () => {
  const { Controller } = await import("../src/controller.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  // Clearing the stored decision re-gates every future `_pixel()` call, but it
  // cannot unload `gtm.js` — it keeps running and keeps firing on its own
  // triggers. Without the reload the withdrawal button would withdraw nothing,
  // which is the one thing it exists to do.
  const funnel = { ...funnelWith(true), integrations: { gtmId: "GTM-WITHDRAW" } };
  const ctrl = new Controller(container, funnel, { trackEvents: false });
  ctrl.mount();
  /** @type {any} */ (container.querySelector(".of-consent-accept")).click();
  expect(document.getElementById("of-gtm")).not.toBeNull();

  const [reloads] = await countingReload(() =>
    /** @type {any} */ (container.querySelector(".of-consent-manage")).click()
  );

  expect(reloads).toBe(1);
  const { marketingAllowed } = await import("../src/consent.js");
  expect(marketingAllowed(funnel, KEY)).toBe(false);

  ctrl.destroy();
});

test("the builder's preview never reloads — it would re-fetch the funnel on disk", async () => {
  const { Controller } = await import("../src/controller.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  // `FUNNEL_BOOT_SCRIPT` sets `isEditor` inside the preview iframe and the
  // console pushes updates by postMessage precisely so nothing there reloads:
  // a reload re-fetches what is ON DISK, so an operator testing withdrawal on
  // unsaved edits would watch their own work flash away. And no third party is
  // being protected from anything in a preview.
  const funnel = { ...funnelWith(true), integrations: { gtmId: "GTM-PREVIEW" } };
  const ctrl = new Controller(container, funnel, { trackEvents: false, isEditor: true });
  ctrl.mount();
  /** @type {any} */ (container.querySelector(".of-consent-accept")).click();

  const [reloads] = await countingReload(() =>
    /** @type {any} */ (container.querySelector(".of-consent-manage")).click()
  );

  expect(reloads).toBe(0);
  // The withdrawal itself still took effect — only the cleanup was skipped.
  const { marketingAllowed } = await import("../src/consent.js");
  expect(marketingAllowed(funnel, KEY)).toBe(false);
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();

  ctrl.destroy();
});

test("a visitor with unsubmitted input is asked before the reload, and a no still withdraws", async () => {
  const { Controller } = await import("../src/controller.js");
  const { marketingAllowed } = await import("../src/consent.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  // A form step, because `saveState()` only runs on advance/back and a form's
  // `oninput` does not write into `state.lead` — so a reload here returns the
  // visitor to the right step with the fields they typed emptied. On a lead
  // funnel that is the lead.
  const funnel = {
    ...funnelWith(true),
    integrations: { gtmId: "GTM-FORM" },
    steps: [{ id: "one", type: "form", headline: "You", submitLabel: "Send", fields: [{ name: "email", type: "email" }] }],
  };
  const ctrl = new Controller(container, funnel, { trackEvents: false });
  ctrl.mount();
  /** @type {any} */ (container.querySelector(".of-consent-accept")).click();

  const field = /** @type {any} */ (container.querySelector(".of-step input"));
  expect(field).not.toBeNull();
  field.value = "half-typed@example.invalid";

  const realConfirm = globalThis.confirm;
  let asked = 0;
  // @ts-ignore -- restored in the finally below.
  globalThis.confirm = () => {
    asked += 1;
    return false; // the visitor keeps what they typed
  };
  let reloads = 0;
  try {
    [reloads] = await countingReload(() =>
      /** @type {any} */ (container.querySelector(".of-consent-manage")).click()
    );
  } finally {
    // @ts-ignore
    globalThis.confirm = realConfirm;
  }

  expect(asked).toBe(1);
  expect(reloads).toBe(0);
  // Refusing the RELOAD must never refuse the WITHDRAWAL — the decision is
  // gone and the bar is back either way.
  expect(marketingAllowed(funnel, KEY)).toBe(false);
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();

  ctrl.destroy();
});

test("a visitor who accepts the notice gets the reload", async () => {
  const { Controller } = await import("../src/controller.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  const funnel = {
    ...funnelWith(true),
    integrations: { gtmId: "GTM-FORM" },
    steps: [{ id: "one", type: "form", headline: "You", submitLabel: "Send", fields: [{ name: "email", type: "email" }] }],
  };
  const ctrl = new Controller(container, funnel, { trackEvents: false });
  ctrl.mount();
  /** @type {any} */ (container.querySelector(".of-consent-accept")).click();
  /** @type {any} */ (container.querySelector(".of-step input")).value = "half-typed@example.invalid";

  const realConfirm = globalThis.confirm;
  // @ts-ignore
  globalThis.confirm = () => true;
  let reloads = 0;
  try {
    [reloads] = await countingReload(() =>
      /** @type {any} */ (container.querySelector(".of-consent-manage")).click()
    );
  } finally {
    // @ts-ignore
    globalThis.confirm = realConfirm;
  }

  expect(reloads).toBe(1);

  ctrl.destroy();
});

test("withdrawing a DECLINE never reloads — nothing was installed to unload", async () => {
  const { Controller } = await import("../src/controller.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  // Same funnel as the test above, so the ONLY difference is which button was
  // pressed. A decline loaded nothing, so paying a reload here would throw away
  // the visitor's place in the funnel for no gain.
  const funnel = { ...funnelWith(true), integrations: { gtmId: "GTM-WITHDRAW" } };
  const ctrl = new Controller(container, funnel, { trackEvents: false });
  ctrl.mount();
  /** @type {any} */ (container.querySelector(".of-consent-decline")).click();
  expect(document.getElementById("of-gtm")).toBeNull();

  const [reloads] = await countingReload(() =>
    /** @type {any} */ (container.querySelector(".of-consent-manage")).click()
  );

  expect(reloads).toBe(0);
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();

  ctrl.destroy();
});

test("re-granting after a withdrawal installs pixels exactly like the first grant", async () => {
  const { Controller } = await import("../src/controller.js");
  const container = document.createElement("div");
  document.body.appendChild(container);

  // `marketingAllowed()` alone doesn't prove pixels were installed — it's a
  // pure read of the stored decision and stays true whether or not
  // `_grantConsent()` ever ran. A GTM integration gives an observable side
  // effect instead: `installPixels()` drops a real `#of-gtm` script tag, and
  // only a grant (first or repeated) can put it there.
  const funnel = { ...funnelWith(true), integrations: { gtmId: "GTM-TEST" } };
  const ctrl = new Controller(container, funnel, { trackEvents: false });
  ctrl.mount();

  expect(document.getElementById("of-gtm")).toBeNull();
  /** @type {any} */ (container.querySelector(".of-consent-decline")).click();
  expect(document.getElementById("of-gtm")).toBeNull();

  // Withdraw the DECLINE — the path that stays in the page, so the re-grant can
  // be observed on this same mounted controller. (Withdrawing a GRANT on a
  // funnel with a pixel reloads instead; that path has its own test above.)
  /** @type {any} */ (container.querySelector(".of-consent-manage")).click();
  expect(container.querySelector(".of-consent-bar")).not.toBeNull();

  // Grant through the bar the withdrawal brought back. This is the assertion
  // that matters: `marketingAllowed()` alone would be true here whether or not
  // `_grantConsent()` actually ran, so it is checked against a real side effect
  // — `installPixels()` dropping the `#of-gtm` script tag.
  /** @type {any} */ (container.querySelector(".of-consent-accept")).click();
  expect(document.getElementById("of-gtm")).not.toBeNull();
  // And the way back is offered again, not left stranded.
  expect(container.querySelector(".of-consent-manage")).not.toBeNull();

  ctrl.destroy();
});
