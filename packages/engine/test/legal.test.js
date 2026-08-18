/**
 * @file Impressum/Datenschutz links on the funnel footer (D1 of the DSGVO gates,
 * PHASE-2-PLAN.md §4 Decision 1). This is only the field + the render + the
 * `consent.policyUrl` fallback. The serve-time refusal for a funnel with no
 * `legal` is a later, separate change (D2) and is not exercised here.
 */
import { test, expect, beforeAll } from "bun:test";
import { installDom } from "./dom-setup.js";

beforeAll(installDom);

/**
 * @param {import('../src/types.js').FunnelLegal} [legal]
 * @param {import('../src/types.js').FunnelBranding} [branding]
 */
function funnelWith(legal, branding) {
  return {
    id: "legal-test",
    slug: "legal-test",
    legal,
    branding,
    steps: [{ id: "one", type: "content", headline: "Hi" }],
  };
}

/** @param {any} funnel @returns {Promise<HTMLElement>} */
async function mount(funnel) {
  const { createFunnel } = await import("../src/index.js");
  document.body.innerHTML = '<div id="app"></div>';
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  createFunnel(app, funnel, { trackEvents: false, resume: false });
  return app;
}

test("both legal URLs render with German default labels, before the source link", async () => {
  const app = await mount(
    funnelWith({
      impressumUrl: "https://example.de/impressum",
      privacyUrl: "https://example.de/datenschutz",
    })
  );

  const legalLinks = /** @type {HTMLAnchorElement[]} */ ([...app.querySelectorAll(".of-legal-link")]);
  expect(legalLinks.map((a) => a.textContent)).toEqual(["Impressum", "Datenschutz"]);
  expect(legalLinks.map((a) => a.getAttribute("href"))).toEqual([
    "https://example.de/impressum",
    "https://example.de/datenschutz",
  ]);
  legalLinks.forEach((a) => {
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener");
  });

  // DOM order: both legal links precede the AGPL source link.
  const footer = /** @type {HTMLElement} */ (app.querySelector(".of-branding-footer"));
  const kids = [...footer.children];
  const sourceIdx = kids.findIndex((n) => n.classList.contains("of-source-link"));
  const legalIdxs = kids.reduce(
    (acc, n, i) => (n.classList.contains("of-legal-link") ? [...acc, i] : acc),
    /** @type {number[]} */ ([])
  );
  expect(legalIdxs.length).toBe(2);
  expect(legalIdxs.every((i) => i < sourceIdx)).toBe(true);
});

test("label overrides are used when set", async () => {
  const app = await mount(
    funnelWith({
      impressumUrl: "https://example.de/impressum",
      impressumLabel: "Legal Notice",
      privacyUrl: "https://example.de/datenschutz",
      privacyLabel: "Privacy Policy",
    })
  );

  const texts = [...app.querySelectorAll(".of-legal-link")].map((a) => a.textContent);
  expect(texts).toEqual(["Legal Notice", "Privacy Policy"]);
});

test("an unnavigable impressumUrl renders no link, and the funnel still mounts", async () => {
  const app = await mount(
    funnelWith({
      impressumUrl: "javascript:alert(1)",
      privacyUrl: "https://example.de/datenschutz",
    })
  );

  const legalLinks = [...app.querySelectorAll(".of-legal-link")];
  expect(legalLinks.length).toBe(1);
  expect(legalLinks[0].textContent).toBe("Datenschutz");
  // The funnel rendered its first step normally — a bad legal URL took down
  // nothing but its own link (D2, not built here, is what would refuse to serve).
  expect(app.querySelector(".of-headline")?.textContent).toBe("Hi");
});

test("branding.hidden still renders the legal links", async () => {
  const app = await mount(
    funnelWith(
      { impressumUrl: "https://example.de/impressum", privacyUrl: "https://example.de/datenschutz" },
      { hidden: true }
    )
  );

  expect(app.querySelector(".of-branding-link")).toBeNull();
  expect(app.querySelectorAll(".of-legal-link").length).toBe(2);
});

test("the consent bar's privacy link falls back to legal.privacyUrl, and consent.policyUrl wins when both are set", async () => {
  const { buildConsentBar } = await import("../src/consent.js");

  const fallback = buildConsentBar(
    {
      ...funnelWith({ privacyUrl: "https://example.de/datenschutz" }),
      consent: { enabled: true },
    },
    () => {}
  );
  expect(fallback?.querySelector(".of-consent-link")?.getAttribute("href")).toBe(
    "https://example.de/datenschutz"
  );

  const overridden = buildConsentBar(
    {
      ...funnelWith({ privacyUrl: "https://example.de/datenschutz" }),
      consent: { enabled: true, policyUrl: "https://example.com/policy" },
    },
    () => {}
  );
  expect(overridden?.querySelector(".of-consent-link")?.getAttribute("href")).toBe(
    "https://example.com/policy"
  );
});
