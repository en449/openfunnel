/**
 * @file The Controller — OpenFunnel's state machine and the object every
 * renderer talks to. It owns the funnel state (index, history, answers, lead),
 * mounts the chrome (progress bar, back button, viewport), runs transitions,
 * emits analytics/lead events, and persists progress.
 *
 * Renderers never touch state directly; they call the small imperative API on
 * this object (`answer`, `submitForm`, `advance`, `redirect`, `after`, …). That
 * keeps the funnel logic in one auditable place.
 */

import { el, clear, uid, prefersReducedMotion } from "./dom.js";
import { resolveNext } from "./branching.js";
import { renderStep } from "./render/index.js";
import { applyTheme, loadThemeFont } from "./theme.js";
import { installPixels, firePixel } from "./analytics.js";
import { buildConsentBar, consentSignal, marketingAllowed } from "./consent.js";
import { submitLead as sendLead, trackEvent } from "./leads.js";
import { loadState, saveState, clearState } from "./persist.js";

export class Controller {
  /**
   * @param {HTMLElement} container  Where the funnel mounts.
   * @param {import('./types.js').Funnel} funnel
   * @param {import('./index.js').FunnelOptions} [options]
   */
  constructor(container, funnel, options = {}) {
    this.container = container;
    this.funnel = funnel;
    this.options = options;
    this.steps = funnel.steps;
    this.key = funnel.slug || funnel.id || "funnel";
    /** @type {Required<import('./types.js').FunnelSettings>} */
    this.settings = {
      showProgress: true,
      allowBack: true,
      persist: true,
      enableSwipe: true,
      transition: "slide",
      ...funnel.settings,
    };
    this.reducedMotion = prefersReducedMotion();
    // Canvas editing affordances (drag-to-reorder) are opt-in from the builder
    // only. Deliberately NOT derived from `?preview=1` / `?admin=1`: those are
    // visitor-supplied, so keying off them would show editor chrome to anyone
    // who appends the param to a live funnel. `isPreview` stays what it is —
    // an analytics suppression flag — and is checked in `_emit()`.
    this.isEditor = Boolean(options.isEditor);
    /** @type {number[]} Pending timeout ids, cleared on every navigation. */
    this._timers = [];
    this._destroyed = false;

    /** @type {import('./types.js').FunnelState} */
    this.state = {
      sessionId: uid(),
      index: 0,
      history: [],
      answers: {},
      lead: {},
      startedAt: Date.now(),
    };

    // Resume a persisted session if configured and present.
    if (this.settings.persist && options.resume !== false) {
      const saved = loadState(this.key);
      if (saved && saved.index < this.steps.length) this.state = saved;
    }
  }

  /* ----- data exposed to renderers ------------------------------------- */

  /** @returns {{ lead: Record<string, unknown>, answers: Record<string, unknown> }} */
  get data() {
    return { lead: this.state.lead, answers: this.state.answers };
  }

  /** @returns {number} */
  now() {
    return Date.now();
  }

  /* ----- lifecycle ------------------------------------------------------ */

  /** Build the chrome once and render the first (or resumed) step. */
  mount() {
    // A non-system `theme.font` is fetched from Google, which hands the visitor's
    // IP, user-agent and Referer to a third party — so it waits for the same
    // decision the pixels wait for. Colours and spacing apply either way.
    applyTheme(this.container, this.funnel.theme, {
      allowRemote: marketingAllowed(this.funnel, this.key),
    });
    // Third-party pixels wait for a decision when the funnel uses a consent bar.
    // `_grantConsent` installs them the moment the visitor accepts.
    if (marketingAllowed(this.funnel, this.key)) installPixels(this.funnel.integrations);

    this.container.classList.add("of-root");
    clear(this.container);

    this.progressEl = el("div", { class: "of-progress", role: "presentation" }, [
      el("div", { class: "of-progress-fill" }),
    ]);
    this.backEl = el("button", {
      type: "button",
      class: "of-back",
      "aria-label": "Go back",
      html: "&#8592;",
      onclick: () => this.back(),
    });
    this.viewport = el("div", { class: "of-viewport" });

    this.container.append(
      el("div", { class: "of-topbar" }, [this.backEl, this.progressEl]),
      this.viewport,
    );

    const consentBar = buildConsentBar(this.funnel, (decision) => {
      if (decision === "granted") this._grantConsent();
    });
    if (consentBar) this.container.appendChild(consentBar);

    this._emit("funnel_start");
    this._render("none");
    this._installSwipe();

    // Best-effort "abandon" beacon so the dashboard can compute true drop-off.
    this._onUnload = () => {
      if (this._destroyed) return;
      const step = this.steps[this.state.index];
      if (step && step.type !== "success") this._emit("abandon", { stepId: step.id });
    };
    window.addEventListener("pagehide", this._onUnload);
    return this;
  }

  destroy() {
    this._destroyed = true;
    this._clearTimers();
    if (this._onUnload) window.removeEventListener("pagehide", this._onUnload);
  }

  /* ----- imperative API used by renderers ------------------------------ */

  /**
   * Record the current step's answer and advance.
   * @param {unknown} value
   * @param {{ optionId?: string, next?: string|null }} branch
   */
  answer(value, branch) {
    const step = this.steps[this.state.index];
    if (!step) return;
    this.state.answers[step.id] = value;
    this._emit("step_complete", { stepId: step.id, value });
    this.advance({ next: branch.next });
  }

  /**
   * Merge form values into the lead, fire lead capture, then advance.
   * @param {Record<string, unknown>} values
   */
  submitForm(values) {
    const step = this.steps[this.state.index];
    Object.assign(this.state.lead, values);
    if (step) this.state.answers[step.id] = values;

    this._emit("lead", { stepId: step?.id, fields: Object.keys(values) });
    this._pixel("lead", { funnelId: this.funnel.id });

    // Ship the lead to your backend. Non-blocking — we advance immediately.
    // Lead capture itself is never gated on consent: the visitor just filled the
    // form in and pressed submit. The consent signal rides along so the server
    // can decide whether to forward the lead onward to an ad platform.
    void sendLead(this.state.lead, this.state.answers, {
      endpoint: this.funnel.integrations?.leadEndpoint || this.options.leadEndpoint,
      funnelId: this.funnel.id,
      sessionId: this.state.sessionId,
      meta: { consent: consentSignal(this.funnel, this.key) },
    });

    this.advance({ next: step?.next });
  }

  /**
   * Move to the next step (resolving branching), or finish the funnel.
   * @param {{ next?: string|null }} [branch]
   */
  advance(branch = {}) {
    const nextIndex = resolveNext(this.steps, this.state.index, branch.next);
    if (nextIndex === -1) return this._finish();
    this.state.history.push(this.steps[this.state.index].id);
    this.state.index = nextIndex;
    this._persist();
    this._render(this.settings.transition, "forward");
  }

  /** Go back to the previous visited step. */
  back() {
    const prevId = this.state.history.pop();
    if (prevId == null) return;
    const idx = this.steps.findIndex((s) => s.id === prevId);
    if (idx === -1) return;
    this.state.index = idx;
    this._persist();
    this._render(this.settings.transition, "back");
  }

  /**
   * Terminal redirect from a success step.
   * @param {string|undefined} url
   */
  redirect(url) {
    this._pixel("complete", { funnelId: this.funnel.id });
    // Only ever navigate to a real web address. A funnel document is
    // operator-written, so this is not a privilege boundary — but `javascript:`
    // and `data:` have no legitimate use here, and refusing them means a
    // document that reaches the engine by some other route cannot execute.
    if (!url) return;
    const safe = /^https?:\/\//i.test(String(url)) || String(url).startsWith("/");
    if (!safe) {
      console.warn("[openfunnel] refusing redirect to non-http(s) target");
      return;
    }
    window.location.href = url;
  }

  /**
   * Register a timeout that is automatically cancelled on the next navigation
   * or on destroy. Renderers should use this instead of raw setTimeout so no
   * callback fires against a step that's no longer on screen.
   * @param {number} ms
   * @param {() => void} fn
   */
  after(ms, fn) {
    const id = window.setTimeout(() => {
      if (!this._destroyed) fn();
    }, ms);
    this._timers.push(id);
    return id;
  }

  /**
   * Repaint the current step in place, with no transition and without touching
   * `index` or `history`. In-canvas editing uses this after mutating the step it
   * is showing, so renderers still never reach for `_render` themselves.
   */
  refresh() {
    this._render("none");
  }

  /* ----- internals ------------------------------------------------------ */

  /**
   * Fire an ad-platform pixel, unless the visitor has not (yet) consented. Every
   * pixel in the engine goes through here so a new call site cannot forget the
   * check — see `consent.js` for what is and is not gated.
   *
   * @param {import('./types.js').FunnelEventType} name
   * @param {Record<string, unknown>} payload
   */
  _pixel(name, payload) {
    if (!marketingAllowed(this.funnel, this.key)) return;
    firePixel(name, payload, this.funnel.integrations);
  }

  /**
   * Visitor accepted: install the pixels that were held back at mount, load the
   * webfont that was held back with them, and fire the view for the step they are
   * on so the session is not lost entirely.
   */
  _grantConsent() {
    installPixels(this.funnel.integrations);
    loadThemeFont(this.funnel.theme);
    const step = this.steps[this.state.index];
    if (step) this._pixel("step_view", { stepId: step.id, stepIndex: this.state.index });
  }

  _finish() {
    if (this.settings.persist) clearState(this.key);
    // No further step — most funnels end on a `success` step, but if a branch
    // ends explicitly we simply stop. `complete` fires from the success button.
  }

  /**
   * @param {"slide"|"fade"|"none"} transition
   * @param {"forward"|"back"} [direction]
   */
  _render(transition, direction = "forward") {
    this._clearTimers();
    const step = this.steps[this.state.index];
    if (!step) return this._finish();

    const screen = renderStep(step, this);
    const mode = this.reducedMotion ? "none" : transition;

    // Update chrome.
    this._updateProgress(step);
    const canBack = this.settings.allowBack && this.state.history.length > 0;
    if (this.backEl) this.backEl.classList.toggle("is-hidden", !canBack);

    // Fire view events (both to pixels via dataLayer and to your backend).
    this._emit("step_view", { stepId: step.id });
    this._pixel("step_view", { stepId: step.id, stepIndex: this.state.index });
    if (step.type === "success") {
      this._emit("complete", { stepId: step.id });
    }

    const vp = /** @type {HTMLElement} */ (this.viewport);
    if (mode === "none" || !vp.firstChild) {
      clear(vp);
      vp.appendChild(screen);
      return;
    }

    // Transition: outgoing leaves, incoming enters. CSS classes do the work.
    const outgoing = /** @type {HTMLElement} */ (vp.firstElementChild);
    screen.classList.add(mode === "fade" ? "of-enter-fade" : `of-enter-${direction}`);
    vp.appendChild(screen);
    requestAnimationFrame(() => {
      screen.classList.add("of-enter-active");
      if (outgoing) {
        outgoing.classList.add(mode === "fade" ? "of-leave-fade" : `of-leave-${direction}`);
      }
    });
    this.after(360, () => {
      if (outgoing && outgoing.parentNode === vp) vp.removeChild(outgoing);
      screen.classList.remove("of-enter-active", "of-enter-forward", "of-enter-back", "of-enter-fade");
      // Move focus to the new headline for screen-reader + keyboard users.
      const focusTarget = /** @type {HTMLElement|null} */ (screen.querySelector("h1, .of-cta, .of-option, .of-input"));
      focusTarget?.focus?.({ preventScroll: true });
    });
  }

  /** @param {import('./types.js').Step} step */
  _updateProgress(step) {
    const show = this.settings.showProgress && step.progress !== false;
    if (this.progressEl) this.progressEl.classList.toggle("is-hidden", !show);
    const fill = /** @type {HTMLElement|undefined} */ (this.progressEl?.firstElementChild);
    if (fill) {
      const pct = Math.round(((this.state.index + 1) / this.steps.length) * 100);
      fill.style.width = `${pct}%`;
    }
  }

  /**
   * @param {import('./types.js').FunnelEventType} type
   * @param {Record<string, unknown>} [meta]
   */
  _emit(type, meta) {
    if (this.options.isPreview || (typeof window !== "undefined" && (window.location.search.includes("preview=1") || window.location.search.includes("admin=1")))) {
      return; // Skip analytics tracking for internal admin or preview views
    }
    const consent = consentSignal(this.funnel, this.key);
    /** @type {import('./types.js').FunnelEvent} */
    const event = {
      type,
      sessionId: this.state.sessionId,
      funnelId: this.funnel.id,
      stepId: this.steps[this.state.index]?.id,
      stepIndex: this.state.index,
      // First-party ingest is not gated, but the signal travels with the record
      // so the server will not forward it to Meta without permission.
      meta: consent ? { ...meta, consent } : meta,
      ts: Date.now(),
    };
    if (this.options.onEvent) this.options.onEvent(event);
    if (this.options.trackEvents !== false) {
      trackEvent(event, { endpoint: this.options.eventEndpoint });
    }
  }

  _persist() {
    if (this.settings.persist) saveState(this.key, this.state);
  }

  _clearTimers() {
    for (const id of this._timers) clearTimeout(id);
    this._timers = [];
  }

  /** Lightweight horizontal swipe → advance on simple steps (choice/content). */
  _installSwipe() {
    if (!this.settings.enableSwipe || !this.viewport) return;
    let startX = 0;
    let active = false;
    const vp = this.viewport;
    vp.addEventListener(
      "touchstart",
      (e) => {
        active = e.touches.length === 1;
        startX = e.touches[0]?.clientX ?? 0;
      },
      { passive: true },
    );
    vp.addEventListener(
      "touchend",
      (e) => {
        if (!active) return;
        active = false;
        const dx = (e.changedTouches[0]?.clientX ?? 0) - startX;
        const step = this.steps[this.state.index];
        // Swipe right → back. (Left-swipe intentionally does NOT skip a required
        // interaction; only content steps allow forward via the CTA.)
        if (dx > 70 && this.state.history.length && this.settings.allowBack) this.back();
      },
      { passive: true },
    );
  }
}
