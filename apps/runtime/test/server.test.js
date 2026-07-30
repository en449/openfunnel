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
import { copyFile, mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dir, "../server.js");

/** @type {import('bun').Subprocess} */
let proc;
let base = "";
let dataDir = "";
let funnelsDir = "";

beforeAll(async () => {
  const tmpParent = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(tmpParent, { recursive: true });
  dataDir = await mkdtemp(join(tmpParent, "openfunnel-test-"));

  // Serve funnels from a throwaway copy of examples/. The builder tests write
  // real files into FUNNELS_DIR, so pointing it at the repo left their scratch
  // funnels behind as untracked changes after every run.
  funnelsDir = await mkdtemp(join(tmpParent, "openfunnel-funnels-"));
  const sourceDir = resolve(import.meta.dir, "../../../examples");
  for (const name of await readdir(sourceDir)) {
    if (name.endsWith(".json")) await copyFile(join(sourceDir, name), join(funnelsDir, name));
  }

  const port = 4000 + Math.floor(Math.random() * 1000);
  base = `http://localhost:${port}`;

  proc = Bun.spawn(["bun", SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, FUNNELS_DIR: funnelsDir },
    stdout: "pipe",
    stderr: "pipe",
  });

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

afterAll(() => proc?.kill());

describe("funnel pages", () => {
  test("serves a funnel page with the config embedded", async () => {
    const res = await fetch(`${base}/f/lead-gen`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain('<div id="app" class="of-root">');
    expect(body).toContain('import { createFunnel } from "/_of/index.js"');
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

  test("never ships webhook credentials to the browser", async () => {
    // The whole funnel document is inlined into the page, so anything left in
    // integrations is readable with View Source.
    await fetch(`${base}/api/builder/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "leaky",
        name: "Leaky",
        integrations: { webhookUrl: "https://hooks.example/catch/abc", webhookSecret: "whsec_topsecret" },
        steps: [{ id: "a", type: "content", headline: "Hi" }],
      }),
    });

    const page = await (await fetch(`${base}/f/leaky`)).text();
    expect(page).not.toContain("whsec_topsecret");
    expect(page).not.toContain("hooks.example");

    const publicJson = await (await fetch(`${base}/api/funnels/leaky`)).text();
    expect(publicJson).not.toContain("whsec_topsecret");
    expect(publicJson).not.toContain("hooks.example");

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
