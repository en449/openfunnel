/**
 * @file The console's delivery log and its re-send button, with `fetch` stubbed.
 *
 * Two things here are worth pinning rather than the routing itself:
 *
 *  - The log must never carry `delivery_target.config`. That column holds the
 *    webhook secret, and the console is the one place an operator would paste a
 *    screenshot from. Both the request and the response are asserted, because a
 *    select that stops naming its columns would leak it without any test that
 *    reads only the response ever noticing.
 *  - Re-send must refuse a row that is `delivering`. A lease is out on it, and
 *    dispatching a second time is a duplicate lead in the client's CRM — the one
 *    failure the idempotency key exists to prevent and which a manual re-send
 *    deliberately bypasses by rotating that key.
 *
 * `lib/db.js` reads its connection per call, so the environment is set at import
 * and UNSET at the end — never restored. `server.test.js` spawns a real server
 * with a copy of this environment, and leaving it configured points that server
 * at a database that does not exist.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

process.env.SUPABASE_URL = "https://db.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

/* Re-send drains inline, and a delivery that dies there mails the operator
 * (WO13). Same rule as delivery.test.js: unset, never restored. */
for (const key of ["NOTIFY_EMAIL", "EMAIL_PROVIDER", "RESEND_API_KEY", "BREVO_API_KEY", "SMTP_RELAY_URL", "SMTP_HOST"]) {
  delete process.env[key];
}
process.env.DATA_DIR = ".tmp/no-mail-settings-here";

const { handleAdmin } = await import("../routes/admin.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stub `fetch`, recording every URL it was called with. */
function stub(responder) {
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      urls.push(String(url));
      return responder(String(url), init);
    }
  );
  return urls;
}

/** Answers the calls every route in this file makes, so a test only names what it cares about. */
function db({ rows = [], resend = true } = {}) {
  return stub((url) => {
    if (url.includes("/rpc/rate_hit")) return jsonResponse(true);
    if (url.includes("/rpc/resend_delivery")) return jsonResponse(resend);
    if (url.includes("/rpc/claim_deliveries")) return jsonResponse([]);
    if (url.includes("/delivery?")) return jsonResponse(rows.shift() ?? []);
    return jsonResponse([]);
  });
}

const get = (query = "") =>
  handleAdmin(new Request(`http://console.test/api/admin/deliveries${query}`), {
    path: "/api/admin/deliveries",
    url: new URL(`http://console.test/api/admin/deliveries${query}`),
    server: null,
  });

const resend = (body) =>
  handleAdmin(
    new Request("http://console.test/api/admin/deliveries/resend", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    {
      path: "/api/admin/deliveries/resend",
      url: new URL("http://console.test/api/admin/deliveries/resend"),
      server: null,
    },
  );

const ROW = {
  id: 42,
  status: "dead",
  attempts: 8,
  last_error: "HTTP 500 from receiver",
  last_status: 500,
  next_attempt_at: "2026-08-12T10:00:00Z",
  created_at: "2026-08-12T09:00:00Z",
  delivered_at: null,
  lead: {
    id: "lead-uuid",
    funnel_id: "funnel-uuid",
    created_at: "2026-08-12T08:59:00Z",
    funnel: { slug: "lead-gen" },
  },
  delivery_target: { kind: "webhook" },
};

/* ========================================================================== *
 *  The log
 * ========================================================================== */

test("the log flattens a row into the console's shape", async () => {
  db({ rows: [[ROW]] });
  const body = await (await get()).json();

  expect(body.deliveries).toEqual([
    {
      id: 42,
      status: "dead",
      attempts: 8,
      lastError: "HTTP 500 from receiver",
      lastStatus: 500,
      nextAttemptAt: "2026-08-12T10:00:00Z",
      createdAt: "2026-08-12T09:00:00Z",
      deliveredAt: null,
      kind: "webhook",
      leadId: "lead-uuid",
      funnelId: "funnel-uuid",
      // The console's funnel list is keyed by slug, so the label has to come
      // from the server; `funnel.id` is a UUID it never sees anywhere else.
      funnelSlug: "lead-gen",
      leadCreatedAt: "2026-08-12T08:59:00Z",
    },
  ]);
});

test("the target's config is neither asked for nor returned", async () => {
  // The row a database would send back if the select ever stopped naming its
  // columns. Nothing may carry it outward.
  const leaky = { ...ROW, delivery_target: { kind: "webhook", config: { secret: "shhh", url: "https://crm.test/hook?token=abc" } } };
  const urls = db({ rows: [[leaky]] });

  const body = await (await get()).json();

  expect(urls[0]).toContain("delivery_target(kind)");
  expect(urls[0]).not.toContain("config");
  expect(JSON.stringify(body)).not.toContain("shhh");
  expect(JSON.stringify(body)).not.toContain("token=abc");
});

test("an unknown status is refused instead of being passed to PostgREST", async () => {
  const urls = db();
  const res = await get("?status=deleted");

  expect(res.status).toBe(400);
  expect(urls).toEqual([]);
});

test("a known status filters, and the limit is clamped", async () => {
  const urls = db({ rows: [[]] });
  await get("?status=dead&limit=9999");

  expect(urls[0]).toContain("status=eq.dead");
  expect(urls[0]).toContain("limit=500");
});

test("a database outage is a 503, not an empty log", async () => {
  stub(() => jsonResponse({ message: "boom" }, 500));
  const res = await get();

  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "db_unavailable" });
});

/* ========================================================================== *
 *  Re-send
 * ========================================================================== */

test("re-send refuses a row that is still leased, without calling the RPC", async () => {
  const urls = db({ rows: [[{ id: 42, status: "delivering", lead_id: "lead-uuid" }]] });
  const res = await resend({ id: 42 });

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "not_resendable", status: "delivering" });
  expect(urls.some((u) => u.includes("resend_delivery"))).toBe(false);
});

test("re-send refuses a row that is merely pending", async () => {
  // Subtler than `delivering`: the row is not leased, so nothing looks unsafe —
  // but it is already going to be attempted, and a re-send would rotate its
  // idempotency key for no reason and reset the attempt count that decides when
  // it dead-letters.
  const urls = db({ rows: [[{ id: 42, status: "pending", lead_id: "lead-uuid" }]] });
  const res = await resend({ id: 42 });

  expect(res.status).toBe(409);
  expect(urls.some((u) => u.includes("resend_delivery"))).toBe(false);
});

test("a delivered row can be re-sent — a receiver that lost it is the reason the button exists", async () => {
  db({
    rows: [
      [{ id: 42, status: "done", lead_id: "lead-uuid" }],
      [{ status: "done", attempts: 1, last_error: null, last_status: 200 }],
    ],
  });

  expect((await resend({ id: 42 })).status).toBe(200);
});

test("a restricted lead is named as the reason, not reported as a lost race", async () => {
  // Art. 18: the refusal is permanent, and an operator told "the state changed"
  // clicks again. `resend_delivery` refuses with the same boolean either way.
  stub((url) => {
    if (url.includes("/rpc/rate_hit")) return jsonResponse(true);
    if (url.includes("/rpc/resend_delivery")) return jsonResponse(false);
    if (url.includes("/lead?")) return jsonResponse([{ restricted: true, deleted_at: null }]);
    return jsonResponse([{ id: 42, status: "dead", lead_id: "lead-uuid" }]);
  });

  const res = await resend({ id: 42 });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "lead_restricted" });
});

test("re-send of an unknown row is a 404", async () => {
  db({ rows: [[]] });
  expect((await resend({ id: 999 })).status).toBe(404);
});

test("a non-numeric id never reaches the database", async () => {
  const urls = db();
  expect((await resend({ id: "42; drop table lead" })).status).toBe(400);
  expect(urls).toEqual([]);
});

test("re-send resets the row, attempts it inline, and answers with the state that followed", async () => {
  const urls = db({
    rows: [
      [{ id: 42, status: "dead", lead_id: "lead-uuid" }],
      [{ status: "done", attempts: 1, last_error: null, last_status: 200 }],
    ],
  });

  const body = await (await resend({ id: 42 })).json();

  expect(body).toEqual({ ok: true, status: "done", attempts: 1, lastError: null, lastStatus: 200 });
  // The drain ran for THIS lead, not for the whole queue.
  expect(urls.some((u) => u.includes("claim_deliveries"))).toBe(true);
});

test("the RPC's refusal wins over the read that preceded it", async () => {
  // The row was claimed between the read and the write — the race the RPC's own
  // status filter exists to lose safely.
  db({ rows: [[{ id: 42, status: "dead", lead_id: "lead-uuid" }]], resend: false });
  const res = await resend({ id: 42 });

  expect(res.status).toBe(409);
});

/* ========================================================================== *
 *  No database at all
 * ========================================================================== */

test("without a database both routes say so rather than pretending to be empty", async () => {
  const url = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const listed = await get();
    expect(listed.status).toBe(503);
    expect(await listed.json()).toEqual({ error: "db_not_configured" });
    expect((await resend({ id: 42 })).status).toBe(503);
  } finally {
    process.env.SUPABASE_URL = url;
  }
});
