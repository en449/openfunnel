/**
 * @file Runtime smoke tests. Boots the real server on an ephemeral port against
 * a temp data dir, then exercises every route a visitor's browser touches.
 *
 * The critical assertion is the round trip: the funnel JSON we embed in the HTML
 * shell must parse back into the exact document the engine expects. If a funnel
 * ever contains a `</script>` or a U+2028, this is what catches it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dir, "../server.js");

/** @type {import('bun').Subprocess} */
let proc;
let base = "";
let dataDir = "";

beforeAll(async () => {
  const tmpParent = resolve(import.meta.dir, "../../../.tmp");
  await mkdir(tmpParent, { recursive: true });
  dataDir = await mkdtemp(join(tmpParent, "openfunnel-test-"));
  const port = 4000 + Math.floor(Math.random() * 1000);
  base = `http://localhost:${port}`;

  proc = Bun.spawn(["bun", SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, FUNNELS_DIR: resolve(import.meta.dir, "../../../examples") },
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

  test("sends and verifies email OTP codes to block fake leads", async () => {
    const sendRes = await fetch(`${base}/api/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "lead@example.com" }),
    });
    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    expect(sendData.ok).toBe(true);

    const code = sendData.code;
    if (code) {
      const vRes = await fetch(`${base}/api/otp/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "lead@example.com", code }),
      });
      expect(vRes.status).toBe(200);
      expect((await vRes.json()).ok).toBe(true);
    }
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
