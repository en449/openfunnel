// @ts-nocheck
/**
 * @file Analytics dispatcher — the single place funnel events fan out to pixels.
 *
 * WHERE INTEGRATORS PLUG IN
 * -------------------------
 * `firePixel(eventName, payload, integrations)` is called by the engine at every
 * meaningful transition. It maps OpenFunnel's internal event names to the event
 * names each ad platform expects, then forwards them. Each vendor block below is
 * self-contained and guarded by a feature check, so you can delete the ones you
 * don't use or add your own with a couple of lines.
 *
 * Internal event → typical vendor mapping:
 *   funnel_start   → Meta "ViewContent"        · GA4 "funnel_start"
 *   step_view      → (dataLayer only, for step-level drop-off analysis)
 *   lead           → Meta "Lead"               · GA4 "generate_lead"
 *   complete       → Meta "CompleteRegistration"· GA4 "sign_up"
 *
 * The engine also ships events to your OWN backend via `trackEvent` (see
 * events.js / leads.js) — pixels are for the ad platforms, your backend is for
 * the analytics dashboard. They are independent on purpose.
 */

/**
 * @typedef {import('./types.js').FunnelIntegrations} FunnelIntegrations
 */

/** @type {Record<string, { meta?: string, ga4?: string }>} */
const EVENT_MAP = {
  funnel_start: { meta: "ViewContent", ga4: "funnel_start" },
  step_view: { ga4: "funnel_step_view" },
  step_complete: { ga4: "funnel_step_complete" },
  lead: { meta: "Lead", ga4: "generate_lead" },
  complete: { meta: "CompleteRegistration", ga4: "sign_up" },
};

/**
 * Fan a single funnel event out to every configured pixel.
 *
 * @param {import('./types.js').FunnelEventType} eventName
 * @param {Record<string, unknown>} payload
 * @param {FunnelIntegrations} [integrations]
 */
export function firePixel(eventName, payload, integrations = {}) {
  const mapping = EVENT_MAP[eventName];

  // --- Google Tag Manager: push EVERY event to the dataLayer -----------------
  // GTM is the most flexible sink; step-level events power drop-off funnels in
  // GA4/Looker without extra code. `dataLayer` exists as soon as the GTM snippet
  // (or our injected one) has run.
  if (typeof window !== "undefined" && Array.isArray(/** @type {any} */ (window).dataLayer)) {
    /** @type {any} */ (window).dataLayer.push({ event: `of_${eventName}`, ...payload });
  }

  // --- Meta (Facebook) Pixel — client side ----------------------------------
  // Standard events get `track`; everything else is a `trackCustom` so you still
  // see step-level activity in Events Manager.
  const fbq = typeof window !== "undefined" ? /** @type {any} */ (window).fbq : undefined;
  if (typeof fbq === "function" && integrations.metaPixelId) {
    if (mapping?.meta) fbq("track", mapping.meta, payload);
    else fbq("trackCustom", `of_${eventName}`, payload);
    // ---------------------------------------------------------------------
    // SERVER-SIDE (Conversions API) — recommended for iOS/ad-blocker coverage.
    // Do NOT put your CAPI access token in client code. Instead POST to your
    // own edge function (see supabase/functions/pixel-capi) which holds the
    // token and forwards to graph.facebook.com. Example call site:
    //
    //   fetch("/api/capi", {
    //     method: "POST",
    //     headers: { "content-type": "application/json" },
    //     body: JSON.stringify({ event: mapping?.meta ?? eventName, payload }),
    //   });
    // ---------------------------------------------------------------------
  }

  // --- Google Analytics 4 (gtag) --------------------------------------------
  const gtag = typeof window !== "undefined" ? /** @type {any} */ (window).gtag : undefined;
  if (typeof gtag === "function" && integrations.ga4Id && mapping?.ga4) {
    gtag("event", mapping.ga4, payload);
  }

  // --- TikTok Pixel ---------------------------------------------------------
  const ttq = typeof window !== "undefined" ? /** @type {any} */ (window).ttq : undefined;
  if (typeof ttq === "object" && integrations.tiktokPixelId) {
    if (eventName === "lead") ttq.track("SubmitForm", payload);
    else if (eventName === "complete") ttq.track("CompleteRegistration", payload);
    else ttq.track("ViewContent", payload);
  }

  // --- Webhook Forwarding ---------------------------------------------------
  // Intentionally absent. Webhook delivery happens server-side in the runtime's
  // `forwardWebhook`, which can sign the request and keep the endpoint private.
  //
  // Doing it from the browser required shipping `integrations.webhookUrl` in the
  // funnel document, where any visitor could read it — a Zapier catch hook is a
  // capability URL, so publishing it lets a stranger post fabricated leads into
  // the operator's CRM. It also delivered every lead twice. The runtime now
  // strips webhook fields before the document reaches the page; if you re-add a
  // client-side path, it must not depend on a secret being present here.
}

/**
 * Inject the pixel base snippets from a funnel's integration config. Safe to
 * call once at funnel start; each block no-ops if already present or unset.
 *
 * @param {FunnelIntegrations} [integrations]
 */
export function installPixels(integrations = {}) {
  if (typeof document === "undefined") return;
  const w = /** @type {any} */ (window);

  // Google Tag Manager / dataLayer bootstrap (always safe to create the array).
  w.dataLayer = w.dataLayer || [];
  if (integrations.gtmId && !document.getElementById("of-gtm")) {
    const s = document.createElement("script");
    s.id = "of-gtm";
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(integrations.gtmId)}`;
    document.head.appendChild(s);
  }

  // Meta Pixel bootstrap.
  if (integrations.metaPixelId && typeof w.fbq !== "function") {
    /* eslint-disable */
    // prettier-ignore
    // @ts-ignore -- verbatim vendor snippet from Meta; not worth typing.
    (function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)})(w,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    w.fbq("init", integrations.metaPixelId);
    w.fbq("track", "PageView");
  }

  // GA4 (gtag) bootstrap.
  if (integrations.ga4Id && typeof w.gtag !== "function") {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(integrations.ga4Id)}`;
    document.head.appendChild(s);
    w.gtag = function () { w.dataLayer.push(arguments); };
    w.gtag("js", new Date());
    w.gtag("config", integrations.ga4Id);
  }

  // TikTok Pixel bootstrap.
  if (integrations.tiktokPixelId && typeof w.ttq !== "object") {
    /* eslint-disable */
    (function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};})(w,document,'ttq');
    w.ttq.load(integrations.tiktokPixelId);
    w.ttq.page();
  }
}
