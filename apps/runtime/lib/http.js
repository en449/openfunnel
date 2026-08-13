/**
 * @file Response constructors, the CORS surface, body parsing and client-address
 * attribution — the HTTP-level concerns every route shares.
 *
 * Two things in here are security controls rather than conveniences, and both
 * are documented at their definition: `PUBLIC_CORS_PATHS` (widening it re-opens
 * CSRF on the privileged routes) and `clientIp` (reading `x-forwarded-for`
 * directly anywhere else makes every per-IP limit bypassable).
 */

import { TRUST_PROXY } from "./config.js";

/* ========================================================================== *
 *  Response constructors
 * ========================================================================== */

/**
 * @param {unknown} body      JSON-serialisable payload.
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/**
 * Headers every HTML response carries.
 *
 * `nosniff` stops a browser from second-guessing a declared content type, and
 * the referrer policy keeps a funnel URL (which often carries campaign
 * parameters) from leaking in full to whatever a visitor clicks through to.
 *
 * Framing is deliberately NOT blocked here — a funnel is meant to be embedded on
 * the operator's marketing site, and the builder previews one in an iframe. The
 * console gets `DENY` separately in ./static.js; it is the page holding the
 * admin token, and nothing legitimately frames it.
 */
export const BASE_HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/**
 * @param {string} body
 * @param {number} [status]
 * @param {Record<string, string>} [extra]
 */
export const html = (body, status = 200, extra = {}) =>
  new Response(body, {
    status,
    headers: { ...BASE_HTML_HEADERS, ...extra },
  });

/* ========================================================================== *
 *  Cross-origin surface
 * ========================================================================== */

/** Ingest endpoints are called cross-origin from embedded funnels. */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * The only paths that may be called cross-origin. A funnel is embedded on the
 * operator's own marketing site, so ingest and the email challenge have to work
 * from another origin — nothing else does.
 *
 * Previously every path answered `OPTIONS` with `Allow-Origin: *`, which
 * green-lit the preflight for `/api/builder/*` and `/api/admin/*` too. Do not
 * widen this set: a privileged route reachable by a CORS *simple* request is a
 * stored-XSS write path onto the console's own origin.
 */
export const PUBLIC_CORS_PATHS = new Set(["/api/lead", "/api/events", "/api/otp/send", "/api/otp/verify"]);

/**
 * Reject a privileged request that a browser made from another site.
 *
 * Without this the console's own APIs are CSRF-able, and on the documented
 * default (no `ADMIN_TOKEN`, so `requireAdmin` trusts loopback) that is a real
 * takeover: `readJson` ignores `Content-Type`, so any page the operator visits
 * can `fetch("http://127.0.0.1:3000/api/builder/save", …)` as a CORS *simple*
 * request — no preflight to block it — and write a funnel document. The reply is
 * unreadable to the attacker, but the write already happened, and a funnel
 * document renders on the console's own origin where the admin token lives.
 *
 * `Origin` and `Sec-Fetch-Site` are set by the browser and cannot be forged by
 * page script. A non-browser client (curl, CI, a server-side integration) sends
 * neither and is unaffected.
 *
 * @param {Request} req
 * @param {URL} url
 * @returns {boolean} true when the call must be refused.
 */
export function isCrossSiteRequest(req, url) {
  const site = req.headers.get("sec-fetch-site");
  // Authoritative whenever the browser sends it (every current browser does),
  // and page script cannot forge it. `none` is a typed URL or a bookmark.
  if (site) return site !== "same-origin" && site !== "none";

  // Legacy fallback for a browser too old to send Sec-Fetch-*. Compare HOST, not
  // the whole origin: a TLS-terminating proxy — which is every PaaS deployment —
  // means the browser sends an `https://` Origin while this process only ever
  // sees `http://` reconstructed from the Host header. Comparing origins would
  // 403 the operator's own console on any real production setup.
  const origin = req.headers.get("origin");
  if (!origin) return false; // curl, CI, server-side integrations
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true; // unparseable Origin is not something to give the benefit of
  }
}

/* ========================================================================== *
 *  Request bodies
 * ========================================================================== */

/** Body size guard — these endpoints take small JSON, never uploads. */
export const MAX_BODY = 64 * 1024;

/**
 * Parse a JSON request body with a hard size cap.
 * @param {Request} req
 * @returns {Promise<any|null>} null when the body is missing, oversized, or invalid.
 */
export async function readJson(req) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY) return null;
  try {
    const text = await req.text();
    if (!text || text.length > MAX_BODY) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ========================================================================== *
 *  Client address
 * ========================================================================== */

let warnedAboutProxy = false;
let warnedNoSocket = false;

/**
 * The address to attribute a request to, for rate-limit keys and lead records.
 *
 * With `TRUST_PROXY` set, the left-most `x-forwarded-for` entry. Note this is only
 * as trustworthy as the proxy: an appending proxy (nginx's
 * `$proxy_add_x_forwarded_for`) leaves the caller's own value left-most, so the
 * proxy must be configured to REPLACE the header, not append to it. Without it, the socket address, which a caller
 * cannot forge.
 *
 * Deploying behind a proxy WITHOUT setting `TRUST_PROXY` is the one bad
 * combination: every request then keys to the proxy's own address, so the
 * per-IP limits apply to all traffic at once. That is loud rather than silent —
 * the first forwarded request logs how to fix it.
 *
 * Anything keyed on a client address must come through here rather than reading
 * the header itself.
 *
 * @param {Request} req
 * @param {any} server  Bun's server object, or undefined off the Vercel entry
 *   point — untyped here the same way `handler.js`'s `ctx.server` is, since no
 *   `@types/bun` is installed (see server.js).
 * @returns {string|null}
 */
export function clientIp(req, server) {
  const fwd = req.headers.get("x-forwarded-for");
  // `fwd` is checked truthy (so non-empty) just above, and splitting a
  // non-empty string always yields at least one element — the `?? fwd`
  // fallback is for `noUncheckedIndexedAccess`, not a real empty-split case.
  if (fwd && TRUST_PROXY) return (fwd.split(",")[0] ?? fwd).trim();
  if (fwd && !warnedAboutProxy) {
    warnedAboutProxy = true;
    console.warn(
      "[runtime] x-forwarded-for seen but TRUST_PROXY is not set, so per-IP limits " +
        "key on the socket address and will apply to all proxied traffic together. " +
        "Set TRUST_PROXY=1 if this server really is behind a proxy you control."
    );
  }

  // Serverless: there is no socket to ask, so with TRUST_PROXY unset this can
  // only answer null — and a null address is one shared rate-limit bucket for
  // every visitor at once, which takes the funnel down for everybody the moment
  // two people submit in the same minute. That is not a safe default, it is a
  // self-inflicted outage, so it is loud. Once per process, naming the fix.
  if (!server || typeof server.requestIP !== "function") {
    // Not when the branch above already said the same thing: both warnings name
    // TRUST_PROXY, and on a proxied serverless deployment both conditions hold.
    if (!warnedNoSocket && !warnedAboutProxy) {
      warnedNoSocket = true;
      console.warn(
        "[runtime] no socket address available (serverless) and TRUST_PROXY is not set, so every " +
          "per-IP limit now shares ONE bucket across all callers. Set TRUST_PROXY=1 — the platform " +
          "in front of this function is what writes x-forwarded-for.",
      );
    }
    return null;
  }
  return server.requestIP(req)?.address || null;
}
