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

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";

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

/** @returns {string[]} every .js file under the engine source tree. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const violations = [];

for (const file of jsFiles(ENGINE_SRC)) {
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

if (violations.length) {
  console.error("Engine imports must be browser-resolvable:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\npackages/engine/src is served raw to the browser with no build step.");
  process.exit(1);
}

console.log("OK: every engine import is relative and extension-qualified.");
