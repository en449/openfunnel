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

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { FUNNELS_DIR, SLUG_RE, isInside } from "../lib/config.js";
import { cacheFunnel, invalidateFunnel, loadFunnel } from "../lib/funnels.js";
import { json, readJson } from "../lib/http.js";

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

    const targetPath = normalize(join(FUNNELS_DIR, `${slug}.json`));
    if (!isInside(targetPath, FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
    await mkdir(FUNNELS_DIR, { recursive: true });
    await writeFile(targetPath, JSON.stringify(body, null, 2), "utf8");
    invalidateFunnel(slug);
    return json({ ok: true, slug });
  }

  if (path === "/api/builder/delete" && req.method === "POST") {
    const body = await readJson(req);
    const slug = body?.slug;
    if (!slug || !SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);
    const targetPath = normalize(join(FUNNELS_DIR, `${slug}.json`));
    if (!isInside(targetPath, FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
    try {
      await unlink(targetPath);
    } catch {}
    invalidateFunnel(slug);
    return json({ ok: true, slug });
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
    const targetPath = normalize(join(FUNNELS_DIR, `${newSlug}.json`));
    // Same guard as save/delete. `newSlug` is safe by construction here, but a
    // write path that skips the check is exactly how the next edit regresses.
    if (!isInside(targetPath, FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
    await writeFile(targetPath, JSON.stringify(copyDoc, null, 2), "utf8");
    cacheFunnel(newSlug, copyDoc);
    return json({ ok: true, funnel: copyDoc });
  }

  return null;
}
