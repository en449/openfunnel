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

  const body = JSON.parse(calls[0].init.body);
  expect(body.p_max).toBe(5);
  expect(body.p_window_ms).toBe(60_000);
  // The key the caller built never reaches the table — see `bucketKey()`. Every
  // per-IP and per-address limit puts its subject in that string, so a plain
  // key is an address (or an email) stored in Postgres.
  expect(body.p_key).not.toContain("rate-hit-false");
  expect(body.p_key).toMatch(/^[0-9a-f]{32}$/);
});

// Stable, or the limit resets on every call and binds nothing at all — the
// failure mode a per-process salt would have produced.
test("the same key hashes to the same bucket, a different key does not", async () => {
  const { rateLimit } = await import("../lib/ratelimit.js");
  const calls = stub(() => jsonResponse(true));

  await rateLimit("ingest:203.0.113.9", 5, 60_000);
  await rateLimit("ingest:203.0.113.9", 5, 60_000);
  await rateLimit("ingest:203.0.113.10", 5, 60_000);

  const keys = calls.map((c) => JSON.parse(c.init.body).p_key);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[2]).not.toBe(keys[0]);
  for (const key of keys) expect(key).not.toContain("203.0.113");
});

// The salt is what stops a 2^32 walk of the IPv4 space from turning the digest
// back into the address, so the two forms must not be the same string.
test("IP_HASH_SALT changes the digest", async () => {
  const { rateLimit } = await import("../lib/ratelimit.js");
  const calls = stub(() => jsonResponse(true));

  await rateLimit("ingest:203.0.113.9", 5, 60_000);
  process.env.IP_HASH_SALT = "pepper-not-a-real-salt";
  try {
    await rateLimit("ingest:203.0.113.9", 5, 60_000);
  } finally {
    delete process.env.IP_HASH_SALT;
  }

  const [unsalted, salted] = calls.map((c) => JSON.parse(c.init.body).p_key);
  expect(salted).not.toBe(unsalted);
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
