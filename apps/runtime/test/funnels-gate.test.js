/**
 * @file WO D2 — the serve-time legal gate (PHASE-2-PLAN.md §4 Decision 1,
 * PLAN.md §8.5 + §8.9).
 *
 * `loadFunnelForVisitor` refuses to serve a funnel with no Impressum/privacy
 * link, or whose client has not signed an AVV, but only when `dbConfigured()`
 * — a self-hoster running out of `FUNNELS_DIR` is their own controller. The
 * gate binds at `/f/:slug` and `GET /api/funnels/:slug`, the two surfaces a
 * visitor or the engine ever reaches, and nowhere else: ingest must still take
 * a lead someone already typed into a page that is about to go dark.
 *
 * Written against `handleRequest` directly, like `report.test.js` and
 * `domains.test.js`: the subject is server behaviour with a fake database
 * behind it, not a spawned process.
 *
 * A NOTE ON PART (a). `legalUrlOk` in `lib/funnels.js` is not exported — on
 * purpose, it is private to that module — and this file is not allowed to
 * change `lib/` to make it importable (see the file header below). So parity
 * with the engine's `isNavigableUrl` is pinned through the gate's own
 * observable decision (`loadFunnelForVisitor`) rather than by calling
 * `legalUrlOk` directly: for each URL in the shared table, the funnel is
 * either let through or refused, and that verdict has to agree with
 * `isNavigableUrl(url)` computed straight from the engine. That is the
 * property that actually matters — a visitor never sees `legalUrlOk`'s return
 * value, only whether the page renders.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Deleted, never restored — see the same note in report.test.js. */
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

const scratch = await mkdtemp(join(await tmpParent(), "openfunnel-funnels-gate-"));
process.env.DATA_DIR = scratch;

async function tmpParent() {
  const dir = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(dir, { recursive: true });
  return dir;
}

const { handleRequest } = await import("../handler.js");
const { loadFunnelForVisitor } = await import("../lib/funnels.js");
const { readJsonlRecords } = await import("../lib/store.js");
const { ADMIN_TOKEN } = await import("../lib/config.js");
const { isNavigableUrl } = await import("../../../packages/engine/src/dom.js");

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.DATA_DIR = scratch;
  // Per test, not once at import — `bun test` shares one process across files.
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    delete process.env[key];
  }
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = realFetch;
});

/**
 * Point the runtime at a database that only exists in this function. Every
 * slug named in `table` IS a row in the `funnel` table (with the given `doc`
 * and its client's `avv_signed_at`); every other slug is absent from the
 * table, so `loadFunnel` falls through to `FUNNELS_DIR` for it — same as a
 * real deployment whose Supabase project does not yet hold that funnel.
 *
 * @param {Record<string, { doc: any, avv: string|null, status?: string }>} table
 */
function stubDb(table = {}) {
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      const target = String(url);
      const reply = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (target.includes("/rpc/rate_hit")) return reply(true);
      if (target.includes("/funnel")) {
        const slugFilter = new URL(target).searchParams.get("slug");
        if (slugFilter) {
          const slug = decodeURIComponent(slugFilter.replace(/^eq\./, ""));
          const row = table[slug];
          if (!row) return reply([]); // not in the table — the caller falls back to disk
          return reply([
            { slug, doc: row.doc, status: row.status || "draft", client: { avv_signed_at: row.avv } },
          ]);
        }
        // The unfiltered listing `listFunnels()` reads before unioning with disk.
        return reply(Object.keys(table).map((slug) => ({ slug, status: table[slug].status || "draft" })));
      }
      throw new Error(`unexpected request in a stubbed test: ${target}`);
    }
  );
}

/**
 * @param {string} path
 */
const get = (path) => handleRequest(new Request(`http://console.example.test${path}`, { headers: { host: "console.example.test" } }));

const VALID_IMPRESSUM = "https://example.de/impressum";
const VALID_PRIVACY = "https://example.de/datenschutz";
const SIGNED_AVV = "2026-01-01T00:00:00.000Z";

/**
 * @param {{ steps?: any[] }} [over]
 */
const doc = (over = {}) => ({
  name: "Gate Test Funnel",
  steps: [{ id: "s1", type: "content", headline: "Hi", blocks: [] }],
  ...over,
});

/* ========================================================================== *
 *  a. Parity with the engine
 * ========================================================================== */

test("legalUrlOk agrees with the engine's isNavigableUrl over a shared table", async () => {
  const cases = [
    "",
    "   ",
    undefined,
    null,
    123,
    "https://example.de/impressum",
    "http://example.de/impressum",
    "/impressum",
    "javascript:alert(1)",
    "mailto:a@b.de",
    "//evil.tld/x",
    "/\tevil.tld/x", // a real tab character
    "data:text/html,x",
    "ftp://example.de/x",
  ];

  const table = {};
  cases.forEach((value, i) => {
    table[`parity-${i}`] = {
      doc: doc({ legal: { impressumUrl: value, privacyUrl: VALID_PRIVACY } }),
      avv: SIGNED_AVV, // signed, so only the URL check under test can block
    };
  });
  stubDb(table);

  for (let i = 0; i < cases.length; i++) {
    const value = cases[i];
    const expected = isNavigableUrl(value);
    const { blocked } = await loadFunnelForVisitor(`parity-${i}`);
    expect({ value, blocked }).toEqual({ value, blocked: expected ? null : "impressum_url_missing" });
  }
});

/* ========================================================================== *
 *  b. The gate's scope — no database, no gate
 * ========================================================================== */

test("with no database configured, a funnel with no legal block still renders", async () => {
  // `fitness` is in examples/ with no `legal` field at all, and no database is
  // configured in this test — a self-hoster running examples/ is their own
  // controller and the gate must not bind.
  const res = await get("/f/fitness");
  expect(res.status).toBe(200);
});

/* ========================================================================== *
 *  c. The refusal — missing legal, missing half, and a URL the engine refuses
 * ========================================================================== */

test("a database-backed funnel with no legal, a missing privacyUrl, or an unnavigable impressumUrl is refused", async () => {
  stubDb({
    "gate-no-legal": { doc: doc(), avv: SIGNED_AVV },
    "gate-no-privacy": { doc: doc({ legal: { impressumUrl: VALID_IMPRESSUM } }), avv: SIGNED_AVV },
    "gate-js-url": {
      doc: doc({ legal: { impressumUrl: "javascript:alert(1)", privacyUrl: VALID_PRIVACY } }),
      avv: SIGNED_AVV,
    },
  });

  for (const slug of ["gate-no-legal", "gate-no-privacy", "gate-js-url"]) {
    const res = await get(`/f/${slug}`);
    expect(`${slug} → ${res.status}`).toBe(`${slug} → 503`);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    // The refusal names none of what triggered it.
    for (const leak of ["impressum_url_missing", "privacy_url_missing", "avv_unsigned", doc().name]) {
      expect(body).not.toContain(leak);
    }
  }
});

/* ========================================================================== *
 *  c (cont). The AVV half
 * ========================================================================== */

test("both legal links valid: a signed AVV renders, an unsigned one refuses", async () => {
  stubDb({
    "gate-avv-signed": { doc: doc({ legal: { impressumUrl: VALID_IMPRESSUM, privacyUrl: VALID_PRIVACY } }), avv: SIGNED_AVV },
    "gate-avv-unsigned": { doc: doc({ legal: { impressumUrl: VALID_IMPRESSUM, privacyUrl: VALID_PRIVACY } }), avv: null },
  });

  const signed = await get("/f/gate-avv-signed");
  expect(signed.status).toBe(200);
  const body = await signed.text();
  expect(body).toContain('"slug":"gate-avv-signed"');

  const unsigned = await get("/f/gate-avv-unsigned");
  expect(unsigned.status).toBe(503);
});

/* ========================================================================== *
 *  d. /f/:slug and /api/funnels/:slug refuse together
 * ========================================================================== */

test("the JSON document refuses for the same funnel /f/:slug refuses", async () => {
  stubDb({ "gate-both": { doc: doc(), avv: SIGNED_AVV } }); // no legal at all

  const page = await get("/f/gate-both");
  const api = await get("/api/funnels/gate-both");

  expect(page.status).toBe(503);
  expect(api.status).toBe(503);
  expect(api.headers.get("x-robots-tag")).toBe("noindex");
  const body = await api.text();
  expect(body).not.toContain("impressum_url_missing");
});

/* ========================================================================== *
 *  e. The AVV half does not bind on a disk funnel
 * ========================================================================== */

test("a database configured, but a slug served from FUNNELS_DIR: legal still binds, AVV does not", async () => {
  stubDb({}); // neither slug below is in the funnel table

  // `lead-gen` (examples/lead-gen.json) now carries a valid legal block (part 1
  // of this work order) and has no client row backing it at all — renders.
  const withLegal = await get("/f/lead-gen");
  expect(withLegal.status).toBe(200);

  // `fitness` (examples/fitness.json) has no legal block — the legal half of
  // the gate still binds even though nothing here is a client's document.
  const withoutLegal = await get("/f/fitness");
  expect(withoutLegal.status).toBe(503);
});

/* ========================================================================== *
 *  f. Ingest is exempt
 * ========================================================================== */

test("POST /api/lead still answers 202 and stores, for a funnel the gate is refusing", async () => {
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

  // `gate-ingest` is genuinely blocked: it is in the funnel table with no
  // `legal` block at all, same shape as the "c" refusal fixtures.
  const blockedDoc = doc();

  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      const target = String(url);
      const reply = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (target.includes("/rpc/rate_hit")) return reply(true);
      if (target.includes("/rpc/ingest_lead")) {
        return reply([{ lead_id: "ingest-gate-1", queued: 1, deduped: false }]);
      }
      if (target.includes("/rpc/claim_deliveries")) return reply([]);
      if (target.includes("/funnel")) {
        const slugFilter = new URL(target).searchParams.get("slug");
        if (slugFilter === "eq.gate-ingest") {
          return reply([{ slug: "gate-ingest", doc: blockedDoc, status: "draft", client: { avv_signed_at: SIGNED_AVV } }]);
        }
        return reply([]);
      }
      // Everything else this route might reach for (email settings, and so on)
      // is not what this test is about — answer empty rather than enumerate it.
      return reply([]);
    }
  );

  // Sanity check on the fixture itself: the gate really is refusing this
  // funnel, or the assertion below would be vacuous (a funnel that renders
  // fine posting a lead proves nothing about the exemption).
  const { blocked } = await loadFunnelForVisitor("gate-ingest");
  expect(blocked).toBe("impressum_url_missing");

  const res = await handleRequest(
    new Request("http://console.example.test/api/lead", {
      method: "POST",
      headers: { host: "console.example.test", "content-type": "application/json" },
      body: JSON.stringify({
        funnelId: "gate-ingest",
        sessionId: "s-gate-1",
        lead: { email: "visitor@example.invalid", name: "Visitor" },
      }),
    }),
  );
  expect(res.status).toBe(202);

  // `persist()` is fire-and-forget from the route's point of view.
  await Bun.sleep(150);

  const records = await readJsonlRecords("leads.jsonl");
  const stored = records.find((r) => r.funnelId === "gate-ingest");
  expect(stored).toBeTruthy();
  expect(stored?.lead?.email).toBe("visitor@example.invalid");
});

/* ========================================================================== *
 *  g. GET /api/admin/funnel-gates
 * ========================================================================== */

test("the funnel-gates admin endpoint names the blocked slug's reason and the servable slug's null", async () => {
  stubDb({
    "gate-report-blocked": { doc: doc(), avv: SIGNED_AVV },
    "gate-report-ok": { doc: doc({ legal: { impressumUrl: VALID_IMPRESSUM, privacyUrl: VALID_PRIVACY } }), avv: SIGNED_AVV },
  });

  // "localhost" so `isLoopbackRequest`'s own Host check passes — it validates
  // the header independently of the mocked socket address (DNS-rebinding
  // guard, see auth.js), so an arbitrary hostname fails loopback trust even
  // with a 127.0.0.1 `requestIP`.
  const bunServer = { requestIP: () => ({ address: "127.0.0.1" }) };
  const adminHeaders = ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {};
  const res = await handleRequest(
    new Request("http://localhost/api/admin/funnel-gates", {
      headers: { host: "localhost", ...adminHeaders },
    }),
    { server: bunServer },
  );
  expect(res.status).toBe(200);
  const { gates } = await res.json();
  expect(gates["gate-report-blocked"]).toBe("impressum_url_missing");
  expect(gates["gate-report-ok"]).toBeNull();
});

test("the funnel-gates admin endpoint refuses without admin credentials", async () => {
  stubDb({});
  // No server (no loopback trust) and no Authorization header, whatever
  // ADMIN_TOKEN happens to be frozen to in this process.
  const res = await handleRequest(
    new Request("http://console.example.test/api/admin/funnel-gates", { headers: { host: "console.example.test" } }),
  );
  expect([401, 403]).toContain(res.status);
});

/* ========================================================================== *
 *  h. The duplicated copy of a blocked funnel is blocked too
 *
 *  Regression test for a fail-open bug: `loadFunnelForVisitor` used to read the
 *  AVV back out of whatever cache entry `loadFunnel` had just left behind, and
 *  `cacheFunnel()` — called by `POST /api/builder/duplicate` — seeded one with
 *  no `avv` field at all. A missing `avv` legitimately means "no client row
 *  backs this document" (a disk funnel), so the duplicate's AVV check silently
 *  stopped binding for as long as that entry lived in cache. Fixed by making
 *  `readFunnel()` the only writer of the cache and deleting `cacheFunnel`
 *  entirely — `routes/builder.js` now invalidates instead of seeding.
 *
 *  This is the important test in the file: it has to reach the actual write
 *  path (`POST /api/builder/duplicate`), not just call `loadFunnelForVisitor`
 *  a second time, or it would not have caught the bug it is named for.
 * ========================================================================== */

/**
 * A minimal PostgREST stand-in, as a REAL HTTP server rather than a stubbed
 * `fetch` — this test needs a genuinely separate OS process on the other end
 * (see the note above), and you cannot hand a child process your in-process
 * `globalThis.fetch` override. `table` is mutated in place by the funnel INSERT
 * this test drives, so the GET that follows sees exactly what the route just
 * wrote — the same sequencing a real Postgres round trip would produce.
 *
 * @param {Record<string, { doc: any, avv: string|null, status?: string }>} table
 * @returns {(req: Request) => Promise<Response>}
 */
function mockPostgrest(table) {
  return async (req) => {
    const url = new URL(req.url);
    const reply = (body, status = 200) => Response.json(body, { status });

    if (url.pathname === "/rest/v1/client") {
      // resolveClientId()'s "exactly one non-deleted client" happy path.
      return reply([{ id: "11111111-1111-1111-1111-111111111111" }]);
    }
    if (url.pathname === "/rest/v1/funnel") {
      if (req.method === "POST") {
        // saveFunnel()'s insert for a slug not already in the table. The
        // duplicate's AVV is unsigned too — filed under the same never-signed
        // default client the stub above resolves to.
        const rows = await req.json();
        const row = Array.isArray(rows) ? rows[0] : rows;
        table[row.slug] = { doc: row.doc, avv: null, status: "draft" };
        return reply([row]);
      }
      const slugFilter = url.searchParams.get("slug");
      const slug = slugFilter ? decodeURIComponent(slugFilter.replace(/^eq\./, "")) : null;
      const row = slug ? table[slug] : undefined;
      if (!row) return reply([]);
      return reply([{ slug, doc: row.doc, status: row.status || "draft", client: { avv_signed_at: row.avv } }]);
    }
    // sync_delivery_targets, email settings, and anything else the write path
    // reaches for — swallowed by `syncFunnelTargets`'s own try/catch, so an
    // empty answer here is exactly as good as a real one for this test.
    return reply([]);
  };
}

test(
  "production cache: duplicating a funnel whose client has not signed an AVV — the copy is blocked too",
  async () => {
    // CACHE_MS is `DEV ? 0 : 60_000`, and `DEV` is read from NODE_ENV ONCE, at
    // whichever import first pulls in `lib/config.js` — which, in a `bun test`
    // run, is some earlier file in the suite, none of which set NODE_ENV. So by
    // the time this file runs, DEV is already latched `true` for the rest of
    // the PROCESS: `Date.now() - hit.at < 0` can never be true, a cache HIT can
    // never happen, and the bug this test guards against — a cache entry with
    // no `avv` — is unobservable in-process. Buggy code and fixed code both
    // pass every in-process assertion identically; an earlier version of this
    // test made exactly that mistake and stayed green with the real bug
    // restored. `server.test.js` hits the same wall for its own CACHE_MS-gated
    // assertion ("only a versioned URL earns an immutable cache") and solves it
    // the same way: spawn the real server as a genuinely separate OS process
    // with `NODE_ENV=production`, so `lib/config.js` reads DEV fresh in a
    // process this file's imports never touched.
    const table = {
      "gate-dup-orig": {
        doc: doc({ legal: { impressumUrl: VALID_IMPRESSUM, privacyUrl: VALID_PRIVACY } }),
        avv: null, // the AVV is the ONLY thing this funnel is missing
      },
    };

    // A child process can't share this file's `globalThis.fetch` override, so
    // the fake database has to be a real server the child can actually dial.
    const dbServer = Bun.serve({ port: 0, fetch: mockPostgrest(table) });
    const dbUrl = `http://localhost:${dbServer.port}`;

    const tmpDir = resolve(import.meta.dir, "../../../.tmp");
    await mkdir(tmpDir, { recursive: true });
    const scratch2 = await mkdtemp(join(tmpDir, "openfunnel-cache-bug-"));
    const port = 7000 + Math.floor(Math.random() * 900);
    const base = `http://localhost:${port}`;
    const SERVER = resolve(import.meta.dir, "../server.js");

    const child = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: scratch2,
        FUNNELS_DIR: scratch2, // empty — no disk-fallback funnel to interfere
        SUPABASE_URL: dbUrl,
        NEXT_PUBLIC_SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "fake-key-not-real",
        ADMIN_TOKEN: "", // loopback trust carries the admin POST below
        INTERNAL_SECRET: "",
        FUNNEL_DOMAINS: "",
        TRUST_PROXY: "",
        NODE_ENV: "production",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${base}/healthz`)).ok) break;
        } catch {
          /* not up yet */
        }
        await Bun.sleep(50);
      }

      // Sanity check on the fixture: the original really is blocked on AVV
      // alone, not on a missing legal block — otherwise the assertions below
      // would not isolate the bug this test is named for.
      const original = await fetch(`${base}/f/gate-dup-orig`);
      expect(original.status).toBe(503);

      const dup = await fetch(`${base}/api/builder/duplicate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "gate-dup-orig" }),
      });
      expect(dup.status).toBe(200);
      const newSlug = (await dup.json()).funnel?.slug;
      expect(typeof newSlug).toBe("string");
      expect(newSlug).not.toBe("gate-dup-orig");

      // The bug: this rendered 200, inside the (now genuinely nonzero) cache
      // window, because `cacheFunnel` seeded the copy's entry with no `avv` at
      // all — and a missing `avv` reads as "no client row backs this document",
      // the disk-funnel exemption, applied to a funnel that has a client and an
      // unsigned AVV.
      const copy = await fetch(`${base}/f/${newSlug}`);
      expect(copy.status).toBe(503);
    } finally {
      child.kill();
      dbServer.stop();
      await rm(scratch2, { recursive: true, force: true });
    }
  },
);

/* ========================================================================== *
 *  i. The funnel LIST is deliberately not filtered
 * ========================================================================== */

test("a blocked funnel still appears in the funnel list, while its own document 503s", async () => {
  stubDb({
    "gate-list-blocked": { doc: doc(), avv: SIGNED_AVV }, // no legal block
  });

  const list = await get("/api/funnels");
  expect(list.status).toBe(200);
  const { funnels } = await list.json();
  expect(funnels.some((f) => f.slug === "gate-list-blocked")).toBe(true);

  const document = await get("/api/funnels/gate-list-blocked");
  expect(document.status).toBe(503);
});
