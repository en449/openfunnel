/**
 * @file Mail settings, the transports, the OTP challenge, and the two messages
 * a captured lead triggers.
 *
 * Four things here are security controls, not plumbing:
 *
 *  - `redactEmailSettings` / `WRITABLE_EMAIL_KEYS`. Secrets never travel
 *    outward, writes go through an allowlist, and a blank secret means "keep the
 *    existing value" rather than wiping it.
 *  - `issue_otp` / `verify_otp` / `is_email_verified` (Postgres) and, as their
 *    fallback, `otpStore` / `verifiedEmails` (in-process). The browser can claim
 *    `email_verified` in a lead payload; only these decide whether the claim is
 *    true — see `otpDbReady()` for which one answers on a given call, and the
 *    comments on `verifyOtpCode` / `isEmailVerified` for why a database error
 *    answers "not verified" rather than falling back to the `Map`.
 *  - The `MAIL_HOURLY_CAP` calls. Both the OTP challenge and the autoresponder
 *    mail an address taken from a public request body, so both need a ceiling
 *    keyed on something the caller cannot rotate.
 *
 * Direct SMTP is NOT implemented. The working transports are the JSON-API
 * providers in `API_TRANSPORTS` (Resend, Brevo) and `SMTP_RELAY_URL`;
 * `sendEmail` reports `ok: false` when only `SMTP_*` is configured rather than
 * claiming a success that did not happen.
 *
 * `sendEmail` does not know who the provider is. Each entry in `API_TRANSPORTS`
 * supplies the key it needs and the request for one message; everything after
 * that — the timeout, the abort, the `res.ok` check, the error mapping, the rule
 * that a failure is logged through `errSummary` and never as the error object —
 * is written once, here. See PHASE-1-PLAN.md §4.6.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomInt } from "node:crypto";
import { safeEqual } from "./auth.js";
import { DATA_DIR } from "./config.js";
import { dbConfigured, dbErrorKind, rpc } from "./db.js";
import { esc } from "./html.js";
import { errSummary, oneLine } from "./log.js";
import { MAIL_HOURLY_CAP, rateLimit } from "./ratelimit.js";

/* ========================================================================== *
 *  Settings
 * ========================================================================== */

/**
 * Where `email_settings.json` lives.
 *
 * Resolved per call, not captured at import — the same rule `lib/store.js` and
 * `lib/db.js` follow, and it was the odd one out. Two consequences of the frozen
 * version, one per environment: on serverless `DATA_DIR` is how an operator
 * points the settings file at the only writable path there is, and a value read
 * at module load ignores them. In-process, whichever module imported this chain
 * FIRST decided the directory for everything after it — so a test that pointed
 * `DATA_DIR` at its own scratch copy before importing got the real one anyway,
 * silently, and read as "the operator has configured no mail at all".
 */
const dataDir = () => process.env.DATA_DIR || DATA_DIR;

/** Keys the console may write. Anything else in the body is discarded. */
const WRITABLE_EMAIL_KEYS = new Set([
  "provider",
  "resendApiKey",
  "resendFrom",
  "brevoApiKey",
  "brevoFrom",
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "smtpPass",
  "smtpFrom",
  "notifyEmail",
  "notifyEnabled",
  "autoresponderEnabled",
  "autoresponderSubject",
  "autoresponderBody",
]);

/**
 * Every secret setting, and the environment variable it falls back to.
 *
 * One table rather than a list plus a ternary in `saveEmailSettings`: that
 * ternary was two-way, so the third secret would silently have been compared
 * against the wrong variable and copied out of the environment into `DATA_DIR`
 * — the exact failure the comment there exists to prevent.
 *
 * @type {Record<string, string>}
 */
const SECRET_ENV = {
  resendApiKey: "RESEND_API_KEY",
  brevoApiKey: "BREVO_API_KEY",
  smtpPass: "SMTP_PASS",
};

/** Secrets are never echoed back; the console sees only whether they are set. */
const SECRET_EMAIL_KEYS = Object.keys(SECRET_ENV);

/** Sender used when the operator has configured none. Not a deliverable address. */
const DEFAULT_FROM = "OpenFunnel Leads <leads@openfunnel.dev>";

/**
 * The first transport whose environment key is set, in `API_TRANSPORTS` order —
 * which is the order that decides the default path (see the table's header).
 *
 * Reads `API_TRANSPORTS` and `SECRET_ENV`, both declared below: this runs per
 * call, long after module init, so there is no temporal-dead-zone problem. It is
 * placed here because it belongs to `getEmailSettings`, which is the only caller.
 *
 * @returns {string} A transport name, or "" when no provider key is configured.
 */
function envTransport() {
  return emailTransportNames().find((name) => process.env[emailTransportEnvVar(name)]) || "";
}

/**
 * The transports, in the order that decides the default path. Exported so a test
 * can hold the table to its own rules rather than restating them.
 */
export const emailTransportNames = () => Object.keys(API_TRANSPORTS);

/**
 * The environment variable a transport's key comes from, or "" if the table and
 * `SECRET_ENV` have drifted — which would make that transport unselectable by
 * inference, silently. A test asserts this is never empty.
 *
 * @param {string} name
 */
export const emailTransportEnvVar = (name) => {
  const keyField = API_TRANSPORTS[name]?.keyField;
  return (keyField && SECRET_ENV[keyField]) || "";
};

/** @returns {Promise<Record<string, any>>} */
export async function getEmailSettings() {
  const settingsFile = join(dataDir(), "email_settings.json");
  /** @type {Record<string, any>} */
  let stored = {};
  try {
    const parsed = JSON.parse(await readFile(settingsFile, "utf8"));
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {}

  // What actually NAMED a provider, as opposed to what was inferred from a key
  // being present. `pickTransport` cannot tell the two apart afterwards — the
  // inference below hands it a provider name that looks explicit — which is why
  // the ambiguity warning is raised here rather than there.
  const explicit = stored.provider || process.env.EMAIL_PROVIDER || "";

  const cfg = {
    // Derived from `API_TRANSPORTS` rather than re-listed here. This used to be
    // a hand-written ternary chain, which made the default provider two facts in
    // two places: reorder the table for the DSGVO gate (PLAN.md §8.3) and forget
    // this line, and the ambiguity warning names one provider while another
    // sends. Now there is one order and it cannot disagree with itself.
    provider: explicit || envTransport() || (process.env.SMTP_HOST ? "smtp" : "none"),
    resendApiKey: stored.resendApiKey || process.env.RESEND_API_KEY || "",
    resendFrom: stored.resendFrom || process.env.RESEND_FROM || DEFAULT_FROM,
    brevoApiKey: stored.brevoApiKey || process.env.BREVO_API_KEY || "",
    brevoFrom: stored.brevoFrom || process.env.BREVO_FROM || DEFAULT_FROM,
    smtpHost: stored.smtpHost || process.env.SMTP_HOST || "",
    smtpPort: Number(stored.smtpPort || process.env.SMTP_PORT || 587),
    smtpUser: stored.smtpUser || process.env.SMTP_USER || "",
    smtpPass: stored.smtpPass || process.env.SMTP_PASS || "",
    smtpFrom: stored.smtpFrom || process.env.SMTP_FROM || "OpenFunnel <noreply@openfunnel.dev>",
    notifyEmail: stored.notifyEmail || process.env.NOTIFY_EMAIL || "",
    notifyEnabled: stored.notifyEnabled !== false,
    autoresponderEnabled: Boolean(stored.autoresponderEnabled),
    autoresponderSubject: stored.autoresponderSubject || "Thank you for completing our quiz!",
    autoresponderBody: stored.autoresponderBody || "Hi {{name}},\n\nThank you for reaching out! We received your responses and our team will get back to you shortly.\n\nBest regards,\nOpenFunnel Team",
    // Deliberately env-only: an HTTP relay receives every lead notification, so
    // it must not be settable through the API. Even with the admin gate in
    // front, a stored relay URL would be a one-request exfiltration channel.
    relayUrl: process.env.SMTP_RELAY_URL || "",
  };

  warnAmbiguousProvider(explicit, cfg);
  return cfg;
}

/**
 * Strip secrets before the settings ever leave the process.
 *
 * @param {Record<string, any>} cfg
 */
export function redactEmailSettings(cfg) {
  /** @type {Record<string, any>} */
  const safe = { ...cfg };
  for (const key of SECRET_EMAIL_KEYS) {
    safe[`${key}Set`] = Boolean(safe[key]);
    delete safe[key];
  }
  delete safe.relayUrl;
  return safe;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Merge a validated subset of `patch` into the stored settings.
 * Unknown keys are dropped, blank secrets keep the existing value (so the
 * redacted GET can be round-tripped without wiping the key), and every field
 * is range-checked before it reaches disk.
 *
 * @param {Record<string, any>} patch
 */
export async function saveEmailSettings(patch) {
  const existing = await getEmailSettings();
  /** @type {Record<string, any>} */
  const next = { ...existing };

  // `getEmailSettings()` resolves secrets from the environment when nothing is
  // stored, so writing that merge straight back would copy RESEND_API_KEY /
  // SMTP_PASS out of the env and into DATA_DIR in plaintext on the first save —
  // and the stored copy then shadows the env var, so rotating the real secret
  // silently stops taking effect. Drop any secret that came from the env; only a
  // value the operator actually typed into this request gets persisted below.
  for (const [key, envVar] of Object.entries(SECRET_ENV)) {
    const fromEnv = process.env[envVar];
    if (fromEnv && next[key] === fromEnv) delete next[key];
  }

  for (const [key, value] of Object.entries(patch || {})) {
    if (!WRITABLE_EMAIL_KEYS.has(key)) continue;

    if (SECRET_EMAIL_KEYS.includes(key)) {
      // Empty means "leave it alone", not "delete it".
      if (typeof value === "string" && value.trim()) next[key] = value.trim();
      continue;
    }
    if (key === "provider") {
      if ([...Object.keys(API_TRANSPORTS), "smtp", "none"].includes(value)) next[key] = value;
      continue;
    }
    if (key === "smtpPort") {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port <= 65535) next[key] = port;
      continue;
    }
    if (key === "notifyEnabled" || key === "autoresponderEnabled") {
      next[key] = Boolean(value);
      continue;
    }
    if (key === "notifyEmail") {
      const email = String(value || "").trim();
      if (!email || EMAIL_RE.test(email)) next[key] = email;
      continue;
    }
    if (key === "smtpHost") {
      // A bare hostname only. Rejecting URLs keeps this field from being
      // repurposed into the HTTP relay that SMTP_RELAY_URL owns.
      const host = String(value || "").trim();
      if (!host || /^[a-z0-9.-]+$/i.test(host)) next[key] = host;
      continue;
    }
    if (typeof value === "string") next[key] = value.slice(0, 5000);
  }

  await mkdir(dataDir(), { recursive: true });
  const { relayUrl: _ignored, ...persistable } = next;
  await writeFile(join(dataDir(), "email_settings.json"), JSON.stringify(persistable, null, 2), "utf8");
  return next;
}

/* ========================================================================== *
 *  Transports
 * ========================================================================== */

/** Ceiling on one outbound send. Mirrors DELIVERY_TIMEOUT_MS, and read per call for the same reason. */
const sendTimeoutMs = () => Math.max(1000, Number(process.env.EMAIL_TIMEOUT_MS) || 10_000);

/**
 * `"Name <addr@example.com>"` → `{ name, email }`, a bare address → `{ email }`.
 *
 * Resend takes the combined string; Brevo takes the two halves, for the sender
 * AND for every recipient — and rejects the whole request if one entry is the
 * wrong shape, which would read as an outage rather than as one bad address.
 * The settings keep the combined form because that is what the console asks for.
 *
 * @param {string} value
 * @returns {{ name?: string, email: string }}
 */
function splitAddress(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(.*?)\s*<([^<>]+)>$/);
  if (!match) return { email: raw };
  const name = String(match[1] || "").trim().replace(/^"(.*)"$/, "$1").trim();
  const email = String(match[2] || "").trim();
  return name ? { name, email } : { email };
}

/**
 * @typedef {object} ApiTransport
 * @property {string} keyField  Which settings field holds this provider's key.
 * @property {(cfg: any, msg: { recipients: string[], subject: string, html: string, text: string })
 *   => { url: string, headers: Record<string, string>, body: any }} request
 */

/**
 * The JSON-API mail providers. A provider is a data entry: the key it reads and
 * the request for one message. Everything else — the deadline, the abort, the
 * success test, the error mapping, the logging rule — belongs to `sendEmail`
 * below and is therefore written exactly once.
 *
 * ORDER IS BEHAVIOUR. With no explicit `provider`, the first entry whose key is
 * configured wins, so this order IS the default path — which is what PLAN.md
 * §8.3's gate is about. Brevo (Brevo SAS, Paris) is declared first because a
 * German client's leads must not reach a US processor by default; Resend stays
 * in the table, supported and unchanged, for the installs already on it.
 *
 * Reordering this changes exactly one deployment: one that configures BOTH keys
 * and names neither in `EMAIL_PROVIDER`. That case already warns (once, naming
 * the variable), and it now resolves to the EU provider rather than to whichever
 * happened to be written first. An install with only `RESEND_API_KEY` still
 * sends through Resend — the entry above it has no key, so it is skipped.
 * `getEmailSettings` runs the same order over the environment; the two have to
 * be changed together.
 *
 * @type {Record<string, ApiTransport>}
 */
const API_TRANSPORTS = {
  // Brevo SAS, Paris — the EU processor this project defaults to, researched in
  // reference/eu-mail-providers-2026-08-10.md. The key travels in its own
  // header, never in the URL: a URL carrying a credential is what forces the
  // errSummary rule on every fetch rejection in this repo.
  brevo: {
    keyField: "brevoApiKey",
    request: (cfg, msg) => ({
      url: "https://api.brevo.com/v3/smtp/email",
      headers: {
        "api-key": cfg.brevoApiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: {
        sender: splitAddress(cfg.brevoFrom || DEFAULT_FROM),
        to: msg.recipients.map(splitAddress),
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
      },
    }),
  },
  // Resend Inc. (US). Still fully supported — an install already sending through
  // it keeps working with no change — but it is no longer what an unconfigured
  // deployment reaches for first. See PLAN.md §8.3: a US processor in the mail
  // path is a subprocessor a German client's AVV has to carry.
  resend: {
    keyField: "resendApiKey",
    request: (cfg, msg) => ({
      url: "https://api.resend.com/emails",
      headers: {
        authorization: `Bearer ${cfg.resendApiKey}`,
        "content-type": "application/json",
      },
      body: {
        from: cfg.resendFrom || DEFAULT_FROM,
        to: msg.recipients,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      },
    }),
  },
};

/**
 * Which transports have a key, in table order. The first is what wins.
 *
 * @param {Record<string, any>} cfg
 */
function configuredTransports(cfg) {
  return Object.entries(API_TRANSPORTS)
    .filter(([, transport]) => cfg[transport.keyField])
    .map(([name]) => name);
}

let warnedAmbiguousProvider = false;

/**
 * The one silent failure this seam could introduce: an operator adds a second
 * key to migrate off the first, keeps sending through the first, and has no way
 * to see it. Once per process, naming the variable that decides.
 *
 * Raised from `getEmailSettings` rather than from `pickTransport`, and review
 * caught why that matters: `getEmailSettings` INFERS `provider` from whichever
 * key is present, so by the time `pickTransport` sees it, "two keys and nobody
 * chose" is indistinguishable from `EMAIL_PROVIDER=resend`. The warning placed
 * there never fired in the exact case it was written for.
 *
 * @param {string} explicit  What actually named a provider — "" when nothing did.
 * @param {any} cfg
 */
function warnAmbiguousProvider(explicit, cfg) {
  if (warnedAmbiguousProvider) return;
  // Somebody chose. `smtp` counts as a choice: it means the relay path, so a
  // stale API key lying around is not an ambiguity.
  if (API_TRANSPORTS[explicit] || explicit === "smtp") return;

  const configured = configuredTransports(cfg);
  if (configured.length < 2) return;

  warnedAmbiguousProvider = true;
  console.warn(
    `[email] more than one provider key is configured (${configured.join(", ")}) and EMAIL_PROVIDER ` +
      `is not set — sending through "${configured[0]}". Set EMAIL_PROVIDER to choose.`,
  );
}

/**
 * Which API transport handles this send, if any.
 *
 * A named provider wins even with no key configured — a deployment that says
 * `EMAIL_PROVIDER=brevo` and forgot the key has to fail loudly as Brevo rather
 * than quietly succeed as something else. Otherwise the first configured key
 * wins in `API_TRANSPORTS` order, which since 2026-08-13 means the EU provider
 * ahead of the US one (PLAN.md §8.3). `provider: "smtp"` still short-circuits:
 * that value means the operator chose the relay path below, so a stale API key
 * must not override it.
 *
 * @param {any} cfg
 * @returns {string|null}
 */
function pickTransport(cfg) {
  if (API_TRANSPORTS[cfg.provider]) return cfg.provider;
  if (cfg.provider === "smtp") return null;
  return configuredTransports(cfg)[0] || null;
}

/**
 * Send one message through whichever transport `pickTransport` selects.
 *
 * `text` and `signal` are optional: most callers have neither, and a plain-text
 * part is derived from the HTML when none is given.
 *
 * @param {object} msg
 * @param {string|string[]} msg.to
 * @param {string} msg.subject
 * @param {string} msg.html
 * @param {string} [msg.text]
 * @param {AbortSignal} [msg.signal]
 * @returns {Promise<{ ok: boolean, provider?: string, error?: string }>}
 */
export async function sendEmail({ to, subject, html, text, signal }) {
  if (!to) return { ok: false, error: "missing_recipient" };
  const cfg = await getEmailSettings();

  // Bound every transport call. A mail provider that accepts the connection and
  // then never answers otherwise holds the invocation open until the platform
  // kills it — on the delivery path that burns the whole drain budget while the
  // rest of the queue waits. The webhook side already had this ceiling; mail
  // did not, which is the only reason the two behaved differently.
  const deadline = AbortSignal.timeout(sendTimeoutMs());
  const abort = signal ? AbortSignal.any([deadline, signal]) : deadline;

  const name = pickTransport(cfg);
  const transport = name ? API_TRANSPORTS[name] : undefined;
  if (name && transport) {
    const recipients = (Array.isArray(to) ? to : [to]).map((one) => String(one || "").trim()).filter(Boolean);
    if (!recipients.length) return { ok: false, error: "missing_recipient" };

    const { url, headers, body } = transport.request(cfg, {
      recipients,
      subject,
      html,
      text: text || String(html || "").replace(/<[^>]+>/g, " "),
    });
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: abort });
      if (res.ok) return { ok: true, provider: name };
      // Truncated: a provider error body is unbounded and this line is the one
      // an operator reads at 2am. The status is what actually classifies it.
      console.warn(`[email] ${name} error:`, res.status, oneLine(await res.text(), 300));
      return { ok: false, error: `${name}_${res.status}` };
    } catch (err) {
      console.warn(`[email] ${name} exception: ${errSummary(err)}`);
      return { ok: false, error: `${name}_failed` };
    }
  }

  // Optional HTTP relay for operators who front their own mailer. Env-only, so
  // it can never be pointed somewhere else through the API.
  if (cfg.relayUrl) {
    try {
      const res = await fetch(cfg.relayUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, subject, html, text }),
        signal: abort,
      });
      return { ok: res.ok, provider: "http_relay" };
    } catch (err) {
      // SMTP_RELAY_URL is operator-supplied and may carry a token in the URL,
      // which a fetch rejection would otherwise print via `err.path`.
      console.warn(`[email] relay error: ${errSummary(err)}`);
      return { ok: false, error: "relay_failed" };
    }
  }

  // No transport is wired up. Report that honestly — claiming success here
  // would let an operator believe lead alerts are going out when they are not.
  if (cfg.smtpHost) {
    console.warn(
      `[email] SMTP host ${cfg.smtpHost} is configured but direct SMTP is not implemented. ` +
        `Set BREVO_API_KEY or RESEND_API_KEY, or SMTP_RELAY_URL pointing at an HTTP-to-SMTP relay.`,
    );
    return { ok: false, error: "smtp_not_implemented" };
  }

  console.log(`[email] No transport configured — would send to ${to}: "${subject}"`);
  return { ok: false, error: "no_transport" };
}

/* ========================================================================== *
 *  Email verification challenge
 * ========================================================================== */

/**
 * NO-DATABASE / NO-SALT FALLBACK ONLY — see `otpDbReady()`. When a database is
 * configured and salted, nothing here is written or read; `issue_otp` /
 * `verify_otp` are the source of truth and a request served by a DIFFERENT
 * process instance can verify a code issued by this one, which a `Map` in this
 * process's heap never could.
 *
 * @type {Map<string, { code: string, expires: number, attempts: number }>}
 */
const otpStore = new Map();

/**
 * Emails that have actually completed a challenge, with an expiry. Same
 * fallback-only status as `otpStore` — see `isEmailVerified`.
 *
 * @type {Map<string, number>}
 */
const verifiedEmails = new Map();

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const VERIFIED_TTL_MS = 30 * 60 * 1000;

/**
 * Drop expired entries. Both maps otherwise only shrink when a key happens to
 * be read again, so addresses that are never verified would accumulate for the
 * life of the process. Only reachable on the fallback path.
 */
function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of otpStore) if (now > entry.expires) otpStore.delete(key);
  for (const [key, until] of verifiedEmails) if (now > until) verifiedEmails.delete(key);
}

let warnedNoOtpSalt = false;

/**
 * Is the Postgres-backed OTP path usable for this call? Both a database AND a
 * salt are required. Read per call rather than resolved once at import — same
 * reason `lib/db.js` and `routes/ingest.js`'s `IP_HASH_SALT` are: on serverless
 * the environment belongs to the invocation, and a value frozen at module load
 * is a setting an operator can change without it ever taking effect.
 *
 * With no salt, a six-digit code has a million preimages — an UNSALTED digest
 * in a table is the code wearing a disguise, worse than the in-process store it
 * would replace. That is why this is a hard gate rather than "salt if you have
 * one", mirroring the existing `IP_HASH_SALT` rule for `lead.ip_hash`.
 *
 * The warning fires once per process, not once per call: an operator who wired
 * up Postgres but forgot the salt would otherwise get no signal at all for why
 * a code issued by one instance cannot be verified by another.
 *
 * @returns {boolean}
 */
function otpDbReady() {
  if (!dbConfigured()) return false;
  if (process.env.OTP_HASH_SALT || process.env.IP_HASH_SALT) return true;
  if (!warnedNoOtpSalt) {
    warnedNoOtpSalt = true;
    console.warn(
      "[email] OTP_HASH_SALT (and IP_HASH_SALT) are both unset — DB-backed OTP verification is off. " +
        "Falling back to the in-process store, which does not survive a restart and does not bind " +
        "across instances. Set OTP_HASH_SALT to enable it.",
    );
  }
  return false;
}

/**
 * Hash a code the same way `routes/ingest.js` hashes an IP: salted SHA-256, hex
 * digest, then Postgres's `bytea` hex-input format (`\x…`) so PostgREST's JSON
 * string passes straight through and the cast happens on the parameter's
 * declared type. The email is folded into the hash alongside the code so the
 * same six digits issued to two different addresses never collide in storage.
 *
 * @param {string} email  normalized (lowercased, trimmed)
 * @param {string} code
 * @param {string} salt
 * @returns {string}
 */
function hashOtpCode(email, code, salt) {
  return `\\x${createHash("sha256").update(`${salt}:${email}:${code}`).digest("hex")}`;
}

/** @param {string} code */
function otpEmailHtml(code) {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;text-align:center;">
      <h2 style="margin:0 0 8px 0;color:#111827;">Verification Code</h2>
      <p style="margin:0 0 20px 0;color:#6b7280;font-size:14px;">Enter the code below to verify your email address:</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#4f46e5;background:#f3f4f6;padding:16px;border-radius:12px;display:inline-block;margin-bottom:20px;">${code}</div>
      <p style="margin:0;color:#9ca3af;font-size:12px;">Code expires in 10 minutes. If you did not request this code, please ignore this email.</p>
    </div>
  `;
}

/** @param {string} email */
export async function sendOtpCode(email) {
  if (!email || !EMAIL_RE.test(String(email).trim())) return { ok: false, error: "invalid_email" };
  const normalized = String(email).toLowerCase().trim();

  // Six digits from a CSPRNG. Math.random is predictable from prior outputs,
  // which would let an attacker derive a victim's code instead of guessing it.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  if (otpDbReady()) {
    const salt = process.env.OTP_HASH_SALT || process.env.IP_HASH_SALT || "";
    try {
      await rpc("issue_otp", {
        p_email: normalized,
        p_code_hash: hashOtpCode(normalized, code, salt),
        p_ttl_ms: OTP_TTL_MS,
      });
    } catch (err) {
      // Deliberately NOT falling back to `otpStore` here. `verifyOtpCode` takes
      // the same `otpDbReady()` branch, so a code this call wrote to memory
      // would be unverifiable for as long as the database stays configured —
      // the feature would break silently rather than degrade. Telling the
      // visitor the send failed, so they retry, is the honest answer.
      console.warn(`[email] issue_otp failed (${dbErrorKind(err)}): ${errSummary(err)}`);
      return { ok: false, error: "send_failed" };
    }

    const res = await sendEmail({ to: normalized, subject: `${code} is your email verification code`, html: otpEmailHtml(code) });
    if (!res.ok) {
      // The row `issue_otp` just wrote is now orphaned: a code nobody received.
      // There is no `revoke_otp` function, and `lib/db.js`'s `update()` refuses
      // an unfiltered PATCH, so cleaning it up needs a second filtered write.
      // Chosen instead: leave it. `issue_otp` deletes any live, unconsumed
      // challenge for the address before inserting a new one, so the visitor's
      // very next resend already clears this row for free; left untouched it is
      // otherwise inert within `OTP_TTL_MS`. The cost is one wasted challenge
      // slot for an address that never got a usable code — cheaper than a
      // second round trip on every failed send, and self-healing either way.
      console.warn(`[email] OTP send failed after issue for ${oneLine(normalized, 120)}: ${res.error}`);
      return { ok: false, error: "send_failed" };
    }
    return { ok: true };
  }

  // Fallback: no database, or no salt. Exactly the pre-Postgres behaviour.
  otpStore.set(normalized, { code, expires: Date.now() + OTP_TTL_MS, attempts: 0 });
  sweepExpired();

  const res = await sendEmail({ to: normalized, subject: `${code} is your email verification code`, html: otpEmailHtml(code) });

  // The code is never returned to the caller — not even in development. It
  // previously was, gated on NODE_ENV !== "production", which is the default:
  // any deploy that forgot to set NODE_ENV handed the code to the client.
  if (!res.ok) {
    otpStore.delete(normalized);
    return { ok: false, error: "send_failed" };
  }
  return { ok: true };
}

/**
 * @param {string} email
 * @param {string} code
 * @returns {Promise<boolean>}
 */
export async function verifyOtpCode(email, code) {
  if (!email || !code) return false;
  const normalized = String(email).toLowerCase().trim();

  if (otpDbReady()) {
    const salt = process.env.OTP_HASH_SALT || process.env.IP_HASH_SALT || "";
    try {
      return Boolean(
        await rpc("verify_otp", {
          p_email: normalized,
          p_code_hash: hashOtpCode(normalized, String(code).trim(), salt),
          p_max_attempts: OTP_MAX_ATTEMPTS,
        }),
      );
    } catch (err) {
      // FAIL CLOSED. An unreachable database must read as "not verified", never
      // "verified" — the opposite of `rateLimit`'s fallback, and deliberately
      // so: a false "verified" here writes a lie onto the operator's stored
      // lead, while a false "not verified" only costs the visitor a retry once
      // the database answers again. Also do not fall back to `otpStore`: in DB
      // mode nothing was ever written there, so checking it would only be a
      // slower way to arrive at the same false.
      console.warn(`[email] verify_otp failed (${dbErrorKind(err)}): ${errSummary(err)}`);
      return false;
    }
  }

  // Fallback path, unchanged from the pre-Postgres implementation.
  const stored = otpStore.get(normalized);
  if (!stored) return false;
  if (Date.now() > stored.expires) {
    otpStore.delete(normalized);
    return false;
  }

  // Burn an attempt before comparing. Without this a six-digit code is a
  // million guesses away from free, and nothing stopped a script from making
  // them; five wrong answers now invalidate the code entirely.
  stored.attempts += 1;
  if (stored.attempts > OTP_MAX_ATTEMPTS) {
    otpStore.delete(normalized);
    return false;
  }

  if (safeEqual(stored.code, String(code).trim())) {
    otpStore.delete(normalized);
    verifiedEmails.set(normalized, Date.now() + VERIFIED_TTL_MS);
    return true;
  }
  return false;
}

/**
 * Did this address actually pass a challenge recently?
 *
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export async function isEmailVerified(email) {
  const normalized = String(email || "").toLowerCase().trim();
  if (!normalized) return false;

  if (otpDbReady()) {
    try {
      return Boolean(await rpc("is_email_verified", { p_email: normalized, p_ttl_ms: VERIFIED_TTL_MS }));
    } catch (err) {
      // Same fail-closed rule as `verifyOtpCode` — see the comment there.
      console.warn(`[email] is_email_verified failed (${dbErrorKind(err)}): ${errSummary(err)}`);
      return false;
    }
  }

  const until = verifiedEmails.get(normalized);
  if (!until) return false;
  if (Date.now() > until) {
    verifiedEmails.delete(normalized);
    return false;
  }
  return true;
}

/* ========================================================================== *
 *  Lead notifications
 * ========================================================================== */

/**
 * Render the operator's "new lead" alert from a lead record.
 *
 * Split out of `processLeadEmailNotifications` because the delivery queue's
 * `email` target sends the same mail to a per-client address — two renderers
 * would drift, and the one that drifts is the one nobody reads until a lead's
 * answers stop showing up in the alert.
 *
 * Everything interpolated here originates with the visitor, so every value is
 * escaped. An unescaped name field would let a lead inject markup into the
 * operator's inbox — a phishing link inside a trusted alert.
 *
 * @param {Record<string, any>} record
 * @returns {{ subject: string, html: string }}
 */
export function leadNotificationEmail(record) {
  const lead = record.lead || {};
  const answers = record.answers || {};
  const funnelId = record.funnelId || "Funnel";
  const leadName = lead.name || lead.first_name || "Lead";
  const leadEmail = lead.email;

  const answersHtml = Object.entries(answers)
    .map(([q, a]) => `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:600;">${esc(q)}</td><td style="padding:8px;border-bottom:1px solid #eee;">${esc(Array.isArray(a) ? a.join(", ") : a)}</td></tr>`)
    .join("");

  const utmHtml = Object.entries(record.utm || record)
    .filter(([k]) => k.startsWith("utm_") || k === "gclid" || k === "fbclid" || k === "ttclid" || k === "ref")
    .map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`)
    .join("");

  const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <h2 style="margin:0;color:#111827;font-size:22px;">🚀 New Lead Captured</h2>
            <span style="padding:4px 10px;background:#e0e7ff;color:#3730a3;border-radius:999px;font-size:12px;font-weight:600;">${esc(funnelId)}</span>
          </div>
          <div style="background:#f9fafb;padding:16px;border-radius:12px;margin-bottom:20px;">
            <p style="margin:0 0 6px 0;font-size:16px;font-weight:600;color:#111827;">Contact Details:</p>
            <p style="margin:2px 0;color:#374151;">👤 <b>Name:</b> ${esc(leadName)}</p>
            <p style="margin:2px 0;color:#374151;">✉️ <b>Email:</b> <a href="mailto:${encodeURIComponent(String(leadEmail || ""))}">${esc(leadEmail || "N/A")}</a></p>
            ${lead.phone ? `<p style="margin:2px 0;color:#374151;">📞 <b>Phone:</b> ${esc(lead.phone)}</p>` : ""}
          </div>
          <h3 style="color:#111827;font-size:16px;margin-bottom:10px;">Quiz Responses</h3>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
            ${answersHtml || '<tr><td style="padding:8px;color:#6b7280;">No quiz choices answered</td></tr>'}
          </table>
          ${utmHtml ? `<div style="background:#f3f4f6;padding:12px;border-radius:8px;font-size:13px;"><p style="margin:0 0 6px 0;font-weight:600;">Ad & Attribution Tracking:</p><ul style="margin:0;padding-left:18px;">${utmHtml}</ul></div>` : ""}
        </div>
      `;

  return { subject: oneLine(`🚀 New Lead: ${leadName} (${funnelId})`), html };
}

/**
 * Where this funnel's lead alert goes.
 *
 * ONE resolver, shared by both delivery paths: the fan-out calls it per lead and
 * `lib/targets.js` calls it when deriving the queue's `email` target. They had
 * come apart in the first version of WO12a — the funnel-level address was read
 * only when deriving a target, so a self-hoster with no Supabase (where
 * `fanOut` is unconditionally true) set the field in the console and kept
 * mailing the global address forever, and a Postgres install did the same for
 * every lead that degraded to the fan-out.
 *
 * `notifyEnabled` is the master switch and gates both: the funnel field
 * overrides the ADDRESS, not the operator's decision to receive alerts at all.
 * An override that is not a valid address resolves to nothing rather than
 * falling back — falling back would send a client's leads to the operator's own
 * inbox because of a typo, which is the failure that looks like it worked.
 *
 * @param {any} funnel  The unredacted funnel document, or null.
 * @param {{ notifyEnabled?: boolean, notifyEmail?: string }} cfg
 * @returns {string} empty when no alert should be sent.
 */
export function notifyEmailFor(funnel, cfg) {
  if (cfg?.notifyEnabled === false) return "";
  const own = String(funnel?.integrations?.notifyEmail || "").trim();
  if (own) return EMAIL_RE.test(own) ? own : "";
  return String(cfg?.notifyEmail || "").trim();
}

/**
 * Did this funnel ask for its own alert address and not get one?
 *
 * Exported for the same reason `notifyEmailFor` is: `lib/targets.js` warns about
 * the identical situation when it derives no `email` target, and two
 * independently written copies of this condition would eventually warn about
 * different funnels. The two log lines differ, the decision does not.
 *
 * @param {any} funnel
 * @param {{ notifyEnabled?: boolean }} cfg
 * @param {string} to  What `notifyEmailFor` resolved to.
 */
export function hasUnusableNotifyOverride(funnel, cfg, to) {
  if (to || cfg?.notifyEnabled === false) return false;
  return Boolean(String(funnel?.integrations?.notifyEmail || "").trim());
}

/**
 * Warned once per funnel, and the set is capped because `funnelId` arrives on a
 * public endpoint.
 *
 * @type {Set<string>}
 */
const badNotifyOverrideWarned = new Set();

/** @param {any} funnel @param {{ notifyEnabled?: boolean }} cfg @param {string} to */
function warnUnusableNotifyOverride(funnel, cfg, to) {
  if (!hasUnusableNotifyOverride(funnel, cfg, to)) return;
  const key = oneLine(funnel?.slug || funnel?.id || "?", 80);
  if (badNotifyOverrideWarned.has(key)) return;
  if (badNotifyOverrideWarned.size > 200) badNotifyOverrideWarned.clear();
  badNotifyOverrideWarned.add(key);
  console.warn(
    `[email] funnel "${key}" sets an unusable integrations.notifyEmail — no lead alert is being sent ` +
      "for it. Fix the address or clear the field to fall back to the global one.",
  );
}

/**
 * Mail the operator that a lead arrived.
 *
 * The fan-out's half of what the queue's `email` target does durably. It runs
 * only when the queue did NOT take the lead — `persist({ fanOut })` decides —
 * because both at once is the operator receiving every lead twice.
 *
 * @param {Record<string, any>} record
 * @param {any} [funnel]  The funnel document, resolved once by `persist()`.
 */
export async function notifyOperatorOfLead(record, funnel = null) {
  try {
    const cfg = await getEmailSettings();
    const to = notifyEmailFor(funnel, cfg);
    if (!to) {
      warnUnusableNotifyOverride(funnel, cfg, to);
      return;
    }

    // The notification goes to a fixed operator address, so it is not a relay —
    // but it is still outbound mail on the operator's quota, driven by a public
    // endpoint, and README claims the hourly ceiling covers all outbound mail.
    // Its own bucket, so a burst of alerts cannot exhaust the OTP budget.
    if (!(await rateLimit("notify-global", MAIL_HOURLY_CAP, 60 * 60 * 1000))) {
      console.warn("[email] lead-notification hourly ceiling reached — see MAIL_MAX_PER_HOUR");
      return;
    }
    const { subject, html } = leadNotificationEmail(record);
    await sendEmail({ to, subject, html });
  } catch (err) {
    console.warn(`[runtime] Lead notification error: ${errSummary(err)}`);
  }
}

/* ========================================================================== *
 *  Dead-letter alerts
 * ========================================================================== */

/**
 * How many dead-letter alerts may leave per hour. An outage that dead-letters
 * continuously would otherwise mail on every cron tick, forever.
 *
 * Read per call, like every other operational knob in this file.
 */
const deadLetterMaxPerHour = () => Math.max(1, Number(process.env.DEAD_LETTER_MAX_PER_HOUR) || 10);

/**
 * Ceiling on the alert's own send — deliberately tighter than `EMAIL_TIMEOUT_MS`.
 *
 * This runs after a drain pass, inside an invocation `pg_net` abandons at 55s,
 * and `routes/internal.js` documents the worst case as a SUM of the timeouts on
 * that path. Review caught that the first version quietly added
 * `EMAIL_TIMEOUT_MS` (10s) plus a `rate_hit` round trip (`DB_TIMEOUT_MS`, 5s) to
 * a total already accounted at 43s — 58s, past the window, so a drain that had
 * in fact delivered would be recorded as a timeout. Five seconds keeps the sum
 * at 53s. A provider slower than that costs one alert, never a delivery, and the
 * `console.error` per dead row is still there.
 */
const alertTimeoutMs = () => Math.max(1000, Number(process.env.ALERT_TIMEOUT_MS) || 5000);

/**
 * Shortest gap between two alerts from THIS process.
 *
 * `routes/internal.js` can call `drainOnce` several times in one request, and
 * during the outage this feature exists for every pass produces dead rows — so
 * without this, one invocation pays the alert's cost once per pass. The hourly
 * `rate_hit` ceiling is the real bound and binds across instances; this one is
 * the cheap in-process guard that stops the expensive round trip from being made
 * at all. Per process by design: it is a cost bound, not a correctness one.
 *
 * Read per call like every other knob here, which is also what lets a test file
 * set it to 0 rather than have its second assertion silently suppressed by its
 * first.
 */
const alertMinGapMs = () => {
  const raw = Number(process.env.ALERT_MIN_GAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
};
let lastDeadLetterAlertAt = 0;

/**
 * @typedef {object} DeadDelivery
 * @property {number|string} id
 * @property {string} kind
 * @property {string} funnelSlug
 * @property {number} attempts
 * @property {string} error
 */

/**
 * Render the alert. Every value is escaped: the funnel slug and the error text
 * both originate outside this process, and `last_error` in particular is
 * `errSummary()` output derived from a remote server's response.
 *
 * What is deliberately NOT in here: the target's `config`, which holds the
 * webhook secret, and the target URL, which routinely carries a token in its
 * path. An alert mail is a copy of whatever it names leaving the server
 * permanently — the id is enough to find the row in the console.
 *
 * @param {DeadDelivery[]} dead
 */
function deadLetterEmail(dead) {
  const rows = dead
    .map(
      (d) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #eee;">#${esc(d.id)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;">${esc(d.kind)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;">${esc(d.funnelSlug)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;">${esc(d.attempts)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #eee;color:#b91c1c;">${esc(d.error)}</td></tr>`,
    )
    .join("");

  const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;">
          <h2 style="margin:0 0 8px 0;color:#b91c1c;font-size:22px;">⚠️ Lead delivery gave up</h2>
          <p style="margin:0 0 20px 0;color:#374151;font-size:14px;">
            ${dead.length === 1 ? "One delivery has" : `${esc(dead.length)} deliveries have`} exhausted every retry.
            The lead is stored — it was not delivered. Re-send from the Delivery view in the console once the cause is fixed.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr style="text-align:left;color:#6b7280;">
              <th style="padding:8px;">Delivery</th><th style="padding:8px;">Kind</th>
              <th style="padding:8px;">Funnel</th><th style="padding:8px;">Attempts</th><th style="padding:8px;">Last error</th>
            </tr>
            ${rows}
          </table>
        </div>
      `;

  return {
    subject: oneLine(
      dead.length === 1
        ? `⚠️ Lead delivery failed permanently (${dead[0]?.funnelSlug})`
        : `⚠️ ${dead.length} lead deliveries failed permanently`,
    ),
    html,
  };
}

/**
 * Tell the operator that deliveries have died.
 *
 * ONE MESSAGE PER DRAIN PASS, not one per row — `drainOnce` collects them and
 * calls this once after its loop. Alerting inside `settle` would put an awaited
 * mail send on the delivery path, so a batch of dead rows would cost
 * `EMAIL_TIMEOUT_MS` each inside a drain that `pg_net` abandons at 55s, and
 * would tell the operator about one outage twenty-five times.
 *
 * Two deliberate departures from `notifyOperatorOfLead`:
 *
 *  - **The global address only, never `notifyEmailFor`.** That resolver can
 *    answer with a CLIENT's address from `integrations.notifyEmail`, and a dead
 *    delivery is the operator's infrastructure failing rather than a lead. It
 *    must not be mailed to the client whose leads are the thing being lost.
 *  - **Not gated on `notifyEnabled`.** That switch means "I do not want an email
 *    for every lead". An operator who delivers by webhook and turned lead alerts
 *    off is exactly the one who would otherwise never learn the webhook has been
 *    dead since Tuesday.
 *
 * Never throws: the caller is a drain pass whose counts must still be returned.
 *
 * @param {DeadDelivery[]} dead
 */
export async function alertDeadLetters(dead) {
  try {
    if (!dead?.length) return;
    const cfg = await getEmailSettings();
    const to = String(cfg.notifyEmail || "").trim();
    if (!to) return; // Nobody to tell. The `console.error` per row is what is left.

    // Checked before the rate limiter, because the point of it is to skip the
    // round trip the rate limiter costs. See `alertMinGapMs`.
    if (Date.now() - lastDeadLetterAlertAt < alertMinGapMs()) return;
    lastDeadLetterAlertAt = Date.now();

    // Its own bucket, so a burst of alerts cannot exhaust the lead-alert budget:
    // the alert is not more important than the leads still getting through. This
    // path only ever runs with a database configured (there is no queue without
    // one), so the ceiling is the Postgres-backed `rate_hit` and binds across
    // instances rather than per invocation.
    if (!(await rateLimit("dead-letter-alert", deadLetterMaxPerHour(), 60 * 60 * 1000))) {
      console.warn(
        `[email] dead-letter alert suppressed by its hourly ceiling (${dead.length} dead) — see DEAD_LETTER_MAX_PER_HOUR`,
      );
      return;
    }

    const { subject, html } = deadLetterEmail(dead);
    const res = await sendEmail({ to, subject, html, signal: AbortSignal.timeout(alertTimeoutMs()) });
    if (!res.ok) console.warn(`[email] dead-letter alert could not be sent: ${res.error}`);
  } catch (err) {
    console.warn(`[email] dead-letter alert error: ${errSummary(err)}`);
  }
}

/**
 * Thank the visitor for submitting.
 *
 * Deliberately NOT tied to `fanOut`, and deliberately not a delivery target.
 * This is a courtesy mail to the person who filled the form in — it is
 * configured once per install rather than per destination, it has never been
 * retried, and losing it loses nobody's lead. Making it a third target kind
 * would mean the queue owning a mail whose recipient comes from the request
 * body; leaving it in the `fanOut` branch would have taken it silently dark the
 * moment the first delivery target existed.
 *
 * @param {Record<string, any>} record
 */
export async function sendLeadAutoresponder(record) {
  try {
    const cfg = await getEmailSettings();
    const lead = record.lead || {};
    const leadName = lead.name || lead.first_name || "Lead";
    const leadEmail = lead.email;

    if (cfg.autoresponderEnabled && leadEmail && EMAIL_RE.test(String(leadEmail).trim())) {
      // The autoresponder mails whoever the lead payload names, and /api/lead is
      // public by necessity. Cap it per recipient so the funnel cannot be driven
      // as a spam cannon against a third party from the operator's domain.
      const recipient = String(leadEmail).toLowerCase().trim();
      if (!(await rateLimit(`autoresponder:${recipient}`, 3, 60 * 60 * 1000))) {
        console.warn(`[email] autoresponder rate limit hit for ${oneLine(recipient, 120)}`);
        return;
      }
      // Per-recipient is not a ceiling: the attacker picks the recipients, so an
      // unbounded number of addresses each get their 3. Same open-relay shape as
      // /api/otp/send, so the same absolute cap applies — mail leaving the
      // operator's domain is bounded by something the caller cannot rotate.
      if (!(await rateLimit("autoresponder-global", MAIL_HOURLY_CAP, 60 * 60 * 1000))) {
        console.warn("[email] autoresponder hourly ceiling reached — see MAIL_MAX_PER_HOUR");
        return;
      }

      const bodyText = String(cfg.autoresponderBody).replace(/\{\{name\}\}/g, String(leadName));
      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;">
          <h2 style="margin:0 0 16px 0;color:#111827;">${esc(cfg.autoresponderSubject)}</h2>
          <div style="color:#374151;font-size:15px;line-height:1.6;white-space:pre-wrap;">${esc(bodyText)}</div>
        </div>
      `;
      await sendEmail({
        to: recipient,
        subject: oneLine(cfg.autoresponderSubject),
        html,
        text: bodyText,
      });
    }
  } catch (err) {
    console.warn(`[runtime] Lead autoresponder error: ${errSummary(err)}`);
  }
}
