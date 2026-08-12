/**
 * @file Static file serving for the console UIs and the engine source.
 *
 * `/_of/*` mirrors `packages/engine/src` 1:1, which is all the "bundling" a
 * browser needs given the engine imports its siblings with relative specifiers.
 * That is the no-build-step architecture in one function.
 *
 * Both servers validate the requested path with `isInside` after normalising,
 * not with a `startsWith` prefix test — see the note on `isInside` in config.js
 * for why the difference matters.
 */

import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { DEV, ENGINE_SRC, isInside } from "./config.js";

/**
 * Read a file, or answer 404.
 *
 * `Bun.file()` used to do this, and it does not exist on the Vercel entry
 * point's Node runtime — the console and the whole engine mirror were 500s
 * there. `readFile` buffers instead of streaming, which is the right trade for
 * what this serves: console assets and engine modules, none of them large, all
 * of them behind the same deploy.
 *
 * @param {string} target
 * @returns {Promise<Buffer|null>} null when it is missing or is a directory.
 */
async function readOrNull(target) {
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  // The self-hosted theme faces (PHASE-1-PLAN.md §4.9). Without this entry they
  // fall through to application/octet-stream — which most browsers still render,
  // so the omission would not look like a bug until one did not.
  ".woff2": "font/woff2",
};

/**
 * Headers for the operator-facing UIs. These pages hold the admin token in
 * localStorage and can drive every privileged API, so they must never be
 * framable: without `DENY`, a page that lures the operator into clicking can
 * overlay an invisible console and borrow their session. Funnel pages
 * deliberately do not get this — being embeddable is the point.
 */
const CONSOLE_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/**
 * Serve a file out of one of the app directories (the console, and the two
 * legacy standalone UIs). `pathname` is trusted only after it normalises back
 * inside `rootDir` — the same defence the funnel loader uses for slugs.
 *
 * @param {string} rootDir  directory the file must live in
 * @param {string} prefix   URL prefix to strip, e.g. "/_app/"
 * @param {string} pathname requested path
 */
export async function serveStaticFile(rootDir, prefix, pathname) {
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  const target = normalize(join(rootDir, rel));
  if (!isInside(target, rootDir)) return new Response("Forbidden", { status: 403 });

  const body = await readOrNull(target);
  if (!body) return new Response("Not found", { status: 404 });

  return new Response(body, {
    headers: {
      ...CONSOLE_HEADERS,
      "content-type": MIME[extname(target)] || "application/octet-stream",
      "cache-control": "no-cache, no-store, must-revalidate",
    },
  });
}

/**
 * Serve a file out of packages/engine/src under /_of/*. The engine imports its
 * siblings with relative specifiers, so mirroring the directory 1:1 is all the
 * "bundling" a browser needs.
 *
 * @param {string} pathname
 */
export async function serveEngine(pathname) {
  const rel = decodeURIComponent(pathname.slice("/_of/".length));
  const target = normalize(join(ENGINE_SRC, rel));
  if (!isInside(target, ENGINE_SRC)) return new Response("Forbidden", { status: 403 });

  const body = await readOrNull(target);
  if (!body) return new Response("Not found", { status: 404 });

  return new Response(body, {
    headers: {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      // Engine source is versioned with the deploy; cache hard in production.
      "cache-control": DEV ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}
