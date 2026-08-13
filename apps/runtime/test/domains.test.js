/**
 * @file WO B2 — what a mapped custom domain is allowed to be.
 *
 * The gate these assertions describe is the reason custom domains are not just
 * a nicer URL: the console, the builder and the whole privileged API ship in the
 * same handler as the funnel pages, so a client's hostname pointed at this
 * project serves all of it — same-origin, so the CSRF check passes, leaving
 * `ADMIN_TOKEN` as the only thing in the way. Design: PHASE-2-PLAN.md §2.
 *
 * Written against `handleRequest` directly rather than a spawned server, because
 * the whole subject is the `Host` header and a real request to `localhost:PORT`
 * carries its own.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Deleted, never restored — a restore hands the next file the developer's real
 * project. `FUNNEL_DOMAINS` is set per test below and cleared in afterEach. */
for (const key of [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_TOKEN",
  "INTERNAL_SECRET",
  "WEBHOOK_URL",
  "ZAPIER_WEBHOOK_URL",
  "NOTIFY_EMAIL",
  "FUNNEL_DOMAINS",
]) {
  delete process.env[key];
}

const scratch = await mkdtemp(join(await tmpParent(), "openfunnel-domains-"));
process.env.DATA_DIR = scratch;

async function tmpParent() {
  const dir = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(dir, { recursive: true });
  return dir;
}

const { handleRequest } = await import("../handler.js");
const { invalidateDomains, normalizeHost } = await import("../lib/domains.js");
const { ADMIN_TOKEN } = await import("../lib/config.js");

/** `lead-gen` is in `examples/`, which is the default FUNNELS_DIR. */
const SLUG = "lead-gen";
const HOST = "angebot.client-firma.test";
/** The console's own hostname — allowed loopback trust, never mappable. */
const CONSOLE_HOST = "console.example.test";

beforeEach(() => {
  process.env.DATA_DIR = scratch;
  process.env.FUNNEL_DOMAINS = `${HOST}=${SLUG}`;
  // Loopback trust also validates the `Host` header (DNS rebinding, see
  // auth.js), and the admin assertions below need a request whose host is NOT
  // loopback — the lockout guard's whole subject is a real hostname. Set per
  // test rather than once before the import: `bun test` runs every file in one
  // process, so whether `auth.js` had already been loaded by another file
  // decided whether this file's console host was trusted. It passed locally and
  // 401'd in CI purely on file order.
  process.env.ALLOWED_HOSTS = CONSOLE_HOST;
  // Per test, and not only once at import: `bun test` shares one process across
  // files, `dbConfigured()` reads the environment per call, and a file that runs
  // before this one sets these for its own fixtures. Without this, the
  // database-less assertions below describe whichever file loaded first.
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    delete process.env[key];
  }
  invalidateDomains();
});

afterEach(() => {
  delete process.env.FUNNEL_DOMAINS;
  // Unset, never restored — leaving it would hand the next file's loopback
  // checks a host allowance it never asked for.
  delete process.env.ALLOWED_HOSTS;
  invalidateDomains();
});

/**
 * @param {string} path
 * @param {string} host
 * @param {RequestInit} [init]
 */
const get = (path, host, init = {}) =>
  handleRequest(new Request(`http://${host}${path}`, { headers: { host }, ...init }));

/* ========================================================================== *
 *  What a funnel host serves
 * ========================================================================== */

test("the mapped host serves its funnel at the root", async () => {
  const res = await get("/", HOST);
  expect(res.status).toBe(200);

  const body = await res.text();
  // The page, not the console shell. Both are HTML, so assert on something only
  // the funnel page has: the inlined document.
  expect(body).toContain(`"slug":"${SLUG}"`);
  expect(res.headers.get("content-security-policy")).toContain("script-src");
});

test("its own /f/<slug> still works, and another funnel's does not", async () => {
  expect((await get(`/f/${SLUG}`, HOST)).status).toBe(200);
  // One host serves one funnel. Serving a second here would put another
  // client's page on this client's domain.
  expect((await get("/f/fitness", HOST)).status).toBe(404);
});

test("the engine assets and lead capture still work", async () => {
  expect((await get("/_of/index.js", HOST)).status).toBe(200);

  const res = await handleRequest(
    new Request(`http://${HOST}/api/lead`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ funnelId: SLUG, sessionId: "s1", lead: { email: "domain@example.invalid" } }),
    }),
  );
  // A funnel that cannot submit is not a funnel.
  expect(res.status).toBe(202);
});

/* ========================================================================== *
 *  What it refuses — 404, not 401
 * ========================================================================== */

test("the console, the funnel list and every gated route are absent on a funnel host", async () => {
  for (const path of [
    "/builder", // the console shell
    "/leads",
    "/_app/app.js", // its assets
    "/api/funnels", // the LIST — every other client's slug and name
    "/api/admin/leads",
    "/api/admin/email-settings",
    "/api/builder/save",
    "/api/ai/generate",
    "/api/internal/drain",
    // Not an exception either: an uptime probe belongs on the console host, and
    // a client's domain has no reason to report whether a database is
    // configured. It answers 200 on the console host — asserted below.
    "/healthz",
  ]) {
    const res = await get(path, HOST);
    // 404 and not 401: a client's domain must not advertise that there is an
    // admin API behind it worth guessing at. Same posture /api/internal/* takes
    // when INTERNAL_SECRET is unset.
    expect(`${path} → ${res.status}`).toBe(`${path} → 404`);
  }
});

test("the console host is completely unaffected", async () => {
  for (const [path, status] of [
    ["/", 200],
    ["/builder", 200],
    ["/api/funnels", 200],
    ["/api/admin/leads", 401],
    ["/healthz", 200],
  ]) {
    const res = await get(String(path), "localhost");
    expect(`${path} → ${res.status}`).toBe(`${path} → ${status}`);
  }
});

/* ========================================================================== *
 *  The lookup itself
 * ========================================================================== */

test("a host matches exactly, after normalisation and never by suffix", async () => {
  // The forms a real client sends: a port, a capital, the fully-qualified
  // trailing dot. All three are the same host.
  expect((await get("/", `${HOST}:443`)).status).toBe(200);
  expect((await get("/", HOST.toUpperCase())).status).toBe(200);
  expect((await get("/", `${HOST}.`)).status).toBe(200);

  // And the ones that must NOT be: `Host` is attacker-controlled, so a suffix
  // or substring test here would let anyone claim a client's mapping.
  for (const host of [
    `${HOST}.attacker.test`,
    `evil-${HOST}`,
    `sub.${HOST}`,
    "client-firma.test",
  ]) {
    const res = await get("/", host);
    // The console host answers 200 for "/" too, so assert on what it served
    // rather than on the status.
    expect(`${host} → ${(await res.text()).includes(`"slug":"${SLUG}"`)}`).toBe(`${host} → false`);
  }
});

test("normalizeHost refuses what is not a hostname rather than guessing", () => {
  expect(normalizeHost("Client-Firma.TEST:8080")).toBe("client-firma.test");
  expect(normalizeHost("client-firma.test.")).toBe("client-firma.test");
  // No dot, so not a domain: `localhost` is the console host and must never
  // resolve through this table.
  expect(normalizeHost("localhost")).toBe("");
  expect(normalizeHost("[::1]:3000")).toBe("");
  expect(normalizeHost("evil.test/../x")).toBe("");
  expect(normalizeHost(undefined)).toBe("");

  // An internationalised domain has two spellings and they must normalise to
  // one: the operator types the readable form into the console, the browser
  // sends the `xn--` form in `Host`. A hand-written lowercase-and-strip would
  // store a row nothing could ever match.
  expect(normalizeHost("kaufhaus-münchen.de")).toBe(normalizeHost("xn--kaufhaus-mnchen-8vb.de"));
  expect(normalizeHost("kaufhaus-münchen.de")).toStartWith("xn--");
});

test("a malformed FUNNEL_DOMAINS entry is skipped, not half-applied", async () => {
  process.env.FUNNEL_DOMAINS = `broken-no-slug,${HOST}=${SLUG},other.test=NOT A SLUG`;
  invalidateDomains();

  expect((await get("/", HOST)).status).toBe(200);
  // The bad entries do not become mappings, so those hosts stay console hosts.
  const res = await get("/api/funnels", "other.test");
  expect(res.status).toBe(200);
});

/* ========================================================================== *
 *  The console's own API for the mapping
 * ========================================================================== */

/** Loopback, so `requireAdmin` passes with no ADMIN_TOKEN set — as it does locally. */
const bunServer = { requestIP: () => ({ address: "127.0.0.1" }) };

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
const adminHeaders = ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {};

const admin = (path, init = {}) =>
  handleRequest(
    new Request(`http://localhost${path}`, { headers: { host: "localhost", ...adminHeaders }, ...init }),
    { server: bunServer },
  );

const postDomain = (/** @type {any} */ body, host = "localhost") =>
  handleRequest(
    new Request(`http://${host}/api/admin/domains`, {
      method: "POST",
      headers: { host, "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify(body),
    }),
    { server: bunServer },
  );

test("the console can read the mapping, including the env one it cannot delete", async () => {
  const res = await admin("/api/admin/domains");
  expect(res.status).toBe(200);

  const body = await res.json();
  // The SOURCE travels with the row. Without it the console offered a Remove
  // button for a mapping that lives in an env var, and the delete — matching no
  // row, but succeeding anyway — reported the client's domain disconnected
  // while it was still serving.
  expect(body.domains).toContainEqual({ host: HOST, slug: SLUG, source: "env" });
  // No database here, so nothing is writable — the console needs to know that
  // rather than offering a form whose every submit 503s.
  expect(body.writable).toBe(false);
});

test("mapping the console's own host is refused, before anything else is checked", async () => {
  // The one mistake that cannot be undone from the console: every admin route
  // is 404 on a mapped host, so this would need a row deleted in the database.
  const res = await postDomain({ host: CONSOLE_HOST, slug: SLUG }, CONSOLE_HOST);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "would_lock_out_console" });
});

test("a host or slug that is not one is refused", async () => {
  expect((await postDomain({ host: "not a host", slug: SLUG })).status).toBe(400);
  expect((await postDomain({ host: "ok.example.test", slug: "../etc/passwd" })).status).toBe(400);
  // Valid, but there is no database to write it to — and that is a different
  // answer from "your input was wrong".
  expect((await postDomain({ host: "ok.example.test", slug: SLUG })).status).toBe(503);
});

test("an env mapping cannot be deleted through the API, and says so", async () => {
  const res = await handleRequest(
    new Request(`http://localhost/api/admin/domains?host=${encodeURIComponent(HOST)}`, {
      method: "DELETE",
      headers: { host: "localhost", ...adminHeaders },
    }),
    { server: bunServer },
  );
  // Not `{ ok: true }`: there is no row, PostgREST would delete nothing and
  // report success, and the mapping would be back on the next read.
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "env_mapping" });
});

test("a mixed-case slug is refused here rather than by the table's constraint", async () => {
  // SLUG_RE is case-insensitive; the `domain` table's CHECK is not. Without
  // this the insert failed in Postgres and surfaced as `db_unavailable`, which
  // sends the operator to look at the database for a typo in their own input.
  const res = await postDomain({ host: "ok.example.test", slug: "Lead-Gen" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_slug" });
});

test("OPTIONS answers the same on a funnel host as on the console host", async () => {
  // The gate runs before the preflight now, so this asserts the two did not
  // come apart: the ingest paths keep their CORS headers on a client's domain
  // (the page posts leads from there) and nothing else gains any.
  for (const host of [HOST, "localhost"]) {
    const lead = await handleRequest(new Request(`http://${host}/api/lead`, { method: "OPTIONS", headers: { host } }));
    expect(`${host} lead ${lead.status} ${lead.headers.get("access-control-allow-origin")}`).toBe(`${host} lead 204 *`);

    const admin = await handleRequest(
      new Request(`http://${host}/api/admin/leads`, { method: "OPTIONS", headers: { host } }),
    );
    // A bare 204 with no CORS headers — identical on both hosts, so the reply
    // reveals nothing about which routes exist where.
    expect(`${host} admin ${admin.status} ${admin.headers.get("access-control-allow-origin")}`).toBe(
      `${host} admin 204 null`,
    );
  }
});
