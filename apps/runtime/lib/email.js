/**
 * @file Mail settings, the transports, the OTP challenge, and the two messages
 * a captured lead triggers.
 *
 * Three things here are security controls, not plumbing:
 *
 *  - `redactEmailSettings` / `WRITABLE_EMAIL_KEYS`. Secrets never travel
 *    outward, writes go through an allowlist, and a blank secret means "keep the
 *    existing value" rather than wiping it.
 *  - `verifiedEmails`. The browser can claim `email_verified` in a lead payload;
 *    only this map decides whether the claim is true.
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
import { randomInt } from "node:crypto";
import { safeEqual } from "./auth.js";
import { DATA_DIR } from "./config.js";
import { esc } from "./html.js";
import { errSummary, oneLine } from "./log.js";
import { MAIL_HOURLY_CAP, rateLimit } from "./ratelimit.js";

/* ========================================================================== *
 *  Settings
 * ========================================================================== */

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
  const settingsFile = join(DATA_DIR, "email_settings.json");
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

  await mkdir(DATA_DIR, { recursive: true });
  const { relayUrl: _ignored, ...persistable } = next;
  await writeFile(join(DATA_DIR, "email_settings.json"), JSON.stringify(persistable, null, 2), "utf8");
  return next;
}

/* ========================================================================== *
 *  Transports
 * ========================================================================== */

export async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, error: "missing_recipient" };
  const cfg = await getEmailSettings();

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
      });
      if (res.ok) return { ok: true, provider: "resend" };
      const errText = await res.text();
      console.warn("[email] Resend error:", res.status, errText);
      return { ok: false, error: `resend_${res.status}` };
    } catch (err) {
      console.warn(`[email] Resend exception: ${errSummary(err)}`);
      return { ok: false, error: String(err) };
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

/** @type {Map<string, { code: string, expires: number, attempts: number }>} */
const otpStore = new Map();

/**
 * Emails that have actually completed a challenge, with an expiry. The browser
 * can claim `email_verified` in a lead payload, but only this map decides
 * whether the claim is true — see `isEmailVerified`.
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
 * life of the process.
 */
function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of otpStore) if (now > entry.expires) otpStore.delete(key);
  for (const [key, until] of verifiedEmails) if (now > until) verifiedEmails.delete(key);
}

export async function sendOtpCode(email) {
  if (!email || !EMAIL_RE.test(String(email).trim())) return { ok: false, error: "invalid_email" };
  const normalized = String(email).toLowerCase().trim();

  // Six digits from a CSPRNG. Math.random is predictable from prior outputs,
  // which would let an attacker derive a victim's code instead of guessing it.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  otpStore.set(normalized, { code, expires: Date.now() + OTP_TTL_MS, attempts: 0 });
  sweepExpired();

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;text-align:center;">
      <h2 style="margin:0 0 8px 0;color:#111827;">Verification Code</h2>
      <p style="margin:0 0 20px 0;color:#6b7280;font-size:14px;">Enter the code below to verify your email address:</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#4f46e5;background:#f3f4f6;padding:16px;border-radius:12px;display:inline-block;margin-bottom:20px;">${code}</div>
      <p style="margin:0;color:#9ca3af;font-size:12px;">Code expires in 10 minutes. If you did not request this code, please ignore this email.</p>
    </div>
  `;

  const res = await sendEmail({
    to: normalized,
    subject: `${code} is your email verification code`,
    html,
  });

  // The code is never returned to the caller — not even in development. It
  // previously was, gated on NODE_ENV !== "production", which is the default:
  // any deploy that forgot to set NODE_ENV handed the code to the client.
  if (!res.ok) {
    otpStore.delete(normalized);
    return { ok: false, error: "send_failed" };
  }
  return { ok: true };
}

export function verifyOtpCode(email, code) {
  if (!email || !code) return false;
  const normalized = String(email).toLowerCase().trim();
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

/** Did this address actually pass a challenge recently? */
export function isEmailVerified(email) {
  const normalized = String(email || "").toLowerCase().trim();
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

export async function processLeadEmailNotifications(record) {
  try {
    const cfg = await getEmailSettings();
    const lead = record.lead || {};
    const answers = record.answers || {};
    const funnelId = record.funnelId || "Funnel";
    const leadName = lead.name || lead.first_name || "Lead";
    const leadEmail = lead.email;

    // The notification goes to a fixed operator address, so it is not a relay —
    // but it is still outbound mail on the operator's quota, driven by a public
    // endpoint, and README claims the hourly ceiling covers all outbound mail.
    // Its own bucket, so a burst of alerts cannot exhaust the OTP budget.
    if (cfg.notifyEnabled && cfg.notifyEmail && !rateLimit("notify-global", MAIL_HOURLY_CAP, 60 * 60 * 1000)) {
      console.warn("[email] lead-notification hourly ceiling reached — see MAIL_MAX_PER_HOUR");
    } else if (cfg.notifyEnabled && cfg.notifyEmail) {
      // Everything below originates with the visitor, so every interpolation
      // is escaped. An unescaped name field would let a lead inject markup
      // into the operator's inbox — a phishing link in a trusted alert.
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

      await sendEmail({
        to: cfg.notifyEmail,
        subject: oneLine(`🚀 New Lead: ${leadName} (${funnelId})`),
        html,
      });
    }

    if (cfg.autoresponderEnabled && leadEmail && EMAIL_RE.test(String(leadEmail).trim())) {
      // The autoresponder mails whoever the lead payload names, and /api/lead is
      // public by necessity. Cap it per recipient so the funnel cannot be driven
      // as a spam cannon against a third party from the operator's domain.
      const recipient = String(leadEmail).toLowerCase().trim();
      if (!rateLimit(`autoresponder:${recipient}`, 3, 60 * 60 * 1000)) {
        console.warn(`[email] autoresponder rate limit hit for ${oneLine(recipient, 120)}`);
        return;
      }
      // Per-recipient is not a ceiling: the attacker picks the recipients, so an
      // unbounded number of addresses each get their 3. Same open-relay shape as
      // /api/otp/send, so the same absolute cap applies — mail leaving the
      // operator's domain is bounded by something the caller cannot rotate.
      if (!rateLimit("autoresponder-global", MAIL_HOURLY_CAP, 60 * 60 * 1000)) {
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
    console.warn(`[runtime] Lead email error: ${errSummary(err)}`);
  }
}
