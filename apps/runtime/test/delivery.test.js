/**
 * @file The dispatcher: what it sends, and what it tells Postgres afterwards.
 *
 * The interesting behaviour is not the POST — it is the outcome reporting. A
 * delivery that fails and is reported as permanent stops retrying forever, and a
 * delivery that fails transiently but is reported as permanent is a lead the
 * client never receives. That distinction is the whole point of the queue, so it
 * is what this file pins.
 *
 * Targets are IP literals on purpose. `resolveSafeTarget` returns early for
 * those without touching DNS, so nothing here depends on a resolver being
 * reachable or on what a public hostname happens to point at today.
 *
 * `lib/config.js` reads the environment once at import time, so the Supabase
 * variables are set before the dynamic imports rather than in a `beforeAll` —
 * same pattern and same reason as db.test.js.
 */
import { afterAll, afterEach, expect, test } from "bun:test";

process.env.SUPABASE_URL = "https://db.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// See db.test.js: server.test.js spawns the real server with `{ ...process.env }`
// and must not inherit a database that does not exist.
afterAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const DB = "https://db.test.invalid";

/** A claim as `claim_deliveries` returns one. */
const claim = (over = {}) => ({
  delivery_id: 7,
  lead_id: "11111111-1111-1111-1111-111111111111",
  attempts: 3,
  idempotency_key: "22222222-2222-2222-2222-222222222222",
  kind: "webhook",
  config: { url: "http://93.184.216.34/hook" },
  funnel_slug: "lead-gen",
  payload: { lead: { email: "visitor@example.invalid" }, answers: { goal: "growth" } },
  utm: { utm_source: "meta" },
  consent: null,
  lead_created_at: "2026-08-11T10:00:00.000Z",
  ...over,
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Stub `fetch` for both sides at once: PostgREST answers from `rpcReply`, and
 * anything else is the delivery target itself.
 *
 * @param {(fn: string, body: any) => Response} rpcReply
 * @param {(url: string, init: any) => Response} targetReply
 */
function stub(rpcReply, targetReply = () => new Response("", { status: 200 })) {
  const rpcCalls = [];
  const targetCalls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      const href = String(url);
      if (href.startsWith(DB)) {
        const fn = href.split("/rpc/")[1] || "";
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        rpcCalls.push({ fn, body });
        return rpcReply(fn, body);
      }
      targetCalls.push({ url: href, init });
      return targetReply(href, init);
    }
  );
  return { rpcCalls, targetCalls };
}

/* ========================================================================== *
 *  What goes out
 * ========================================================================== */

test("a webhook delivery carries the idempotency key the claim was issued with", async () => {
  const { dispatch } = await import("../lib/delivery.js");
  const { targetCalls } = stub(() => jsonResponse(null));

  const out = await dispatch(claim());

  expect(out.ok).toBe(true);
  expect(out.status).toBe(200);
  expect(targetCalls[0].init.headers["idempotency-key"]).toBe("22222222-2222-2222-2222-222222222222");
  expect(targetCalls[0].init.redirect).toBe("manual");
});

// The old fan-out shipped the whole record, raw IP included. The queue stores
// the IP hashed and it must not reappear on the way out to a third party.
test("the delivered body carries the lead but never the visitor's IP", async () => {
  const { dispatch } = await import("../lib/delivery.js");
  const { targetCalls } = stub(() => jsonResponse(null));

  await dispatch(claim({ payload: { lead: { email: "v@example.invalid" }, ip: "203.0.113.9" } }));

  const body = JSON.parse(targetCalls[0].init.body);
  expect(body.funnelId).toBe("lead-gen");
  expect(body.lead.email).toBe("v@example.invalid");
  expect(body.utm).toEqual({ utm_source: "meta" });
  // `ip` rode in on the payload here only because this test put it there — the
  // real ingest path strips it before the insert. Belt and braces: if a payload
  // ever carries one again, this is the assertion that fails.
  expect(JSON.stringify(body)).not.toContain("203.0.113.9");
});

/* ========================================================================== *
 *  Transient vs permanent — the distinction the queue is built on
 * ========================================================================== */

test("an HTTP failure is retried, not dead-lettered", async () => {
  const { drainOnce } = await import("../lib/delivery.js");
  const { rpcCalls } = stub(
    (fn) => jsonResponse(fn === "claim_deliveries" ? [claim()] : "pending"),
    () => new Response("nope", { status: 500 }),
  );

  const counts = await drainOnce();

  const fail = rpcCalls.find((c) => c.fn === "fail_delivery");
  expect(fail).toBeTruthy();
  expect(fail.body.p_status).toBe(500);
  // Absent means "use the function's own ceiling of 8" — anything else here
  // would turn one bad gateway response into a permanently undelivered lead.
  expect(fail.body.p_max_attempts).toBeUndefined();
  expect(counts).toEqual({ claimed: 1, done: 0, failed: 1, dead: 0 });
});

test("a target the egress guard refuses dies on the first attempt", async () => {
  const { drainOnce } = await import("../lib/delivery.js");
  const { rpcCalls, targetCalls } = stub((fn) =>
    jsonResponse(fn === "claim_deliveries" ? [claim({ config: { url: "http://127.0.0.1/hook" } })] : "dead"),
  );

  const counts = await drainOnce();

  expect(targetCalls).toHaveLength(0); // never opened the socket
  const fail = rpcCalls.find((c) => c.fn === "fail_delivery");
  expect(fail.body.p_max_attempts).toBe(0);
  expect(fail.body.p_error).toContain("blocked egress target");
  expect(counts.dead).toBe(1);
});

// The other half of that verdict, and the one that cost leads before it was
// found: `resolveSafeTarget` also returns null when it simply could not RESOLVE
// the name. A resolver having a bad minute must not dead-letter every webhook
// delivery in the system on its first attempt.
test("a host that does not resolve is retried, not dead-lettered", async () => {
  const { dispatch } = await import("../lib/delivery.js");
  stub(() => jsonResponse(null));

  // `.invalid` is reserved by RFC 2606 and never resolves — offline it fails
  // the same way, so the outcome here does not depend on a working resolver.
  const out = await dispatch(claim({ config: { url: "https://crm-of-the-client.invalid/hook" } }));

  expect(out.ok).toBe(false);
  expect(out.permanent).toBeUndefined();
  expect(out.error).toContain("did not resolve");
});

// The schema's check constraint allows `sheet`, and nothing dispatches it yet.
// Retrying for twelve hours would make a target that can never work look like a
// slow one; dying immediately puts it in front of the operator.
test("a kind with no dispatcher dies immediately rather than retrying for hours", async () => {
  const { dispatch } = await import("../lib/delivery.js");
  stub(() => jsonResponse(null));

  const out = await dispatch(claim({ kind: "sheet", config: {} }));

  expect(out.ok).toBe(false);
  expect(out.permanent).toBe(true);
  expect(out.error).toContain("sheet");
});

/* ========================================================================== *
 *  The fence
 * ========================================================================== */

test("the outcome is reported with the attempt and key from the claim, not the row", async () => {
  const { drainOnce } = await import("../lib/delivery.js");
  const { rpcCalls } = stub((fn) => jsonResponse(fn === "claim_deliveries" ? [claim()] : true));

  await drainOnce({ leadId: "11111111-1111-1111-1111-111111111111" });

  expect(rpcCalls[0].body).toEqual({ p_limit: 25, p_lead_id: "11111111-1111-1111-1111-111111111111" });
  const done = rpcCalls.find((c) => c.fn === "complete_delivery");
  expect(done.body.p_id).toBe(7);
  expect(done.body.p_attempt).toBe(3);
  expect(done.body.p_key).toBe("22222222-2222-2222-2222-222222222222");
});

// `complete_delivery` returning false means a later claim owns the row — this
// dispatcher outlived its lease. That is the fence working, not an error, and
// it must not throw out of the drain and abandon the rest of the batch.
test("a refused transition is counted as superseded, not as a crash", async () => {
  const { drainOnce } = await import("../lib/delivery.js");
  stub((fn) => jsonResponse(fn === "claim_deliveries" ? [claim()] : false));

  const counts = await drainOnce();

  expect(counts).toEqual({ claimed: 1, done: 0, failed: 0, dead: 0 });
});

// A delivery that went out but whose outcome could not be written is the one
// case that risks a duplicate. It must not throw either: the lease expires, the
// sweeper requeues it, and the receiver's `Idempotency-Key` covers the rest.
test("an unreachable database during settle does not abort the drain", async () => {
  const { drainOnce } = await import("../lib/delivery.js");
  stub((fn) => {
    if (fn === "claim_deliveries") return jsonResponse([claim(), claim({ delivery_id: 8 })]);
    return jsonResponse({ message: "gateway" }, 503);
  });

  const counts = await drainOnce();

  expect(counts.claimed).toBe(2);
  expect(counts.done).toBe(0);
});

test("an empty claim is not an outbound request", async () => {
  const { drainOnce } = await import("../lib/delivery.js");
  const { targetCalls } = stub(() => jsonResponse([]));

  expect(await drainOnce()).toEqual({ claimed: 0, done: 0, failed: 0, dead: 0 });
  expect(targetCalls).toHaveLength(0);
});
