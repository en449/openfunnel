/**
 * @file The PostgREST client, with `fetch` stubbed.
 *
 * The behaviour worth pinning is not "it makes a request" — it is the error
 * classification. `/api/lead` branches on it: an unknown funnel means log it and
 * still answer the visitor 202, while an unreachable database means deliver
 * inline and skip the queue. Get that mapping wrong and the degrade-forward path
 * fires on a typo in a slug, or worse, does not fire when Supabase is down and
 * the lead is simply lost — which is the failure this whole phase exists to
 * remove.
 *
 * `lib/config.js` reads the environment once at import time, so the Supabase
 * variables are set before the dynamic imports below rather than in a
 * `beforeAll` — same pattern as hardening.test.js, for the same reason.
 *
 * Not covered here: the `db_not_configured` refusal, which needs the opposite
 * environment in the same process and is one branch on a constant.
 */
import { afterAll, afterEach, expect, test } from "bun:test";

process.env.SUPABASE_URL = "https://db.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Unset them again once this file is done. server.test.js spawns the real
// server with `{ ...process.env }`, and leaving these set would make that
// server believe it has a database — every ingest would then fire a doomed
// request at db.test.invalid, which is a slow test suite at best and a
// confusing one at worst.
afterAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

/** Stub `fetch` and record what it was called with. */
function stub(responder) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    }
  );
  return calls;
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ========================================================================== *
 *  Request shape
 * ========================================================================== */

test("rpc posts to /rest/v1/rpc/<fn> with the service-role credentials", async () => {
  const { rpc } = await import("../lib/db.js");
  const calls = stub(() => jsonResponse([{ lead_id: "abc", queued: 2, deduped: false }]));

  const out = await rpc("ingest_lead", { p_slug: "lead-gen" });

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://db.test.invalid/rest/v1/rpc/ingest_lead");
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].init.headers.apikey).toBe("service-role-key-not-real");
  expect(calls[0].init.headers.authorization).toBe("Bearer service-role-key-not-real");
  expect(JSON.parse(calls[0].init.body)).toEqual({ p_slug: "lead-gen" });
  expect(out).toEqual([{ lead_id: "abc", queued: 2, deduped: false }]);
});

test("select passes the filter through and always returns an array", async () => {
  const { select } = await import("../lib/db.js");
  const calls = stub(() => jsonResponse([{ id: 1 }]));

  const rows = await select("funnel", "select=id,doc&slug=eq.lead-gen&limit=1");

  expect(calls[0].url).toBe("https://db.test.invalid/rest/v1/funnel?select=id,doc&slug=eq.lead-gen&limit=1");
  expect(calls[0].init.method).toBe("GET");
  expect(rows).toEqual([{ id: 1 }]);
});

test("a 204 with no body reads as an empty result, not a parse error", async () => {
  const { insert } = await import("../lib/db.js");
  stub(() => new Response(null, { status: 204 }));

  expect(await insert("event", { type: "view" }, { returning: false })).toEqual([]);
});

// PATCH with no filter updates every row in the table, and the tables here are
// leads and delivery state. The refusal is worth more than the convenience.
test("update refuses an unfiltered PATCH before it reaches the network", async () => {
  const { update } = await import("../lib/db.js");
  const calls = stub(() => jsonResponse([]));

  await expect(update("delivery", "", { status: "done" })).rejects.toThrow(/unfiltered/);
  expect(calls).toHaveLength(0);
});

/* ========================================================================== *
 *  Error classification — the part callers branch on
 * ========================================================================== */

// The status here is the one PostgREST actually returns for a PT404 raise,
// confirmed against a real instance. The stub used to say 404 for SQLSTATE
// P0002, which PostgREST answers 500 to — the test agreed with the comment
// rather than with the server, and would have kept passing while the real
// unknown-slug path classified as "unavailable" and fired degrade-forward.
test("an unknown funnel is not_found, so ingest logs it rather than degrading forward", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => jsonResponse({ code: "PT404", message: "unknown_funnel" }, 404));

  try {
    await rpc("ingest_lead", { p_slug: "nope" });
    expect.unreachable("a 404 must throw");
  } catch (err) {
    expect(dbErrorKind(err)).toBe("not_found");
    expect(err.code).toBe("PT404");
    expect(err.status).toBe(404);
  }
});

// A rotated service-role key that was never updated in the environment answers
// 401 to EVERY request. Classified as "rejected" it would look like "the
// database said no to this record", so ingest would log-and-202 forever and
// every lead for every client would vanish — the exact failure this project
// exists to prevent, at maximum blast radius. Nothing is wrong with the lead.
test("an auth failure is unavailable, not rejected — a stale key must not swallow every lead", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => jsonResponse({ code: "PGRST301", message: "No suitable key or wrong key type" }, 401));

  try {
    await rpc("ingest_lead", {});
    expect.unreachable("a 401 must throw");
  } catch (err) {
    expect(dbErrorKind(err)).toBe("unavailable");
    expect(err.status).toBe(401);
  }
});

test("a 403 is unavailable for the same reason", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => jsonResponse({ code: "42501", message: "permission denied" }, 403));

  try {
    await rpc("claim_deliveries", {});
    expect.unreachable("a 403 must throw");
  } catch (err) {
    expect(dbErrorKind(err)).toBe("unavailable");
    // Not decoration. `expect.unreachable` throws an ordinary Error, which this
    // same `catch` then receives — and an Error carrying no status classifies as
    // "unavailable" by default, so the line above alone is satisfied by `rpc`
    // never having thrown at all. Every sibling here pins a second property for
    // that reason; this one was the exception.
    expect(err.status).toBe(403);
  }
});

test("a 5xx is unavailable — this is what triggers degrade-forward delivery", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => jsonResponse({ message: "upstream down" }, 503));

  try {
    await rpc("ingest_lead", {});
    expect.unreachable("a 503 must throw");
  } catch (err) {
    expect(dbErrorKind(err)).toBe("unavailable");
    expect(err.status).toBe(503);
  }
});

test("a 4xx that is not 404 is rejected — deterministic, and a bug rather than a miss", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => jsonResponse({ code: "23514", message: "violates check constraint" }, 400));

  try {
    await rpc("ingest_lead", {});
    expect.unreachable("a 400 must throw");
  } catch (err) {
    expect(dbErrorKind(err)).toBe("rejected");
  }
});

test("a network failure is unavailable, with no status to read", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => {
    throw new TypeError("fetch failed");
  });

  try {
    await rpc("claim_deliveries", {});
    expect.unreachable("a network failure must throw");
  } catch (err) {
    expect(dbErrorKind(err)).toBe("unavailable");
    expect(err.status).toBe(null);
    expect(err.code).toBe("db_unreachable");
  }
});

test("a timeout is unavailable and says so, so a slow database is not read as a bad request", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => {
    throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  });

  try {
    await rpc("claim_deliveries", {});
    expect.unreachable("a timeout must throw");
  } catch (err) {
    expect(dbErrorKind(err)).toBe("unavailable");
    expect(err.code).toBe("db_timeout");
  }
});

/* ========================================================================== *
 *  Personal data must not ride out on an error
 * ========================================================================== */

// A Postgres constraint message quotes the row that violated it. On this schema
// that row is a lead, so `details` carries a visitor's email address — and the
// caller logs whatever `err.message` holds.
test("a Postgres error detail carrying personal data never reaches the thrown message", async () => {
  const { rpc } = await import("../lib/db.js");
  stub(() =>
    jsonResponse(
      {
        code: "23505",
        message: "duplicate key value violates unique constraint",
        details: "Key (dedupe_key)=(klaus.bergmann@example.de|lead-gen) already exists.",
        hint: null,
      },
      409,
    ),
  );

  try {
    await rpc("ingest_lead", {});
    expect.unreachable("a 409 must throw");
  } catch (err) {
    expect(err.message).not.toContain("klaus.bergmann@example.de");
    expect(err.message).toBe("duplicate key value violates unique constraint");
  }
});

test("a long Postgres message is truncated rather than logged whole", async () => {
  const { rpc } = await import("../lib/db.js");
  stub(() => jsonResponse({ code: "P0001", message: "x".repeat(5000) }, 400));

  try {
    await rpc("ingest_lead", {});
    expect.unreachable("must throw");
  } catch (err) {
    expect(err.message.length).toBe(200);
  }
});

test("a non-JSON error body still throws with the status", async () => {
  const { rpc, dbErrorKind } = await import("../lib/db.js");
  stub(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));

  try {
    await rpc("claim_deliveries", {});
    expect.unreachable("must throw");
  } catch (err) {
    expect(err.status).toBe(502);
    expect(dbErrorKind(err)).toBe("unavailable");
  }
});
