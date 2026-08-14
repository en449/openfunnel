/**
 * @file The client report link — minting, resolving and reading (PHASE-2-PLAN.md §3).
 *
 * WHAT THIS IS
 * A client gets one URL, `/r/<token>`, and it shows them their own leads. No
 * account, no password, no session (PLAN.md §5.3). The token is therefore the
 * whole access control, which puts three obligations in this file:
 *
 *   1. 256 bits from a CSPRNG. That is an Art. 32 TOM commitment, not a
 *      preference — a guessable report link would be a reportable breach.
 *   2. The token is never stored. This module hashes it on the way in and the
 *      database only ever holds the digest.
 *   3. The token is never logged. Every warn below names the reason and nothing
 *      else; the same rule the rest of the runtime applies to `err.path`.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * Validity. Whether a token is expired, revoked, or belongs to a deleted client
 * is decided by `resolve_report_token` in SQL, in one place, and this module's
 * entire authorisation logic is "did it return a row" (PHASE-2-PLAN.md §3,
 * Decision 6). Adding a second check here would create a second answer.
 */

import { createHash, randomBytes } from "node:crypto";
import { dbConfigured, rpc, select } from "./db.js";

/**
 * How long a freshly issued link lives (PLAN.md §5.3).
 *
 * The column is NOT NULL with no default, on purpose: a link with no end is a
 * credential with no end, and the number belongs next to the entropy it goes
 * with rather than in a schema an operator reads once.
 */
export const REPORT_TTL_DAYS = Math.max(1, Number(process.env.REPORT_TTL_DAYS) || 180);

/** How many leads the page lists. See the `ponytail:` note in PHASE-2-PLAN.md §3. */
export const REPORT_LEAD_LIMIT = 200;

/**
 * The shape a token has, checked before anything touches the database.
 *
 * 32 random bytes in base64url is exactly 43 characters with no padding. This is
 * not a security control — the digest lookup is — it is what keeps a crawler
 * hitting `/r/favicon.ico` from costing a round trip, and it means the rate
 * limiter's miss counter measures real guesses rather than noise.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mint a new token.
 *
 * `randomBytes` and not `Math.random`, and 32 bytes and not 16: the token is the
 * only thing between the internet and one client's personal data, so it is sized
 * so that guessing is not a strategy at any rate the endpoint could be walked at.
 *
 * @returns {{ token: string, hash: string }} The token to show the operator ONCE,
 *   and the digest to store.
 */
export function mintReportToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: reportTokenHash(token) };
}

/**
 * `sha256(token)`, in the `\x…` hex form PostgREST casts to `bytea` — the same
 * encoding `hashIp` and `hashOtpCode` already use.
 *
 * Unsalted, unlike those two, and the migration explains why at length: they hash
 * a small input space (six digits, 2^32 addresses) where an unsalted digest is
 * the secret in a thin disguise. A 256-bit random token has no space to search.
 *
 * @param {string} token
 * @returns {string}
 */
export function reportTokenHash(token) {
  return `\\x${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Which client may this token read?
 *
 * @param {string} token
 * @returns {Promise<{ tokenId: string, clientId: string, clientName: string }|null>}
 *   null for every failure — wrong, expired, revoked, deleted client, or a
 *   database that could not be reached. The caller answers 404 to all of them,
 *   which is what stops the endpoint confirming that a near-miss was near.
 */
export async function resolveReportToken(token) {
  if (!dbConfigured() || typeof token !== "string" || !TOKEN_RE.test(token)) return null;

  try {
    const rows = await rpc("resolve_report_token", { p_hash: reportTokenHash(token) });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.client_id) return null;
    return { tokenId: row.token_id, clientId: row.client_id, clientName: row.client_name || "" };
  } catch (err) {
    // Deliberately not `errSummary(err)`: that prints the request URL, and the
    // request URL of this particular call has the token's digest in its body,
    // not its path — but the next edit to `rpc()` could change that, and there
    // is nothing useful in the message either. A database failure here is
    // already visible in every other route's logging.
    console.warn("[report] token lookup failed (database unavailable)");
    return null;
  }
}

/**
 * The report for one client: per-funnel counts, totals, and the most recent
 * leads. One RPC — the exclusion rules for deleted, restricted and spam rows
 * live in SQL so the counter and the list cannot come to disagree.
 *
 * @param {string} clientId
 * @param {number} [limit]
 * @returns {Promise<{ funnels: any[], total: number, d7: number, d30: number, leads: any[] }|null>}
 */
export async function loadClientReport(clientId, limit = REPORT_LEAD_LIMIT) {
  try {
    const data = await rpc("client_report", { p_client_id: clientId, p_limit: limit });
    if (!data || typeof data !== "object") return null;
    return {
      funnels: Array.isArray(data.funnels) ? data.funnels : [],
      total: Number(data.total) || 0,
      d7: Number(data.d7) || 0,
      d30: Number(data.d30) || 0,
      leads: Array.isArray(data.leads) ? data.leads : [],
    };
  } catch (err) {
    console.warn("[report] could not build a report (database unavailable)");
    return null;
  }
}

/* ========================================================================== *
 *  The operator's side
 * ========================================================================== */

/**
 * Columns the console may see. The digest is not among them — it is not a secret
 * that unlocks anything on its own, but there is no reason for it to travel and
 * an allowlist here is what stops the next added column travelling by accident.
 */
const TOKEN_SELECT = "select=id,client_id,label,expires_at,revoked_at,last_seen_at,created_at,client(name)";

/**
 * Every report link the operator has issued, newest first.
 *
 * @returns {Promise<Array<{ id: string, clientId: string, clientName: string|null,
 *   label: string|null, expiresAt: string, revokedAt: string|null,
 *   lastSeenAt: string|null, createdAt: string, expired: boolean }>>}
 */
export async function listReportTokens() {
  const rows = await select("report_token", `${TOKEN_SELECT}&order=created_at.desc&limit=200`);
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client?.name ?? null,
    label: row.label ?? null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at,
    // Derived here rather than in the console, because "expired" is a fact about
    // the server's clock and a browser with a wrong one would draw a live link
    // as dead — or, worse, a dead one as live.
    expired: new Date(row.expires_at).getTime() <= now,
  }));
}
