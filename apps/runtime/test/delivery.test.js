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

/* A dead delivery now mails the operator (WO13), so this file's mail settings
 * have to come from nowhere. Unset, never restored — the standing rule. Without
 * it, a machine whose environment names a notification address and a provider
 * key records an extra outbound call in every stub below, and the assertions
 * that count them fail there and nowhere else. `DATA_DIR` points at a path that
 * does not exist for the same reason: `.data/email_settings.json` is per-machine
 * and would otherwise supply the address. */
for (const key of ["NOTIFY_EMAIL", "EMAIL_PROVIDER", "RESEND_API_KEY", "BREVO_API_KEY", "SMTP_RELAY_URL", "SMTP_HOST"]) {
  delete process.env[key];
}
process.env.DATA_DIR = ".tmp/no-mail-settings-here";

/* The alert keeps a per-process minimum gap so one drain invocation cannot pay
 * for it once per pass. Off by default here, or the first test to alert would
 * silently suppress every later one; the test that asserts the gap turns it back
 * on for itself. */
process.env.ALERT_MIN_GAP_MS = "0";

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

/* ========================================================================== *
 *  WO13 — a dead delivery reaches a person
 * ========================================================================== */

/**
 * Two rows that both die on their first attempt, with the mail path configured.
 * `127.0.0.1` is refused by the egress guard textually, so it is permanent and
 * no socket is ever opened — and the config carries a secret precisely so the
 * alert can be asserted not to contain it.
 *
 * @param {(fn: string) => Response} [rpcReply]
 */
function twoDeadDeliveries(rpcReply) {
  return stub(
    rpcReply ||
      ((fn) => {
        if (fn === "claim_deliveries") {
          return jsonResponse([
            claim({ delivery_id: 41, config: { url: "http://127.0.0.1/hook", secret: "whsec_topsecret" } }),
            claim({ delivery_id: 42, config: { url: "http://127.0.0.1/hook", secret: "whsec_topsecret" } }),
          ]);
        }
        if (fn === "rate_hit") return jsonResponse(true);
        return jsonResponse("dead");
      }),
  );
}

test("a whole pass of dead deliveries is ONE alert, and it names every row", async () => {
  process.env.NOTIFY_EMAIL = "ops@example.invalid";
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  try {
    const { drainOnce } = await import("../lib/delivery.js");
    const { targetCalls } = twoDeadDeliveries();

    const counts = await drainOnce();
    expect(counts.dead).toBe(2);

    // One message for the pass, not one per row: alerting per row would put an
    // awaited send on the delivery path and tell the operator about one outage
    // twice.
    const mails = targetCalls.filter((c) => c.url.includes("api.brevo.com"));
    expect(mails).toHaveLength(1);

    const body = JSON.parse(mails[0].init.body);
    expect(body.to).toEqual([{ email: "ops@example.invalid" }]);
    expect(body.htmlContent).toContain("41");
    expect(body.htmlContent).toContain("42");
    expect(body.htmlContent).toContain("lead-gen");
    expect(body.htmlContent).toContain("blocked egress target");
  } finally {
    delete process.env.NOTIFY_EMAIL;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
  }
});

// The alert is a copy of whatever it names leaving the server permanently, and
// a webhook URL routinely carries a token in its path.
test("the alert carries no target URL and no webhook secret", async () => {
  process.env.NOTIFY_EMAIL = "ops@example.invalid";
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  try {
    const { drainOnce } = await import("../lib/delivery.js");
    const { targetCalls } = twoDeadDeliveries();

    await drainOnce();

    const mail = targetCalls.find((c) => c.url.includes("api.brevo.com"));
    expect(mail.init.body).not.toContain("whsec_topsecret");
    expect(mail.init.body).not.toContain("127.0.0.1");
  } finally {
    delete process.env.NOTIFY_EMAIL;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
  }
});

// An outage that dead-letters continuously would otherwise mail on every cron
// tick, forever. The row still dies and the console still shows it.
test("the hourly ceiling suppresses the alert without changing the outcome", async () => {
  process.env.NOTIFY_EMAIL = "ops@example.invalid";
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  try {
    const { drainOnce } = await import("../lib/delivery.js");
    const { targetCalls } = twoDeadDeliveries((fn) => {
      if (fn === "claim_deliveries") {
        return jsonResponse([claim({ delivery_id: 41, config: { url: "http://127.0.0.1/hook" } })]);
      }
      if (fn === "rate_hit") return jsonResponse(false); // ceiling reached
      return jsonResponse("dead");
    });

    const counts = await drainOnce();

    expect(counts.dead).toBe(1);
    expect(targetCalls.filter((c) => c.url.includes("api.brevo.com"))).toHaveLength(0);
  } finally {
    delete process.env.NOTIFY_EMAIL;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
  }
});

// A self-hoster with no notification address configured has nobody to tell. It
// must not throw, and it must not hold the drain open trying.
test("with no notification address, a dead delivery mails nobody", async () => {
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  try {
    const { drainOnce } = await import("../lib/delivery.js");
    const { targetCalls } = twoDeadDeliveries();

    const counts = await drainOnce();

    expect(counts.dead).toBe(2);
    expect(targetCalls).toHaveLength(0);
  } finally {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
  }
});

// A mail transport that is itself broken is the most likely state at the moment
// a delivery dies. The alert failing must not lose the drain's counts.
test("a failing alert never breaks the drain that produced it", async () => {
  process.env.NOTIFY_EMAIL = "ops@example.invalid";
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  try {
    const { drainOnce } = await import("../lib/delivery.js");
    stub(
      (fn) => {
        if (fn === "claim_deliveries") {
          return jsonResponse([claim({ delivery_id: 41, config: { url: "http://127.0.0.1/hook" } })]);
        }
        if (fn === "rate_hit") return jsonResponse(true);
        return jsonResponse("dead");
      },
      () => {
        throw new TypeError("fetch failed"); // the mail POST itself
      },
    );

    expect(await drainOnce()).toEqual({ claimed: 1, done: 0, failed: 0, dead: 1 });
  } finally {
    delete process.env.NOTIFY_EMAIL;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
  }
});

// `routes/internal.js` calls `drainOnce` repeatedly inside one HTTP request, and
// during the outage this feature exists for, every pass produces a dead row.
// Without the gap the invocation re-pays the alert's rate-limit round trip and
// send per pass and can overrun `pg_net`'s 55s window — recording a drain that
// succeeded as a timeout. Review round 1's second Major.
test("one invocation pays for the alert once, not once per pass", async () => {
  process.env.NOTIFY_EMAIL = "ops@example.invalid";
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  try {
    const { drainOnce } = await import("../lib/delivery.js");
    const { targetCalls, rpcCalls } = twoDeadDeliveries();

    // Staged rather than run twice under the same gap, because the guard is a
    // module-level timestamp this file's earlier tests have already moved: the
    // first pass sends and stamps it, the second runs with the real gap in
    // force. What is being asserted is that the stamp suppresses the second.
    await drainOnce();
    process.env.ALERT_MIN_GAP_MS = "60000";
    await drainOnce();

    expect(targetCalls.filter((c) => c.url.includes("api.brevo.com"))).toHaveLength(1);
    // The rate-limit round trip is skipped too — it is the expensive half.
    expect(rpcCalls.filter((c) => c.fn === "rate_hit")).toHaveLength(1);
  } finally {
    process.env.ALERT_MIN_GAP_MS = "0";
    delete process.env.NOTIFY_EMAIL;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.BREVO_API_KEY;
  }
});
