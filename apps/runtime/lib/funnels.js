/**
 * @file Reading funnel documents, and the cache in front of that.
 *
 * TWO STORES, AND POSTGRES WINS WHEN IT IS THERE.
 *
 * Historically `examples/` (or whatever `FUNNELS_DIR` points at) was the funnel
 * database: one JSON document per funnel, listed by reading the directory. That
 * is still the whole story for a self-hoster with no Supabase configured, which
 * the README promises and the test suite depends on — `server.test.js` spawns
 * against a temp directory.
 *
 * It cannot stay the story for Enno's own deployment, for two reasons that have
 * nothing to do with elegance. `FUNNELS_DIR` defaults to `examples/`, inside a
 * tree that is now published on GitHub, so a client's funnel copy would be
 * committed. And serverless has no durable filesystem to write to at all.
 *
 * So: when `dbConfigured()`, the `funnel` table is asked first and the directory
 * is the fallback for a slug it does not hold. Not an either/or — pointing a
 * running install at a fresh Supabase project would otherwise blank out every
 * funnel in `examples/`, which is where this repo ships its own. The slug is
 * validated against `SLUG_RE` before either lookup, and the path containment
 * check stays on the file branch — the database branch cannot traverse
 * anything, but a single validation contract for both is what stops the next
 * edit picking the wrong one.
 *
 * ARCHIVED FUNNELS ARE NOT SERVED. Deleting a funnel row is not an option — it
 * is referenced by `lead`, and a delete that takes the leads with it is the
 * opposite of this project. So the console's delete archives, and archived
 * documents do not load. Ingest deliberately does NOT apply the same filter: a
 * visitor who loaded the page seconds before it was archived still submits, and
 * dropping that lead is the failure this phase exists to remove.
 *
 * The cache is invalidated through `invalidateFunnel` rather than by exporting
 * the Map, so the write routes cannot leave it holding a document that no longer
 * matches the store. Nothing else may WRITE to it: an entry seeded from outside
 * `readFunnel` carries no client AVV, and the serve-time gate reads a missing one
 * as "no client row backs this funnel" — so a hand-seeded entry switched half the
 * gate off for as long as it lived. Invalidate and let the next read refill it.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEV, FUNNELS_DIR, SLUG_RE, isInside } from "./config.js";
import { dbConfigured, insert, select, update } from "./db.js";
import { errSummary } from "./log.js";
// Cyclic on paper — targets.js → webhook.js → funnels.js — and safe in practice:
// every binding in that ring is read inside a function, never while a module is
// still evaluating. Keep it that way, or the cycle stops being harmless.
import { syncFunnelTargets } from "./targets.js";

/**
 * `avv` is the owning client's `avv_signed_at`, cached with the document because
 * the serve-time gate needs both and they arrive in the same query. `undefined`
 * means no client row backs this document at all — a funnel served from
 * `FUNNELS_DIR`, which nobody has signed an AVV for because nobody is its client.
 *
 * @type {Map<string, { funnel: any, at: number, avv?: string|null }>}
 */
const cache = new Map();
const CACHE_MS = DEV ? 0 : 60_000;

/**
 * A document is only usable if it has steps to render. Same rule for both stores.
 * @param {any} funnel
 * @param {string} slug
 * @param {string} where
 */
function usable(funnel, slug, where) {
  if (!Array.isArray(funnel?.steps) || funnel.steps.length === 0) {
    console.warn(`[runtime] funnel "${slug}" in ${where} has no steps — ignoring.`);
    return false;
  }
  return true;
}

/**
 * Load a funnel document by slug. Cached in production, always fresh in dev so
 * editing a document and hitting reload just works.
 *
 * @param {string} slug
 * @returns {Promise<any|null>}
 */
export async function loadFunnel(slug) {
  return (await readFunnel(slug)).funnel;
}

/**
 * The reader both callers share: the document AND the owning client's AVV state,
 * from the same lookup.
 *
 * `loadFunnelForVisitor` used to call `loadFunnel` and then read the AVV back out
 * of the cache entry it had just written. Two ways that went wrong, and the
 * second one failed OPEN, which is the direction a gate must never fail:
 * `invalidateFunnel` landing between the two lines left no entry at all, and an
 * entry written by anything other than this function carried no `avv` — so the
 * AVV half of the gate silently stopped binding for as long as that entry lived.
 * Returning the pair from one call is what makes `undefined` mean exactly one
 * thing: no client row backs this document.
 *
 * @param {string} slug
 * @returns {Promise<{ funnel: any|null, avv: string|null|undefined }>}
 */
async function readFunnel(slug) {
  if (!SLUG_RE.test(slug)) return { funnel: null, avv: undefined };
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return { funnel: hit.funnel, avv: hit.avv };

  let funnel = null;
  /** @type {string|null|undefined} */
  let avv;
  if (dbConfigured()) {
    const found = await loadFromDb(slug);
    // A decision, not an absence — never fall back to disk.
    if (found === ARCHIVED) return { funnel: null, avv: undefined };
    if (found) ({ funnel, avv } = found);
  }
  // Not in the database, or the database could not be reached. `examples/*.json`
  // is the funnel store for anyone who has not migrated, and it ships with this
  // repo — pointing the runtime at an empty Supabase project must not blank out
  // every funnel the operator already had.
  if (!funnel) funnel = await loadFromDisk(slug);

  if (funnel) cache.set(slug, { funnel, at: Date.now(), avv });
  return { funnel, avv };
}

/** Distinguishes "archived on purpose" from "not in the database". */
const ARCHIVED = Symbol("archived");

/**
 * @param {string} slug
 * @returns {Promise<any>}
 */
async function loadFromDb(slug) {
  try {
    const rows = await select(
      "funnel",
      `slug=eq.${encodeURIComponent(slug)}&select=slug,doc,status,client(avv_signed_at)&limit=1`,
    );
    const row = rows[0];
    if (!row) return null;
    // Filtered in JS rather than with `status=neq.archived`, because the filter
    // made an archived funnel indistinguishable from an absent one — and the
    // fallback above would then have served the deleted funnel back off disk.
    if (row.status === "archived") return ARCHIVED;
    const funnel = { ...row.doc };
    if (!usable(funnel, slug, "the database")) return null;
    funnel.slug ||= row.slug;
    // Embedded by table name, the same shape `report.js`'s TOKEN_SELECT already
    // uses against this project — `funnel` has exactly one foreign key to
    // `client`, so the relationship needs no disambiguation.
    //
    // `funnel.client_id` is NOT NULL, so a missing embed is a query that changed
    // under the gate rather than a funnel without a client. Read it as unsigned:
    // the gate's whole value is failing in the direction that takes a page down.
    if (!row.client) {
      console.warn(`[runtime] funnel "${slug}" returned no client row — treating the AVV as unsigned.`);
    }
    return { funnel, avv: row.client ? row.client.avv_signed_at ?? null : null };
  } catch (err) {
    // Never the error object: it carries the request URL, which carries the key.
    console.warn(`[runtime] funnel "${slug}" load failed: ${errSummary(err)}`);
    return null;
  }
}

/**
 * @param {string} slug
 * @returns {Promise<any>}
 */
async function loadFromDisk(slug) {
  const file = join(FUNNELS_DIR, `${slug}.json`);
  if (!isInside(file, FUNNELS_DIR)) return null; // defence in depth
  try {
    const funnel = JSON.parse(await readFile(file, "utf8"));
    if (!usable(funnel, slug, FUNNELS_DIR)) return null;
    funnel.slug ||= slug;
    return funnel;
  } catch {
    return null;
  }
}

/* ========================================================================== *
 *  The serve-time legal gate — PHASE-2-PLAN.md §4, PLAN.md §8.5 + §8.9
 *
 *  §5 DDG requires an Impressum and Art. 13 DSGVO a privacy notice on every
 *  page a visitor lands on, and Art. 28 requires a signed AVV before a processor
 *  holds a client's personal data. PLAN.md writes both as "publish is refused" —
 *  but there is no publish action in this codebase, and inventing one would gate
 *  a single code path while an edit, an import or a restore walked past it.
 *
 *  So the gate binds where the visitor is: the page refuses to render. It cannot
 *  be routed around, it is one check rather than a state machine, and it fails in
 *  the direction that takes a page down rather than the one that quietly ships an
 *  Abmahnung.
 *
 *  SCOPE. It binds only when `dbConfigured()`. A self-hoster running out of
 *  `FUNNELS_DIR` is their own controller — the README says so — and refusing to
 *  serve this repo's own examples would make the project undemonstrable. The AVV
 *  half binds only for a document that came from the `funnel` table, because an
 *  AVV is a contract with a client and a file on disk has none.
 *
 *  The ingest path deliberately does NOT consult this, exactly as it ignores
 *  `status === "archived"`. A visitor who loaded the page a second before an
 *  Impressum URL was cleared still presses submit, and dropping that lead would
 *  destroy data rather than protect it — the collection already happened.
 * ========================================================================== */

/**
 * The engine's `isNavigableUrl`, re-implemented here for the same reason
 * `sameOriginPath` and `hasPreviewFlag` are: the runtime cannot import browser
 * code onto the serverless path. It has to agree with the engine's check exactly,
 * because the engine is what decides whether the link actually renders — a URL
 * this accepts and the engine rejects is a gate that passed a page with no
 * visible Impressum on it. `funnels-gate.test.js` pins the two against one table.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function legalUrlOk(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  let parsed;
  try {
    parsed = new URL(value, RELATIVE_BASE);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (/^https?:/i.test(value.trim())) return true;
  return parsed.origin === RELATIVE_BASE;
}

/**
 * Why this funnel must not be rendered, or null when it may be.
 *
 * @param {any} funnel
 * @param {string|null|undefined} avv  the client's `avv_signed_at`; undefined when no client row backs it
 * @returns {"impressum_url_missing"|"privacy_url_missing"|"avv_unsigned"|null}
 */
function gateReason(funnel, avv) {
  if (!dbConfigured()) return null;
  if (!legalUrlOk(funnel?.legal?.impressumUrl)) return "impressum_url_missing";
  if (!legalUrlOk(funnel?.legal?.privacyUrl)) return "privacy_url_missing";
  if (avv === undefined) return null;
  if (!avv) return "avv_unsigned";
  return null;
}

/**
 * Load a funnel for a visitor-facing surface, with the gate applied.
 *
 * `loadFunnel` stays the unguarded reader: ingest, the delivery fan-out, the CAPI
 * forward and the builder all need the document of a funnel that must not be
 * rendered. Only the two routes a visitor reaches go through this.
 *
 * @param {string} slug
 * @returns {Promise<{ funnel: any|null, blocked: string|null }>}
 */
export async function loadFunnelForVisitor(slug) {
  const { funnel, avv } = await readFunnel(slug);
  if (!funnel) return { funnel: null, blocked: null };
  return { funnel, blocked: gateReason(funnel, avv) };
}

/**
 * Every funnel's gate reason, for the console — the operator has to be able to
 * see why a page is down, and see it before an edit takes one down.
 *
 * Answered by the same `gateReason` the route uses rather than re-derived in the
 * browser: a console that computes its own verdict is a second answer to the same
 * question, and the day the two disagree it reports a healthy funnel that 503s.
 *
 * @returns {Promise<Record<string, string|null>>} slug → reason, null when servable
 */
export async function funnelGates() {
  /** @type {Record<string, string|null>} */
  const gates = {};
  // ponytail: one query per funnel on a cold cache. Fine at a single operator's
  // handful of client funnels; if this list ever gets long, select the documents
  // and their clients in one round trip instead.
  for (const slug of await listFunnels()) {
    const { funnel, blocked } = await loadFunnelForVisitor(slug);
    if (funnel) gates[slug] = blocked;
  }
  return gates;
}

/** @returns {Promise<string[]>} Every servable slug, for the dev index page. */
export async function listFunnels() {
  /** @type {Set<string>} */
  const slugs = new Set();
  /** @type {Set<string>} */
  const archived = new Set();

  if (dbConfigured()) {
    try {
      for (const row of await select("funnel", "select=slug,status")) {
        (row.status === "archived" ? archived : slugs).add(row.slug);
      }
    } catch (err) {
      console.warn(`[runtime] funnel list failed: ${errSummary(err)}`);
    }
  }

  // Same union `loadFunnel` reads through, so the list cannot advertise a slug
  // that 404s or hide one that serves. Archived wins over a file still on disk:
  // the operator deleted it, and a listing that resurrects it is a bug report.
  try {
    for (const file of await readdir(FUNNELS_DIR)) {
      if (file.endsWith(".json")) slugs.add(file.slice(0, -5));
    }
  } catch {
    /* no directory is a valid state once everything lives in Postgres */
  }

  return [...slugs].filter((s) => !archived.has(s)).sort();
}

/* ========================================================================== *
 *  Writing
 *
 *  The store operations live here rather than in `routes/builder.js` so the
 *  route has no idea which store it is talking to and cannot get the branch
 *  wrong. The route keeps its own `SLUG_RE` and `isInside` checks anyway — that
 *  redundancy is deliberate and documented; a write path that trusts its caller
 *  to have validated is how the next edit opens traversal.
 * ========================================================================== */

/**
 * Which client owns a funnel the console did not name one for?
 *
 * The builder has no client picker yet — that is Phase 2, together with the
 * clients view. Until then a single non-deleted client is unambiguous and gets
 * used. Two of them is not, and inventing an answer would file a client's funnel
 * under the wrong AVV, so it refuses instead of guessing.
 *
 * Zero of them is the first run, and it creates one. Refusing there meant a
 * freshly migrated database answered every save with a 400 until the operator
 * hand-inserted a row — a console that looks broken on the first click, for a
 * value only they could have supplied and only one of which is correct.
 *
 * @returns {Promise<string>}
 */
async function resolveClientId() {
  const rows = await select("client", "deleted_at=is.null&select=id&limit=2");
  if (rows.length === 1) return rows[0].id;
  if (rows.length === 0) {
    // `contact_email` is NOT NULL and only the operator knows the real one, so
    // the placeholder is deliberately one that reads as unfinished in the
    // clients view. `avv_signed_at` stays null, which is what the publish gate
    // (PLAN.md §8.9) checks — a self-hoster gets a working builder, and a client
    // funnel still cannot go live until the paperwork exists.
    try {
      const [created] = await insert(
        "client",
        { name: "Default", slug: "default", contact_email: process.env.NOTIFY_EMAIL || "change-me@example.invalid" },
        { returning: true },
      );
      if (created?.id) {
        console.warn("[runtime] created the default client row — set its name and contact email before adding a second");
        return created.id;
      }
    } catch (err) {
      // Two first-time saves at once: both saw zero clients, one won the unique
      // index on `client.slug`. Losing that race is not a failed save — the
      // re-select below picks up the row the winner created.
      //
      // Logged rather than swallowed, because this catch cannot tell a race from
      // a real failure (a permission, a schema mismatch). In the genuine-failure
      // case the re-select finds nothing and the caller gets `client_missing`,
      // which says nothing about why — this line is the only trace of the cause.
      console.warn(`[runtime] default client insert failed: ${errSummary(err)}`);
    }
    const raced = await select("client", "slug=eq.default&deleted_at=is.null&select=id&limit=1");
    if (raced[0]) return raced[0].id;
  }
  const err = /** @type {any} */ (new Error(rows.length ? "client_ambiguous" : "client_missing"));
  err.code = rows.length ? "client_ambiguous" : "client_missing";
  throw err;
}

/**
 * Create or replace a funnel document.
 *
 * @param {string} slug   Already validated by the caller; validated again here.
 * @param {any} doc
 * @param {{ clientId?: string }} [opts]
 */
export async function saveFunnel(slug, doc, opts = {}) {
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error("invalid_slug"), { code: "invalid_slug" });

  if (dbConfigured()) {
    const existing = await select("funnel", `slug=eq.${encodeURIComponent(slug)}&select=id,status&limit=1`);
    if (existing[0]) {
      // client_id is deliberately not touched on update: re-parenting a funnel
      // to another client silently moves that client's leads with it.
      //
      // `status` is only touched to UN-archive. The row is matched on slug
      // alone, so a save under a previously deleted slug landed here and left
      // `status = 'archived'` — the API answered `{ ok: true }` while
      // `loadFunnel`'s archived sentinel kept refusing to serve it, with no
      // error anywhere and no restore path short of hand-written SQL. Saving is
      // an unambiguous statement that the funnel should exist again. A `paused`
      // or `live` funnel keeps its status, because a save is not a publish.
      await update(
        "funnel",
        `slug=eq.${encodeURIComponent(slug)}`,
        {
          doc,
          name: doc?.name || slug,
          updated_at: new Date().toISOString(),
          ...(existing[0].status === "archived" ? { status: "draft" } : {}),
        },
        { returning: false },
      );
    } else {
      await insert(
        "funnel",
        {
          slug,
          client_id: opts.clientId || (await resolveClientId()),
          name: doc?.name || slug,
          doc,
        },
        { returning: false },
      );
    }

    // The funnel document IS the delivery configuration (§4.3), so the queue's
    // targets are re-derived here rather than anywhere a caller could forget.
    // `syncFunnelTargets` swallows its own failures on purpose: a target that
    // could not be written leaves the direct fan-out delivering, which is
    // strictly better than refusing to save the funnel.
    await syncFunnelTargets(slug, doc);
  } else {
    const targetPath = join(FUNNELS_DIR, `${slug}.json`);
    if (!isInside(targetPath, FUNNELS_DIR)) {
      throw Object.assign(new Error("forbidden_path"), { code: "forbidden_path" });
    }
    await mkdir(FUNNELS_DIR, { recursive: true });
    await writeFile(targetPath, JSON.stringify(doc, null, 2), "utf8");
  }

  invalidateFunnel(slug);
}

/**
 * Remove a funnel from service.
 *
 * On Postgres this archives rather than deletes, and that is not a soft-delete
 * preference — `lead.funnel_id` references this row, so a real delete either
 * fails or takes the client's leads with it.
 *
 * BOTH stores are cleared, not whichever one is configured. `loadFunnel` falls
 * back to the directory when Postgres has no row for a slug, so archiving the
 * row while leaving `examples/<slug>.json` in place deletes a funnel that then
 * carries on serving — with the operator's own console telling them it is gone.
 *
 * @param {string} slug
 */
export async function removeFunnel(slug) {
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error("invalid_slug"), { code: "invalid_slug" });

  const targetPath = join(FUNNELS_DIR, `${slug}.json`);
  if (!isInside(targetPath, FUNNELS_DIR)) {
    throw Object.assign(new Error("forbidden_path"), { code: "forbidden_path" });
  }

  if (dbConfigured()) {
    await update(
      "funnel",
      `slug=eq.${encodeURIComponent(slug)}`,
      { status: "archived", updated_at: new Date().toISOString() },
      { returning: false },
    );
  }

  try {
    await unlink(targetPath);
  } catch {
    /* already gone — the caller asked for absence, and absence is what it gets */
  }

  invalidateFunnel(slug);
}

/**
 * Drop a slug from the cache after a write or delete.
 * @param {string} slug
 */
export function invalidateFunnel(slug) {
  cache.delete(slug);
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
 *
 * `notifyEmail` goes for a different reason: it is a person's address — the
 * operator's or the client's — and the whole document is inlined into a page
 * that anyone who clicks the ad can read. It is consumed server-side, by
 * `lib/targets.js`, and never by the browser.
 */
// `leadEndpoint` stays, but only as a SAME-ORIGIN PATH — see `sameOriginPath`.
const SERVER_ONLY_INTEGRATIONS = [
  "webhookUrl",
  "webhook",
  "webhookSecret",
  "notifyEmail",
  "apiKey",
  "aiKey",
  "openaiKey",
  "resendApiKey",
  "brevoApiKey",
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
