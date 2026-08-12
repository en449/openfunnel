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
 * Direct SMTP is NOT implemented. `RESEND_API_KEY` and `SMTP_RELAY_URL` are the
 * two working transports; `sendEmail` reports `ok: false` when only `SMTP_*` is
 * configured rather than claiming a success that did not happen.
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

/** Secrets are never echoed back; the console sees only whether they are set. */
const SECRET_EMAIL_KEYS = ["resendApiKey", "smtpPass"];

export async function getEmailSettings() {
  const settingsFile = join(dataDir(), "email_settings.json");
  let stored = {};
  try {
    const parsed = JSON.parse(await readFile(settingsFile, "utf8"));
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {}

  return {
    provider: stored.provider || process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? "resend" : process.env.SMTP_HOST ? "smtp" : "none"),
    resendApiKey: stored.resendApiKey || process.env.RESEND_API_KEY || "",
    resendFrom: stored.resendFrom || process.env.RESEND_FROM || "OpenFunnel Leads <leads@openfunnel.dev>",
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
}

/** Strip secrets before the settings ever leave the process. */
export function redactEmailSettings(cfg) {
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
 */
export async function saveEmailSettings(patch) {
  const existing = await getEmailSettings();
  const next = { ...existing };

  // `getEmailSettings()` resolves secrets from the environment when nothing is
  // stored, so writing that merge straight back would copy RESEND_API_KEY /
  // SMTP_PASS out of the env and into DATA_DIR in plaintext on the first save —
  // and the stored copy then shadows the env var, so rotating the real secret
  // silently stops taking effect. Drop any secret that came from the env; only a
  // value the operator actually typed into this request gets persisted below.
  for (const key of SECRET_EMAIL_KEYS) {
    const fromEnv = key === "resendApiKey" ? process.env.RESEND_API_KEY : process.env.SMTP_PASS;
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
      if (["resend", "smtp", "none"].includes(value)) next[key] = value;
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

  if (cfg.provider === "resend" || (cfg.resendApiKey && cfg.provider !== "smtp")) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.resendFrom || "OpenFunnel Leads <leads@openfunnel.dev>",
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          text: text || String(html || "").replace(/<[^>]+>/g, " "),
        }),
        signal: abort,
      });
      if (res.ok) return { ok: true, provider: "resend" };
      const errText = await res.text();
      console.warn("[email] Resend error:", res.status, errText);
      return { ok: false, error: `resend_${res.status}` };
    } catch (err) {
      console.warn(`[email] Resend exception: ${errSummary(err)}`);
      return { ok: false, error: "resend_failed" };
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
        `Set RESEND_API_KEY, or SMTP_RELAY_URL pointing at an HTTP-to-SMTP relay.`,
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
