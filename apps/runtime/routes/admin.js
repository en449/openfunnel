/**
 * @file `/api/admin/*` — the console's data and configuration APIs.
 *
 * PRIVILEGED. The router runs `isCrossSiteRequest` and `requireAdmin` before
 * dispatching here; these handlers do no auth of their own.
 *
 * Two invariants show up in this file:
 *
 *  - Every reader filters with `isPreviewRecord`, the SAME predicate the ingest
 *    path uses. When those drifted, a stranger could inject records the operator
 *    could never see.
 *  - `redactEmailSettings` runs on the way out. Secrets never travel outward,
 *    not even to an authenticated console.
 */

import { esc } from "../lib/html.js";
import { EMAIL_RE, getEmailSettings, redactEmailSettings, saveEmailSettings, sendEmail } from "../lib/email.js";
import { clientIp, json, readJson } from "../lib/http.js";
import { isPreviewRecord } from "../lib/preview.js";
import { rateLimit, tooMany } from "../lib/ratelimit.js";
import { readJsonlRecords } from "../lib/store.js";
import { syncAllFunnelTargets } from "../lib/targets.js";
import { dbConfigured, insert, remove, rpc, select, update } from "../lib/db.js";
import { REPORT_TTL_DAYS, listReportTokens, mintReportToken } from "../lib/report.js";
import { drainOnce } from "../lib/delivery.js";
import { errSummary } from "../lib/log.js";
import { SLUG_RE } from "../lib/config.js";
import { domainSource, invalidateDomains, listDomains, normalizeHost } from "../lib/domains.js";
import { ASSET_TYPES, MAX_ASSET_BYTES, assetPath, deleteAsset, signAssetUpload } from "../lib/storage.js";

/** The five states in the schema's own check constraint. */
const DELIVERY_STATUSES = new Set(["pending", "delivering", "done", "dead", "cancelled"]);

/**
 * Shape check for an id that goes into a PostgREST filter.
 *
 * The value is encoded before it is interpolated either way; this is the same
 * belt-and-braces the file-touching routes apply with `SLUG_RE`, and it turns a
 * malformed id into a 400 rather than a 503 the operator reads as an outage.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * States `resend_delivery` accepts. `delivering` is excluded because a lease is
 * still out on it and a second dispatch is a double-send; `pending` because it
 * is already going to be attempted.
 */
const RESENDABLE = new Set(["dead", "done", "cancelled"]);

/**
 * Columns the delivery log reads.
 *
 * `delivery_target.config` is NOT among them and must never be — it holds the
 * webhook secret, and §2 of the schema says in as many words that it may not be
 * returned by a console API.
 *
 * The funnel's SLUG comes through a nested embed rather than being resolved in
 * the console, because the console's funnel list is slugs only: `funnel.id` is a
 * UUID that never reaches it, so a client-side lookup by id would label every
 * row with a raw UUID forever.
 */
const DELIVERY_SELECT =
  "select=id,status,attempts,last_error,last_status,next_attempt_at,created_at,delivered_at," +
  "lead(id,funnel_id,created_at,funnel(slug)),delivery_target(kind)";

/**
 * Shape one delivery row for the console.
 *
 * An allowlist rather than a rename pass: if the select above ever grows a
 * column, it does not reach the console until someone adds it here too.
 *
 * @param {any} row
 */
const deliveryView = (row) => ({
  id: row.id,
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error ?? null,
  lastStatus: row.last_status ?? null,
  nextAttemptAt: row.next_attempt_at ?? null,
  createdAt: row.created_at ?? null,
  deliveredAt: row.delivered_at ?? null,
  kind: row.delivery_target?.kind ?? null,
  leadId: row.lead?.id ?? null,
  funnelId: row.lead?.funnel_id ?? null,
  funnelSlug: row.lead?.funnel?.slug ?? null,
  leadCreatedAt: row.lead?.created_at ?? null,
});

/**
 * Why `resend_delivery` said no.
 *
 * The RPC answers with one boolean for two very different situations, and the
 * console showed both as "the row's state changed" — which is a lie in the case
 * that matters: a restricted lead (Art. 18) refuses the re-send permanently, and
 * an operator told the state changed will simply click again. The lookup only
 * runs on the refusal path.
 *
 * @param {string} leadId
 * @returns {Promise<"lead_restricted"|"lead_deleted"|"not_resendable">}
 */
async function refusalReason(leadId) {
  try {
    const [lead] = await select("lead", `select=restricted,deleted_at&id=eq.${encodeURIComponent(leadId)}&limit=1`);
    if (lead?.restricted) return "lead_restricted";
    if (lead?.deleted_at) return "lead_deleted";
  } catch {
    /* the reason is a courtesy; the refusal itself already stands */
  }
  return "not_resendable";
}

/**
 * @param {Request} req
 * @param {{ path: string, url: URL, server: any }} ctx
 * @returns {Promise<Response|null>} null when no admin route matched.
 */
export async function handleAdmin(req, ctx) {
  const { path, url, server } = ctx;

  if (path === "/api/admin/leads" && req.method === "GET") {
    const records = (await readJsonlRecords("leads.jsonl")).filter((l) => !isPreviewRecord(l));
    return json({ leads: records.reverse() });
  }

  if (path === "/api/admin/stats" && req.method === "GET") {
    return json(await computeStats(url.searchParams.get("funnel") || ""));
  }

  if (path === "/api/admin/email-settings" && req.method === "GET") {
    const cfg = await getEmailSettings();
    return json({ settings: redactEmailSettings(cfg) });
  }

  if (path === "/api/admin/email-settings" && req.method === "POST") {
    const body = await readJson(req);
    await saveEmailSettings(body || {});
    // The queue's `email` targets hold a copy of the notification address, so a
    // change here has to reach them — otherwise leads keep arriving at the
    // address the operator just replaced, durably and with no error anywhere.
    await syncAllFunnelTargets();
    // Re-resolve rather than echoing what was written: the saved object has
    // env-provided secrets stripped out (so they are not persisted to disk),
    // which would otherwise make this reply say "no key is set" at the exact
    // moment the operator might type one in — and a typed key persists and
    // shadows the env var, the failure that stripping exists to prevent.
    return json({ ok: true, settings: redactEmailSettings(await getEmailSettings()) });
  }

  // Re-derive every funnel's delivery targets. The backfill for funnels that
  // existed before targets did — without it, "never lose a lead" only becomes
  // true for a funnel once somebody happens to save it again. WO12's console
  // view calls this; until then it is the operator's one-request repair.
  if (path === "/api/admin/targets/sync" && req.method === "POST") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    return json({ ok: true, ...(await syncAllFunnelTargets()) });
  }

  // The delivery log. A read of the queue, never a second copy of it.
  if (path === "/api/admin/deliveries" && req.method === "GET") {
    // An empty log and no queue at all are opposite situations: a deployment
    // running on the legacy fan-out must not be told its delivery log is fine.
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    const wanted = url.searchParams.get("status") || "";
    if (wanted && !DELIVERY_STATUSES.has(wanted)) return json({ error: "invalid_status" }, 400);
    const asked = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 500) : 100;

    try {
      const rows = await select(
        "delivery",
        `${DELIVERY_SELECT}&order=id.desc&limit=${limit}${wanted ? `&status=eq.${wanted}` : ""}`,
      );
      return json({ deliveries: rows.map(deliveryView) });
    } catch (err) {
      console.warn(`[admin] delivery log unavailable: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  // Manual re-send. `resend_delivery` is the authority on whether the row may
  // move — the read below only exists to tell "no such row" apart from "not in a
  // state you can re-send", which the RPC's boolean cannot.
  if (path === "/api/admin/deliveries/resend" && req.method === "POST") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    const body = await readJson(req);
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid_id" }, 400);
    // Authenticated, but a leaked token that can trigger unbounded outbound
    // egress is worth a ceiling — same reasoning as the test-email route.
    if (!(await rateLimit(`resend:${clientIp(req, server) || "unknown"}`, 30, 60 * 60 * 1000))) return tooMany();

    try {
      const [row] = await select("delivery", `select=id,status,lead_id&id=eq.${id}&limit=1`);
      if (!row) return json({ error: "not_found" }, 404);
      if (!RESENDABLE.has(row.status)) return json({ error: "not_resendable", status: row.status }, 409);
      // Races the drain: the row can be claimed between the read and here, which
      // is exactly what the RPC's own status filter refuses.
      if (!(await rpc("resend_delivery", { p_id: id }))) return json({ error: await refusalReason(row.lead_id) }, 409);

      // Attempted inline, and awaited: the operator clicked a button and should
      // get the outcome, not a row that sits in `pending` until pg_cron fires.
      //
      // Bounded twice over. Each attempt has the dispatcher's own timeout, and
      // the deadline stops this claiming more work — `claim_deliveries` takes
      // every due row for the lead, not only the one that was clicked, so the
      // wait is not a function of anything this route can see. Accelerating a
      // sibling row that was already due is harmless; making the operator wait
      // an unbounded number of chunks for it is not.
      await drainOnce({ leadId: row.lead_id, limit: 10, deadline: Date.now() + 20_000, signal: req.signal });

      const [after] = await select("delivery", `select=status,attempts,last_error,last_status&id=eq.${id}&limit=1`);
      return json({
        ok: true,
        status: after?.status ?? "pending",
        attempts: after?.attempts ?? 0,
        lastError: after?.last_error ?? null,
        lastStatus: after?.last_status ?? null,
      });
    } catch (err) {
      console.warn(`[admin] re-send of delivery ${id} failed: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Assets — PHASE-2-PLAN.md §1
   *
   *  The bytes never come through here. This mints a token scoped to one
   *  object path and the console PUTs the file straight to Supabase, which is
   *  what keeps `MAX_BODY` at 64KB for public ingest and sidesteps Vercel's
   *  4.5MB body cap. Everything this route decides is about the PATH.
   * ------------------------------------------------------------------ */
  if (path === "/api/admin/assets/sign" && req.method === "POST") {
    if (!dbConfigured()) return json({ error: "storage_not_configured" }, 503);
    const body = await readJson(req);

    // The slug is a path segment in a public URL, so it gets the same check
    // every file-touching route in this repo uses. `assetPath` builds the rest
    // from a random value, so there is nothing else here a caller controls.
    const slug = String(body?.slug || "").trim();
    if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400);

    const contentType = String(body?.contentType || "").toLowerCase();
    if (!ASSET_TYPES[contentType]) return json({ error: "unsupported_type" }, 400);

    // Advisory: the browser declares this and could lie. The bucket's own
    // `file_size_limit` is the check that actually binds, and it is on the side
    // the browser cannot reach. This one exists so an operator picking a 40MB
    // RAW file is told now rather than after the upload.
    const size = Number(body?.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_ASSET_BYTES) return json({ error: "too_large" }, 413);

    // A leaked token minting unbounded upload URLs would be a way to fill the
    // operator's bucket. Same reasoning as the re-send and test-email ceilings.
    if (!(await rateLimit(`assets-sign:${clientIp(req, server) || "unknown"}`, 120, 60 * 60 * 1000))) return tooMany();

    try {
      return json(await signAssetUpload(assetPath(slug, contentType)));
    } catch (err) {
      // `errSummary`, never the error: a signed-upload URL carries its token in
      // the query string and Bun puts the whole URL on `err.path`.
      console.warn(`[admin] could not sign an upload for "${slug}": ${errSummary(err)}`);
      return json({ error: "storage_unavailable" }, 503);
    }
  }

  if (path === "/api/admin/assets" && req.method === "DELETE") {
    if (!dbConfigured()) return json({ error: "storage_not_configured" }, 503);
    const body = await readJson(req);
    const target = String(body?.path || "");

    // Shape-checked rather than sanitised. This is the same rule as `isInside`
    // one layer up: `..` in an object path would let a delete reach outside the
    // prefix this console is allowed to manage, and a regex that ACCEPTS a known
    // good shape cannot be talked around the way a blocklist can.
    if (!/^funnel\/[a-z0-9][a-z0-9-]{0,63}\/[0-9a-f]{32}\.[a-z]{3,4}$/i.test(target)) {
      return json({ error: "invalid_path" }, 400);
    }

    // Same ceiling as its siblings, for the same reason: authenticated is not
    // unbounded, and this one deletes. Note the path is not scoped to the funnel
    // the console has open — an admin session may delete any asset, which is the
    // single-ADMIN_TOKEN trust model this whole surface already has.
    if (!(await rateLimit(`assets-delete:${clientIp(req, server) || "unknown"}`, 120, 60 * 60 * 1000))) return tooMany();

    try {
      await deleteAsset(target);
      return json({ ok: true });
    } catch (err) {
      // A missing object is the operator's intent already satisfied, not a
      // failure — the button says "remove" and it is gone.
      if (/** @type {any} */ (err)?.status === 404) return json({ ok: true, missing: true });
      console.warn(`[admin] could not delete an asset: ${errSummary(err)}`);
      return json({ error: "storage_unavailable" }, 503);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Custom domains — PHASE-2-PLAN.md §2
   *
   *  A row here decides what the SERVER IS for that hostname: the console, the
   *  funnel list and every privileged route answer 404 on a mapped host. So the
   *  write path's real job is refusing the two mappings an operator cannot undo
   *  from the console afterwards — its own host, and a host it does not own.
   *  Only the first is checkable here; the second is Vercel's verification.
   * ------------------------------------------------------------------ */
  if (path === "/api/admin/domains" && req.method === "GET") {
    return json({ domains: await listDomains(), writable: dbConfigured() });
  }

  if (path === "/api/admin/domains" && req.method === "POST") {
    const body = await readJson(req);

    const host = normalizeHost(body?.host);
    if (!host) return json({ error: "invalid_host" }, 400);

    // Lowercase as well as SLUG_RE: that pattern is case-insensitive and the
    // table's CHECK constraint is not, so a mixed-case slug passed here and then
    // failed in Postgres — surfacing as `db_unavailable`, which sends the
    // operator looking at the database for a typo in their own input.
    const slug = String(body?.slug || "").trim();
    if (!SLUG_RE.test(slug) || slug !== slug.toLowerCase()) return json({ error: "invalid_slug" }, 400);

    // The lockout guard, and it runs BEFORE the database check on purpose: it is
    // a fact about the request, not about the store, and an operator who is
    // about to take the console off its own hostname should be told that rather
    // than "no database". Mapping the host this request arrived on removes the
    // console from that hostname the moment the cache expires — including the
    // page making the request — and the only way back is deleting the row in
    // the database, because every console API answers 404 on a mapped host.
    if (host === normalizeHost(req.headers.get("host"))) {
      return json({ error: "would_lock_out_console" }, 409);
    }

    // No table, no writes. `FUNNEL_DOMAINS` still works and is what a
    // database-less self-hoster uses; saying so beats a 500.
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);

    if (!(await rateLimit(`domains-write:${clientIp(req, server) || "unknown"}`, 60, 60 * 60 * 1000))) return tooMany();

    try {
      // Upsert: pointing an existing domain at a different funnel is an edit,
      // not an error, and it is the operation an operator reaches for when a
      // client's funnel is replaced.
      await insert("domain", [{ host, slug }], { onConflict: "host", returning: false });
      invalidateDomains();
      return json({ ok: true, host, slug });
    } catch (err) {
      console.warn(`[admin] could not map a domain: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  if (path === "/api/admin/domains" && req.method === "DELETE") {
    const host = normalizeHost(url.searchParams.get("host"));
    if (!host) return json({ error: "invalid_host" }, 400);

    // Asked before deleting, because a PostgREST DELETE that matches nothing
    // still succeeds. An entry from `FUNNEL_DOMAINS` has no row: deleting it
    // would report success while the mapping stayed live and came back on the
    // next read. The console hides the button for these, and this is the same
    // refusal for anything that does not go through the console.
    // Before the database check, for the same reason the lockout guard is: this
    // is a fact about the mapping the operator is pointing at, and "that one
    // lives in an env var" is a more useful answer than "no database".
    if ((await domainSource(host)) === "env") return json({ error: "env_mapping" }, 409);

    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);

    if (!(await rateLimit(`domains-write:${clientIp(req, server) || "unknown"}`, 60, 60 * 60 * 1000))) return tooMany();

    try {
      await remove("domain", `host=eq.${encodeURIComponent(host)}`);
      invalidateDomains();

      // A host can be in BOTH stores — the table wins, so deleting its row hands
      // the hostname back to `FUNNEL_DOMAINS` rather than unmapping it. Saying
      // "unmapped" there would be the same untrue success this route was just
      // fixed for, one layer down.
      const remaining = await domainSource(host);
      return json({ ok: true, host, stillMappedBy: remaining });
    } catch (err) {
      console.warn(`[admin] could not unmap a domain: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Clients
   *
   *  A read, and only the columns the console draws with. The table also holds
   *  `contact_email` and `retention_months`; neither is on this list, because a
   *  picker needs a name and an id and nothing here yet edits a client.
   * ------------------------------------------------------------------ */
  if (path === "/api/admin/clients" && req.method === "GET") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    try {
      const rows = await select("client", "select=id,name,slug,avv_signed_at&deleted_at=is.null&order=name.asc&limit=200");
      return json({
        clients: rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, avvSignedAt: c.avv_signed_at ?? null })),
      });
    } catch (err) {
      console.warn(`[admin] client list unavailable: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Report tokens — PHASE-2-PLAN.md §3
   *
   *  Each row is a credential that reads one client's leads with no login, so
   *  this surface has one rule above all others: the token exists in exactly one
   *  response, the one that mints it. Nothing else ever returns it, and the
   *  digest does not travel either.
   * ------------------------------------------------------------------ */
  if (path === "/api/admin/report-tokens" && req.method === "GET") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    try {
      return json({ tokens: await listReportTokens() });
    } catch (err) {
      console.warn(`[admin] report token list unavailable: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  if (path === "/api/admin/report-tokens" && req.method === "POST") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    const body = await readJson(req);

    // The client is named explicitly and never inferred. `saveFunnel` may guess
    // when there is exactly one client, because the cost of guessing wrong there
    // is a funnel filed under the wrong AVV — recoverable. Guessing wrong here
    // hands one client a working link to another client's leads.
    const clientId = String(body?.clientId || "").trim();
    if (!UUID_RE.test(clientId)) return json({ error: "invalid_client" }, 400);

    const label = String(body?.label || "").trim().slice(0, 120) || null;

    const askedDays = Number(body?.ttlDays);
    const ttlDays = Number.isFinite(askedDays) ? Math.min(Math.max(Math.trunc(askedDays), 1), 3650) : REPORT_TTL_DAYS;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

    // This route mints credentials, so it gets the same ceiling its siblings do
    // — and here it also bounds how many live links a leaked admin token could
    // scatter before anyone notices.
    if (!(await rateLimit(`report-mint:${clientIp(req, server) || "unknown"}`, 30, 60 * 60 * 1000))) return tooMany();

    const { token, hash } = mintReportToken();

    try {
      // The client is checked by the foreign key, not by a select-then-insert:
      // one round trip, and no window between the two in which it could be
      // deleted. A violation is a 400 about the client, not a 503 about the
      // database, because the operator's input is what was wrong.
      const [row] = await insert(
        "report_token",
        { client_id: clientId, token_hash: hash, label, expires_at: expiresAt },
        { returning: true },
      );

      // The only response that will ever carry it. `path` rather than a full
      // URL: this process cannot know its own public scheme behind a TLS-
      // terminating proxy, and the console composes the link from its own
      // `location.origin`, which is the same deployment.
      return json({ ok: true, id: row?.id ?? null, token, path: `/r/${token}`, expiresAt });
    } catch (err) {
      if (/** @type {any} */ (err)?.code === "23503") return json({ error: "unknown_client" }, 400);
      console.warn(`[admin] could not issue a report token: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  if (path === "/api/admin/report-tokens" && req.method === "DELETE") {
    if (!dbConfigured()) return json({ error: "db_not_configured" }, 503);
    const id = String(url.searchParams.get("id") || "");
    if (!UUID_RE.test(id)) return json({ error: "invalid_id" }, 400);

    if (!(await rateLimit(`report-mint:${clientIp(req, server) || "unknown"}`, 30, 60 * 60 * 1000))) return tooMany();

    try {
      // Revoked, not deleted: who could read a client's personal data and until
      // when is what Art. 30/32 asks about, and a removed row cannot answer it.
      //
      // `returning: true` and then counting, because a PostgREST write that
      // matches no row still SUCCEEDS — the same failure the domain Remove
      // button shipped with, where the console reported a client's domain
      // disconnected while it went on serving. Here it would report a link dead
      // while it still opened.
      const rows = await update(
        "report_token",
        `id=eq.${encodeURIComponent(id)}&revoked_at=is.null`,
        { revoked_at: new Date().toISOString() },
        { returning: true },
      );
      if (!rows.length) return json({ error: "not_found_or_already_revoked" }, 404);
      return json({ ok: true, id });
    } catch (err) {
      console.warn(`[admin] could not revoke a report token: ${errSummary(err)}`);
      return json({ error: "db_unavailable" }, 503);
    }
  }

  if (path === "/api/admin/test-email" && req.method === "POST") {
    const body = await readJson(req);
    const targetEmail = String(body?.email || (await getEmailSettings()).notifyEmail || "").trim();
    if (!targetEmail) return json({ error: "No recipient email specified" }, 400);
    if (!EMAIL_RE.test(targetEmail)) return json({ error: "invalid_email" }, 400);
    // Authenticated, but still capped: a leaked token should not turn the
    // operator's mail domain into a spam source.
    if (!(await rateLimit(`test-email:${clientIp(req, server) || "unknown"}`, 10, 60 * 60 * 1000))) return tooMany();

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

  return null;
}

/**
 * Roll the JSONL sinks up into the dashboard's numbers.
 *
 * @param {string} scope  a funnelId to narrow to, or "" for everything.
 */
async function computeStats(scope) {
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
    if (ev.sessionId) sessions.add(String(ev.sessionId));

    if (ev.type !== "step_view" || !ev.stepId) return;
    // Coerced, not asserted: these records come from the public /api/events
    // body, so `stepId` and `sessionId` are whatever JSON the caller sent. A
    // non-string session id in a Set dedupes by identity, so two objects that
    // look identical would count as two visitors and inflate the step.
    const stepId = String(ev.stepId);
    let entry = perStep.get(stepId);
    if (!entry) {
      entry = { order: typeof ev.stepIndex === "number" ? ev.stepIndex : i, sessions: new Set() };
      perStep.set(stepId, entry);
    }
    entry.sessions.add(String(ev.sessionId || `anon-${i}`));
  });

  const steps = [...perStep.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([stepId, entry]) => ({ stepId, sessions: entry.sessions.size }));

  // Per-funnel rollup always spans every funnel so the dashboard can label
  // each card even while a single funnel is in scope.
  /** @type {Record<string, { starts: number, leads: number, completes: number }>} */
  // Null-prototype: `funnelId` comes from the public /api/events body, and on
  // a plain object `perFunnel["__proto__"]` resolves to Object.prototype —
  // truthy, so `||=` never creates an own key and the increments land on the
  // prototype instead.
  const perFunnel = Object.create(null);
  /** @param {string} id */
  const bucket = (id) => (perFunnel[id] ||= { starts: 0, leads: 0, completes: 0 });
  allEvents.forEach((ev) => {
    if (!ev.funnelId) return;
    if (ev.type === "funnel_start") bucket(String(ev.funnelId)).starts++;
    if (ev.type === "complete") bucket(String(ev.funnelId)).completes++;
  });
  allLeads.forEach((l) => {
    if (l.funnelId) bucket(String(l.funnelId)).leads++;
  });

  return {
    starts,
    stepViews,
    leads: leads.length,
    completes,
    sessions: sessions.size,
    steps,
    perFunnel,
  };
}
