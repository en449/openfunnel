/**
 * @file WO D4 — the two admin endpoints behind the Subjects view:
 * `GET /api/admin/subjects` (`find_subject`) and `DELETE /api/admin/subjects`
 * (`erase_subject`). The SQL migration's own header
 * (`supabase/migrations/20260819100000_subject_rights.sql`) states what those
 * functions guarantee; this file pins that the ROUTE layer does not claim
 * more (a short needle is refused before the database ever sees it, a
 * mis-typed confirmation calls nothing) and does not leak (the needle never
 * reaches a log line, on either endpoint, on either the success or the
 * failure path).
 *
 * Written against `handleRequest` directly with a stubbed PostgREST, the same
 * shape `funnels-gate.test.js`'s `stubDb` and `domains.test.js`'s `admin`
 * helper use — this file only ever needs `/rpc/find_subject` and
 * `/rpc/erase_subject`. There is deliberately no `/rpc/rate_hit` stub: these
 * two routes carry no rate limit (see the comment on the DELETE in
 * `routes/admin.js`), so a call to it would be an unannounced one and the
 * catch-all below is what makes that visible instead of quietly answering it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Deleted, never restored — see the identical note in funnels-gate.test.js
 * and domains.test.js: the next test file in the same `bun test` process must
 * not inherit whatever this file happened to set last. */
for (const key of [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_TOKEN",
  "INTERNAL_SECRET",
  "FUNNEL_DOMAINS",
  "ALLOWED_HOSTS",
]) {
  delete process.env[key];
}

async function tmpParent() {
  const dir = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(dir, { recursive: true });
  return dir;
}

const scratch = await mkdtemp(join(await tmpParent(), "openfunnel-subjects-"));
process.env.DATA_DIR = scratch;

const { handleRequest } = await import("../handler.js");
const { ADMIN_TOKEN } = await import("../lib/config.js");

const realFetch = globalThis.fetch;

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";

/** A `find_subject` row, shaped exactly like the SQL function's OUT columns. */
const ROW = {
  lead_id: "22222222-2222-2222-2222-222222222222",
  funnel_id: "33333333-3333-3333-3333-333333333333",
  funnel_slug: "lead-gen",
  created_at: "2026-08-01T00:00:00.000Z",
  deleted_at: null,
  restricted: false,
  is_spam: false,
  email_verified: true,
  session_id: "s-1",
  session_shared: false,
  event_count: 3,
  payload: { email: "person@example.invalid", name: "Person" },
  utm: {},
  consent: {},
};

/** An `erase_subject` receipt row — all five columns, none of them the default. */
const RECEIPT = {
  leads_deleted: 1,
  leads_already_deleted: 0,
  events_deleted: 3,
  leads_without_session: 0,
  shared_sessions: 0,
};

/**
 * Points the runtime at a database that exists only in this function, and
 * counts calls to each RPC so a "must call nothing" assertion is not just
 * hoping the status code implies it.
 *
 * @param {{ find?: any[], erase?: any, throwFind?: boolean, throwErase?: boolean }} [opts]
 * @returns {{ find: number, erase: number }}
 */
function stubDb(opts = {}) {
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";
  const calls = { find: 0, erase: 0 };

  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      const target = String(url);
      const reply = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (target.includes("/rpc/find_subject")) {
        calls.find++;
        if (opts.throwFind) return reply({ code: "XX000", message: "database error 500" }, 500);
        return reply(opts.find ?? [ROW]);
      }
      if (target.includes("/rpc/erase_subject")) {
        calls.erase++;
        if (opts.throwErase) return reply({ code: "XX000", message: "database error 500" }, 500);
        return reply([opts.erase ?? RECEIPT]);
      }
      throw new Error(`unexpected request in a stubbed test: ${target}`);
    }
  );

  return calls;
}

/** Loopback, so `requireAdmin` passes with no ADMIN_TOKEN set — as it does locally. */
const bunServer = { requestIP: () => ({ address: "127.0.0.1" }) };
const adminHeaders = ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {};

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
const admin = (path, init = {}) =>
  handleRequest(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { host: "localhost", ...adminHeaders, ...(init.headers || {}) },
    }),
    { server: bunServer },
  );

beforeEach(() => {
  process.env.DATA_DIR = scratch;
  // Per test, not once at import — `bun test` shares one process across
  // files, and a file that ran before this one may have left these set.
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ========================================================================== *
 *  Auth and the CSRF gate — both endpoints are dispatched inside the same
 *  privileged branch as every other /api/admin/* route, so this is really a
 *  test that the new paths did not escape it.
 * ========================================================================== */

test("the GET refuses without admin credentials, and refuses a cross-site Origin", async () => {
  const noAuth = await handleRequest(
    new Request(`http://console.example.test/api/admin/subjects?client=${CLIENT_ID}&q=person%40example.invalid`, {
      headers: { host: "console.example.test" },
    }),
  );
  expect([401, 403]).toContain(noAuth.status);

  // Would otherwise pass (loopback trust, no ADMIN_TOKEN) — refused anyway,
  // before requireAdmin is even reached.
  const crossSite = await handleRequest(
    new Request(`http://localhost/api/admin/subjects?client=${CLIENT_ID}&q=person%40example.invalid`, {
      headers: { host: "localhost", origin: "https://evil.tld", ...adminHeaders },
    }),
    { server: bunServer },
  );
  expect(crossSite.status).toBe(403);
  expect((await crossSite.json()).error).toBe("cross_site_denied");
});

/* ========================================================================== *
 *  No database, no subjects to find
 * ========================================================================== */

test("with no database configured, both endpoints answer 503", async () => {
  const get = await admin(`/api/admin/subjects?client=${CLIENT_ID}&q=person%40example.invalid`);
  expect(get.status).toBe(503);
  expect((await get.json()).error).toBe("db_not_configured");

  const del = await admin("/api/admin/subjects", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: CLIENT_ID, q: "person@example.invalid", confirm: "person@example.invalid" }),
  });
  expect(del.status).toBe(503);
  expect((await del.json()).error).toBe("db_not_configured");
});

/* ========================================================================== *
 *  Both endpoints require client and q
 * ========================================================================== */

test("an invalid or missing client id is 400 on both endpoints, and calls nothing", async () => {
  const calls = stubDb();

  const badClient = await admin(`/api/admin/subjects?client=not-a-uuid&q=person%40example.invalid`);
  expect(badClient.status).toBe(400);
  expect((await badClient.json()).error).toBe("invalid_client");

  const noClient = await admin(`/api/admin/subjects?q=person%40example.invalid`);
  expect(noClient.status).toBe(400);
  expect((await noClient.json()).error).toBe("invalid_client");

  const del = await admin("/api/admin/subjects", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: "not-a-uuid", q: "person@example.invalid", confirm: "person@example.invalid" }),
  });
  expect(del.status).toBe(400);
  expect((await del.json()).error).toBe("invalid_client");

  expect(calls.find).toBe(0);
  expect(calls.erase).toBe(0);
});

test("a needle under 3 characters is 400, not a 500 from the database", async () => {
  const calls = stubDb();

  const res = await admin(`/api/admin/subjects?client=${CLIENT_ID}&q=ab`);
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("needle_too_short");

  const empty = await admin(`/api/admin/subjects?client=${CLIENT_ID}`);
  expect(empty.status).toBe(400);
  expect((await empty.json()).error).toBe("needle_too_short");

  expect(calls.find).toBe(0);
});

/* ========================================================================== *
 *  The GET result shape — `find_subject`'s rows as-is, never cached
 * ========================================================================== */

test("the GET returns the find_subject rows as-is, with no-store", async () => {
  stubDb({ find: [ROW] });
  const res = await admin(`/api/admin/subjects?client=${CLIENT_ID}&q=${encodeURIComponent("person@example.invalid")}`);
  expect(res.status).toBe(200);
  // This response holds one identified person's data — never cacheable, same
  // reasoning as the client report link.
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ leads: [ROW] });
});

/* ========================================================================== *
 *  DELETE without confirm, and with a wrong confirm — 400, and erase_subject
 *  is never called. This is the exact bug class the typed confirmation exists
 *  to close: a mis-wired button must not be able to delete on click.
 * ========================================================================== */

test("DELETE without confirm, and with confirm !== q, are both 400 and call nothing", async () => {
  const calls = stubDb();

  const noConfirm = await admin("/api/admin/subjects", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: CLIENT_ID, q: "person@example.invalid" }),
  });
  expect(noConfirm.status).toBe(400);
  // An ABSENT confirm is refused by the body type-guard, one step before the
  // equality check — `typeof undefined !== "string"`. The distinction is only
  // in the error code; what this test is about is that both shapes are 400 and
  // neither reaches `erase_subject`.
  expect((await noConfirm.json()).error).toBe("invalid_body");

  const wrongConfirm = await admin("/api/admin/subjects", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: CLIENT_ID, q: "person@example.invalid", confirm: "someone-else@example.invalid" }),
  });
  expect(wrongConfirm.status).toBe(400);
  expect((await wrongConfirm.json()).error).toBe("confirm_mismatch");

  // Whitespace is not "close enough" either — exact equality, as documented.
  const paddedConfirm = await admin("/api/admin/subjects", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: CLIENT_ID, q: "person@example.invalid", confirm: "person@example.invalid " }),
  });
  expect(paddedConfirm.status).toBe(400);
  expect((await paddedConfirm.json()).error).toBe("confirm_mismatch");

  expect(calls.erase).toBe(0);
});

/* ========================================================================== *
 *  The successful erase — all FIVE columns, sharedSessions included
 * ========================================================================== */

test("a successful DELETE returns the receipt with all five counts, sharedSessions included", async () => {
  stubDb({
    erase: {
      leads_deleted: 2,
      leads_already_deleted: 1,
      events_deleted: 5,
      leads_without_session: 1,
      shared_sessions: 3,
    },
  });

  const res = await admin("/api/admin/subjects", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: CLIENT_ID, q: "person@example.invalid", confirm: "person@example.invalid" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    leadsDeleted: 2,
    leadsAlreadyDeleted: 1,
    eventsDeleted: 5,
    leadsWithoutSession: 1,
    sharedSessions: 3,
  });
});

/* ========================================================================== *
 *  The needle never reaches a log line — success and failure, both endpoints
 * ========================================================================== */

test("neither endpoint's log output contains the needle", async () => {
  const NEEDLE = "very-secret-person@example.invalid";
  const warn = console.warn;
  /** @type {string[]} */
  let lines = [];
  console.warn = (...args) => void lines.push(args.map(String).join(" "));

  try {
    // GET, forced onto the failure path so a log line is actually produced —
    // an assertion over zero lines would be true of broken code too.
    stubDb({ throwFind: true });
    const getRes = await admin(`/api/admin/subjects?client=${CLIENT_ID}&q=${encodeURIComponent(NEEDLE)}`);
    expect(getRes.status).toBe(503);

    // DELETE, on its SUCCESS path: the client id and the counts are the
    // audit trail an Art. 17 erasure needs, and that line has to exist
    // without the needle riding along inside it.
    stubDb({ erase: { ...RECEIPT } });
    const delRes = await admin("/api/admin/subjects", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: CLIENT_ID, q: NEEDLE, confirm: NEEDLE }),
    });
    expect(delRes.status).toBe(200);

    // And DELETE's own failure path.
    stubDb({ throwErase: true });
    const delFailRes = await admin("/api/admin/subjects", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: CLIENT_ID, q: NEEDLE, confirm: NEEDLE }),
    });
    expect(delFailRes.status).toBe(503);
  } finally {
    console.warn = warn;
  }

  // Not vacuous: at least one line was actually produced.
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).not.toContain(NEEDLE);
  // And the permitted content — the client id — really is what is logged,
  // so this isn't passing merely because nothing meaningful was logged.
  expect(lines.some((l) => l.includes(CLIENT_ID))).toBe(true);
});
