/**
 * @file The Meta Conversions API forward — the most consequential outbound call
 * this server makes, because it hands Meta the visitor's IP address and
 * user-agent.
 *
 * It is opt-in via `META_PIXEL_ID` + `META_CAPI_TOKEN`, environment-only (never
 * per funnel, never from the request body), never fired for preview traffic, and
 * gated on consent re-derived from the funnel document rather than on the
 * client's word.
 */

import { loadFunnel } from "./funnels.js";
import { errSummary, oneLine } from "./log.js";
import { isPreviewRecord } from "./preview.js";

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
export async function forwardMetaCapi(record) {
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
