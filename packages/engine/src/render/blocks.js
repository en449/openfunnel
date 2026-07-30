/**
 * @file Renderers for reusable content blocks (image, video, reviews, etc.).
 * These can appear on the header of any step via `step.blocks`, and are what let
 * a `content` step act as a VSL / social-proof / storytelling screen.
 */

import { el } from "../dom.js";
import { pipe } from "../piping.js";

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
    const node = renderBlock(block, data);
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
 * @returns {HTMLElement}
 */
function renderBlock(block, data) {
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
        block.items.map((t) =>
          t.src
            ? el("img", { class: "of-trust-logo", src: t.src, alt: t.label || "", loading: "lazy" })
            : el("span", { class: "of-trust-label", text: t.label || "" }),
        ),
      );

    case "spacer":
      return el("div", { style: { height: `${block.size ?? 12}px` } });

    case "calculator":
      return renderCalculator(block, data);

    default:
      return el("div");
  }
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
