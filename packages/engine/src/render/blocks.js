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
 * @returns {HTMLElement}
 */
export function renderBlocks(blocks, data) {
  const wrap = el("div", { class: "of-blocks" });
  for (const block of blocks) wrap.appendChild(renderBlock(block, data));
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

    default:
      return el("div");
  }
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
