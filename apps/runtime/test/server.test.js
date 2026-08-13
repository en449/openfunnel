/**
 * @file Runtime smoke tests. Boots the real server on an ephemeral port against
 * a temp data dir, then exercises every route a visitor's browser touches.
 *
 * The critical assertion is the round trip: the funnel JSON we embed in the HTML
 * shell must parse back into the exact document the engine expects. If a funnel
 * ever contains a `</script>` or a U+2028, this is what catches it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dir, "../server.js");

/** @type {import('bun').Subprocess} */
let proc;
let base = "";
let dataDir = "";
let funnelsDir = "";

/** Every scratch dir this file creates, removed in afterAll. */
const scratchDirs = [];

/**
 * Credentials blanked for every server this file spawns.
 *
 * Bun loads the repo's own `.env`, and `{ ...process.env }` copies whatever is
 * in it into the child — so the assertions here quietly describe the developer's
 * machine rather than the code. It has bitten twice now. First with Supabase:
 * this file would have read funnels from a real project and written test funnels
 * and a client row into it. Then, the day `ADMIN_TOKEN` and `INTERNAL_SECRET`
 * were generated for the first deployment, nine tests went red at once — the
 * ones asserting what an UNCONFIGURED server does, which is exactly the
 * configuration a fresh self-hoster has and nobody runs locally any more.
 *
 * Blanked rather than omitted, because spreading `process.env` puts them back.
 * Add a variable here the moment the runtime learns to read it.
 */
const BLANK_CREDENTIALS = {
  SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  ADMIN_TOKEN: "",
  INTERNAL_SECRET: "",
  IP_HASH_SALT: "",
  OTP_HASH_SALT: "",
  WEBHOOK_URL: "",
  ZAPIER_WEBHOOK_URL: "",
  WEBHOOK_SECRET: "",
  EMAIL_PROVIDER: "",
  RESEND_API_KEY: "",
  BREVO_API_KEY: "",
  SMTP_RELAY_URL: "",
  META_CAPI_ACCESS_TOKEN: "",
  TRUST_PROXY: "",
  // Not credentials, but the same rule and the same reason: these four decide
  // the engine's version segment, and `vercel env pull` writes VERCEL_* into a
  // local .env. Left alone, a developer's file would choose the URLs these
  // tests assert on.
  ENGINE_VERSION: "",
  VERCEL_DEPLOYMENT_ID: "",
  VERCEL_GIT_COMMIT_SHA: "",
  VERCEL_URL: "",
};

beforeAll(async () => {
  const tmpParent = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(tmpParent, { recursive: true });
  dataDir = await mkdtemp(join(tmpParent, "openfunnel-test-"));
  scratchDirs.push(dataDir);

  // Serve funnels from a throwaway copy of examples/. The builder tests write
  // real files into FUNNELS_DIR, so pointing it at the repo left their scratch
  // funnels behind as untracked changes after every run.
  funnelsDir = await mkdtemp(join(tmpParent, "openfunnel-funnels-"));
  scratchDirs.push(funnelsDir);
  const sourceDir = resolve(import.meta.dir, "../../../examples");
  for (const name of await readdir(sourceDir)) {
    if (name.endsWith(".json")) await copyFile(join(sourceDir, name), join(funnelsDir, name));
  }

  const port = 4000 + Math.floor(Math.random() * 1000);
  base = `http://localhost:${port}`;

  // See BLANK_CREDENTIALS.
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    FUNNELS_DIR: funnelsDir,
    ...BLANK_CREDENTIALS,
  };

  proc = Bun.spawn(["bun", SERVER], { env, stdout: "pipe", stderr: "pipe" });

  // Poll until it answers rather than sleeping a fixed amount.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }
  throw new Error("runtime did not start in time");
});

// Removed rather than left behind: this file makes five scratch dirs per run and
// nothing was deleting them, so `.tmp/` had grown to 310 directories. Gitignored,
// so it never showed up in a diff — which is exactly why it kept growing.
afterAll(async () => {
  proc?.kill();
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("funnel pages", () => {
  test("serves a funnel page with the config embedded", async () => {
    const res = await fetch(`${base}/f/lead-gen`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain('<div id="app" class="of-root">');
    // Versioned engine path (PHASE-1-PLAN.md §4.9.1): the version segment is what
    // lets `/_of/*` be cached immutably without pinning a returning visitor to
    // the deploy they first loaded, so an unversioned import here is the bug.
    expect(body).toMatch(/import \{ createFunnel \} from "\/_of\/v-[0-9a-f]{12}\/index\.js"/);
    // The theme is inlined on <html> so the first paint is already branded.
    expect(body).toContain("--of-primary:#4f46e5");
  });

  test("embedded JSON parses back to the source funnel", async () => {
    const body = await fetch(`${base}/f/lead-gen`).then((r) => r.text());
    const raw = body.match(
      /<script id="of-funnel" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(raw).toBeTruthy();

    const embedded = JSON.parse(String(raw));
    const onDisk = JSON.parse(
      await readFile(resolve(import.meta.dir, "../../../examples/lead-gen.json"), "utf8"),
    );
    expect(embedded).toEqual(onDisk);
  });

  test("unknown slugs 404", async () => {
    expect((await fetch(`${base}/f/does-not-exist`)).status).toBe(404);
  });

  test("rejects slugs that are not plain identifiers", async () => {
    expect((await fetch(`${base}/f/..%2F..%2Fpackage`)).status).toBe(404);
  });
});

describe("engine assets", () => {
  test("serves engine modules as javascript", async () => {
    const res = await fetch(`${base}/_of/index.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("export function createFunnel");
  });

  test("serves nested render modules and the stylesheet", async () => {
    expect((await fetch(`${base}/_of/render/form.js`)).status).toBe(200);
    const css = await fetch(`${base}/_of/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  test("refuses to escape the engine directory", async () => {
    const res = await fetch(`${base}/_of/..%2F..%2F..%2Fpackage.json`);
    expect([403, 404]).toContain(res.status);
  });

  test("a versioned path serves the same file as the unversioned one", async () => {
    // The segment is decorative to the lookup: it exists so the URL changes
    // between deploys, not so it selects anything. Every version resolves to
    // what is on disk now — which is also what keeps an old cached page working
    // after a deploy instead of 404ing on a version that no longer exists.
    const plain = await fetch(`${base}/_of/theme.js`);
    const versioned = await fetch(`${base}/_of/v-0123456789ab/theme.js`);
    expect(versioned.status).toBe(200);
    expect(await versioned.text()).toBe(await plain.text());

    // And the containment check still runs after the segment is stripped.
    const escape = await fetch(`${base}/_of/v-0123456789ab/..%2F..%2F..%2Fpackage.json`);
    expect([403, 404]).toContain(escape.status);
  });

  test("only a versioned URL earns an immutable cache", async () => {
    // The failure this pins: `immutable` on an UNVERSIONED url told every
    // browser that had ever loaded a funnel page to keep that deploy's engine
    // for a year, with no way to correct it — measured live, where a deleted
    // Google Fonts request kept firing from cache after the fix had shipped
    // (PHASE-1-PLAN.md §4.9.1).
    //
    // It has to be asserted in production mode, because DEV caches nothing and
    // would pass either way — which is how the original bug survived: every
    // local run exercised the branch that was fine.
    const dir = await mkdtemp(join(resolve(import.meta.dir, "../../../.tmp"), "openfunnel-cache-"));
    scratchDirs.push(dir);
    const port = 6000 + Math.floor(Math.random() * 900);
    const child = Bun.spawn(["bun", SERVER], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, FUNNELS_DIR: dir, ...BLANK_CREDENTIALS, NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = `http://localhost:${port}`;
    try {
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${url}/healthz`)).ok) break;
        } catch {
          /* not up yet */
        }
        await Bun.sleep(50);
      }

      const versioned = await fetch(`${url}/_of/v-0123456789ab/theme.js`);
      expect(versioned.status).toBe(200);
      expect(versioned.headers.get("cache-control")).toContain("immutable");

      const plain = await fetch(`${url}/_of/theme.js`);
      expect(plain.status).toBe(200);
      expect(plain.headers.get("cache-control")).not.toContain("immutable");
    } finally {
      child.kill();
    }
  });
});

describe("ingest", () => {
  test("accepts a lead and writes it to disk", async () => {
    const res = await fetch(`${base}/api/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        funnelId: "lead-gen",
        sessionId: "sess-1",
        lead: { email: "jane@example.com" },
        answers: { goal: "grow" },
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    await Bun.sleep(80); // the write is deliberately off the response path
    const rows = (await readFile(join(dataDir, "leads.jsonl"), "utf8")).trim().split("\n");
    const row = JSON.parse(rows.at(-1) || "{}");
    expect(row.lead.email).toBe("jane@example.com");
    expect(row.received_at).toBeTruthy();

    // The sink is the one lead store a deployment with no database has, and it
    // used to hold the visitor's address in the clear. Both halves matter: the
    // field is gone, and the address does not survive under some other key.
    expect(row.ip).toBeUndefined();
    expect(rows.at(-1)).not.toContain("127.0.0.1");
  });

  test("accepts an analytics event", async () => {
    const res = await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "step_view", sessionId: "sess-1", ts: Date.now() }),
    });
    expect(res.status).toBe(202);

    await Bun.sleep(80);
    const rows = (await readFile(join(dataDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(rows.at(-1) || "{}").type).toBe("step_view");

    // Events go through the same `persist()` strip as leads. Asserted on both
    // kinds, because the strip lives above a `kind` branch and a refactor that
    // moves it below one would leave this sink holding addresses in silence.
    expect(JSON.parse(rows.at(-1) || "{}").ip).toBeUndefined();
    expect(rows.at(-1)).not.toContain("127.0.0.1");
  });

  test("rejects malformed bodies and wrong methods", async () => {
    const bad = await fetch(`${base}/api/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(bad.status).toBe(400);

    expect((await fetch(`${base}/api/lead`)).status).toBe(405);
  });

  test("refuses an oversized body without buffering it", async () => {
    // A chunked request declares no content-length, so `readJson`'s declared-size
    // check reads 0 and only catches the body after Bun has buffered all of it.
    // `maxRequestBodySize` is what makes this a transport-layer 413 instead of an
    // unauthenticated caller getting the server to allocate up to Bun's 128MB
    // default per request. A ReadableStream body forces chunked encoding.
    const oversized = "A".repeat(256 * 1024);
    const res = await fetch(`${base}/api/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"pad":"${oversized}"}`));
          controller.close();
        },
      }),
      // @ts-expect-error — required by fetch for a streaming request body.
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  test("answers CORS preflight so funnels can be embedded cross-origin", async () => {
    const res = await fetch(`${base}/api/events`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("never returns the OTP code to the caller", async () => {
    const res = await fetch(`${base}/api/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "lead@example.com" }),
    });
    const body = await res.text();

    // The code must never reach the client on any path. It used to be included
    // whenever NODE_ENV !== "production" — which is the default — so a deploy
    // that forgot to set it handed out the answer.
    expect(body).not.toMatch(/"code"\s*:\s*"?\d{4,6}/);
    // No transport is configured under test, so the send reports failure
    // rather than pretending a mail went out.
    expect(res.status).toBe(502);
    expect(JSON.parse(body).ok).toBe(false);
  });

  test("rejects a malformed OTP recipient", async () => {
    const res = await fetch(`${base}/api/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_email");
  });

  test("refuses a verification attempt for an address with no live code", async () => {
    const res = await fetch(`${base}/api/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", code: "123456" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(false);
  });

  test("does not trust a browser-supplied email_verified flag", async () => {
    await fetch(`${base}/api/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        funnelId: "lead-gen",
        lead: { email: "forged@example.com", email_verified: true },
      }),
    });

    await Bun.sleep(120);
    const written = await readFile(join(dataDir, "leads.jsonl"), "utf8");
    const forged = written
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.lead?.email === "forged@example.com");

    expect(forged).toBeDefined();
    // Nobody passed a challenge for this address, so the stored record must say so.
    expect(forged.lead.email_verified).toBe(false);
  });
});

describe("privileged route protection", () => {
  // With no ADMIN_TOKEN configured the server falls back to loopback-only. A
  // forwarded header means the request came through a proxy, so it must not
  // inherit localhost's privileges no matter what the socket address says.
  const proxied = { "x-forwarded-for": "203.0.113.7" };

  test("refuses lead export to a proxied caller", async () => {
    const res = await fetch(`${base}/api/admin/leads`, { headers: proxied });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("admin_token_required");
  });

  test("refuses funnel writes to a proxied caller", async () => {
    const res = await fetch(`${base}/api/builder/save`, {
      method: "POST",
      headers: { "content-type": "application/json", ...proxied },
      body: JSON.stringify({ slug: "pwned", steps: [{ id: "a", type: "content" }] }),
    });
    expect(res.status).toBe(401);
  });

  test("refuses mail settings to a proxied caller", async () => {
    const res = await fetch(`${base}/api/admin/email-settings`, { headers: proxied });
    expect(res.status).toBe(401);
  });

  test("never discloses mail credentials, even to an allowed caller", async () => {
    const res = await fetch(`${base}/api/admin/email-settings`);
    expect(res.status).toBe(200);
    const { settings } = await res.json();

    expect(settings).not.toHaveProperty("resendApiKey");
    expect(settings).not.toHaveProperty("smtpPass");
    expect(settings).not.toHaveProperty("relayUrl");
    // The console still needs to know whether a key is configured.
    expect(settings).toHaveProperty("resendApiKeySet");
    expect(typeof settings.resendApiKeySet).toBe("boolean");
  });

  test("drops unknown keys instead of persisting them", async () => {
    const res = await fetch(`${base}/api/admin/email-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notifyEmail: "ops@example.com", relayUrl: "https://attacker.example", nonsense: 1 }),
    });
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.notifyEmail).toBe("ops@example.com");
    expect(settings).not.toHaveProperty("nonsense");
    expect(settings).not.toHaveProperty("relayUrl");
  });

  test("never ships webhook credentials or API keys to the browser", async () => {
    // The whole funnel document is inlined into the page, so anything left in
    // integrations is readable with View Source.
    await fetch(`${base}/api/builder/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "leaky",
        name: "Leaky",
        apiKey: "sk-topsecret-apikey",
        integrations: {
          webhookUrl: "https://hooks.example/catch/abc",
          webhookSecret: "whsec_topsecret",
          apiKey: "sk-integration-secret",
          resendApiKey: "re_secret_key_123",
          smtpPass: "super_secret_smtp_password",
        },
        steps: [{ id: "a", type: "content", headline: "Hi" }],
      }),
    });

    const page = await (await fetch(`${base}/f/leaky`)).text();
    expect(page).not.toContain("whsec_topsecret");
    expect(page).not.toContain("hooks.example");
    expect(page).not.toContain("sk-topsecret-apikey");
    expect(page).not.toContain("sk-integration-secret");
    expect(page).not.toContain("re_secret_key_123");
    expect(page).not.toContain("super_secret_smtp_password");

    const publicJson = await (await fetch(`${base}/api/funnels/leaky`)).text();
    expect(publicJson).not.toContain("whsec_topsecret");
    expect(publicJson).not.toContain("hooks.example");
    expect(publicJson).not.toContain("sk-topsecret-apikey");
    expect(publicJson).not.toContain("sk-integration-secret");
    expect(publicJson).not.toContain("re_secret_key_123");
    expect(publicJson).not.toContain("super_secret_smtp_password");

    // The builder still needs the real values, or saving would blank them.
    const editing = await (await fetch(`${base}/api/builder/funnel/leaky`)).json();
    expect(editing.integrations.webhookSecret).toBe("whsec_topsecret");
  });

  test("ignores a webhook target supplied in the lead body", async () => {
    // /api/lead is public. Honouring a body-supplied webhookUrl would let any
    // caller aim the server at a host they control, or probe internal ones.
    let hit = false;
    const sink = Bun.serve({ port: 0, fetch: () => ((hit = true), new Response("ok")) });

    await fetch(`${base}/api/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        funnelId: "ssrf-probe",
        webhookUrl: `http://localhost:${sink.port}/steal`,
        lead: { email: "victim@example.com" },
      }),
    });

    await Bun.sleep(200);
    sink.stop(true);
    expect(hit).toBe(false);
  });

  test("rejects a URL smuggled into smtpHost", async () => {
    const res = await fetch(`${base}/api/admin/email-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ smtpHost: "https://attacker.example/collect" }),
    });
    const { settings } = await res.json();
    expect(settings.smtpHost).not.toContain("attacker.example");
  });

  /**
   * The three tests above pick a route each. These sweep the whole privileged
   * surface, because the gate is meant to be structural: the router dispatches
   * the builder/admin/AI handlers INSIDE the branch that runs
   * `isCrossSiteRequest` + `requireAdmin`, so a handler is unreachable without
   * both. Enumerating every endpoint is what makes that claim testable — a new
   * route added to one of those modules is covered the moment it exists, and a
   * route moved out of the branch fails here rather than in production.
   *
   * `/api/ai/*` matters most: both its routes accept an `apiKey` in the body, so
   * ungated they are an open proxy to four paid APIs — and they fall back to the
   * operator's own OPENAI_API_KEY when the body omits one.
   */
  const PRIVILEGED_ENDPOINTS = [
    ["GET", "/api/admin/leads"],
    ["GET", "/api/admin/stats"],
    ["GET", "/api/admin/email-settings"],
    ["POST", "/api/admin/email-settings"],
    ["POST", "/api/admin/test-email"],
    ["GET", "/api/builder/funnel/lead-gen"],
    ["POST", "/api/builder/save"],
    ["POST", "/api/builder/delete"],
    ["POST", "/api/builder/duplicate"],
    ["POST", "/api/ai/generate"],
    ["POST", "/api/ai/improve-copy"],
  ];

  test("every privileged endpoint refuses a proxied caller", async () => {
    for (const [method, path] of PRIVILEGED_ENDPOINTS) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", ...proxied },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 401`);
    }
  });

  test("every privileged endpoint refuses a cross-site browser request", async () => {
    // `Sec-Fetch-Site` is set by the browser and cannot be forged by page
    // script. Without this check, a page the operator merely visits can drive
    // the console on a loopback-trust deploy — `readJson` ignores Content-Type,
    // so the write goes out as a CORS *simple* request with no preflight to stop
    // it. Refused before `requireAdmin`, because on loopback the caller is
    // already "authorised".
    for (const [method, path] of PRIVILEGED_ENDPOINTS) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 403`);
    }
  });

  // The machine surface is a second gate with a second secret. This server runs
  // with no INTERNAL_SECRET, which is the default for anyone not running the
  // cron — and the route must then not exist at all rather than answer 401,
  // because a 401 tells a stranger a drain endpoint is there to be guessed at.
  test("the drain does not exist without INTERNAL_SECRET, and never 401s its way into being advertised", async () => {
    for (const method of ["GET", "POST"]) {
      const res = await fetch(`${base}/api/internal/drain`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(`${method} → ${res.status}`).toBe(`${method} → 404`);
    }
    // Presenting a token must not change the answer either — otherwise the 404
    // is an oracle for "you guessed the secret".
    const guessed = await fetch(`${base}/api/internal/drain`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer guess" },
      body: "{}",
    });
    expect(guessed.status).toBe(404);
  });

  test("the drain refuses a cross-site browser request before authenticating", async () => {
    const res = await fetch(`${base}/api/internal/drain`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  // A route that fell out of the internal branch would land in the public
  // fall-through and answer 404 for a different reason. This asserts the branch
  // is what answers: an unknown path under the prefix is refused by the gate.
  test("an unknown internal path is answered by the gate, not by the public fall-through", async () => {
    const res = await fetch(`${base}/api/internal/anything-else`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  test("the public surface is NOT caught by the privileged gate", async () => {
    // The mirror image, and the reason the gate is a prefix list rather than a
    // default-deny: a funnel is embedded on the operator's marketing site, so
    // ingest and the email challenge have to keep working cross-site. If this
    // ever starts returning 403, embedded funnels stop capturing leads.
    const res = await fetch(`${base}/api/lead`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ funnelId: "gate-check", lead: { email: "embedded@example.com" } }),
    });
    expect(res.status).toBe(202);
  });
});

describe("builder & admin", () => {
  test("serves visual builder UI", async () => {
    const res = await fetch(`${base}/builder`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OpenFunnel");
  });

  test("serves admin dashboard UI", async () => {
    const res = await fetch(`${base}/admin`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OpenFunnel");
  });

  test("saves a new funnel via builder API", async () => {
    const newFunnel = {
      id: "test-funnel",
      slug: "test-funnel",
      name: "Test Funnel",
      steps: [{ id: "start", type: "choice", headline: "Test Step" }],
    };

    const res = await fetch(`${base}/api/builder/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(newFunnel),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: "test-funnel" });

    // Verify it is fetchable
    const getRes = await fetch(`${base}/api/funnels/test-funnel`);
    expect(getRes.status).toBe(200);
    const loaded = await getRes.json();
    expect(loaded.name).toBe("Test Funnel");
  });

  test("counts one visitor once, whatever JSON type the session id arrived as", async () => {
    // `/api/events` is public, so `sessionId` and `stepId` are whatever the
    // caller sent — a number here, a string there. Drop-off is counted with a
    // Set, which dedupes by identity, so 7 and "7" used to be two visitors on
    // the same step and every drop-off number was inflatable by anyone with the
    // endpoint. `computeStats` coerces before counting.
    const step = `dedupe-${Date.now()}`;
    for (const sessionId of ["77", 77]) {
      const res = await fetch(`${base}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "step_view", stepId: step, sessionId, ts: Date.now() }),
      });
      expect(res.status).toBe(202);
    }
    await Bun.sleep(80);

    const stats = await fetch(`${base}/api/admin/stats`).then((r) => r.json());
    const row = stats.steps.find((/** @type {any} */ s) => s.stepId === step);
    expect(row).toBeDefined();
    expect(row.sessions).toBe(1);
  });

  test("returns admin leads and stats", async () => {
    const leadsRes = await fetch(`${base}/api/admin/leads`);
    expect(leadsRes.status).toBe(200);
    const leadsData = await leadsRes.json();
    expect(Array.isArray(leadsData.leads)).toBe(true);

    const statsRes = await fetch(`${base}/api/admin/stats`);
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json();
    expect(typeof stats.starts).toBe("number");
    expect(typeof stats.leads).toBe("number");
  });
});

describe("api", () => {
  test("returns raw funnel JSON", async () => {
    const res = await fetch(`${base}/api/funnels/fitness`);
    expect(res.status).toBe(200);
    const funnel = await res.json();
    expect(funnel.slug).toBe("fitness");
    expect(funnel.steps.length).toBeGreaterThan(0);
  });

  test("healthz reports readiness", async () => {
    expect(await fetch(`${base}/healthz`).then((r) => r.json())).toMatchObject({ ok: true });
  });
});

describe("content security policy", () => {
  /**
   * The funnel page pins `script-src` to the SHA-256 of its inline boot script.
   * If the script is edited and the hash is not recomputed from the same string,
   * the browser refuses to run it and EVERY funnel page silently renders a blank
   * screen — nothing throws server-side, and no other test notices. So this
   * recomputes the hash from the bytes actually served and compares.
   */
  test("the advertised script hash matches the script actually served", async () => {
    const res = await fetch(`${base}/f/fitness`);
    const csp = res.headers.get("content-security-policy") || "";
    const page = await res.text();

    const inline = page.match(/<script type="module">([\s\S]*?)<\/script>/);
    expect(inline).not.toBeNull();

    const digest = createHash("sha256").update(inline[1], "utf8").digest("base64");
    expect(csp).toContain(`'sha256-${digest}'`);
  });

  test("locks down the funnel page without blocking embedding", async () => {
    const csp = (await fetch(`${base}/f/fitness`)).headers.get("content-security-policy") || "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Funnels are meant to be embedded on the operator's marketing site, and the
    // builder previews one in an iframe — so this must NOT be restricted here.
    expect(csp).not.toContain("frame-ancestors");
    // A funnel with no pixels configured gets no third-party script origin.
    expect(csp).not.toContain("connect.facebook.net");
  });

  test("the operator console refuses to be framed", async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

/**
 * Operator-pasted `customHead` / `customBody` scripts.
 *
 * A funnel page is served from the same origin as the console, and the admin
 * token lives in that origin's `localStorage` — so a script running on a funnel
 * page can read it and drain `/api/admin/*`. Funnel documents get imported from
 * templates and bug reports, which is why executing whatever a document carries
 * is opt-in per deployment rather than on by default.
 *
 * The first test here is the one that matters: it asserts the gate is SHUT when
 * nobody opted in. If that ever inverts, importing a funnel JSON becomes console
 * takeover, and no other test in this file would notice.
 */
describe("custom script injection", () => {
  const HEAD_INLINE = `console.log("head")`;
  const BODY_INLINE = `console.log("body")`;

  /** A funnel carrying every shape of custom code. */
  const funnelDoc = {
    id: "custom-code",
    name: "Custom code",
    customCss: ".of-root{--of-radius:20px}",
    customHead:
      `<meta name="x-marker" content="yes">` +
      `<script>${HEAD_INLINE}</script>` +
      `<script src="https://cdn.example.com/tag.js"></script>` +
      `<script type="application/json">{"not":"executable"}</script>`,
    customBody: `<script>${BODY_INLINE}</script>`,
    steps: [{ id: "s1", type: "content", headline: "Hi", ctaLabel: "Go" }],
  };

  const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

  /** Boot a second runtime with its own env, so both flag states are covered. */
  async function bootWith(env) {
    const dir = await mkdtemp(join(resolve(import.meta.dir, "../../../.tmp"), "openfunnel-custom-"));
    scratchDirs.push(dir);
    await Bun.write(join(dir, "custom-code.json"), JSON.stringify(funnelDoc));
    const port = 5000 + Math.floor(Math.random() * 900);
    const child = Bun.spawn(["bun", SERVER], {
      // Same reason as the main spawn above — see BLANK_CREDENTIALS. The
      // caller's own `env` is spread last, so a test that WANTS a credential
      // (the drain's INTERNAL_SECRET, say) still sets one deliberately.
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        FUNNELS_DIR: dir,
        ...BLANK_CREDENTIALS,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = `http://localhost:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) return { url, child };
      } catch {
        /* not up yet */
      }
      await Bun.sleep(50);
    }
    child.kill();
    throw new Error("custom-code runtime did not start in time");
  }

  test("refuses pasted scripts by default, but still serves the markup", async () => {
    const { url, child } = await bootWith({});
    try {
      const res = await fetch(`${url}/f/custom-code`);
      const csp = res.headers.get("content-security-policy") || "";
      const page = await res.text();

      // Neither inline script is granted, and the external host is not allowed.
      expect(csp).not.toContain(sha(HEAD_INLINE));
      expect(csp).not.toContain(sha(BODY_INLINE));
      expect(csp).not.toContain("cdn.example.com");
      // Exactly one hash — the boot script's — so nothing else can execute.
      expect(csp.match(/'sha256-/g)?.length).toBe(1);

      // The markup is still injected; only execution is refused. CSS too.
      expect(page).toContain('name="x-marker"');
      expect(page).toContain("--of-radius:20px");
    } finally {
      child.kill();
    }
  });

  test("ALLOW_CUSTOM_SCRIPTS grants exactly what was pasted, and nothing else", async () => {
    const { url, child } = await bootWith({
      ALLOW_CUSTOM_SCRIPTS: "1",
      CUSTOM_SCRIPT_ORIGINS: "https://extra.example.net",
    });
    try {
      const res = await fetch(`${url}/f/custom-code`);
      const csp = res.headers.get("content-security-policy") || "";
      const page = await res.text();

      // Both inline scripts are allowed by the hash of their exact bytes.
      expect(csp).toContain(sha(HEAD_INLINE));
      expect(csp).toContain(sha(BODY_INLINE));

      // The external script's origin is allowed to load AND to beacon back — a
      // script that loads but cannot connect reports nothing, silently.
      expect(csp).toContain("script-src");
      const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src")) || "";
      const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src")) || "";
      expect(scriptSrc).toContain("https://cdn.example.com");
      expect(connectSrc).toContain("https://cdn.example.com");
      expect(scriptSrc).toContain("https://extra.example.net");
      expect(connectSrc).toContain("https://extra.example.net");

      // Only the origin is granted, never the full URL path.
      expect(scriptSrc).not.toContain("/tag.js");
      // Opting in must not degrade into a blanket allow. Compared as whole
      // tokens: a substring test for "https:" also matches the legitimate
      // "https://cdn.example.com" and would pass while proving nothing.
      const sources = scriptSrc.split(/\s+/).slice(1);
      expect(sources).not.toContain("'unsafe-inline'");
      expect(sources).not.toContain("https:");
      expect(sources).not.toContain("*");

      // The JSON data block is not executable, so it gets no grant of its own:
      // boot + the two inline scripts, and nothing for the data block.
      expect(csp.match(/'sha256-/g)?.length).toBe(3);

      // The hashes have to match the bytes actually on the page, or the browser
      // refuses them — recompute from the served HTML rather than trusting the
      // fixture, which is what catches a drift between the two resolvers.
      for (const body of [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) {
        expect(csp).toContain(sha(body));
      }
    } finally {
      child.kill();
    }
  });

  test("a funnel with no custom code is unaffected by the opt-in", async () => {
    const { url, child } = await bootWith({ ALLOW_CUSTOM_SCRIPTS: "1" });
    try {
      const csp = (await fetch(`${url}/f/custom-code`)).headers.get("content-security-policy") || "";
      // Sanity: the flag alone never adds 'unsafe-inline' anywhere.
      expect(csp).not.toContain("'unsafe-inline'; script-src");
      expect(csp).toContain("default-src 'none'");
    } finally {
      child.kill();
    }
  });
});
