/**
 * @file `/api/lead` with a database configured — the branch that decides whether
 * the queue or the legacy fan-out delivers a lead.
 *
 * This file exists because a review found a Critical that no other test could
 * have caught. `delivery.test.js` never touches the route, `server.test.js`
 * blanks `SUPABASE_*` so the route always takes the file path, and
 * `db-integration.mjs` calls the RPC directly. The one thing nothing exercised
 * was `handleIngest` deciding what to do with what the RPC returned — which is
 * exactly where a deduped resubmit was fanning out a second copy of a lead the
 * first submit had already queued.
 *
 * The assertion in every test below is about DELIVERY COUNT: how many times one
 * submitted lead leaves this server. Once is correct. Twice is the operator's
 * CRM holding a duplicate. Zero is the failure this whole phase exists to
 * remove — so the tests distinguish all three rather than checking a status
 * code, which is 202 in every case by design.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const tmpParent = resolve(import.meta.dir, "../../../.tmp");
const dataDir = await mkdtemp(join(tmpParent, "openfunnel-ingestq-"));
process.env.DATA_DIR = dataDir;
process.env.SUPABASE_URL = "https://db.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";
process.env.IP_HASH_SALT = "test-salt";
// The legacy fan-out's destination. An IP literal, so `resolveSafeTarget`
// returns early without a DNS lookup and a fan-out is observable as a request
// to this host rather than as a silent no-op.
process.env.WEBHOOK_URL = "http://93.184.216.34/legacy-fanout";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Deleted, deliberately NOT restored to whatever the repo root `.env` supplied.
// Bun auto-loads that file, so "restore what was there" would hand the next test
// file the developer's real Supabase project and real webhook destination —
// which is the bug that made `db-integration.mjs` run against production. UNSET
// is the safe terminal state for anything naming a connection or an egress
// target; a test that needs one sets its own, as every file here does.
afterAll(async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.IP_HASH_SALT;
  delete process.env.WEBHOOK_URL;
  await rm(dataDir, { recursive: true, force: true });
});

const DB = "https://db.test.invalid";
const FANOUT_HOST = "93.184.216.34";

/**
 * Stub both sides. `rpcReply(fn, body)` answers PostgREST; everything else is a
 * real outbound delivery and is recorded so the test can count it.
 */
function stub(rpcReply) {
  const rpcCalls = [];
  const outbound = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      const href = String(url);
      if (href.startsWith(DB)) {
        const fn = href.split("/rpc/")[1] || "";
        rpcCalls.push({ fn, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify(rpcReply(fn)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      outbound.push(href);
      return new Response("", { status: 200 });
    }
  );
  return { rpcCalls, outbound };
}

/** `persist()` is deliberately not awaited by the route, so give it a moment. */
const settle = () => Bun.sleep(120);

let ip = 0;
const post = (body) =>
  new Request("http://localhost/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// A fresh address per test: the per-IP ingest limiter is process-wide and shared
// with every other file in this suite.
const ctx = () => ({
  path: "/api/lead",
  server: { requestIP: () => ({ address: `203.0.113.${++ip}` }) },
});

const lead = (over = {}) => ({
  funnelId: "lead-gen",
  sessionId: "s-1",
  lead: { email: "queue@example.invalid", name: "Queue Tester" },
  answers: { goal: "leads" },
  ...over,
});

beforeEach(() => {
  ip = 0;
});

/* ========================================================================== *
 *  Exactly one delivery per lead
 * ========================================================================== */

test("a queued lead is delivered by the queue and NOT by the fan-out", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls, outbound } = stub((fn) => {
    if (fn === "ingest_lead") return [{ lead_id: "lead-1", queued: 2, deduped: false }];
    if (fn === "claim_deliveries") return [];
    // rate_hit — not what this test is about, so allow. A bare `null` default
    // reads as `Boolean(null) === false`, which is a rate-limit denial and
    // would turn every request in this file into a 429 rather than the 202
    // the route actually answers with.
    return true;
  });

  const res = await handleIngest(post(lead()), ctx());
  expect(res.status).toBe(202);
  await settle();

  expect(rpcCalls.map((c) => c.fn)).toContain("claim_deliveries");
  expect(outbound.filter((u) => u.includes(FANOUT_HOST))).toHaveLength(0);
});

// The Critical. `ingest_lead` collapses a resubmit inside the dedupe window and
// returns `deduped: true` with no new delivery rows. That is the queue saying
// "already handled", not "I could not take it" — and reading it as the latter
// sent the operator's CRM and alert inbox a second copy of the same lead. A
// double-tapped submit button was enough.
test("a deduped resubmit delivers nothing at all — not by the queue, not by the fan-out", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls, outbound } = stub((fn) => {
    if (fn === "ingest_lead") return [{ lead_id: "lead-1", queued: 0, deduped: true }];
    if (fn === "claim_deliveries") return [];
    // See the sibling test above: rate_hit needs a truthy default or every
    // request in this file 429s instead of exercising the dedupe path.
    return true;
  });

  const res = await handleIngest(post(lead()), ctx());
  expect(res.status).toBe(202);
  await settle();

  expect(outbound.filter((u) => u.includes(FANOUT_HOST))).toHaveLength(0);
  // Nor may it drain: those rows belong to the first submit's attempt, and
  // claiming them again is the same duplicate by a different route.
  expect(rpcCalls.map((c) => c.fn)).not.toContain("claim_deliveries");
});

/* ========================================================================== *
 *  Never zero deliveries
 * ========================================================================== */

// Nothing creates `delivery_target` rows yet, so this is the state EVERY
// deployment is in the moment it configures Postgres. Counting a stored lead as
// "handled" took the operator's webhook and lead alert silently dark — a
// regression from the behaviour they had before turning the database on.
test("a lead stored with no delivery target falls through to the fan-out", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { outbound } = stub((fn) => {
    if (fn === "ingest_lead") return [{ lead_id: "lead-2", queued: 0, deduped: false }];
    return [];
  });

  await handleIngest(post(lead()), ctx());
  await settle();

  expect(outbound.filter((u) => u.includes(FANOUT_HOST))).toHaveLength(1);
});

test("an unreachable database degrades forward to the fan-out, and still answers 202", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const outbound = [];
  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      const href = String(url);
      if (href.startsWith(DB)) throw new TypeError("fetch failed");
      outbound.push(href);
      return new Response("", { status: 200 });
    }
  );

  const res = await handleIngest(post(lead()), ctx());
  expect(res.status).toBe(202);
  await settle();

  expect(outbound.filter((u) => u.includes(FANOUT_HOST))).toHaveLength(1);
});

test("an unknown funnel still delivers, rather than logging the lead away", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const outbound = [];
  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      const href = String(url);
      if (href.startsWith(DB)) {
        return new Response(JSON.stringify({ code: "PT404", message: "unknown_funnel" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      outbound.push(href);
      return new Response("", { status: 200 });
    }
  );

  expect((await handleIngest(post(lead()), ctx())).status).toBe(202);
  await settle();
  expect(outbound.filter((u) => u.includes(FANOUT_HOST))).toHaveLength(1);
});

/* ========================================================================== *
 *  What the row actually contains
 * ========================================================================== */

test("the stored row carries a salted IP hash and never the address itself", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls } = stub((fn) => (fn === "ingest_lead" ? [{ lead_id: "l", queued: 1 }] : []));

  await handleIngest(post(lead()), ctx());
  await settle();

  const { body } = rpcCalls.find((c) => c.fn === "ingest_lead");
  expect(body.p_ip_hash).toMatch(/^\\x[0-9a-f]{64}$/);
  expect(JSON.stringify(body.p_payload)).not.toContain("203.0.113.");
  expect(body.p_payload.lead.email).toBe("queue@example.invalid");
  expect(body.p_dedupe_key).toMatch(/^[0-9a-f]{64}$/);
});

// `email_verified` is re-derived from the server's own record of who passed a
// challenge. The claim in the body is the visitor's, and the visitor controls it.
test("a claimed email_verified does not survive into the insert", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls } = stub((fn) => {
    if (fn === "ingest_lead") return [{ lead_id: "l", queued: 1 }];
    // `is_email_verified` is a scalar function; PostgREST returns the raw
    // boolean, never wrapped in an array. Answering `false` here is what makes
    // this test actually exercise the re-derivation — the empty-array default
    // used elsewhere in this file is truthy (`Boolean([]) === true`) and would
    // make the claim survive by accident rather than by the server trusting it.
    if (fn === "is_email_verified") return false;
    return true;
  });

  await handleIngest(post(lead({ lead: { email: "liar@example.invalid", email_verified: true } })), ctx());
  await settle();

  expect(rpcCalls.find((c) => c.fn === "ingest_lead").body.p_email_verified).toBe(false);
});
