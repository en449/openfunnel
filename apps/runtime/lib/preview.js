/**
 * @file The one predicate that decides whether a record is builder-preview
 * traffic.
 *
 * It lives alone in its own module because the single most important property
 * is that ingest and the `/api/admin/*` readers use the SAME function. They
 * drifted once — the ingest short-circuit checked three markers while the reader
 * checked six — so a record marked only via `isPreview` / `meta.isPreview` / a
 * `meta.url` containing `preview=1` was persisted and fanned out to the webhook,
 * the operator's alert inbox and the autoresponder, then filtered back out of
 * the console. A stranger could inject records the operator could never see.
 *
 * `dom.js` in the engine has its own copy of `hasPreviewFlag` for the client
 * side of the same decision.
 */

/**
 * Is `preview=1` or `admin=1` genuinely set as a query parameter?
 *
 * Parsed rather than substring-matched, and this is not a nicety: this predicate
 * decides whether a lead is persisted at all. `referer.includes("preview=1")`
 * also fires on `?utm_campaign=spring-preview=1-sale`, so anyone who circulated
 * a link to the operator's funnel with those nine characters buried anywhere in
 * it silently destroyed every lead that came through it — no log, no counter,
 * and a 202 back to the visitor so the funnel looked fine.
 *
 * Type-guarded too. `meta.url` is attacker-supplied JSON, so a non-string threw
 * out of the ingest handler and returned 500, breaking the "ingest must never
 * fail a visitor" invariant.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasPreviewFlag(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const params = new URL(value, "http://openfunnel.invalid").searchParams;
    return params.get("preview") === "1" || params.get("admin") === "1";
  } catch {
    return false;
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
export function isPreviewRecord(r) {
  if (!r || typeof r !== "object") return false;
  return Boolean(
    r.preview === true || r.isPreview === true ||
    r.meta?.preview === true || r.meta?.isPreview === true ||
    hasPreviewFlag(r.referer) ||
    hasPreviewFlag(r.meta?.url)
  );
}
