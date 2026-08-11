/**
 * @file Static routes: the engine source and the console shell.
 *
 * Every console view is a client-side route, so each one has to survive a hard
 * refresh or a pasted link — they all resolve to the same shell, which is what
 * `APP_ROUTES` is for.
 *
 * The two legacy standalone UIs (`apps/builder`, `apps/admin`, mounted at
 * `/_builder/*` and `/_admin/*`) are gone. They were superseded by `apps/app`
 * and no longer maintained, so they were two unattended escapers on the console's
 * own origin — one of which, `builder.js`, broadcast the whole funnel document
 * including `webhookSecret` with `postMessage(doc, "*")` to whatever origin the
 * preview iframe had navigated to. Deleting a UI nobody used was cheaper than
 * maintaining a second copy of the builder's security properties.
 */

import { APP_DIR, APP_ROUTES } from "../lib/config.js";
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

  return null;
}
