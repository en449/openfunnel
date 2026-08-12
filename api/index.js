/**
 * @file The Vercel entry point. Every path routes here (see `vercel.json`), and
 * the router itself is the same `handleRequest` the Bun server runs.
 *
 * `export default { fetch }` is Vercel's Web Handler form for a function that
 * takes every HTTP method. The alternative — named `GET`/`POST` exports — is one
 * export per method and still would not cover the rest, and this is a router:
 * it decides the method itself, per route, and answers 405 where that matters.
 *
 * TWO THINGS THE ROUTER GETS FROM BUN AND NOT FROM HERE
 *
 * `server` is absent, deliberately and not as an oversight. `requireAdmin` falls
 * back to loopback trust only when it can see a socket address; with no server
 * object it cannot, so a deployment with no `ADMIN_TOKEN` refuses every
 * privileged request — including the operator's. That is the intended posture
 * (PLAN.md §7.1): the console sits behind Vercel Authentication, and a gate that
 * treats "I do not recognise this platform" as permission is not a gate.
 *
 * `clientIp` has the same problem with a different answer: it needs
 * `TRUST_PROXY=1` here, or every per-IP ceiling collapses into one shared
 * bucket. The runtime logs that once, naming the variable, rather than leaving
 * the operator to notice their rate limits behaving oddly.
 */

import { handleRequest } from "../apps/runtime/handler.js";

/**
 * The platform's own `waitUntil`, or null.
 *
 * Read off the request-context global rather than imported from
 * `@vercel/functions`, which is where that package reads it from too. The
 * invariant is zero runtime dependencies, and the cost of this internal moving
 * is bounded by the fallback below: work that must finish gets awaited instead,
 * so `/api/lead` gets slower and never lossy. That is the only failure direction
 * this endpoint is allowed to have.
 *
 * Resolved per request: the context is per-invocation, so a value captured at
 * module load would belong to whichever request happened to warm the instance.
 *
 * ponytail: internal symbol. Swap in `@vercel/functions`'s `waitUntil` if the
 * zero-dependency rule is ever relaxed for the runtime workspace.
 *
 * @returns {((p: Promise<any>) => void) | null}
 */
function platformWaitUntil() {
  const store = /** @type {any} */ (globalThis)[Symbol.for("@vercel/request-context")];
  const ctx = store?.get?.();
  return typeof ctx?.waitUntil === "function" ? (p) => ctx.waitUntil(p) : null;
}

export default {
  /**
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async fetch(req) {
    const platform = platformWaitUntil();

    /** @type {Promise<any>[]} */
    const deferred = [];
    const res = await handleRequest(req, {
      waitUntil: platform || ((p) => void deferred.push(Promise.resolve(p))),
    });

    // Only reached when the platform gave us nothing to defer with. The lead is
    // already durable in Postgres by this point — what is still pending is the
    // degraded-path fan-out, which is the only delivery a lead the queue refused
    // will ever get. Making the visitor wait for it is worse than not waiting;
    // dropping it is worse than both.
    if (deferred.length) await Promise.allSettled(deferred);

    return res;
  },
};
