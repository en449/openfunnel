/**
 * @file `rateLimit`, with `fetch` stubbed — the database path and its fallback.
 *
 * The interesting behaviour is not "it calls rate_hit" — it is what happens
 * when that call cannot complete. `rateLimit` backs every abuse ceiling in the
 * codebase, including `MAIL_HOURLY_CAP`, so a database outage must degrade the
 * limit rather than throw or block. See `lib/ratelimit.js`'s `@file` header.
 *
 * `lib/config.js` reads the environment once at import time, so the Supabase
 * variables are set before the dynamic imports below rather than in a
 * `beforeAll` — same pattern as db.test.js, for the same reason.
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

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

test("rate_hit returning false produces false from rateLimit", async () => {
  const { rateLimit } = await import("../lib/ratelimit.js");
  const calls = stub(() => jsonResponse(false));

  const allowed = await rateLimit("test:rate-hit-false", 5, 60_000);

  expect(allowed).toBe(false);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://db.test.invalid/rest/v1/rpc/rate_hit");
  expect(JSON.parse(calls[0].init.body)).toEqual({
    p_key: "test:rate-hit-false",
    p_max: 5,
    p_window_ms: 60_000,
  });
});

test("rate_hit returning true produces true from rateLimit", async () => {
  const { rateLimit } = await import("../lib/ratelimit.js");
  stub(() => jsonResponse(true));

  expect(await rateLimit("test:rate-hit-true", 5, 60_000)).toBe(true);
});

// The whole point of the fallback: a database outage must degrade the ceiling,
// not remove it and not surface as a thrown error on a public route.
test("an RPC that throws falls back to the in-memory bucket, still enforces the ceiling, and never throws", async () => {
  const { rateLimit } = await import("../lib/ratelimit.js");
  stub(() => {
    throw new TypeError("fetch failed");
  });

  const key = "test:rpc-throws-fallback";
  // max=2: two calls allowed, the third must be refused by the in-memory bucket.
  expect(await rateLimit(key, 2, 60_000)).toBe(true);
  expect(await rateLimit(key, 2, 60_000)).toBe(true);
  expect(await rateLimit(key, 2, 60_000)).toBe(false);
});

test("with no database configured, the in-memory bucket answers directly and fetch is never called", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const { rateLimit } = await import("../lib/ratelimit.js");
    let called = false;
    globalThis.fetch = /** @type {any} */ (async () => {
      called = true;
      throw new Error("fetch must not be called when no database is configured");
    });

    expect(await rateLimit("test:no-db", 1, 60_000)).toBe(true);
    expect(called).toBe(false);
  } finally {
    process.env.SUPABASE_URL = "https://db.test.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";
  }
});
