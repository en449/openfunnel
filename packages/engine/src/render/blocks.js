/**
 * @file Renderers for reusable content blocks (image, video, reviews, etc.).
 * These can appear on the header of any step via `step.blocks`, and are what let
 * a `content` step act as a VSL / social-proof / storytelling screen — or a
 * `landing` step act as a full marketing page, where `step.blocks` is the page
 * body below the hero.
 *
 * Every section a landing page needs is a block rather than a landing-only
 * field, so a new section type lands here once and every step type gains it.
 */

import { el } from "../dom.js";
import { pipe } from "../piping.js";

/**
 * One call-to-action button, shared by the `cta` block, the landing hero and the
 * landing nav so all three behave identically: `url` navigates through the same
 * guard `Controller.redirect` applies, anything else advances the funnel and
 * honours `next`, letting one page offer two entry points into different branches.
 *
 * It lives here rather than in `landing.js` to keep the import one-directional —
 * `landing.js` needs `renderBlocks`, so `blocks.js` must not need `landing.js`.
 *
 * @param {import('../types.js').CtaBlock|import('../types.js').LandingCta} cta
 * @param {import('../controller.js').Controller} ctrl
 * @param {string} className
 * @param {string} fallbackLabel
 * @returns {HTMLElement}
 */
export function ctaButton(cta, ctrl, className, fallbackLabel) {
  const variant = cta.variant;
  const icon = /** @type {any} */ (cta).icon;
  return el(
    "button",
    {
      type: "button",
      class: `${className}${variant && variant !== "solid" ? ` of-cta-${variant}` : ""}`,
      onclick: () => {
        if (cta.url) return ctrl.redirect(cta.url);
        ctrl.advance({ next: cta.next });
      },
    },
    [
      icon ? el("span", { class: "of-cta-icon", text: icon }) : null,
      el("span", { text: cta.label || fallbackLabel }),
    ].filter(Boolean),
  );
}

/**
 * @param {import('../types.js').ContentBlock[]} blocks
 * @param {{ lead?: Record<string, unknown>, answers?: Record<string, unknown> }} data
 * @param {import('../types.js').Step} [step]
 * @param {import('../controller.js').Controller} [ctrl]
 * @returns {HTMLElement}
 */
export function renderBlocks(blocks, data, step, ctrl) {
  const wrap = el("div", { class: "of-blocks" });
  /** @type {number | null} */
  let draggedBlockIdx = null;

  blocks.forEach((block, idx) => {
    const node = renderBlock(block, data, ctrl);
    if (ctrl?.isEditor && step) {
      node.classList.add("is-block-draggable");
      node.setAttribute("draggable", "true");
      node.setAttribute("data-block-idx", String(idx));

      const handle = el("span", { class: "of-drag-handle-block", text: "⋮⋮ Drag Block", title: "Drag to reorder block on canvas" });
      node.prepend(handle);

      node.addEventListener("dragstart", (e) => {
        draggedBlockIdx = idx;
        node.classList.add("is-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(idx));
        }
      });

      node.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = node.getBoundingClientRect();
        const isAfter = e.clientY > rect.top + rect.height / 2;
        node.classList.toggle("drop-after", isAfter);
        node.classList.toggle("drop-before", !isAfter);
        node.classList.add("drag-over");
      });

      node.addEventListener("dragleave", () => {
        node.classList.remove("drag-over", "drop-before", "drop-after");
      });

      node.addEventListener("drop", (e) => {
        e.preventDefault();
        node.classList.remove("drag-over", "drop-before", "drop-after");
        if (draggedBlockIdx === null) return;
        const rect = node.getBoundingClientRect();
        const isAfter = e.clientY > rect.top + rect.height / 2;
        let targetIdx = isAfter ? idx + 1 : idx;

        const movedBlocks = [...blocks];
        const [moved] = movedBlocks.splice(draggedBlockIdx, 1);
        if (draggedBlockIdx < targetIdx) targetIdx--;
        movedBlocks.splice(targetIdx, 0, moved);

        step.blocks = movedBlocks;
        if (window.parent && window.parent !== window) {
          // Same-origin builder only — never "*", or any site that frames this
          // funnel would receive the message too.
          window.parent.postMessage(
            { type: "of_reorder_blocks", stepId: step.id, blocks: movedBlocks },
            window.location.origin
          );
        }
        ctrl.refresh();
      });

      node.addEventListener("dragend", () => {
        node.classList.remove("is-dragging", "drag-over", "drop-before", "drop-after");
        draggedBlockIdx = null;
      });
    }
    wrap.appendChild(node);
  });

  return wrap;
}

/**
 * @param {import('../types.js').ContentBlock} block
 * @param {{ lead?: Record<string, unknown>, answers?: Record<string, unknown> }} data
 * @param {import('../controller.js').Controller} [ctrl]  Only the `cta` block needs it.
 * @returns {HTMLElement}
 */
function renderBlock(block, data, ctrl) {
  switch (block.type) {
    case "image":
      return el("img", {
        class: "of-block-image",
        src: block.src,
        alt: block.alt || "",
        loading: "lazy",
        decoding: "async",
        style: { objectFit: block.fit || "cover", aspectRatio: block.aspect || "16/9" },
      });

    case "video":
      return renderVideo(block);

    case "text":
      return el("p", {
        class: `of-block-text of-text-${block.size || "md"} of-align-${block.align || "center"}`,
        text: pipe(block.value, data),
      });

    case "list":
      return el(
        "ul",
        { class: "of-block-list" },
        block.items.map((it) =>
          el("li", { class: "of-list-item" }, [
            el("span", { class: "of-list-icon", text: it.icon || "✓" }),
            el("span", { text: it.text }),
          ]),
        ),
      );

    case "reviews":
      return el(
        "div",
        { class: "of-block-reviews" },
        block.items.map((r) =>
          el("figure", { class: "of-review" }, [
            r.rating ? el("div", { class: "of-stars", text: "★".repeat(Math.round(r.rating)) }) : null,
            el("blockquote", { text: r.text }),
            el("figcaption", { class: "of-review-author" }, [
              r.avatar ? el("img", { class: "of-avatar", src: r.avatar, alt: "" }) : null,
              el("span", { text: r.name }),
            ]),
          ]),
        ),
      );

    case "countdown":
      return renderCountdown(block);

    case "trust":
      return el(
        "div",
        { class: "of-block-trust" },
        // A bare string is accepted as shorthand for `{ label }`. Templates and
        // hand-written funnels reach for `["Trusted by 200+ brands", …]`, and the
        // strict shape rendered those as empty spans — a silently blank row.
        (block.items || []).map((raw) => {
          const t = typeof raw === "string" ? { label: raw } : raw || {};
          return t.src
            ? el("img", { class: "of-trust-logo", src: t.src, alt: t.label || "", loading: "lazy" })
            : el("span", { class: "of-trust-label", text: t.label || "" });
        }),
      );

    case "spacer":
      return el("div", { style: { height: `${block.size ?? 12}px` } });

    case "calculator":
      return renderCalculator(block, data);

    /* ----- landing-page sections ----------------------------------------- */

    case "heading":
      return el("div", { class: `of-block-heading of-align-${block.align || "center"}` }, [
        block.eyebrow ? el("span", { class: "of-section-eyebrow", text: block.eyebrow }) : null,
        el("h2", { class: "of-section-title", text: pipe(block.value, data) }),
        block.sub ? el("p", { class: "of-section-sub", text: pipe(block.sub, data) }) : null,
      ]);

    case "features":
      return el(
        "div",
        { class: `of-block-features of-cols-${block.columns || 1}` },
        (block.items || []).map((f) =>
          el("div", { class: "of-feature" }, [
            f.image
              ? el("img", { class: "of-feature-img", src: f.image, alt: "", loading: "lazy" })
              : el("span", { class: "of-feature-icon", text: f.icon || "✦" }),
            el("div", { class: "of-feature-body" }, [
              el("h3", { class: "of-feature-title", text: pipe(f.title, data) }),
              f.text ? el("p", { class: "of-feature-text", text: pipe(f.text, data) }) : null,
            ]),
          ]),
        ),
      );

    case "steps":
      return el(
        "ol",
        { class: "of-block-steps" },
        (block.items || []).map((s, i) =>
          el("li", { class: "of-howstep" }, [
            el("span", { class: "of-howstep-num", text: String(i + 1) }),
            el("div", { class: "of-howstep-body" }, [
              el("h3", { class: "of-howstep-title", text: pipe(s.title, data) }),
              s.text ? el("p", { class: "of-howstep-text", text: pipe(s.text, data) }) : null,
            ]),
          ]),
        ),
      );

    case "stats":
      return el(
        "div",
        { class: `of-block-stats of-cols-${block.columns || 3}` },
        (block.items || []).map((s) =>
          el("div", { class: "of-stat" }, [
            el("div", { class: "of-stat-value", text: pipe(s.value, data) }),
            s.label ? el("div", { class: "of-stat-label", text: s.label }) : null,
          ]),
        ),
      );

    case "faq":
      return el(
        "div",
        { class: "of-block-faq" },
        (block.items || []).map((item) =>
          el("details", { class: "of-faq-item" }, [
            el("summary", { class: "of-faq-q", text: item.q }),
            el("p", { class: "of-faq-a", text: pipe(item.a, data) }),
          ]),
        ),
      );

    case "pricing":
      return el(
        "div",
        { class: "of-block-pricing" },
        (block.plans || []).map((plan) =>
          el("div", { class: `of-plan${plan.highlight ? " is-highlight" : ""}` }, [
            plan.badge ? el("span", { class: "of-plan-badge", text: plan.badge }) : null,
            el("h3", { class: "of-plan-name", text: plan.name }),
            el("div", { class: "of-plan-price" }, [
              el("span", { class: "of-plan-amount", text: plan.price }),
              plan.period ? el("span", { class: "of-plan-period", text: plan.period }) : null,
            ]),
            plan.features?.length
              ? el(
                  "ul",
                  { class: "of-plan-features" },
                  plan.features.map((f) =>
                    el("li", {}, [el("span", { class: "of-list-icon", text: "✓" }), el("span", { text: f })]),
                  ),
                )
              : null,
            plan.ctaLabel && ctrl
              ? el("button", {
                  type: "button",
                  class: `of-plan-cta${plan.highlight ? "" : " of-cta-outline"}`,
                  text: plan.ctaLabel,
                  onclick: () => ctrl.advance({ next: plan.next }),
                })
              : null,
          ]),
        ),
      );

    case "gallery":
      return el(
        "div",
        { class: `of-block-gallery of-gallery-${block.layout || "scroll"}` },
        (block.items || []).map((g) =>
          el("figure", { class: "of-gallery-item" }, [
            el("img", { src: g.src, alt: g.alt || "", loading: "lazy", decoding: "async" }),
            g.caption ? el("figcaption", { text: g.caption }) : null,
          ]),
        ),
      );

    case "compare":
      return el("div", { class: "of-block-compare" }, [
        comparePane(block.left, "of-compare-neg", "✕"),
        comparePane(block.right, "of-compare-pos", "✓"),
      ]);

    case "quote":
      return el("figure", { class: "of-block-quote" }, [
        block.rating ? el("div", { class: "of-stars", text: "★".repeat(Math.round(block.rating)) }) : null,
        el("blockquote", { text: pipe(block.text, data) }),
        block.name
          ? el("figcaption", { class: "of-quote-author" }, [
              block.avatar ? el("img", { class: "of-avatar", src: block.avatar, alt: "", loading: "lazy" }) : null,
              el("div", {}, [
                el("span", { class: "of-quote-name", text: block.name }),
                block.role ? el("span", { class: "of-quote-role", text: block.role }) : null,
              ]),
            ])
          : null,
      ]);

    case "cta":
      // Without a controller (a preview rendering blocks standalone) the button
      // would do nothing, so render the copy and skip the dead control.
      return el("div", { class: "of-block-cta" }, [
        ctrl
          ? ctaButton(block, ctrl, "of-cta", "Continue")
          : el("p", { class: "of-block-text of-align-center", text: block.label || "Continue" }),
        block.note ? el("p", { class: "of-cta-note", text: block.note }) : null,
      ]);

    case "divider":
      return el("div", { class: "of-block-divider" }, [
        block.label ? el("span", { class: "of-divider-label", text: block.label }) : null,
      ]);

    default:
      return el("div");
  }
}

/**
 * @param {{ title: string, items: string[] }} pane
 * @param {string} className
 * @param {string} mark
 */
function comparePane(pane, className, mark) {
  return el("div", { class: `of-compare-pane ${className}` }, [
    el("h3", { class: "of-compare-title", text: pane?.title || "" }),
    el(
      "ul",
      { class: "of-compare-list" },
      (pane?.items || []).map((text) =>
        el("li", {}, [el("span", { class: "of-compare-mark", text: mark }), el("span", { text })]),
      ),
    ),
  ]);
}

/**
 * @param {import('../types.js').CalculatorBlock} block
 * @param {{ lead?: Record<string, unknown>, answers?: Record<string, unknown> }} data
 */
function renderCalculator(block, data) {
  const currency = block.currency || "$";
  const pipedFormula = pipe(block.formula || "0", data);

  // Built first so the node exists before the async fill-in below can touch it.
  const wrap = el("div", { class: "of-block-calculator" }, [
    block.label ? el("div", { class: "of-calc-label", text: pipe(block.label, data) }) : null,
    el("div", { class: "of-calc-amount", text: currency }),
  ]);

  // The evaluator is only pulled in for steps that actually carry a calculator,
  // so a plain funnel never pays for the parser.
  import("../calculator.js").then(({ evaluateFormula }) => {
    const amountEl = wrap.querySelector(".of-calc-amount");
    if (!amountEl) return;
    const formatted = new Intl.NumberFormat().format(evaluateFormula(pipedFormula));
    amountEl.textContent = `${currency}${formatted}`;
  });

  return wrap;
}

/** @param {import('../types.js').VideoBlock} block */
function renderVideo(block) {
  const isEmbed = /youtube\.com|youtu\.be|vimeo\.com|player\./.test(block.src);
  if (isEmbed) {
    // Normalise common share urls to embeddable ones.
    let src = block.src;
    const yt = src.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/);
    if (yt) src = `https://www.youtube.com/embed/${yt[1]}`;
    return el("div", { class: "of-block-video" }, [
      el("iframe", {
        src,
        allow: "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture",
        allowfullscreen: true,
        loading: "lazy",
        title: "Video",
      }),
    ]);
  }
  return el("div", { class: "of-block-video" }, [
    el("video", {
      src: block.src,
      poster: block.poster,
      controls: block.controls !== false,
      autoplay: block.autoplay || false,
      muted: block.autoplay || false,
      playsinline: true,
    }),
  ]);
}

/** @param {import('../types.js').CountdownBlock} block */
function renderCountdown(block) {
  const wrap = el("div", { class: "of-block-countdown" }, [
    block.label ? el("div", { class: "of-countdown-label", text: block.label }) : null,
    el("div", { class: "of-countdown-clock", text: "--:--" }),
  ]);
  const clock = /** @type {HTMLElement} */ (wrap.querySelector(".of-countdown-clock"));
  const end = Date.now() + block.minutes * 60_000;
  const tick = () => {
    const remaining = Math.max(0, end - Date.now());
    const m = Math.floor(remaining / 60_000);
    const s = Math.floor((remaining % 60_000) / 1000);
    clock.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (remaining <= 0 && timer) clearInterval(timer);
  };
  const timer = setInterval(tick, 1000);
  tick();
  return wrap;
}
