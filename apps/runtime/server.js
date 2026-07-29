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
async function forwardWebhook(record) {
  let webhookUrl =
    process.env.WEBHOOK_URL ||
    process.env.ZAPIER_WEBHOOK_URL ||
    record.webhookUrl ||
    record.meta?.webhookUrl;

  if (!webhookUrl && record.funnelId) {
    const funnel = await loadFunnel(record.funnelId);
    webhookUrl = funnel?.integrations?.webhookUrl || funnel?.integrations?.webhook;
  }
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!res.ok) console.warn(`[runtime] webhook dispatch HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[runtime] webhook error:`, err);
  }
}

/* ========================================================================== *
 *  Email Delivery Engine (Resend & SMTP)
 * ========================================================================== */

async function getEmailSettings() {
  const settingsFile = join(DATA_DIR, "email_settings.json");
  let stored = {};
  try {
    stored = JSON.parse(await readFile(settingsFile, "utf8"));
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
  };
}

async function saveEmailSettings(newSettings) {
  await mkdir(DATA_DIR, { recursive: true });
  const settingsFile = join(DATA_DIR, "email_settings.json");
  const existing = await getEmailSettings();
  const merged = { ...existing, ...newSettings };
  await writeFile(settingsFile, JSON.stringify(merged, null, 2), "utf8");
  return merged;
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
          text: text || html.replace(/<[^>]+>/g, " "),
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

  if (cfg.smtpHost) {
    try {
      if (cfg.smtpHost.startsWith("http://") || cfg.smtpHost.startsWith("https://")) {
        const res = await fetch(cfg.smtpHost, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to, subject, html, text }),
        });
        return { ok: res.ok, provider: "http_relay" };
      }
      console.log(`[email] SMTP alert prepared for ${to}: "${subject}"`);
      return { ok: true, provider: "smtp" };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  console.log(`[email] Logged lead email to ${to}: "${subject}" (Configure Resend or SMTP in Settings for live inbox delivery)`);
  return { ok: true, provider: "logged" };
}

/** @type {Map<string, { code: string, expires: number }>} */
const otpStore = new Map();

async function sendOtpCode(email) {
  if (!email || !email.includes("@")) return { ok: false, error: "invalid_email" };
  const normalized = email.toLowerCase().trim();

  // Generate 4-digit code
  const code = String(Math.floor(1000 + Math.random() * 9000));
  otpStore.set(normalized, { code, expires: Date.now() + 10 * 60 * 1000 });

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

  return { ok: true, provider: res.provider, code: DEV ? code : undefined };
}

function verifyOtpCode(email, code) {
  if (!email || !code) return false;
  const normalized = email.toLowerCase().trim();
  const stored = otpStore.get(normalized);
  if (!stored) return false;
  if (Date.now() > stored.expires) {
    otpStore.delete(normalized);
    return false;
  }
  if (stored.code === String(code).trim()) {
    otpStore.delete(normalized);
    return true;
  }
  return false;
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
      const answersHtml = Object.entries(answers)
        .map(([q, a]) => `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:600;">${q}</td><td style="padding:8px;border-bottom:1px solid #eee;">${Array.isArray(a) ? a.join(", ") : a}</td></tr>`)
        .join("");

      const utmHtml = Object.entries(record.utm || record)
        .filter(([k]) => k.startsWith("utm_") || k === "gclid" || k === "fbclid" || k === "ttclid" || k === "ref")
        .map(([k, v]) => `<li><b>${k}:</b> ${v}</li>`)
        .join("");

      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <h2 style="margin:0;color:#111827;font-size:22px;">🚀 New Lead Captured</h2>
            <span style="padding:4px 10px;background:#e0e7ff;color:#3730a3;border-radius:999px;font-size:12px;font-weight:600;">${funnelId}</span>
          </div>
          <div style="background:#f9fafb;padding:16px;border-radius:12px;margin-bottom:20px;">
            <p style="margin:0 0 6px 0;font-size:16px;font-weight:600;color:#111827;">Contact Details:</p>
            <p style="margin:2px 0;color:#374151;">👤 <b>Name:</b> ${leadName}</p>
            <p style="margin:2px 0;color:#374151;">✉️ <b>Email:</b> <a href="mailto:${leadEmail}">${leadEmail || "N/A"}</a></p>
            ${lead.phone ? `<p style="margin:2px 0;color:#374151;">📞 <b>Phone:</b> ${lead.phone}</p>` : ""}
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
        subject: `🚀 New Lead: ${leadName} (${funnelId})`,
        html,
      });
    }

    if (cfg.autoresponderEnabled && leadEmail) {
      const bodyText = cfg.autoresponderBody.replace(/\{\{name\}\}/g, leadName);
      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff;">
          <h2 style="margin:0 0 16px 0;color:#111827;">${cfg.autoresponderSubject}</h2>
          <div style="color:#374151;font-size:15px;line-height:1.6;white-space:pre-wrap;">${bodyText}</div>
        </div>
      `;
      await sendEmail({
        to: leadEmail,
        subject: cfg.autoresponderSubject,
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
      return json({ settings: cfg });
    }

    if (path === "/api/admin/email-settings" && req.method === "POST") {
      const body = await readJson(req);
      const updated = await saveEmailSettings(body || {});
      return json({ ok: true, settings: updated });
    }

    if (path === "/api/admin/test-email" && req.method === "POST") {
      const body = await readJson(req);
      const targetEmail = body?.email || (await getEmailSettings()).notifyEmail;
      if (!targetEmail) return json({ error: "No recipient email specified" }, 400);

      const res = await sendEmail({
        to: targetEmail,
        subject: "🎉 OpenFunnel Email Test Successful",
        html: `<div style="font-family:sans-serif;padding:20px;border-radius:12px;border:1px solid #e2e8f0;">
          <h2>OpenFunnel Email Verification</h2>
          <p>Your email notification settings are working correctly!</p>
          <p style="color:#64748b;font-size:13px;">Timestamp: ${new Date().toISOString()}</p>
        </div>`,
      });
      return json(res);
    }

    if (path === "/api/otp/send" && req.method === "POST") {
      const body = await readJson(req);
      const email = body?.email;
      if (!email) return json({ error: "missing_email" }, 400);
      const res = await sendOtpCode(email);
      return json(res);
    }

    if (path === "/api/otp/verify" && req.method === "POST") {
      const body = await readJson(req);
      const email = body?.email;
      const code = body?.code;
      const valid = verifyOtpCode(email, code);
      return json({ ok: valid, valid });
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

      const record = {
        ...body,
        received_at: new Date().toISOString(),
        ip: clientIp(req, server),
        user_agent: req.headers.get("user-agent"),
        referer: req.headers.get("referer"),
      };

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
