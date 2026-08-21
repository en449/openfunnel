/**
 * @file Supabase Storage — the funnel's own images.
 *
 * Design: PHASE-2-PLAN.md §1. Two operations and nothing else: mint a signed
 * upload URL, and delete an object.
 *
 * THE BYTES NEVER PASS THROUGH THIS SERVER.
 * `readJson` caps every request body at `MAX_BODY` (64KB) on both entries, and
 * Vercel caps a function body at 4.5MB — so an upload route that accepted the
 * file would either refuse a phone photo or force a 60× larger ceiling onto
 * public, anonymous `/api/lead`. Instead this mints a token scoped to one exact
 * object path and the browser PUTs the file straight to Supabase. The service
 * key stays here, as it does everywhere else in this repo.
 *
 * WHAT A CALLER MUST STILL DO
 * Nothing in this module decides WHO may upload — `routes/admin.js` is behind
 * the privileged gate and that is the whole authorisation story. What this
 * module owns is the object path: it is built here, from a validated slug and a
 * content type, never from a filename the browser supplied. A filename is often
 * a person's name, and it would end up in a world-readable URL.
 *
 * LOGGING RULE, INHERITED
 * Nothing here logs. Callers log `errSummary(err)` — never the error object,
 * because a fetch rejection carries the full request URL on `err.path`, and
 * these URLs carry an upload token.
 */

import { randomBytes } from "node:crypto";

import { supabaseConn } from "./db.js";

/** The bucket, created by `supabase/migrations/20260813020000_asset_storage.sql`. */
export const ASSET_BUCKET = "funnel-assets";

/**
 * What may be uploaded, and the extension each type gets.
 *
 * The extension comes from the CONTENT TYPE, not from the uploaded filename:
 * the browser controls the filename, and `.php`/`.html` in a public bucket is a
 * different kind of object than an image. The bucket declares the same list
 * (`allowed_mime_types`), so a caller that bypassed this check still meets it
 * one layer down — two locks, one key each.
 *
 * @type {Record<string, string>}
 */
export const ASSET_TYPES = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** Hard ceiling, matching the bucket's own `file_size_limit`. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Storage calls are one round trip and not on a visitor's path; 10s is generous. */
const TIMEOUT_MS = () => Math.max(1000, Number(process.env.STORAGE_TIMEOUT_MS) || 10_000);

/**
 * @param {string} message
 * @param {number|null} [status]
 * @returns {Error & { status: number|null }}
 */
function storageError(message, status = null) {
  const err = /** @type {any} */ (new Error(message));
  err.status = status;
  return err;
}

/**
 * The object path for a new asset: `funnel/<slug>/<32 hex>.<ext>`.
 *
 * Random rather than derived from the file. The bucket is public, so this is not
 * a guessability control — it is what stops one funnel's `hero.jpg` from
 * overwriting another's, and what keeps the original filename (often a person's
 * name) out of a URL that anyone can read.
 *
 * @param {string} slug  Already validated against SLUG_RE by the caller.
 * @param {string} contentType
 * @returns {string}
 */
export function assetPath(slug, contentType) {
  const ext = ASSET_TYPES[contentType];
  if (!ext) throw storageError("unsupported_type");
  return `funnel/${slug}/${randomBytes(16).toString("hex")}.${ext}`;
}

/**
 * The public URL an object is served from once uploaded.
 *
 * @param {string} path
 */
export function publicAssetUrl(path) {
  const { url } = supabaseConn();
  return `${url}/storage/v1/object/public/${ASSET_BUCKET}/${path}`;
}

/**
 * One Storage request, with the service key and a deadline.
 *
 * @param {string} method
 * @param {string} path  Everything after `/storage/v1`.
 * @returns {Promise<any>} The parsed JSON body, or `{}` when there is none.
 */
async function storageFetch(method, path) {
  const { url, key } = supabaseConn();
  // The caller gates on `dbConfigured()`, which only says a project URL and key
  // exist. A self-hoster running plain PostgREST against their own Postgres
  // satisfies that and has no Storage API at all, so their first upload fails
  // here as a network error rather than being refused up front. Accepted: the
  // alternative is probing Storage on a path that is otherwise one round trip,
  // and the paste-a-URL field every image had before this feature still works.
  if (!url || !key) throw storageError("not_configured");

  const res = await fetch(`${url}/storage/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, apikey: key },
    signal: AbortSignal.timeout(TIMEOUT_MS()),
  });

  if (!res.ok) {
    // The status only. A Storage error body echoes the object path, and the
    // path is the one part of this that could name a client.
    throw storageError(`storage_${res.status}`, res.status);
  }
  return res.status === 204 ? {} : await res.json().catch(() => ({}));
}

/**
 * Mint a signed upload URL for one object path.
 *
 * The returned token authorises exactly this path and nothing else, so a console
 * that has it cannot write anywhere in the bucket — which is what lets the
 * bucket carry no insert policy at all.
 *
 * @param {string} path
 * @returns {Promise<{ path: string, uploadUrl: string, publicUrl: string }>}
 */
export async function signAssetUpload(path) {
  const { url } = supabaseConn();
  const body = await storageFetch("POST", `/object/upload/sign/${ASSET_BUCKET}/${path}`);

  // Supabase answers with a relative `url` that already carries the token.
  // Absolute-ising it here rather than in the route keeps every caller from
  // having to know the shape of that answer.
  const signed = String(body?.url || "");
  if (!signed) throw storageError("storage_no_url");

  return {
    path,
    uploadUrl: `${url}/storage/v1${signed.startsWith("/") ? signed : `/${signed}`}`,
    publicUrl: publicAssetUrl(path),
  };
}

/**
 * Delete one object. A missing object answers 404 from Storage, which the caller
 * treats as done rather than as an error — the operator asked for it to be gone.
 *
 * @param {string} path
 */
export async function deleteAsset(path) {
  await storageFetch("DELETE", `/object/${ASSET_BUCKET}/${path}`);
}
