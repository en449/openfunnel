/**
 * @file OpenFunnel public runtime — the server that actually serves funnels to
 * visitors. Deliberately tiny: one file, zero dependencies beyond Bun itself.
 *
 * WHAT IT DOES
 *   GET  /f/:slug            → the funnel page (HTML shell + engine, no bundler)
 *   GET  /api/funnels/:slug  → the raw funnel JSON
 *   POST /api/lead           → lead capture   (see packages/engine/src/leads.js)
 *   POST /api/events         → analytics ingest
 *   GET  /_of/*              → the engine's ES modules + stylesheet, served raw
 *   GET  /healthz            → liveness probe
 *
 * WHY NO BUILD STEP
 * The engine is zero-dependency ESM, so the browser can import it directly.
 * That keeps the critical path to one HTML document + one CSS file + a handful
 * of small modules — the whole reason a funnel feels instant on a 4G phone.
 * Put a CDN in front of /f/:slug and /_of/* and you are done.
 *
 * STORAGE
 * Funnels are read from a directory of JSON files (FUNNELS_DIR, default the
 * repo's examples/). Leads and events append to newline-delimited JSON under
 * DATA_DIR. If SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, leads/events
 * are also inserted into Supabase tables via PostgREST. Both sinks are
 * best-effort: ingest must never fail a visitor's funnel.
 *
 * Run:  bun run dev   (from apps/runtime)   ·   PORT=3000 bun server.js
 */

import { mkdir, readdir, readFile, writeFile, appendFile, unlink } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { randomInt, timingSafeEqual } from "node:crypto";

/* ========================================================================== *
 *  Config
 * ========================================================================== */

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ENGINE_SRC = join(REPO_ROOT, "packages/engine/src");
const APP_DIR = join(REPO_ROOT, "apps/app");
const BUILDER_DIR = join(REPO_ROOT, "apps/builder");
const ADMIN_DIR = join(REPO_ROOT, "apps/admin");

const PORT = Number(process.env.PORT || 3000);
const FUNNELS_DIR = resolve(process.env.FUNNELS_DIR || join(REPO_ROOT, "examples"));
const DATA_DIR = resolve(process.env.DATA_DIR || join(REPO_ROOT, ".data"));
const DEV = process.env.NODE_ENV !== "production";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ON = Boolean(SUPABASE_URL && SUPABASE_KEY);

/**
 * Shared secret guarding every privileged route (the console's own APIs).
 * When unset the server still refuses privileged requests from anywhere but
 * loopback, so `bun run dev` needs no configuration while a public deploy
 * cannot be driven by a stranger. See `requireAdmin`.
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/** Slugs are user-facing URL segments — keep them boring so path joins are safe. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** Client-side console routes the server must answer with the app shell. */
const APP_ROUTES = new Set([
  "/app",
  "/builder",
  "/admin",
  "/leads",
  "/analytics",
  "/templates",
  "/settings",
]);

/* ========================================================================== *
 *  Access control & abuse limits
 *
 *  Everything the console can do — reading leads, rewriting funnels, changing
 *  mail credentials, sending mail — is privileged. These helpers are the only
 *  thing standing between those routes and the open internet, so they fail
 *  closed: an unrecognised caller is refused rather than allowed.
 * ========================================================================== */

/** Constant-time string compare, so a wrong token leaks no timing signal. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True only for a request that arrived directly on the loopback interface.
 *
 * A forwarded header means the request crossed a proxy, so the socket address
 * belongs to that proxy and says nothing about who is calling. We refuse to
 * infer "local" in that case — otherwise anyone on the internet reaching a
 * reverse-proxied deployment would inherit localhost's privileges.
 */
function isLoopbackRequest(req, server) {
  if (req.headers.get("x-forwarded-for") || req.headers.get("forwarded")) return false;
  const addr = server.requestIP(req)?.address || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Gate a privileged route.
 *
 * With ADMIN_TOKEN set, callers must present it as `Authorization: Bearer …`
 * or `X-Admin-Token`. Without it, only loopback callers pass — so local
 * development needs no setup, but the same binary exposed on a public
 * interface refuses to hand out leads or credentials.
 *
 * @returns {Response|null} null when the caller may proceed.
 */
function requireAdmin(req, server) {
  if (ADMIN_TOKEN) {
    const header = req.headers.get("authorization") || "";
    const provided = header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : req.headers.get("x-admin-token") || "";
    if (safeEqual(provided, ADMIN_TOKEN)) return null;
    return json({ error: "unauthorized" }, 401);
  }
  if (isLoopbackRequest(req, server)) return null;
  return json(
    {
      error: "admin_token_required",
      hint: "This server is reachable off-host. Set ADMIN_TOKEN in the environment and send it as 'Authorization: Bearer <token>'.",
    },
    401,
  );
}

/** @type {Map<string, number[]>} sliding windows keyed by action + subject. */
const rateBuckets = new Map();

/**
 * Fixed-cost sliding-window limiter. In-memory and therefore per-process —
 * enough to stop scripted abuse of the mail and OTP endpoints, not a
 * substitute for an edge rate limit on a multi-instance deploy.
 *
 * @returns {boolean} true when the call is allowed.
 */
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);

  // Opportunistic prune so a long-running server cannot grow this unbounded.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) rateBuckets.delete(k);
    }
  }
  return true;
}

const tooMany = () => json({ error: "rate_limited" }, 429, CORS);

/** Collapse to a single line — a CR/LF in a subject is a header-injection try. */
function oneLine(value, max = 200) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

/* ========================================================================== *
 *  Funnel store
 * ========================================================================== */

/** @type {Map<string, { funnel: any, at: number }>} */
const cache = new Map();
const CACHE_MS = DEV ? 0 : 60_000;

/**
 * Load a funnel document by slug. Cached in production, always fresh in dev so
 * editing a JSON file and hitting reload just works.
 *
 * @param {string} slug
 * @returns {Promise<any|null>}
 */
async function loadFunnel(slug) {
  if (!SLUG_RE.test(slug)) return null;
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.funnel;

  const file = join(FUNNELS_DIR, `${slug}.json`);
  if (!file.startsWith(FUNNELS_DIR)) return null; // defence in depth
  try {
    const funnel = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(funnel?.steps) || funnel.steps.length === 0) {
      console.warn(`[runtime] ${slug}.json has no steps — ignoring.`);
      return null;
    }
    funnel.slug ||= slug;
    cache.set(slug, { funnel, at: Date.now() });
    return funnel;
  } catch {
    return null;
  }
}

/** @returns {Promise<string[]>} Every published slug, for the dev index page. */
async function listFunnels() {
  try {
    const files = await readdir(FUNNELS_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/* ========================================================================== *
 *  Ingest sinks
 * ========================================================================== */

/**
 * Append one record to a JSONL file. Local-first storage: readable with `tail`,
 * importable anywhere, and impossible to lose to a bad migration.
 *
 * @param {"leads"|"events"} kind
 * @param {Record<string, unknown>} record
 */
async function appendJsonl(kind, record) {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(join(DATA_DIR, `${kind}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Best-effort insert into a Supabase table via PostgREST. Skipped entirely when
 * the service-role key is absent, so self-hosters get file storage for free.
 *
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
async function supabaseInsert(table, row) {
  if (!SUPABASE_ON) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${SUPABASE_KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.warn(`[runtime] supabase ${table} insert ${res.status}`);
  } catch (err) {
    console.warn(`[runtime] supabase ${table} insert failed:`, err);
  }
}

/**
 * Forward a captured lead to a Webhook URL (Zapier, Make, GoHighLevel, HubSpot, CRM).
 *
 * @param {Record<string, unknown>} record
 */
/** Hosts a webhook must never resolve to — cloud metadata and the local network. */
const BLOCKED_HOST_RE =
  /^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|.*\.internal$|.*\.local$)/i;

/**
 * Is this a destination we are willing to POST lead data to?
 *
 * Blocks non-HTTP schemes and anything addressed at the loopback interface,
 * the private ranges, or the cloud metadata endpoint. This is a literal-address
 * check: it does not defeat a hostname that resolves to a private IP (DNS
 * rebinding), which needs resolution-time filtering to close properly.
 */
function isSafeWebhookTarget(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return !BLOCKED_HOST_RE.test(url.hostname);
}

async function forwardWebhook(record) {
  // Deliberately NOT read from the record. /api/lead is public, so honouring a
  // webhookUrl from the request body let any caller aim the server at a host of
  // their choosing — both an open redirector for lead data and an SSRF probe
  // against whatever the server can reach. The destination is operator-owned:
  // the environment, or the funnel document (written through the admin API).
  let webhookUrl = process.env.WEBHOOK_URL || process.env.ZAPIER_WEBHOOK_URL || "";
  let webhookSecret = process.env.WEBHOOK_SECRET || "";

  if (record.funnelId) {
    const funnel = await loadFunnel(record.funnelId);
    if (!webhookUrl) {
      webhookUrl = funnel?.integrations?.webhookUrl || funnel?.integrations?.webhook || "";
    }
    webhookSecret ||= funnel?.integrations?.webhookSecret || "";
  }
  if (!webhookUrl) return;

  if (!isSafeWebhookTarget(webhookUrl)) {
    console.warn(`[runtime] refusing webhook to blocked target: ${webhookUrl}`);
    return;
  }

  try {
    /** @type {Record<string,string>} */
    const headers = { "content-type": "application/json" };
    // The console advertises this header, so send it: it lets the receiving
    // automation prove the delivery came from this server.
    if (webhookSecret) headers["x-webhook-secret"] = oneLine(webhookSecret, 512);

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(record),
      redirect: "manual", // a 302 would sidestep the target check above
    });
    if (!res.ok) console.warn(`[runtime] webhook dispatch HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[runtime] webhook error:`, err);
  }
}

/* ========================================================================== *
 *  Email Delivery Engine (Resend & SMTP)
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

async function getEmailSettings() {
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
function redactEmailSettings(cfg) {
  const safe = { ...cfg };
  for (const key of SECRET_EMAIL_KEYS) {
    safe[`${key}Set`] = Boolean(safe[key]);
    delete safe[key];
  }
  delete safe.relayUrl;
  return safe;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Merge a validated subset of `patch` into the stored settings.
 * Unknown keys are dropped, blank secrets keep the existing value (so the
 * redacted GET can be round-tripped without wiping the key), and every field
 * is range-checked before it reaches disk.
 */
async function saveEmailSettings(patch) {
  const existing = await getEmailSettings();
  const next = { ...existing };

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

async function sendEmail({ to, subject, html, text }) {
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
      console.warn("[email] Resend exception:", err);
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
      console.warn("[email] relay error:", err);
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

async function sendOtpCode(email) {
  if (!email || !EMAIL_RE.test(String(email).trim())) return { ok: false, error: "invalid_email" };
  const normalized = String(email).toLowerCase().trim();

  // Six digits from a CSPRNG. Math.random is predictable from prior outputs,
  // which would let an attacker derive a victim's code instead of guessing it.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  otpStore.set(normalized, { code, expires: Date.now() + OTP_TTL_MS, attempts: 0 });

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

function verifyOtpCode(email, code) {
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
function isEmailVerified(email) {
  const normalized = String(email || "").toLowerCase().trim();
  const until = verifiedEmails.get(normalized);
  if (!until) return false;
  if (Date.now() > until) {
    verifiedEmails.delete(normalized);
    return false;
  }
  return true;
}

async function processLeadEmailNotifications(record) {
  try {
    const cfg = await getEmailSettings();
    const lead = record.lead || {};
    const answers = record.answers || {};
    const funnelId = record.funnelId || "Funnel";
    const leadName = lead.name || lead.first_name || "Lead";
    const leadEmail = lead.email;

    if (cfg.notifyEnabled && cfg.notifyEmail) {
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
        console.warn(`[email] autoresponder rate limit hit for ${recipient}`);
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
    console.warn("[runtime] Lead email error:", err);
  }
}

/**
 * Persist a record to every configured sink. Never throws — a failed write must
 * not turn into a 500 that breaks the visitor's funnel.
 *
 * @param {"leads"|"events"} kind
 * @param {Record<string, unknown>} record
 */
async function persist(kind, record) {
  const tasks = [appendJsonl(kind, record), supabaseInsert(kind, record)];
  if (kind === "leads") {
    tasks.push(forwardWebhook(record));
    tasks.push(processLeadEmailNotifications(record));
  }
  await Promise.allSettled(tasks);
}

/* ========================================================================== *
 *  HTML shell
 * ========================================================================== */

/** Escape a string for safe interpolation into HTML text/attributes. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serialise JSON for embedding in a <script> tag. Escaping `<` is what stops a
 * funnel's own copy from being able to close the script element.
 */
function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Inline the funnel's theme as CSS custom properties on <html>. The engine
 * re-applies these on mount; doing it server-side too means the very first
 * paint is already branded — no white flash, no layout shift.
 */
function themeVars(theme = {}) {
  const map = {
    "--of-primary": theme.primary,
    "--of-primary-text": theme.primaryText,
    "--of-bg": theme.bg,
    "--of-surface": theme.surface,
    "--of-text": theme.text,
    "--of-muted": theme.muted,
    "--of-border": theme.border,
    "--of-radius": theme.radius,
    "--of-font": theme.font,
  };
  return Object.entries(map)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([k, v]) => `${k}:${String(v).replace(/[<>"]/g, "")}`)
    .join(";");
}

/**
 * Render the funnel page. One document, one stylesheet, one module — the entire
 * funnel config ships inline so there is no second round trip before first paint.
 *
 * @param {any} funnel
 */
function funnelPage(funnel) {
  const first = funnel.steps[0] || {};
  const title = funnel.name || first.headline || "Get started";
  const description = first.subtext || "";
  const dark = funnel.theme?.mode === "dark";

  return `<!doctype html>
<html lang="${esc(funnel.lang || "en")}" style="${esc(themeVars(funnel.theme))}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="${dark ? "dark" : "light"}" />
    <meta name="robots" content="noindex" />
    <title>${esc(title)}</title>
    ${description ? `<meta name="description" content="${esc(description)}" />` : ""}
    <meta property="og:title" content="${esc(title)}" />
    ${description ? `<meta property="og:description" content="${esc(description)}" />` : ""}
    <link rel="preload" as="script" href="/_of/index.js" crossorigin />
    <link rel="stylesheet" href="/_of/styles.css" />
    <style>body{margin:0;background:var(--of-bg,#eef1f6)}</style>
  </head>
  <body>
    <main class="of-stage"><div id="app" class="of-root"></div></main>

    <script id="of-funnel" type="application/json">${jsonScript(funnel)}</script>
    <script type="module">
      import { createFunnel } from "/_of/index.js";
      const mount = document.getElementById("app");
      const funnel = JSON.parse(document.getElementById("of-funnel").textContent);
      const isPreview = Boolean(
        window.parent !== window ||
        window.self !== window.top ||
        location.search.includes("preview=1") ||
        location.search.includes("admin=1")
      );
      let live = createFunnel(mount, funnel, {
        isPreview: isPreview,
        trackEvents: !isPreview,
        eventEndpoint: "/api/events",
        leadEndpoint: "/api/lead",
      });

      // Embedded in the builder: re-mount from the working document the builder
      // posts in, so an unsaved edit is visible immediately. Reloading the page
      // would only ever show what is already on disk.
      if (window.parent !== window) {
        addEventListener("message", (e) => {
          if (e.origin !== location.origin || e.data?.type !== "of:preview") return;
          try {
            live.destroy();
          } catch {}
          mount.innerHTML = "";
          live = createFunnel(mount, e.data.funnel, {
            isPreview: true,
            trackEvents: false,
            resume: false,
          });
        });
        parent.postMessage({ type: "of:preview-ready" }, location.origin);
      }
    </script>

    <noscript>
      <p style="font:16px/1.5 system-ui;padding:24px;text-align:center">
        This experience needs JavaScript enabled.
      </p>
    </noscript>
  </body>
</html>`;
}

async function readJsonlRecords(filename) {
  try {
    const file = join(DATA_DIR, filename);
    const content = await readFile(file, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/* ========================================================================== *
 *  Static engine assets
 * ========================================================================== */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve a file out of one of the app directories (the console, and the two
 * legacy standalone UIs). `pathname` is trusted only after it normalises back
 * inside `rootDir` — the same defence the funnel loader uses for slugs.
 *
 * @param {string} rootDir  directory the file must live in
 * @param {string} prefix   URL prefix to strip, e.g. "/_app/"
 * @param {string} pathname requested path
 */
async function serveStaticFile(rootDir, prefix, pathname) {
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  const target = normalize(join(rootDir, rel));
  if (!target.startsWith(rootDir)) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(target);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  return new Response(file, {
    headers: {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      // The console ships with the server, so it is only cached in production.
      "cache-control": DEV ? "no-store" : "public, max-age=3600",
    },
  });
}

/**
 * Serve a file out of packages/engine/src under /_of/*. The engine imports its
 * siblings with relative specifiers, so mirroring the directory 1:1 is all the
 * "bundling" a browser needs.
 *
 * @param {string} pathname
 */
async function serveEngine(pathname) {
  const rel = decodeURIComponent(pathname.slice("/_of/".length));
  const target = normalize(join(ENGINE_SRC, rel));
  if (!target.startsWith(ENGINE_SRC)) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(target);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  return new Response(file, {
    headers: {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      // Engine source is versioned with the deploy; cache hard in production.
      "cache-control": DEV ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

/* ========================================================================== *
 *  Helpers
 * ========================================================================== */

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

/** Ingest endpoints are called cross-origin from embedded funnels. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/** Body size guard — these endpoints take small JSON, never uploads. */
const MAX_BODY = 64 * 1024;

/**
 * Parse a JSON request body with a hard size cap.
 * @returns {Promise<any|null>} null when the body is missing, oversized, or invalid.
 */
async function readJson(req) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY) return null;
  try {
    const text = await req.text();
    if (!text || text.length > MAX_BODY) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Client IP, trusting the proxy header a CDN/ingress sets. */
function clientIp(req, server) {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return server.requestIP(req)?.address || null;
}

/* ========================================================================== *
 *  Router
 * ========================================================================== */

const server = Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // --- Health -------------------------------------------------------------
    if (path === "/healthz") return json({ ok: true, supabase: SUPABASE_ON });

    // --- Engine & SaaS App Assets -------------------------------------------
    if (path.startsWith("/_of/")) return serveEngine(path);

    // --- Unified SaaS Application (Dashboard, Visual Builder, Leads CRM, Analytics)
    // Every console view is a client-side route, so each one has to survive a
    // hard refresh or a pasted link — they all resolve to the same shell.
    if (path === "/" || APP_ROUTES.has(path) || path.startsWith("/_app/")) {
      return serveStaticFile(APP_DIR, "/_app/", path.startsWith("/_app/") ? path : "/_app/index.html");
    }

    if (path.startsWith("/_builder/")) {
      return serveStaticFile(BUILDER_DIR, "/_builder/", path);
    }

    if (path.startsWith("/_admin/")) {
      return serveStaticFile(ADMIN_DIR, "/_admin/", path);
    }

    // --- Mobile Funnel Pages ------------------------------------------------

    if (path.startsWith("/f/")) {
      const funnel = await loadFunnel(path.slice(3));
      if (!funnel) return html("<h1>404 — funnel not found</h1>", 404);
      return html(funnelPage(funnel));
    }

    // The console's funnel switcher and dashboard read this instead of holding a
    // hardcoded list — drop a JSON file in FUNNELS_DIR and it shows up.
    if (path === "/api/funnels") {
      const slugs = await listFunnels();
      const funnels = [];
      for (const slug of slugs) {
        const funnel = await loadFunnel(slug);
        if (!funnel) continue;
        funnels.push({
          slug,
          name: funnel.name || slug,
          primary: funnel.theme?.primary || null,
          mode: funnel.theme?.mode || "light",
          steps: funnel.steps.length,
        });
      }
      return json({ funnels });
    }

    if (path.startsWith("/api/funnels/")) {
      const funnel = await loadFunnel(path.slice("/api/funnels/".length));
      if (!funnel) return json({ error: "not_found" }, 404);
      return json(funnel, 200, { "cache-control": DEV ? "no-store" : "public, max-age=60" });
    }

    // --- Privileged surface -------------------------------------------------
    // Every console-only route sits behind one gate rather than each remembering
    // to check for itself, so a new /api/admin/* or /api/builder/* endpoint is
    // protected the moment it exists. Everything above this line is public:
    // funnel pages, the engine assets, and the two ingest endpoints.
    if (
      path.startsWith("/api/admin/") ||
      path.startsWith("/api/builder/") ||
      path.startsWith("/api/ai/")
    ) {
      const denied = requireAdmin(req, server);
      if (denied) return denied;
    }

    // --- Builder API --------------------------------------------------------
    if (path === "/api/builder/save" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || !body.slug || !Array.isArray(body.steps)) {
        return json({ error: "invalid_funnel" }, 400);
      }
      const slug = body.slug;
      if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);

      const targetPath = normalize(join(FUNNELS_DIR, `${slug}.json`));
      if (!targetPath.startsWith(FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
      await mkdir(FUNNELS_DIR, { recursive: true });
      await writeFile(targetPath, JSON.stringify(body, null, 2), "utf8");
      cache.delete(slug);
      return json({ ok: true, slug });
    }

    if (path === "/api/builder/delete" && req.method === "POST") {
      const body = await readJson(req);
      const slug = body?.slug;
      if (!slug || !SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);
      const targetPath = normalize(join(FUNNELS_DIR, `${slug}.json`));
      if (!targetPath.startsWith(FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
      try {
        await unlink(targetPath);
      } catch {}
      cache.delete(slug);
      return json({ ok: true, slug });
    }

    if (path === "/api/builder/duplicate" && req.method === "POST") {
      const body = await readJson(req);
      const slug = body?.slug;
      if (!slug || !SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);
      const source = await loadFunnel(slug);
      if (!source) return json({ error: "not_found" }, 404);

      const newSlug = `${slug}-copy-${Date.now().toString(36).slice(-4)}`;
      const copyDoc = { ...source, id: newSlug, slug: newSlug, name: `${source.name || slug} (Copy)` };
      const targetPath = normalize(join(FUNNELS_DIR, `${newSlug}.json`));
      await writeFile(targetPath, JSON.stringify(copyDoc, null, 2), "utf8");
      cache.set(newSlug, { funnel: copyDoc, at: Date.now() });
      return json({ ok: true, funnel: copyDoc });
    }

    // --- Admin APIs ---------------------------------------------------------
    const isPreviewRecord = (r) => Boolean(
      r.preview || r.isPreview || r.meta?.preview || r.meta?.isPreview ||
      (r.referer && (r.referer.includes("preview=1") || r.referer.includes("admin=1"))) ||
      (r.meta?.url && (r.meta.url.includes("preview=1") || r.meta.url.includes("admin=1")))
    );

    if (path === "/api/admin/leads" && req.method === "GET") {
      const records = (await readJsonlRecords("leads.jsonl")).filter((l) => !isPreviewRecord(l));
      return json({ leads: records.reverse() });
    }

    if (path === "/api/admin/stats" && req.method === "GET") {
      const scope = url.searchParams.get("funnel") || "";
      const allEvents = (await readJsonlRecords("events.jsonl")).filter((ev) => !isPreviewRecord(ev));
      const allLeads = (await readJsonlRecords("leads.jsonl")).filter((l) => !isPreviewRecord(l));

      const events = scope ? allEvents.filter((ev) => ev.funnelId === scope) : allEvents;
      const leads = scope ? allLeads.filter((l) => l.funnelId === scope) : allLeads;

      let starts = 0;
      let stepViews = 0;
      let completes = 0;

      // Drop-off is only honest per *visitor*, so each step counts distinct
      // sessions — a visitor tapping back and forth must not inflate a step.
      const sessions = new Set();
      /** @type {Map<string, { order: number, sessions: Set<string> }>} */
      const perStep = new Map();

      events.forEach((ev, i) => {
        if (ev.type === "funnel_start") starts++;
        if (ev.type === "step_view") stepViews++;
        if (ev.type === "complete") completes++;
        if (ev.sessionId) sessions.add(ev.sessionId);

        if (ev.type !== "step_view" || !ev.stepId) return;
        let entry = perStep.get(ev.stepId);
        if (!entry) {
          entry = { order: typeof ev.stepIndex === "number" ? ev.stepIndex : i, sessions: new Set() };
          perStep.set(ev.stepId, entry);
        }
        entry.sessions.add(ev.sessionId || `anon-${i}`);
      });

      const steps = [...perStep.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([stepId, entry]) => ({ stepId, sessions: entry.sessions.size }));

      // Per-funnel rollup always spans every funnel so the dashboard can label
      // each card even while a single funnel is in scope.
      /** @type {Record<string, { starts: number, leads: number, completes: number }>} */
      const perFunnel = {};
      const bucket = (id) => (perFunnel[id] ||= { starts: 0, leads: 0, completes: 0 });
      allEvents.forEach((ev) => {
        if (!ev.funnelId) return;
        if (ev.type === "funnel_start") bucket(ev.funnelId).starts++;
        if (ev.type === "complete") bucket(ev.funnelId).completes++;
      });
      allLeads.forEach((l) => {
        if (l.funnelId) bucket(l.funnelId).leads++;
      });

      return json({
        starts,
        stepViews,
        leads: leads.length,
        completes,
        sessions: sessions.size,
        steps,
        perFunnel,
      });
    }

    if (path === "/api/admin/email-settings" && req.method === "GET") {
      const cfg = await getEmailSettings();
      return json({ settings: redactEmailSettings(cfg) });
    }

    if (path === "/api/admin/email-settings" && req.method === "POST") {
      const body = await readJson(req);
      const updated = await saveEmailSettings(body || {});
      return json({ ok: true, settings: redactEmailSettings(updated) });
    }

    if (path === "/api/admin/test-email" && req.method === "POST") {
      const body = await readJson(req);
      const targetEmail = String(body?.email || (await getEmailSettings()).notifyEmail || "").trim();
      if (!targetEmail) return json({ error: "No recipient email specified" }, 400);
      if (!EMAIL_RE.test(targetEmail)) return json({ error: "invalid_email" }, 400);
      // Authenticated, but still capped: a leaked token should not turn the
      // operator's mail domain into a spam source.
      if (!rateLimit(`test-email:${clientIp(req, server) || "unknown"}`, 10, 60 * 60 * 1000)) return tooMany();

      const res = await sendEmail({
        to: targetEmail,
        subject: "🎉 OpenFunnel Email Test Successful",
        html: `<div style="font-family:sans-serif;padding:20px;border-radius:12px;border:1px solid #e2e8f0;">
          <h2>OpenFunnel Email Verification</h2>
          <p>Your email notification settings are working correctly!</p>
          <p style="color:#64748b;font-size:13px;">Timestamp: ${esc(new Date().toISOString())}</p>
        </div>`,
      });
      return json(res);
    }

    // OTP endpoints are public — a visitor mid-funnel has no credentials. They
    // are instead bounded on every axis: per address, per caller, and by the
    // attempt cap inside verifyOtpCode.
    if (path === "/api/otp/send" && req.method === "POST") {
      const body = await readJson(req);
      const email = String(body?.email || "").trim().toLowerCase();
      if (!email) return json({ error: "missing_email" }, 400, CORS);
      if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400, CORS);

      const ip = clientIp(req, server) || "unknown";
      // One code per address per minute, a handful per hour, and a ceiling per
      // caller so one host cannot mail every address it can think of.
      if (!rateLimit(`otp-send:${email}`, 1, 60 * 1000)) return tooMany();
      if (!rateLimit(`otp-send-hourly:${email}`, 5, 60 * 60 * 1000)) return tooMany();
      if (!rateLimit(`otp-send-ip:${ip}`, 20, 60 * 60 * 1000)) return tooMany();

      const res = await sendOtpCode(email);
      return json(res, res.ok ? 200 : 502, CORS);
    }

    if (path === "/api/otp/verify" && req.method === "POST") {
      const body = await readJson(req);
      const email = String(body?.email || "").trim().toLowerCase();
      const code = body?.code;
      const ip = clientIp(req, server) || "unknown";
      if (!rateLimit(`otp-verify:${ip}`, 30, 10 * 60 * 1000)) return tooMany();

      const valid = verifyOtpCode(email, code);
      return json({ ok: valid, valid }, 200, CORS);
    }

    // --- AI Funnel Copilot API ----------------------------------------------
    if (path === "/api/ai/generate" && req.method === "POST") {
      const body = await readJson(req);
      const prompt = body?.prompt || "fitness lead gen";
      const apiKey = body?.apiKey || process.env.OPENAI_API_KEY || "";

      if (apiKey && apiKey.startsWith("sk-")) {
        try {
          const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "authorization": `Bearer ${apiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: body?.model || "gpt-4o",
              messages: [
                { role: "system", content: "You are an expert sales funnel copywriter. Output valid OpenFunnel JSON with steps array." },
                { role: "user", content: `Create an interactive quiz funnel for: ${prompt}` }
              ]
            })
          });
          if (aiRes.ok) {
            const data = await aiRes.json();
            const text = data.choices?.[0]?.message?.content || "";
            const match = text.match(/\{[\s\S]*\}/);
            if (match) return json({ funnel: JSON.parse(match[0]) });
          }
        } catch {}
      }

      // Built-in intelligent funnel generator fallback
      const slug = `ai-${prompt.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 20)}-${Date.now().toString(36)}`;
      const generatedFunnel = {
        id: slug,
        slug: slug,
        name: `AI: ${prompt.slice(0, 25)}`,
        theme: { primary: "#2563eb", mode: "light", radius: "18px" },
        steps: [
          {
            id: "q1",
            type: "choice",
            headline: `What is your primary goal regarding ${prompt}?`,
            subtext: "Select your main focus area to begin.",
            options: [
              { id: "o1", label: "Fastest Results & Growth ⚡", icon: "🚀" },
              { id: "o2", label: "Long-term Sustainable Plan 📈", icon: "🎯" },
              { id: "o3", label: "Expert Guidance & Support 🤝", icon: "💎" }
            ]
          },
          {
            id: "q2",
            type: "choice",
            headline: "What is your biggest obstacle right now?",
            options: [
              { id: "b1", label: "Lack of Time / Schedule ⏳" },
              { id: "b2", label: "Clear Execution Strategy 🗺️" },
              { id: "b3", label: "Accountability & Tracking 📊" }
            ]
          },
          {
            id: "analyzing",
            type: "loader",
            headline: "Analyzing your responses...",
            subtext: "Customizing your personalized recommendation...",
            durationMs: 2500
          },
          {
            id: "contact",
            type: "form",
            headline: "Your customized plan is ready!",
            subtext: "Enter your contact details to receive full access.",
            fields: [
              { name: "name", type: "text", label: "First Name", required: true },
              { name: "email", type: "email", label: "Email Address", required: true },
              { name: "phone", type: "tel", label: "Phone (Optional)" }
            ]
          },
          {
            id: "success",
            type: "success",
            headline: "You're all set, {{name}}! 🎉",
            subtext: "Check your inbox for your custom report."
          }
        ]
      };

      return json({ funnel: generatedFunnel });
    }

    if (path === "/api/ai/improve-copy" && req.method === "POST") {
      const body = await readJson(req);
      const headline = String(body?.headline || "").trim();
      if (!headline) return json({ hooks: [] });

      // Offline reframings only. This fallback never invents a claim the
      // operator has not made — no guarantees, no timeframes, no rankings.
      const core = headline.replace(/[?.!]+$/, "");
      const lower = core.charAt(0).toLowerCase() + core.slice(1);
      const stripped = lower.replace(/^(what|which|how|where|why|when|who)\s+/i, "");

      const hooks = [
        /\?$/.test(headline) ? `First things first — ${lower}?` : `${core}?`,
        `Let's start with ${stripped}.`,
        `Tell us about ${stripped} and we'll take it from there.`,
      ];

      return json({ hooks: [...new Set(hooks)].filter((h) => h && h !== headline).slice(0, 3) });
    }

    // --- Ingest -------------------------------------------------------------
    if (path === "/api/lead" || path === "/api/events") {
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, CORS);

      const body = await readJson(req);
      if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400, CORS);

      const referer = req.headers.get("referer") || "";
      if (body.preview || body.meta?.preview || referer.includes("preview=1")) {
        return json({ ok: true, preview: true }, 202, CORS);
      }

      const ip = clientIp(req, server);
      // Public endpoints: bound them so a script cannot flood the JSONL sink,
      // the webhook, and the autoresponder in a loop.
      if (!rateLimit(`ingest:${ip || "unknown"}`, path === "/api/lead" ? 30 : 300, 60 * 1000)) {
        return tooMany();
      }

      const record = {
        ...body,
        received_at: new Date().toISOString(),
        ip,
        user_agent: req.headers.get("user-agent"),
        referer: req.headers.get("referer"),
      };

      // `email_verified` arrives from the browser, which the visitor controls.
      // Re-derive it from the server's own record of who passed a challenge so
      // the stored lead reflects what actually happened, not what was claimed.
      if (path === "/api/lead" && record.lead && typeof record.lead === "object") {
        const claimed = Boolean(record.lead.email_verified);
        const actual = claimed && isEmailVerified(record.lead.email);
        record.lead = { ...record.lead, email_verified: actual };
        if (claimed && !actual) {
          console.warn(`[runtime] unverified lead claimed email_verified: ${record.lead.email}`);
        }
      }

      // Respond immediately; the visitor is mid-funnel and must not wait on I/O.
      void persist(path === "/api/lead" ? "leads" : "events", record);
      return json({ ok: true }, 202, CORS);
    }

    return new Response("Not found", { status: 404 });
  },

  error(err) {
    console.error("[runtime] unhandled:", err);
    return json({ error: "internal" }, 500);
  },
});

console.log(`\n  OpenFunnel runtime → http://localhost:${server.port}`);
console.log(`  funnels: ${FUNNELS_DIR}`);
console.log(`  data:    ${DATA_DIR}${SUPABASE_ON ? "  (+ Supabase)" : ""}\n`);
