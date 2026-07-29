/**
 * @file Lead + event sinks — how captured data leaves the funnel and reaches
 * YOUR backend (CRM + analytics dashboard). Kept separate from analytics.js:
 * that file is for ad-platform pixels, this file is for your own database.
 *
 * Both functions are intentionally tiny, non-blocking, and failure-tolerant: a
 * funnel must NEVER break for a visitor because an analytics call failed. They
 * use `navigator.sendBeacon` when available (survives page unload/redirect) and
 * fall back to `fetch(..., { keepalive: true })`.
 */

function getUtmParams() {
  if (typeof location === "undefined" || !location.search) return {};
  try {
    const params = new URLSearchParams(location.search);
    /** @type {Record<string, string>} */
    const utm = {};
    const keys = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "ttclid",
      "ref",
    ];
    for (const key of keys) {
      const val = params.get(key);
      if (val) utm[key] = val;
    }
    return utm;
  } catch {
    return {};
  }
}

/**
 * POST a captured lead to your endpoint (Supabase edge function by default).
 *
 * @param {Record<string, unknown>} lead      Form field values.
 * @param {Record<string, unknown>} answers   Quiz answers keyed by step id.
 * @param {{ endpoint?: string, funnelId?: string, sessionId?: string, meta?: Record<string, unknown> }} ctx
 * @returns {Promise<boolean>} Resolves true on a 2xx, false otherwise (never throws).
 */
export async function submitLead(lead, answers, ctx = {}) {
  const endpoint = ctx.endpoint || "/api/lead"; // TODO: point at your deployment
  const body = {
    funnelId: ctx.funnelId,
    sessionId: ctx.sessionId,
    lead,
    answers,
    meta: {
      url: typeof location !== "undefined" ? location.href : undefined,
      referrer: typeof document !== "undefined" ? document.referrer : undefined,
      utm: getUtmParams(),
      ...ctx.meta,
    },
    ts: Date.now(),
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
    return res.ok;
  } catch (err) {
    console.warn("[openfunnel] submitLead failed (non-fatal):", err);
    return false;
  }
}

/**
 * Ship a single funnel analytics event to your ingest endpoint. Fire-and-forget.
 *
 * @param {import('./types.js').FunnelEvent} event
 * @param {{ endpoint?: string }} [ctx]
 */
export function trackEvent(event, ctx = {}) {
  const endpoint = ctx.endpoint || "/api/events";
  const payload = JSON.stringify(event);
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(endpoint, blob)) return;
    }
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never throw into the funnel */
  }
}
