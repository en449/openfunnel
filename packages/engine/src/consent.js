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
 *
 * §8.4 asks for two more things a plain accept/decline bar doesn't give you:
 * withdrawal as easy as granting (`clearDecision`, wired to a footer control in
 * `controller.js` — the bar itself can't host it, since it stops rendering the
 * moment a decision exists), and evidence of what was agreed to
 * (`consentEvidence`, `{ signal, at, text_version }`, riding to the server as
 * `meta.consentRecord` — a SECOND field, never a replacement for the bare
 * string `consentSignal()` returns, because `apps/runtime/lib/capi.js` compares
 * that string to `"granted"` directly).
 */

import { el, isNavigableUrl } from "./dom.js";

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
 * @typedef {{ d: "granted"|"denied", at: string|null, v: string|null }} StoredDecision
 */

/**
 * Read whatever is under this key and normalise it to a `StoredDecision`, or
 * `null` when there is no decision yet. Two formats can be sitting there:
 *
 *   - the current one, a JSON object `{ d, at, v }`;
 *   - a bare `"granted"` / `"denied"` string, written by every build before
 *     this one — read-compatibility with it is load-bearing (trap 2): a
 *     visitor who already decided must not be asked again just because the
 *     storage format grew a timestamp.
 *
 * Unparseable JSON reads as "undecided" rather than throwing, same posture as
 * the try/catch below it for a storage engine that refuses reads entirely.
 *
 * @param {string} key
 * @returns {StoredDecision | null}
 */
function readStored(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === "granted" || raw === "denied") return { d: raw, at: null, v: null };
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.d === "granted" || parsed.d === "denied")) {
      return {
        d: parsed.d,
        at: typeof parsed.at === "string" ? parsed.at : null,
        v: typeof parsed.v === "string" ? parsed.v : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} key  The funnel key (slug or id).
 * @returns {"granted" | "denied" | null}  null when the visitor has not decided.
 */
export function readDecision(key) {
  return readStored(key)?.d ?? null;
}

/**
 * @param {string} key
 * @param {"granted" | "denied"} decision
 * @param {import('./types.js').Funnel} [funnel]  Its `consent.textVersion`
 *   travels with the decision, so the evidence can later name which wording
 *   the visitor actually agreed to.
 */
export function writeDecision(key, decision, funnel) {
  try {
    /** @type {StoredDecision} */
    const record = { d: decision, at: new Date().toISOString(), v: funnel?.consent?.textVersion || null };
    localStorage.setItem(PREFIX + key, JSON.stringify(record));
  } catch {
    /* storage unavailable — the visitor is simply asked again next visit */
  }
}

/**
 * Forget a decision, so `readDecision` reports undecided again and the bar
 * reappears. Used by the withdrawal control in the branding footer — GDPR
 * requires consent to be as easy to withdraw as it was to give, and the
 * decision lives only in this one key.
 *
 * @param {string} key
 */
export function clearDecision(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage unavailable — nothing was persisted to begin with */
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
 * Evidence of what was agreed to, for the lead record (§8.4): `{ signal, at,
 * text_version }`. `signal` is exactly what `consentSignal()` returns
 * (including `"pending"`), so the two read the same localStorage entry and
 * cannot disagree.
 *
 * This is a SEPARATE field from `consentSignal()`'s plain string, never a
 * replacement for it — `apps/runtime/lib/capi.js` compares that string to
 * `"granted"` directly, so its shape must never change (trap 1).
 *
 * @param {import('./types.js').Funnel} funnel
 * @param {string} key
 * @returns {{ signal: "granted"|"denied"|"pending", at: string|null, text_version: string|null } | undefined}
 *   undefined when the funnel does not use the bar, same posture as `consentSignal`.
 */
export function consentEvidence(funnel, key) {
  if (!consentRequired(funnel)) return undefined;
  const stored = readStored(key);
  return {
    signal: stored?.d || "pending",
    at: stored?.at ?? null,
    text_version: stored?.v ?? null,
  };
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
  // Same reasoning as `Controller.redirect`: operator-written, but a link target
  // is never a reason to allow `javascript:` or a protocol-relative hop.
  // `consent.policyUrl` wins when set (self-hoster back-compat); `legal.privacyUrl`
  // is the canonical field and is the fallback.
  const rawPolicyUrl = cfg.policyUrl || funnel.legal?.privacyUrl;
  const policyUrl = isNavigableUrl(rawPolicyUrl) ? rawPolicyUrl : "";
  if (policyUrl) {
    copy.appendChild(
      el("a", {
        class: "of-consent-link",
        href: policyUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        text: "Privacy policy",
      })
    );
  }

  /** @param {"granted" | "denied"} decision */
  const decide = (decision) => {
    writeDecision(key, decision, funnel);
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
