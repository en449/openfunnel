/**
 * @file `/api/internal/drain` — the loop, not the gate.
 *
 * `server.test.js` covers the gate (no secret → 404, cross-site → 403). What it
 * cannot reach is the loop inside `handleInternal`, because that needs a
 * database. A review pointed out that an edit dropping the `claimed < batch`
 * break — the thing standing between one cron tick and an infinite loop — would
 * have passed the entire suite untouched. So this file drives the loop directly
 * with `fetch` stubbed, and asserts on how many claims it makes.
 *
 * The route is called directly rather than over HTTP on purpose: authentication
 * lives in the router branch, not in the handler, so reaching the handler here
 * asserts nothing about the gate and is not a way around it.
 */
import { afterAll, afterEach, expect, test } from "bun:test";

process.env.SUPABASE_URL = "https://db.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

/* The drain mails the operator when a delivery dies (WO13). Same rule as
 * delivery.test.js: no address, no key, no settings file — unset, never
 * restored, or the stubbed call counts here describe the developer's machine. */
for (const key of ["NOTIFY_EMAIL", "EMAIL_PROVIDER", "RESEND_API_KEY", "BREVO_API_KEY", "SMTP_RELAY_URL", "SMTP_HOST"]) {
  delete process.env[key];
}
process.env.DATA_DIR = ".tmp/no-mail-settings-here";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DRAIN_BATCH;
  delete process.env.DRAIN_BUDGET_MS;
});

afterAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const DB = "https://db.test.invalid";
const ctx = { path: "/api/internal/drain" };
const req = (method = "POST") => new Request("http://localhost/api/internal/drain", { method });

/** One claimable row, delivering to a public IP literal so no DNS is touched. */
const claim = (id) => ({
  delivery_id: id,
  lead_id: "11111111-1111-1111-1111-111111111111",
  attempts: 1,
  idempotency_key: "22222222-2222-2222-2222-222222222222",
  kind: "webhook",
  config: { url: "http://93.184.216.34/hook" },
  funnel_slug: "lead-gen",
  payload: { lead: { email: "drain@example.invalid" } },
  utm: null,
  consent: null,
  lead_created_at: "2026-08-11T10:00:00.000Z",
});

/**
 * @param {(n: number) => any[]} claimsForPass  rows returned by the nth claim (1-based)
 * @param {() => Promise<Response>|Response} [targetReply]
 */
function stub(claimsForPass, targetReply = () => new Response("", { status: 200 })) {
  let passes = 0;
  const rpcCalls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      const href = String(url);
      if (!href.startsWith(DB)) return targetReply();
      const fn = href.split("/rpc/")[1] || "";
      rpcCalls.push(fn);
      const body = fn === "claim_deliveries" ? claimsForPass(++passes) : true;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  );
  return {
    rpcCalls,
    get claimCount() {
      return rpcCalls.filter((f) => f === "claim_deliveries").length;
    },
  };
}

/* ========================================================================== *
 *  The loop terminates
 * ========================================================================== */

test("an empty queue costs exactly one claim", async () => {
  const { handleInternal } = await import("../routes/internal.js");
  const calls = stub(() => []);

  const res = await handleInternal(req(), ctx);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, claimed: 0, passes: 1 });
  expect(calls.claimCount).toBe(1);
});

// The break that matters. A full batch means there may be more; a short one
// means the queue is empty and the next tick can have it. Without this the loop
// runs until the deadline, re-claiming nothing, every single minute.
test("a short batch ends the loop instead of spinning to the deadline", async () => {
  process.env.DRAIN_BATCH = "3";
  const { handleInternal } = await import("../routes/internal.js");
  // Pass 1 fills the batch, pass 2 is short.
  const calls = stub((n) => (n === 1 ? [claim(1), claim(2), claim(3)] : [claim(4)]));

  const body = await (await handleInternal(req(), ctx)).json();

  expect(calls.claimCount).toBe(2);
  expect(body).toMatchObject({ passes: 2, claimed: 4, done: 4 });
});

test("a backlog deeper than one batch is drained in the same call", async () => {
  process.env.DRAIN_BATCH = "2";
  const { handleInternal } = await import("../routes/internal.js");
  const calls = stub((n) => (n <= 3 ? [claim(n * 10), claim(n * 10 + 1)] : []));

  const body = await (await handleInternal(req(), ctx)).json();

  expect(calls.claimCount).toBe(4); // three full batches, then the empty one
  expect(body).toMatchObject({ claimed: 6, done: 6, passes: 4 });
});

// The Major from review round 2: the budget was checked only BETWEEN passes, so
// a pass starting a millisecond under it could still add a full pass of
// in-flight attempts on top. The deadline is now passed into `drainOnce` too.
// The Major from review round 2: the deadline was checked only BETWEEN passes,
// so a pass that had already started ran to completion however long it took.
//
// Arranged so ONE pass overruns, which is what makes this deterministic. A batch
// of 25 against DELIVERY_PARALLEL=5 is five sequential chunks; at 250ms per
// delivery the pass needs ~1250ms against a 1000ms budget:
//
//   checked only between passes → the pass runs all five chunks → done === 25
//   checked inside the pass too → it breaks at the chunk boundary past the
//                                 deadline → done === 20
//
// `claimed` is 25 either way, because it comes from a single `claim_deliveries`
// call, so the assertion is `done < claimed` — no wall clock, and no dependence
// on a SECOND pass managing to start, which is what a two-pass version needs and
// what makes that version flaky: it leaves only ~100ms of slack for all the
// non-sleep overhead before pass 2 never begins and the test fails while the
// logic under test is perfectly correct.
//
// Contention can only help. `Bun.sleep(250)` is a floor, so a loaded machine
// fits FEWER chunks inside the deadline and `done` drops further below
// `claimed`; reaching parity would need chunks to run faster than the sleeps
// they are built from.
test("the deadline bounds work INSIDE a pass, not just between passes", async () => {
  process.env.DRAIN_BATCH = "25";
  process.env.DRAIN_BUDGET_MS = "1000"; // the clamped floor
  const { handleInternal } = await import("../routes/internal.js");

  const calls = stub(
    () => Array.from({ length: 25 }, (_, i) => claim(i + 1)),
    async () => {
      await Bun.sleep(250);
      return new Response("", { status: 200 });
    },
  );

  const body = await (await handleInternal(req(), ctx)).json();

  expect(body.ok).toBe(true);
  expect(calls.claimCount).toBe(1);
  expect(body.claimed).toBe(25);
  // The gap is rows claimed but never dispatched. They are not lost: they stay
  // leased and the sweeper returns them to the queue five minutes later.
  expect(body.done).toBeLessThan(body.claimed);
});

test("a drain with no database configured says so rather than pretending to work", async () => {
  const url = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "";
  try {
    const { handleInternal } = await import("../routes/internal.js");
    const res = await handleInternal(req(), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("db_not_configured");
  } finally {
    process.env.SUPABASE_URL = url;
  }
});

test("a caller that gives up ends the loop without claiming again", async () => {
  process.env.DRAIN_BATCH = "1";
  const { handleInternal } = await import("../routes/internal.js");
  const calls = stub(() => [claim(1)]);

  const controller = new AbortController();
  const request = new Request("http://localhost/api/internal/drain", {
    method: "POST",
    signal: controller.signal,
  });
  controller.abort();

  const res = await handleInternal(request, ctx);

  expect(res.status).toBe(200);
  expect(calls.claimCount).toBe(0);
});

/* ========================================================================== *
 *  Refusals
 * ========================================================================== */

test("a GET is refused — draining is not idempotent and must not be a link", async () => {
  const { handleInternal } = await import("../routes/internal.js");
  expect((await handleInternal(req("GET"), ctx)).status).toBe(405);
});

test("any other internal path falls through rather than being drained", async () => {
  const { handleInternal } = await import("../routes/internal.js");
  expect(await handleInternal(req(), { path: "/api/internal/something-else" })).toBeNull();
});

// Partial progress is reported rather than swallowed: "500 with no numbers" and
// "delivered 4, then the database went away" need different responses from the
// operator, and the cron job's log is the only place either is ever seen.
test("a mid-drain failure reports what was delivered before it", async () => {
  process.env.DRAIN_BATCH = "2";
  const { handleInternal } = await import("../routes/internal.js");
  let passes = 0;
  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      const href = String(url);
      if (!href.startsWith(DB)) return new Response("", { status: 200 });
      if (href.includes("/rpc/claim_deliveries")) {
        if (++passes > 1) return new Response(JSON.stringify({ message: "gone" }), { status: 503 });
        return new Response(JSON.stringify([claim(1), claim(2)]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
    }
  );

  const res = await handleInternal(req(), ctx);
  const body = await res.json();

  expect(res.status).toBe(500);
  expect(body).toMatchObject({ ok: false, claimed: 2, done: 2 });
});
