/**
 * @file OTP issuance and verification, with `fetch` stubbed — the database
 * path, the fail-closed behaviour of verification, and the no-salt fallback.
 *
 * `sendOtpCode` never returns the code it generated (see the comment in
 * `lib/email.js`), so the tests that need to know the actual value recover it
 * from the outbound mail request itself — set `RESEND_API_KEY` so `sendEmail`
 * takes the fetch path to `api.resend.com`, which this file's `fetch` stub
 * captures the same way it captures the `/rpc/*` calls.
 *
 * `lib/config.js` reads the environment once at import time, so the Supabase
 * variables are set before the dynamic imports below rather than in a
 * `beforeAll` — same pattern as db.test.js.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.SUPABASE_URL = "https://db.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-not-real";

// Each test clears the variables it set, and clearing is the END STATE — these
// are deliberately not restored to whatever the repo root `.env` supplied. Bun
// auto-loads that file, so "put back what was there" would hand the next test
// file a real Resend key and a real Supabase project, which is exactly how
// `db-integration.mjs` ended up running against production earlier in this
// phase. Unset is safe: with no salt the OTP path takes its in-memory fallback,
// and with no key `sendEmail` reports `no_transport` instead of mailing anyone.
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

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stub `fetch` and record what it was called with. */
function stub(responder) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    }
  );
  return calls;
}

/**
 * Recover the six-digit code from an outbound Resend request body. Anchored on
 * `font-size:36px`, the styling unique to the code's own `<div>` — the
 * template also carries `#111827` (a hex colour) elsewhere, which is itself
 * six decimal digits and would false-match a plain `/\d{6}/` search.
 */
function codeFromResendBody(body) {
  const html = JSON.parse(body).html;
  const match = html.match(/font-size:36px;[^>]*>(\d{6})</);
  if (!match) throw new Error("could not find the code in the Resend request body");
  return match[1];
}

test("the OTP hash sent to Postgres matches the code and never contains it as plaintext", async () => {
  process.env.OTP_HASH_SALT = "test-otp-salt";
  process.env.RESEND_API_KEY = "test-resend-key";
  try {
    const { sendOtpCode } = await import("../lib/email.js");
    const calls = stub((url) => (url.includes("/rpc/issue_otp") ? jsonResponse(null) : jsonResponse({ id: "email_1" })));

    const res = await sendOtpCode("visitor@example.invalid");
    expect(res.ok).toBe(true);

    const issueCall = calls.find((c) => c.url.endsWith("/rpc/issue_otp"));
    const resendCall = calls.find((c) => c.url === "https://api.resend.com/emails");
    expect(issueCall).toBeDefined();
    expect(resendCall).toBeDefined();

    const code = codeFromResendBody(resendCall.init.body);
    const issueBody = JSON.parse(issueCall.init.body);

    expect(issueBody.p_email).toBe("visitor@example.invalid");
    expect(issueBody.p_code_hash).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(issueBody.p_code_hash).toBe(
      `\\x${createHash("sha256").update(`test-otp-salt:visitor@example.invalid:${code}`).digest("hex")}`,
    );
    expect(issueBody.p_code_hash).not.toContain(code);
  } finally {
    delete process.env.OTP_HASH_SALT;
    delete process.env.RESEND_API_KEY;
  }
});

test("isEmailVerified fails closed when the RPC throws — a database outage must never read as verified", async () => {
  process.env.OTP_HASH_SALT = "test-otp-salt";
  try {
    const { isEmailVerified } = await import("../lib/email.js");
    stub(() => {
      throw new TypeError("fetch failed");
    });

    expect(await isEmailVerified("visitor@example.invalid")).toBe(false);
  } finally {
    delete process.env.OTP_HASH_SALT;
  }
});

test("verifyOtpCode also fails closed when the RPC throws", async () => {
  process.env.OTP_HASH_SALT = "test-otp-salt";
  try {
    const { verifyOtpCode } = await import("../lib/email.js");
    stub(() => {
      throw new TypeError("fetch failed");
    });

    expect(await verifyOtpCode("visitor@example.invalid", "123456")).toBe(false);
  } finally {
    delete process.env.OTP_HASH_SALT;
  }
});

test("with no salt configured, no RPC is issued at all and the in-memory path answers", async () => {
  delete process.env.OTP_HASH_SALT;
  delete process.env.IP_HASH_SALT;
  process.env.RESEND_API_KEY = "test-resend-key";
  try {
    const { sendOtpCode, verifyOtpCode } = await import("../lib/email.js");
    const calls = stub((url) => {
      if (url.includes("/rpc/")) throw new Error("no RPC should be issued with no salt configured");
      return jsonResponse({ id: "email_1" });
    });

    const send = await sendOtpCode("visitor@example.invalid");
    expect(send.ok).toBe(true);
    expect(calls.some((c) => c.url.includes("/rpc/"))).toBe(false);

    const resendCall = calls.find((c) => c.url === "https://api.resend.com/emails");
    const code = codeFromResendBody(resendCall.init.body);

    // In-memory path answers: the code just issued verifies, and is consumed —
    // a second attempt with the same code fails.
    expect(await verifyOtpCode("visitor@example.invalid", code)).toBe(true);
    expect(await verifyOtpCode("visitor@example.invalid", code)).toBe(false);
  } finally {
    delete process.env.RESEND_API_KEY;
  }
});

/* ========================================================================== *
 *  activeEmailProvider — what a published privacy notice is allowed to name
 * ========================================================================== */

test("activeEmailProvider names a provider only when its key is actually there", async () => {
  const { activeEmailProvider } = await import("../lib/email.js");

  expect(activeEmailProvider({ provider: "brevo", brevoApiKey: "k" })).toBe("brevo");
  expect(activeEmailProvider({ provider: "resend", resendApiKey: "k" })).toBe("resend");
  // Chosen but unconfigured: `pickTransport` still names it (so `sendEmail`
  // fails loudly as that provider), which is exactly why the notice cannot
  // reuse `pickTransport` directly.
  expect(activeEmailProvider({ provider: "brevo" })).toBe(null);
  expect(activeEmailProvider({})).toBe(null);
});

test("activeEmailProvider does not fall back to the relay for a keyless provider", async () => {
  const { activeEmailProvider } = await import("../lib/email.js");

  // `sendEmail` returns from inside the named-transport branch whether or not
  // the key is set, so it never reaches the relay in this configuration: mail
  // goes nowhere. Naming the relay here would put a recipient into a document
  // the client publishes for mail that never leaves the process.
  expect(activeEmailProvider({ provider: "brevo", relayUrl: "https://mail.internal.invalid/send" })).toBe(null);
  // `provider: "smtp"` is the operator explicitly choosing the relay path, and
  // `pickTransport` short-circuits on it — that one really does send there.
  expect(activeEmailProvider({ provider: "smtp", relayUrl: "https://mail.internal.invalid/send" })).toBe("http_relay");
  expect(activeEmailProvider({ relayUrl: "https://mail.internal.invalid/send" })).toBe("http_relay");
});
