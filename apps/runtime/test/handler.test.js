/**
 * @file WO11 — what the router does when the two things Bun hands it for free
 * are gone: an identity for the caller's socket, and a process that is still
 * alive after the response is written.
 *
 * Neither is observable through `server.test.js`, which spawns a real Bun
 * server and therefore always has both. These assertions are the serverless
 * side, and both are refusals rather than features: a gate that cannot see a
 * socket must refuse, and deferred work that nothing is waiting on must be
 * waited on by somebody.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Bun auto-loads the repo's `.env`, so without this the whole file would run
 * against whatever Supabase project, webhook and mailbox the developer has
 * configured. Deleted rather than blanked-and-restored: the hazard is the NEXT
 * test file inheriting a real credential, never the absence of one. */
for (const key of [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WEBHOOK_URL",
  "ZAPIER_WEBHOOK_URL",
  "NOTIFY_EMAIL",
  "META_PIXEL_ID",
  "META_CAPI_TOKEN",
]) {
  delete process.env[key];
}

const scratch = await mkdtemp(join(await tmpParent(), "openfunnel-handler-"));
process.env.DATA_DIR = scratch;

async function tmpParent() {
  const dir = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(dir, { recursive: true });
  return dir;
}

// Imported after the deletes above, because `lib/config.js` reads the
// environment once at import time and hands out constants.
const { handleRequest } = await import("../handler.js");
const { isLoopbackRequest } = await import("../lib/auth.js");
const { clientIp } = await import("../lib/http.js");
const vercelEntry = (await import("../../../api/index.js")).default;

const realFetch = globalThis.fetch;
const CONTEXT_KEY = Symbol.for("@vercel/request-context");

// Per test, not once at import: every test file's module body runs before any
// test does, so two files each pointing DATA_DIR at their own scratch directory
// leave whichever loaded last deciding it for both.
beforeEach(() => {
  process.env.DATA_DIR = scratch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (/** @type {any} */ (globalThis))[CONTEXT_KEY];
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** A stand-in for Bun's server object, answering as a loopback caller would. */
const bunServer = { requestIP: () => ({ address: "127.0.0.1" }) };

const lead = (funnelId = "handler-test") =>
  new Request("http://localhost/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ funnelId, sessionId: "s1", lead: { email: "wo11@example.invalid" } }),
  });

/* ========================================================================== *
 *  No socket means no loopback trust
 * ========================================================================== */

test("loopback trust needs a server object, and says so rather than guessing", () => {
  const req = new Request("http://localhost:3000/api/admin/leads", { headers: { host: "localhost:3000" } });

  expect(isLoopbackRequest(req, bunServer)).toBe(true);
  // The serverless entry passes no server. Answering true here — or throwing,
  // which is what reading `server.requestIP` unguarded does — is the difference
  // between a console behind Vercel Authentication and one behind nothing.
  expect(isLoopbackRequest(req, undefined)).toBe(false);
});

test("a privileged route is refused when the router has no server", async () => {
  const res = await handleRequest(
    new Request("http://localhost/api/admin/leads", { headers: { host: "localhost" } }),
  );
  // 401 whichever gate answered: with ADMIN_TOKEN set it is a missing token,
  // without one it is the loopback fallback declining. A 500 here means the
  // guard was removed and `server.requestIP` threw; a 200 means it fell open.
  expect(res.status).toBe(401);
});

test("the public surface does not need a server at all", async () => {
  const res = await handleRequest(new Request("http://localhost/healthz"));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("clientIp answers null without a socket instead of throwing", () => {
  expect(clientIp(new Request("http://localhost/api/lead"), undefined)).toBe(null);
});

/* ========================================================================== *
 *  Work that outlives the response
 * ========================================================================== */

test("ingest hands its post-response work to ctx.waitUntil", async () => {
  /** @type {Promise<any>[]} */
  const deferred = [];
  const res = await handleRequest(lead(), {
    server: bunServer,
    waitUntil: (p) => void deferred.push(p),
  });

  expect(res.status).toBe(202);
  // `persist()` — the JSONL sink plus, on this path, the direct fan-out that is
  // the ONLY delivery a lead the queue did not take will ever get.
  expect(deferred.length).toBeGreaterThan(0);
  await Promise.all(deferred);
});

test("the Vercel entry uses the platform's waitUntil when there is one", async () => {
  /** @type {Promise<any>[]} */
  const handed = [];
  /** @type {any} */ (globalThis)[CONTEXT_KEY] = {
    get: () => ({ waitUntil: (/** @type {Promise<any>} */ p) => handed.push(p) }),
  };

  const res = await vercelEntry.fetch(lead());

  expect(res.status).toBe(202);
  expect(handed.length).toBeGreaterThan(0);
  await Promise.all(handed);
});

test("with no platform waitUntil the entry waits for the work itself", async () => {
  // Something observable and slow inside `persist()`. The CAPI forward is the
  // only outbound call on this path that can be turned on with two variables.
  process.env.META_PIXEL_ID = "0";
  process.env.META_CAPI_TOKEN = "not-a-real-token";
  let finished = false;
  globalThis.fetch = /** @type {any} */ (
    async () => {
      await Bun.sleep(30);
      finished = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
  );

  try {
    const res = await vercelEntry.fetch(lead());
    expect(res.status).toBe(202);
    // The fallback is the whole safety argument for not taking the dependency:
    // if the platform's waitUntil ever disappears, `/api/lead` gets slower and
    // never lossy. Without this the invocation is frozen here and the fan-out —
    // the degraded path's only delivery — never happens.
    expect(finished).toBe(true);
  } finally {
    delete process.env.META_PIXEL_ID;
    delete process.env.META_CAPI_TOKEN;
  }
});
