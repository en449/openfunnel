/**
 * @file The router. One function, `handleRequest(req, opts)`, called by both
 * entry points: `server.js` (Bun, long-lived process) and `api/index.js`
 * (Vercel, one invocation per request).
 *
 * WHAT IT DOES
 *   GET  /f/:slug            → the funnel page (HTML shell + engine, no bundler)
 *   GET  /api/funnels/:slug  → the raw funnel JSON
 *   POST /api/lead           → lead capture   (see packages/engine/src/leads.js)
 *   POST /api/events         → analytics ingest
 *   GET  /_of/*              → the engine's ES modules + stylesheet, served raw
 *   GET  /healthz            → liveness probe
 *
 * ROUTE ORDER IS THE SECURITY MODEL
 * Everything above the privileged branch is public by design: the funnel page,
 * the engine assets, the console shell and the two ingest endpoints. Everything
 * under `/api/admin/*`, `/api/builder/*` and `/api/ai/*` is dispatched INSIDE
 * that branch, after `isCrossSiteRequest` and `requireAdmin` — so a privileged
 * handler is unreachable except through both. Do not move a handler out of that
 * branch, and do not add a privileged route under a different prefix.
 *
 * `/api/internal/*` is a SECOND such branch, built the same way but holding its
 * own secret (INTERNAL_SECRET, not ADMIN_TOKEN) because its caller is a pg_cron
 * job rather than the operator's browser. Same rule applies: the handler is
 * dispatched inside the gate.
 *
 * WHAT `opts` IS FOR, AND WHY IT IS TWO THINGS
 * Bun gives the router two things for free that a serverless platform does not:
 * an identity for the caller's socket, and a process that is still alive after
 * the response is written. Both are now passed in rather than assumed.
 *
 *   `server`    Bun's server object, or undefined. `requireAdmin` and `clientIp`
 *               are the only readers, and both treat its absence as a fact about
 *               the caller rather than a reason to guess — see their comments.
 *   `waitUntil` Where work that outlives the response goes. Absent means
 *               fire-and-forget, which is correct for a process that stays up.
 */

import { SUPABASE_ON } from "./lib/config.js";
import { isInternalPath, isPrivilegedPath, requireAdmin, requireInternal } from "./lib/auth.js";
import { CORS, PUBLIC_CORS_PATHS, isCrossSiteRequest, json } from "./lib/http.js";
import { errSummary } from "./lib/log.js";
import { handleAdmin } from "./routes/admin.js";
import { handleAi } from "./routes/ai.js";
import { handleAssets } from "./routes/assets.js";
import { handleBuilder } from "./routes/builder.js";
import { handleFunnels } from "./routes/funnels.js";
import { handleIngest } from "./routes/ingest.js";
import { handleInternal } from "./routes/internal.js";
import { handleOtp } from "./routes/otp.js";

/**
 * @param {Request} req
 * @param {{ server?: any, waitUntil?: (p: Promise<any>) => void }} [opts]
 * @returns {Promise<Response>}
 */
export async function handleRequest(req, opts = {}) {
  const { server, waitUntil } = opts;

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ctx = { url, path, server, waitUntil };

    // Only the public ingest surface is cross-origin callable. Answering every
    // path with `Allow-Origin: *` would let a preflight succeed for the
    // privileged routes below.
    if (req.method === "OPTIONS") {
      return PUBLIC_CORS_PATHS.has(path)
        ? new Response(null, { status: 204, headers: CORS })
        : new Response(null, { status: 204 });
    }

    // --- Health -------------------------------------------------------------
    if (path === "/healthz") return json({ ok: true, supabase: SUPABASE_ON });

    // --- Public surface -----------------------------------------------------
    // The engine's modules, the console shell, the funnel page and the
    // read-only funnel JSON. Each handler returns null to fall through.
    const asset = await handleAssets(req, ctx);
    if (asset) return asset;

    const funnels = await handleFunnels(req, ctx);
    if (funnels) return funnels;

    // --- Privileged surface -------------------------------------------------
    // One gate, and the handlers it guards are dispatched inside it. A route
    // under these prefixes is protected by where it lives rather than by its
    // author remembering to check — which is the point, since the gate used to
    // be an early `if` that a later handler could be written past.
    if (isPrivilegedPath(path)) {
      // Refuse before authenticating: on a loopback-trust deploy the caller is
      // already "authorised", so the browser-driven CSRF has to be stopped here.
      if (isCrossSiteRequest(req, url)) return json({ error: "cross_site_denied" }, 403);

      const denied = requireAdmin(req, server);
      if (denied) return denied;

      return (
        (await handleBuilder(req, ctx)) ??
        (await handleAdmin(req, ctx)) ??
        (await handleAi(req, ctx)) ??
        new Response("Not found", { status: 404 })
      );
    }

    // --- Machine surface ----------------------------------------------------
    // Built exactly like the branch above and for the same reason: the handler
    // is dispatched INSIDE the gate, so a future `/api/internal/*` route cannot
    // be reached without passing it. Its own secret, not ADMIN_TOKEN — the
    // caller is a pg_cron job, and tying a Vault secret's lifetime to the
    // operator's login token means rotating one silently stops the queue.
    if (isInternalPath(path)) {
      // No CORS, no OPTIONS, and the cross-site check anyway: pg_net sends no
      // Origin, so this costs the real caller nothing and means no page a
      // browser loads can ever drive the drain.
      if (isCrossSiteRequest(req, url)) return json({ error: "cross_site_denied" }, 403);

      const denied = requireInternal(req);
      if (denied) return denied;

      return (await handleInternal(req, ctx)) ?? new Response("Not found", { status: 404 });
    }

    // --- Public ingest ------------------------------------------------------
    const otp = await handleOtp(req, ctx);
    if (otp) return otp;

    const ingest = await handleIngest(req, ctx);
    if (ingest) return ingest;

    return new Response("Not found", { status: 404 });
  } catch (err) {
    // `Bun.serve`'s `error()` callback used to be the only net under this, and
    // Vercel has no equivalent — so the net moves inside the router and covers
    // both entry points. `errSummary`, never the error object: an unhandled
    // rejection from an outbound `fetch` carries the request URL on `err.path`,
    // and printing the object prints whatever credential that URL held.
    console.error(`[runtime] unhandled: ${errSummary(err)}`);
    return json({ error: "internal" }, 500);
  }
}
