/**
 * @file WO C3 — what `/r/:token` is allowed to be.
 *
 * The token in the path is the entire access control (PLAN.md §5.3), so what is
 * worth asserting here is not "a valid token renders a report" — that needs a
 * database and lives in `supabase/tests/report.sql`, where the rules actually
 * are. It is the four ways the link stops being a credential:
 *
 *   - a refusal that says WHICH refusal it was, so a prober learns their guess
 *     was close;
 *   - the report appearing on a mapped client domain, where one wrong mapping
 *     serves one client's leads on another client's brand;
 *   - the page reaching off-origin, which would carry the token out as a
 *     `Referer` on every subresource;
 *   - the token reaching a log.
 *
 * Written against `handleRequest` directly, like `domains.test.js`: the subject
 * is the router's own behaviour, and the report needs no server object.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Deleted, never restored — restoring hands the next file the developer's real
 * project (see feedback in CLAUDE.md's test notes). */
for (const key of [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_TOKEN",
  "INTERNAL_SECRET",
  "FUNNEL_DOMAINS",
]) {
  delete process.env[key];
}

const scratch = await mkdtemp(join(await tmpParent(), "openfunnel-report-"));
process.env.DATA_DIR = scratch;

async function tmpParent() {
  const dir = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(dir, { recursive: true });
  return dir;
}

const { handleRequest } = await import("../handler.js");
const { invalidateDomains } = await import("../lib/domains.js");
const { mintReportToken, reportTokenHash } = await import("../lib/report.js");

const HOST = "console.example.test";
const FUNNEL_HOST = "angebot.client-firma.test";
const SLUG = "lead-gen";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.DATA_DIR = scratch;
  // Per test, not once at import: `bun test` shares one process across files and
  // `dbConfigured()` reads the environment per call, so a file that ran earlier
  // would otherwise decide what these assertions are describing. The
  // database-backed tests below set them inside their own body.
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    delete process.env[key];
  }
  invalidateDomains();
});

afterEach(() => {
  delete process.env.FUNNEL_DOMAINS;
  // Unset, never restored: restoring would hand the next file the developer's
  // real Supabase project, and `lib/db.js` reads the connection per call.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = realFetch;
  invalidateDomains();
});

/**
 * Point the runtime at a database that only exists in this function.
 *
 * The report needs one to render at all, and without it every assertion about
 * what the PAGE does is vacuous — the route would answer 404 whether the code
 * were right or not. That was the first version of the mapped-host test below:
 * it passed with the gate deliberately broken.
 *
 * @param {{ leads?: any[], funnels?: any[], total?: number, d7?: number, d30?: number, resolves?: boolean }} [fixture]
 */
function stubDatabase(fixture = {}) {
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

  const report = {
    funnels: fixture.funnels ?? [{ slug: SLUG, name: "Lead Gen", total: 1, d7: 1, d30: 1 }],
    total: fixture.total ?? 1,
    d7: fixture.d7 ?? 1,
    d30: fixture.d30 ?? 1,
    leads: fixture.leads ?? [],
  };

  /** @type {{ url: string, body: string }[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      const target = String(url);
      calls.push({ url: target, body: String(init?.body ?? "") });
      const reply = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (target.includes("/rpc/rate_hit")) return reply(true);
      if (target.includes("/rpc/resolve_report_token")) {
        return reply(
          fixture.resolves === false
            ? []
            : [{ token_id: "11111111-1111-1111-1111-111111111111", client_id: "22222222-2222-2222-2222-222222222222", client_name: "Garten Barbian" }],
        );
      }
      if (target.includes("/rpc/client_report")) return reply(report);
      // Funnel documents: empty, so `loadFunnel` falls back to examples/ on disk.
      if (target.includes("/funnel")) return reply([]);
      // No rows in the domain table either — the mapping under test comes from
      // `FUNNEL_DOMAINS`, and answering here rather than throwing keeps the
      // fallback path out of the assertions (a thrown request works too, via
      // the table-unavailable branch, but for the wrong reason).
      if (target.includes("/domain")) return reply([]);
      throw new Error(`unexpected request in a stubbed test: ${target}`);
    }
  );
  return calls;
}

/**
 * @param {string} path
 * @param {string} [host]
 */
const get = (path, host = HOST) =>
  handleRequest(new Request(`http://${host}${path}`, { headers: { host } }));

/* ========================================================================== *
 *  Every refusal looks the same
 * ========================================================================== */

test("a malformed token, a well-formed unknown one and no token at all are byte-identical", async () => {
  const { token } = mintReportToken();
  const paths = [
    "/r/", // nothing at all
    "/r/nope", // not the right shape
    `/r/${token}`, // the right shape, and no database to know it
    `/r/${token}xx`, // one that is too long
    `/r/${token}/extra`, // a second URL for the same page, if it were allowed
  ];

  /** @type {Set<string>} */
  const shapes = new Set();
  for (const path of paths) {
    const res = await get(path);
    shapes.add(`${res.status} ${await res.text()}`);
  }

  // ONE distinct answer across all of them. A report link that distinguishes
  // "expired" from "never existed" tells a prober which half of a guess was
  // right — and the entropy of the token is the only control there is.
  expect([...shapes]).toEqual(["404 Not found"]);
});

test("a traversal out of /r/ lands on the gated route, not inside the report", async () => {
  // The WHATWG parser resolves `..` before the router sees a path, so this
  // arrives as `/api/admin/leads` — which must then be refused BY THE PRIVILEGED
  // GATE rather than answered as a report. A 404 here would be the friendlier
  // answer and the wrong one: it would mean `/r/` had matched first and the
  // report route was deciding what happens to admin paths.
  const res = await get("/r/../api/admin/leads");
  expect(res.status).toBe(401);
});

test("with no database configured there is no report at all", async () => {
  const { token } = mintReportToken();
  const res = await get(`/r/${token}`);
  expect(res.status).toBe(404);
  // Not a 503 and not an error page: the JSONL sink has no client_id, so there
  // is nothing to scope a report to on that path (PHASE-2-PLAN.md §3, Dec. 8).
});

/* ========================================================================== *
 *  Where the report may appear
 * ========================================================================== */

test("the report is absent on a mapped funnel host, and present on the console host", async () => {
  stubDatabase();
  process.env.FUNNEL_DOMAINS = `${FUNNEL_HOST}=${SLUG}`;
  invalidateDomains();

  const { token } = mintReportToken();

  // The same token, the same deployment, two hostnames. The console host renders
  // it — which is what makes the 404 below mean the GATE and not a fixture that
  // was never going to render anywhere.
  expect((await get(`/r/${token}`)).status).toBe(200);

  // Refused not because report.js checks the host, but because
  // `handleFunnelHost` is an allowlist and nothing added `/r/` to it. That is the
  // property under test: a route added later does not appear on a client's
  // domain by default. "Fixing" this by adding /r/ to the allowlist fails here.
  expect((await get(`/r/${token}`, FUNNEL_HOST)).status).toBe(404);

  // And the funnel itself still serves on that host, so the 404 is the gate
  // rather than a broken mapping.
  expect((await get("/", FUNNEL_HOST)).status).toBe(200);
});

/* ========================================================================== *
 *  The page itself
 * ========================================================================== */

test("the page carries the headers that keep the token out of a Referer and out of an index", async () => {
  stubDatabase();
  const { token } = mintReportToken();
  const res = await get(`/r/${token}`);

  expect(res.status).toBe(200);
  // The secret is in the PATH, so the shared `strict-origin-when-cross-origin`
  // is not enough: a click-out would carry the whole URL.
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-robots-tag")).toContain("noindex");
  expect(res.headers.get("cache-control")).toContain("no-store");

  // Nothing off-origin: no script, no font, no image, no third party. §8.2
  // applies to this page exactly as it does to a funnel page.
  const csp = res.headers.get("content-security-policy") || "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");

  const body = await res.text();
  expect(body).not.toContain("<script");
  // Nothing the browser would fetch: no subresource of any kind, so there is no
  // request that could carry this URL out as a `Referer` in the first place.
  expect(body).not.toMatch(/<(script|img|iframe|link|source|video|audio)\b/);
  expect(body).not.toContain('href="http');
});

test("a hostile lead payload is escaped, and the client's own numbers are shown", async () => {
  stubDatabase({
    total: 3,
    d7: 2,
    d30: 3,
    leads: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        createdAt: "2026-08-13T09:00:00Z",
        funnel: "Lead Gen",
        slug: SLUG,
        // Every one of these came out of a public form body.
        payload: {
          lead: {
            name: "<img src=x onerror=alert(1)>",
            email: "kunde@example.invalid",
            // Not an address, and `mailto:` takes header parameters — so this
            // must be shown as text rather than becoming a link that CCs a
            // stranger on the client's reply to their own customer.
            phone: "kunde@example.invalid?cc=attacker@evil.invalid",
            // The same attack with the second address PERCENT-ENCODED, which is
            // the version that beat the first fix: `EMAIL_RE` sees no second `@`
            // and no whitespace, so a pattern-matching check passes it and the
            // browser resolves the `%40` back to `@` when the link is clicked.
            // Found by review, not by this file — the original assertion was the
            // literal-`@` case only, and it was green over a live bypass.
            mail: "opfer@example.invalid?cc=attacker%40evil.invalid",
          },
          answers: { budget: "</style><script>alert(2)</script>" },
        },
      },
    ],
  });

  const body = await (await get(`/r/${mintReportToken().token}`)).text();

  // The whole page is operator-facing HTML built from visitor-supplied strings,
  // and it is served on the same origin as the console.
  expect(body).not.toContain("<img src=x");
  expect(body).not.toContain("<script>alert(2)");
  expect(body).toContain("&lt;img src=x");
  // Contact details stay actionable — the report exists to be called back from.
  expect(body).toContain('href="mailto:kunde@example.invalid"');
  // …but only when the value is the thing its key claims to be. Neither the
  // literal nor the percent-encoded second address may become an href — a
  // `mailto:` carrying a `cc=` is the client's reply going to a stranger.
  expect(body).not.toMatch(/href="mailto:[^"]*cc=/);
  expect(body).not.toContain("attacker%40evil.invalid&quot;");
  expect(body).not.toContain('href="tel:');
  // Exactly one link on the page, and it is the address that is only an address.
  expect(body.match(/href="mailto:[^"]*"/g)).toEqual(['href="mailto:kunde@example.invalid"']);
  // The numbers the RPC returned, not a count of the rows that fit on the page.
  expect(body).toContain(">3<");
  expect(body).toContain(">2<");
});

test("a token the database refuses renders nothing, and looks like every other refusal", async () => {
  stubDatabase({ resolves: false });
  const res = await get(`/r/${mintReportToken().token}`);
  expect(`${res.status} ${await res.text()}`).toBe("404 Not found");
});

test("the router still answers everything else on the console host", async () => {
  // A `/r/` prefix that swallowed more than it should would be invisible until a
  // console route stopped working.
  expect((await get("/healthz")).status).toBe(200);
  expect((await get("/api/funnels")).status).toBe(200);
  expect((await get(`/f/${SLUG}`)).status).toBe(200);
});

/* ========================================================================== *
 *  The token itself
 * ========================================================================== */

test("a minted token is 256 bits of base64url and hashes to a bytea literal", () => {
  const { token, hash } = mintReportToken();

  // 32 bytes in base64url is 43 characters with no padding. Sized so that
  // walking the endpoint is not a strategy at any rate — an Art. 32 commitment
  // (PLAN.md §5.3), not a preference.
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(hash).toMatch(/^\\x[0-9a-f]{64}$/);
  expect(reportTokenHash(token)).toBe(hash);

  // Two mints are two tokens. A seeded or time-derived generator would pass
  // every other assertion in this file.
  expect(mintReportToken().token).not.toBe(token);
});

test("the token never reaches a log line", async () => {
  const { token } = mintReportToken();
  const warn = console.warn;
  /** @type {string[]} */
  const lines = [];
  console.warn = (...args) => void lines.push(args.map(String).join(" "));
  try {
    await get(`/r/${token}`);
  } finally {
    console.warn = warn;
  }

  // The one credential this route handles must not end up in the operator's log
  // aggregator, where it outlives the request and is readable by anyone with
  // log access. Same rule the runtime applies to `err.path`.
  for (const line of lines) expect(line).not.toContain(token);
});

/* ========================================================================== *
 *  Only GET
 * ========================================================================== */

test("the report answers GET and nothing else", async () => {
  const { token } = mintReportToken();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await handleRequest(
      new Request(`http://${HOST}/r/${token}`, { method, headers: { host: HOST } }),
    );
    expect(`${method} → ${res.status}`).toBe(`${method} → 404`);
  }
});
