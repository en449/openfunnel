/**
 * @file Fails CI if the engine imports anything the browser cannot resolve.
 *
 * `/_of/*` serves `packages/engine/src` raw, so every specifier the engine uses
 * is resolved by the *browser*, not by a bundler. A bare specifier (`import x
 * from "foo"`) typechecks fine under Node resolution and then 404s on a
 * visitor's phone. So does a Node builtin (`node:fs`) and an extensionless
 * relative path (`./theme` rather than `./theme.js`).
 *
 * The failure mode is what makes this worth a CI job: it is invisible locally
 * if you only ever run `bun test`, because Bun resolves all three happily.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

const ENGINE_SRC = resolve(import.meta.dirname, "../packages/engine/src");
const REPO_ROOT = resolve(import.meta.dirname, "..");

/**
 * Matches the specifier of a static `import`/`export ... from` and of a dynamic
 * `import("...")` with a literal argument. A dynamic import built from a
 * variable is not checked — the engine has none, and this script would rather
 * miss one than block CI on a false positive.
 */
const SPECIFIER_RE =
  /(?:\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)["']([^"']+)["']/g;

/**
 * Comments have to go before matching, or the `@file` docblock in `index.js`
 * fails the build for showing consumers the published `@openfunnel/engine`
 * specifier — which is correct in that example and wrong in real code.
 *
 * Line comments are only stripped when `//` is not preceded by a colon, so a
 * `https://` inside a string survives. Blanking a comment out rather than
 * deleting it keeps the line numbers in the error messages honest.
 *
 * KNOWN LIMITATION: this is regex-only and string-unaware, so a comment opener
 * inside a string literal blinds it to imports after that point. Both of these
 * get missed:
 *
 *   const CDN = "//cdn.example.com";   // swallows the rest of the line
 *   const open = "/*";                 // swallows everything up to the next * /
 *
 * That is tolerable because engine imports sit on their own lines at the top of
 * a file, above any such string — the failure mode is a missed violation, never
 * a false alarm that blocks CI on correct code. Reach for a real parser only if
 * this ever misses something real; a dependency here would be ironic given what
 * the script exists to enforce.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_, prefix) => prefix);
}

/**
 * @param {string} dir
 * @param {string} ext
 * @returns {string[]} every file with that extension under the engine source tree.
 */
function filesWithExt(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesWithExt(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/**
 * `url()` targets in a stylesheet, the same way `@import` and `src:` spell them.
 * The optional quotes are captured out; a `url(` with no closing paren does not
 * match, which is a syntax error the browser would reject anyway.
 */
const CSS_URL_RE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/g;

const violations = [];

for (const file of filesWithExt(ENGINE_SRC, ".js")) {
  const source = stripComments(readFileSync(file, "utf8"));
  const where = relative(REPO_ROOT, file);
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const spec = match[1];
    const line = source.slice(0, match.index).split("\n").length;

    if (!spec.startsWith("./") && !spec.startsWith("../")) {
      violations.push(
        `${where}:${line}: "${spec}" is not a relative specifier — the browser cannot resolve it`,
      );
      continue;
    }
    // Relative, but the browser still needs the extension spelled out.
    if (!/\.(js|css|json)$/.test(spec)) {
      violations.push(
        `${where}:${line}: "${spec}" is missing a file extension — the browser does not guess`,
      );
    }
  }
}

/**
 * The same check for the CSS the engine serves, for the same reason and one
 * more. A `url()` the browser cannot resolve is the identical invisible 404 —
 * an @font-face just falls back to a system face, so a typo in a filename looks
 * like a design decision rather than a bug. And an *absolute* one is worse than
 * unresolvable: the fonts were self-hosted precisely to stop the funnel page
 * calling a third party (PHASE-1-PLAN.md §4.9), so a `url()` pointing off-origin
 * silently reinstates the leak the gate closed.
 */
for (const file of filesWithExt(ENGINE_SRC, ".css")) {
  // Comments go first, exactly as for JS. A CSS file explaining what a `url()`
  // used to point at — which is the sort of comment this very change invites —
  // would otherwise fail CI for a string the browser never reads. `/* … */` is
  // CSS's only comment form, so the JS stripper's line-comment half is a no-op
  // here rather than a hazard.
  const source = stripComments(readFileSync(file, "utf8"));
  const where = relative(REPO_ROOT, file);
  for (const match of source.matchAll(CSS_URL_RE)) {
    const target = match[1] ?? match[2] ?? match[3] ?? "";
    const line = source.slice(0, match.index).split("\n").length;

    // Inlined bytes go nowhere and resolve to nothing — there is nothing to check.
    if (target.startsWith("data:")) continue;

    if (!target.startsWith("./") && !target.startsWith("../")) {
      violations.push(
        `${where}:${line}: url("${target}") is not a relative path — engine CSS must never reach off-origin`,
      );
      continue;
    }
    // Relative, so it has to actually be there: strip any ?v= / #frag first.
    const asset = resolve(dirname(file), target.replace(/[?#].*$/, ""));
    if (!existsSync(asset)) {
      violations.push(`${where}:${line}: url("${target}") does not exist on disk — a 404 for every visitor`);
    }
  }
}

if (violations.length) {
  console.error("Engine imports must be browser-resolvable:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\npackages/engine/src is served raw to the browser with no build step.");
  process.exit(1);
}

console.log("OK: every engine import is relative and extension-qualified, and every CSS url() resolves.");
