/**
 * @file `GET /api/admin/privacy-notice` — the ROUTE that assembles `facts` for
 * `privacyNotice()` (lib/privacy.js). `privacy.test.js` already pins the pure
 * function's derivation; this file pins the thing only the route can get
 * wrong: which `delivery_target` ROWS reach that function in the first place.
 *
 * The bug this file exists to pin: `delivery_target` rows are PER FUNNEL —
 * the table has both `client_id` and a nullable `funnel_id`, and
 * `ingest_lead` (supabase/migrations/20260811120100_phase1_functions.sql)
 * queues a lead against exactly this predicate:
 *
 *   where t.client_id = v_funnel.client_id
 *     and t.enabled
 *     and (t.funnel_id is null or t.funnel_id = v_funnel.id)
 *
 * The route originally selected a client's targets filtered on `client_id`
 * ALONE, so a client with two funnels — one with a webhook target, one with
 * none — got the FIRST funnel's webhook described in the SECOND funnel's
 * published privacy notice: a legal document naming a recipient that never
 * receives anything from that funnel. The route now selects `kind,funnel_id`
 * and filters in JS with the same predicate as the SQL above.
 *
 * Written against `handleRequest` directly with a stubbed PostgREST, the same
 * shape `funnels-gate.test.js` and `subjects.test.js` use.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Deleted, never restored — see the identical note in subjects.test.js and
 * funnels-gate.test.js: the next test file in the same `bun test` process must
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

const scratch = await mkdtemp(join(await tmpParent(), "openfunnel-privacy-route-"));
process.env.DATA_DIR = scratch;

const { handleRequest } = await import("../handler.js");
const { ADMIN_TOKEN } = await import("../lib/config.js");

const realFetch = globalThis.fetch;

const VALID_LEGAL = { impressumUrl: "https://example.invalid/impressum", privacyUrl: "https://example.invalid/datenschutz" };
const SIGNED_AVV = "2026-01-01T00:00:00.000Z";

/** A minimal, servable funnel document — same shape `funnels-gate.test.js` uses. */
const doc = (over = {}) => ({
  name: "Privacy Route Test Funnel",
  steps: [{ id: "s1", type: "content", headline: "Hi", blocks: [] }],
  legal: VALID_LEGAL,
  ...over,
});

/**
 * Points the runtime at a database that exists only in this function.
 *
 * `fixtures.funnels[slug]` answers BOTH funnel queries the route touches for
 * that slug — `funnels.js`'s `client(avv_signed_at)` embed (the gate) and the
 * route's own `client(name,contact_email,retention_months,avv_signed_at)`
 * embed — because a real `slug=eq.<slug>` row answers both selects, just with
 * different columns.
 *
 * `fixtures.targets[clientId]` answers `/delivery_target?...&client_id=eq.<id>`
 * with ALL of that client's enabled rows, `funnel_id` included — exactly what
 * PostgREST would return, since the query itself has no `funnel_id` filter.
 * The per-funnel filtering is the thing under test, so the stub must NOT do
 * it for the route.
 *
 * @param {{
 *   funnels: Record<string, { id: string, clientId: string, doc: any, avv?: string|null }>,
 *   clients: Record<string, { name: string, contact_email: string, retention_months: number, avv_signed_at: string|null }>,
 *   targets?: Record<string, Array<{ kind: string, funnel_id: string|null, config?: any }>>,
 * }} fixtures
 */
function stubDb(fixtures) {
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      const target = String(url);
      const reply = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const u = new URL(target);

      if (u.pathname.endsWith("/funnel")) {
        const slugParam = u.searchParams.get("slug");
        const slug = slugParam ? decodeURIComponent(slugParam.replace(/^eq\./, "")) : null;
        const row = slug ? fixtures.funnels[slug] : undefined;
        if (!row) return reply([]);

        const select = u.searchParams.get("select") || "";
        if (select.includes("client(avv_signed_at)")) {
          // funnels.js's loadFromDb — the gate's own query.
          return reply([{ slug, doc: row.doc, status: "draft", client: { avv_signed_at: row.avv ?? SIGNED_AVV } }]);
        }
        if (select.includes("client(name,contact_email")) {
          // The privacy-notice route's own query.
          const c = fixtures.clients[row.clientId];
          return reply([
            { id: row.id, client_id: row.clientId, client: c ? { ...c } : null },
          ]);
        }
        throw new Error(`unexpected funnel select in a stubbed test: ${select}`);
      }

      if (u.pathname.endsWith("/delivery_target")) {
        const clientIdParam = u.searchParams.get("client_id");
        const clientId = clientIdParam ? clientIdParam.replace(/^eq\./, "") : null;
        return reply((fixtures.targets && clientId && fixtures.targets[clientId]) || []);
      }

      throw new Error(`unexpected request in a stubbed test: ${target}`);
    }
  );
}

/** Loopback, so `requireAdmin` passes with no ADMIN_TOKEN set — as it does locally. */
const bunServer = { requestIP: () => ({ address: "127.0.0.1" }) };
const adminHeaders = ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {};

/** @param {string} slug */
const admin = (slug) =>
  handleRequest(
    new Request(`http://localhost/api/admin/privacy-notice?slug=${encodeURIComponent(slug)}`, {
      headers: { host: "localhost", ...adminHeaders },
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

const CLIENT = {
  name: "Musterfirma GmbH",
  contact_email: "info@musterfirma.example.invalid",
  retention_months: 12,
  avv_signed_at: SIGNED_AVV,
};

/* Every slug below is distinct on purpose: `lib/funnels.js` caches documents
 * in-process (`readFunnel`'s `cache` Map, keyed by slug), and a shared slug
 * across tests would let one test's fixture answer another's request instead
 * of the stub above. `CACHE_MS` is 0 for the whole `bun test` process anyway
 * (DEV latches true — see funnels-gate.test.js's note on the same subject),
 * so this is belt-and-braces rather than load-bearing today, and cheap
 * insurance against it becoming load-bearing later. */

/* ========================================================================== *
 *  1 + 2. Per-funnel filtering, refusal AND success side by side — a webhook
 *  belonging to a SIBLING funnel of the same client must not appear; a
 *  webhook belonging to THIS funnel must. Test 1 alone would pass even if the
 *  route returned no targets at all, ever — test 2 is what proves it isn't.
 * ========================================================================== */

test("a webhook target belonging to another funnel of the same client is not described in this funnel's notice", async () => {
  const CLIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const THIS_FUNNEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const OTHER_FUNNEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const SLUG = "privacy-route-sibling-webhook";

  stubDb({
    funnels: { [SLUG]: { id: THIS_FUNNEL_ID, clientId: CLIENT_ID, doc: doc() } },
    clients: { [CLIENT_ID]: CLIENT },
    targets: {
      [CLIENT_ID]: [{ kind: "webhook", funnel_id: OTHER_FUNNEL_ID, config: { url: "https://evil.invalid/hook?token=SUPERSECRET" } }],
    },
  });

  const res = await admin(SLUG);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.text).not.toMatch(/Webhook/);
  expect(body.warnings.some((w) => /Webhook-Ziel/.test(w))).toBe(false);
});

test("a webhook target belonging to THIS funnel is described in its notice", async () => {
  const CLIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
  const THIS_FUNNEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
  const SLUG = "privacy-route-own-webhook";

  stubDb({
    funnels: { [SLUG]: { id: THIS_FUNNEL_ID, clientId: CLIENT_ID, doc: doc() } },
    clients: { [CLIENT_ID]: CLIENT },
    targets: {
      [CLIENT_ID]: [{ kind: "webhook", funnel_id: THIS_FUNNEL_ID, config: { url: "https://evil.invalid/hook?token=SUPERSECRET" } }],
    },
  });

  const res = await admin(SLUG);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.text).toMatch(/Webhook/);
  expect(body.warnings.some((w) => /Webhook-Ziel/.test(w))).toBe(true);
});

/* ========================================================================== *
 *  3. A client-wide target (funnel_id: null) — the opposite over-correction
 *  from 1/2 would be dropping every target with no funnel_id, but a null
 *  there means "applies to every funnel of this client" (the same SQL `is
 *  null or =` the migration comment quotes), not "applies to none".
 * ========================================================================== */

test("a client-wide target (funnel_id null) is described in every one of the client's funnels' notices", async () => {
  const CLIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac";
  const THIS_FUNNEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd";
  const SLUG = "privacy-route-clientwide-target";

  stubDb({
    funnels: { [SLUG]: { id: THIS_FUNNEL_ID, clientId: CLIENT_ID, doc: doc() } },
    clients: { [CLIENT_ID]: CLIENT },
    targets: { [CLIENT_ID]: [{ kind: "webhook", funnel_id: null, config: { url: "https://evil.invalid/hook?token=SUPERSECRET" } }] },
  });

  const res = await admin(SLUG);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.text).toMatch(/Webhook/);
  expect(body.warnings.some((w) => /Webhook-Ziel/.test(w))).toBe(true);
});

/* ========================================================================== *
 *  4. `delivery_target.config` never leaks, even though the stub returns one
 *  — the route's own SELECT doesn't even ask for that column
 *  (`select=kind,funnel_id`), so this proves the omission holds end to end
 *  rather than merely trusting the query string never changes.
 * ========================================================================== */

test("delivery_target.config never reaches the response, even when the stubbed row carries a secret", async () => {
  const CLIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad";
  const THIS_FUNNEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbe";
  const SLUG = "privacy-route-config-leak";
  const SECRET_URL = "https://evil.invalid/hook?token=SUPERSECRET";

  stubDb({
    funnels: { [SLUG]: { id: THIS_FUNNEL_ID, clientId: CLIENT_ID, doc: doc() } },
    clients: { [CLIENT_ID]: CLIENT },
    targets: { [CLIENT_ID]: [{ kind: "webhook", funnel_id: THIS_FUNNEL_ID, config: { url: SECRET_URL, secret: "SUPERSECRET" } }] },
  });

  const res = await admin(SLUG);
  expect(res.status).toBe(200);
  const rawBody = await res.text();
  expect(rawBody).not.toContain("SUPERSECRET");
  expect(rawBody).not.toContain(SECRET_URL);
  expect(rawBody).not.toContain("evil.invalid");
  // Sanity check on the fixture: the target really was described (as a kind),
  // or the assertions above would be vacuous — a route that dropped the row
  // entirely also "never leaks the config" and would pass for the wrong reason.
  expect(JSON.parse(rawBody).text).toMatch(/Webhook/);
});

/* ========================================================================== *
 *  5. cache-control — the text embeds the client's name and contact email
 * ========================================================================== */

test("the response is never cacheable, because the text embeds the client's name and contact email", async () => {
  const CLIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae";
  const THIS_FUNNEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbf";
  const SLUG = "privacy-route-cache-control";

  stubDb({
    funnels: { [SLUG]: { id: THIS_FUNNEL_ID, clientId: CLIENT_ID, doc: doc() } },
    clients: { [CLIENT_ID]: CLIENT },
    targets: { [CLIENT_ID]: [] },
  });

  const res = await admin(SLUG);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body.text).toContain(CLIENT.name);
  expect(body.text).toContain(CLIENT.contact_email);
});

/* ========================================================================== *
 *  6. No database configured — the route still answers, deriving targets
 *  from the funnel document itself (lib/targets.js's deriveTargets) instead
 *  of querying delivery_target at all.
 * ========================================================================== */

test("with no database configured, the endpoint still answers 200 with a text, derived from the funnel document", async () => {
  // No stubDb call: SUPABASE_URL/KEY are deleted in beforeEach, so
  // `dbConfigured()` is false and the route's `select("funnel", …)` /
  // `select("delivery_target", …)` branch never runs — reaching `fetch` at
  // all here would itself be the bug this test would catch, so `fetch` is
  // left pointing at the real network-refusing implementation rather than a
  // stub that would silently hide such a call.
  //
  // `dbConfigured()` false also means `loadFunnelForVisitor`'s gate
  // (`gateReason`) short-circuits to null before it even looks at
  // `legal` — see `lib/funnels.js`, `if (!dbConfigured()) return null;` — so
  // this reads an on-disk example that ships with the repo rather than
  // needing its own fixture file.
  const res = await admin("lead-gen");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.text).toBe("string");
  expect(body.text.length).toBeGreaterThan(0);
  // No client row exists in this mode at all (there is no database to hold
  // one), so the notice's own AVV warning is the one thing guaranteed to be
  // there — pinning that the "no db" path really is exercised, not merely
  // that SOME text came back.
  expect(body.warnings.some((w) => /Auftragsverarbeitungsvereinbarung/.test(w))).toBe(true);
});

/* ========================================================================== *
 *  Auth — the route lives inside the same privileged branch as every other
 *  /api/admin/* endpoint; this is really a test that it did not escape it.
 * ========================================================================== */

test("the route refuses without admin credentials", async () => {
  const res = await handleRequest(
    new Request("http://console.example.test/api/admin/privacy-notice?slug=lead-gen", {
      headers: { host: "console.example.test" },
    }),
  );
  expect([401, 403]).toContain(res.status);
});
