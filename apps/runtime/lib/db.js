/**
 * @file The Postgres client. Speaks PostgREST over plain `fetch` — there is no
 * SQL driver in this repo and there is not going to be one.
 *
 * WHY NOT `pg`
 * Two reasons, and the second is the one that matters. The repo has a
 * CI-enforced zero-runtime-dependency invariant (`scripts/check-no-deps.mjs`),
 * so a driver fails the build. And on serverless a driver drags in connection
 * pooling: pgbouncer in transaction mode, no prepared statements, and a
 * connection storm every time traffic scales out. PostgREST is stateless HTTP,
 * which is the shape the platform already is.
 *
 * WHAT THAT COSTS, AND HOW IT IS PAID
 * One PostgREST request is one transaction, so a multi-statement transaction
 * cannot be expressed from here. Anything transactional — inserting a lead
 * together with its delivery rows — or anything needing `FOR UPDATE SKIP
 * LOCKED` lives in a Postgres function and is called with `rpc()`. See
 * `supabase/migrations/*_phase1_functions.sql`. The useful consequence is that
 * the delivery state machine has exactly one implementation, in SQL, and no
 * route handler can transition a row by writing a status string.
 *
 * NO RETRIES HERE, ON PURPOSE
 * A retry belongs to the delivery queue, which is durable and can back off over
 * hours. A retry loop inside a request handler burns the visitor's latency
 * budget on a database that is already unhappy, and the ingest path has a
 * degrade-forward answer that is strictly better than waiting.
 *
 * ERRORS CARRY A CODE BECAUSE CALLERS BRANCH ON IT
 * `/api/lead` has to tell "this funnel does not exist" (nothing to deliver to,
 * log it, still answer the visitor 202) from "Supabase is unreachable" (deliver
 * inline, skip the queue). So every failure throws an `Error` with `.status`
 * and `.code` attached, and `dbErrorKind()` names the three cases callers
 * actually distinguish.
 *
 * LOGGING RULE, INHERITED
 * Nothing here logs. Callers log `errSummary(err)` — never the error object,
 * and never a response body verbatim: a Postgres constraint message quotes the
 * values that violated it, which on this schema means a visitor's email address
 * in the operator's logs.
 */

/**
 * Connection details, read per call rather than once at import.
 *
 * `lib/config.js` deliberately reads the environment once, and that is right for
 * a value the process is built around. These two are different: on serverless
 * the environment belongs to the invocation, and `forwardWebhook` already reads
 * `process.env.WEBHOOK_URL` at call time for the same reason.
 *
 * `config.js` still exports SUPABASE_URL / SUPABASE_KEY / SUPABASE_ON for
 * `store.js`'s `supabaseInsert`. That duplication is transitional and goes away
 * with the JSONL sinks when the ingest path moves onto this module.
 */
const conn = () => ({
  url: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, ""),
  key: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  // Supabase mounts PostgREST behind a gateway at /rest/v1. A standalone
  // PostgREST — which is how this runs locally, since the Supabase CLI's stack
  // needs Docker — serves the same API at the root. Set SUPABASE_REST_PATH=""
  // for that case. Everywhere else the default is correct and nothing sets it.
  base: process.env.SUPABASE_REST_PATH ?? "/rest/v1",
});

/** Default per-request ceiling. The ingest path is latency-critical; the drain overrides it. */
const DEFAULT_TIMEOUT_MS = () => Math.max(500, Number(process.env.DB_TIMEOUT_MS) || 5000);

/** True when this deployment has a database configured at all. */
export function dbConfigured() {
  const { url, key } = conn();
  return Boolean(url && key);
}

/**
 * The project's base URL and service key, for the ONE caller that is not
 * PostgREST: `lib/storage.js` talks to the Storage API on the same project, at a
 * different path prefix (PHASE-2-PLAN.md §1).
 *
 * Exported from here rather than read again over there so there is one place
 * that knows which variables name a Supabase project — the alternative is two
 * readers that agree until someone adds a fallback to one of them.
 *
 * @returns {{ url: string, key: string }}
 */
export function supabaseConn() {
  const { url, key } = conn();
  return { url, key };
}

/**
 * @param {string} message
 * @param {{ status?: number|null, code?: string|null }} [meta]
 * @returns {Error & { status: number|null, code: string|null }}
 */
function dbError(message, meta = {}) {
  const err = /** @type {any} */ (new Error(message));
  err.status = meta.status ?? null;
  err.code = meta.code ?? null;
  return err;
}

/**
 * Classify a thrown database error into the three cases callers branch on.
 *
 * - `"not_found"` — the row the call named does not exist. Our functions raise
 *   SQLSTATE `PT404`; PostgREST maps its own `PTxxx` range onto HTTP status
 *   codes, so that arrives as a 404. Deterministic — retrying cannot fix it.
 *   (A plain `P0002`/`no_data_found` does NOT become a 404; PostgREST passes it
 *   through as a generic 500, which this function would read as "database
 *   down". That is why the raise uses `PT404` and not the intuitive code.)
 * - `"rejected"` — the database was reached and said no about THIS request: a
 *   constraint, a bad argument. Deterministic, and scoped to one call.
 * - `"unavailable"` — no answer, a 5xx, or an authentication failure. The
 *   ingest path degrades forward on this one, because the lead is real and the
 *   queue cannot hold it.
 *
 * 401 and 403 are deliberately `"unavailable"` rather than `"rejected"`, and
 * the distinction is the difference between losing one lead and losing all of
 * them. A rotated service-role key that was not updated in the environment
 * answers 401 to every single request — if that classified as "the database
 * said no to this record", ingest would log and 202 forever and every lead for
 * every client would vanish silently, which is precisely the failure this
 * project exists to prevent. Nothing is wrong with the lead; the connection to
 * the database is broken, and that is what degrade-forward is for.
 *
 * @param {any} err
 * @returns {"not_found"|"rejected"|"unavailable"}
 */
export function dbErrorKind(err) {
  const status = err?.status ?? null;
  if (err?.code === "PT404" || status === 404) return "not_found";
  if (status === null || status >= 500 || status === 401 || status === 403) return "unavailable";
  return "rejected";
}

/**
 * One request. Everything else in this file is a thin wrapper around it.
 *
 * @param {string} path   Path under /rest/v1, already encoded.
 * @param {RequestInit & { timeoutMs?: number }} [init]
 * @returns {Promise<any>} Parsed JSON, or null for an empty body.
 */
async function request(path, init = {}) {
  const { url, key, base } = conn();
  if (!url || !key) throw dbError("database not configured", { code: "db_not_configured" });

  const { timeoutMs = DEFAULT_TIMEOUT_MS(), headers, ...rest } = init;

  let res;
  try {
    res = await fetch(`${url}${base}${path}`, {
      ...rest,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...headers,
      },
      // A hung database must not hold a function open until the platform kills
      // it — that is how a slow query turns into a stranded lead.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network failure, DNS failure, timeout. No status, so `dbErrorKind` reads
    // it as unavailable, which is the case the ingest path degrades forward on.
    throw dbError(/** @type {any} */ (err)?.name === "TimeoutError" ? "database timeout" : "database unreachable", {
      code: /** @type {any} */ (err)?.name === "TimeoutError" ? "db_timeout" : "db_unreachable",
    });
  }

  if (!res.ok) {
    // PostgREST answers { code, message, details, hint }. Take the code and a
    // bounded message: `details` quotes the offending row, which on this schema
    // is personal data, and it would end up wherever the caller logs.
    let code = null;
    let message = `database error ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body === "object") {
        code = typeof body.code === "string" ? body.code : null;
        if (typeof body.message === "string") message = body.message.slice(0, 200);
      }
    } catch {
      /* non-JSON error body; the status is enough */
    }
    throw dbError(message, { status: res.status, code });
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Call a Postgres function. This is where every transactional and every
 * queue-claiming operation goes.
 *
 * @param {string} fn    Function name, e.g. "claim_deliveries".
 * @param {Record<string, unknown>} [args]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export function rpc(fn, args = {}, opts = {}) {
  return request(`/rpc/${encodeURIComponent(fn)}`, {
    method: "POST",
    body: JSON.stringify(args),
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Read rows. `query` is PostgREST filter syntax, e.g.
 * `select=id,doc&slug=eq.lead-gen&limit=1`.
 *
 * @param {string} table
 * @param {string} [query]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any[]>}
 */
export async function select(table, query = "", opts = {}) {
  const rows = await request(`/${encodeURIComponent(table)}${query ? `?${query}` : ""}`, {
    method: "GET",
    timeoutMs: opts.timeoutMs,
  });
  return Array.isArray(rows) ? rows : rows == null ? [] : [rows];
}

/**
 * Insert rows. Returns the inserted representation unless `returning` is false,
 * which is the cheaper path when the caller only needs to know it worked.
 *
 * @param {string} table
 * @param {Record<string, unknown>|Record<string, unknown>[]} rows
 * @param {{ returning?: boolean, onConflict?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<any[]>}
 */
export async function insert(table, rows, opts = {}) {
  const { returning = true, onConflict } = opts;
  const prefer = [returning ? "return=representation" : "return=minimal"];
  if (onConflict) prefer.push("resolution=merge-duplicates");

  const out = await request(
    `/${encodeURIComponent(table)}${onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : ""}`,
    {
      method: "POST",
      headers: { prefer: prefer.join(",") },
      body: JSON.stringify(rows),
      timeoutMs: opts.timeoutMs,
    },
  );
  return Array.isArray(out) ? out : out == null ? [] : [out];
}

/**
 * Update rows matching a PostgREST filter.
 *
 * The filter is required and must not be empty: PATCH with no filter updates
 * every row in the table, and the tables here are leads and delivery state.
 *
 * @param {string} table
 * @param {string} query  PostgREST filter, e.g. `id=eq.7`.
 * @param {Record<string, unknown>} values
 * @param {{ returning?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<any[]>}
 */
export async function update(table, query, values, opts = {}) {
  if (!query) throw dbError("refusing an unfiltered update", { code: "db_unfiltered_update" });

  const out = await request(`/${encodeURIComponent(table)}?${query}`, {
    method: "PATCH",
    headers: { prefer: opts.returning === false ? "return=minimal" : "return=representation" },
    body: JSON.stringify(values),
    timeoutMs: opts.timeoutMs,
  });
  return Array.isArray(out) ? out : out == null ? [] : [out];
}

/**
 * Delete rows matching a PostgREST filter.
 *
 * Same required filter as `update`, and for a stronger reason: DELETE with no
 * filter empties the table, and nothing in this runtime ever wants that. The
 * guard is the API's shape rather than a comment, because the failure has no
 * second chance.
 *
 * @param {string} table
 * @param {string} query  PostgREST filter, e.g. `host=eq.example.com`.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function remove(table, query, opts = {}) {
  if (!query) throw dbError("refusing an unfiltered delete", { code: "db_unfiltered_delete" });

  await request(`/${encodeURIComponent(table)}?${query}`, {
    method: "DELETE",
    headers: { prefer: "return=minimal" },
    timeoutMs: opts.timeoutMs,
  });
}
