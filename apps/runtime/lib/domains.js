/**
 * @file Custom domains — which funnel a hostname serves, if any.
 *
 * Design: PHASE-2-PLAN.md §2. One question, asked on every request:
 * `funnelHostSlug(host)` → a slug, or null for "this is the console host".
 *
 * WHY THE ANSWER DECIDES MORE THAN A ROUTE
 * The console, the builder, the privileged API and the funnel pages all ship in
 * one handler. A client's domain pointed at this project therefore serves the
 * operator's console too — same origin, so the CSRF check passes, and the only
 * thing left holding `/api/admin/*` shut is `ADMIN_TOKEN`. So a mapped host is
 * not "a nicer URL for /f/:slug"; it is a different server, and `handler.js`
 * treats it as one. This module is only the lookup.
 *
 * `HOST` MUST REACH THIS PROCESS UNMODIFIED
 * Behind a reverse proxy that rewrites it — nginx `proxy_pass` without
 * `proxy_set_header Host $host;` is the common default — this module sees the
 * proxy's hostname, never the client's. Two things then break silently: a
 * mapping written for the real public hostname never matches, so that hostname
 * keeps serving the CONSOLE, which is the exact failure this feature exists to
 * prevent; and the lockout guard in `routes/admin.js` compares against the
 * rewritten name and stops protecting anything. There is no header to fall back
 * to: `x-forwarded-host` is caller-supplied too, and trusting it would let
 * anyone claim any mapping with one header. So the requirement is on the
 * deployment, and it is stated in README.md next to the variable.
 *
 * THE HOST HEADER IS ATTACKER-CONTROLLED
 * Every lookup here is an exact match against a stored string after
 * normalisation. Never a suffix test, never a pattern: `endsWith(".client.de")`
 * is satisfied by `evil.client.de.attacker.tld`, and a host that matches the
 * wrong funnel is a client's page served under someone else's brand. The
 * normalisation itself only ever removes things (case, port, one trailing dot)
 * — it can turn a valid host into a miss, never into a different hit.
 *
 * NO DATABASE IS NOT AN ERROR
 * `FUNNEL_DOMAINS` covers the self-hoster, same as everywhere else in this
 * runtime: Supabase is opt-in and the database-less path is maintained. The env
 * mapping is also what the tests use, since it needs no fixture.
 */

import { DEV, SLUG_RE } from "./config.js";
import { dbConfigured, select } from "./db.js";
import { errSummary } from "./log.js";

/** Same shape as the funnel cache: fresh in dev, 60s in production. */
const CACHE_MS = DEV ? 0 : 60_000;

/**
 * The whole mapping, with each entry's ORIGIN kept alongside its slug — the
 * console needs it (an env mapping has no row to delete) and nothing else does.
 *
 * @type {{ at: number, map: Map<string, { slug: string, source: "env"|"db" }> } | null}
 */
let cached = null;

/** A hostname, for the exact-match lookup. Deliberately conservative. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Lowercase, drop the port, drop one trailing dot.
 *
 * `Host` arrives as the client wrote it: `Client-Firma.DE:443`, or
 * `client-firma.de.` — the fully-qualified form with the root label, which is
 * legal, resolves identically and would otherwise miss the table. An IPv6
 * literal (`[::1]:3000`) has colons inside brackets, so the port is stripped
 * only from the tail and only when what follows the colon is digits.
 *
 * Returns "" for anything that does not look like a hostname, which the callers
 * treat as "not a funnel host" — the console host is the default, and a request
 * with a junk `Host` gets the ordinary server rather than a special case.
 *
 * @param {string|null|undefined} host
 * @returns {string}
 */
export function normalizeHost(host) {
  const raw = String(host || "").trim();
  // Refused before parsing, because the parser would helpfully split them off
  // and hand back a hostname the caller never sent: `evil.test/../x` parses to
  // `evil.test` with a path. A `Host` carrying any of these is malformed, and
  // the honest answer to a malformed host is "not a funnel host".
  if (!raw || /[/?#\s@]/.test(raw)) return "";

  let hostname;
  try {
    // Parsed, not pattern-matched — the rule CLAUDE.md states for every other
    // URL check in this repo, and it is what makes an internationalised domain
    // work: the WHATWG parser applies IDNA, so `kaufhaus-münchen.de` and its
    // `xn--` form normalise to the SAME string. A lowercase-and-strip written by
    // hand does not, so an operator typing the unicode form into the console
    // would store a row that no browser's `Host` header could ever match.
    hostname = new URL(`http://${raw}`).hostname;
  } catch {
    return "";
  }

  // The fully-qualified trailing dot is legal, resolves identically, and would
  // otherwise miss the table.
  const clean = hostname.replace(/\.$/, "");
  return HOST_RE.test(clean) ? clean : "";
}

/**
 * The env mapping: `FUNNEL_DOMAINS="angebot.client.de=client-slug,x.de=other"`.
 *
 * Read per call rather than once at import, like the other per-invocation env
 * readers in this runtime — on serverless the environment belongs to the
 * invocation, and the tests set it between cases.
 *
 * @returns {Map<string, { slug: string, source: "env"|"db" }>}
 */
function envDomains() {
  const map = new Map();
  for (const entry of String(process.env.FUNNEL_DOMAINS || "").split(",")) {
    const [host, slug] = entry.split("=");
    const cleanHost = normalizeHost(host);
    const cleanSlug = String(slug || "").trim();
    // A malformed entry is skipped and named. Silence here would mean a client
    // domain that quietly serves the console instead of their funnel, which is
    // the failure this whole feature exists to prevent.
    if (!entry.trim()) continue;
    if (!cleanHost || !SLUG_RE.test(cleanSlug)) {
      console.warn(`[domains] ignoring unusable FUNNEL_DOMAINS entry: ${entry.trim().slice(0, 80)}`);
      continue;
    }
    map.set(cleanHost, { slug: cleanSlug, source: /** @type {"env"} */ ("env") });
  }
  return map;
}

/**
 * Every mapping, env first and then the table.
 *
 * The table wins on a conflict: the env var is the self-hoster's static
 * configuration and the table is what the console writes, so an operator who
 * remaps a domain in the UI should not be silently overruled by a variable set
 * once at deploy time. A conflict is warned about, because the two disagreeing
 * is a configuration mistake either way.
 *
 * @returns {Promise<Map<string, { slug: string, source: "env"|"db" }>>}
 */
async function loadDomains() {
  const map = envDomains();
  if (!dbConfigured()) return map;

  try {
    const rows = await select("domain", "select=host,slug&order=host.asc");
    for (const row of rows) {
      const host = normalizeHost(row?.host);
      const slug = String(row?.slug || "").trim();
      if (!host || !SLUG_RE.test(slug)) continue;
      const fromEnv = map.get(host);
      if (fromEnv && fromEnv.slug !== slug) {
        console.warn(`[domains] ${host} is mapped to "${fromEnv.slug}" in FUNNEL_DOMAINS and "${slug}" in the database — using the database`);
      }
      map.set(host, { slug, source: /** @type {"db"} */ ("db") });
    }
  } catch (err) {
    // Degrade to the env mapping rather than to "everything is the console
    // host": a database blip must not publish the console on every client
    // domain at once. It also must not fail the request — the console host
    // itself has to keep working while Postgres is unreachable.
    console.warn(`[domains] table unavailable, falling back to FUNNEL_DOMAINS: ${errSummary(err)}`);
  }
  return map;
}

/**
 * The funnel a hostname serves, or null when it is the console host.
 *
 * Cached whole rather than per host: the map is small (one row per client
 * domain), every request asks this exactly once, and a per-host cache would
 * make a miss cost a round trip on every request to the console host.
 *
 * @param {string|null|undefined} host  The raw `Host` header.
 * @returns {Promise<string|null>}
 */
export async function funnelHostSlug(host) {
  const clean = normalizeHost(host);
  if (!clean) return null;

  if (!cached || Date.now() - cached.at >= CACHE_MS) {
    cached = { at: Date.now(), map: await loadDomains() };
  }
  return cached.map.get(clean)?.slug || null;
}

/**
 * Drop the cache — called after the console writes a mapping.
 *
 * It clears THIS process, and on serverless that is one instance of several: a
 * warm instance that did not serve the write keeps its map for up to
 * `CACHE_MS`. So a newly mapped host can still be served the console for a
 * minute, and an unmapped one its funnel. Accepted rather than solved, because
 * the clock that actually governs a custom domain is DNS propagation plus
 * Vercel's certificate issuance — minutes, not seconds — and the alternative is
 * a database round trip on every request to every host. If that ever stops
 * being true, the fix is a short-TTL lookup per host, not a longer cache.
 */
export function invalidateDomains() {
  cached = null;
}

/**
 * Every mapping, for the console's Domains view, each carrying WHERE IT CAME
 * FROM.
 *
 * The source is not decoration. A row from `FUNNEL_DOMAINS` cannot be deleted
 * through the API — there is no row to delete — and a PostgREST `DELETE` that
 * matches nothing still succeeds, so without this the console offered a Remove
 * button for an env mapping, reported "unmapped", and the mapping was still
 * live and came back on the next refresh. On a surface whose whole job is
 * deciding what a hostname serves, being told a client's domain was
 * disconnected when it was not is the worst answer available.
 *
 * @returns {Promise<{ host: string, slug: string, source: "env"|"db" }[]>}
 */
export async function listDomains() {
  const map = await loadDomains();
  return [...map.entries()]
    .map(([host, entry]) => ({ host, slug: entry.slug, source: entry.source }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Where one host's mapping comes from, or null when it is not mapped.
 *
 * `DELETE /api/admin/domains` asks before deleting: the answer decides whether
 * the operator gets a truthful refusal or a delete that silently matches
 * nothing.
 *
 * @param {string} host  Already normalised.
 * @returns {Promise<"env"|"db"|null>}
 */
export async function domainSource(host) {
  const map = await loadDomains();
  return map.get(host)?.source || null;
}
