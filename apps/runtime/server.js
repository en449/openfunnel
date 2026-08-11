/**
 * @file OpenFunnel public runtime — the server that actually serves funnels to
 * visitors. This file is now the router and nothing else: it owns the order
 * routes are tried in and the admin gate, and delegates everything else to
 * ./lib and ./routes.
 *
 * WHAT IT DOES
 *   GET  /f/:slug            → the funnel page (HTML shell + engine, no bundler)
 *   GET  /api/funnels/:slug  → the raw funnel JSON
 *   POST /api/lead           → lead capture   (see packages/engine/src/leads.js)
 *   POST /api/events         → analytics ingest
 *   GET  /_of/*              → the engine's ES modules + stylesheet, served raw
 *   GET  /healthz            → liveness probe
 *
 * WHY NO BUILD STEP
 * The engine is zero-dependency ESM, so the browser can import it directly.
 * That keeps the critical path to one HTML document + one CSS file + a handful
 * of small modules — the whole reason a funnel feels instant on a 4G phone.
 * Put a CDN in front of /f/:slug and /_of/* and you are done.
 *
 * STORAGE
 * Without Supabase: funnels are read from a directory of JSON files
 * (FUNNELS_DIR, default the repo's examples/), and leads and events append to
 * newline-delimited JSON under DATA_DIR while the webhook and notification mail
 * go out directly. With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set, funnels
 * live in the `funnel` table (the directory becoming a fallback), and a lead is
 * written with its delivery rows in one transaction — retried, backed off and
 * dead-lettered by the queue instead of being lost to a `console.warn`. The
 * JSONL sink is written either way. Ingest must never fail a visitor's funnel.
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
 * Run:  bun run dev   (from apps/runtime)   ·   PORT=3000 bun server.js
 */

import { HOST, PORT, SUPABASE_ON, DEV, FUNNELS_DIR, DATA_DIR } from "./lib/config.js";
import { isInternalPath, isPrivilegedPath, requireAdmin, requireInternal } from "./lib/auth.js";
import { CORS, MAX_BODY, PUBLIC_CORS_PATHS, isCrossSiteRequest, json } from "./lib/http.js";
import { handleAdmin } from "./routes/admin.js";
import { handleAi } from "./routes/ai.js";
import { handleAssets } from "./routes/assets.js";
import { handleBuilder } from "./routes/builder.js";
import { handleFunnels } from "./routes/funnels.js";
import { handleIngest } from "./routes/ingest.js";
import { handleInternal } from "./routes/internal.js";
import { handleOtp } from "./routes/otp.js";

/* ========================================================================== *
 *  Router
 * ========================================================================== */

// Only listen when this file is the entrypoint. Importing it (the egress-guard
// unit tests do) must not bind a port or print a banner — the handler takes its
// own `server` argument, so nothing inside the router depends on this binding.
const server = import.meta.main ? Bun.serve({
  port: PORT,

  // Loopback unless HOST says otherwise. Omitting this bound every interface,
  // which on a default install (no ADMIN_TOKEN, so the admin gate trusts
  // loopback) put the console in reach of the whole local network.
  hostname: HOST,

  // Refuse an oversized body at the transport layer instead of buffering it.
  //
  // `readJson` already caps at MAX_BODY, but it can only do so after Bun has
  // read the body into memory: a request with `Transfer-Encoding: chunked` sends
  // no `content-length`, so the declared-size check reads 0 and `req.text()`
  // buffers the lot. Bun's own default ceiling is 128MB, so an unauthenticated
  // caller could make `/api/lead` allocate that much per request and repeat it.
  // Setting the limit here makes Bun answer 413 before the handler runs.
  //
  // Behaviour-neutral: every route on this server takes small JSON and none
  // accepts an upload, so anything above MAX_BODY was already rejected by
  // `readJson` — this only moves the rejection earlier. The largest funnel
  // document in `examples/` is under 8KB against a 64KB budget.
  maxRequestBodySize: MAX_BODY,

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ctx = { url, path, server };

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
    // The engine's modules, the console shell, the legacy UIs, the funnel page
    // and the read-only funnel JSON. Each handler returns null to fall through.
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
  },

  error(err) {
    console.error("[runtime] unhandled:", err);
    return json({ error: "internal" }, 500);
  },
}) : null;

if (server) {
  console.log(`\n  OpenFunnel runtime → http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}`);
  console.log(`  bound:   ${HOST}${HOST === "0.0.0.0" ? "  (all interfaces — set ADMIN_TOKEN)" : ""}`);
  console.log(`  funnels: ${FUNNELS_DIR}`);
  console.log(`  data:    ${DATA_DIR}${SUPABASE_ON ? "  (+ Supabase)" : ""}\n`);

  // Every limit in this process is a Map in this process's heap: the rate-limit
  // buckets, the OTP challenges, the verified-email record and the global mail
  // cap. Run a second replica and each one gets its own copy, so an N-instance
  // deploy multiplies every ceiling by N and an OTP issued by one instance
  // cannot be verified by another — the visitor sees a valid code rejected.
  //
  // The README says this, but a deploy is exactly when nobody is reading the
  // README, and the failure is silent: nothing errors, the limits are just
  // wider than configured. Printing it at boot is the only place an operator
  // reliably looks before scaling rather than after.
  if (!DEV) {
    console.log(
      "  [scope] Single-process state: rate limits, OTP challenges and the\n" +
      "          hourly mail cap all live in this process's memory. They are\n" +
      "          NOT shared between replicas and reset on restart.\n" +
      "          Running more than one instance? You need an edge rate limit\n" +
      "          and a shared OTP store, or verification breaks and every\n" +
      "          ceiling multiplies by your replica count.\n",
    );
  }
}

/* ========================================================================== *
 *  Exports — for tests only. The server is started above when run directly.
 *
 *  Re-exported from their new homes so the egress tests keep importing one
 *  place. `isInside` and `isPreviewRecord` in particular are asserted against
 *  directly because both have been the subject of a real bug.
 * ========================================================================== */

export { isInside } from "./lib/config.js";
export { isPreviewRecord } from "./lib/preview.js";
export { isSafeWebhookTarget, isSafeWebhookTargetResolved, resolveSafeTarget } from "./lib/webhook.js";
