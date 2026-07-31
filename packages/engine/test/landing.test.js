/**
 * @file Landing step + section block tests.
 *
 * Two things here are worth guarding beyond "does it render":
 *   - a landing step must NOT get the shared step header, or the headline
 *     appears twice and the sections are pushed below the fold;
 *   - every CTA route (hero, sticky, nav, mid-page block, pricing plan) has to
 *     actually move the funnel, because a landing page whose button does nothing
 *     fails silently — there is no error, just a visitor who never converts.
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
  g.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
});

/** @returns {any} */
function landingFunnel(landing = {}) {
  return {
    id: "L",
    slug: "L",
    settings: { persist: false, transition: "none" },
    steps: [
      {
        id: "home",
        type: "landing",
        headline: "Sell the click",
        subtext: "Then ask the question.",
        cta: { label: "Start" },
        ...landing,
      },
      { id: "q1", type: "choice", headline: "Pick", options: [{ id: "a", label: "A" }] },
      { id: "alt", type: "content", headline: "Alternate branch", ctaLabel: "Go" },
    ],
  };
}

async function mount(funnel) {
  const { createFunnel } = await import("../src/index.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const ctrl = createFunnel(host, funnel, { trackEvents: false, isPreview: true });
  return { ctrl, host };
}

/* ===== structure ========================================================= */

test("landing renders its own hero and not the shared step header", async () => {
  const { host } = await mount(landingFunnel());

  expect(host.querySelectorAll(".of-landing").length).toBe(1);
  expect(host.querySelector(".of-hero-headline")?.textContent).toBe("Sell the click");
  expect(host.querySelector(".of-hero-sub")?.textContent).toBe("Then ask the question.");
  // The shared header would duplicate the headline into an `.of-headline`.
  expect(host.querySelector(".of-step-header")).toBeNull();
  expect(host.querySelector(".of-headline")).toBeNull();
  expect(host.querySelectorAll("h1").length).toBe(1);
});

test("the progress bar is hidden on a landing step and returns afterwards", async () => {
  const { ctrl, host } = await mount(landingFunnel());
  const progress = host.querySelector(".of-progress");

  expect(progress?.classList.contains("is-hidden")).toBe(true);
  ctrl.advance({});
  expect(progress?.classList.contains("is-hidden")).toBe(false);
});

test("progress: true overrides the landing default", async () => {
  const { host } = await mount(landingFunnel({ progress: true }));
  expect(host.querySelector(".of-progress")?.classList.contains("is-hidden")).toBe(false);
});

test("the root carries the step type and canvas width for CSS to key off", async () => {
  const { ctrl, host } = await mount(landingFunnel({ width: "wide" }));

  expect(host.dataset.stepType).toBe("landing");
  expect(host.dataset.width).toBe("wide");
  ctrl.advance({});
  // A plain step must drop back to the phone frame, or every later step inherits
  // the landing page's full-bleed canvas.
  expect(host.dataset.stepType).toBe("choice");
  expect(host.dataset.width).toBe("phone");
});

test("piping works in the hero, eyebrow and proof line", async () => {
  const funnel = landingFunnel({
    eyebrow: "Hi {{name}}",
    headline: "Welcome back, {{name}}",
    proof: { text: "{{name}} and 400 others" },
  });
  const { ctrl, host } = await mount(funnel);
  ctrl.state.lead.name = "Ada";
  ctrl.refresh();

  expect(host.querySelector(".of-hero-headline")?.textContent).toBe("Welcome back, Ada");
  expect(host.querySelector(".of-hero-eyebrow")?.textContent).toBe("Hi Ada");
  expect(host.querySelector(".of-proof-text")?.textContent).toBe("Ada and 400 others");
});

/* ===== call to action ==================================================== */

test("the hero CTA advances the funnel", async () => {
  const { ctrl, host } = await mount(landingFunnel());
  host.querySelector(".of-hero-actions .of-cta")?.click();
  expect(ctrl.steps[ctrl.state.index].id).toBe("q1");
});

test("a CTA with `next` branches instead of falling through", async () => {
  const { ctrl, host } = await mount(landingFunnel({ cta: { label: "Go", next: "alt" } }));
  host.querySelector(".of-hero-actions .of-cta")?.click();
  expect(ctrl.steps[ctrl.state.index].id).toBe("alt");
});

test("the sticky bar repeats the CTA and advances too", async () => {
  const { ctrl, host } = await mount(landingFunnel({ stickyCta: true }));

  const sticky = host.querySelector(".of-landing-sticky .of-cta");
  expect(sticky).not.toBeNull();
  sticky?.click();
  expect(ctrl.steps[ctrl.state.index].id).toBe("q1");
});

test("the nav CTA inherits the hero's branch target", async () => {
  const funnel = landingFunnel({ cta: { label: "Go", next: "alt" }, nav: { brand: "Acme", ctaLabel: "Start" } });
  const { ctrl, host } = await mount(funnel);

  expect(host.querySelector(".of-nav-brand")?.textContent).toBe("Acme");
  host.querySelector(".of-nav-cta")?.click();
  expect(ctrl.steps[ctrl.state.index].id).toBe("alt");
});

test("a CTA with a url redirects rather than advancing", async () => {
  const { ctrl, host } = await mount(landingFunnel({ cta: { label: "Go", url: "https://example.com/x" } }));
  let redirected = "";
  ctrl.redirect = (/** @type {string} */ url) => {
    redirected = url;
  };
  ctrl.refresh();

  host.querySelector(".of-hero-actions .of-cta")?.click();
  expect(redirected).toBe("https://example.com/x");
  expect(ctrl.state.index).toBe(0);
});

/* ===== background, links and layout ====================================== */

test("a media background gets a scrim at the configured opacity", async () => {
  const funnel = landingFunnel({ background: { image: "https://cdn.test/hero.jpg", overlay: 0.7 } });
  const { host } = await mount(funnel);

  expect(host.querySelector(".of-hero-bg-media")?.getAttribute("src")).toBe("https://cdn.test/hero.jpg");
  expect(host.querySelector(".of-hero-scrim")?.style.opacity).toBe("0.7");
  // Media behind text defaults to light ink so the headline stays readable.
  expect(host.querySelector(".of-landing")?.dataset.ink).toBe("light");
});

test("an out-of-range overlay is clamped rather than passed through", async () => {
  const { host } = await mount(landingFunnel({ background: { image: "https://cdn.test/a.jpg", overlay: 9 } }));
  expect(host.querySelector(".of-hero-scrim")?.style.opacity).toBe("1");
});

test("a non-navigable nav link renders as text, not a live href", async () => {
  const funnel = landingFunnel({
    nav: {
      brand: "Acme",
      links: [
        { label: "Real", href: "https://example.com" },
        { label: "Nasty", href: "javascript:alert(1)" },
        { label: "Protocol relative", href: "//evil.example" },
      ],
    },
  });
  const { host } = await mount(funnel);

  const anchors = host.querySelectorAll(".of-nav-links a");
  expect(anchors.length).toBe(1);
  expect(anchors[0].getAttribute("href")).toBe("https://example.com");
  expect(anchors[0].getAttribute("rel")).toBe("noopener noreferrer");
  // The two refused links still render their label, just without an href.
  expect(host.querySelectorAll(".of-nav-links span.of-nav-link").length).toBe(2);
});

test("layout and height land on the page as data attributes", async () => {
  const { host } = await mount(landingFunnel({ layout: "split", height: "full" }));
  const page = host.querySelector(".of-landing");
  expect(page?.dataset.layout).toBe("split");
  expect(page?.dataset.height).toBe("full");
});

test("fullBleed defaults to a full-height hero without being told", async () => {
  const { host } = await mount(landingFunnel({ layout: "fullBleed" }));
  expect(host.querySelector(".of-landing")?.dataset.height).toBe("full");
});

/* ===== section blocks ==================================================== */

test("blocks render below the hero as the page body", async () => {
  const funnel = landingFunnel({
    blocks: [
      { type: "heading", eyebrow: "Why", value: "Because it works" },
      { type: "stats", items: [{ value: "4.8×", label: "ROAS" }] },
      {
        type: "features",
        columns: 2,
        items: [{ icon: "⚡", title: "Fast", text: "Very" }],
      },
      { type: "steps", items: [{ title: "One" }, { title: "Two" }] },
      { type: "faq", items: [{ q: "Really?", a: "Yes." }] },
      { type: "compare", left: { title: "Old", items: ["Slow"] }, right: { title: "New", items: ["Quick"] } },
      { type: "quote", text: "Great", name: "Sam", rating: 5 },
      { type: "gallery", items: [{ src: "https://cdn.test/1.jpg", caption: "One" }] },
      { type: "divider", label: "or" },
    ],
  });
  const { host } = await mount(funnel);

  const body = host.querySelector(".of-landing-body");
  expect(body).not.toBeNull();
  expect(body?.querySelector(".of-section-title")?.textContent).toBe("Because it works");
  expect(body?.querySelector(".of-stat-value")?.textContent).toBe("4.8×");
  expect(body?.querySelector(".of-block-features")?.classList.contains("of-cols-2")).toBe(true);
  expect(body?.querySelectorAll(".of-howstep").length).toBe(2);
  expect(body?.querySelector(".of-faq-q")?.textContent).toBe("Really?");
  expect(body?.querySelectorAll(".of-compare-pane").length).toBe(2);
  expect(body?.querySelector(".of-block-quote blockquote")?.textContent).toBe("Great");
  expect(body?.querySelector(".of-gallery-item img")?.getAttribute("src")).toBe("https://cdn.test/1.jpg");
  expect(body?.querySelector(".of-divider-label")?.textContent).toBe("or");

  // The hero still comes first in document order.
  const page = /** @type {any} */ (host.querySelector(".of-landing"));
  expect(page.children[0].classList.contains("of-hero")).toBe(true);
});

test("a mid-page cta block advances the funnel", async () => {
  const funnel = landingFunnel({ blocks: [{ type: "cta", label: "Go now", note: "60 seconds" }] });
  const { ctrl, host } = await mount(funnel);

  expect(host.querySelector(".of-cta-note")?.textContent).toBe("60 seconds");
  host.querySelector(".of-block-cta .of-cta")?.click();
  expect(ctrl.steps[ctrl.state.index].id).toBe("q1");
});

test("a pricing plan button branches to its own target", async () => {
  const funnel = landingFunnel({
    blocks: [
      {
        type: "pricing",
        plans: [
          { name: "Free", price: "$0", features: ["One"], ctaLabel: "Start", next: "alt" },
          { name: "Pro", price: "$49", period: "/mo", badge: "Popular", highlight: true },
        ],
      },
    ],
  });
  const { ctrl, host } = await mount(funnel);

  expect(host.querySelectorAll(".of-plan").length).toBe(2);
  expect(host.querySelector(".of-plan.is-highlight .of-plan-badge")?.textContent).toBe("Popular");
  // The second plan has no ctaLabel, so it must not render a dead button.
  expect(host.querySelectorAll(".of-plan-cta").length).toBe(1);

  host.querySelector(".of-plan-cta")?.click();
  expect(ctrl.steps[ctrl.state.index].id).toBe("alt");
});

test("trust badges accept the bare-string shorthand templates use", async () => {
  const funnel = landingFunnel({
    blocks: [{ type: "trust", items: ["Trusted by 200+ brands", { label: "SOC 2" }, { src: "https://cdn.test/l.png" }] }],
  });
  const { host } = await mount(funnel);

  const labels = [...host.querySelectorAll(".of-trust-label")].map((n) => n.textContent);
  expect(labels).toEqual(["Trusted by 200+ brands", "SOC 2"]);
  expect(host.querySelectorAll(".of-trust-logo").length).toBe(1);
});

test("blocks still render above the interaction on a non-landing step", async () => {
  const funnel = landingFunnel();
  funnel.steps[1].blocks = [{ type: "heading", value: "Above the options" }];
  const { ctrl, host } = await mount(funnel);
  ctrl.advance({});

  const step = /** @type {any} */ (host.querySelector(".of-step-choice"));
  expect(step.querySelector(".of-section-title")?.textContent).toBe("Above the options");
  // Header, then blocks, then the options — not wrapped in a landing body.
  expect(step.querySelector(".of-landing-body")).toBeNull();
  expect(step.children[0].classList.contains("of-step-header")).toBe(true);
  expect(step.children[1].classList.contains("of-blocks")).toBe(true);
});
