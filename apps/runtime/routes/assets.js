/**
 * @file Static routes: the engine source, the console shell, and the two legacy
 * standalone UIs.
 *
 * Every console view is a client-side route, so each one has to survive a hard
 * refresh or a pasted link — they all resolve to the same shell, which is what
 * `APP_ROUTES` is for.
 */

import { APP_DIR, ADMIN_DIR, APP_ROUTES, BUILDER_DIR } from "../lib/config.js";
import { serveEngine, serveStaticFile } from "../lib/static.js";

/**
 * @param {Request} req
 * @param {{ path: string }} ctx
 * @returns {Promise<Response|null>} null when no static route matched.
 */
export async function handleAssets(req, ctx) {
  const { path } = ctx;

  if (path.startsWith("/_of/")) return serveEngine(path);

  // Unified SaaS application (dashboard, visual builder, leads CRM, analytics).
  if (path === "/" || APP_ROUTES.has(path) || path.startsWith("/_app/")) {
    return serveStaticFile(APP_DIR, "/_app/", path.startsWith("/_app/") ? path : "/_app/index.html");
  }

  if (path.startsWith("/_builder/")) return serveStaticFile(BUILDER_DIR, "/_builder/", path);
  if (path.startsWith("/_admin/")) return serveStaticFile(ADMIN_DIR, "/_admin/", path);

  return null;
}
