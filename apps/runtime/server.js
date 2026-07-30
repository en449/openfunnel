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
import { extname, join, normalize, resolve, sep } from "node:path";
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

/**
 * Is `target` the root directory itself, or genuinely inside it?
 *
 * A bare `target.startsWith(root)` is the usual way to write this and it is
 * subtly wrong: with a root of `…/apps/app`, the sibling `…/apps/app-legacy`
 * also passes, so `/_app/..%2fapp-legacy/secret` would escape. No such sibling
 * exists today, which makes this a latent bug rather than a live one — the point
 * is that creating one must not silently open a hole. Requiring the separator
 * closes the whole class.
 *
 * The `..` still has to arrive percent-encoded to get this far: the WHATWG URL
 * parser resolves literal (and `%2e`-encoded) dot segments before routing, but
 * `%2f` survives to `decodeURIComponent`, so this check is load-bearing, not
 * decoration.
 *
 * @param {string} target  An already-`normalize`d absolute path.
 * @param {string} root    An absolute directory.
 * @returns {boolean}
 */
function isInside(target, root) {
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return target === base || target.startsWith(base + sep);
}

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

/**
 * The only part of a failed outbound request we are willing to log.
 *
 * A `fetch` rejection carries the whole request URL (Bun exposes it as
 * `err.path`), so `console.warn("...", err)` on an outbound call prints any
 * credential that URL contained — a webhook token in the path, an `access_token`
 * query parameter — straight into the server log. Log the code or message only.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errSummary(err) {
  const e = /** @type {{ code?: unknown, message?: unknown } | null | undefined} */ (err);
  return oneLine(e?.code ?? e?.message ?? "unknown error", 200) || "unknown error";
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
  if (!isInside(file, FUNNELS_DIR)) return null; // defence in depth
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
    console.warn(`[runtime] supabase ${table} insert failed: ${errSummary(err)}`);
  }
}

/**
 * Forward a captured lead to a Webhook URL (Zapier, Make, GoHighLevel, HubSpot, CRM).
 *
 * @param {Record<string, unknown>} record
 */
/** Names that resolve to the local machine even though they are not literals. */
const BLOCKED_NAME_RE = /^(localhost|.*\.localhost|.*\.internal|.*\.local|.*\.home\.arpa)$/i;

/**
 * Reserved IPv4 ranges we refuse to POST to, as `[firstOctet, test]` predicates.
 * Deliberately spelled out rather than crammed into one regex — the previous
 * single-regex version silently missed several of these.
 */
function isBlockedIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (parts.some((p) => !/^\d{1,3}$/.test(p)) || [a, b].some((n) => Number.isNaN(n))) return false;
  if (a === 0 || a === 127) return true;                    // this-host, loopback
  if (a === 10) return true;                                // private
  if (a === 169 && b === 254) return true;                  // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;         // private
  if (a === 192 && b === 168) return true;                  // private
  if (a === 100 && b >= 64 && b <= 127) return true;        // RFC 6598 carrier-grade NAT
  return false;
}

/**
 * @param {string} host  An IPv6 literal WITHOUT surrounding brackets, lower-cased.
 */
function isBlockedIpv6(host) {
  if (host === "::1" || host === "::") return true;          // loopback, unspecified
  // IPv4-mapped (`::ffff:127.0.0.1`, which the URL parser rewrites to
  // `::ffff:7f00:1`). No webhook has a legitimate reason to be one, and letting
  // them through was a straight loopback bypass — the old regex missed it.
  if (host.startsWith("::ffff:")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;          // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;          // fe80::/10 link-local
  return false;
}

/**
 * Is this a destination we are willing to POST lead data to?
 *
 * Blocks non-HTTP schemes and anything addressed at the loopback interface, the
 * private ranges, or the cloud metadata endpoint. The URL parser normalises the
 * decimal/hex/octal IPv4 spellings (`http://2130706433/`) before we see them, so
 * those arrive here as plain dotted quads.
 *
 * Still a literal-address check: it does not defeat a hostname that RESOLVES to
 * a private IP (DNS rebinding), which needs resolution-time filtering to close
 * properly. The destination is operator-owned, so that residual gap is a
 * misconfiguration risk rather than something a visitor can reach.
 */
function isSafeWebhookTarget(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;

  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return !isBlockedIpv6(host.slice(1, -1));
  if (BLOCKED_NAME_RE.test(host)) return false;
  return !isBlockedIpv4(host);
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
    // Never log the error object: a fetch failure carries the full request URL
    // on `err.path`, and webhook URLs routinely embed a token in the path, so
    // printing it would copy an operator's credential into the log.
    console.warn(`[runtime] webhook error: ${errSummary(err)}`);
  }
}

/**
 * Builder-preview and admin traffic must never reach analytics — neither the
 * console's own numbers nor an ad platform. Shared by the ingest fan-out and
 * the `/api/admin/*` readers so both agree on what counts as preview.
 *
 * @param {Record<string, any>} r
 * @returns {boolean}
 */
function isPreviewRecord(r) {
  return Boolean(
    r.preview || r.isPreview || r.meta?.preview || r.meta?.isPreview ||
    (r.referer && (r.referer.includes("preview=1") || r.referer.includes("admin=1"))) ||
    (r.meta?.url && (r.meta.url.includes("preview=1") || r.meta.url.includes("admin=1")))
  );
}

/**
 * funnelIds we have already complained about, so a busy funnel logs the
 * "consent not enforced" warning once instead of once per event.
 *
 * @type {Set<string>}
 */
const capiConsentWarned = new Set();

/** @param {unknown} funnelId */
function warnCapiConsentUnenforced(funnelId) {
  const key = oneLine(funnelId, 120);
  if (capiConsentWarned.has(key)) return;
  // `funnelId` is client-supplied on the public ingest route, so cap the set
  // rather than let junk ids grow it without bound.
  if (capiConsentWarned.size > 200) capiConsentWarned.clear();
  capiConsentWarned.add(key);
  const which = key ? `funnelId "${key}"` : "a record with no funnelId";
  console.warn(
    `[runtime] Meta CAPI: no funnel document for ${which} — consent could not be enforced ` +
      `server-side, falling back to the client's signal. Make the funnel's \`id\` match its slug to enforce.`
  );
}

/**
 * Forward a conversion to the Meta Conversions API (server-side pixel).
 *
 * This hands Meta the visitor's IP address and user-agent, so it is the most
 * consequential outbound call the runtime makes: opt-in via `META_PIXEL_ID` +
 * `META_CAPI_TOKEN`, never fired for preview traffic, and gated on consent from
 * the funnel document rather than on the client's word alone.
 *
 * @param {Record<string, any>} record
 */
async function forwardMetaCapi(record) {
  const pixelId = process.env.META_PIXEL_ID || "";
  const capiToken = process.env.META_CAPI_TOKEN || "";
  if (!pixelId || !capiToken) return;
  if (isPreviewRecord(record)) return; // a preview drag-through is not a conversion

  // Honour the visitor's consent decision — but do not let the client define what
  // the decision was by omission. `record.meta.consent` is a client-side
  // assertion, so a missing field cannot mean "permitted": a stripped payload
  // would read exactly like a funnel that has no consent bar. The funnel document
  // is operator-owned and says authoritatively whether the bar is on, so ask it
  // first and fall back to the client signal only when it cannot be resolved.
  const consent = record.meta?.consent;

  /** @type {any} */
  let funnel = null;
  try {
    if (record.funnelId) funnel = await loadFunnel(String(record.funnelId));
  } catch {
    funnel = null; // a lookup problem is a miss, never an ingest failure
  }

  if (funnel?.consent?.enabled) {
    // Enforcement. The funnel asks for consent, so only an explicit grant
    // forwards — "denied", "pending" and absent all mean no.
    if (consent !== "granted") return;
  } else {
    // Either the funnel has no consent bar, or we could not resolve it (a funnel
    // whose `id` is not its slug, or a document since deleted). Keep the
    // pre-consent behaviour and honour whatever the client did send. Deliberately
    // not failing closed: that would silently disable CAPI for those deployments.
    if (!funnel) warnCapiConsentUnenforced(record.funnelId);
    if (consent && consent !== "granted") return;
  }

  const eventName = record.type === "lead" || record.lead ? "Lead" : "PageView";
  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor((new Date(record.received_at || Date.now()).getTime()) / 1000),
        action_source: "website",
        event_id: record.sessionId || undefined,
        user_data: {
          client_ip_address: record.ip || undefined,
          client_user_agent: record.user_agent || undefined,
        },
      },
    ],
  };

  // `access_token` goes in the query string because that is the only form Meta
  // documents for a JSON payload to this endpoint — an `access_token` key inside
  // the JSON body, or an `Authorization: Bearer` header, is unverified here and a
  // silent 400 would disable conversion tracking without anyone noticing.
  //
  // That puts a credential in the URL, so the containment is on the logging side
  // and it is not optional: a fetch rejection carries the full URL on `err.path`,
  // so this must never log the error object. `errSummary()` exists for exactly
  // this, and the non-ok branch logs a bare status. Keep it that way.
  const endpoint = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${encodeURIComponent(capiToken)}`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`[runtime] Meta CAPI dispatch HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[runtime] Meta CAPI error: ${errSummary(err)}`);
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

/**
 * Absolute ceiling on outbound mail per hour, across every caller — shared by
 * the OTP challenge and the lead autoresponder.
 *
 * The per-address and per-IP limits are the everyday guards; this one exists
 * because the per-IP key comes from `x-forwarded-for`, which the caller sets.
 * Bounding the total means the worst case is a capped amount of outbound mail
 * rather than an open relay. Generous by default so a real funnel never notices.
 */
const MAIL_HOURLY_CAP = Math.max(1, Number(process.env.MAIL_MAX_PER_HOUR) || 500);
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

async function sendOtpCode(email) {
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

/**
 * Persist a record to every configured sink. Never throws — a failed write must
 * not turn into a 500 that breaks the visitor's funnel.
 *
 * @param {"leads"|"events"} kind
 * @param {Record<string, unknown>} record
 */
async function persist(kind, record) {
  const tasks = [appendJsonl(kind, record), supabaseInsert(kind, record), forwardMetaCapi(record)];
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
/**
 * Server-only fields, stripped before a funnel document reaches a browser.
 *
 * The whole document is inlined into the funnel page, so anything left in
 * `integrations` is readable with View Source by every visitor.
 *
 * `webhookSecret` exists so the receiving automation can prove a delivery came
 * from this server — publishing it would defeat the entire point.
 *
 * `webhookUrl` goes too. A Zapier/Make catch hook is a capability URL: whoever
 * holds it can post fabricated leads straight into the operator's CRM. The
 * server already forwards every lead in `persist()`, so nothing is lost by
 * keeping the endpoint private — and it stops the same lead being delivered
 * twice, once from the browser and once from here.
 */
// `leadEndpoint` deliberately stays: it is a plain path the engine needs in
// order to know where to POST, and it carries no secret.
const SERVER_ONLY_INTEGRATIONS = ["webhookUrl", "webhook", "webhookSecret"];

/** @param {any} funnel @returns {any} a copy safe to hand to a browser. */
function publicFunnel(funnel) {
  if (!funnel?.integrations) return funnel;
  const integrations = { ...funnel.integrations };
  for (const key of SERVER_ONLY_INTEGRATIONS) delete integrations[key];
  return { ...funnel, integrations };
}

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

    <script id="of-funnel" type="application/json">${jsonScript(publicFunnel(funnel))}</script>
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
            // Only this same-origin handshake turns on canvas drag-to-reorder,
            // so a visitor appending ?preview=1 never sees editor chrome.
            isEditor: true,
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
/**
 * Headers for the operator-facing UIs. These pages hold the admin token in
 * localStorage and can drive every privileged API, so they must never be
 * framable: without `DENY`, a page that lures the operator into clicking can
 * overlay an invisible console and borrow their session. Funnel pages
 * deliberately do not get this — being embeddable is the point.
 */
const CONSOLE_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

async function serveStaticFile(rootDir, prefix, pathname) {
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  const target = normalize(join(rootDir, rel));
  if (!isInside(target, rootDir)) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(target);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  return new Response(file, {
    headers: {
      ...CONSOLE_HEADERS,
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
  if (!isInside(target, ENGINE_SRC)) return new Response("Forbidden", { status: 403 });

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

/**
 * Headers every HTML response carries.
 *
 * `nosniff` stops a browser from second-guessing a declared content type, and
 * the referrer policy keeps a funnel URL (which often carries campaign
 * parameters) from leaking in full to whatever a visitor clicks through to.
 *
 * Framing is deliberately NOT blocked here — a funnel is meant to be embedded on
 * the operator's marketing site, and the builder previews one in an iframe. The
 * console gets `DENY` separately below; it is the page holding the admin token,
 * and nothing legitimately frames it.
 */
const BASE_HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const html = (body, status = 200, extra = {}) =>
  new Response(body, {
    status,
    headers: { ...BASE_HTML_HEADERS, ...extra },
  });

/** Ingest endpoints are called cross-origin from embedded funnels. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * The only paths that may be called cross-origin. A funnel is embedded on the
 * operator's own marketing site, so ingest and the email challenge have to work
 * from another origin — nothing else does.
 *
 * Previously every path answered `OPTIONS` with `Allow-Origin: *`, which
 * green-lit the preflight for `/api/builder/*` and `/api/admin/*` too.
 */
const PUBLIC_CORS_PATHS = new Set(["/api/lead", "/api/events", "/api/otp/send", "/api/otp/verify"]);

/**
 * Reject a privileged request that a browser made from another site.
 *
 * Without this the console's own APIs are CSRF-able, and on the documented
 * default (no `ADMIN_TOKEN`, so `requireAdmin` trusts loopback) that is a real
 * takeover: `readJson` ignores `Content-Type`, so any page the operator visits
 * can `fetch("http://127.0.0.1:3000/api/builder/save", …)` as a CORS *simple*
 * request — no preflight to block it — and write a funnel document. The reply is
 * unreadable to the attacker, but the write already happened, and a funnel
 * document renders on the console's own origin where the admin token lives.
 *
 * `Origin` and `Sec-Fetch-Site` are set by the browser and cannot be forged by
 * page script. A non-browser client (curl, CI, a server-side integration) sends
 * neither and is unaffected.
 *
 * @param {Request} req
 * @param {URL} url
 * @returns {boolean} true when the call must be refused.
 */
function isCrossSiteRequest(req, url) {
  const site = req.headers.get("sec-fetch-site");
  // Authoritative whenever the browser sends it (every current browser does),
  // and page script cannot forge it. `none` is a typed URL or a bookmark.
  if (site) return site !== "same-origin" && site !== "none";

  // Legacy fallback for a browser too old to send Sec-Fetch-*. Compare HOST, not
  // the whole origin: a TLS-terminating proxy — which is every PaaS deployment —
  // means the browser sends an `https://` Origin while this process only ever
  // sees `http://` reconstructed from the Host header. Comparing origins would
  // 403 the operator's own console on any real production setup.
  const origin = req.headers.get("origin");
  if (!origin) return false; // curl, CI, server-side integrations
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true; // unparseable Origin is not something to give the benefit of
  }
}

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

// Only listen when this file is the entrypoint. Importing it (the egress-guard
// unit tests do) must not bind a port or print a banner — the handler takes its
// own `server` argument, so nothing inside the router depends on this binding.
const server = import.meta.main ? Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Only the public ingest surface is cross-origin callable. Answering every
    // path with `Allow-Origin: *` would let a preflight succeed for the
    // privileged routes below.
    if (req.method === "OPTIONS") {
      return PUBLIC_CORS_PATHS.has(path)
        ? new Response(null, { status: 204, headers: CORS })
        : new Response(null, { status: 204 });
    }

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
      // Public route: the builder fetches the full document through the
      // authenticated /api/builder surface instead.
      return json(publicFunnel(funnel), 200, {
        "cache-control": DEV ? "no-store" : "public, max-age=60",
      });
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
      // Refuse before authenticating: on a loopback-trust deploy the caller is
      // already "authorised", so the browser-driven CSRF has to be stopped here.
      if (isCrossSiteRequest(req, url)) return json({ error: "cross_site_denied" }, 403);

      const denied = requireAdmin(req, server);
      if (denied) return denied;
    }

    // --- Builder API --------------------------------------------------------

    // The unredacted document, for editing. The public /api/funnels/:slug strips
    // the webhook URL and secret, so the builder has to read them from here —
    // otherwise saving would silently blank out whatever it could not see.
    if (path.startsWith("/api/builder/funnel/") && req.method === "GET") {
      const funnel = await loadFunnel(path.slice("/api/builder/funnel/".length));
      if (!funnel) return json({ error: "not_found" }, 404);
      return json(funnel, 200, { "cache-control": "no-store" });
    }

    if (path === "/api/builder/save" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || !body.slug || !Array.isArray(body.steps)) {
        return json({ error: "invalid_funnel" }, 400);
      }
      const slug = body.slug;
      if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);

      const targetPath = normalize(join(FUNNELS_DIR, `${slug}.json`));
      if (!isInside(targetPath, FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
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
      if (!isInside(targetPath, FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
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

      // Trim the base so the derived slug still fits SLUG_RE's 64-char budget.
      // Without this a long source slug produces a copy that is written to disk
      // and then unloadable, because `loadFunnel` rejects the over-long name.
      const suffix = `-copy-${Date.now().toString(36).slice(-4)}`;
      const newSlug = `${slug.slice(0, 64 - suffix.length)}${suffix}`;
      if (!SLUG_RE.test(newSlug)) return json({ error: "invalid_slug" }, 400);

      const copyDoc = { ...source, id: newSlug, slug: newSlug, name: `${source.name || slug} (Copy)` };
      const targetPath = normalize(join(FUNNELS_DIR, `${newSlug}.json`));
      // Same guard as save/delete. `newSlug` is safe by construction here, but a
      // write path that skips the check is exactly how the next edit regresses.
      if (!isInside(targetPath, FUNNELS_DIR)) return json({ error: "forbidden_path" }, 403);
      await writeFile(targetPath, JSON.stringify(copyDoc, null, 2), "utf8");
      cache.set(newSlug, { funnel: copyDoc, at: Date.now() });
      return json({ ok: true, funnel: copyDoc });
    }

    // --- Admin APIs ---------------------------------------------------------
    // `isPreviewRecord` lives at module scope so the ingest fan-out shares it.

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

      // The per-caller ceiling above is keyed on `clientIp`, which honours
      // `x-forwarded-for` so a proxied deploy attributes traffic correctly — and
      // that header is caller-supplied, so an attacker rotates it and the ceiling
      // never binds. What is actually at stake is outbound mail: this endpoint
      // sends a "Verification Code" message to any address in the request, so an
      // unbounded caller turns the operator's mail domain into an open relay and
      // burns their sending reputation.
      //
      // This cap is global and keyed on nothing the caller controls, so no header
      // rotates past it. It sits after the per-address limits so ordinary traffic
      // never reaches it. Raise it with MAIL_MAX_PER_HOUR on a high-volume funnel.
      if (!rateLimit("otp-send-global", MAIL_HOURLY_CAP, 60 * 60 * 1000)) return tooMany();

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
          console.warn(`[runtime] unverified lead claimed email_verified: ${oneLine(record.lead.email, 120)}`);
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
}) : null;

if (server) {
  console.log(`\n  OpenFunnel runtime → http://localhost:${server.port}`);
  console.log(`  funnels: ${FUNNELS_DIR}`);
  console.log(`  data:    ${DATA_DIR}${SUPABASE_ON ? "  (+ Supabase)" : ""}\n`);
}

/* ========================================================================== *
 *  Exports — for tests only. The server is started above when run directly.
 * ========================================================================== */

export { isSafeWebhookTarget, isInside, isPreviewRecord };
