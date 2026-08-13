/**
 * @file Paths, environment flags and the two primitives everything else builds
 * on (`SLUG_RE`, `isInside`).
 *
 * This module reads `process.env` exactly once, at import time, and exports the
 * results as constants. That is deliberate: it means there is one place to look
 * for "what does this deployment have configured", and a module cannot disagree
 * with another about whether, say, `DEV` is true. It also means a test that
 * needs different configuration spawns a new process rather than mutating a
 * live server's behaviour halfway through a request.
 *
 * Nothing here imports anything else from the runtime — this is the bottom of
 * the dependency graph, and keeping it that way is what stops import cycles
 * appearing as the server grows.
 */

import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/* ========================================================================== *
 *  Paths
 * ========================================================================== */

// `import.meta.dir` is Bun's, and it is `undefined` on Node — which is what the
// Vercel entry point runs on. That made `resolve(undefined, …)` throw at import
// time, so the very first deployment answered 500 to every route including the
// funnel pages. Derived from `import.meta.url` instead, which both runtimes have.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const ENGINE_SRC = join(REPO_ROOT, "packages/engine/src");
export const APP_DIR = join(REPO_ROOT, "apps/app");

export const PORT = Number(process.env.PORT || 3000);

/**
 * Interface to bind. Loopback by default, which is what the README already tells
 * operators to do and what the boot banner already claimed was happening —
 * neither was true, because `Bun.serve` was called with no `hostname` and so took
 * every interface, with no way to change it short of editing this file.
 *
 * Loopback is the safe default rather than a convenience one: with `ADMIN_TOKEN`
 * unset the admin gate trusts loopback callers, so binding `0.0.0.0` on a shared
 * or untrusted network handed the console to anyone on that network. Set
 * `HOST=0.0.0.0` deliberately — in a container, or behind a proxy — and set
 * `ADMIN_TOKEN` when you do.
 */
export const HOST = process.env.HOST || "127.0.0.1";
export const FUNNELS_DIR = resolve(process.env.FUNNELS_DIR || join(REPO_ROOT, "examples"));
export const DATA_DIR = resolve(process.env.DATA_DIR || join(REPO_ROOT, ".data"));
export const DEV = process.env.NODE_ENV !== "production";

/* ========================================================================== *
 *  Engine asset versioning
 * ========================================================================== */

/**
 * A token identifying this deploy's engine source, used as a path segment:
 * `/_of/v-<ENGINE_VERSION>/index.js`. See `serveEngine` in ./static.js and
 * PHASE-1-PLAN.md §4.9.1 for why a *path* segment and not a `?v=` query.
 *
 * The short version: engine modules import their siblings relatively, so a query
 * on the entry point never reaches `./theme.js` — the browser keeps serving that
 * from cache. A path segment is inherited by relative resolution for free.
 *
 * The value must be path-safe, must change when the source changes, and — the
 * requirement that shapes the list below — must be the SAME for every instance
 * of one deploy. A serverless deploy is many processes: if each minted its own,
 * the URL would change per cold start and the immutable cache would never be
 * worth anything. Hence three platform-supplied values that are per-DEPLOY
 * before the per-PROCESS last resort, and an explicit override ahead of all of
 * them for anyone whose platform is none of these.
 *
 * `Date.now()` is the honest floor, not a good answer: on a self-hosted install
 * it means a restart looks like a deploy (correct, just eager), and across
 * several worker processes it means each one advertises its own version. Nothing
 * breaks — the segment is decorative to the lookup, so any instance serves any
 * version — but the caching is duplicated per worker, which is the whole benefit
 * gone. Reaching it in production therefore warns once, naming `ENGINE_VERSION`.
 *
 * Hashed rather than used raw so that no deployment identifier — not secret, but
 * not the browser's business either — travels in a URL a visitor's device keeps.
 */
const versionSource =
  process.env.ENGINE_VERSION ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  // Vercel's per-deployment hostname. Present at runtime on every plan, and
  // identical across every instance of one deployment — which the two above are
  // not guaranteed to be, since exposing them to the runtime is a project toggle.
  process.env.VERCEL_URL ||
  "";

// Falling through means the version is per-PROCESS, and this is the one case
// worth saying out loud rather than degrading quietly: every replica or cold
// start then advertises its own version for byte-identical files, so a visitor
// routed across instances caches the same engine several times and the
// return-visit caching this exists for buys nothing. Nothing breaks — any
// instance serves any version — so it warns rather than refuses. Not in DEV,
// where a restart minting a new version is the wanted behaviour.
if (!versionSource && process.env.NODE_ENV === "production") {
  console.warn(
    "[openfunnel] no deploy identifier found (ENGINE_VERSION, VERCEL_DEPLOYMENT_ID, " +
      "VERCEL_GIT_COMMIT_SHA, VERCEL_URL) — engine URLs are versioned per process. " +
      "Set ENGINE_VERSION to one value per release if this runs as more than one process.",
  );
}

export const ENGINE_VERSION = createHash("sha256")
  .update(versionSource || String(Date.now()), "utf8")
  .digest("hex")
  .slice(0, 12);

/** The prefix every engine URL in a served page is built from. */
export const ENGINE_BASE = `/_of/v-${ENGINE_VERSION}`;

/**
 * Matches the version segment `serveEngine` strips off. Anchored and shaped so
 * it cannot collide with a real directory in `packages/engine/src` — nothing
 * there is named `v-<hex>`, and a request that does not carry one is still
 * served, just without the immutable cache header it has not earned.
 */
export const ENGINE_VERSION_SEGMENT_RE = /^v-[0-9a-f]{6,64}\//;

/* ========================================================================== *
 *  Optional integrations
 * ========================================================================== */

export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const SUPABASE_ON = Boolean(SUPABASE_URL && SUPABASE_KEY);

/**
 * Shared secret guarding every privileged route (the console's own APIs).
 * When unset the server still refuses privileged requests from anywhere but
 * loopback, so `bun run dev` needs no configuration while a public deploy
 * cannot be driven by a stranger. See `requireAdmin` in ./auth.js.
 */
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/**
 * Shared secret guarding `/api/internal/*` — the delivery drain, called by a
 * `pg_cron` job through `pg_net` and by nothing else.
 *
 * Deliberately NOT `ADMIN_TOKEN`. That token lives in the operator's browser and
 * gets rotated when a laptop is lost; this one lives in Supabase Vault and gets
 * rotated when the database is re-provisioned. Sharing them means rotating
 * either one silently stops the queue draining, and a queue that stopped
 * draining looks exactly like a queue with nothing in it.
 *
 * Unset means the route does not exist — `/api/internal/*` answers 404, not 401,
 * because an unconfigured endpoint should not advertise itself. A self-hoster
 * with no cron never sets it and never sees it.
 */
export const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";

/**
 * Set when the server genuinely sits behind a proxy that rewrites the client
 * address. Off by default because `x-forwarded-for` is a request header: anyone
 * can send one, so honouring it unconditionally means every per-IP limit is
 * bypassed by rotating a string. Read it through `clientIp` in ./http.js.
 */
export const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");

/* ========================================================================== *
 *  Primitives
 * ========================================================================== */

/** Slugs are user-facing URL segments — keep them boring so path joins are safe. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/**
 * Is `target` the root directory itself, or genuinely inside it?
 *
 * A bare `target.startsWith(root)` is the usual way to write this and it is
 * subtly wrong: with a root of `…/apps/app`, the sibling `…/apps/app-legacy`
 * also passes, so `/_app/..%2fapp-legacy/secret` would escape. No such sibling
 * exists today, which makes this a latent bug rather than a live one — the point
 * is that creating one must not silently open a hole. Requiring the separator
 * closes the whole class.
 *
 * The `..` still has to arrive percent-encoded to get this far: the WHATWG URL
 * parser resolves literal (and `%2e`-encoded) dot segments before routing, but
 * `%2f` survives to `decodeURIComponent`, so this check is load-bearing, not
 * decoration.
 *
 * @param {string} target  An already-`normalize`d absolute path.
 * @param {string} root    An absolute directory.
 * @returns {boolean}
 */
export function isInside(target, root) {
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return target === base || target.startsWith(base + sep);
}

/** Client-side console routes the server must answer with the app shell. */
export const APP_ROUTES = new Set([
  "/app",
  "/builder",
  "/admin",
  "/leads",
  "/delivery",
  "/analytics",
  "/templates",
  "/domains",
  "/settings",
]);
