/**
 * @file Access control for the privileged surface.
 *
 * Everything the console can do — reading leads, rewriting funnels, changing
 * mail credentials, sending mail — is privileged. These helpers are the only
 * thing standing between those routes and the open internet, so they fail
 * closed: an unrecognised caller is refused rather than allowed.
 *
 * `PRIVILEGED_PREFIXES` is the single definition of what "privileged" means.
 * The router applies the gate to that list and only then dispatches to the
 * handlers for those prefixes, so a new endpoint under one of them is protected
 * by where it lives rather than by the author remembering to check.
 */

import { timingSafeEqual } from "node:crypto";
import { ADMIN_TOKEN, INTERNAL_SECRET } from "./config.js";
import { json } from "./http.js";

/** Constant-time string compare, so a wrong token leaks no timing signal. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Route prefixes that require the admin gate.
 *
 * The router checks this list, runs the gate, and dispatches the matching
 * handlers INSIDE that branch — so a privileged handler is unreachable except
 * through `isCrossSiteRequest` + `requireAdmin`. Adding a route under one of
 * these prefixes inherits both. Adding a privileged route outside them does not,
 * so do not.
 */
export const PRIVILEGED_PREFIXES = ["/api/admin/", "/api/builder/", "/api/ai/"];

/** @param {string} path @returns {boolean} */
export function isPrivilegedPath(path) {
  return PRIVILEGED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Route prefixes the machine surface lives under — today only the delivery
 * drain. Its own list, its own gate, and its own secret, for the reason in
 * `INTERNAL_SECRET`'s comment: the caller is a `pg_cron` job, not a browser and
 * not the operator, so folding it into the admin gate would tie the lifetime of
 * a Vault secret to the lifetime of the operator's login token.
 *
 * Same structural rule as `PRIVILEGED_PREFIXES`: the router checks this list and
 * dispatches the handler INSIDE the branch, so a route added under this prefix
 * is gated by where it lives.
 */
export const INTERNAL_PREFIXES = ["/api/internal/"];

/** @param {string} path @returns {boolean} */
export function isInternalPath(path) {
  return INTERNAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Gate for `/api/internal/*`.
 *
 * 404 rather than 401 when the secret is unset: the endpoint is opt-in, and a
 * 401 tells an unauthenticated caller that a drain endpoint exists and is worth
 * guessing at. Loopback is NOT trusted here — unlike the admin gate, there is no
 * developer convenience to buy, and `pg_net` never arrives over loopback anyway.
 *
 * @param {Request} req
 * @returns {Response|null} null when the caller may proceed.
 */
export function requireInternal(req) {
  if (!INTERNAL_SECRET) return new Response("Not found", { status: 404 });
  const header = req.headers.get("authorization") || "";
  const provided = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : req.headers.get("x-internal-secret") || "";
  return safeEqual(provided, INTERNAL_SECRET) ? null : json({ error: "unauthorized" }, 401);
}

/**
 * True only for a request that arrived directly on the loopback interface.
 *
 * A forwarded header means the request crossed a proxy, so the socket address
 * belongs to that proxy and says nothing about who is calling. We refuse to
 * infer "local" in that case — otherwise anyone on the internet reaching a
 * reverse-proxied deployment would inherit localhost's privileges.
 */
const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

/** Extra hostnames allowed to use loopback trust, for reaching the console by
 *  name without a token. Comma-separated, e.g. ALLOWED_HOSTS=dev.myhost.test */
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

export function isLoopbackRequest(req, server) {
  // No server object means no socket to inspect, which is the serverless entry
  // point (`api/index.js`). The honest answer there is "not local", and it is
  // the whole of what PLAN.md §7.1 calls removing loopback trust: a Vercel
  // deployment with no ADMIN_TOKEN refuses every privileged request, from
  // everyone. The alternative is a gate that treats an unfamiliar platform as
  // permission and hands `/api/admin/*` to the internet on the first deploy
  // where an environment variable was forgotten.
  if (!server || typeof server.requestIP !== "function") return false;
  if (req.headers.get("x-forwarded-for") || req.headers.get("forwarded")) return false;
  const addr = server.requestIP(req)?.address || "";
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;

  // DNS rebinding. An attacker page served from `http://evil.tld:3000`, whose A
  // record they then flip to 127.0.0.1, reaches this process over loopback AND
  // is same-origin with itself — so the socket check passes, `isCrossSiteRequest`
  // sees `Sec-Fetch-Site: same-origin`, and being same-origin the page can READ
  // the response. Every other gate is satisfied; the `Host` header is the only
  // thing that still distinguishes the operator's own console from a rebound
  // attacker origin. Without this, `bun run dev` hands lead PII, mail settings
  // and funnel writes to any site the operator happens to visit.
  const host = (req.headers.get("host") || "").toLowerCase();
  if (LOOPBACK_HOST_RE.test(host)) return true;
  // A browser always writes `name:port` on a non-default port, and the default
  // here is 3000 — so comparing the raw header alone meant the documented
  // ALLOWED_HOSTS example could never match. Accept either form.
  return ALLOWED_HOSTS.has(host) || ALLOWED_HOSTS.has(host.replace(/:\d+$/, ""));
}

/**
 * Gate a privileged route.
 *
 * With ADMIN_TOKEN set, callers must present it as `Authorization: Bearer …`
 * or `X-Admin-Token`. Without it, only loopback callers pass — so local
 * development needs no setup, but the same binary exposed on a public
 * interface refuses to hand out leads or credentials.
 *
 * @returns {Response|null} null when the caller may proceed.
 */
export function requireAdmin(req, server) {
  if (ADMIN_TOKEN) {
    const header = req.headers.get("authorization") || "";
    const provided = header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : req.headers.get("x-admin-token") || "";
    if (safeEqual(provided, ADMIN_TOKEN)) return null;
    return json({ error: "unauthorized" }, 401);
  }
  if (isLoopbackRequest(req, server)) return null;
  return json(
    {
      error: "admin_token_required",
      hint: "This server is reachable off-host. Set ADMIN_TOKEN in the environment and send it as 'Authorization: Bearer <token>'.",
    },
    401,
  );
}
