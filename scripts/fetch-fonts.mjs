/**
 * @file Fetches the five self-hosted webfont families — the four the theme
 * presets name, plus JetBrains Mono for the console — and writes
 * `packages/engine/src/fonts/`: one WOFF2 per family per kept subset, and the
 * `fonts.css` that `@font-face`s them.
 *
 * PHASE-1-PLAN.md §4.9 is the design contract this implements — read Decisions
 * 2, 3 and 5 there before changing anything here.
 *
 * Run by hand, never by a build: `bun run scripts/fetch-fonts.mjs` (or
 * `node scripts/fetch-fonts.mjs`). Nothing in the request/response/serve path
 * needs it — the ten WOFF2 files and `fonts.css` are committed output, not a
 * build artifact regenerated on every install. It exists anyway so the next
 * person can answer "which version is this and where did it come from": the
 * families and their axis ranges are the table below, the source is Google
 * Fonts' css2 API on the date this last ran, and the licence for all five is
 * OFL-1.1 (`OFL.txt`, fetched separately — see that file's header).
 *
 * How it works:
 *   1. For each family, request the css2 API with a desktop Chrome User-Agent.
 *      Google keys the file format off the UA rather than an Accept header or
 *      a query param, and the default Node/Bun UA gets TTF, not WOFF2.
 *   2. The response is a flat list of `@font-face` blocks, each preceded by a
 *      `/* <subset> *\/` comment — that comment is the only thing identifying
 *      which subset a block belongs to, so blocks are paired with their
 *      subset by matching the comment immediately in front of each block
 *      rather than assumed from list position.
 *   3. Only `latin` and `latin-ext` blocks are kept (Decision 2 — the lead
 *      form has to render Turkish and Polish surnames; the other subsets Google
 *      slices are unicode-range-gated, so the browser would never fetch them
 *      even if this script kept them, and dropping them just saves repo weight).
 *   4. Each kept block's `.woff2` is downloaded to
 *      `packages/engine/src/fonts/<family-slug>-<subset>.woff2` and checked
 *      for the WOFF2 magic bytes (`wOF2`) — a non-WOFF2 body means Google
 *      served something this script did not anticipate, and that has to stop
 *      the run rather than commit a broken font silently.
 *   5. `fonts.css` is written with each block's `src:` rewritten to that local
 *      relative filename, `unicode-range` copied verbatim (it is what stops
 *      the browser downloading latin-ext on a page that never needs it), and
 *      `font-display: swap` retained.
 *
 * Idempotent: re-running overwrites all ten files and `fonts.css` with fresh
 * downloads from the same URLs, so running it twice in a row produces
 * byte-identical output (modulo Google shipping a new font revision).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "packages/engine/src/fonts");

// A modern desktop Chrome UA. Google's css2 endpoint returns WOFF2 only when it
// recognises the caller as a browser that supports it — the default Node/Bun
// fetch UA gets TTF instead, silently, with no header or status code saying so.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Each family's real variable weight axis (PHASE-1-PLAN.md §4.9 Decision 3).
// The bug this fixes: the runtime code this replaces asked every family for
// `wght@400;500;600;700;800`, five static weights, and that range runs past
// the end of Space Grotesk's actual axis (300-700).
const FAMILIES = [
  { name: "Plus Jakarta Sans", axis: "200..800" },
  { name: "Inter", axis: "100..900" },
  { name: "Space Grotesk", axis: "300..700" },
  { name: "Playfair Display", axis: "400..900" },
  { name: "JetBrains Mono", axis: "100..800" },
];

const KEPT_SUBSETS = new Set(["latin", "latin-ext"]);

/** @param {string} name @returns {string} "Plus Jakarta Sans" -> "plus-jakarta-sans" */
function slug(name) {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/** @param {{ name: string, axis: string }} family @returns {string} */
function css2Url(family) {
  const familyParam = encodeURIComponent(family.name).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${family.axis}&display=swap`;
}

/**
 * Splits a css2 response into its `@font-face` blocks, each paired with the
 * subset comment immediately in front of it. A block with no such comment
 * (Google has always emitted one per block; a change here is exactly the kind
 * of upstream surprise this script should stop on rather than paper over) is
 * left out of the result and reported by the caller as a mismatch.
 *
 * @param {string} css
 * @returns {Array<{ subset: string, block: string }>}
 */
function splitBySubset(css) {
  const blocks = [];
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
  for (const match of css.matchAll(re)) {
    blocks.push({ subset: match[1].toLowerCase(), block: match[2] });
  }
  return blocks;
}

/**
 * Pulls the fields this script needs out of one `@font-face` block. Throws if
 * a field is missing or the format is not woff2 — both mean Google returned
 * something this script was not written for.
 *
 * @param {string} block
 * @param {string} family
 * @param {string} subset
 */
function parseFontFace(block, family, subset) {
  const urlMatch = block.match(/src:\s*url\(([^)]+)\)\s*format\((['"]?)([^'")]+)\2\)/);
  const weightMatch = block.match(/font-weight:\s*([^;]+);/);
  const styleMatch = block.match(/font-style:\s*([^;]+);/);
  const displayMatch = block.match(/font-display:\s*([^;]+);/);
  const rangeMatch = block.match(/unicode-range:\s*([^;]+);/);

  if (!urlMatch || !weightMatch || !styleMatch || !displayMatch || !rangeMatch) {
    throw new Error(
      `${family} (${subset}): @font-face block is missing an expected field — Google's response ` +
        `shape changed. Block:\n${block}`,
    );
  }
  const format = urlMatch[3].toLowerCase();
  if (format !== "woff2") {
    throw new Error(
      `${family} (${subset}): expected woff2, got format('${format}') — the Chrome User-Agent ` +
        `header stopped working, or Google changed what it serves.`,
    );
  }

  return {
    url: urlMatch[1].trim(),
    weight: weightMatch[1].trim(),
    style: styleMatch[1].trim(),
    display: displayMatch[1].trim(),
    unicodeRange: rangeMatch[1].trim(),
  };
}

/**
 * Downloads a WOFF2 file and verifies the magic bytes before writing it —
 * an HTML error page saved with a `.woff2` extension is a corrupt font that
 * fails silently in the browser (bytes on disk, unusable), not a fetch error.
 *
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<number>} bytes written
 */
async function downloadWoff2(url, destPath) {
  const res = await fetch(url, { headers: { "user-agent": CHROME_UA } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== "wOF2") {
    throw new Error(
      `${url} did not start with the WOFF2 magic bytes (got "${magic}") — this is not a font file.`,
    );
  }
  writeFileSync(destPath, buf);
  return buf.length;
}

async function main() {
  mkdirSync(FONTS_DIR, { recursive: true });

  /** @type {string[]} */
  const cssBlocks = [];
  let totalBytes = 0;

  for (const family of FAMILIES) {
    const url = css2Url(family);
    const res = await fetch(url, { headers: { "user-agent": CHROME_UA } });
    if (!res.ok) {
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    }
    const css = await res.text();
    const blocks = splitBySubset(css);
    const kept = blocks.filter((b) => KEPT_SUBSETS.has(b.subset));

    const missing = [...KEPT_SUBSETS].filter((s) => !kept.some((b) => b.subset === s));
    if (missing.length) {
      throw new Error(
        `${family.name}: expected a block for [${[...KEPT_SUBSETS].join(", ")}], got ` +
          `[${blocks.map((b) => b.subset).join(", ")}] — missing ${missing.join(", ")}.`,
      );
    }

    for (const { subset, block } of kept) {
      const parsed = parseFontFace(block, family.name, subset);
      const filename = `${slug(family.name)}-${subset}.woff2`;
      const destPath = join(FONTS_DIR, filename);
      const bytes = await downloadWoff2(parsed.url, destPath);
      totalBytes += bytes;
      console.log(`wrote ${filename} (${bytes.toLocaleString()} bytes)`);

      cssBlocks.push(
        [
          "@font-face {",
          `  font-family: "${family.name}";`,
          `  font-style: ${parsed.style};`,
          `  font-weight: ${parsed.weight};`,
          `  font-display: ${parsed.display};`,
          `  src: url("./${filename}") format("woff2");`,
          `  unicode-range: ${parsed.unicodeRange};`,
          "}",
        ].join("\n"),
      );
    }
  }

  const header = [
    "/* ==========================================================================",
    "   Self-hosted webfonts: the four families the theme presets name, plus the",
    "   Inter/JetBrains Mono pair the operator console uses.",
    "",
    "   Generated by scripts/fetch-fonts.mjs — do not hand-edit. Re-run that script",
    "   to refresh these files; see its @file comment and packages/engine/src/fonts/",
    "   README.md for what it does and why the fonts live here rather than being",
    "   requested from Google at runtime (PHASE-1-PLAN.md §4.9).",
    "",
    "   latin + latin-ext only, one variable WOFF2 per family per subset. Each",
    "   family's font-weight below is that family's actual variable axis, not a",
    "   fixed list of weights.",
    "   ========================================================================== */",
    "",
  ].join("\n");

  const cssPath = join(FONTS_DIR, "fonts.css");
  writeFileSync(cssPath, header + cssBlocks.join("\n\n") + "\n");
  console.log(`wrote fonts.css (${cssBlocks.length} @font-face blocks)`);
  console.log(`\ntotal font bytes written: ${totalBytes.toLocaleString()}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
