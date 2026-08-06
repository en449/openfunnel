/**
 * @file Fails CI if any workspace package grows a runtime dependency.
 *
 * "Zero runtime dependencies" is not a preference here, it is what makes the
 * no-build-step architecture possible: the browser imports engine source
 * directly from `/_of/*`, so an npm specifier has nothing to resolve it. The
 * failure lands on a visitor's phone as a 404 mid-funnel, not on the
 * contributor who added the import. Nothing else in the repo enforces this, so
 * this script is the enforcement.
 *
 * devDependencies are allowed (happy-dom, typescript) — they never reach the
 * browser. `peerDependencies` and `optionalDependencies` are treated as runtime
 * because a consumer installing the engine would fetch them.
 *
 * `workspace:` links are allowed: `apps/runtime` depends on `@openfunnel/engine`
 * that way, which resolves to a sibling directory on disk and fetches nothing.
 * That is the monorepo wiring, not a dependency in the sense this guards.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/** @returns {string[]} every package.json in the workspace, root included. */
function packageManifests() {
  const found = [join(REPO_ROOT, "package.json")];
  for (const group of ["packages", "apps"]) {
    const dir = join(REPO_ROOT, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(dir, entry.name, "package.json");
      if (existsSync(manifest)) found.push(manifest);
    }
  }
  return found;
}

const violations = [];

for (const manifest of packageManifests()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (err) {
    violations.push(`${relative(REPO_ROOT, manifest)}: unparseable — ${err.message}`);
    continue;
  }
  for (const field of RUNTIME_FIELDS) {
    const external = Object.entries(pkg[field] || {})
      .filter(([, version]) => !String(version).startsWith("workspace:"))
      .map(([name]) => name);
    if (external.length) {
      violations.push(
        `${relative(REPO_ROOT, manifest)}: ${field} must contain only workspace: links, found ${external.join(", ")}`,
      );
    }
  }
}

if (violations.length) {
  console.error("Runtime dependencies are not allowed in this workspace:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\nThe engine is served as source to the browser; an npm specifier 404s at runtime.",
  );
  process.exit(1);
}

console.log("OK: no runtime dependencies in any workspace package.");
