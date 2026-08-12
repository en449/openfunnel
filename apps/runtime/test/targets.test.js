/**
 * @file WO12a — where `delivery_target` rows come from, and what must not go
 * dark the moment the first one exists.
 *
 * Two things are asserted here that nothing else can see. The derivation, which
 * decides where a client's leads are delivered and is therefore worth pinning
 * field by field. And the switch-over: creating a target flips `queueOwnsIt`,
 * which switches the direct fan-out off — so anything the fan-out used to send
 * that has no queue equivalent stops being sent, silently, with a 202 still
 * going back to the visitor.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Bun auto-loads the repo's `.env`. Unset, never restored — the hazard is the
 * next test file inheriting a real credential, not the absence of one. */
for (const key of [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WEBHOOK_URL",
  "ZAPIER_WEBHOOK_URL",
  "WEBHOOK_SECRET",
  "NOTIFY_EMAIL",
  "META_PIXEL_ID",
  "META_CAPI_TOKEN",
  "RESEND_API_KEY",
  "SMTP_RELAY_URL",
  "SMTP_HOST",
]) {
  delete process.env[key];
}

const tmpParent = resolve(import.meta.dir, "../../../.tmp");
await mkdir(tmpParent, { recursive: true });
const dataDir = await mkdtemp(join(tmpParent, "openfunnel-targets-"));
process.env.DATA_DIR = dataDir;

// A transport, so the mail paths below are observable. Written to disk because
// that is where `getEmailSettings` looks, and reading it per call is what makes
// this file independent of import order.
await writeFile(
  join(dataDir, "email_settings.json"),
  JSON.stringify({
    provider: "resend",
    resendApiKey: "re_not_a_real_key",
    notifyEnabled: true,
    notifyEmail: "operator@example.invalid",
    autoresponderEnabled: true,
  }),
  "utf8",
);

const { deriveTargets, syncFunnelTargets } = await import("../lib/targets.js");
const { notifyEmailFor } = await import("../lib/email.js");
const { publicFunnel } = await import("../lib/funnels.js");
const { persist } = await import("../lib/store.js");

const realFetch = globalThis.fetch;

// Per test, not once at import. Every test file's module body runs before any
// test does, so two files that both point `DATA_DIR` at their own scratch
// directory at import time leave whichever loaded last deciding it for both —
// which read as this file's mail settings simply not existing.
beforeEach(() => {
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WEBHOOK_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const mail = { notifyEnabled: true, notifyEmail: "operator@example.invalid" };

/** A funnel document as the builder writes it — unredacted. */
const doc = (integrations = {}) => ({ slug: "wo12a", steps: [{ type: "form" }], integrations });

/* ========================================================================== *
 *  The derivation
 * ========================================================================== */

test("a webhook URL and its secret become one webhook target", () => {
  const targets = deriveTargets(doc({ webhookUrl: "https://hooks.example.invalid/x", webhookSecret: "s3cret" }), mail);
  expect(targets).toContainEqual({
    kind: "webhook",
    config: { url: "https://hooks.example.invalid/x", secret: "s3cret" },
  });
});

test("a webhook host the egress guard refuses never becomes a target", () => {
  const targets = deriveTargets(doc({ webhookUrl: "http://127.0.0.1:9999/hook" }), mail);
  // Not "created and then dead-lettered on first attempt": a row that can never
  // deliver reads as an outage in the console it will eventually appear in.
  expect(targets.some((t) => t.kind === "webhook")).toBe(false);
});

test("the funnel's own notification address wins over the install-wide one", () => {
  const targets = deriveTargets(doc({ notifyEmail: "kunde@example.invalid" }), mail);
  expect(targets).toContainEqual({ kind: "email", config: { to: "kunde@example.invalid" } });
  expect(targets).not.toContainEqual({ kind: "email", config: { to: "operator@example.invalid" } });
});

test("no funnel address falls back to the install-wide one", () => {
  expect(deriveTargets(doc(), mail)).toContainEqual({
    kind: "email",
    config: { to: "operator@example.invalid" },
  });
});

test("notifications switched off produce no email target at all", () => {
  const targets = deriveTargets(doc(), { notifyEnabled: false, notifyEmail: "operator@example.invalid" });
  expect(targets.some((t) => t.kind === "email")).toBe(false);
});

test("a funnel with nothing configured derives nothing", () => {
  // Which is the signal for `sync_delivery_targets` to disable whatever it wrote
  // last time, and for ingest to keep using the direct fan-out.
  expect(deriveTargets(doc(), { notifyEnabled: true, notifyEmail: "" })).toEqual([]);
});

test("a garbled notification address is refused rather than queued", () => {
  const targets = deriveTargets(doc({ notifyEmail: "not-an-address" }), mail);
  expect(targets.some((t) => t.kind === "email")).toBe(false);
});

/* ========================================================================== *
 *  Nothing this touches is allowed to reach the browser
 * ========================================================================== */

test("publicFunnel strips the notification address", () => {
  const clean = publicFunnel(doc({ notifyEmail: "kunde@example.invalid", metaPixelId: "123" }));
  // The whole document is inlined into the funnel page, so a field left here is
  // a client's email address published to everyone who clicks the ad.
  expect(clean.integrations.notifyEmail).toBeUndefined();
  expect(clean.integrations.metaPixelId).toBe("123");
});

/* ========================================================================== *
 *  The write
 * ========================================================================== */

test("syncFunnelTargets sends the derived list to the RPC and returns the count", async () => {
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";
  /** @type {any} */
  let sent = null;
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body || "{}")) };
      return new Response("2", { status: 200, headers: { "content-type": "application/json" } });
    }
  );

  const count = await syncFunnelTargets("wo12a", doc({ webhookUrl: "https://hooks.example.invalid/x" }));

  expect(count).toBe(2);
  expect(sent.url).toContain("/rpc/sync_delivery_targets");
  expect(sent.body.p_slug).toBe("wo12a");
  expect(sent.body.p_targets.map((/** @type {any} */ t) => t.kind).sort()).toEqual(["email", "webhook"]);
});

test("a failed sync is a warning, never a thrown save", async () => {
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";
  globalThis.fetch = /** @type {any} */ (async () => new Response("nope", { status: 500 }));

  // The caller is `saveFunnel`. Refusing an operator's funnel save because a
  // derived row could not be written trades a working console for a tidy
  // database, and the fan-out still delivers meanwhile.
  expect(await syncFunnelTargets("wo12a", doc())).toBe(null);
});

test("saving a funnel is what triggers the sync", async () => {
  // The wiring, not the derivation. Without this, deleting the one line in
  // `saveFunnel` leaves every unit test above passing and nothing on any
  // deployment ever creating a target again — which is the state WO12a exists
  // to end, and it would look exactly like it looked before.
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";
  /** @type {string[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      const href = String(url);
      calls.push(`${init?.method || "GET"} ${href.split("/rest/v1/")[1] || href}`);
      const body = href.includes("/rpc/sync_delivery_targets")
        ? 1
        : href.includes("/client")
          ? [{ id: "00000000-0000-0000-0000-000000000001" }]
          : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  );

  const { saveFunnel } = await import("../lib/funnels.js");
  await saveFunnel("wo12a-wired", doc({ webhookUrl: "https://hooks.example.invalid/x" }));

  expect(calls.some((c) => c.includes("rpc/sync_delivery_targets"))).toBe(true);
});

/* ========================================================================== *
 *  What must not go dark when the queue takes over
 * ========================================================================== */

/** @returns {{ recipients: string[] }} every address the mail transport was asked for. */
function captureMail() {
  const recipients = /** @type {string[]} */ ([]);
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      if (String(url).includes("api.resend.com")) {
        const body = JSON.parse(String(init?.body || "{}"));
        recipients.push(...[].concat(body.to));
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
  );
  return { recipients };
}

test("the visitor's autoresponder still sends once the queue owns the lead", async () => {
  const { recipients } = captureMail();

  await persist("leads", { funnelId: "wo12a-unknown", lead: { email: "visitor1@example.invalid" } }, { fanOut: false });

  // fanOut false means a delivery_target exists, so the operator's alert is the
  // queue's job now. The autoresponder is NOT a delivery of the lead and has no
  // target — leaving it in the fan-out branch took it silently dark for every
  // funnel that gained a target.
  expect(recipients).toEqual(["visitor1@example.invalid"]);
});

test("with no queue owning it, the operator is alerted as well", async () => {
  const { recipients } = captureMail();

  await persist("leads", { funnelId: "wo12a-unknown", lead: { email: "visitor2@example.invalid" } }, { fanOut: true });

  expect(recipients.sort()).toEqual(["operator@example.invalid", "visitor2@example.invalid"]);
});

test("the fan-out honours the funnel's own notification address too", async () => {
  // The queue reads `integrations.notifyEmail` when deriving a target. The
  // fan-out has to read the SAME field, or the console's per-funnel address does
  // nothing at all on a deployment with no database — where `fanOut` is always
  // true — and nothing on a Postgres install for any lead that degraded to it.
  process.env.SUPABASE_URL = "https://db.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";
  /** @type {string[]} */
  const recipients = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      const href = String(url);
      if (href.includes("api.resend.com")) {
        recipients.push(...[].concat(JSON.parse(String(init?.body || "{}")).to));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      // The funnel document, as `loadFunnel` reads it out of the `funnel` table.
      const body = href.includes("/funnel?")
        ? [{ slug: "wo12a-own", status: "draft", doc: doc({ notifyEmail: "kunde@example.invalid" }) }]
        : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
  );

  await persist("leads", { funnelId: "wo12a-own", lead: { email: "visitor3@example.invalid" } }, { fanOut: true });

  expect(recipients.sort()).toEqual(["kunde@example.invalid", "visitor3@example.invalid"]);
});

test("notifications switched off silence the funnel's own address as well", () => {
  // The funnel field overrides the ADDRESS, not the operator's decision to
  // receive alerts — one master switch, or "off" does not mean off.
  expect(notifyEmailFor(doc({ notifyEmail: "kunde@example.invalid" }), { notifyEnabled: false })).toBe("");
});

test("an unusable override resolves to nothing rather than the global address", () => {
  // Falling back would deliver a client's leads into the operator's own inbox
  // because of a typo, which is the failure that looks like it worked.
  expect(notifyEmailFor(doc({ notifyEmail: "not-an-address" }), mail)).toBe("");
});
