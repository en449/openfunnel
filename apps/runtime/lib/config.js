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

import { join, resolve, sep } from "node:path";

/* ========================================================================== *
 *  Paths
 * ========================================================================== */

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
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
  "/analytics",
  "/templates",
  "/settings",
]);
