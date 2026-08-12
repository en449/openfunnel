/**
 * @file Fails CI if code the Vercel entry point can reach uses a Bun-only API.
 *
 * The runtime has two entry points (PHASE-1-PLAN.md §4.2): `apps/runtime/server.js`
 * runs on Bun and owns `Bun.serve`, and `api/index.js` runs on Vercel's **Node**
 * runtime. Everything reachable from the second one therefore has to be
 * runtime-neutral, and nothing in `bun test` can tell you it is not — Bun
 * resolves all of it happily.
 *
 * This exists because the first deployment answered 500 to every route, funnel
 * pages included. `lib/config.js` used `import.meta.dir`, which is `undefined`
 * on Node, so `resolve(undefined, …)` threw while the module graph was still
 * loading; `lib/static.js` then called `Bun.file`, which would have taken the
 * console and the whole engine mirror down right behind it. Both were invisible
 * to 219 passing tests.
 *
 * `server.js` is exempt: it is the Bun entry point and `Bun.serve` is its job.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Trees the Vercel entry point pulls in. */
const ROOTS = ["api", "apps/runtime", "packages/engine/src"];

/** The Bun entry point, which is allowed everything Bun has. */
const EXEMPT = new Set(["apps/runtime/server.js"]);

/**
 * Bun globals that have no Node equivalent under the same name. `import.meta.dir`
 * is listed separately from `import.meta.dirname`, which Node 20.11+ does have.
 */
const BANNED = [
  { re: /(?<![\w.$])Bun\s*\./g, what: "Bun.* is undefined on Node" },
  { re: /\bimport\.meta\.dir(?!name)\b/g, what: "import.meta.dir is Bun-only — use import.meta.url" },
];

/** Same regex-only comment stripping as check-engine-imports.mjs, and the same known limits. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_, prefix) => prefix);
}

/** @returns {string[]} every .js file under `dir`, tests excluded. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "test" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const violations = [];

for (const root of ROOTS) {
  for (const file of jsFiles(join(REPO_ROOT, root))) {
    const where = relative(REPO_ROOT, file);
    if (EXEMPT.has(where)) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    for (const { re, what } of BANNED) {
      for (const match of source.matchAll(re)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${where}:${line}: ${match[0].trim()} — ${what}`);
      }
    }
  }
}

if (violations.length) {
  console.error("Code reachable from api/index.js must run on Node, not only on Bun:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\nThe Vercel entry point runs Node. A Bun-only API there is a 500 on every route.");
  process.exit(1);
}

console.log("OK: nothing on the serverless path depends on a Bun-only API.");
