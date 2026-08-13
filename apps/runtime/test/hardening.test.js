/**
 * @file Regression tests for the runtime findings fixed in this pass.
 *
 * Each one asserts the *bug*, not the feature: the rate-limiter prune that reset
 * the hourly mail cap, the funnel field that redirected leads to another origin,
 * and the unbounded sink read that let an anonymous writer size the operator's
 * dashboard allocation.
 *
 * `lib/config.js` reads the environment once at import time, so the data dir is
 * set before the dynamic imports below rather than in a `beforeAll`.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const tmpParent = resolve(import.meta.dir, "../../../.tmp");
const dataDir = await mkdtemp(join(tmpParent, "openfunnel-hardening-"));
process.env.DATA_DIR = dataDir;
// Both ceilings at their 1MB floor, so a test can cross them without writing
// the 64MB the default would need.
process.env.MAX_SINK_BYTES = "1000000";
process.env.MAX_READ_BYTES = "1000000";

// The prune test below asserts the behaviour of the in-process bucket, which
// `rateLimit` only reaches with no database configured. Bun auto-loads the repo
// root `.env`, so without this the file inherits whatever Supabase project the
// developer is actually pointed at and fires five thousand `rate_hit` calls at
// it — slow, dependent on a network, and aimed at production. Blanked rather
// than pointed at a fake host so nothing leaves the machine at all. They stay
// unset afterwards rather than being restored, for the same reason: the next
// test file inheriting the developer's real project is the hazard, not the
// absence of one.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/* ========================================================================== *
 *  M2 — the prune judged every bucket by the caller's window
 * ========================================================================== */

test("an exhausted long-window bucket survives a flood of short-window calls", async () => {
  const { rateLimit } = await import("../lib/ratelimit.js");

  // Stands in for MAIL_HOURLY_CAP: the one ceiling whose key a caller cannot
  // rotate, and therefore the one worth resetting.
  const CAP = "mail:global";
  const LONG = 2000;
  expect(await rateLimit(CAP, 2, LONG)).toBe(true);
  expect(await rateLimit(CAP, 2, LONG)).toBe(true);
  expect(await rateLimit(CAP, 2, LONG)).toBe(false);

  // Exhausted buckets stop recording hits, so this one's newest timestamp now
  // ages while the limit is still meant to hold.
  await Bun.sleep(120);

  // Public, unauthenticated, 60s-window calls — enough of them to trip the
  // prune. The old code compared every bucket against *this* window, so the
  // hourly one looked stale after 60s and was deleted by the very traffic it
  // was supposed to be independent of.
  for (let i = 0; i < 5100; i++) await rateLimit(`ingest:flood-${i}`, 300, 60);

  expect(await rateLimit(CAP, 2, LONG)).toBe(false);
});

/* ========================================================================== *
 *  M1 — integrations.leadEndpoint pointed the browser at another origin
 * ========================================================================== */

test("publicFunnel drops a cross-origin leadEndpoint and keeps a path", async () => {
  const { publicFunnel } = await import("../lib/funnels.js");

  const hijacked = publicFunnel({
    slug: "x",
    integrations: { leadEndpoint: "https://leads.attacker.tld/collect", metaPixelId: "1" },
  });
  expect(hijacked.integrations.leadEndpoint).toBeUndefined();
  expect(hijacked.integrations.metaPixelId).toBe("1"); // unrelated config untouched

  // Protocol-relative reads as an absolute URL in a browser, so it is the same
  // attack with two characters.
  expect(publicFunnel({ integrations: { leadEndpoint: "//attacker.tld/c" } }).integrations.leadEndpoint)
    .toBeUndefined();
  expect(publicFunnel({ integrations: { leadEndpoint: "/\\attacker.tld/c" } }).integrations.leadEndpoint)
    .toBeUndefined();

  // And the same attack with ONE character. The URL parser deletes ASCII tab,
  // newline and carriage return from anywhere in the input before resolving, so
  // each of these is `https://attacker.tld/c` to the browser that fetches it
  // while reading as a plain path to any string-matching check.
  for (const ws of ["\t", "\n", "\r"]) {
    const funnel = publicFunnel({ integrations: { leadEndpoint: `/${ws}/attacker.tld/c` } });
    expect(funnel.integrations.leadEndpoint).toBeUndefined();
  }
  expect(publicFunnel({ integrations: { leadEndpoint: "https://openfunnel.invalid/c" } })
    .integrations.leadEndpoint).toBeUndefined();

  expect(publicFunnel({ integrations: { leadEndpoint: "/api/lead" } }).integrations.leadEndpoint)
    .toBe("/api/lead");
});

test("funnelCsp no longer widens connect-src for a funnel-supplied endpoint", async () => {
  const { funnelCsp } = await import("../lib/csp.js");
  const csp = funnelCsp({ slug: "x", integrations: { leadEndpoint: "https://leads.attacker.tld/collect" } });
  expect(csp).not.toContain("attacker.tld");
  expect(csp).toContain("connect-src 'self'");
});

test("funnelCsp pre-authorises no font host — the preset faces are self-hosted", async () => {
  const { funnelCsp } = await import("../lib/csp.js");
  // A preset funnel: the case that used to hotlink Google on page view.
  const csp = funnelCsp({ slug: "x", theme: { preset: "midnight-glass", font: "'Plus Jakarta Sans', sans-serif" } });

  // The policy is the second half of the gate (PHASE-1-PLAN.md §4.9): the
  // engine no longer asks for a remote font, and the CSP no longer permits one.
  // Asserted on the whole policy rather than on style-src alone, because a
  // revert would most likely put both hosts back at once.
  expect(csp).not.toContain("googleapis.com");
  expect(csp).not.toContain("gstatic.com");
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(csp).toContain("font-src 'self' data:");
});

/* ========================================================================== *
 *  M3 — unbounded sink growth and unbounded reads
 * ========================================================================== */

test("readJsonlRecords reads a bounded tail and skips a partial line", async () => {
  const { readJsonlRecords } = await import("../lib/store.js");

  // Bigger than MAX_READ_BYTES (1MB floor) so the read starts mid-record.
  const filler = { note: "x".repeat(1_200_000) };
  const newest = { id: "newest" };
  await writeFile(
    join(dataDir, "tail.jsonl"),
    `${JSON.stringify(filler)}\n${JSON.stringify(newest)}\n`,
    "utf8",
  );

  const records = await readJsonlRecords("tail.jsonl");
  expect(records.length).toBe(1);
  expect(records[0].id).toBe("newest");
});

// Nothing writes an `ip` any more, but a sink written before that change still
// holds one — and every admin reader (lead inbox, CSV export, the drawer's "Copy
// JSON") returns these records verbatim. Stripping on read is what makes the
// upgrade apply to the file that is already on disk.
test("readJsonlRecords drops an ip left by an older writer", async () => {
  const { readJsonlRecords } = await import("../lib/store.js");
  await writeFile(
    join(dataDir, "legacy.jsonl"),
    `${JSON.stringify({ id: "old", ip: "203.0.113.9", lead: { email: "a@b.invalid" } })}\n`,
    "utf8",
  );

  const records = await readJsonlRecords("legacy.jsonl");
  expect(records).toHaveLength(1);
  expect(records[0].ip).toBeUndefined();
  expect(records[0].lead.email).toBe("a@b.invalid");
});

test("readJsonlRecords skips a malformed line instead of returning nothing", async () => {
  const { readJsonlRecords } = await import("../lib/store.js");
  await writeFile(join(dataDir, "torn.jsonl"), '{"id":"a"}\n{not json\n{"id":"b"}\n', "utf8");

  const records = await readJsonlRecords("torn.jsonl");
  expect(records.map((r) => r.id)).toEqual(["a", "b"]);
});

test("the sink rotates at its ceiling and the new file is not world-readable", async () => {
  const { persist } = await import("../lib/store.js");
  const file = join(dataDir, "events.jsonl");

  // One oversized record puts the file past MAX_SINK_BYTES; the next append
  // rotates it. Disk is therefore bounded at 2× the ceiling however long an
  // unauthenticated caller keeps posting.
  await writeFile(file, `${JSON.stringify({ pad: "x".repeat(1_100_000) })}\n`, "utf8");
  await persist("events", { id: "after-rotation" });

  expect((await stat(`${file}.1`)).size).toBeGreaterThan(1_000_000);
  const rolled = await stat(file);
  expect(rolled.size).toBeLessThan(1000);
  expect(rolled.mode & 0o077).toBe(0); // 0600: these files hold lead PII
});
