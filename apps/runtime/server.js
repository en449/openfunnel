/**
 * @file The Bun entry point — `bun run dev`, `bun server.js`, and the process
 * every test in `test/` spawns. The router itself lives in ./handler.js and is
 * shared with the Vercel entry point in `api/index.js`.
 *
 * WHAT THIS FILE OWNS, AND WHY IT IS NOT IN THE ROUTER
 * Everything here is a property of running as a long-lived process on a socket:
 * the interface it binds, the port, the transport-level body ceiling, the boot
 * banner. None of it exists on a platform that hands a function one `Request`.
 *
 * It also owns the two things it passes into the router:
 *   `server`    Bun's server object. `requireAdmin` uses it to recognise a
 *               loopback caller — the reason `bun run dev` needs no token.
 *   `waitUntil` Fire-and-forget, because this process is still here after the
 *               response. The Vercel entry has to buy that guarantee.
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
 * Run:  bun run dev   (from apps/runtime)   ·   PORT=3000 bun server.js
 */

import { HOST, PORT, SUPABASE_ON, DEV, FUNNELS_DIR, DATA_DIR } from "./lib/config.js";
import { handleRequest } from "./handler.js";
import { MAX_BODY, json } from "./lib/http.js";
import { errSummary } from "./lib/log.js";

/* ========================================================================== *
 *  Listener
 * ========================================================================== */

// Only listen when this file is the entrypoint. Importing it (the egress-guard
// unit tests do) must not bind a port or print a banner.
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
  //
  // Bun-only, and deliberately not reproduced on Vercel: the platform caps a
  // request body long before this number, and `readJson` is the ceiling both
  // entry points actually share.
  maxRequestBodySize: MAX_BODY,

  fetch(req, server) {
    // Work that outlives the response just runs: this process is not going
    // anywhere between requests, which is the assumption the Vercel entry
    // cannot make. The `catch` is what keeps a rejected background promise from
    // becoming an unhandled rejection that takes the process down.
    return handleRequest(req, {
      server,
      waitUntil: (p) => void Promise.resolve(p).catch((err) => {
        console.warn(`[runtime] background task failed: ${errSummary(err)}`);
      }),
    });
  },

  // The router has its own net around the whole dispatch; this catches what
  // escapes outside it. Never the error object — see lib/log.js.
  error(err) {
    console.error(`[runtime] unhandled: ${errSummary(err)}`);
    return json({ error: "internal" }, 500);
  },
}) : null;

if (server) {
  console.log(`\n  OpenFunnel runtime → http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}`);
  console.log(`  bound:   ${HOST}${HOST === "0.0.0.0" ? "  (all interfaces — set ADMIN_TOKEN)" : ""}`);
  console.log(`  funnels: ${FUNNELS_DIR}`);
  console.log(`  data:    ${DATA_DIR}${SUPABASE_ON ? "  (+ Supabase)" : ""}\n`);

  // Rate limits, the OTP challenge and the hourly mail cap live in Postgres
  // when a database is configured AND a hash salt is set — see PHASE-1-PLAN §4.1.
  // Without both, they are Maps in this process's heap: run a second replica and
  // each one gets its own copy, so an N-instance deploy multiplies every ceiling
  // by N and an OTP issued by one instance cannot be verified by another — the
  // visitor sees a valid code rejected.
  //
  // The README says this, but a deploy is exactly when nobody is reading the
  // README, and the failure is silent: nothing errors, the limits are just
  // wider than configured. Printing it at boot is the only place an operator
  // reliably looks before scaling rather than after.
  const sharedState = SUPABASE_ON && Boolean(process.env.OTP_HASH_SALT || process.env.IP_HASH_SALT);
  if (!DEV && !sharedState) {
    console.log(
      "  [scope] Single-process state: rate limits, OTP challenges and the\n" +
      "          hourly mail cap all live in this process's memory. They are\n" +
      "          NOT shared between replicas and reset on restart.\n" +
      `          ${SUPABASE_ON ? "Set OTP_HASH_SALT to move them into Postgres." : "Configure Supabase and set OTP_HASH_SALT to move them into Postgres."}\n`,
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

export { handleRequest } from "./handler.js";
export { isInside } from "./lib/config.js";
export { isPreviewRecord } from "./lib/preview.js";
export { isSafeWebhookTarget, isSafeWebhookTargetResolved, resolveSafeTarget } from "./lib/webhook.js";
