/**
 * @file The two log-sanitising helpers, kept together because every outbound
 * call in this server is required to use them.
 *
 * `errSummary` is the important one and it is not a style preference: Bun puts
 * the full request URL on a failed `fetch`'s error object, and several of this
 * server's outbound URLs carry credentials (the Meta CAPI `access_token` in the
 * query string, a webhook token in the path, an `SMTP_RELAY_URL`). Logging the
 * error object copies that credential into the server log — where it survives
 * log shipping, log aggregation and screenshots of a terminal.
 *
 * They live in their own module rather than inside any one caller because the
 * rule applies to all of them, and a helper that lives in `webhook.js` invites
 * the next outbound call to write its own.
 */

/**
 * Collapse to a single line — a CR/LF in a subject is a header-injection try.
 * @param {unknown} value
 * @param {number} [max]
 */
export function oneLine(value, max = 200) {
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
export function errSummary(err) {
  const e = /** @type {{ code?: unknown, message?: unknown } | null | undefined} */ (err);
  return oneLine(e?.code ?? e?.message ?? "unknown error", 200) || "unknown error";
}
