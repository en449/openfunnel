/**
 * @file Reading funnel documents off disk, and the cache in front of that.
 *
 * `examples/` (or whatever `FUNNELS_DIR` points at) is the funnel database: one
 * JSON document per funnel, listed by reading the directory. That is why adding
 * a funnel needs no registration step, and why every path that touches the
 * directory has to validate a slug before joining it.
 *
 * The cache is invalidated through `invalidateFunnel`/`cacheFunnel` rather than
 * by exporting the Map, so the builder's write routes cannot leave it holding a
 * document that no longer matches the file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEV, FUNNELS_DIR, SLUG_RE, isInside } from "./config.js";

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
export async function loadFunnel(slug) {
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
export async function listFunnels() {
  try {
    const files = await readdir(FUNNELS_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/** Drop a slug from the cache after a write or delete. */
export function invalidateFunnel(slug) {
  cache.delete(slug);
}

/** Seed the cache with a document just written to disk. */
export function cacheFunnel(slug, funnel) {
  cache.set(slug, { funnel, at: Date.now() });
}

/* ========================================================================== *
 *  Redaction
 * ========================================================================== */

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
// `leadEndpoint` stays, but only as a SAME-ORIGIN PATH — see `sameOriginPath`.
const SERVER_ONLY_INTEGRATIONS = [
  "webhookUrl",
  "webhook",
  "webhookSecret",
  "apiKey",
  "aiKey",
  "openaiKey",
  "resendApiKey",
  "smtpPass",
  "smtpUser",
  "smtpHost",
  "secret",
  "secretToken",
];

/** Stand-in origin: this server has no fixed public URL to resolve against. */
const RELATIVE_BASE = "https://openfunnel.invalid";

/**
 * Is this a path on this server, rather than somewhere else entirely?
 *
 * Resolved through the URL parser, not pattern-matched. A `startsWith("/")` test
 * that also rejects `//` and `/\` looks complete and is not: the parser strips
 * every ASCII tab, newline and carriage return from anywhere in the input before
 * resolving, so `"/\t/evil.tld/collect"` — one JSON escape — passes all three
 * string tests and still resolves to `https://evil.tld/collect` in the browser
 * that eventually fetches it. Asking the parser what the string becomes is the
 * only check that cannot disagree with the thing doing the fetching.
 *
 * The leading-slash test stays as well, so a URL that happens to name the
 * sentinel host cannot pass as a path.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function sameOriginPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  try {
    return new URL(value, RELATIVE_BASE).origin === RELATIVE_BASE;
  } catch {
    return false;
  }
}

/** @param {any} funnel @returns {any} a copy safe to hand to a browser. */
export function publicFunnel(funnel) {
  if (!funnel) return funnel;
  const clean = { ...funnel };
  delete clean.apiKey;
  delete clean.aiKey;
  delete clean.openaiKey;
  delete clean.secret;
  delete clean.secretToken;
  if (clean.integrations) {
    const integrations = { ...clean.integrations };
    for (const key of SERVER_ONLY_INTEGRATIONS) delete integrations[key];

    // A cross-origin `leadEndpoint` is lead exfiltration wearing a config field.
    // The engine prefers `integrations.leadEndpoint` over the endpoint the page
    // supplies, the field was deliberately left in the public copy, and
    // `funnelCsp` used to widen `connect-src` to whatever origin it named — so
    // all three layers stepped aside for one string in an imported document.
    // Every lead then goes to that origin instead: the operator's inbox reads
    // zero, the server logs nothing, and the funnel looks healthy.
    //
    // Posting to your own backend is still supported — as a path on this server,
    // which is what the field is documented to be. Anything else is dropped and
    // named in the log, because a silently ignored setting is its own bug report.
    if (integrations.leadEndpoint != null && !sameOriginPath(integrations.leadEndpoint)) {
      console.warn(
        `[runtime] funnel "${clean.slug || clean.id || "?"}" sets a non-path integrations.leadEndpoint — ` +
          "ignoring it. Lead capture must post to a path on this server; a full URL here would send " +
          "every lead to that origin. Use a webhook (server-side, env or funnel document) to forward leads.",
      );
      delete integrations.leadEndpoint;
    }

    clean.integrations = integrations;
  }
  return clean;
}
