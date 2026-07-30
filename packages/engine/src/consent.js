/**
 * @file Visitor consent for third-party data sharing.
 *
 * A funnel can hand visitor data to parties the visitor never chose: the browser
 * pixels in `analytics.js` (Meta, GA4/GTM, TikTok) and the runtime's Meta
 * Conversions API forward, which posts IP address and user-agent server-side.
 * When a funnel opts in via `funnel.consent.enabled`, none of that happens until
 * the visitor accepts.
 *
 * Deliberately narrow — consent gates *third-party sharing only*:
 *
 *   gated      browser pixels, and the server-side Meta CAPI forward
 *   not gated  lead capture (`/api/lead`) and first-party drop-off analytics
 *              (`/api/events`)
 *
 * Lead capture is the funnel's stated purpose and the visitor deliberately typed
 * their details and pressed submit; a bar that silently dropped that would be a
 * broken funnel, not a private one. First-party events stay because they are the
 * operator's own data on the operator's own server.
 *
 * The decision lives in localStorage, first-party, and fails silently exactly
 * like `persist.js` — a browser that refuses storage is treated as undecided,
 * which is the conservative direction.
 */

import { el } from "./dom.js";

const PREFIX = "openfunnel:consent:";

/**
 * Does this funnel ask for consent at all? Read from the funnel document rather
 * than a console setting: the funnel page is rendered for visitors from this
 * JSON, so a per-browser value in the operator's console could never reach them.
 *
 * @param {import('./types.js').Funnel} funnel
 * @returns {boolean}
 */
export function consentRequired(funnel) {
  return Boolean(funnel?.consent?.enabled);
}

/**
 * @param {string} key  The funnel key (slug or id).
 * @returns {"granted" | "denied" | null}  null when the visitor has not decided.
 */
export function readDecision(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === "granted" || raw === "denied" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {"granted" | "denied"} decision
 */
export function writeDecision(key, decision) {
  try {
    localStorage.setItem(PREFIX + key, decision);
  } catch {
    /* storage unavailable — the visitor is simply asked again next visit */
  }
}

/**
 * May third-party marketing fire right now? True for every funnel that does not
 * use the bar, so enabling consent is opt-in and nothing changes underneath
 * existing funnels.
 *
 * @param {import('./types.js').Funnel} funnel
 * @param {string} key
 * @returns {boolean}
 */
export function marketingAllowed(funnel, key) {
  if (!consentRequired(funnel)) return true;
  return readDecision(key) === "granted";
}

/**
 * The value attached to outbound records so the server can honour the same
 * decision for the Meta CAPI forward. `undefined` when the funnel does not use
 * the bar — the server treats a missing signal as "not in use" and forwards as
 * before, so this cannot silently break a configured integration.
 *
 * @param {import('./types.js').Funnel} funnel
 * @param {string} key
 * @returns {"granted" | "denied" | "pending" | undefined}
 */
export function consentSignal(funnel, key) {
  if (!consentRequired(funnel)) return undefined;
  return readDecision(key) || "pending";
}

/**
 * Build the consent bar. Non-blocking by design: the funnel stays fully usable
 * whichever button the visitor presses, and a decision is never re-prompted.
 *
 * @param {import('./types.js').Funnel} funnel
 * @param {(decision: "granted" | "denied") => void} onDecide
 * @returns {HTMLElement | null}  null when no bar should be shown.
 */
export function buildConsentBar(funnel, onDecide) {
  const key = funnel.slug || funnel.id || "funnel";
  if (!consentRequired(funnel) || readDecision(key)) return null;

  const cfg = funnel.consent || {};
  const bar = el("div", { class: "of-consent-bar", role: "region", "aria-label": "Privacy consent" });

  const copy = el("div", { class: "of-consent-copy" }, [
    el("span", {
      text:
        cfg.text ||
        "We use marketing pixels to measure our ads. Accept to allow them, or decline — either way you can use this page.",
    }),
  ]);
  if (cfg.policyUrl) {
    copy.appendChild(
      el("a", {
        class: "of-consent-link",
        href: cfg.policyUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        text: "Privacy policy",
      })
    );
  }

  /** @param {"granted" | "denied"} decision */
  const decide = (decision) => {
    writeDecision(key, decision);
    bar.remove();
    onDecide(decision);
  };

  bar.append(
    copy,
    el("div", { class: "of-consent-actions" }, [
      el("button", {
        type: "button",
        class: "of-consent-btn of-consent-decline",
        text: cfg.declineLabel || "Decline",
        onclick: () => decide("denied"),
      }),
      el("button", {
        type: "button",
        class: "of-consent-btn of-consent-accept",
        text: cfg.acceptLabel || "Accept",
        onclick: () => decide("granted"),
      }),
    ])
  );

  return bar;
}
