/**
 * @file WO12b — the provider seam in `lib/email.js`.
 *
 * Every test here stubs `globalThis.fetch`, so nothing in this file can send a
 * real message. What is asserted is the request that WOULD have gone out: which
 * provider was selected, the URL and headers it was handed, and the body shape —
 * because Brevo rejects the whole request when one recipient is the wrong shape,
 * and that reads as an outage rather than as one bad address.
 *
 * Two of these are regression tests rather than new behaviour: an install with
 * only `RESEND_API_KEY` must resolve exactly as it did before the table existed,
 * and a provider named in `EMAIL_PROVIDER` must be used even with no key — a
 * deployment that names Brevo and forgot the key has to fail as Brevo rather
 * than quietly succeed as something else.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/* Bun auto-loads the repo's `.env`. Unset, never restored — the hazard is the
 * next test file inheriting a real credential, not the absence of one. */
for (const key of ["EMAIL_PROVIDER", "RESEND_API_KEY", "RESEND_FROM", "BREVO_API_KEY", "BREVO_FROM", "SMTP_RELAY_URL", "SMTP_HOST", "SMTP_PASS"]) {
  delete process.env[key];
}

const tmpParent = resolve(import.meta.dir, "../../../.tmp");
await mkdir(tmpParent, { recursive: true });
const dataDir = await mkdtemp(join(tmpParent, "openfunnel-transport-"));
process.env.DATA_DIR = dataDir;

const { getEmailSettings, redactEmailSettings, saveEmailSettings, sendEmail } = await import("../lib/email.js");

const realFetch = globalThis.fetch;

/** Stub `fetch` and record what it was called with. */
function stub(status = 200) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status, headers: { "content-type": "application/json" } });
    }
  );
  return calls;
}

// Per test, not once at import: every test file's module body runs before any
// test does, so a file that points DATA_DIR at its own scratch dir at import
// time would otherwise decide it for this one too.
beforeEach(() => {
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ["EMAIL_PROVIDER", "RESEND_API_KEY", "BREVO_API_KEY", "BREVO_FROM"]) delete process.env[key];
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const message = { to: "ops@example.invalid", subject: "New lead", html: "<b>Hello</b>" };

test("EMAIL_PROVIDER=brevo sends to Brevo, with the key in its own header and never in the URL", async () => {
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  process.env.BREVO_FROM = "Acme Leads <leads@acme.invalid>";

  const calls = stub(201); // Brevo answers 201 Created, not 200.
  const res = await sendEmail(message);

  expect(res).toEqual({ ok: true, provider: "brevo" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
  expect(calls[0].url).not.toContain("xkeysib");
  expect(calls[0].init.headers["api-key"]).toBe("xkeysib-not-a-real-key");
  expect(calls[0].init.headers.authorization).toBeUndefined();

  const body = JSON.parse(calls[0].init.body);
  expect(body.sender).toEqual({ name: "Acme Leads", email: "leads@acme.invalid" });
  expect(body.to).toEqual([{ email: "ops@example.invalid" }]);
  expect(body.subject).toBe("New lead");
  expect(body.htmlContent).toBe("<b>Hello</b>");
  // Derived from the HTML when the caller supplies none, same as Resend's.
  expect(body.textContent).toContain("Hello");
});

test("an array of recipients is split per address, not passed through as strings", async () => {
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";

  const calls = stub(201);
  await sendEmail({ ...message, to: ["a@example.invalid", "Ops Team <b@example.invalid>", "  ", ""] });

  const body = JSON.parse(calls[0].init.body);
  expect(body.to).toEqual([{ email: "a@example.invalid" }, { name: "Ops Team", email: "b@example.invalid" }]);
});

test("a Brevo rejection maps to its own error code and does not claim success", async () => {
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";

  stub(400);
  expect(await sendEmail(message)).toEqual({ ok: false, error: "brevo_400" });
});

test("RESEND_API_KEY alone still sends through Resend, unchanged", async () => {
  process.env.RESEND_API_KEY = "re_not_a_real_key";

  const calls = stub(200);
  const res = await sendEmail(message);

  expect(res).toEqual({ ok: true, provider: "resend" });
  expect(calls[0].url).toBe("https://api.resend.com/emails");
  expect(calls[0].init.headers.authorization).toBe("Bearer re_not_a_real_key");

  const body = JSON.parse(calls[0].init.body);
  expect(body.from).toBe("OpenFunnel Leads <leads@openfunnel.dev>");
  expect(body.to).toEqual(["ops@example.invalid"]);
  expect(body.html).toBe("<b>Hello</b>");
});

// Also review round 1's first Major, which is why the warning is asserted right
// here rather than in a test of its own: `getEmailSettings` INFERS `provider`
// from whichever key is present, so by the time `pickTransport` sees it, "two
// keys and nobody chose" is indistinguishable from `EMAIL_PROVIDER=resend`. The
// warning used to be raised there and never fired in the one case it was written
// for — an operator adding a second key to migrate, who then keeps sending
// through the first with no signal at all. It is once per process, so it has to
// be captured at the first send that can raise it.
test("with both keys and no EMAIL_PROVIDER, the pre-existing provider keeps the traffic — and says so", async () => {
  process.env.RESEND_API_KEY = "re_not_a_real_key";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const calls = stub(200);
    expect((await sendEmail(message)).provider).toBe("resend");
    expect(calls[0].url).toContain("api.resend.com");

    const ambiguous = warnings.filter((line) => line.includes("more than one provider key"));
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toContain("EMAIL_PROVIDER");

    // Once per process: a warning on every send would bury the log it exists to
    // stand out in.
    await sendEmail(message);
    expect(warnings.filter((line) => line.includes("more than one provider key"))).toHaveLength(1);
  } finally {
    console.warn = realWarn;
  }
});

test("EMAIL_PROVIDER wins over a configured key, in both directions", async () => {
  process.env.RESEND_API_KEY = "re_not_a_real_key";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";
  process.env.EMAIL_PROVIDER = "brevo";

  const calls = stub(201);
  expect((await sendEmail(message)).provider).toBe("brevo");
  expect(calls[0].url).toContain("api.brevo.com");
});

test("EMAIL_PROVIDER=brevo with no key fails as Brevo rather than falling back to Resend", async () => {
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.RESEND_API_KEY = "re_not_a_real_key";

  const calls = stub(401);
  const res = await sendEmail(message);

  expect(res).toEqual({ ok: false, error: "brevo_401" });
  expect(calls[0].url).toContain("api.brevo.com");
});

test("EMAIL_PROVIDER=smtp is not overridden by a stale API key", async () => {
  process.env.EMAIL_PROVIDER = "smtp";
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";

  const calls = stub(200);
  const res = await sendEmail(message);

  // No relay configured either, so the honest answer is that nothing was sent.
  expect(res.ok).toBe(false);
  expect(calls).toHaveLength(0);
});

test("the Brevo key is redacted out of the settings the console reads", async () => {
  process.env.BREVO_API_KEY = "xkeysib-not-a-real-key";

  const safe = redactEmailSettings(await getEmailSettings());
  expect(safe).not.toHaveProperty("brevoApiKey");
  expect(safe.brevoApiKeySet).toBe(true);
  expect(JSON.stringify(safe)).not.toContain("xkeysib");
});

test("a blank Brevo key means keep the existing one, and an env key is never persisted", async () => {
  // Stored, so this test is about the merge rather than the environment.
  await writeFile(join(dataDir, "email_settings.json"), JSON.stringify({ brevoApiKey: "xkeysib-stored" }), "utf8");
  try {
    const kept = await saveEmailSettings({ brevoApiKey: "", brevoFrom: "Acme <leads@acme.invalid>" });
    expect(kept.brevoApiKey).toBe("xkeysib-stored");
    expect(kept.brevoFrom).toBe("Acme <leads@acme.invalid>");
    expect(await getEmailSettings()).toMatchObject({ brevoApiKey: "xkeysib-stored" });

    // A key that only ever came from the environment must not be copied to disk:
    // the stored copy would then shadow it, so rotating the real secret would
    // silently stop taking effect.
    await rm(join(dataDir, "email_settings.json"), { force: true });
    process.env.BREVO_API_KEY = "xkeysib-from-env";
    await saveEmailSettings({ notifyEmail: "ops@example.invalid" });
    const onDisk = await readFile(join(dataDir, "email_settings.json"), "utf8");
    expect(onDisk).not.toContain("xkeysib-from-env");
  } finally {
    await rm(join(dataDir, "email_settings.json"), { force: true });
  }
});

test("provider=brevo survives a settings write; an unknown provider does not", async () => {
  try {
    expect((await saveEmailSettings({ provider: "brevo" })).provider).toBe("brevo");
    // Unknown values are dropped, so the previous choice stands.
    expect((await saveEmailSettings({ provider: "carrier-pigeon" })).provider).toBe("brevo");
  } finally {
    await rm(join(dataDir, "email_settings.json"), { force: true });
  }
});
