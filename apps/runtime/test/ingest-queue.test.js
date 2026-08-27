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

/* ========================================================================== *
 *  Consent evidence (WO-D6, §8.4) — `p_consent` used to be whatever string
 *  `record.meta.consent` held. It is now always the same shape:
 *  `{ signal, at, text_version }`, regardless of which engine build sent the
 *  lead.
 * ========================================================================== */

test("a current-build engine's consent evidence is stored as one object", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls } = stub((fn) => (fn === "ingest_lead" ? [{ lead_id: "l", queued: 1 }] : []));

  await handleIngest(
    post(
      lead({
        meta: {
          consent: "granted", // trap 1: the bare string a current engine still sends
          consentRecord: { signal: "granted", at: "2026-08-19T10:00:00.000Z", text_version: "v2" },
        },
      })
    ),
    ctx()
  );
  await settle();

  expect(rpcCalls.find((c) => c.fn === "ingest_lead").body.p_consent).toEqual({
    signal: "granted",
    at: "2026-08-19T10:00:00.000Z",
    text_version: "v2",
  });
});

// The shape an engine built before D6 sends: a bare string under `meta.consent`
// and no `consentRecord` at all. It must land in the SAME shape as the block
// above, not a second one `lead.consent` readers would have to branch on.
test("a legacy string body is normalised, not stored as-is", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls } = stub((fn) => (fn === "ingest_lead" ? [{ lead_id: "l", queued: 1 }] : []));

  await handleIngest(post(lead({ meta: { consent: "denied" } })), ctx());
  await settle();

  expect(rpcCalls.find((c) => c.fn === "ingest_lead").body.p_consent).toEqual({
    signal: "denied",
    at: null,
    text_version: null,
  });
});

// `/api/lead` is public: an attacker's `consentRecord` must not reach the
// database as typed, oversized, or carrying extra keys.
test("a malformed consentRecord is validated, not trusted, before it reaches p_consent", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls } = stub((fn) => (fn === "ingest_lead" ? [{ lead_id: "l", queued: 1 }] : []));

  await handleIngest(
    post(
      lead({
        meta: {
          consentRecord: {
            signal: "not-a-real-signal",
            at: "x".repeat(500),
            text_version: "y".repeat(500),
            evil: "<script>",
          },
        },
      })
    ),
    ctx()
  );
  await settle();

  // An invalid `signal` sinks the whole object rather than storing junk —
  // there is no legacy string here either, so the record carries no evidence.
  expect(rpcCalls.find((c) => c.fn === "ingest_lead").body.p_consent).toBeNull();
});

test("an oversized but validly-shaped consentRecord is bounded, not stored whole", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { rpcCalls } = stub((fn) => (fn === "ingest_lead" ? [{ lead_id: "l", queued: 1 }] : []));

  await handleIngest(
    post(
      lead({
        meta: {
          consentRecord: { signal: "granted", at: "x".repeat(500), text_version: "y".repeat(500) },
        },
      })
    ),
    ctx()
  );
  await settle();

  const stored = rpcCalls.find((c) => c.fn === "ingest_lead").body.p_consent;
  expect(stored.signal).toBe("granted");
  expect(stored.at.length).toBeLessThanOrEqual(64);
  expect(stored.text_version.length).toBeLessThanOrEqual(200);
});

/* ========================================================================== *
 *  WO D-24 — the JSONL sink is the store of LAST RESORT, not a second copy
 *
 *  `persist()` used to append to `.data/*.jsonl` on every path. On a deployment
 *  with Postgres that made the file a shadow copy of every lead, and both
 *  deletion mechanisms are Postgres-only (`erase_subject`, `purge_expired`) — so
 *  an erased lead went on sitting on disk with nothing that could reach it. This
 *  is the only file in the suite that runs the ingest route WITH a database
 *  configured, so it is the only place the distinction is observable at all.
 *
 *  Asserted per record, not by an empty file: every test here shares one
 *  DATA_DIR, and the two below deliberately write to the same sink.
 * ========================================================================== */

/**
 * Records in a sink whose lead email or session id EQUALS this test's marker.
 *
 * Exact, not `JSON.stringify(record).includes(marker)`, which is what this
 * started as. `s-sink-evt-lost` contains `s-sink-evt`, so a substring matcher
 * made the assert-0 test below pass only because Bun happens to run the file in
 * declaration order — reorder the tests and it counts the other one's record.
 * The same shape as the search-needle bug D4's review found: a matcher loose
 * enough to be convenient is loose enough to answer about the wrong record.
 */
async function sinkRecordsFor(file, marker) {
  const path = join(dataDir, file);
  const raw = await Bun.file(path)
    .text()
    .catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((r) => r.sessionId === marker || r.lead?.email === marker);
}

test("a lead the queue took leaves NO copy in the JSONL sink", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  stub((fn) => {
    if (fn === "ingest_lead") return [{ lead_id: "lead-sink-1", queued: 2, deduped: false }];
    if (fn === "claim_deliveries") return [];
    return true;
  });

  await handleIngest(post(lead({ lead: { email: "durable@sink.invalid" } })), ctx());
  await settle();

  // Postgres holds it, so `erase_subject` and `purge_expired` can both reach it.
  // A sink line here is the same person's data in a file neither one knows about.
  expect(await sinkRecordsFor("leads.jsonl", "durable@sink.invalid")).toHaveLength(0);
});

// The Critical from D-24's own review, and the reason `durable` exists as a
// third field rather than `!fanOut`. `ingest_lead` commits the lead row BEFORE it
// inserts any `delivery` row and returns the id on every success path — so a
// client with no `delivery_target` gets `queued: 0` with the lead durably stored.
// `queueOwnsIt` is false there (nothing will deliver it, so the legacy fan-out
// MUST run), and the first version of this change read the sink off that flag —
// which wrote a shadow copy of a lead Postgres already held. Nothing creates
// `delivery_target` rows until WO12, so that is not an edge case: it is every
// lead on every Postgres deployment today.
test("a lead stored with NO delivery target is in Postgres, so it is not in the sink either", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  const { outbound } = stub((fn) => {
    if (fn === "ingest_lead") return [{ lead_id: "lead-no-target", queued: 0, deduped: false }];
    return [];
  });

  await handleIngest(post(lead({ lead: { email: "notarget@sink.invalid" } })), ctx());
  await settle();

  // Both halves, because the bug was reading one flag for both questions: the
  // fan-out still has to run (nobody else delivers this lead) ...
  expect(outbound.filter((u) => u.includes(FANOUT_HOST))).toHaveLength(1);
  // ... and the sink still must not, because `erase_subject` can reach the row.
  expect(await sinkRecordsFor("leads.jsonl", "notarget@sink.invalid")).toHaveLength(0);
});

// Same shape one step further along: a deduped resubmit keeps the FIRST submit's
// committed row (`on conflict (dedupe_key) do nothing`), so it is durable too.
test("a deduped resubmit leaves no sink copy — the first submit's row is still there", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  stub((fn) => {
    if (fn === "ingest_lead") return [{ lead_id: "lead-dupe", queued: 0, deduped: true }];
    return true;
  });

  await handleIngest(post(lead({ lead: { email: "dupe@sink.invalid" } })), ctx());
  await settle();

  expect(await sinkRecordsFor("leads.jsonl", "dupe@sink.invalid")).toHaveLength(0);
});

test("a lead the database REFUSED does land in the sink — it is the only copy left", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      if (String(url).startsWith(DB)) throw new TypeError("fetch failed");
      return new Response("", { status: 200 });
    }
  );

  await handleIngest(post(lead({ lead: { email: "outage@sink.invalid" } })), ctx());
  await settle();

  // The other half of the same decision, and the reason this is not simply
  // "skip the sink when a database is configured": with the database down and
  // no delivery target configured, dropping this write loses the lead outright.
  expect(await sinkRecordsFor("leads.jsonl", "outage@sink.invalid")).toHaveLength(1);
});

test("a stored event leaves no copy in the sink either", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  stub((fn) => (fn === "ingest_event" ? [] : true));

  const req = new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ funnelId: "lead-gen", sessionId: "s-sink-evt", type: "step_view", stepId: "one" }),
  });
  await handleIngest(req, { path: "/api/events", server: { requestIP: () => ({ address: `203.0.113.${++ip}` }) } });
  await settle();

  // Events carry the session id `subject_matches` erases a person's trail by, so
  // the sink copy is as much outside Art. 17 as the lead's is.
  expect(await sinkRecordsFor("events.jsonl", "s-sink-evt")).toHaveLength(0);
});

// The other direction, which nothing covered: `/api/events` passes
// `durable: stored`, and `storeEvent` SWALLOWS its own failure and returns false
// rather than throwing — drop-off analytics are never escalated. So a hard-coded
// or inverted `durable` here would not fail loudly anywhere: the event would be
// in neither Postgres nor the sink, and no test in the suite would notice. That
// is silent data loss on the path whose session id is the only join
// `erase_subject` has.
test("an event the database REFUSED lands in the sink, since nothing else holds it", async () => {
  const { handleIngest } = await import("../routes/ingest.js");
  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      if (String(url).startsWith(DB)) throw new TypeError("fetch failed");
      return new Response("", { status: 200 });
    }
  );

  const req = new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ funnelId: "lead-gen", sessionId: "s-sink-evt-lost", type: "step_view", stepId: "one" }),
  });
  await handleIngest(req, { path: "/api/events", server: { requestIP: () => ({ address: `203.0.113.${++ip}` }) } });
  await settle();

  expect(await sinkRecordsFor("events.jsonl", "s-sink-evt-lost")).toHaveLength(1);
});
