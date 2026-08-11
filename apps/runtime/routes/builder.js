/**
 * @file `/api/builder/*` — the funnel document write path.
 *
 * PRIVILEGED. The router runs `isCrossSiteRequest` and `requireAdmin` before
 * dispatching here; these handlers do no auth of their own and must not be
 * reachable from anywhere else.
 *
 * That gate is what makes the engine's trust in a funnel document sound. The
 * engine renders `step.consent` as HTML, and a funnel page shares an origin with
 * the console — so anything that weakens the write path re-opens stored XSS on
 * the origin holding the admin token.
 *
 * Every route that touches a file validates against `SLUG_RE` *and* checks the
 * resolved path is still `isInside(FUNNELS_DIR)`. Copy that pattern for any new
 * file-touching route; the redundancy is deliberate.
 */

import { join, normalize } from "node:path";
import { FUNNELS_DIR, SLUG_RE, isInside } from "../lib/config.js";
import { cacheFunnel, loadFunnel, removeFunnel, saveFunnel } from "../lib/funnels.js";
import { json, readJson } from "../lib/http.js";
import { errSummary } from "../lib/log.js";

/**
 * @param {Request} req
 * @param {{ path: string }} ctx
 * @returns {Promise<Response|null>} null when no builder route matched.
 */
export async function handleBuilder(req, ctx) {
  const { path } = ctx;

  // The unredacted document, for editing. The public /api/funnels/:slug strips
  // the webhook URL and secret, so the builder has to read them from here —
  // otherwise saving would silently blank out whatever it could not see.
  if (path.startsWith("/api/builder/funnel/") && req.method === "GET") {
    const funnel = await loadFunnel(path.slice("/api/builder/funnel/".length));
    if (!funnel) return json({ error: "not_found" }, 404);
    return json(funnel, 200, { "cache-control": "no-store" });
  }

  if (path === "/api/builder/save" && req.method === "POST") {
    const body = await readJson(req);
    if (!body || !body.slug || !Array.isArray(body.steps)) {
      return json({ error: "invalid_funnel" }, 400);
    }
    const slug = body.slug;
    if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);
    if (!containable(slug)) return json({ error: "forbidden_path" }, 403);

    return storeWrite(() => saveFunnel(slug, body, { clientId: body.clientId }), slug);
  }

  if (path === "/api/builder/delete" && req.method === "POST") {
    const body = await readJson(req);
    const slug = body?.slug;
    if (!slug || !SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);
    if (!containable(slug)) return json({ error: "forbidden_path" }, 403);

    return storeWrite(() => removeFunnel(slug), slug);
  }

  if (path === "/api/builder/duplicate" && req.method === "POST") {
    const body = await readJson(req);
    const slug = body?.slug;
    if (!slug || !SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);
    const source = await loadFunnel(slug);
    if (!source) return json({ error: "not_found" }, 404);

    // Trim the base so the derived slug still fits SLUG_RE's 64-char budget.
    // Without this a long source slug produces a copy that is written to disk
    // and then unloadable, because `loadFunnel` rejects the over-long name.
    const suffix = `-copy-${Date.now().toString(36).slice(-4)}`;
    const newSlug = `${slug.slice(0, 64 - suffix.length)}${suffix}`;
    if (!SLUG_RE.test(newSlug)) return json({ error: "invalid_slug" }, 400);

    const copyDoc = { ...source, id: newSlug, slug: newSlug, name: `${source.name || slug} (Copy)` };
    // Same guard as save/delete. `newSlug` is safe by construction here, but a
    // write path that skips the check is exactly how the next edit regresses.
    if (!containable(newSlug)) return json({ error: "forbidden_path" }, 403);

    const failed = await storeWrite(() => saveFunnel(newSlug, copyDoc), newSlug, { silent: true });
    if (failed) return failed;
    cacheFunnel(newSlug, copyDoc);
    return json({ ok: true, funnel: copyDoc });
  }

  return null;
}

/* ========================================================================== *
 *  Shared write plumbing
 * ========================================================================== */

/**
 * Would this slug resolve to a path inside FUNNELS_DIR?
 *
 * Kept even when the store is Postgres and no file is touched. It costs a path
 * join, it is still correct if the deployment falls back to the file store, and
 * the invariant it encodes — a route that writes validates the slug AND the
 * resolved path — is one that stops holding the moment somebody makes it
 * conditional.
 *
 * @param {string} slug  Already matched against SLUG_RE by the caller.
 */
function containable(slug) {
  return isInside(normalize(join(FUNNELS_DIR, `${slug}.json`)), FUNNELS_DIR);
}

/**
 * Run a store write and turn its failures into responses the console can act on.
 *
 * `client_missing` / `client_ambiguous` are the two an operator can actually fix
 * — the builder has no client picker until Phase 2, so a funnel saved while
 * there is more than one client has to say so rather than pick one.
 *
 * @param {() => Promise<void>} write
 * @param {string} slug
 * @param {{ silent?: boolean }} [opts]  silent: return null on success, for callers with their own reply.
 */
async function storeWrite(write, slug, opts = {}) {
  try {
    await write();
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === "client_missing" || code === "client_ambiguous") {
      return json({ error: code }, 400);
    }
    console.warn(`[runtime] funnel "${slug}" write failed: ${errSummary(err)}`);
    return json({ error: "save_failed" }, 502);
  }
  return opts.silent ? null : json({ ok: true, slug });
}
