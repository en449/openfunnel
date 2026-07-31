/**
 * @file `landing` step — a full marketing page rendered as a funnel step.
 *
 * Every other step type asks the visitor for something. This one sells first:
 * it is what a cold ad click lands on, and its CTAs advance into the quiz, so a
 * funnel is "landing page → questions → lead" inside one document instead of a
 * separate page builder bolted onto the front.
 *
 * Two things make it unlike its siblings:
 *
 *   - It owns the whole screen. `render/index.js` skips the shared header for a
 *     landing step, because the hero draws its own eyebrow/headline/subtext with
 *     layout-specific typography, and a second copy of them above the hero would
 *     be nonsense.
 *   - `step.blocks` is the page *body below the hero*, not content above an
 *     interaction. That is deliberate: every section a landing page could want
 *     (features, pricing, FAQ, comparison…) is an ordinary `ContentBlock`, so
 *     adding one is a block type rather than a landing-only field, and `content`
 *     steps get it for free.
 *
 * Nothing here reads or writes state — CTAs call `ctrl.advance()` / `ctrl.redirect()`
 * like every other renderer.
 */

import { el, isNavigableUrl } from "../dom.js";
import { pipe } from "../piping.js";
import { renderBlocks, ctaButton } from "./blocks.js";

/**
 * @param {import('../types.js').LandingStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
export function renderLanding(step, ctrl) {
  const data = ctrl.data;
  const layout = step.layout || "centered";
  const bg = step.background || {};
  const hasMediaBg = Boolean(bg.image || bg.video);
  // Media behind text needs light ink; a flat colour keeps the theme's own.
  const ink = bg.ink || (hasMediaBg ? "light" : bg.gradient ? "light" : "");

  const page = el("div", {
    class: "of-landing",
    "data-layout": layout,
    "data-height": step.height || (layout === "fullBleed" ? "full" : "auto"),
    "data-ink": ink || null,
  });

  if (step.nav) page.appendChild(renderNav(step.nav, step, ctrl));
  page.appendChild(renderHero(step, ctrl, layout, bg, hasMediaBg, data));

  if (step.blocks?.length) {
    const body = el("div", { class: "of-landing-body" }, [renderBlocks(step.blocks, data, step, ctrl)]);
    page.appendChild(body);
  }

  if (step.footer) page.appendChild(renderFooter(step.footer));

  // The sticky bar repeats the primary CTA so a long page never strands the
  // visitor mid-scroll with the only button offscreen. It sticks inside the
  // step's own scroll container rather than being `fixed`, so it cannot end up
  // layered over the consent bar.
  if (step.stickyCta && step.cta) {
    page.appendChild(
      el("div", { class: "of-landing-sticky" }, [ctaButton(step.cta, ctrl, "of-cta", "Get started")]),
    );
  }

  return page;
}

/* ===== hero ============================================================== */

/**
 * @param {import('../types.js').LandingStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @param {string} layout
 * @param {import('../types.js').LandingBackground} bg
 * @param {boolean} hasMediaBg
 * @param {{ lead?: Record<string, unknown>, answers?: Record<string, unknown> }} data
 */
function renderHero(step, ctrl, layout, bg, hasMediaBg, data) {
  const hero = el("section", { class: "of-hero" });

  if (bg.color) hero.style.background = bg.color;
  if (bg.gradient) hero.style.backgroundImage = bg.gradient;

  if (hasMediaBg) {
    const media = bg.video
      ? el("video", {
          class: "of-hero-bg-media",
          src: bg.video,
          autoplay: true,
          muted: true,
          loop: true,
          playsinline: true,
          poster: bg.image,
          "aria-hidden": "true",
        })
      : el("img", {
          class: "of-hero-bg-media",
          src: bg.image,
          alt: "",
          "aria-hidden": "true",
          decoding: "async",
        });
    if (bg.blur) media.style.filter = `blur(${bg.blur}px)`;
    if (bg.position) media.style.objectPosition = bg.position;
    hero.appendChild(el("div", { class: "of-hero-bg" }, [media]));
    hero.appendChild(
      el("div", {
        class: "of-hero-scrim",
        style: { opacity: String(clamp01(bg.overlay ?? 0.45)) },
      }),
    );
  }

  const copy = el("div", { class: "of-hero-copy" }, [
    step.eyebrow ? el("span", { class: "of-hero-eyebrow", text: pipe(step.eyebrow, data) }) : null,
    step.headline ? el("h1", { class: "of-hero-headline", tabindex: "-1", text: pipe(step.headline, data) }) : null,
    step.subtext ? el("p", { class: "of-hero-sub", text: pipe(step.subtext, data) }) : null,
  ]);

  // `media` is the foreground shot beside/below the copy; `background` is behind
  // it. A step may use either, both, or neither.
  const foreground = step.media ? renderHeroMedia(step.media) : null;

  const actions = renderActions(step, ctrl);
  const proof = step.proof ? renderProof(step.proof, data) : null;

  if (layout === "split") {
    // Copy and shot sit side by side once there is room; stacked before that.
    copy.append(...compact([actions, proof]));
    hero.appendChild(el("div", { class: "of-hero-inner of-hero-split" }, compact([copy, foreground])));
  } else {
    hero.appendChild(
      el("div", { class: "of-hero-inner" }, compact([copy, foreground, proof, actions])),
    );
  }

  if (step.scrollHint) {
    hero.appendChild(el("div", { class: "of-hero-scroll", "aria-hidden": "true", text: "↓" }));
  }

  return hero;
}

/** @param {import('../types.js').ImageBlock|import('../types.js').VideoBlock} media */
function renderHeroMedia(media) {
  if (media.type === "video") {
    const isEmbed = /youtube\.com|youtu\.be|vimeo\.com|player\./.test(media.src || "");
    if (isEmbed) {
      let src = media.src;
      const yt = src.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/);
      if (yt) src = `https://www.youtube.com/embed/${yt[1]}`;
      return el("div", { class: "of-hero-media of-hero-media-video" }, [
        el("iframe", {
          src,
          allow: "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture",
          allowfullscreen: true,
          loading: "lazy",
          title: "Video",
        }),
      ]);
    }
    return el("div", { class: "of-hero-media of-hero-media-video" }, [
      el("video", {
        src: media.src,
        poster: media.poster,
        controls: media.controls !== false,
        autoplay: media.autoplay || false,
        muted: media.autoplay || false,
        playsinline: true,
      }),
    ]);
  }

  return el("div", { class: "of-hero-media" }, [
    el("img", {
      src: media.src,
      alt: media.alt || "",
      loading: "eager",
      decoding: "async",
      style: { objectFit: media.fit || "cover", aspectRatio: media.aspect || "4/3" },
    }),
  ]);
}

/**
 * @param {import('../types.js').LandingStep} step
 * @param {import('../controller.js').Controller} ctrl
 */
function renderActions(step, ctrl) {
  const buttons = compact([
    step.cta ? ctaButton(step.cta, ctrl, "of-cta", "Get started") : null,
    step.secondaryCta ? ctaButton(step.secondaryCta, ctrl, "of-cta of-cta-secondary", "Learn more") : null,
  ]);
  if (!buttons.length) return null;

  const note = step.cta?.note;
  return el("div", { class: "of-hero-actions" }, [
    ...buttons,
    note ? el("p", { class: "of-hero-note", text: note }) : null,
  ]);
}

/**
 * @param {import('../types.js').LandingProof} proof
 * @param {{ lead?: Record<string, unknown>, answers?: Record<string, unknown> }} data
 */
function renderProof(proof, data) {
  const avatars = (proof.avatars || []).slice(0, 6);
  return el("div", { class: "of-hero-proof" }, [
    avatars.length
      ? el(
          "div",
          { class: "of-facepile" },
          avatars.map((src) => el("img", { class: "of-facepile-img", src, alt: "", loading: "lazy" })),
        )
      : null,
    el("div", { class: "of-proof-copy" }, [
      proof.rating
        ? el("div", { class: "of-stars", text: "★".repeat(Math.round(clampRating(proof.rating))) })
        : null,
      proof.text ? el("span", { class: "of-proof-text", text: pipe(proof.text, data) }) : null,
    ]),
  ]);
}

/* ===== chrome ============================================================ */

/**
 * @param {import('../types.js').LandingNav} nav
 * @param {import('../types.js').LandingStep} step
 * @param {import('../controller.js').Controller} ctrl
 */
function renderNav(nav, step, ctrl) {
  const links = (nav.links || []).filter((l) => l.label);
  return el("nav", { class: "of-landing-nav" }, [
    nav.logo
      ? el("img", { class: "of-nav-logo", src: nav.logo, alt: nav.brand || "", loading: "eager" })
      : nav.brand
        ? el("span", { class: "of-nav-brand", text: nav.brand })
        : null,
    links.length
      ? el(
          "div",
          { class: "of-nav-links" },
          links.map((l) => safeLink(l, "of-nav-link")),
        )
      : null,
    nav.ctaLabel
      ? ctaButton({ label: nav.ctaLabel, next: step.cta?.next }, ctrl, "of-nav-cta", nav.ctaLabel)
      : null,
  ]);
}

/** @param {import('../types.js').LandingFooter} footer */
function renderFooter(footer) {
  const links = (footer.links || []).filter((l) => l.label);
  return el("footer", { class: "of-landing-footer" }, [
    links.length
      ? el(
          "div",
          { class: "of-footer-links" },
          links.map((l) => safeLink(l, "of-footer-link")),
        )
      : null,
    footer.text ? el("p", { class: "of-footer-text", text: footer.text }) : null,
  ]);
}

/**
 * A nav/footer link, or a plain span when the href is not a real web address.
 * Same reasoning as `Controller.redirect`: the document is operator-written, so
 * this is not a privilege boundary — but `javascript:` has no legitimate use in
 * a funnel link, and refusing it means a document that arrives by some other
 * route cannot execute.
 *
 * @param {import('../types.js').LandingLink} link
 * @param {string} className
 */
function safeLink(link, className) {
  if (!isNavigableUrl(link.href)) return el("span", { class: className, text: link.label });
  return el("a", {
    class: className,
    href: link.href,
    target: "_blank",
    rel: "noopener noreferrer",
    text: link.label,
  });
}

/* ===== helpers =========================================================== */

/** @param {number} n */
function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

/** @param {number} n */
function clampRating(n) {
  return Math.min(5, Math.max(0, Number(n) || 0));
}

/**
 * @template T
 * @param {Array<T|null|undefined>} list
 * @returns {T[]}
 */
function compact(list) {
  return /** @type {T[]} */ (list.filter(Boolean));
}
