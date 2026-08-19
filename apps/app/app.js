/**
 * @file OpenFunnel console.
 *
 * One working document (`state.funnel`) is edited in the builder, previewed
 * live in the device frame, and saved back to FUNNELS_DIR. Everything the
 * console shows about a funnel — its colour, its step count, its numbers — is
 * read from the server, never assumed.
 */

import { THEME_PRESETS } from "/_of/theme.js";
import { FUNNEL_TEMPLATES } from "./templates.js";

/* ========================================================================== *
 *  State
 * ========================================================================== */

const state = {
  /** @type {Array<{slug:string,name:string,primary:string|null,mode:string,steps:number}>} */
  funnels: [],
  /** The document being edited. May not exist on disk yet. */
  funnel: null,
  /**
   * slug → the serve-time gate's reason, from `GET /api/admin/funnel-gates`
   * (WO D2-console). `null` means servable; a slug absent from this object
   * means "not asked yet" or the endpoint answered 503 (no database) — both
   * degrade to showing no badge, never an error toast. Read the verdict from
   * here, never re-derived from `state.funnel.legal` — see the endpoint's
   * own header in `apps/runtime/lib/funnels.js`.
   * @type {Record<string, string|null>}
   */
  gates: {},
  stepIndex: 0,
  /**
   * Storage objects the operator removed from a field, waiting for the save that
   * makes that removal real. Emptied by `purgeRemovedAssets()` after a
   * successful save — see `removeImageField`. Nothing here is deleted until the
   * document that stopped referencing it is on disk.
   *
   * @type {string[]}
   */
  pendingAssetDeletes: [],
  /** @type {any[]} */
  leads: [],
  /** @type {any} */
  stats: null,
  dirty: false,
  view: "dashboard",
  /** @type {any[]} */
  deliveries: [],
  /** "ready" | "unconfigured" (no database — §4.4 Decision 1) | "error". */
  deliveryState: "ready",
  /** @type {{host:string,slug:string}[]} */
  domains: [],
  /** Mirrors `GET /api/admin/domains`'s `writable` — false with no database,
   *  where `FUNNEL_DOMAINS` is the only mapping and it is an env var this
   *  console cannot write (PHASE-2-PLAN.md §2 Decision 2). */
  domainsWritable: false,
  /** "ready" | "unauthorized" | "error", same shape as `deliveryState`. */
  domainsState: "ready",
  /** @type {{id:string,clientId:string,clientName:string|null,label:string|null,expiresAt:string,revokedAt:string|null,lastSeenAt:string|null,createdAt:string,expired:boolean}[]} */
  reports: [],
  /** Client picker for the issue form — `GET /api/admin/clients`, the same
   *  list a token's `clientId` must name (PHASE-2-PLAN.md §3 Decision 3: never
   *  guessed, because guessing wrong hands one client a link to another's leads). */
  reportClients: /** @type {{id:string,name:string,slug:string,avvSignedAt:string|null}[]} */ ([]),
  /** "ready" | "unconfigured" (no database — §3 Decision 8, `/r/:token` 404s and
   *  issuing 503s) | "unauthorized" | "error". */
  reportsState: "ready",
  /** The just-minted `{ url }` this view is showing exactly once (§3 Decision
   *  9). Cleared ONLY by the operator dismissing the panel — never by a
   *  re-render, a toast, or a list refresh, or the operator has issued a
   *  credential nobody has (work order C5, requirement 1). */
  reportIssuedUrl: /** @type {string|null} */ (null),
};

const VIEWS = ["dashboard", "builder", "leads", "delivery", "analytics", "templates", "domains", "reports", "settings"];
const ROUTES = {
  dashboard: "/",
  builder: "/builder",
  leads: "/leads",
  delivery: "/delivery",
  analytics: "/analytics",
  templates: "/templates",
  domains: "/domains",
  reports: "/reports",
  settings: "/settings",
};

const STEP_TYPES = ["landing", "content", "choice", "multiselect", "form", "loader", "success"];
// `select` is deliberately absent: `form.js` renders it, but the console has no
// editor for its `options`, so offering it here would only ever produce an empty
// dropdown. Add the options editor and the type in the same change.
const FIELD_TYPES = ["text", "email", "tel", "textarea", "number", "date", "address"];

/* ========================================================================== *
 *  Section (content block) schema
 *
 *  The inspector builds its section editor from this table rather than from
 *  hand-written markup per block type, so a new engine block becomes editable by
 *  adding one entry. Field `key`s are the JSON keys the engine reads — keep them
 *  in step with `ContentBlock` in `packages/engine/src/types.js`, or the console
 *  will happily write a key nothing consumes.
 *
 *  Field kinds: text | area | url | num | bool | pick | lines (newline-separated
 *  string[]) | list (array of objects, edited with a nested repeater) | group
 *  (a nested object).
 * ========================================================================== */

const BLOCK_SCHEMA = {
  heading: {
    label: "Section heading",
    glyph: "H",
    make: () => ({ type: "heading", eyebrow: "Why us", value: "A headline for this section" }),
    fields: [
      { key: "eyebrow", label: "Eyebrow", kind: "text" },
      { key: "value", label: "Title", kind: "text" },
      { key: "sub", label: "Supporting line", kind: "area" },
      { key: "align", label: "Align", kind: "pick", options: ["center", "left"] },
    ],
  },
  text: {
    label: "Paragraph",
    glyph: "¶",
    make: () => ({ type: "text", value: "Say something persuasive here." }),
    fields: [
      { key: "value", label: "Text", kind: "area" },
      { key: "size", label: "Size", kind: "pick", options: ["md", "sm", "lg"] },
      { key: "align", label: "Align", kind: "pick", options: ["center", "left"] },
    ],
  },
  image: {
    label: "Image",
    glyph: "🖼",
    make: () => ({ type: "image", src: "" }),
    fields: [
      { key: "src", label: "Image URL", kind: "image" },
      { key: "alt", label: "Alt text", kind: "text" },
      { key: "aspect", label: "Aspect ratio", kind: "text", placeholder: "16/9" },
      { key: "fit", label: "Fit", kind: "pick", options: ["cover", "contain"] },
    ],
  },
  video: {
    label: "Video / VSL",
    glyph: "▶",
    make: () => ({ type: "video", src: "" }),
    fields: [
      { key: "src", label: "Video or YouTube/Vimeo URL", kind: "url" },
      { key: "poster", label: "Poster image URL", kind: "image" },
      { key: "autoplay", label: "Autoplay (muted)", kind: "bool" },
    ],
  },
  features: {
    label: "Feature cards",
    glyph: "▦",
    make: () => ({
      type: "features",
      columns: 1,
      items: [
        { icon: "⚡", title: "Fast to launch", text: "Live in under an hour." },
        { icon: "🎯", title: "Built for ads", text: "Every step is a conversion point." },
      ],
    }),
    fields: [
      { key: "columns", label: "Columns", kind: "pick", options: ["1", "2", "3"], num: true },
      {
        key: "items",
        label: "Features",
        kind: "list",
        add: () => ({ icon: "✦", title: "New feature" }),
        item: [
          { key: "icon", label: "Icon", kind: "text" },
          { key: "title", label: "Title", kind: "text" },
          { key: "text", label: "Description", kind: "area" },
          { key: "image", label: "Image URL (replaces icon)", kind: "image" },
        ],
      },
    ],
  },
  steps: {
    label: "How it works",
    glyph: "①",
    make: () => ({
      type: "steps",
      items: [
        { title: "Answer 4 questions", text: "Takes about 60 seconds." },
        { title: "Get your match", text: "We calculate it instantly." },
        { title: "Book your call", text: "Pick any slot that suits you." },
      ],
    }),
    fields: [
      {
        key: "items",
        label: "Steps",
        kind: "list",
        add: () => ({ title: "Next step" }),
        item: [
          { key: "title", label: "Title", kind: "text" },
          { key: "text", label: "Description", kind: "area" },
        ],
      },
    ],
  },
  stats: {
    label: "Stat row",
    glyph: "％",
    make: () => ({
      type: "stats",
      columns: 3,
      items: [
        { value: "12,480", label: "Leads captured" },
        { value: "4.8×", label: "Average ROAS" },
        { value: "62%", label: "Completion rate" },
      ],
    }),
    fields: [
      { key: "columns", label: "Columns", kind: "pick", options: ["3", "2"], num: true },
      {
        key: "items",
        label: "Stats",
        kind: "list",
        add: () => ({ value: "0", label: "Metric" }),
        item: [
          { key: "value", label: "Value", kind: "text" },
          { key: "label", label: "Label", kind: "text" },
        ],
      },
    ],
  },
  faq: {
    label: "FAQ / objections",
    glyph: "?",
    make: () => ({
      type: "faq",
      items: [{ q: "How long does it take?", a: "About 60 seconds — four short questions." }],
    }),
    fields: [
      {
        key: "items",
        label: "Questions",
        kind: "list",
        add: () => ({ q: "New question", a: "" }),
        item: [
          { key: "q", label: "Question", kind: "text" },
          { key: "a", label: "Answer", kind: "area" },
        ],
      },
    ],
  },
  pricing: {
    label: "Pricing plans",
    glyph: "$",
    make: () => ({
      type: "pricing",
      plans: [
        { name: "Starter", price: "$0", period: "/mo", features: ["1 funnel", "Unlimited leads"], ctaLabel: "Start free" },
        { name: "Growth", price: "$49", period: "/mo", badge: "Popular", highlight: true, features: ["Unlimited funnels", "A/B testing"], ctaLabel: "Get started" },
      ],
    }),
    fields: [
      {
        key: "plans",
        label: "Plans",
        kind: "list",
        add: () => ({ name: "New plan", price: "$0" }),
        item: [
          { key: "name", label: "Name", kind: "text" },
          { key: "price", label: "Price", kind: "text" },
          { key: "period", label: "Period", kind: "text", placeholder: "/mo" },
          { key: "badge", label: "Badge", kind: "text" },
          { key: "features", label: "Features (one per line)", kind: "lines" },
          { key: "ctaLabel", label: "Button label", kind: "text" },
          { key: "highlight", label: "Highlight this plan", kind: "bool" },
          { key: "next", label: "Branch to step ID", kind: "text", list: "stepIds" },
        ],
      },
    ],
  },
  reviews: {
    label: "Review cards",
    glyph: "★",
    make: () => ({
      type: "reviews",
      items: [{ name: "Sarah M.", text: "Booked three calls the first week.", rating: 5 }],
    }),
    fields: [
      {
        key: "items",
        label: "Reviews",
        kind: "list",
        add: () => ({ name: "Customer", text: "" }),
        item: [
          { key: "text", label: "Quote", kind: "area" },
          { key: "name", label: "Name", kind: "text" },
          { key: "rating", label: "Rating (0–5)", kind: "num" },
          { key: "avatar", label: "Avatar URL", kind: "image" },
        ],
      },
    ],
  },
  quote: {
    label: "Pull quote",
    glyph: "❝",
    make: () => ({ type: "quote", text: "This paid for itself in a week.", name: "Alex R.", rating: 5 }),
    fields: [
      { key: "text", label: "Quote", kind: "area" },
      { key: "name", label: "Name", kind: "text" },
      { key: "role", label: "Role / company", kind: "text" },
      { key: "rating", label: "Rating (0–5)", kind: "num" },
      { key: "avatar", label: "Avatar URL", kind: "image" },
    ],
  },
  gallery: {
    label: "Image gallery",
    glyph: "▤",
    make: () => ({ type: "gallery", layout: "scroll", items: [{ src: "" }] }),
    fields: [
      { key: "layout", label: "Layout", kind: "pick", options: ["scroll", "grid"] },
      {
        key: "items",
        label: "Images",
        kind: "list",
        add: () => ({ src: "" }),
        item: [
          { key: "src", label: "Image URL", kind: "image" },
          { key: "caption", label: "Caption", kind: "text" },
          { key: "alt", label: "Alt text", kind: "text" },
        ],
      },
    ],
  },
  compare: {
    label: "Us vs. them",
    glyph: "⇄",
    make: () => ({
      type: "compare",
      left: { title: "The old way", items: ["Slow forms", "Cold leads"] },
      right: { title: "With us", items: ["60-second quiz", "Pre-qualified leads"] },
    }),
    fields: [
      {
        key: "left",
        label: "Left column (✕)",
        kind: "group",
        item: [
          { key: "title", label: "Title", kind: "text" },
          { key: "items", label: "Points (one per line)", kind: "lines" },
        ],
      },
      {
        key: "right",
        label: "Right column (✓)",
        kind: "group",
        item: [
          { key: "title", label: "Title", kind: "text" },
          { key: "items", label: "Points (one per line)", kind: "lines" },
        ],
      },
    ],
  },
  list: {
    label: "Checklist",
    glyph: "✓",
    make: () => ({ type: "list", items: [{ text: "Something you get" }] }),
    fields: [
      {
        key: "items",
        label: "Items",
        kind: "list",
        add: () => ({ text: "New item" }),
        item: [
          { key: "icon", label: "Icon", kind: "text" },
          { key: "text", label: "Text", kind: "text" },
        ],
      },
    ],
  },
  trust: {
    label: "Trust badges",
    glyph: "🛡",
    make: () => ({ type: "trust", items: [{ label: "Trusted by 200+ brands" }] }),
    fields: [
      {
        key: "items",
        label: "Badges",
        kind: "list",
        add: () => ({ label: "New badge" }),
        item: [
          { key: "label", label: "Label", kind: "text" },
          { key: "src", label: "Logo URL (replaces label)", kind: "image" },
        ],
      },
    ],
  },
  countdown: {
    label: "Countdown timer",
    glyph: "⏱",
    make: () => ({ type: "countdown", minutes: 15, label: "Offer expires in" }),
    fields: [
      { key: "label", label: "Label", kind: "text" },
      { key: "minutes", label: "Minutes", kind: "num" },
    ],
  },
  calculator: {
    label: "Calculator",
    glyph: "＝",
    make: () => ({ type: "calculator", label: "Your estimated saving", currency: "$", formula: "1000" }),
    fields: [
      { key: "label", label: "Label", kind: "text" },
      { key: "currency", label: "Currency symbol", kind: "text" },
      { key: "formula", label: "Formula", kind: "text", hint: "Pipe answers in, e.g. {{bill}} * 12 * 0.7" },
    ],
  },
  cta: {
    label: "Call to action",
    glyph: "➔",
    make: () => ({ type: "cta", label: "Start now", note: "Takes 60 seconds" }),
    fields: [
      { key: "label", label: "Button label", kind: "text" },
      { key: "note", label: "Microcopy under the button", kind: "text" },
      { key: "variant", label: "Style", kind: "pick", options: ["solid", "outline"] },
      { key: "next", label: "Branch to step ID", kind: "text", list: "stepIds" },
      { key: "url", label: "External URL (instead of advancing)", kind: "url" },
    ],
  },
  divider: {
    label: "Divider",
    glyph: "—",
    make: () => ({ type: "divider" }),
    fields: [{ key: "label", label: "Caption (optional)", kind: "text" }],
  },
  spacer: {
    label: "Spacer",
    glyph: "␣",
    make: () => ({ type: "spacer", size: 24 }),
    fields: [{ key: "size", label: "Height (px)", kind: "num" }],
  },
};

/* ========================================================================== *
 *  Small helpers
 * ========================================================================== */

const $ = (id) => document.getElementById(id);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * fetch for the console's own APIs, which the server treats as privileged.
 *
 * On a remote deployment the server requires ADMIN_TOKEN; paste the same value
 * into Settings → Admin API token and it travels as a bearer header. Running
 * locally the server accepts loopback callers, so this is a no-op there.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 */
function apiFetch(url, options = {}) {
  const token = localStorage.getItem("of.adminToken") || "";
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function icon(name, size = 14) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

/** Plural without the "(s)" shrug. */
function count(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function relativeTime(iso) {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ---- Toasts: an action's result belongs next to the work, not in a modal --- */
function toast(message, kind = "ok") {
  const host = $("toasts");
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " is-error" : ""}`;
  el.innerHTML = `${icon(kind === "error" ? "alert" : "check", 15)}<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 2600);
}

/* ========================================================================== *
 *  Colour — the one place the console takes a colour from data
 * ========================================================================== */

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim();
  if (!HEX_RE.test(hex)) return null;
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
  }
  return hex.toLowerCase();
}

/** The colour a funnel is known by: its own, or its preset's. */
function funnelColor(funnelOrTheme) {
  const theme = funnelOrTheme?.theme || funnelOrTheme || {};
  const own = normalizeHex(theme.primary);
  if (own) return own;
  const preset = theme.preset && THEME_PRESETS[theme.preset];
  return normalizeHex(preset?.primary) || "#4f46e5";
}

/** Text that stays legible on `hex` — checked, not guessed. */
function readableInk(hex) {
  const c = normalizeHex(hex) || "#4f46e5";
  const channel = (i) => {
    const v = parseInt(c.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.42 ? "#101318" : "#ffffff";
}

function applyAccent(hex) {
  const color = normalizeHex(hex) || "#4f46e5";
  const root = document.documentElement.style;
  root.setProperty("--accent", color);
  root.setProperty("--accent-ink", readableInk(color));
}

/* ========================================================================== *
 *  Console theme
 * ========================================================================== */

function setTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem("of.theme", mode);
  } catch {}
  const btn = $("themeBtn");
  btn.innerHTML = icon(mode === "dark" ? "sun" : "moon", 15);
  btn.title = mode === "dark" ? "Switch to light" : "Switch to dark";
}

/* ========================================================================== *
 *  Dirty tracking — a funnel edited but not written to disk
 * ========================================================================== */

function markDirty(dirty = true) {
  state.dirty = dirty;
  $("saveBtn").classList.toggle("is-dirty", dirty);
}

/* ========================================================================== *
 *  Routing
 * ========================================================================== */

function viewFromLocation() {
  const path = location.pathname.toLowerCase().replace(/\/+$/, "");
  const hash = location.hash.replace("#", "").toLowerCase();
  const key = hash || path.slice(1);
  if (key === "admin") return "leads";
  if (key === "app") return "dashboard";
  return VIEWS.includes(key) ? key : "dashboard";
}

function showView(view, push = true) {
  if (!VIEWS.includes(view)) view = "dashboard";
  state.view = view;

  qsa(".tab").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.view === view)));
  VIEWS.forEach((id) => $(`view-${id}`).classList.toggle("is-active", id === view));

  if (push && location.pathname !== ROUTES[view]) {
    history.pushState({ view }, "", ROUTES[view]);
  }

  if (view === "builder") mountPreview();
  if (view === "leads" || view === "analytics" || view === "dashboard") refreshData();
  // The funnel grid's badges live only on this view; re-fetch each time the
  // operator returns to it, since an AVV gets signed outside this console.
  if (view === "dashboard") loadGates();
  // Own load, not folded into refreshData(): a separate endpoint, and no
  // polling — a fresh read only when the operator actually opens the panel.
  if (view === "delivery") loadDeliveries();
  if (view === "domains") loadDomains();
  if (view === "reports") loadReports();
}

/* ========================================================================== *
 *  Funnels
 * ========================================================================== */

async function loadFunnelList() {
  try {
    const res = await fetch("/api/funnels");
    if (!res.ok) throw new Error("list failed");
    const data = await res.json();
    state.funnels = data.funnels || [];
  } catch {
    state.funnels = [];
  }
  renderSwitcher();
}

/** Funnels known to the server, plus the working document if it is unsaved. */
function knownFunnels() {
  const list = state.funnels.slice();
  if (state.funnel && !list.some((f) => f.slug === state.funnel.slug)) {
    list.push({
      slug: state.funnel.slug,
      name: state.funnel.name || state.funnel.slug,
      primary: funnelColor(state.funnel),
      mode: state.funnel.theme?.mode || "light",
      steps: state.funnel.steps.length,
      unsaved: true,
    });
  }
  return list;
}

function renderSwitcher() {
  const select = $("funnelSelect");
  const current = state.funnel?.slug || "";
  const options = knownFunnels()
    .map(
      (f) =>
        `<option value="${esc(f.slug)}"${f.slug === current ? " selected" : ""}>${esc(f.name)}${
          f.unsaved ? " — unsaved" : ""
        }</option>`
    )
    .join("");
  select.innerHTML = `${options}<option value="__new">＋ New funnel</option>`;
}

async function openFunnel(slug) {
  try {
    // The editing copy, not the public one — see /api/builder/funnel/:slug.
    const res = await apiFetch(`/api/builder/funnel/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error("not found");
    setWorkingFunnel(await res.json());
    markDirty(false);
  } catch {
    toast(`Could not open ${slug}`, "error");
  }
}

/** Adopt a funnel document as the thing being edited, and sync every surface. */
function setWorkingFunnel(funnel) {
  state.funnel = funnel;
  state.stepIndex = 0;

  applyAccent(funnelColor(funnel));
  syncFunnelChrome();
  renderSwitcher();
  renderSpine();
  renderInspector();
  renderThemeModal();
  renderPixelsModal();
  renderDashboard();
  renderGateBanner();
  loadSettings();
  mountPreview(true);
  renderAnalytics();
}

function syncFunnelChrome() {
  const slug = state.funnel?.slug || "";
  const href = `/f/${slug}`;
  $("liveLinkText").textContent = href;
  $("liveLink").href = href;
  $("fullscreenLink").href = href;
  $("analyticsSub").textContent = state.funnel
    ? `Where visitors leave ${state.funnel.name || slug}, step by step.`
    : "Where visitors leave, step by step.";
}

/**
 * Reason → what the operator sees. Shared by the funnel-card badge (`tag`)
 * and the builder banner (`fix`) so the two surfaces never describe the same
 * gate two different ways. `avv_unsigned`'s `fix` deliberately names no
 * console action — signing an AVV happens outside this app entirely.
 */
const GATE_INFO = {
  impressum_url_missing: { tag: "no Impressum URL", fix: "no Impressum URL is set (Settings → Legal)" },
  privacy_url_missing: { tag: "no privacy URL", fix: "no privacy URL is set (Settings → Legal)" },
  avv_unsigned: { tag: "AVV unsigned", fix: "the client has no signed AVV on record" },
};

/** One sentence naming the 503 and the fix, or "" for an unknown/absent reason. */
function gateSentence(reason) {
  const info = GATE_INFO[reason];
  return info ? `This funnel returns 503 to visitors: ${info.fix}.` : "";
}

/** The banner atop the builder stage when the funnel now open is gated. */
function renderGateBanner() {
  const el = $("gateBanner");
  if (!el) return;
  const reason = state.funnel ? state.gates[state.funnel.slug] : null;
  el.hidden = !reason;
  if (reason) el.innerHTML = `${icon("alert", 14)}<span>${esc(gateSentence(reason))}</span>`;
}

function slugify(text, fallback = "funnel") {
  const base = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || fallback}-${Date.now().toString(36).slice(-4)}`;
}

function createFunnel() {
  const slug = slugify("funnel");
  setWorkingFunnel({
    id: slug,
    slug,
    name: "Untitled funnel",
    theme: { primary: "#4f46e5", mode: "light", radius: "18px" },
    steps: [
      {
        id: "goal",
        type: "choice",
        headline: "What are you looking for?",
        subtext: "Pick the closest match.",
        options: [
          { id: "opt_1", label: "Option one" },
          { id: "opt_2", label: "Option two" },
        ],
      },
      {
        id: "contact",
        type: "form",
        headline: "Where should we send it?",
        fields: [
          { name: "name", type: "text", label: "Name", required: true },
          { name: "email", type: "email", label: "Email", required: true },
        ],
      },
      { id: "done", type: "success", headline: "You're all set, {{name}}." },
    ],
  });
  markDirty(true);
  showView("builder");
  toast("New funnel created. Save it to publish.");
}

/**
 * The shortlist offered in the "Create New Funnel" modal, newest-operator first:
 * one broad lead-gen quiz, one consumer quiz, one local-services qualifier.
 *
 * Keys must exist in FUNNEL_TEMPLATES. They are rendered rather than hardcoded in
 * `index.html` precisely because they drifted: two of the three cards named a
 * *category* (`lead-gen`, `fitness`) instead of a template, so `useTemplate()`
 * found nothing and returned — a dead click with no toast and no console warning.
 * Title and description come from the template itself, so the card can never
 * describe a funnel other than the one it creates.
 */
const BLUEPRINTS = [
  { key: "agency-lead", icon: "🎯" },
  { key: "fitness-challenge", icon: "💪" },
  { key: "real-estate", icon: "🏡" },
];

function renderBlueprints() {
  const host = $("blueprintCards");
  if (!host) return;
  host.innerHTML = BLUEPRINTS.filter(({ key }) => FUNNEL_TEMPLATES[key])
    .map(({ key, icon: emoji }) => {
      const tpl = FUNNEL_TEMPLATES[key];
      return `<button class="card card-pad blueprint-card" data-blueprint="${esc(key)}" style="text-align:left;cursor:pointer">
        <div style="font-weight:600;font-size:15px;margin-bottom:4px">${emoji} ${esc(tpl.title || key)}</div>
        <p class="field-hint" style="margin:0">${esc(tpl.description || "")}</p>
      </button>`;
    })
    .join("");
}

function useTemplate(key) {
  const template = FUNNEL_TEMPLATES[key];
  // Say so rather than returning silently — a bad key here means a button that
  // does nothing at all, which is how the blueprint cards stayed broken.
  if (!template) {
    console.warn(`[openfunnel] no template named "${key}"`);
    return toast(`Template “${key}” not found`, "error");
  }
  const copy = structuredClone(template);
  copy.slug = slugify(key);
  copy.id = copy.slug;
  copy.name = template.title || key;
  setWorkingFunnel(copy);
  markDirty(true);
  showView("builder");
  toast(`Started from ${template.title || key}`);
}

async function saveFunnel() {
  if (!state.funnel) return;
  const btn = $("saveBtn");
  const label = btn.querySelector("span");
  btn.disabled = true;
  label.textContent = "Saving";
  try {
    const res = await apiFetch("/api/builder/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.funnel),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "save_failed");
    }
    markDirty(false);
    label.textContent = "Saved";
    // Only now: an image removed in the builder is not removed until the
    // document that stopped pointing at it is the one on disk.
    void purgeRemovedAssets();
    toast(`${state.funnel.name || state.funnel.slug} saved`);
    await loadFunnelList();
    // The save just wrote legal.impressumUrl/privacyUrl, the two fields the
    // gate reads — refresh so the badge and banner reflect what's on disk now.
    await loadGates();
    renderDashboard();
    setTimeout(() => (label.textContent = "Save"), 1600);
  } catch (err) {
    label.textContent = "Save";
    const reason =
      err.message === "invalid_slug"
        ? "The slug must be lowercase letters, numbers and dashes."
        : "The server rejected the funnel document.";
    toast(`Not saved. ${reason}`, "error");
  } finally {
    btn.disabled = false;
  }
}

/* ========================================================================== *
 *  Data
 * ========================================================================== */

async function refreshData() {
  const scope = state.funnel?.slug ? `?funnel=${encodeURIComponent(state.funnel.slug)}` : "";
  const [leadsRes, statsRes, globalRes] = await Promise.allSettled([
    apiFetch("/api/admin/leads"),
    apiFetch(`/api/admin/stats${scope}`),
    apiFetch("/api/admin/stats"),
  ]);

  if (leadsRes.status === "fulfilled" && leadsRes.value.ok) {
    const data = await leadsRes.value.json();
    state.leads = data.leads || [];
    renderLeads();
  }
  if (statsRes.status === "fulfilled" && statsRes.value.ok) {
    state.stats = await statsRes.value.json();
    renderAnalytics();
  }
  if (globalRes.status === "fulfilled" && globalRes.value.ok) {
    state.globalStats = await globalRes.value.json();
  }
  renderDashboard();
}

/**
 * Every funnel's serve-time gate reason (WO D2-console). A 503 means no
 * database is configured — nothing to show, so it degrades to an empty
 * object rather than an error toast; the badge and banner just don't appear.
 */
async function loadGates() {
  try {
    const res = await apiFetch("/api/admin/funnel-gates");
    state.gates = res.ok ? (await res.json()).gates || {} : {};
  } catch {
    state.gates = {};
  }
  renderFunnelGrid();
  renderGateBanner();
}

/* ========================================================================== *
 *  Overview
 * ========================================================================== */

function renderDashboard() {
  const stats = state.globalStats || {};
  const starts = stats.starts || 0;
  const leads = stats.leads || 0;
  const completes = stats.completes || 0;
  const rate = starts ? Math.round((leads / starts) * 100) : null;

  const leadBadge = $("tabLeadBadge");
  if (leadBadge) leadBadge.textContent = state.leads.length ? state.leads.length.toLocaleString() : "0";

  $("mStarts").textContent = starts.toLocaleString();
  $("mLeads").textContent = leads.toLocaleString();
  $("mRate").textContent = rate === null ? "—" : `${rate}%`;
  $("mCompletes").textContent = completes.toLocaleString();
  $("mRateNote").textContent = starts
    ? `${count(leads, "lead")} from ${count(starts, "start")}`
    : "Needs traffic to measure";

  const funnels = knownFunnels();
  const newest = state.leads[0];
  $("dashSub").textContent = funnels.length
    ? `${count(funnels.length, "funnel")} in this workspace${newest ? ` · last capture ${relativeTime(newest.received_at)}` : ""}`
    : "No funnels yet.";

  renderFunnelGrid();
  renderCaptureFeed();
}

async function deleteFunnel(slug) {
  if (!confirm(`Are you sure you want to delete '${slug}'? This action cannot be undone.`)) return;
  try {
    const res = await apiFetch("/api/builder/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    if (!res.ok) throw new Error("delete_failed");
    state.funnels = state.funnels.filter((f) => f.slug !== slug);
    if (state.funnel?.slug === slug) {
      state.funnel = null;
    }
    toast(`Deleted ${slug}`);
    await loadFunnelList();
    renderDashboard();
  } catch {
    toast("Could not delete funnel", "error");
  }
}

async function duplicateFunnel(slug) {
  try {
    const res = await apiFetch("/api/builder/duplicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    if (!res.ok) throw new Error("duplicate_failed");
    const data = await res.json();
    if (data.funnel) {
      setWorkingFunnel(data.funnel);
      await loadFunnelList();
      showView("builder");
      toast(`Duplicated funnel as ${data.funnel.name}`);
    }
  } catch {
    toast("Could not duplicate funnel", "error");
  }
}

function renderFunnelGrid() {
  const grid = $("funnelGrid");
  const query = $("funnelSearch").value.trim().toLowerCase();
  const perFunnel = state.globalStats?.perFunnel || {};

  let funnels = knownFunnels();
  if (query) {
    funnels = funnels.filter(
      (f) => f.slug.toLowerCase().includes(query) || f.name.toLowerCase().includes(query)
    );
  }

  $("funnelCount").textContent = funnels.length ? count(funnels.length, "funnel") : "";

  if (!funnels.length) {
    grid.innerHTML = `<div class="card empty" style="grid-column:1/-1">
      <div class="empty-title">${query ? "Nothing matches that" : "No funnels yet"}</div>
      <p class="empty-body">${
        query
          ? "Clear the filter to see every funnel in the workspace."
          : "Start from a template, or build one step by step."
      }</p>
      ${
        query
          ? ""
          : `<div class="empty-actions">
               <button class="btn" data-goto="templates">Browse templates</button>
               <button class="btn btn-primary" data-new-funnel>New funnel</button>
             </div>`
      }
    </div>`;
    return;
  }

  grid.innerHTML = funnels
    .map((f) => {
      const color = normalizeHex(f.primary) || "#007aff";
      const s = perFunnel[f.slug] || {};
      const current = state.funnel?.slug === f.slug;
      // From GET /api/admin/funnel-gates, not re-derived from f.legal — see
      // the "gates" field comment on `state` for why.
      const gateReason = state.gates[f.slug];
      return `<article class="funnel-card${current ? " is-current" : ""}" style="--accent:${esc(color)}" data-slug="${esc(f.slug)}" tabindex="0" role="button">
        <div class="funnel-card-head">
          <div class="funnel-card-title-group">
            <div class="funnel-name">${esc(f.name)}</div>
            <div class="funnel-slug">/f/${esc(f.slug)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            ${f.unsaved ? `<span class="tag tag-warning">unsaved</span>` : ""}
            ${
              gateReason
                ? `<span class="tag tag-danger" title="${esc(gateSentence(gateReason))}">${esc(GATE_INFO[gateReason]?.tag || "gated")}</span>`
                : ""
            }
          </div>
        </div>
        <div class="funnel-stats">
          <span class="funnel-stat"><b>${f.steps}</b> ${f.steps === 1 ? "step" : "steps"}</span>
          <span class="stat-dot-sep">•</span>
          <span class="funnel-stat"><b>${s.starts || 0}</b> starts</span>
          <span class="stat-dot-sep">•</span>
          <span class="funnel-stat"><b>${s.leads || 0}</b> leads</span>
        </div>
        <div class="funnel-actions">
          <button class="btn btn-sm btn-primary" data-edit="${esc(f.slug)}">
            ${icon("code", 12)} Edit
          </button>
          <button class="btn btn-sm btn-ghost" data-duplicate="${esc(f.slug)}" title="Duplicate funnel">
            ${icon("copy", 12)} Copy
          </button>
          <a class="btn btn-sm btn-ghost" href="/f/${esc(f.slug)}" target="_blank" rel="noopener" data-open title="Open funnel live view">
            ${icon("external", 12)} Open
          </a>
          <button class="btn btn-ghost btn-sm btn-danger" data-delete="${esc(f.slug)}" title="Delete funnel" style="margin-left:auto">
            ${icon("trash", 12)}
          </button>
        </div>
      </article>`;
    })
    .join("");
}

function renderCaptureFeed() {
  const feed = $("captureFeed");
  const recent = state.leads.slice(0, 5);

  if (!recent.length) {
    feed.innerHTML = `<div class="empty">
      <div class="empty-title">No captures yet</div>
      <p class="empty-body">Open one of your funnels and complete it once — submissions show up here straight away.</p>
    </div>`;
    return;
  }

  feed.innerHTML = recent
    .map((lead) => {
      // Coerce: `lead` is public input, so any of these can be an object or a
      // number. `.charAt` on one throws and permanently blanks the operator's feed.
      const who = String(lead.lead?.email || lead.lead?.phone || lead.lead?.name || "Anonymous");
      const initial = (who.charAt(0) || "?").toUpperCase();
      return `<div class="feed-row" style="cursor:pointer" data-lead-id="${esc(lead.id || "")}">
        <div style="display:flex;align-items:center;gap:10px;overflow:hidden">
          <span class="avatar-bubble">${esc(initial)}</span>
          <span class="feed-who">${esc(who)}</span>
        </div>
        <span class="tag">${esc(lead.funnelId || "unknown")}</span>
        <span class="feed-when">${esc(relativeTime(lead.received_at))}</span>
      </div>`;
    })
    .join("");
}

/* ========================================================================== *
 *  Builder — the spine
 * ========================================================================== */

function stepTitle(step) {
  return step.headline || step.id || "Untitled step";
}

/** Every branch this step can send a visitor to — otherwise invisible in the UI. */
function branchTargets(step) {
  const targets = new Set();
  if (step.next) targets.add(step.next);
  (step.options || []).forEach((opt) => opt.next && targets.add(opt.next));
  return [...targets];
}

function renderSpine() {
  const host = $("stepSpine");
  if (!state.funnel) {
    host.innerHTML = `<p class="placeholder">No funnel loaded.</p>`;
    return;
  }

  const steps = state.funnel.steps;
  $("stepCount").textContent = `· ${steps.length}`;

  host.innerHTML = steps
    .map((step, i) => {
      const branches = branchTargets(step)
        .map((t) => `<span class="branch">${icon("right", 9)}${esc(t)}</span>`)
        .join("");
      return `<div class="spine-row${i === state.stepIndex ? " is-active" : ""}" data-step="${i}" draggable="true" role="button" tabindex="0">
        <span class="drag-handle" title="Drag to reorder step">${icon("grid", 12)}</span>
        <span class="spine-index">${String(i + 1).padStart(2, "0")}</span>
        <span class="spine-body">
          <span class="spine-title">${esc(stepTitle(step))}</span>
          <span class="spine-meta">
            <span class="spine-type-badge">${esc(step.type || "content")}</span>
            ${branches}
          </span>
        </span>
        <span class="spine-tools">
          <button class="btn btn-ghost btn-icon btn-sm spine-dup-btn" data-dup-step="${i}" title="Duplicate step" aria-label="Duplicate step">${icon("copy", 11)}</button>
          ${
            i > 0
              ? `<button class="btn btn-ghost btn-icon btn-sm" data-move="${i}" data-dir="-1" title="Move up" aria-label="Move up">${icon("up", 12)}</button>`
              : ""
          }
          ${
            i < steps.length - 1
              ? `<button class="btn btn-ghost btn-icon btn-sm" data-move="${i}" data-dir="1" title="Move down" aria-label="Move down">${icon("down", 12)}</button>`
              : ""
          }
        </span>
      </div>`;
    })
    .join("");
  bindSpineDragAndDrop();
}

function selectStep(index) {
  state.stepIndex = Math.max(0, Math.min(index, (state.funnel?.steps.length || 1) - 1));
  renderSpine();
  renderInspector();
  pushPreview();
}

function moveStep(from, delta) {
  const steps = state.funnel.steps;
  const to = from + delta;
  if (to < 0 || to >= steps.length) return;
  [steps[from], steps[to]] = [steps[to], steps[from]];
  state.stepIndex = to;
  renderSpine();
  renderInspector();
  onFunnelEdited();
}

function duplicateStep(index) {
  if (!state.funnel?.steps[index]) return;
  const original = state.funnel.steps[index];
  const clone = JSON.parse(JSON.stringify(original));
  const timestamp = Date.now().toString(36).slice(-4);
  clone.id = `${original.id || "step"}_copy_${timestamp}`;
  if (clone.headline) clone.headline = `${clone.headline} (Copy)`;
  state.funnel.steps.splice(index + 1, 0, clone);
  state.stepIndex = index + 1;
  renderSpine();
  renderInspector();
  onFunnelEdited();
  toast("Step duplicated", "success");
}

function createStepFromArchetype(archetype) {
  if (!state.funnel) return;
  const timestamp = Date.now().toString(36).slice(-4);
  let newStep;

  if (archetype === "choice") {
    newStep = {
      id: `q_${timestamp}`,
      type: "choice",
      headline: "Which goal matters most to you right now?",
      subtext: "Select one option to continue.",
      autoAdvance: true,
      layout: "list",
      options: [
        { id: "opt_1", label: "Scale qualified leads & sales", icon: "⚡", badge: "🔥 Popular", subtext: "For high-ticket offers and services" },
        { id: "opt_2", label: "Automate prospect qualification", icon: "🎯", badge: "⭐ Recommended", subtext: "Filter out low quality leads automatically" },
        { id: "opt_3", label: "Boost funnel conversion rates", icon: "📈", subtext: "Turn cold ad traffic into paying clients" }
      ]
    };
  } else if (archetype === "multiselect") {
    newStep = {
      id: `multi_${timestamp}`,
      type: "multiselect",
      headline: "What features are essential for your funnel?",
      subtext: "Select all options that apply.",
      options: [
        { id: "m1", label: "Interactive quiz branching", icon: "🔀" },
        { id: "m2", label: "Meta & GA4 pixel tracking", icon: "📊" },
        { id: "m3", label: "Anti-spam OTP verification", icon: "🛡️" },
        { id: "m4", label: "Instant CRM & Zapier sync", icon: "⚡" }
      ],
      ctaLabel: "Continue to Next Step ➔"
    };
  } else if (archetype === "form") {
    newStep = {
      id: `lead_form_${timestamp}`,
      type: "form",
      headline: "Where should we send your custom report?",
      subtext: "Enter your contact details below to get instant access.",
      verifyEmail: true,
      fields: [
        { name: "name", label: "Full Name", type: "text", required: true },
        { name: "email", label: "Work Email", type: "email", required: true },
        { name: "phone", label: "Phone Number", type: "phone", required: false }
      ],
      submitLabel: "Get Instant Access ➔"
    };
  } else if (archetype === "vsl") {
    newStep = {
      id: `vsl_${timestamp}`,
      type: "content",
      headline: "Watch This 2-Minute Demo Before Continuing",
      subtext: "Discover how our interactive funnel system drives 3x conversions.",
      blocks: [
        { type: "video", src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", autoplay: false },
        {
          type: "features",
          columns: 2,
          items: [
            { icon: "⚡", title: "Instant Setup", text: "Launch in under 10 minutes." },
            { icon: "🎯", title: "High Conversion", text: "Optimized for mobile paid traffic." }
          ]
        }
      ],
      ctaLabel: "Claim Your Strategy Session ➔"
    };
  } else if (archetype === "calculator") {
    newStep = {
      id: `calc_${timestamp}`,
      type: "content",
      headline: "Your Projected ROI & Savings",
      subtext: "Based on your inputs, here is your estimated monthly output:",
      blocks: [
        { type: "calculator", label: "Estimated Monthly Growth", currency: "$", formula: "2500 * 1.5" },
        { type: "trust", items: [{ label: "Verified 4.9/5 Rating" }, { label: "100% Guaranteed Accuracy" }] }
      ],
      ctaLabel: "Lock In Your Projected Rate ➔"
    };
  } else if (archetype === "reviews") {
    newStep = {
      id: `proof_${timestamp}`,
      type: "content",
      headline: "See What Top Performers Are Saying",
      subtext: "Join 1,200+ businesses who switched to openFunnel.",
      blocks: [
        {
          type: "reviews",
          items: [
            { name: "Alex R., Agency Lead", text: "This quiz funnel doubled our lead quality in less than 48 hours.", rating: 5 },
            { name: "Sarah M., SaaS Founder", text: "Best conversion improvement we have made all year.", rating: 5 }
          ]
        },
        { type: "stats", columns: 3, items: [{ value: "12,400+", label: "Leads Captured" }, { value: "4.8x", label: "Average ROAS" }, { value: "98%", label: "Satisfaction" }] }
      ],
      ctaLabel: "Start Your Quiz Now ➔"
    };
  } else if (archetype === "pricing") {
    newStep = {
      id: `offer_${timestamp}`,
      type: "content",
      headline: "Choose Your Growth Package",
      subtext: "Select the option best suited for your current scale.",
      blocks: [
        {
          type: "pricing",
          plans: [
            { name: "Starter", price: "$490", period: "/one-time", features: ["1 Custom Quiz Funnel", "Webhook Integration", "Basic Analytics"], ctaLabel: "Select Starter" },
            { name: "Pro Scale", price: "$990", period: "/one-time", badge: "🔥 Most Popular", highlight: true, features: ["Unlimited Funnels", "A/B Split Testing", "Priority 24/7 Support"], ctaLabel: "Select Pro Scale" }
          ]
        }
      ]
    };
  } else if (archetype === "landing") {
    return addLandingStep();
  } else {
    newStep = {
      id: `step_${timestamp}`,
      type: "choice",
      headline: "New question",
      options: [
        { id: "opt_1", label: "Option one" },
        { id: "opt_2", label: "Option two" }
      ]
    };
  }

  state.funnel.steps.push(newStep);
  state.stepIndex = state.funnel.steps.length - 1;
  renderSpine();
  renderInspector();
  onFunnelEdited();
  toast("New step added", "success");
}

function addStep() {
  createStepFromArchetype("choice");
}

/**
 * A landing page goes in *front* of the funnel, not on the end — it is what the
 * ad click lands on. Appending it like any other step would put a hero screen
 * after the thank-you page, which is never what was meant.
 */
function addLandingStep() {
  if (!state.funnel) return;
  state.funnel.steps.unshift({
    id: `landing_${Date.now().toString(36).slice(-4)}`,
    type: "landing",
    ...blankLanding(),
    blocks: [
      BLOCK_SCHEMA.stats.make(),
      BLOCK_SCHEMA.features.make(),
      BLOCK_SCHEMA.faq.make(),
    ],
  });
  state.stepIndex = 0;
  renderSpine();
  renderInspector();
  onFunnelEdited();
  toast("Landing page added as step 1");
}

function deleteStep() {
  if (!state.funnel || state.funnel.steps.length <= 1) {
    toast("A funnel needs at least one step", "error");
    return;
  }
  state.funnel.steps.splice(state.stepIndex, 1);
  state.stepIndex = Math.max(0, state.stepIndex - 1);
  renderSpine();
  renderInspector();
  onFunnelEdited();
}

/* ---- Inspector ----------------------------------------------------------- */

function renderInspector() {
  const host = $("inspector");
  const step = state.funnel?.steps[state.stepIndex];

  if (!step) {
    host.innerHTML = `<p class="placeholder">Select a step to edit it.</p>`;
    return;
  }

  const activeTab = state.inspectorTab || "content";

  const tabsNav = `
    <div class="inspector-tabs" id="insTabs">
      <button type="button" class="ins-tab${activeTab === "content" ? " is-active" : ""}" data-ins-tab="content">✏️ Content</button>
      <button type="button" class="ins-tab${activeTab === "design" ? " is-active" : ""}" data-ins-tab="design">🎨 Design</button>
      <button type="button" class="ins-tab${activeTab === "blocks" ? " is-active" : ""}" data-ins-tab="blocks">🧩 Blocks</button>
      <button type="button" class="ins-tab${activeTab === "logic" ? " is-active" : ""}" data-ins-tab="logic">🔀 Logic</button>
    </div>
  `;

  let tabBody = "";

  if (activeTab === "content") {
    tabBody = `
      <div class="inspector-section">
        <div class="repeat-grid" style="grid-template-columns:1fr 1fr;gap:8px">
          <div class="field" style="margin:0">
            <label for="insType">Step Type</label>
            <span class="select-wrap">
              <select id="insType" class="select">
                ${STEP_TYPES.map(
                  (t) => `<option value="${t}"${step.type === t ? " selected" : ""}>${t}</option>`
                ).join("")}
              </select>
              <span class="select-caret">${icon("chevron")}</span>
            </span>
          </div>
          <div class="field" style="margin:0">
            <label for="insId">Step ID</label>
            <input id="insId" class="input input-mono" type="text" value="${esc(step.id || "")}" />
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="field">
          <label for="insHeadline">Headline</label>
          <input id="insHeadline" class="input" type="text" value="${esc(step.headline || "")}" placeholder="Ask one clear question" />
          <div class="token-chips" style="margin-top:6px">
            <span style="font-size:11px;color:var(--text-3);line-height:20px">Pipe:</span>
            <button type="button" class="token-chip" data-insert-token="{{name}}">{{name}}</button>
            <button type="button" class="token-chip" data-insert-token="{{email}}">{{email}}</button>
            <button type="button" class="token-chip" data-insert-token="{{answers.budget}}">{{answers.budget}}</button>
            <button type="button" class="token-chip" data-insert-token="{{score}}">{{score}}</button>
          </div>
          <div id="headlineVariants" style="margin-top:8px"></div>
        </div>
        <div class="field">
          <label for="insSubtext">Supporting text</label>
          <textarea id="insSubtext" class="textarea" rows="2" placeholder="Optional subtext">${esc(step.subtext || "")}</textarea>
        </div>
        <div class="field" style="margin-top:6px">
          <label>Headline & Header Alignment</label>
          <div class="align-picker" id="insHeaderAlign">
            <button type="button" class="align-btn${(step.align || "center") === "left" ? " is-active" : ""}" data-step-align="left">Left</button>
            <button type="button" class="align-btn${(step.align || "center") === "center" ? " is-active" : ""}" data-step-align="center">Center</button>
            <button type="button" class="align-btn${(step.align || "center") === "right" ? " is-active" : ""}" data-step-align="right">Right</button>
          </div>
        </div>
        <button id="rewriteBtn" class="btn btn-sm" style="margin-top:8px">${icon("ai", 13)} Suggest headlines</button>
      </div>

      ${renderStepBody(step)}
    `;
  } else if (activeTab === "design") {
    tabBody = `
      <div class="inspector-section">
        ${
          step.type === "choice" || step.type === "multiselect"
            ? `<div class="field" style="margin-bottom:14px">
                <label>Option Layout</label>
                <div class="seg-picker" id="insLayoutSeg">
                  <button type="button" class="seg-btn${step.layout === "list" || !step.layout ? " is-active" : ""}" data-layout="list">☰ Stacked</button>
                  <button type="button" class="seg-btn${step.layout === "grid" ? " is-active" : ""}" data-layout="grid">⊞ 2-Col</button>
                  <button type="button" class="seg-btn${step.layout === "grid3" ? " is-active" : ""}" data-layout="grid3">▦ 3-Col</button>
                </div>
              </div>`
            : ""
        }
        ${
          step.type === "choice"
            ? `<div class="field row-between" style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)">
                <div>
                  <div style="font-weight:600;font-size:12px">Auto-Advance on Click</div>
                  <p class="field-hint" style="margin:0">Advance step immediately when prospect selects an option.</p>
                </div>
                <label class="switch">
                  <input id="insAutoAdvance" type="checkbox"${step.autoAdvance !== false ? " checked" : ""} />
                  <span class="switch-track"></span>
                </label>
              </div>`
            : ""
        }
        <div class="field">
          <label for="insHeroImage">Step Hero Photo / Media URL</label>
          <input id="insHeroImage" class="input input-mono" type="text" value="${esc(step.image || step.heroImage || "")}" placeholder="https://images.unsplash.com/photo-…" />
          <p class="field-hint">Optional hero photo displayed at top of step.</p>
        </div>
        <div class="field row-between" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
          <div>
            <div style="font-weight:600;font-size:12px">Hide "Powered by OpenFunnel" Badge</div>
            <p class="field-hint" style="margin:0">Remove badge from bottom of published pages.</p>
          </div>
          <label class="switch">
            <input id="insHideBranding" type="checkbox"${state.funnel?.branding?.hidden ? " checked" : ""} />
            <span class="switch-track"></span>
          </label>
        </div>
      </div>
    `;
  } else if (activeTab === "blocks") {
    tabBody = `
      <div class="block-drop-hint">
        <strong>💡 Drag & Drop Enabled:</strong> Drag block chips below directly into your step sections, or drag section cards up/down to reorder.
      </div>
      ${renderSectionEditor(step)}
    `;
  } else if (activeTab === "logic") {
    tabBody = `
      <div class="inspector-section">
        <div class="inspector-head"><span class="eyebrow">Flow & Branching</span></div>
        <div class="field">
          <label for="insNext">Default next step target</label>
          <input id="insNext" class="input input-mono" type="text" value="${esc(step.next || "")}" placeholder="${esc(nextStepHint())}" list="stepIds" />
          <p class="field-hint">Fallback next step if option doesn't override.</p>
        </div>
        <datalist id="stepIds">
          ${state.funnel.steps.map((s) => `<option value="${esc(s.id)}"></option>`).join("")}
        </datalist>
      </div>

      <div class="inspector-section" style="margin-top:20px">
        <button id="deleteStepBtn" class="btn btn-sm btn-danger" style="width:100%">${icon("trash", 13)} Delete step</button>
      </div>
    `;
  }

  host.innerHTML = tabsNav + tabBody;
  bindInspector(step);
}

function nextStepHint() {
  const next = state.funnel?.steps[state.stepIndex + 1];
  return next ? next.id : "end of funnel";
}

/* ---- Path-addressed editing ---------------------------------------------
 * The landing panel and the section editor both write deep into the step
 * (`cta.label`, `blocks.2.items.0.title`), which is far too much shape to hang
 * a named `data-*` attribute off. Every control instead carries the JSON path it
 * owns, and one delegated handler applies it. Adding a field is then a line of
 * schema, not a line of schema plus a line of wiring.
 * ------------------------------------------------------------------------- */

/** @returns {any} The value at `a.b.0.c`, or undefined. */
function readPath(root, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), root);
}

/**
 * Write `a.b.0.c`, creating intermediates (an array when the next segment is an
 * index, an object otherwise). `undefined` deletes the key rather than storing
 * it: a field the operator emptied should leave the funnel JSON as it was before
 * they touched it, not seed it with `""` that the engine then has to treat as set.
 */
function writePath(root, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let node = root;
  keys.forEach((key, i) => {
    const nextKey = i + 1 < keys.length ? keys[i + 1] : last;
    if (node[key] == null) node[key] = /^\d+$/.test(nextKey) ? [] : {};
    node = node[key];
  });
  if (value === undefined) delete node[last];
  else node[last] = value;
}

/** Read one control's value back out in the shape its `kind` implies. */
function valueFromControl(el) {
  const kind = el.dataset.kind || "text";
  if (kind === "bool") return el.checked || undefined;
  if (kind === "num") {
    const n = Number(el.value);
    return el.value === "" || !Number.isFinite(n) ? undefined : n;
  }
  if (kind === "lines") {
    const lines = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines : undefined;
  }
  return el.value.trim() === "" ? undefined : el.value;
}

/** One labelled control for a schema field. `base` is its parent's JSON path. */
function fieldControl(field, base, parent) {
  const path = base ? `${base}.${field.key}` : field.key;
  const raw = parent?.[field.key];
  const attrs = `data-path="${esc(path)}" data-kind="${esc(field.kind === "area" || field.kind === "url" || field.kind === "image" ? "text" : field.kind === "pick" ? (field.num ? "num" : "text") : field.kind)}"`;
  const hint = field.hint ? `<p class="field-hint">${esc(field.hint)}</p>` : "";

  if (field.kind === "bool") {
    return `<label class="repeat-check">
      <input type="checkbox" ${attrs}${raw ? " checked" : ""} /> ${esc(field.label)}
    </label>`;
  }

  if (field.kind === "pick" && field.key === "align") {
    const rawVal = String(raw ?? field.options?.[0] ?? "center");
    const options = (field.options || ["center", "left", "right"])
      .map((o) => `<button type="button" class="align-btn${rawVal === String(o) ? " is-active" : ""}" data-align-opt="${esc(o)}">${esc(o.charAt(0).toUpperCase() + o.slice(1))}</button>`)
      .join("");
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <div class="align-picker" data-align-path="${esc(path)}">
        ${options}
      </div>
      ${hint}
    </div>`;
  }

  if (field.kind === "pick") {
    const options = field.options
      .map((o) => `<option value="${esc(o)}"${String(raw ?? "") === String(o) ? " selected" : ""}>${esc(o)}</option>`)
      .join("");
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <span class="select-wrap"><select class="select" ${attrs}>${options}</select>
      <span class="select-caret">${icon("chevron")}</span></span>${hint}
    </div>`;
  }

  if (field.kind === "area" || field.kind === "lines") {
    const value = field.kind === "lines" ? (Array.isArray(raw) ? raw.join("\n") : "") : raw || "";
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <textarea class="textarea" rows="2" ${attrs} placeholder="${esc(field.placeholder || "")}">${esc(value)}</textarea>${hint}
    </div>`;
  }

  if (field.kind === "group") {
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <div class="repeat">${renderFields(field.item, path, raw || {})}</div>${hint}
    </div>`;
  }

  if (field.kind === "list") {
    const items = Array.isArray(raw) ? raw : [];
    const tpl = esc(JSON.stringify(field.add ? field.add() : {}));
    const rows = items
      .map(
        (item, i) => `<div class="repeat">
          <div class="repeat-head">
            <span class="repeat-num">${String(i + 1).padStart(2, "0")}</span>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-item-move="${esc(path)}.${i}" data-dir="-1" title="Move up" aria-label="Move up" style="margin-left:auto" draggable="false"${i === 0 ? " disabled" : ""}>${icon("up", 11)}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-item-move="${esc(path)}.${i}" data-dir="1" title="Move down" aria-label="Move down" draggable="false"${i === items.length - 1 ? " disabled" : ""}>${icon("down", 11)}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-item-del="${esc(path)}.${i}" title="Remove" aria-label="Remove" draggable="false">${icon("close", 11)}</button>
          </div>
          ${renderFields(field.item, `${path}.${i}`, item)}
        </div>`
      )
      .join("");
    return `<div class="field">
      <div class="inspector-head">
        <span class="eyebrow">${esc(field.label)}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-item-add="${esc(path)}" data-item-tpl="${tpl}">${icon("plus", 12)} Add</button>
      </div>
      ${rows || `<p class="field-hint">Nothing here yet.</p>`}
    </div>`;
  }

  if (field.kind === "image") {
    // Same text field the paste box has always been — an operator with their
    // own CDN keeps that path — plus an "Upload" button next to it and a
    // "Remove" one that only appears once the value is something OUR bucket
    // produced (`isStorageAssetUrl`), so it never offers to delete a URL it
    // does not own.
    const value = typeof raw === "string" ? raw : "";
    const canRemove = isStorageAssetUrl(value);
    return `<div class="field">
      <label>${esc(field.label)}</label>
      <input class="input input-mono" type="text" ${attrs} value="${esc(value)}" placeholder="${esc(field.placeholder || "")}" />
      <div class="repeat-row">
        <button type="button" class="btn btn-ghost btn-sm" data-img-upload="${esc(path)}">Upload</button>
        ${canRemove ? `<button type="button" class="btn btn-ghost btn-sm" data-img-remove="${esc(path)}">${icon("close", 12)} Remove</button>` : ""}
      </div>
      <p class="field-hint">Uploaded images are stored in a public bucket — anyone with the link can view them.</p>
      ${hint}
    </div>`;
  }

  const mono = field.kind === "url" ? " input-mono" : "";
  const type = field.kind === "num" ? "number" : "text";
  const list = field.list ? ` list="${esc(field.list)}"` : "";
  return `<div class="field">
    <label>${esc(field.label)}</label>
    <input class="input${mono}" type="${type}" ${attrs}${list} value="${esc(raw ?? "")}" placeholder="${esc(field.placeholder || "")}" />${hint}
  </div>`;
}

/** @param {any[]} fields */
function renderFields(fields, base, parent) {
  return fields.map((f) => fieldControl(f, base, parent)).join("");
}

/* ---- Image uploads (PHASE-2-PLAN.md §1) ----------------------------------
 * A `kind: "image"` field renders the same URL text box every `kind: "url"`
 * field always has — an operator with their own CDN keeps pasting into it —
 * plus "Upload" and, once the value is one of ours, "Remove". Both buttons
 * are bound in `bindInspector`'s delegated `onClick`, the same one every
 * other structural edit in the inspector goes through.
 * -------------------------------------------------------------------------- */

/**
 * Every public URL `signAssetUpload` (apps/runtime/lib/storage.js) hands back
 * looks like `<supabase-url>/storage/v1/object/public/funnel-assets/<path>`.
 * The console never sees the Supabase URL or the bucket name from the server
 * — it is a separate browser bundle with no import path into runtime code —
 * so this marker is the one place that has to be kept in step with
 * `ASSET_BUCKET` by hand if that constant ever changes.
 */
const ASSET_URL_MARKER = "/object/public/funnel-assets/";

/**
 * Whether a field's current value is something the "Remove" button may delete.
 *
 * Parsed, not substring-matched. The decision is only cosmetic here — the server
 * re-validates the object path against an anchored regex before deleting
 * anything — but this repo's rule is that a check on a URL resolves the URL, and
 * a value like `https://evil.tld/?x=/object/public/funnel-assets/` satisfies a
 * substring test while being nothing of the kind.
 */
function isStorageAssetUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).pathname.includes(ASSET_URL_MARKER);
  } catch {
    return false;
  }
}

/** The Storage object path a public asset URL was minted for, or "" if it is not one of ours. */
function assetPathFromPublicUrl(value) {
  if (!isStorageAssetUrl(value)) return "";
  const { pathname } = new URL(String(value));
  return pathname.slice(pathname.indexOf(ASSET_URL_MARKER) + ASSET_URL_MARKER.length);
}

/** Turn `/api/admin/assets*`'s error codes into copy an operator can act on. */
function imageUploadErrorMessage(code) {
  if (code === "invalid_slug") return "Save the funnel with a valid slug before uploading images.";
  if (code === "unsupported_type") return "That file type isn't supported — use WebP, JPEG, PNG, GIF or SVG.";
  if (code === "too_large") return "That file is over the 8MB upload limit.";
  if (code === "storage_not_configured" || code === "storage_unavailable") return "Storage isn't available right now.";
  if (code === "rate_limited") return "Too many uploads in the last hour — try again shortly.";
  return "Could not upload that image.";
}

/**
 * SVG has no raster to resample and a GIF's frames would collapse to one the
 * moment a canvas reads it, so both go up byte-for-byte. Everything else is
 * re-encoded as WebP at a fixed quality — Storage's own image transformations
 * are a Pro feature (PHASE-2-PLAN.md §1 Decision 2), so this is the only place
 * a funnel's photos get smaller before they cost storage and bandwidth.
 *
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function prepareImageUpload(file) {
  if (file.type === "image/svg+xml" || file.type === "image/gif") return file;

  let bitmap;
  try {
    // `imageOrientation: "from-image"` is not the default, and without it a
    // phone photo is decoded with its EXIF rotation ignored — so the canvas
    // re-encode BAKES IN a sideways image and there is no metadata left to
    // correct it with. The paste path never had this problem because a browser
    // rendering an <img> applies the tag itself.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Not decodable as an image on this path — hand the original to Storage's
    // own content-type check rather than fail the upload ourselves.
    return file;
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 1920 / longest); // never upscale a smaller original
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const webp = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  // A null blob (canvas quirk) or a "smaller" WebP that actually grew both mean
  // the re-encode lost — the original file is always a valid upload, so it is
  // the fallback rather than a failure.
  return webp && webp.size <= file.size ? webp : file;
}

/**
 * "Upload" opens a file picker that exists only for the one pick it is made
 * for — a persisted hidden `<input type="file">` would need resetting after
 * every use or a second click would silently reuse the first one's listener.
 * The chosen file is downscaled (`prepareImageUpload`), signed through the
 * admin route, and PUT straight to Storage: PHASE-2-PLAN.md §1 Decision 1 is
 * that the bytes never pass through this server, so this fetch is the one
 * place the console talks to Supabase directly rather than through `apiFetch`.
 *
 * @param {any} step
 * @param {string} path  The step-relative JSON path `writePath` will set.
 * @param {HTMLButtonElement} btn
 */
function uploadImageField(step, path, btn) {
  const slug = state.funnel?.slug;
  // Says why rather than doing nothing. The object path is `funnel/<slug>/…`
  // and the route refuses a slug that is not one, so a funnel that has not been
  // saved yet cannot upload — and a button that silently returns is the exact
  // dead-click failure the "Use template" cards had.
  if (!slug) {
    toast("Save the funnel first — an upload is filed under its slug.", "error");
    return;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener(
    "change",
    async () => {
      const file = input.files?.[0];
      if (!file) return;

      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Uploading…";

      try {
        const blob = await prepareImageUpload(file);
        const contentType = blob.type || file.type;

        const signRes = await apiFetch("/api/admin/assets/sign", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, contentType, size: blob.size }),
        });
        if (!signRes.ok) {
          const body = await signRes.json().catch(() => ({}));
          throw new Error(body.error || `sign_${signRes.status}`);
        }
        const { uploadUrl, publicUrl } = await signRes.json();

        // No apiFetch here: the upload token lives in `uploadUrl`'s own query
        // string, and Storage never asked for the console's admin bearer on
        // top of it.
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "content-type": contentType },
          body: blob,
        });
        if (!putRes.ok) throw new Error(`upload_${putRes.status}`);

        writePath(step, path, publicUrl);
        onFunnelEdited();
        renderInspector();
        toast("Image uploaded");
      } catch (err) {
        toast(imageUploadErrorMessage(err.message), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    },
    { once: true }
  );

  input.click();
}

/**
 * "Remove" clears the field and QUEUES the object for deletion. It does not
 * delete it.
 *
 * Every other edit in this builder is in-memory and discardable by reloading
 * without saving, and the first version of this one was not: it fired the
 * `DELETE` on the click. An operator editing a LIVE funnel who removed an image
 * and then changed their mind had already destroyed the object, while the
 * published document still pointed at it — a broken image on a page they never
 * saved a change to, and nothing to undo it with. Deletion has to be a
 * consequence of saving, because saving is what makes the removal true.
 *
 * The queue is deliberately lossy in the safe direction: a save that never
 * happens, a closed tab or a failed delete all leave the object in place, which
 * is an orphan (a cleanup job, PHASE-2-PLAN.md §1) rather than a broken page.
 *
 * @param {any} step
 * @param {string} path
 */
function removeImageField(step, path) {
  const objectPath = assetPathFromPublicUrl(readPath(step, path));
  if (objectPath && !state.pendingAssetDeletes.includes(objectPath)) {
    state.pendingAssetDeletes.push(objectPath);
  }
  writePath(step, path, undefined);
  onFunnelEdited();
  renderInspector();
  toast("Image removed — the stored file goes when you save");
}

/**
 * Delete the queued objects, after the document that stopped referencing them
 * is on disk.
 *
 * Re-checked against the saved document rather than trusted: an operator can
 * remove an image and paste the same URL back, or undo by reloading a template,
 * and deleting something the funnel still points at is the failure this whole
 * mechanism exists to avoid. A substring test over the serialised document is
 * crude and deliberately so — it errs toward keeping the object, and the cost of
 * being wrong in that direction is a file nobody references.
 *
 * Failures are swallowed: the save succeeded, which is what the operator asked
 * for, and an object that outlives its funnel is not worth a red toast.
 */
async function purgeRemovedAssets() {
  const queued = state.pendingAssetDeletes;
  state.pendingAssetDeletes = [];
  if (!queued.length) return;

  const saved = JSON.stringify(state.funnel || {});
  for (const objectPath of queued) {
    if (saved.includes(objectPath)) continue;
    try {
      await apiFetch("/api/admin/assets", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: objectPath }),
      });
    } catch {
      // Orphan. See the header.
    }
  }
}

/** Split `nav.links.2` into the array it lives in and the index within it. */
function splitIndexPath(root, path) {
  const cut = path.lastIndexOf(".");
  const list = readPath(root, path.slice(0, cut));
  return { list: Array.isArray(list) ? list : null, index: +path.slice(cut + 1) };
}

/** @returns {boolean} Whether the move happened (false at either end). */
function moveWithin(list, from, delta) {
  const to = from + delta;
  if (!Array.isArray(list) || to < 0 || to >= list.length) return false;
  [list[from], list[to]] = [list[to], list[from]];
  return true;
}

/* ---- Sections (content blocks) ------------------------------------------ */

/**
 * The section editor. Available on every step type — `step.blocks` has always
 * rendered above the interaction on a choice or form step, there was simply no
 * way to author one outside a template — and it is the entire body of a landing
 * page, where blocks render below the hero.
 */
function renderSectionEditor(step) {
  const blocks = step.blocks || [];
  const isPage = step.type === "landing";

  const menu = Object.entries(BLOCK_SCHEMA)
    .map(
      ([type, spec]) =>
        `<button type="button" class="block-chip" draggable="true" data-block-add="${type}" title="Click or drag into sections list: ${esc(spec.label)}">
          <span class="block-chip-glyph">${esc(spec.glyph)}</span>${esc(spec.label)}
        </button>`
    )
    .join("");

  const cards = blocks
    .map((block, i) => {
      const spec = BLOCK_SCHEMA[block.type];
      const body = spec
        ? renderFields(spec.fields, `blocks.${i}`, block)
        : `<p class="field-hint">No editor for <code>${esc(block.type)}</code> yet — edit it in the JSON view.</p>`;
      return `<div class="repeat block-card" draggable="true" data-block-index="${i}">
        <div class="repeat-head">
          <span class="drag-handle" title="Drag to reorder section">${icon("grid", 12)}</span>
          <span class="repeat-num">${String(i + 1).padStart(2, "0")}</span>
          <span class="block-card-type">${esc(spec?.glyph || "•")} ${esc(spec?.label || block.type)}</span>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-block-move="${i}" data-dir="-1" title="Move section up" aria-label="Move section up" style="margin-left:auto" draggable="false"${i === 0 ? " disabled" : ""}>${icon("up", 12)}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-block-move="${i}" data-dir="1" title="Move section down" aria-label="Move section down" draggable="false"${i === blocks.length - 1 ? " disabled" : ""}>${icon("down", 12)}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-block-del="${i}" title="Remove section" aria-label="Remove section" draggable="false">${icon("close", 12)}</button>
        </div>
        ${body}
      </div>`;
    })
    .join("");

  return `<div class="inspector-section">
    <div class="inspector-head">
      <span class="eyebrow">${isPage ? "Page sections" : "Content blocks"}</span>
      <span class="field-hint" style="margin:0">${count(blocks.length, "section")}</span>
    </div>
    <p class="field-hint" style="margin-top:0">
      ${isPage ? "Everything below the hero. Drag sections or click palette chips below." : "Rendered above this step's interaction. Drag sections to reorder."}
    </p>
    ${cards}
    <div class="block-palette">${menu}</div>
  </div>`;
}

/* ---- Landing page panel -------------------------------------------------- */

/** A landing step that already looks like something, so the preview is never blank. */
function blankLanding() {
  return {
    layout: "centered",
    height: "tall",
    eyebrow: "Free 60-second quiz",
    headline: "The headline that sells the click",
    subtext: "One sentence on what they get and why it is worth a minute of their time.",
    cta: { label: "Start now", note: "No credit card required" },
    proof: { rating: 5, text: "Rated 4.9/5 by 1,200+ customers" },
    stickyCta: false,
  };
}

const LANDING_FIELDS = {
  hero: [
    { key: "eyebrow", label: "Eyebrow badge", kind: "text", placeholder: "Free 60-second quiz" },
    { key: "height", label: "Hero height", kind: "pick", options: ["auto", "tall", "full"] },
    { key: "width", label: "Canvas width (desktop)", kind: "pick", options: ["phone", "wide"], hint: "\"wide\" breaks out of the 9:16 phone frame." },
    { key: "scrollHint", label: "Show scroll arrow", kind: "bool" },
  ],
  media: [
    { key: "media.type", label: "Media type", kind: "pick", options: ["image", "video"] },
    { key: "media.src", label: "Media URL", kind: "url", hint: "Shown beside the copy on a split layout, below it otherwise." },
  ],
  background: [
    { key: "background.image", label: "Background image URL", kind: "image" },
    { key: "background.video", label: "Background video URL", kind: "url", hint: "Muted, looping, autoplaying." },
    { key: "background.color", label: "Background colour", kind: "text", placeholder: "#0b1020" },
    { key: "background.gradient", label: "Background gradient (CSS)", kind: "text", placeholder: "linear-gradient(160deg,#4f46e5,#0f172a)" },
    { key: "background.overlay", label: "Scrim over media (0–1)", kind: "num" },
    { key: "background.blur", label: "Media blur (px)", kind: "num" },
    { key: "background.ink", label: "Text colour", kind: "pick", options: ["", "light", "dark"] },
  ],
  cta: [
    { key: "cta.label", label: "Primary button", kind: "text", placeholder: "Start now" },
    { key: "cta.note", label: "Microcopy under the button", kind: "text" },
    { key: "cta.icon", label: "Button icon", kind: "text" },
    { key: "cta.next", label: "Branch to step ID", kind: "text", list: "stepIds" },
    { key: "cta.url", label: "External URL (instead of advancing)", kind: "url" },
    { key: "stickyCta", label: "Repeat the button in a sticky bar", kind: "bool" },
    { key: "secondaryCta.label", label: "Secondary button", kind: "text" },
    { key: "secondaryCta.variant", label: "Secondary style", kind: "pick", options: ["outline", "ghost", "solid"] },
    { key: "secondaryCta.url", label: "Secondary URL", kind: "url" },
    { key: "secondaryCta.next", label: "Secondary branch to step ID", kind: "text", list: "stepIds" },
  ],
  proof: [
    { key: "proof.text", label: "Proof line", kind: "text", placeholder: "Joined by 12,480 homeowners" },
    { key: "proof.rating", label: "Star rating (0–5)", kind: "num" },
    { key: "proof.avatars", label: "Face pile image URLs (one per line)", kind: "lines" },
  ],
  nav: [
    { key: "nav.brand", label: "Brand name", kind: "text" },
    { key: "nav.logo", label: "Logo URL", kind: "image" },
    { key: "nav.ctaLabel", label: "Nav button label", kind: "text" },
    {
      key: "nav.links",
      label: "Nav links",
      kind: "list",
      add: () => ({ label: "Link", href: "" }),
      item: [
        { key: "label", label: "Label", kind: "text" },
        { key: "href", label: "URL", kind: "url" },
      ],
    },
  ],
  footer: [
    { key: "footer.text", label: "Footer text", kind: "text", placeholder: "© 2026 Acme Inc." },
    {
      key: "footer.links",
      label: "Footer links",
      kind: "list",
      add: () => ({ label: "Privacy", href: "" }),
      item: [
        { key: "label", label: "Label", kind: "text" },
        { key: "href", label: "URL", kind: "url" },
      ],
    },
  ],
};

const LANDING_LAYOUTS = [
  ["centered", "◎ Centred"],
  ["left", "◧ Left"],
  ["split", "⬓ Split"],
  ["fullBleed", "▣ Full bleed"],
  ["minimal", "○ Minimal"],
];

/**
 * `fieldControl` addresses values relative to a base path, but the landing
 * fields above already carry their full dotted path from the step (`cta.label`),
 * so they are rendered with an empty base and the parent object resolved per
 * field. This keeps one flat table instead of a tree of nested groups.
 */
function renderLandingFields(step, fields) {
  return fields
    .map((f) => {
      const dot = f.key.lastIndexOf(".");
      if (dot === -1) return fieldControl(f, "", step);
      const parentPath = f.key.slice(0, dot);
      const leaf = { ...f, key: f.key.slice(dot + 1) };
      return fieldControl(leaf, parentPath, readPath(step, parentPath) || {});
    })
    .join("");
}

function renderLandingPanel(step) {
  const group = (title, fields, open = false) => `<details class="ins-group"${open ? " open" : ""}>
    <summary class="ins-group-head">${esc(title)}</summary>
    <div class="ins-group-body">${renderLandingFields(step, fields)}</div>
  </details>`;

  return `<div class="inspector-section">
    <div class="field">
      <label>Hero layout</label>
      <div class="seg-picker seg-wrap">
        ${LANDING_LAYOUTS.map(
          ([value, label]) =>
            `<button type="button" class="seg-btn${(step.layout || "centered") === value ? " is-active" : ""}" data-landing-layout="${value}">${esc(label)}</button>`
        ).join("")}
      </div>
    </div>
    ${group("Hero", LANDING_FIELDS.hero, true)}
    ${group("Call to action", LANDING_FIELDS.cta, true)}
    ${group("Background", LANDING_FIELDS.background)}
    ${group("Hero media", LANDING_FIELDS.media)}
    ${group("Social proof", LANDING_FIELDS.proof)}
    ${group("Top nav", LANDING_FIELDS.nav)}
    ${group("Footer", LANDING_FIELDS.footer)}
  </div>`;
}

function renderStepBody(step) {
  if (step.type === "landing") {
    return renderLandingPanel(step) + renderSectionEditor(step);
  }

  if (step.type === "choice" || step.type === "multiselect") {
    const options = (step.options || [])
      .map(
        (opt, i) => `<div class="repeat option-edit-card" draggable="true" data-opt-index="${i}">
          <div class="repeat-head">
            <span class="drag-handle-pill" title="Drag to reorder option">⋮⋮ Drag</span>
            <span class="repeat-num">${String(i + 1).padStart(2, "0")}</span>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-move-opt="${i}" data-dir="-1" title="Move up" aria-label="Move up" style="margin-left:auto" draggable="false"${i === 0 ? " disabled" : ""}>${icon("up", 11)}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-move-opt="${i}" data-dir="1" title="Move down" aria-label="Move down" draggable="false"${i === (step.options?.length || 0) - 1 ? " disabled" : ""}>${icon("down", 11)}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-dup-opt="${i}" title="Duplicate option" aria-label="Duplicate option" draggable="false">${icon("copy", 11)}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-del-opt="${i}" title="Remove option" aria-label="Remove option" draggable="false">${icon("close", 11)}</button>
          </div>
          <div class="repeat-grid" style="grid-template-columns:1fr auto;gap:6px">
            <input class="input" type="text" data-opt-label="${i}" value="${esc(opt.label || "")}" placeholder="Option label" />
            <button type="button" class="btn btn-ghost btn-sm" data-pick-symbol="${i}" title="Pick icon">
              <span style="font-size:14px;line-height:1">${esc(opt.icon || "⚡")}</span> Icon
            </button>
          </div>
          <div class="repeat-row" style="margin-top:4px">
            <input class="input input-mono" type="text" data-opt-next="${i}" value="${esc(opt.next || "")}" placeholder="Branch to step ID (optional)" list="stepIds" />
          </div>
          <details class="ins-group" style="margin-top:6px">
            <summary class="ins-group-head" style="font-size:11px">Advanced (Badge, Subtext, Image)</summary>
            <div class="ins-group-body" style="padding-top:6px">
              <div class="field" style="margin-bottom:6px">
                <label style="font-size:11px">Description / Subtext</label>
                <input class="input" type="text" data-opt-subtext="${i}" value="${esc(opt.subtext || "")}" placeholder="Description line" />
              </div>
              <div class="field" style="margin-bottom:6px">
                <label style="font-size:11px">Badge Tag</label>
                <input class="input" type="text" data-opt-badge="${i}" value="${esc(opt.badge || "")}" placeholder="e.g. Popular, Recommended" />
                <div class="badge-chips" data-opt-idx="${i}" style="margin-top:4px">
                  <button type="button" class="badge-chip" data-set-badge="🔥 Popular">🔥 Popular</button>
                  <button type="button" class="badge-chip" data-set-badge="⭐ Best Value">⭐ Best Value</button>
                  <button type="button" class="badge-chip" data-set-badge="⚡ Recommended">⚡ Recommended</button>
                </div>
              </div>
              <div class="field" style="margin-bottom:0">
                <label style="font-size:11px">Card Photo Image URL</label>
                <input class="input input-mono" type="text" data-opt-image="${i}" value="${esc(opt.image || "")}" placeholder="https://..." />
              </div>
            </div>
          </details>
        </div>`
      )
      .join("");

    return `<div class="inspector-section">
      ${
        step.type === "choice"
          ? `<div class="field row-between" style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--line)">
              <div>
                <div style="font-weight:600;font-size:12px">Auto-Advance on Click</div>
                <p class="field-hint" style="margin:0">Advance step immediately when prospect selects an option.</p>
              </div>
              <label class="switch">
                <input id="insAutoAdvance" type="checkbox"${step.autoAdvance !== false ? " checked" : ""} />
                <span class="switch-track"></span>
              </label>
            </div>`
          : ""
      }
      <div class="field" style="margin-bottom:12px">
        <label>Option Layout</label>
        <div class="seg-picker" id="insLayoutSeg">
          <button type="button" class="seg-btn${step.layout === "list" || !step.layout ? " is-active" : ""}" data-layout="list">☰ Stacked</button>
          <button type="button" class="seg-btn${step.layout === "grid" ? " is-active" : ""}" data-layout="grid">⊞ 2-Col</button>
          <button type="button" class="seg-btn${step.layout === "grid3" ? " is-active" : ""}" data-layout="grid3">▦ 3-Col</button>
        </div>
      </div>
      <div class="inspector-head">
        <span class="eyebrow">Options</span>
        <button id="addOptBtn" class="btn btn-ghost btn-sm">${icon("plus", 12)} Add</button>
      </div>
      ${options || `<p class="field-hint">No options yet.</p>`}
    </div>${renderSectionEditor(step)}`;
  }

  if (step.type === "form") {
    const fields = (step.fields || [])
      .map(
        (f, i) => `<div class="repeat">
          <div class="repeat-head">
            <span class="repeat-num">${String(i + 1).padStart(2, "0")}</span>
            <button class="btn btn-ghost btn-icon btn-sm" data-del-field="${i}" title="Remove field" aria-label="Remove field">${icon("close", 12)}</button>
          </div>
          <div class="repeat-grid" style="grid-template-columns:1fr 1fr">
            <input class="input" type="text" data-f-label="${i}" value="${esc(f.label || "")}" placeholder="Label" />
            <input class="input input-mono" type="text" data-f-name="${i}" value="${esc(f.name || "")}" placeholder="key" />
          </div>
          <div class="repeat-row">
            <span class="select-wrap" style="flex:1">
              <select class="select" data-f-type="${i}">
                ${FIELD_TYPES.map(
                  (t) => `<option value="${t}"${f.type === t ? " selected" : ""}>${t}</option>`
                ).join("")}
              </select>
              <span class="select-caret">${icon("chevron")}</span>
            </span>
            <label class="repeat-check">
              <input type="checkbox" data-f-req="${i}"${f.required ? " checked" : ""} /> Required
            </label>
          </div>
        </div>`
      )
      .join("");

    return `<div class="inspector-section">
      <div class="inspector-head">
        <span class="eyebrow">Fields</span>
        <button id="addFieldBtn" class="btn btn-ghost btn-sm">${icon("plus", 12)} Add</button>
      </div>
      ${fields || `<p class="field-hint">No fields yet.</p>`}
      <div class="field row-between" style="margin-top:14px;padding-top:10px;border-top:1px solid var(--line)">
        <div>
          <div style="font-weight:600">Email Verification (Anti-Spam OTP)</div>
          <p class="field-hint">Send a 4-digit code to prospect's email to block fake leads.</p>
        </div>
        <label class="switch">
          <input id="insVerifyEmail" type="checkbox"${step.verifyEmail ? " checked" : ""} />
          <span class="switch-track"></span>
        </label>
      </div>
    </div>${renderSectionEditor(step)}`;
  }

  if (step.type === "loader") {
    return `<div class="inspector-section">
      <div class="field">
        <label for="insDuration">Duration (ms)</label>
        <input id="insDuration" class="input input-mono" type="number" min="200" step="100" value="${esc(step.durationMs ?? 2000)}" />
        <p class="field-hint">How long the progress animation runs before advancing.</p>
      </div>
    </div>${renderSectionEditor(step)}`;
  }

  if (step.type === "content") {
    return `<div class="inspector-section">
      <div class="field">
        <label for="insCtaLabel">Button label</label>
        <input id="insCtaLabel" class="input" type="text" value="${esc(step.ctaLabel || "")}" placeholder="Continue" />
      </div>
    </div>${renderSectionEditor(step)}`;
  }

  if (step.type === "success") {
    return `<div class="inspector-section">
      <div class="field">
        <label for="insButtonLabel">Button label</label>
        <input id="insButtonLabel" class="input" type="text" value="${esc(step.buttonLabel || "")}" placeholder="Done" />
      </div>
      <div class="field">
        <label for="insRedirectUrl">Redirect URL</label>
        <input id="insRedirectUrl" class="input input-mono" type="text" value="${esc(step.redirectUrl || "")}" placeholder="https://calendly.com/…" />
        <p class="field-hint">Where the button sends them. Leave empty to stop here.</p>
      </div>
    </div>${renderSectionEditor(step)}`;
  }

  return renderSectionEditor(step);
}

/**
 * Bind the controls the current inspector render actually produced.
 *
 * EVERY lookup here must be guarded. The inspector is tabbed, so only one tab's
 * markup exists at a time: `insHeadline` / `insSubtext` / `insType` / `insId` /
 * `rewriteBtn` are in Content, `insNext` / `deleteStepBtn` are in Logic. These
 * seven were bound unconditionally and predate the tabs, so `bindInspector` threw
 * on every tab — on Content at `insNext`, on the other three at the first line.
 *
 * That throw propagated out of `renderInspector()` into `setWorkingFunnel()`,
 * which meant "Use template", "Blank Funnel" and opening a funnel all died before
 * `showView("builder")` — a click that did nothing at all, with the whole builder
 * unreachable. This is the `$("x")` guard rule in CLAUDE.md; the tabs made it
 * apply here too.
 */
function bindInspector(step) {
  const onEdit = () => onFunnelEdited();

  $("insHeadline")?.addEventListener("input", (e) => {
    step.headline = e.target.value;
    renderSpine();
    onEdit();
  });

  $("insSubtext")?.addEventListener("input", (e) => {
    step.subtext = e.target.value || undefined;
    onEdit();
  });

  $("insType")?.addEventListener("change", (e) => {
    step.type = e.target.value;
    if ((step.type === "choice" || step.type === "multiselect") && !step.options) {
      step.options = [{ id: "opt_1", label: "Option one" }];
    }
    if (step.type === "form" && !step.fields) {
      step.fields = [{ name: "email", type: "email", label: "Email", required: true }];
    }
    // A landing step with no hero, CTA or copy previews as an empty white
    // canvas, which reads as a broken editor rather than an empty one.
    if (step.type === "landing" && !step.cta) {
      const seed = blankLanding();
      if (step.headline) delete seed.headline;
      if (step.subtext) delete seed.subtext;
      Object.assign(step, seed);
    }
    renderSpine();
    renderInspector();
    onEdit();
  });

  $("insNext")?.addEventListener("input", (e) => {
    step.next = e.target.value.trim() || undefined;
    renderSpine();
    onEdit();
  });

  $("insId")?.addEventListener("input", (e) => {
    step.id = e.target.value.trim();
    renderSpine();
    onEdit();
  });

  $("deleteStepBtn")?.addEventListener("click", deleteStep);
  $("rewriteBtn")?.addEventListener("click", suggestHeadlines);

  const inspector = $("inspector");

  if ($("insHeroImage")) {
    $("insHeroImage").addEventListener("input", (e) => {
      step.image = e.target.value.trim() || undefined;
      onEdit();
    });
  }

  if ($("insVerifyEmail")) {
    $("insVerifyEmail").addEventListener("change", (e) => {
      step.verifyEmail = e.target.checked || undefined;
      onEdit();
    });
  }

  // `ctaLabel` / `buttonLabel` / `redirectUrl` are read by the engine but had no
  // console control, so a content step's button always said "Continue" and a
  // success step could not be pointed at a booking link without the JSON view.
  if ($("insCtaLabel")) {
    $("insCtaLabel").addEventListener("input", (e) => {
      step.ctaLabel = e.target.value.trim() || undefined;
      onEdit();
    });
  }

  if ($("insButtonLabel")) {
    $("insButtonLabel").addEventListener("input", (e) => {
      step.buttonLabel = e.target.value.trim() || undefined;
      onEdit();
    });
  }

  if ($("insRedirectUrl")) {
    $("insRedirectUrl").addEventListener("input", (e) => {
      step.redirectUrl = e.target.value.trim() || undefined;
      onEdit();
    });
  }

  if ($("insLayout")) {
    $("insLayout").addEventListener("change", (e) => {
      step.layout = e.target.value;
      onEdit();
    });
  }

  // These three are delegated onto `#inspector` itself, which survives the
  // `innerHTML` swap in `renderInspector()` — so without dropping the previous
  // set they accumulate one per render, and a single click on "add section" or
  // "add option" fires once per accumulated listener. Two renders in and every
  // structural edit is silently doubled.
  if (inspector._ofUnbind) inspector._ofUnbind();

  const onInput = (e) => {
    const t = e.target;
    const opts = step.options || [];
    const fields = step.fields || [];

    // Path-addressed controls (landing panel + section editor) write themselves.
    // Deliberately no re-render here: the inspector is rebuilt from scratch each
    // time, so repainting on every keystroke would move focus out of the field
    // being typed into. Structural edits below re-render; text edits do not.
    if (t.dataset.path !== undefined) {
      writePath(step, t.dataset.path, valueFromControl(t));
      onEdit();
      return;
    }

    if (t.dataset.optLabel !== undefined) opts[+t.dataset.optLabel].label = t.value;
    else if (t.dataset.optSubtext !== undefined) opts[+t.dataset.optSubtext].subtext = t.value || undefined;
    else if (t.dataset.optBadge !== undefined) opts[+t.dataset.optBadge].badge = t.value || undefined;
    else if (t.dataset.optIcon !== undefined) opts[+t.dataset.optIcon].icon = t.value || undefined;
    else if (t.dataset.optImage !== undefined) opts[+t.dataset.optImage].image = t.value.trim() || undefined;
    else if (t.dataset.optNext !== undefined) {
      opts[+t.dataset.optNext].next = t.value.trim() || undefined;
      renderSpine();
    } else if (t.dataset.fLabel !== undefined) fields[+t.dataset.fLabel].label = t.value;
    else if (t.dataset.fName !== undefined) fields[+t.dataset.fName].name = t.value.trim();
    else if (t.id === "insDuration") step.durationMs = Number(t.value) || undefined;
    else return;

    onEdit();
  };

  const onChange = (e) => {
    const t = e.target;
    if (t.dataset.path !== undefined) {
      writePath(step, t.dataset.path, valueFromControl(t));
      onEdit();
      return;
    }
    if (t.id === "insLayout") {
      step.layout = t.value;
    } else if (t.dataset.fType !== undefined) {
      step.fields[+t.dataset.fType].type = t.value;
    } else if (t.dataset.fReq !== undefined) {
      step.fields[+t.dataset.fReq].required = t.checked || undefined;
    } else return;
    onEdit();
  };

  const onClick = (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    if (btn.dataset.insTab !== undefined) {
      state.inspectorTab = btn.dataset.insTab;
      renderInspector();
      return;
    }

    if (btn.dataset.dupOpt !== undefined) {
      const idx = +btn.dataset.dupOpt;
      if (step.options?.[idx]) {
        const clone = JSON.parse(JSON.stringify(step.options[idx]));
        clone.id = `opt_${Date.now().toString(36).slice(-4)}`;
        clone.label = `${clone.label} (Copy)`;
        step.options.splice(idx + 1, 0, clone);
        renderInspector();
        onEdit();
      }
      return;
    }

    if (btn.dataset.moveOpt !== undefined) {
      const idx = +btn.dataset.moveOpt;
      const dir = +btn.dataset.dir;
      if (moveWithin(step.options, idx, dir)) {
        renderInspector();
        onEdit();
      }
      return;
    }

    if (btn.dataset.stepAlign !== undefined) {
      step.align = btn.dataset.stepAlign;
      renderInspector();
      onEdit();
      return;
    }

    if (btn.dataset.alignOpt !== undefined) {
      const picker = btn.closest("[data-align-path]");
      if (picker) {
        writePath(step, picker.dataset.alignPath, btn.dataset.alignOpt);
        renderInspector();
        onEdit();
      }
      return;
    }

    if (btn.dataset.layout !== undefined) {
      step.layout = btn.dataset.layout;
      renderInspector();
      onEdit();
      return;
    }

    if (btn.dataset.landingLayout !== undefined) {
      step.layout = btn.dataset.landingLayout;
      renderInspector();
      onEdit();
      return;
    }

    /* ----- sections ---------------------------------------------------- */

    if (btn.dataset.blockAdd !== undefined) {
      const spec = BLOCK_SCHEMA[btn.dataset.blockAdd];
      if (!spec) return;
      step.blocks ||= [];
      step.blocks.push(spec.make());
      renderInspector();
      onEdit();
      pushPreview();
      // Scroll the new section into view — the palette sits at the bottom of a
      // long panel, so without this the card is added off-screen above.
      inspector.querySelector(".block-card:last-of-type")?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (btn.dataset.blockDel !== undefined) {
      step.blocks?.splice(+btn.dataset.blockDel, 1);
      if (!step.blocks?.length) delete step.blocks;
      renderInspector();
      onEdit();
      pushPreview();
      return;
    }

    if (btn.dataset.blockMove !== undefined) {
      if (moveWithin(step.blocks, +btn.dataset.blockMove, +btn.dataset.dir)) {
        renderInspector();
        onEdit();
        pushPreview();
      }
      return;
    }

    /* ----- repeated items inside a section or the landing panel ---------- */

    if (btn.dataset.itemAdd !== undefined) {
      const path = btn.dataset.itemAdd;
      const list = readPath(step, path);
      const item = JSON.parse(btn.dataset.itemTpl || "{}");
      if (Array.isArray(list)) list.push(item);
      else writePath(step, path, [item]);
      renderInspector();
      onEdit();
      pushPreview();
      return;
    }

    if (btn.dataset.itemDel !== undefined) {
      const { list, index } = splitIndexPath(step, btn.dataset.itemDel);
      if (list) {
        list.splice(index, 1);
        renderInspector();
        onEdit();
        pushPreview();
      }
      return;
    }

    if (btn.dataset.itemMove !== undefined) {
      const { list, index } = splitIndexPath(step, btn.dataset.itemMove);
      if (moveWithin(list, index, +btn.dataset.dir)) {
        renderInspector();
        onEdit();
        pushPreview();
      }
      return;
    }

    /* ----- image fields (`kind: "image"`) --------------------------------- */

    if (btn.dataset.imgUpload !== undefined) {
      // Fire-and-forget, same as `resendDelivery` below: the click handler
      // stays sync, the async work owns its own button state.
      uploadImageField(step, btn.dataset.imgUpload, btn);
      return;
    }

    if (btn.dataset.imgRemove !== undefined) {
      removeImageField(step, btn.dataset.imgRemove);
      return;
    }

    if (btn.dataset.setBadge !== undefined) {
      const idx = +btn.closest(".badge-chips")?.dataset.optIdx;
      if (step.options?.[idx]) {
        step.options[idx].badge = btn.dataset.setBadge;
        renderInspector();
        onEdit();
      }
      return;
    }

    if (btn.dataset.pickSymbol !== undefined) {
      const idx = +btn.dataset.pickSymbol;
      const current = step.options?.[idx]?.icon || "";
      openSymbolPicker(current, (selected) => {
        if (step.options?.[idx]) {
          step.options[idx].icon = selected || undefined;
          renderInspector();
          onEdit();
        }
      });
      return;
    }

    if (btn.id === "addOptBtn") {
      step.options ||= [];
      step.options.push({ id: `opt_${Date.now().toString(36).slice(-4)}`, label: "New option" });
    } else if (btn.id === "addFieldBtn") {
      step.fields ||= [];
      step.fields.push({ name: `field_${Date.now().toString(36).slice(-4)}`, type: "text", label: "New field" });
    } else if (btn.dataset.delOpt !== undefined) {
      step.options.splice(+btn.dataset.delOpt, 1);
    } else if (btn.dataset.delField !== undefined) {
      step.fields.splice(+btn.dataset.delField, 1);
    } else {
      return;
    }

    renderInspector();
    renderSpine();
    onEdit();
  };

  if ($("insAutoAdvance")) {
    $("insAutoAdvance").addEventListener("change", (e) => {
      step.autoAdvance = e.target.checked;
      onEdit();
    });
  }

  if ($("insHideBranding")) {
    $("insHideBranding").addEventListener("change", (e) => {
      const hidden = e.target.checked;
      if (state.funnel) {
        state.funnel.branding = { ...(state.funnel.branding || {}), hidden };
      }
      localStorage.setItem("of.branding.hidden", String(hidden));
      onEdit();
      pushPreview();
    });
  }

  qsa("[data-insert-token]", inspector).forEach((btn) => {
    btn.addEventListener("click", () => {
      const token = btn.dataset.insertToken;
      const input = $("insHeadline");
      if (input) {
        const start = input.selectionStart || input.value.length;
        input.value = input.value.slice(0, start) + token + input.value.slice(start);
        step.headline = input.value;
        onEdit();
        input.focus();
      }
    });
  });

  inspector.addEventListener("input", onInput);
  inspector.addEventListener("change", onChange);
  inspector.addEventListener("click", onClick);
  inspector._ofUnbind = () => {
    inspector.removeEventListener("input", onInput);
    inspector.removeEventListener("change", onChange);
    inspector.removeEventListener("click", onClick);
  };

  bindOptionDragAndDrop();
  bindBlockDragAndDrop();
}

/** Offer alternatives rather than silently overwriting what the user wrote. */
async function suggestHeadlines() {
  const step = state.funnel?.steps[state.stepIndex];
  const btn = $("rewriteBtn");
  const host = $("headlineVariants");
  if (!step) return;

  btn.disabled = true;
  btn.innerHTML = `${icon("ai", 13)} Writing…`;

  try {
    const res = await apiFetch("/api/ai/improve-copy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        headline: step.headline || "",
        apiKey: localStorage.getItem("of.ai.key") || "",
        provider: localStorage.getItem("of.ai.provider") || "builtin",
        model: localStorage.getItem("of.ai.model") || "gpt-4o",
        tone: localStorage.getItem("of.ai.tone") || "direct",
      }),
    });
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    const hooks = (data.hooks || []).filter(Boolean);

    if (!hooks.length) {
      host.innerHTML = `<p class="field-hint">No suggestions came back.</p>`;
      return;
    }

    host.innerHTML = `<p class="field-hint" style="margin-bottom:6px">Tap one to use it.</p>${hooks
      .map(
        (hook) =>
          `<button class="btn btn-sm" style="width:100%;justify-content:flex-start;text-align:left;margin-bottom:4px;height:auto;padding:6px 9px;white-space:normal" data-hook="${esc(hook)}">${esc(hook)}</button>`
      )
      .join("")}`;

    qsa("[data-hook]", host).forEach((el) =>
      el.addEventListener("click", () => {
        step.headline = el.dataset.hook;
        $("insHeadline").value = step.headline;
        host.innerHTML = "";
        renderSpine();
        onFunnelEdited();
      })
    );
  } catch {
    toast("Could not reach the copy service", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon("ai", 13)} Suggest headlines`;
  }
}

/* ========================================================================== *
 *  Preview
 * ========================================================================== */

let previewReady = false;

/** Point the frame at a real funnel page, then drive it over postMessage. */
function mountPreview(force = false) {
  const frame = $("previewFrame");
  if (!frame || !state.funnel) return;

  // A brand-new funnel has no page on disk yet, so borrow any published shell —
  // its contents are replaced by the working document the moment it is ready.
  const host = state.funnels.some((f) => f.slug === state.funnel.slug)
    ? state.funnel.slug
    : state.funnels[0]?.slug;
  if (!host) return;

  const src = `/f/${host}?preview=1`;
  if (force || !frame.src.includes(`/f/${host}?`)) {
    previewReady = false;
    frame.src = src;
  } else {
    pushPreview();
  }
}

function pushPreview() {
  if (!previewReady || !state.funnel) return;
  $("previewFrame").contentWindow?.postMessage(
    {
      type: "of:preview",
      funnel: JSON.parse(JSON.stringify(state.funnel)),
      stepIndex: state.stepIndex,
    },
    location.origin
  );
}

const pushPreviewSoon = debounce(pushPreview, 220);

/** One funnel edit: repaint what depends on it and mark the document unsaved. */
function onFunnelEdited() {
  markDirty(true);
  applyAccent(funnelColor(state.funnel));
  pushPreviewSoon();
}

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type === "of:preview-ready") {
    previewReady = true;
    pushPreview();
  }
  if (e.data?.type === "of_reorder_options" && state.funnel) {
    const { stepId, options } = e.data;
    const targetStep = state.funnel.steps.find((s) => s.id === stepId);
    if (targetStep && Array.isArray(options)) {
      targetStep.options = options;
      markDirty();
      renderInspector();
    }
  }
  if (e.data?.type === "of_reorder_blocks" && state.funnel) {
    const { stepId, blocks } = e.data;
    const targetStep = state.funnel.steps.find((s) => s.id === stepId);
    if (targetStep && Array.isArray(blocks)) {
      targetStep.blocks = blocks;
      markDirty();
      renderInspector();
    }
  }
  if (e.data?.type === "of_select_block" && state.funnel) {
    const { blockIndex } = e.data;
    state.inspectorTab = "blocks";
    renderInspector();
    const cards = qsa(".block-card", $("inspector"));
    if (cards[blockIndex]) {
      cards[blockIndex].scrollIntoView({ block: "nearest", behavior: "smooth" });
      cards[blockIndex].classList.add("drop-before");
      setTimeout(() => cards[blockIndex]?.classList.remove("drop-before"), 1500);
    }
  }
  if (e.data?.type === "of_update_path" && state.funnel) {
    const { stepId, path, value } = e.data;
    const targetStep = state.funnel.steps.find((s) => s.id === stepId);
    if (targetStep && path) {
      writePath(targetStep, path, value);
      onFunnelEdited();
      renderInspector();
    }
  }
});

/* ========================================================================== *
 *  Leads
 * ========================================================================== */

function visibleLeads() {
  const query = $("leadSearch").value.trim().toLowerCase();
  if (!query) return state.leads;
  return state.leads.filter((lead) => JSON.stringify(lead).toLowerCase().includes(query));
}

function renderLeads() {
  const body = $("leadsBody");
  const leads = visibleLeads();
  const query = $("leadSearch").value.trim();

  $("leadsSub").textContent = state.leads.length
    ? `${count(state.leads.length, "capture")} across every funnel.`
    : "Everything your funnels have captured.";

  if (!leads.length) {
    body.innerHTML = `<tr><td colspan="4"><div class="empty">
      <div class="empty-title">${query ? "No matching leads" : "No leads yet"}</div>
      <p class="empty-body">${
        query
          ? "Try a different name, email or answer."
          : "Complete one of your funnels and the submission lands here."
      }</p>
    </div></td></tr>`;
    return;
  }

  body.innerHTML = leads
    .map((lead, i) => {
      const who = String(lead.lead?.email || lead.lead?.phone || lead.lead?.name || "Anonymous");
      const answers = Object.entries(lead.answers || {})
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join(" · ");
      return `<tr data-lead="${i}" tabindex="0">
        <td class="cell-mono">${esc(relativeTime(lead.received_at))}</td>
        <td><span class="tag">${esc(lead.funnelId || "unknown")}</span></td>
        <td style="font-weight:500">${esc(who)}</td>
        <td class="cell-answers">${esc(answers || "—")}</td>
      </tr>`;
    })
    .join("");
}

function openLeadDrawer(lead) {
  const contact = lead.lead || {};
  const answers = lead.answers || {};
  const who = String(contact.email || contact.phone || contact.name || "Anonymous Visitor");

  const contactItems = Object.entries(contact)
    .filter(([, v]) => v)
    .map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line-soft)"><span style="font-weight:600;color:var(--text-2);text-transform:capitalize">${esc(k)}</span><span style="font-weight:500">${esc(v)}</span></div>`)
    .join("");

  const answerItems = Object.entries(answers)
    .map(([stepId, val], idx) => {
      const displayVal = Array.isArray(val) ? val.join(", ") : val;
      return `<div class="timeline-step">
        <span class="timeline-step-num">Step ${String(idx + 1).padStart(2, "0")} · ${esc(stepId)}</span>
        <div class="timeline-step-a">${esc(displayVal)}</div>
      </div>`;
    })
    .join("");

  $("drawerBody").innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
      <span class="avatar-bubble" style="width:40px;height:40px;font-size:16px">${esc((who.charAt(0) || "?").toUpperCase())}</span>
      <div>
        <div style="font-size:16px;font-weight:600;color:var(--text)">${esc(who)}</div>
        <div style="font-size:12px;color:var(--text-2);margin-top:2px">Captured ${esc(relativeTime(lead.received_at))} in <span class="tag">${esc(lead.funnelId || "funnel")}</span></div>
      </div>
    </div>

    <div class="kv">
      <div class="kv-key">Contact Details</div>
      <div class="kv-val" style="margin-top:6px">${contactItems || "<span style='color:var(--text-3)'>No contact fields</span>"}</div>
    </div>

    <div class="kv" style="margin-top:16px">
      <div class="kv-key">Submission Timeline (${Object.keys(answers).length} responses)</div>
      <div class="answer-timeline">
        ${answerItems || "<div style='color:var(--text-3);font-size:13px'>No quiz answers logged</div>"}
      </div>
    </div>

    <div class="kv" style="margin-top:16px">
      <div class="kv-key">Raw Submission Metadata</div>
      <!-- No IP field: nothing stores one any more (PLAN.md §10), and the line
           that used to print one fell back to a hardcoded "127.0.0.1" whenever
           the record had none — a fabricated address in a panel labelled raw. -->
      <div class="kv-val"><pre>${esc(JSON.stringify({ id: lead.id, received_at: lead.received_at, funnelId: lead.funnelId }, null, 2))}</pre></div>
    </div>

    <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--line);display:flex;gap:8px">
      <button id="drawerExportBtn" class="btn btn-primary" style="flex:1">
        ${icon("download", 13)} Export CSV
      </button>
      <button id="drawerCopyJsonBtn" class="btn btn-ghost" style="flex:1">
        ${icon("copy", 13)} Copy JSON
      </button>
    </div>
  `;

  $("drawerExportBtn")?.addEventListener("click", exportCsv);
  $("drawerCopyJsonBtn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(JSON.stringify(lead, null, 2));
    toast("Lead JSON copied to clipboard");
  });

  $("drawerScrim").classList.add("is-open");
  $("leadDrawer").classList.add("is-open");
  $("leadDrawer").setAttribute("aria-hidden", "false");
  $("drawerCloseBtn").focus();
}

function closeLeadDrawer() {
  $("drawerScrim").classList.remove("is-open");
  $("leadDrawer").classList.remove("is-open");
  $("leadDrawer").setAttribute("aria-hidden", "true");
}

function exportCsv() {
  const leads = visibleLeads();
  if (!leads.length) {
    toast("Nothing to export", "error");
    return;
  }

  // Lead values are whatever a stranger typed into a form. Excel and Sheets
  // treat a leading =, +, - or @ as a formula, so an exported name field like
  // `=HYPERLINK("http://evil","Invoice")` runs against whoever opens the file.
  // Prefix those with a quote so they stay text. (OWASP CSV injection.)
  const cell = (v) => {
    const raw = String(v ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const headers = [
    "captured_at",
    "funnel",
    "name",
    "email",
    "phone",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "answers",
    "referrer",
  ];
  const rows = leads.map((l) => {
    const utm = l.meta?.utm || l.utm || {};
    return [
      l.received_at || "",
      l.funnelId || "",
      l.lead?.name || "",
      l.lead?.email || "",
      l.lead?.phone || "",
      utm.utm_source || "",
      utm.utm_medium || "",
      utm.utm_campaign || "",
      utm.utm_term || "",
      utm.utm_content || "",
      utm.gclid || "",
      utm.fbclid || "",
      JSON.stringify(l.answers || {}),
      l.referrer || l.meta?.referrer || "",
    ].map(cell).join(",");
  });

  const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `openfunnel-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${count(leads.length, "lead")}`);
}

/* ========================================================================== *
 *  Analytics — the same spine, measured
 * ========================================================================== */

function renderAnalytics() {
  const stats = state.stats;
  const host = $("measureSpine");
  if (!stats) return;

  $("aStarts").textContent = (stats.starts || 0).toLocaleString();
  $("aLeads").textContent = (stats.leads || 0).toLocaleString();
  $("aCompletes").textContent = (stats.completes || 0).toLocaleString();

  // Order by the funnel document, so the chart matches the builder exactly.
  const measured = new Map((stats.steps || []).map((s) => [s.stepId, s.sessions]));
  const ordered = state.funnel
    ? state.funnel.steps.map((s) => ({ stepId: s.id, title: stepTitle(s), sessions: measured.get(s.id) || 0 }))
    : (stats.steps || []).map((s) => ({ stepId: s.stepId, title: s.stepId, sessions: s.sessions }));

  const peak = Math.max(1, ...ordered.map((s) => s.sessions));
  const totalSeen = ordered.reduce((sum, s) => sum + s.sessions, 0);

  if (!totalSeen) {
    host.innerHTML = `<div class="empty">
      <div class="empty-title">No traffic yet</div>
      <p class="empty-body">Once visitors move through this funnel, each step shows how many reached it and how many left.</p>
    </div>`;
    $("aWorst").textContent = "—";
    $("aWorstNote").textContent = "Needs traffic to measure";
    return;
  }

  let worst = { drop: 0, title: null };

   host.innerHTML = ordered
    .map((s, i) => {
      const prev = i === 0 ? null : ordered[i - 1].sessions;
      const drop = prev && prev > 0 ? Math.round(((prev - s.sessions) / prev) * 100) : null;
      if (drop !== null && drop > worst.drop) worst = { drop, title: s.title, stepId: s.stepId };

      const widthPct = Math.max(4, Math.round((s.sessions / peak) * 100));
      return `<div class="analytics-bar-row">
        <div class="analytics-bar-head">
          <span class="analytics-bar-title">${String(i + 1).padStart(2, "0")}. ${esc(s.title)} <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-left:4px">(${esc(s.stepId)})</span></span>
          <div style="display:flex;align-items:center;gap:10px">
            ${drop !== null ? `<span class="tag ${drop > 20 ? "tag-warning" : ""}">${drop > 0 ? `−${drop}% drop` : "100% kept"}</span>` : ""}
            <span class="analytics-bar-count">${s.sessions.toLocaleString()} visitors</span>
          </div>
        </div>
        <div class="analytics-bar-track">
          <div class="analytics-bar-fill" style="width: ${widthPct}%"></div>
        </div>
      </div>`;
    })
    .join("");

  $("aWorst").textContent = worst.title ? `−${worst.drop}%` : "—";
  $("aWorstNote").textContent = worst.title
    ? `Step ${worst.stepId} (“${worst.title}”)`
    : "No major drop-offs";
}

/* ========================================================================== *
 *  Delivery — a read of the queue, not a second copy of it (PHASE-1-PLAN.md
 *  §4.4). No polling anywhere in this section: a fresh read happens when the
 *  panel opens or the operator clicks Refresh, never on a timer.
 * ========================================================================== */

/** The only three states `resend_delivery` accepts — most importantly NOT
 *  `delivering`, where a lease is still out and a second dispatch would
 *  double-send. */
const RESENDABLE_DELIVERY_STATUSES = new Set(["dead", "done", "cancelled"]);

/** "done" reads positive, "dead" reads negative. Everything else is neutral —
 *  `pending`/`delivering`/`cancelled` aren't good or bad, just states. */
const DELIVERY_STATUS_TONE = { done: "trend-pos", dead: "trend-neg" };

function deliveryStatusBadge(status) {
  const tone = DELIVERY_STATUS_TONE[status];
  return tone
    ? `<span class="trend-badge ${tone}">${esc(status)}</span>`
    : `<span class="tag">${esc(status)}</span>`;
}

function truncateText(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * When the next attempt is due. `relativeTime` is past-tense by design and every
 * other view wants it that way — but a scheduled retry is in the FUTURE, so it
 * rendered a delivery 90 seconds out as "Next just now", which is the log
 * quietly lying about the one column an operator reads while waiting.
 */
function untilTime(iso) {
  const ms = iso ? new Date(iso).getTime() - Date.now() : NaN;
  if (Number.isNaN(ms)) return "soon";
  if (ms <= 0) return "due now";
  if (ms < 60000) return `in ${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `in ${Math.round(ms / 60000)}m`;
  return `in ${Math.round(ms / 3600000)}h`;
}

/** An id shortened for a table cell; the untruncated value still lives in `title`. */
function shortDeliveryId(id) {
  const s = String(id ?? "");
  return s.length > 10 ? `${s.slice(0, 8)}…` : s || "—";
}

/**
 * Labels a row using the funnel list already loaded for the switcher
 * (`state.funnels`, from `/api/funnels`) — no second API call to print a name.
 *
 * Matched on SLUG, which is why the server sends `funnelSlug`: `/api/funnels`
 * returns `{ slug, name, primary, mode, steps }` and never the funnel table's
 * UUID, so matching on `funnelId` would have labelled every row with a raw UUID
 * forever (§4.4 Decision 1, corrected). The id is the last fallback, so a row
 * still identifies itself if a funnel was deleted out from under it.
 */
function deliveryFunnelLabel(d) {
  const match = d.funnelSlug ? state.funnels.find((f) => f.slug === d.funnelSlug) : null;
  return (match && (match.name || match.slug)) || d.funnelSlug || d.funnelId || "—";
}

async function loadDeliveries() {
  const status = $("deliveryStatusFilter")?.value || "all";
  const qs = new URLSearchParams({ limit: "100" });
  if (status !== "all") qs.set("status", status);

  try {
    const res = await apiFetch(`/api/admin/deliveries?${qs}`);
    if (res.status === 503) {
      // Opposite of an empty list, not a variant of one: no queue exists at
      // all, so a self-hosted install without a database isn't told its
      // delivery log is merely quiet.
      state.deliveryState = "unconfigured";
      state.deliveries = [];
    } else if (res.status === 401) {
      // The token lives in localStorage, which is per-ORIGIN — so opening the
      // same deployment by a different hostname (a branch alias rather than the
      // deployment URL, say) looks exactly like a broken server unless this
      // says otherwise. "The server did not answer" sent me looking at the
      // queue when the answer was a missing token.
      state.deliveryState = "unauthorized";
      state.deliveries = [];
    } else if (!res.ok) {
      throw new Error(`status ${res.status}`);
    } else {
      const data = await res.json();
      state.deliveries = data.deliveries || [];
      state.deliveryState = "ready";
    }
  } catch {
    state.deliveryState = "error";
    state.deliveries = [];
  }
  renderDeliveries();
}

function renderDeliveries() {
  const unconfigured = $("deliveryUnconfigured");
  const wrap = $("deliveryTableWrap");
  const body = $("deliveryBody");
  const sub = $("deliverySub");

  if (state.deliveryState === "unconfigured") {
    unconfigured.hidden = false;
    wrap.hidden = true;
    sub.textContent = "The delivery queue is not configured; leads are delivered directly.";
    return;
  }
  unconfigured.hidden = true;
  wrap.hidden = false;

  const rows = state.deliveries;
  sub.textContent =
    state.deliveryState === "unauthorized"
      ? "Not authorised — paste the admin token in Settings."
      : state.deliveryState === "error"
        ? "Could not load the delivery log."
        : rows.length
        ? `${count(rows.length, "delivery", "deliveries")}, newest first.`
        : "Where every lead went, and whether it arrived.";

  if (!rows.length) {
    const EMPTY = {
      unauthorized: [
        "Not authorised",
        "This browser has no admin token for this hostname. Settings → Admin API token.",
      ],
      error: ["Could not load deliveries", "The server did not answer — try Refresh."],
      ready: ["Nothing queued", "No deliveries match this filter yet."],
    };
    const [title, hint] = EMPTY[state.deliveryState] || EMPTY.ready;
    body.innerHTML = `<tr><td colspan="8"><div class="empty">
      <div class="empty-title">${esc(title)}</div>
      <p class="empty-body">${esc(hint)}</p>
    </div></td></tr>`;
    return;
  }

  // Every value below that came from the server — kind, funnelId (and its
  // label), status, lastError — goes through `esc()` before it reaches
  // `innerHTML`. `lastError` is a truncated summary of an upstream response to
  // a URL an operator typed, so it is exactly as trusted as any other visitor
  // input this console renders (see CLAUDE.md's escaping rule).
  body.innerHTML = rows
    .map((d, i) => {
      const timing = d.deliveredAt
        ? `Delivered ${esc(relativeTime(d.deliveredAt))}`
        : d.status === "pending" || d.status === "delivering"
          ? `Next ${esc(untilTime(d.nextAttemptAt))}`
          : "—";
      const hasResult = d.lastStatus != null || d.lastError;
      const result = hasResult
        ? `<div class="cell-mono" style="white-space:normal;color:var(--text-2)" title="${esc(d.lastError || "")}">${
            d.lastStatus != null ? esc(`HTTP ${d.lastStatus}`) : ""
          }${d.lastStatus != null && d.lastError ? " — " : ""}${esc(truncateText(d.lastError, 80))}</div>`
        : `<span style="color:var(--text-3)">—</span>`;
      const resend = RESENDABLE_DELIVERY_STATUSES.has(d.status)
        ? `<button class="btn btn-sm" data-resend="${i}">Resend</button>`
        : "";
      return `<tr>
        <td class="cell-mono" title="${esc(d.createdAt || "")}">${esc(relativeTime(d.createdAt))}</td>
        <td><span class="tag">${esc(deliveryFunnelLabel(d))}</span></td>
        <td><span class="tag">${esc(d.kind)}</span></td>
        <td>${deliveryStatusBadge(d.status)}<div class="cell-mono" style="margin-top:3px">${esc(count(d.attempts, "attempt"))}</div></td>
        <td>${result}</td>
        <td class="cell-mono">${timing}</td>
        <td class="cell-mono" title="${esc(d.leadId || "")}">${esc(shortDeliveryId(d.leadId))}<div style="color:var(--text-3)">${esc(relativeTime(d.leadCreatedAt))}</div></td>
        <td>${resend}</td>
      </tr>`;
    })
    .join("");
}

/**
 * Posts `{ id }` to the resend endpoint and reports whatever it answers. The
 * server attempts the delivery inline, so this can take a few seconds — the
 * button stays disabled for the whole round trip, not just until the request
 * is sent (PHASE-1-PLAN.md §4.4 Decision 2).
 */
async function resendDelivery(id, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Resending…";
  }
  let refresh = false;
  try {
    const res = await apiFetch("/api/admin/deliveries/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      const data = await res.json();
      toast(`Resent — now ${data.status}, attempt ${data.attempts}`);
      refresh = true;
    } else if (res.status === 404) {
      toast("That delivery no longer exists", "error");
      refresh = true;
    } else if (res.status === 409) {
      // The server distinguishes a lost race from a lead that may not be
      // delivered at all — clicking again fixes the first and never the second.
      const reason = await res.json().catch(() => ({}));
      toast(
        reason.error === "lead_restricted"
          ? "That lead is restricted — it cannot be delivered until the restriction is lifted"
          : reason.error === "lead_deleted"
            ? "That lead was deleted — it cannot be delivered"
            : "That delivery's state changed before the resend landed",
        "error",
      );
      refresh = true;
    } else if (res.status === 429) {
      toast("Hourly re-send limit reached — try again later", "error");
    } else if (res.status === 503) {
      toast("The delivery queue is not configured", "error");
    } else {
      toast("Could not resend that delivery", "error");
    }
  } catch {
    toast("Could not resend that delivery", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Resend";
    }
  }
  if (refresh) await loadDeliveries();
}

async function syncDeliveryTargets() {
  const btn = $("deliverySyncBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Re-syncing…";
  }
  try {
    const res = await apiFetch("/api/admin/targets/sync", { method: "POST" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    toast(`Re-synced targets — ${data.synced ?? 0} synced, ${data.failed ?? 0} failed`, data.failed ? "error" : "ok");
  } catch {
    toast("Could not re-sync delivery targets", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${icon("broadcast", 13)} Re-sync targets`;
    }
  }
}

function bindDelivery() {
  $("deliveryStatusFilter").addEventListener("change", loadDeliveries);
  $("deliveryRefreshBtn").addEventListener("click", loadDeliveries);
  $("deliverySyncBtn").addEventListener("click", syncDeliveryTargets);
  // Delegated: rows are rendered, not authored, so a per-button listener would
  // never survive the next innerHTML swap. Index into state.deliveries rather
  // than round-tripping the id through a data-* string attribute, so a bigint
  // id is passed back to the server exactly as the JSON response carried it.
  $("deliveryBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-resend]");
    if (!btn) return;
    const row = state.deliveries[+btn.dataset.resend];
    if (row) resendDelivery(row.id, btn);
  });
}

/* ========================================================================== *
 *  Domains — map a client hostname to one of this workspace's funnels
 *  (PHASE-2-PLAN.md §2). This view only ever writes a row in the `domain`
 *  table. It never calls Vercel and never shows a DNS value: attaching the
 *  domain to this project and pointing the client's DNS at it are Decision
 *  3's two steps the plan deliberately leaves manual (no production
 *  deployment exists yet on Hobby, and the A/CNAME values are per-project —
 *  see reference/vercel-custom-domains-2026-08-13.md §Q4), so the view says
 *  what to do instead of getting either one wrong.
 * ========================================================================== */

/**
 * One line per `{ error }` body `POST /api/admin/domains` and its DELETE can
 * send back. A generic "something went wrong" would cost the operator a trip
 * to the server log for a failure the response already named — especially
 * `would_lock_out_console`, where the fix is "map a different host", and
 * `db_not_configured`, where the fix is "edit FUNNEL_DOMAINS instead", and
 * conflating either with a normal failure sends the operator retrying a
 * request that cannot succeed differently next time.
 */
const DOMAIN_ERRORS = {
  invalid_host: "That doesn't look like a real hostname.",
  invalid_slug: "Pick a funnel first.",
  would_lock_out_console: "That is the hostname this console is on — mapping it would lock the console out of itself.",
  db_not_configured: "No database configured — set FUNNEL_DOMAINS instead.",
  db_unavailable: "The database didn't answer — try again.",
  env_mapping: "That mapping comes from FUNNEL_DOMAINS — edit it on the server, not here.",
  rate_limited: "Too many domain changes — try again in an hour.",
};

function domainErrorToast(res, body) {
  toast(DOMAIN_ERRORS[body?.error] || `Could not save that (status ${res.status})`, "error");
}

async function loadDomains() {
  try {
    const res = await apiFetch("/api/admin/domains");
    if (res.status === 401) {
      // Same signal as the delivery log: the admin token lives in
      // localStorage per ORIGIN, so a branch alias with nothing pasted in
      // looks exactly like a broken server unless this says otherwise.
      state.domainsState = "unauthorized";
      state.domains = [];
    } else if (!res.ok) {
      throw new Error(`status ${res.status}`);
    } else {
      const data = await res.json();
      state.domains = data.domains || [];
      state.domainsWritable = Boolean(data.writable);
      state.domainsState = "ready";
    }
  } catch {
    state.domainsState = "error";
    state.domains = [];
  }
  renderDomains();
}

const DOMAINS_EMPTY = {
  unauthorized: ["Not authorised", "This browser has no admin token for this hostname. Settings → Admin API token."],
  error: ["Could not load domains", "The server did not answer — try Refresh."],
};

function renderDomains() {
  const notice = $("domainsUnwritable");
  const body = $("domainsBody");
  const sub = $("domainsSub");
  const addBtn = $("domainAddBtn");
  const hostInput = $("domainHostInput");
  const funnelSelect = $("domainFunnelSelect");

  const writable = state.domainsState === "ready" && state.domainsWritable;

  // The form is disabled outright rather than left clickable and failing on
  // submit: the server already told us (via `writable`) that a write here
  // cannot succeed, so waiting for the operator to click and then toasting
  // the reason is strictly worse than showing it up front.
  if (addBtn) addBtn.disabled = !writable;
  if (hostInput) hostInput.disabled = !writable;
  if (funnelSelect) funnelSelect.disabled = !writable;
  // Only shown for the specific "loaded fine, but read-only" case — the
  // unauthorized/error states get their own empty-table message below, and
  // showing both would tell the operator two different things at once.
  if (notice) notice.hidden = writable || state.domainsState !== "ready";

  if (funnelSelect) {
    const current = funnelSelect.value;
    // Sourced from `state.funnels`, the same list every other view's funnel
    // picker reads (`renderSwitcher`, `deliveryFunnelLabel`) — no second
    // fetch to populate a dropdown the console already has the data for.
    const options = state.funnels
      .map((f) => `<option value="${esc(f.slug)}">${esc(f.name || f.slug)}</option>`)
      .join("");
    funnelSelect.innerHTML = `<option value="">Select a funnel…</option>${options}`;
    if (state.funnels.some((f) => f.slug === current)) funnelSelect.value = current;
  }

  if (sub) {
    sub.textContent =
      state.domainsState === "unauthorized"
        ? "Not authorised — paste the admin token in Settings."
        : state.domainsState === "error"
          ? "Could not load domain mappings."
          : !state.domainsWritable
            ? "Read-only — no database configured."
            : state.domains.length
              ? `${count(state.domains.length, "mapping")}.`
              : "No hostnames mapped yet.";
  }

  if (!body) return;

  if (state.domainsState !== "ready") {
    const [title, hint] = DOMAINS_EMPTY[state.domainsState] || DOMAINS_EMPTY.error;
    body.innerHTML = `<tr><td colspan="3"><div class="empty">
      <div class="empty-title">${esc(title)}</div>
      <p class="empty-body">${esc(hint)}</p>
    </div></td></tr>`;
    return;
  }

  if (!state.domains.length) {
    body.innerHTML = `<tr><td colspan="3"><div class="empty">
      <div class="empty-title">No domains mapped</div>
      <p class="empty-body">Add a hostname above once its DNS points at this Vercel project.</p>
    </div></td></tr>`;
    return;
  }

  // `host` and `slug` reach here off a database row (or FUNNEL_DOMAINS) — a
  // hostname a client typed into their DNS provider, not something this
  // console authored, so it gets the same esc() treatment as any other
  // visitor-sourced string rendered as markup (CLAUDE.md's Escaping rule).
  body.innerHTML = state.domains
    .map(
      (d, i) => `<tr>
        <td class="cell-mono">${esc(d.host)}</td>
        <td><span class="tag">${esc(d.slug)}</span></td>
        <td>${
          writable && d.source !== "env"
            ? `<button class="btn btn-sm" data-delete-domain="${i}">Remove</button>`
            // An env mapping has no row to delete, and a PostgREST delete that
            // matches nothing still succeeds — so a button here would report
            // "unmapped" while the mapping stayed live and came back on the
            // next refresh. Say where it lives instead.
            : d.source === "env"
              ? `<span class="field-hint">FUNNEL_DOMAINS</span>`
              : ""
        }</td>
      </tr>`,
    )
    .join("");
}

async function addDomainMapping() {
  const hostInput = $("domainHostInput");
  const funnelSelect = $("domainFunnelSelect");
  const btn = $("domainAddBtn");
  const host = hostInput?.value.trim() || "";
  const slug = funnelSelect?.value || "";
  if (!host) return toast("Enter a hostname", "error");
  if (!slug) return toast("Pick a funnel", "error");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Mapping…";
  }
  try {
    const res = await apiFetch("/api/admin/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host, slug }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      toast(`${host} now serves ${slug}`);
      if (hostInput) hostInput.value = "";
      await loadDomains();
    } else {
      domainErrorToast(res, data);
    }
  } catch {
    toast("Could not reach the server", "error");
  } finally {
    if (btn) {
      // Re-enable unless the state that made it clickable has itself
      // changed mid-request — loadDomains() (on success) already re-runs
      // renderDomains(), which sets this correctly; this covers the error
      // path, where nothing else touches the button.
      btn.disabled = !(state.domainsState === "ready" && state.domainsWritable);
      btn.textContent = "Map domain";
    }
  }
}

async function deleteDomainMapping(host, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Removing…";
  }
  try {
    const res = await apiFetch(`/api/admin/domains?host=${encodeURIComponent(host)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      // `stillMappedBy` is set when the host is also in FUNNEL_DOMAINS: the row
      // is gone and the hostname still serves a funnel, so "unmapped" would be
      // wrong in the one direction that matters.
      toast(
        data.stillMappedBy === "env"
          ? `${host} now falls back to its FUNNEL_DOMAINS mapping`
          : `${host} unmapped`,
      );
      await loadDomains();
      return;
    }
    domainErrorToast(res, data);
  } catch {
    toast("Could not reach the server", "error");
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Remove";
  }
}

function bindDomains() {
  $("domainsRefreshBtn")?.addEventListener("click", loadDomains);
  $("domainAddBtn")?.addEventListener("click", addDomainMapping);
  $("domainHostInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDomainMapping();
    }
  });
  // Delegated, like the delivery log's resend button: rows are rendered, not
  // authored, so a listener bound to one button would not survive the next
  // innerHTML swap.
  $("domainsBody")?.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-delete-domain]");
    if (!trigger) return;
    const row = state.domains[+trigger.dataset.deleteDomain];
    if (row) deleteDomainMapping(row.host, trigger);
  });
}

/* ========================================================================== *
 *  Reports — a signed `/r/:token` link a client opens to see their own leads,
 *  with no login (PHASE-2-PLAN.md §3). This view is the entire admin surface
 *  for that credential: `POST` mints one, `GET` lists metadata about it and
 *  `DELETE` revokes it — the token itself travels in exactly one response,
 *  the mint, and never again (Decision 9). Modeled on the Domains section
 *  immediately above: same load/render/bind shape, same `writable`-style
 *  "can't do anything here" state, same delegated row-button pattern.
 * ========================================================================== */

/**
 * One line per `{ error }` body the issue/revoke routes can send back — same
 * reasoning as `DOMAIN_ERRORS`: a generic failure message would send the
 * operator retrying a request that cannot succeed differently next time.
 */
const REPORT_ERRORS = {
  invalid_client: "Pick a client first.",
  unknown_client: "That client no longer exists — refresh and try again.",
  db_not_configured: "No database configured — reports are unavailable.",
  db_unavailable: "The database didn't answer — try again.",
  rate_limited: "Too many report links issued in the last hour — try again later.",
  invalid_id: "That link no longer exists.",
  not_found_or_already_revoked: "That link was already revoked.",
};

function reportErrorToast(res, body) {
  toast(REPORT_ERRORS[body?.error] || `Could not save that (status ${res.status})`, "error");
}

/** Classifies one fetch outcome into the same states `renderReports()` reads. */
function reportFetchState(res) {
  if (res.status === 503) return "unconfigured";
  if (res.status === 401) return "unauthorized";
  if (!res.ok) return "error";
  return "ready";
}

/**
 * Loads both the token list and the client picker's options in one round
 * trip each. They are gated identically server-side (same `dbConfigured()`,
 * same admin check), so in practice they succeed or fail together — the
 * token response's state wins when it doesn't, since the list is this view's
 * primary content and the picker is only ever secondary to it.
 */
async function loadReports() {
  try {
    const [tokensRes, clientsRes] = await Promise.all([
      apiFetch("/api/admin/report-tokens"),
      apiFetch("/api/admin/clients"),
    ]);
    const tState = reportFetchState(tokensRes);
    const overall = tState !== "ready" ? tState : reportFetchState(clientsRes);
    if (overall !== "ready") {
      state.reportsState = overall;
      state.reports = [];
      state.reportClients = [];
    } else {
      const [tokensData, clientsData] = await Promise.all([tokensRes.json(), clientsRes.json()]);
      state.reports = tokensData.tokens || [];
      state.reportClients = clientsData.clients || [];
      state.reportsState = "ready";
    }
  } catch {
    state.reportsState = "error";
    state.reports = [];
    state.reportClients = [];
  }
  renderReports();
}

/**
 * Never touches `#reportIssuedPanel`. That panel is the one place in this
 * view a token's full URL ever appears, it exists for exactly one reason —
 * so the operator can copy it before it is gone forever — and this function
 * runs after every load, every revoke and every issue. If it cleared the
 * panel, the panel would not have survived long enough to be read.
 */
function renderReports() {
  const unconfigured = $("reportsUnconfigured");
  const issueCard = $("reportIssueCard");
  const wrap = $("reportsTableWrap");
  const body = $("reportsBody");
  const sub = $("reportsSub");
  const clientSelect = $("reportClientSelect");
  const labelInput = $("reportLabelInput");
  const issueBtn = $("reportIssueBtn");
  const noClients = $("reportsNoClients");

  // No database, no per-client store to scope a report to (§3 Decision 8) —
  // the issue form is hidden outright rather than left clickable and failing
  // on submit, same posture as the Domains view's own unwritable state.
  if (state.reportsState === "unconfigured") {
    if (unconfigured) unconfigured.hidden = false;
    if (issueCard) issueCard.hidden = true;
    if (wrap) wrap.hidden = true;
    if (sub) sub.textContent = "No database configured — reports are unavailable.";
    return;
  }
  if (unconfigured) unconfigured.hidden = true;
  if (issueCard) issueCard.hidden = false;
  if (wrap) wrap.hidden = false;

  const ready = state.reportsState === "ready";
  const hasClients = ready && state.reportClients.length > 0;

  if (clientSelect) {
    const current = clientSelect.value;
    // The server refuses a mint with no `clientId` and never guesses one
    // (§3 Decision 3), so an empty picker cannot fall back to "the only
    // client" the way `saveFunnel` may — it has to say there is nothing to
    // pick, which `#reportsNoClients` below does.
    clientSelect.innerHTML = hasClients
      ? `<option value="">Select a client…</option>${state.reportClients
          .map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.slug)}</option>`)
          .join("")}`
      : `<option value="">No clients yet</option>`;
    if (hasClients && state.reportClients.some((c) => c.id === current)) clientSelect.value = current;
    clientSelect.disabled = !hasClients;
  }
  if (labelInput) labelInput.disabled = !hasClients;
  if (issueBtn) issueBtn.disabled = !hasClients;
  if (noClients) noClients.hidden = !(ready && state.reportClients.length === 0);

  if (sub) {
    sub.textContent =
      state.reportsState === "unauthorized"
        ? "Not authorised — paste the admin token in Settings."
        : state.reportsState === "error"
          ? "Could not load report links."
          : state.reports.length
            ? `${count(state.reports.length, "link")} issued.`
            : "No report links issued yet.";
  }

  if (!body) return;

  if (state.reportsState !== "ready") {
    const EMPTY = {
      unauthorized: ["Not authorised", "This browser has no admin token for this hostname. Settings → Admin API token."],
      error: ["Could not load report links", "The server did not answer — try Refresh."],
    };
    const [title, hint] = EMPTY[state.reportsState] || EMPTY.error;
    body.innerHTML = `<tr><td colspan="7"><div class="empty">
      <div class="empty-title">${esc(title)}</div>
      <p class="empty-body">${esc(hint)}</p>
    </div></td></tr>`;
    return;
  }

  if (!state.reports.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty">
      <div class="empty-title">No report links yet</div>
      <p class="empty-body">Issue one above once a client is set up.</p>
    </div></td></tr>`;
    return;
  }

  // `clientName` and `label` are operator-authored strings the server passes
  // through unmodified — esc()'d like any other value this console renders
  // as markup (CLAUDE.md's Escaping rule). The token itself is never in this
  // list: `listReportTokens()` never selects it, so there is nothing here to
  // leak even if this table's HTML were somehow read back.
  body.innerHTML = state.reports
    .map((t, i) => {
      const status = t.revokedAt
        ? `<span class="trend-badge trend-neg">Revoked</span>`
        // Read off the server's own `expired` boolean, never recomputed from
        // the browser's clock — a wrong local clock must not draw a dead
        // link as live, or a live one as dead (work order C5, requirement 2).
        : t.expired
          ? `<span class="trend-badge trend-neg">Expired</span>`
          : `<span class="trend-badge trend-pos">Active</span>`;
      return `<tr>
        <td>${esc(t.clientName || "—")}</td>
        <td>${t.label ? esc(t.label) : `<span style="color:var(--text-3)">—</span>`}</td>
        <td class="cell-mono" title="${esc(t.createdAt || "")}">${esc(relativeTime(t.createdAt))}</td>
        <td class="cell-mono" title="${esc(t.expiresAt || "")}">${esc(
          new Date(t.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
        )}</td>
        <td class="cell-mono">${t.lastSeenAt ? esc(relativeTime(t.lastSeenAt)) : "Never opened"}</td>
        <td>${status}</td>
        <td>${!t.revokedAt ? `<button class="btn btn-sm" data-revoke-report="${i}">Revoke</button>` : ""}</td>
      </tr>`;
    })
    .join("");
}

/** Fills and reveals the one-time reveal panel. See its doc on `renderReports`. */
function showIssuedReportUrl(url) {
  state.reportIssuedUrl = url;
  const panel = $("reportIssuedPanel");
  const input = $("reportIssuedUrl");
  if (input) input.value = url;
  if (panel) panel.hidden = false;
}

/** The only thing allowed to hide `#reportIssuedPanel` — an explicit click. */
function dismissIssuedReportUrl() {
  state.reportIssuedUrl = null;
  const panel = $("reportIssuedPanel");
  if (panel) panel.hidden = true;
}

async function issueReportToken() {
  const clientSelect = $("reportClientSelect");
  const labelInput = $("reportLabelInput");
  const btn = $("reportIssueBtn");
  const clientId = clientSelect?.value || "";
  const label = labelInput?.value.trim().slice(0, 120) || "";
  if (!clientId) return toast("Pick a client", "error");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Issuing…";
  }
  try {
    const res = await apiFetch("/api/admin/report-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, label: label || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      // `location.origin` because the mint response deliberately sends only a
      // path — the server behind a TLS-terminating proxy cannot know its own
      // public scheme, and the console already knows the origin it is on.
      showIssuedReportUrl(location.origin + data.path);
      if (labelInput) labelInput.value = "";
      await loadReports();
    } else {
      reportErrorToast(res, data);
    }
  } catch {
    toast("Could not reach the server", "error");
  } finally {
    if (btn) {
      btn.disabled = !(state.reportsState === "ready" && state.reportClients.length > 0);
      btn.textContent = "Issue link";
    }
  }
}

async function revokeReportToken(id, btn) {
  // Says what revoking means, not just "are you sure" — the client's link
  // stops working immediately and there is no undo (work order C5,
  // requirement 3).
  if (!confirm("Revoke this report link? The client's link stops working immediately and this cannot be undone.")) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Revoking…";
  }
  try {
    const res = await apiFetch(`/api/admin/report-tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      toast("Report link revoked");
      // Reload from the server rather than marking the row revoked locally —
      // a DELETE the server refused (already revoked, unknown id) must not
      // leave the row drawn as revoked when it is not (requirement 3).
      await loadReports();
      return;
    }
    reportErrorToast(res, data);
  } catch {
    toast("Could not reach the server", "error");
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Revoke";
  }
}

function bindReports() {
  $("reportsRefreshBtn")?.addEventListener("click", loadReports);
  $("reportIssueBtn")?.addEventListener("click", issueReportToken);
  $("reportLabelInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      issueReportToken();
    }
  });
  $("reportIssuedCopyBtn")?.addEventListener("click", () => {
    const url = $("reportIssuedUrl")?.value || "";
    if (!url) return;
    navigator.clipboard
      .writeText(url)
      .then(() => toast("Report link copied — this is the only time it will be shown", "info"))
      .catch(() => toast(url, "info"));
  });
  $("reportIssuedDismissBtn")?.addEventListener("click", dismissIssuedReportUrl);
  // Delegated, like the delivery log's resend button and the domains list's
  // remove button: rows are rendered, not authored, so a listener bound to
  // one button would not survive the next innerHTML swap.
  $("reportsBody")?.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-revoke-report]");
    if (!trigger) return;
    const row = state.reports[+trigger.dataset.revokeReport];
    if (row) revokeReportToken(row.id, trigger);
  });
}

/* ========================================================================== *
 *  Templates
 * ========================================================================== */

function renderTemplates(filterCat = "all") {
  // Filter on the template's declared `category`. This used to guess from the
  // key ("does it contain 'lead'?"), which quietly mis-filed anything whose name
  // didn't happen to contain the right word — and silently showed everything
  // under every pill once the library grew past a handful.
  const entries = Object.entries(FUNNEL_TEMPLATES).filter(
    ([, tpl]) => !filterCat || filterCat === "all" || tpl.category === filterCat,
  );

  $("templateGrid").innerHTML = entries
    .map(([key, tpl]) => {
      const color = funnelColor(tpl);
      const flow = tpl.steps
        .slice(0, 5)
        .map((s) => `<span class="tpl-step">${esc(s.type)}</span>`)
        .join(`<span class="tpl-arrow">${icon("right", 10)}</span>`);
      return `<article class="tpl-card" style="--accent:${esc(color)}">
        <div class="tpl-name">${esc(tpl.title || key)}</div>
        <p class="tpl-body">${esc(tpl.description || "")}</p>
        <div class="tpl-flow">${flow}${tpl.steps.length > 5 ? `<span class="tpl-step">+${tpl.steps.length - 5}</span>` : ""}</div>
        <button class="btn btn-primary btn-sm" data-template="${esc(key)}" style="align-self:flex-start;margin-top:4px">Use template</button>
      </article>`;
    })
    .join("");
}

/* ========================================================================== *
 *  Modals
 * ========================================================================== */

let lastFocused = null;

function openModal(id) {
  lastFocused = document.activeElement;
  $(id).hidden = false;
  if (id === "aiOverlay" && $("aiModelSelect")) {
    $("aiModelSelect").value = localStorage.getItem("of.ai.model") || $("setModel")?.value || "gpt-4o";
  }
  const focusable = $(id).querySelector("input,textarea,select,button");
  focusable?.focus();
}

function closeModal(id) {
  $(id).hidden = true;
  lastFocused?.focus?.();
}

function closeTopModal() {
  const open = qsa(".overlay").find((o) => !o.hidden);
  if (open) closeModal(open.id);
  else closeLeadDrawer();
}

function renderThemeModal() {
  const theme = state.funnel?.theme || {};
  const color = funnelColor(state.funnel);
  if ($("thPreset")) $("thPreset").value = theme.preset || "";
  if ($("thFont")) $("thFont").value = theme.font || "Inter";
  if ($("thBtnStyle")) $("thBtnStyle").value = theme.btnStyle || "flat";
  if ($("thPrimary")) $("thPrimary").value = color;
  if ($("thPrimaryHex")) $("thPrimaryHex").value = color;
  if ($("thMode")) $("thMode").value = theme.mode || "light";
  if ($("thRadius")) $("thRadius").value = theme.radius || "18px";
}

function patchTheme(patch) {
  if (!state.funnel) return;
  state.funnel.theme = { ...(state.funnel.theme || {}), ...patch };
  onFunnelEdited();
  renderFunnelGrid();
  renderSwitcher();
}

function renderPixelsModal() {
  const i = state.funnel?.integrations || {};
  if ($("pxMeta")) $("pxMeta").value = i.metaPixelId || "";
  if ($("pxGtm")) $("pxGtm").value = i.gtmId || "";
  if ($("pxGa4")) $("pxGa4").value = i.ga4Id || "";
  if ($("pxGoogleAds")) $("pxGoogleAds").value = i.googleAdsId || "";
  if ($("pxGoogleLabel")) $("pxGoogleLabel").value = i.googleAdsLabel || "";
  if ($("pxTiktok")) $("pxTiktok").value = i.tiktokPixelId || "";
  if ($("pxLinkedin")) $("pxLinkedin").value = i.linkedinTagId || "";
  if ($("pxPinterest")) $("pxPinterest").value = i.pinterestPixelId || "";
  if ($("pxWebhook")) $("pxWebhook").value = i.webhookUrl || "";
  if ($("pxWebhookSecret")) $("pxWebhookSecret").value = i.webhookSecret || "";
  if ($("pxNotifyEmail")) $("pxNotifyEmail").value = i.notifyEmail || "";
  if ($("pxCustomCss")) $("pxCustomCss").value = state.funnel?.customCss || i.customCss || "";
  if ($("pxCustomHead")) $("pxCustomHead").value = state.funnel?.customHead || i.customHead || "";
  if ($("pxCustomBody")) $("pxCustomBody").value = state.funnel?.customBody || i.customBody || "";
}

function patchIntegrations(patch) {
  if (!state.funnel) return;
  state.funnel.integrations = { ...(state.funnel.integrations || {}), ...patch };
  if (patch.customCss !== undefined) state.funnel.customCss = patch.customCss;
  if (patch.customHead !== undefined) state.funnel.customHead = patch.customHead;
  if (patch.customBody !== undefined) state.funnel.customBody = patch.customBody;
  onFunnelEdited();
}

async function generateFunnel() {
  const prompt = $("aiPrompt").value.trim();
  const selectedModel = $("aiModelSelect")?.value.trim() || localStorage.getItem("of.ai.model") || "gpt-4o";
  localStorage.setItem("of.ai.model", selectedModel);

  if (!prompt) {
    toast("Describe the offer first", "error");
    return;
  }

  const btn = $("aiSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = `${icon("ai", 14)} Generating…`;

  try {
    const res = await apiFetch("/api/ai/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        apiKey: localStorage.getItem("of.ai.key") || "",
        provider: localStorage.getItem("of.ai.provider") || "builtin",
        model: selectedModel,
        tone: localStorage.getItem("of.ai.tone") || "direct",
      }),
    });
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    if (!data.funnel?.steps?.length) throw new Error("empty");

    setWorkingFunnel(data.funnel);
    markDirty(true);
    closeModal("aiOverlay");
    $("aiPrompt").value = "";
    showView("builder");
    toast(`Drafted ${count(data.funnel.steps.length, "step")}. Edit anything, then save.`);
  } catch {
    toast("Generation failed. Check the model and API key in Settings.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon("ai", 14)} Generate funnel`;
  }
}

/* ========================================================================== *
 *  Command palette
 * ========================================================================== */

/**
 * The `hint` on a Navigation entry is the number key that opens it, and the key
 * binding reads `VIEWS` by position (`VIEWS[index - 1]`) — so a hint written by
 * hand is a second copy of that order and drifts the moment a view is inserted.
 * It had: `delivery` went in at position 4 and every hint below it was off by
 * one, so the palette taught three wrong shortcuts. Derived from `VIEWS` now.
 *
 * @param {string} view
 */
const viewHint = (view) => String(VIEWS.indexOf(view) + 1);

const PALETTE_ACTIONS = [
  { label: "Overview", icon: "grid", hint: viewHint("dashboard"), category: "Navigation", run: () => showView("dashboard") },
  { label: "Builder", icon: "layers", hint: viewHint("builder"), category: "Navigation", run: () => showView("builder") },
  { label: "Leads", icon: "inbox", hint: viewHint("leads"), category: "Navigation", run: () => showView("leads") },
  { label: "Delivery", icon: "broadcast", hint: viewHint("delivery"), category: "Navigation", run: () => showView("delivery") },
  { label: "Analytics", icon: "chart", hint: viewHint("analytics"), category: "Navigation", run: () => showView("analytics") },
  { label: "Templates", icon: "grid", hint: viewHint("templates"), category: "Navigation", run: () => showView("templates") },
  { label: "Domains", icon: "external", hint: viewHint("domains"), category: "Navigation", run: () => showView("domains") },
  { label: "Reports", icon: "copy", hint: viewHint("reports"), category: "Navigation", run: () => showView("reports") },
  { label: "Settings", icon: "settings", hint: viewHint("settings"), category: "Navigation", run: () => showView("settings") },

  { label: "Funnel theme", icon: "palette", category: "Funnel Settings & Config", run: () => openModal("themeOverlay") },
  { label: "Pixels and integrations", icon: "broadcast", category: "Funnel Settings & Config", run: () => openModal("pixelsOverlay") },
  { label: "General & domain settings", icon: "settings", category: "Funnel Settings & Config", run: () => showView("settings") },
  { label: "Export leads as CSV", icon: "download", category: "Funnel Settings & Config", run: exportCsv },

  { label: "Save funnel", icon: "save", hint: "⌘S", category: "Quick Actions & Creation", run: saveFunnel },
  { label: "New funnel", icon: "plus", category: "Quick Actions & Creation", run: createFunnel },
  { label: "Add step", icon: "plus", category: "Quick Actions & Creation", run: () => { showView("builder"); addStep(); } },
  { label: "Generate with AI", icon: "ai", category: "Quick Actions & Creation", run: () => openModal("aiOverlay") },
  { label: "Switch dark/light mode", icon: "moon", category: "Quick Actions & Creation", run: () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
];

let paletteItems = [];
let paletteIndex = 0;

function paletteCommands() {
  const funnelCommands = knownFunnels().map((f) => ({
    label: `Open ${f.name}`,
    icon: "layers",
    hint: f.slug,
    category: "Funnels",
    run: () => {
      if (f.unsaved) showView("builder");
      else openFunnel(f.slug).then(() => showView("builder"));
    },
  }));
  return [...PALETTE_ACTIONS, ...funnelCommands];
}

function renderPalette(query = "") {
  const q = query.trim().toLowerCase();
  const allCommands = paletteCommands();
  paletteItems = allCommands.filter(
    (c) => !q || c.label.toLowerCase().includes(q) || (c.category && c.category.toLowerCase().includes(q))
  );
  paletteIndex = 0;

  const list = $("paletteList");
  if (!paletteItems.length) {
    list.innerHTML = `<p class="palette-empty">Nothing matches “${esc(query)}”.</p>`;
    return;
  }

  const categoryOrder = ["Navigation", "Funnel Settings & Config", "Quick Actions & Creation", "Funnels"];
  const groups = {};

  paletteItems.forEach((item, globalIndex) => {
    const cat = item.category || "Actions";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ item, globalIndex });
  });

  const activeCategories = [
    ...categoryOrder.filter((cat) => groups[cat] && groups[cat].length > 0),
    ...Object.keys(groups).filter((cat) => !categoryOrder.includes(cat) && groups[cat].length > 0),
  ];

  let html = "";
  activeCategories.forEach((cat) => {
    const groupItems = groups[cat];
    html += `<div class="palette-group">
      <div class="palette-header">${esc(cat)}</div>
      ${groupItems
        .map(
          ({ item: c, globalIndex: i }) =>
            `<button class="palette-item${i === 0 ? " is-selected" : ""}" data-index="${i}">
              ${icon(c.icon, 15)}<span>${esc(c.label)}</span>${c.hint ? `<span class="kbd">${esc(c.hint)}</span>` : ""}
            </button>`
        )
        .join("")}
    </div>`;
  });

  list.innerHTML = html;
}

function movePalette(delta) {
  if (!paletteItems.length) return;
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  const items = qsa(".palette-item");
  items.forEach((el) => {
    const idx = parseInt(el.dataset.index, 10);
    const isSelected = idx === paletteIndex;
    el.classList.toggle("is-selected", isSelected);
    if (isSelected) el.scrollIntoView({ block: "nearest" });
  });
}

function runPalette(index) {
  const command = paletteItems[index];
  closeModal("paletteOverlay");
  command?.run();
}

function openPalette() {
  $("paletteInput").value = "";
  renderPalette("");
  openModal("paletteOverlay");
  $("paletteInput").focus();
}

/* ========================================================================== *
 *  Settings
 * ========================================================================== */

const SETTINGS = [
  ["setWorkspace", "of.workspace", "My workspace"],
  ["setDomain", "of.domain", ""],
  ["setAdminToken", "of.adminToken", ""],
  ["setCurrency", "of.currency", "USD"],
  ["setLanguage", "of.language", "en"],
  ["setNotifyEmail", "of.notifyEmail", ""],
  ["setGlobalCode", "of.globalCode", ""],
  ["setBrandVoice", "of.ai.brandVoice", ""],
  ["setProvider", "of.ai.provider", "builtin"],
  ["setModel", "of.ai.model", "gpt-4o"],
  ["setApiKey", "of.ai.key", ""],
];

function loadSettings() {
  SETTINGS.forEach(([id, key, fallback]) => {
    const el = $(id);
    if (el) el.value = localStorage.getItem(key) ?? fallback;
  });

  // USD is the only currency offered. Assigning a value a <select> does not
  // contain does not fall back to the first option — it sets selectedIndex to
  // -1 and the control renders BLANK, so a browser that saved EUR/GBP/CAD/AUD
  // before this narrowing would open Settings to an empty currency field. Pin
  // the stored value too, or the stale code lingers until the next save.
  if ($("setCurrency")) {
    localStorage.setItem("of.currency", "USD");
    $("setCurrency").value = "USD";
  }
  if ($("aiModelSelect")) $("aiModelSelect").value = localStorage.getItem("of.ai.model") || "gpt-4o";

  if ($("setBranding")) {
    const isHidden = state.funnel?.branding?.hidden ?? (localStorage.getItem("of.branding.hidden") === "true");
    $("setBranding").checked = Boolean(isHidden);
  }
  if ($("setGdpr")) {
    $("setGdpr").checked = Boolean(state.funnel?.consent?.enabled);
    $("setGdpr").disabled = !state.funnel;
  }
  if ($("legalImpressumUrl")) {
    $("legalImpressumUrl").value = state.funnel?.legal?.impressumUrl || "";
    $("legalImpressumUrl").disabled = !state.funnel;
  }
  if ($("legalPrivacyUrl")) {
    $("legalPrivacyUrl").value = state.funnel?.legal?.privacyUrl || "";
    $("legalPrivacyUrl").disabled = !state.funnel;
  }
  if ($("setAllowBack")) {
    $("setAllowBack").checked = Boolean(state.funnel?.settings?.allowBack ?? true);
    $("setAllowBack").disabled = !state.funnel;
  }
  if ($("setPersistProgress")) {
    $("setPersistProgress").checked = Boolean(state.funnel?.settings?.persist ?? true);
    $("setPersistProgress").disabled = !state.funnel;
  }
  if ($("setEnableSwipe")) {
    $("setEnableSwipe").checked = Boolean(state.funnel?.settings?.enableSwipe ?? true);
    $("setEnableSwipe").disabled = !state.funnel;
  }
  loadEmailSettings();
}

function saveSettings() {
  SETTINGS.forEach(([id, key]) => {
    const el = $(id);
    if (el) localStorage.setItem(key, el.value);
  });
  if ($("setBranding")) {
    const hidden = $("setBranding").checked;
    localStorage.setItem("of.branding.hidden", String(hidden));
    if (state.funnel) {
      state.funnel.branding = { ...(state.funnel.branding || {}), hidden };
    }
  }
  if (state.funnel) {
    if ($("setGdpr")) {
      const enabled = $("setGdpr").checked;
      state.funnel.consent = { ...(state.funnel.consent || {}), enabled };
    }
    if ($("legalImpressumUrl") || $("legalPrivacyUrl")) {
      const legal = { ...(state.funnel.legal || {}) };
      const impressumUrl = $("legalImpressumUrl")?.value.trim();
      const privacyUrl = $("legalPrivacyUrl")?.value.trim();
      if (impressumUrl) legal.impressumUrl = impressumUrl;
      else delete legal.impressumUrl;
      if (privacyUrl) legal.privacyUrl = privacyUrl;
      else delete legal.privacyUrl;
      state.funnel.legal = legal;
    }
    state.funnel.settings = {
      ...(state.funnel.settings || {}),
      allowBack: $("setAllowBack") ? $("setAllowBack").checked : true,
      persist: $("setPersistProgress") ? $("setPersistProgress").checked : true,
      enableSwipe: $("setEnableSwipe") ? $("setEnableSwipe").checked : true,
    };
    onFunnelEdited();
  }
  saveEmailSettingsFromUI();
}

async function loadEmailSettings() {
  try {
    const res = await apiFetch("/api/admin/email-settings");
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data.settings || {};

    if ($("setNotifyEmail")) $("setNotifyEmail").value = cfg.notifyEmail || "";
    if ($("setEmailProvider")) $("setEmailProvider").value = cfg.provider || "resend";
    if ($("setResendApiKey")) $("setResendApiKey").value = cfg.resendApiKey || "";
    if ($("setResendFrom")) $("setResendFrom").value = cfg.resendFrom || "";
    if ($("setBrevoApiKey")) $("setBrevoApiKey").value = cfg.brevoApiKey || "";
    if ($("setBrevoFrom")) $("setBrevoFrom").value = cfg.brevoFrom || "";
    if ($("setSmtpHost")) $("setSmtpHost").value = cfg.smtpHost || "";
    if ($("setSmtpPort")) $("setSmtpPort").value = cfg.smtpPort || 587;
    if ($("setSmtpUser")) $("setSmtpUser").value = cfg.smtpUser || "";
    if ($("setSmtpPass")) $("setSmtpPass").value = cfg.smtpPass || "";
    if ($("setSmtpFrom")) $("setSmtpFrom").value = cfg.smtpFrom || "";
    if ($("setAutoresponderEnabled")) $("setAutoresponderEnabled").checked = Boolean(cfg.autoresponderEnabled);
    if ($("setAutoresponderSubject")) $("setAutoresponderSubject").value = cfg.autoresponderSubject || "";
    if ($("setAutoresponderBody")) $("setAutoresponderBody").value = cfg.autoresponderBody || "";

    toggleEmailProviderFields(cfg.provider || "resend");
    toggleAutoresponderFields(Boolean(cfg.autoresponderEnabled));
  } catch (err) {
    console.warn("Failed to load email settings:", err);
  }
}

function toggleEmailProviderFields(provider) {
  if ($("resendFields")) $("resendFields").style.display = provider === "resend" ? "block" : "none";
  if ($("brevoFields")) $("brevoFields").style.display = provider === "brevo" ? "block" : "none";
  if ($("smtpFields")) $("smtpFields").style.display = provider === "smtp" ? "block" : "none";
}

function toggleAutoresponderFields(enabled) {
  if ($("autoresponderFields")) $("autoresponderFields").style.display = enabled ? "block" : "none";
}

async function saveEmailSettingsFromUI() {
  const payload = {
    notifyEmail: $("setNotifyEmail")?.value || "",
    provider: $("setEmailProvider")?.value || "resend",
    resendApiKey: $("setResendApiKey")?.value || "",
    resendFrom: $("setResendFrom")?.value || "",
    brevoApiKey: $("setBrevoApiKey")?.value || "",
    brevoFrom: $("setBrevoFrom")?.value || "",
    smtpHost: $("setSmtpHost")?.value || "",
    smtpPort: Number($("setSmtpPort")?.value || 587),
    smtpUser: $("setSmtpUser")?.value || "",
    smtpPass: $("setSmtpPass")?.value || "",
    smtpFrom: $("setSmtpFrom")?.value || "",
    autoresponderEnabled: $("setAutoresponderEnabled")?.checked || false,
    autoresponderSubject: $("setAutoresponderSubject")?.value || "",
    autoresponderBody: $("setAutoresponderBody")?.value || "",
  };

  try {
    const res = await apiFetch("/api/admin/email-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) toast("Email settings saved successfully!");
    else toast("Failed to save email settings", "error");
  } catch (err) {
    toast("Error saving email settings", "error");
  }
}

async function sendTestEmailFromUI() {
  const email = $("setNotifyEmail")?.value;
  if (!email) {
    toast("Enter an Admin Notification Email first", "error");
    return;
  }

  const btn = $("testEmailBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }

  try {
    const res = await apiFetch("/api/admin/test-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`Test email sent! (${data.provider})`);
    } else {
      toast(`Email failed: ${data.error || "unknown"}`, "error");
    }
  } catch (err) {
    toast("Failed to send test email", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send Test Email";
    }
  }
}

/* ========================================================================== *
 *  Wiring
 * ========================================================================== */

function bindChrome() {
  $("brandBtn").addEventListener("click", () => showView("dashboard"));
  $("themeBtn").addEventListener("click", () =>
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
  );
  $("saveBtn").addEventListener("click", saveFunnel);
  $("paletteBtn").addEventListener("click", openPalette);
  $("copyUrlBtn")?.addEventListener("click", () => {
    const link = $("liveLinkText")?.textContent || "";
    if (link) {
      const fullUrl = window.location.origin + link;
      navigator.clipboard.writeText(fullUrl).then(() => {
        toast("Live URL copied to clipboard!", "info");
      }).catch(() => {
        toast(fullUrl, "info");
      });
    }
  });

  qsa(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));

  $("funnelSelect").addEventListener("change", (e) => {
    if (e.target.value === "__new") createFunnel();
    else openFunnel(e.target.value);
  });

  window.addEventListener("popstate", () => showView(viewFromLocation(), false));

  window.addEventListener("beforeunload", (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

function bindDashboard() {
  $("newFunnelBtn")?.addEventListener("click", () => openModal("newFunnelOverlay"));
  $("quickCsvBtn")?.addEventListener("click", exportCsv);
  $("allLeadsBtn").addEventListener("click", () => showView("leads"));
  $("funnelSearch").addEventListener("input", renderFunnelGrid);

  const newOverlay = $("newFunnelOverlay");
  if (newOverlay) {
    renderBlueprints();
    // Delegated, because the template cards inside are rendered rather than
    // authored — per-element listeners bound here would not survive the render.
    newOverlay.addEventListener("click", (e) => {
      const card = e.target.closest("[data-blueprint]");
      if (!card) return;
      const bp = card.dataset.blueprint;
      closeModal("newFunnelOverlay");
      if (bp === "blank") {
        createFunnel();
      } else {
        useTemplate(bp);
      }
    });
  }

  $("funnelGrid").addEventListener("click", (e) => {
    const dup = e.target.closest("[data-duplicate]");
    if (dup) {
      e.stopPropagation();
      return duplicateFunnel(dup.dataset.duplicate);
    }
    const del = e.target.closest("[data-delete]");
    if (del) {
      e.stopPropagation();
      return deleteFunnel(del.dataset.delete);
    }
    if (e.target.closest("[data-open]")) return;
    if (e.target.closest("[data-new-funnel]")) return openModal("newFunnelOverlay");
    const goto = e.target.closest("[data-goto]");
    if (goto) return showView(goto.dataset.goto);

    const card = e.target.closest("[data-slug]");
    if (!card) return;
    const slug = card.dataset.slug;
    if (slug === state.funnel?.slug) showView("builder");
    else openFunnel(slug).then(() => showView("builder"));
  });

  $("funnelGrid").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest("[data-slug]");
    if (!card) return;
    e.preventDefault();
    card.click();
  });
}

function bindBuilder() {
  $("addStepBtn").addEventListener("click", () => openModal("stepArchetypeOverlay"));
  $("addLandingBtn")?.addEventListener("click", addLandingStep);
  $("aiStepBtn")?.addEventListener("click", () => openModal("aiOverlay"));
  $("themeModalBtn").addEventListener("click", () => openModal("themeOverlay"));
  $("pixelsModalBtn").addEventListener("click", () => openModal("pixelsOverlay"));
  $("reloadPreviewBtn").addEventListener("click", () => mountPreview(true));
  $("jsonBtn").addEventListener("click", () => {
    $("jsonArea").value = JSON.stringify(state.funnel, null, 2);
    openModal("jsonOverlay");
  });

  $("archetypeGrid")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-archetype]");
    if (!card) return;
    const archetype = card.dataset.archetype;
    createStepFromArchetype(archetype);
    closeModal("stepArchetypeOverlay");
  });

  $("stepSpine").addEventListener("click", (e) => {
    const dup = e.target.closest("[data-dup-step]");
    if (dup) {
      e.stopPropagation();
      return duplicateStep(+dup.dataset.dupStep);
    }
    const move = e.target.closest("[data-move]");
    if (move) {
      e.stopPropagation();
      return moveStep(+move.dataset.move, +move.dataset.dir);
    }
    const row = e.target.closest("[data-step]");
    if (row) selectStep(+row.dataset.step);
  });

  $("stepSpine").addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-step]");
    if (!row || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    selectStep(+row.dataset.step);
  });

  $("zoomSelect")?.addEventListener("change", (e) => {
    const scale = e.target.value;
    const device = $("device");
    if (device) {
      device.style.transform = scale === "1" ? "none" : `scale(${scale})`;
      device.style.transformOrigin = "top center";
    }
  });

  $("chassisSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    qsa("#chassisSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    const chassis = btn.dataset.chassis;
    $("device").dataset.chassis = chassis;
    $("deviceLabel").textContent =
      chassis === "tablet" ? "834 × 1112" : chassis === "desktop" ? "1440 × 900" : "390 × 844";
  });
}

function bindLeads() {
  $("leadSearch").addEventListener("input", renderLeads);
  $("exportCsvBtn").addEventListener("click", exportCsv);

  $("leadsBody").addEventListener("click", (e) => {
    const row = e.target.closest("[data-lead]");
    if (row) openLeadDrawer(visibleLeads()[+row.dataset.lead]);
  });
  $("leadsBody").addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-lead]");
    if (!row || e.key !== "Enter") return;
    openLeadDrawer(visibleLeads()[+row.dataset.lead]);
  });

  $("drawerCloseBtn").addEventListener("click", closeLeadDrawer);
  $("drawerScrim").addEventListener("click", closeLeadDrawer);
}

function bindModals() {
  qsa(".overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest("[data-close]")) closeModal(overlay.id);
    });
  });

  $("aiSubmitBtn").addEventListener("click", generateFunnel);
  $("aiModelSelect")?.addEventListener("change", (e) => {
    const isCustom = e.target.value === "custom";
    if ($("aiCustomModelWrap")) $("aiCustomModelWrap").hidden = !isCustom;
  });
  $("aiPrompt").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generateFunnel();
  });

  $("thPreset").addEventListener("change", (e) => {
    const preset = e.target.value;
    if (!preset) return patchTheme({ preset: undefined });
    patchTheme({ preset, primary: THEME_PRESETS[preset]?.primary });
    renderThemeModal();
  });
  $("thPrimary").addEventListener("input", (e) => {
    $("thPrimaryHex").value = e.target.value;
    patchTheme({ primary: e.target.value });
  });
  $("thPrimaryHex").addEventListener("input", (e) => {
    const hex = normalizeHex(e.target.value);
    if (!hex) return;
    $("thPrimary").value = hex;
    patchTheme({ primary: hex });
  });
  $("thFont")?.addEventListener("change", (e) => patchTheme({ font: e.target.value }));
  $("thBtnStyle")?.addEventListener("change", (e) => patchTheme({ btnStyle: e.target.value }));
  $("thMode").addEventListener("change", (e) => patchTheme({ mode: e.target.value }));
  $("thRadius").addEventListener("input", (e) => patchTheme({ radius: e.target.value || undefined }));

  const pixelFields = [
    ["pxMeta", "metaPixelId"],
    ["pxGtm", "gtmId"],
    ["pxGa4", "ga4Id"],
    ["pxGoogleAds", "googleAdsId"],
    ["pxGoogleLabel", "googleAdsLabel"],
    ["pxTiktok", "tiktokPixelId"],
    ["pxLinkedin", "linkedinTagId"],
    ["pxPinterest", "pinterestPixelId"],
    ["pxWebhook", "webhookUrl"],
    ["pxWebhookSecret", "webhookSecret"],
    ["pxNotifyEmail", "notifyEmail"],
    ["pxCustomCss", "customCss"],
    ["pxCustomHead", "customHead"],
    ["pxCustomBody", "customBody"],
  ];
  pixelFields.forEach(([id, key]) =>
    $(id)?.addEventListener("input", (e) => patchIntegrations({ [key]: e.target.value || undefined }))
  );

  $("copyJsonBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("jsonArea").value);
      toast("Funnel JSON copied");
    } catch {
      $("jsonArea").select();
      toast("Press ⌘C to copy", "error");
    }
  });

  $("paletteInput").addEventListener("input", (e) => renderPalette(e.target.value));
  $("paletteInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteIndex); }
  });
  $("paletteList").addEventListener("click", (e) => {
    const item = e.target.closest("[data-index]");
    if (item) runPalette(+item.dataset.index);
  });

  $("templateGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-template]");
    if (btn) useTemplate(btn.dataset.template);
  });

  $("templateCategories")?.addEventListener("click", (e) => {
    const pill = e.target.closest(".cat-pill");
    if (!pill) return;
    qsa(".cat-pill", $("templateCategories")).forEach((p) => p.classList.remove("is-active"));
    pill.classList.add("is-active");
    renderTemplates(pill.dataset.cat);
  });

function purgeCredentials() {
  localStorage.removeItem("of.ai.key");
  localStorage.removeItem("of.adminToken");
  localStorage.removeItem("of.webhookSecret");
  if ($("setApiKey")) $("setApiKey").value = "";
  if ($("setAdminToken")) $("setAdminToken").value = "";
  toast("All stored API keys & admin tokens purged cleanly from browser storage", "info");
}

  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("purgeKeysBtn")?.addEventListener("click", purgeCredentials);
  $("setProvider")?.addEventListener("change", (e) => {
    const provider = e.target.value;
    const modelInput = $("setModel");
    if (!modelInput) return;
    const defaults = {
      openai: "gpt-4o",
      anthropic: "claude-3-7-sonnet-20250219",
      google: "gemini-2.0-flash",
      deepseek: "deepseek-chat",
    };
    if (!modelInput.value.trim() && defaults[provider]) {
      modelInput.value = defaults[provider];
      if ($("aiModelSelect")) $("aiModelSelect").value = defaults[provider];
    }
  });
  $("setModel")?.addEventListener("input", (e) => {
    if ($("aiModelSelect")) $("aiModelSelect").value = e.target.value;
  });
  $("aiModelSelect")?.addEventListener("input", (e) => {
    if ($("setModel")) $("setModel").value = e.target.value;
  });
  $("setEmailProvider")?.addEventListener("change", (e) => toggleEmailProviderFields(e.target.value));
  $("setAutoresponderEnabled")?.addEventListener("change", (e) => toggleAutoresponderFields(e.target.checked));
  $("saveEmailBtn")?.addEventListener("click", saveEmailSettingsFromUI);
  $("testEmailBtn")?.addEventListener("click", sendTestEmailFromUI);
}

function bindKeys() {
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      return $("paletteOverlay").hidden ? openPalette() : closeModal("paletteOverlay");
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      return saveFunnel();
    }
    if (e.key === "Escape") return closeTopModal();

    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const index = Number(e.key);
    if (index >= 1 && index <= VIEWS.length) showView(VIEWS[index - 1]);
  });
}

/* ========================================================================== *
 *  Drag & Drop + Symbol Picker Engine
 * ========================================================================== */

let draggedSpineIndex = null;

function bindSpineDragAndDrop() {
  const host = $("stepSpine");
  if (!host || host.dataset.dragBound) return;
  host.dataset.dragBound = "true";

  host.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".spine-row");
    if (!row) return;
    draggedSpineIndex = Number(row.dataset.step);
    row.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(draggedSpineIndex));
  });

  host.addEventListener("dragover", (e) => {
    const row = e.target.closest(".spine-row");
    if (!row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    qsa(".spine-row", host).forEach((r) => r.classList.remove("drop-before", "drop-after"));
    const rect = row.getBoundingClientRect();
    const isAfter = e.clientY > rect.top + rect.height / 2;
    row.classList.add(isAfter ? "drop-after" : "drop-before");
  });

  host.addEventListener("dragleave", (e) => {
    const row = e.target.closest(".spine-row");
    if (row && (!e.relatedTarget || !row.contains(e.relatedTarget))) {
      row.classList.remove("drop-before", "drop-after");
    }
  });

  host.addEventListener("drop", (e) => {
    e.preventDefault();
    const row = e.target.closest(".spine-row");
    if (!row || draggedSpineIndex === null) return;
    const rect = row.getBoundingClientRect();
    const isAfter = e.clientY > rect.top + rect.height / 2;
    qsa(".spine-row", host).forEach((r) => r.classList.remove("drop-before", "drop-after", "is-dragging"));

    let targetIndex = Number(row.dataset.step);
    if (isAfter) targetIndex++;
    if (draggedSpineIndex < targetIndex) targetIndex--;

    if (draggedSpineIndex !== targetIndex && state.funnel) {
      const steps = state.funnel.steps;
      const [moved] = steps.splice(draggedSpineIndex, 1);
      steps.splice(targetIndex, 0, moved);
      state.stepIndex = targetIndex;
      renderSpine();
      renderInspector();
      onFunnelEdited();
    }
    draggedSpineIndex = null;
  });

  host.addEventListener("dragend", () => {
    qsa(".spine-row", host).forEach((r) => r.classList.remove("is-dragging", "drop-before", "drop-after"));
    draggedSpineIndex = null;
  });
}

let draggedOptIndex = null;

function bindOptionDragAndDrop() {
  const host = $("inspector");
  if (!host || host.dataset.optDragBound) return;
  host.dataset.optDragBound = "true";

  host.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".option-edit-card");
    if (!card) return;
    draggedOptIndex = Number(card.dataset.optIndex);
    card.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(draggedOptIndex));
  });

  host.addEventListener("dragover", (e) => {
    const card = e.target.closest(".option-edit-card");
    if (!card) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    qsa(".option-edit-card", host).forEach((c) => c.classList.remove("drop-before", "drop-after"));
    const rect = card.getBoundingClientRect();
    const isAfter = e.clientY > rect.top + rect.height / 2;
    card.classList.add(isAfter ? "drop-after" : "drop-before");
  });

  host.addEventListener("dragleave", (e) => {
    const card = e.target.closest(".option-edit-card");
    if (card && (!e.relatedTarget || !card.contains(e.relatedTarget))) {
      card.classList.remove("drop-before", "drop-after");
    }
  });

  host.addEventListener("drop", (e) => {
    const card = e.target.closest(".option-edit-card");
    if (!card || draggedOptIndex === null) return;
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    const isAfter = e.clientY > rect.top + rect.height / 2;
    qsa(".option-edit-card", host).forEach((c) => c.classList.remove("drop-before", "drop-after", "is-dragging"));

    let targetIndex = Number(card.dataset.optIndex);
    if (isAfter) targetIndex++;
    if (draggedOptIndex < targetIndex) targetIndex--;

    const step = state.funnel?.steps[state.stepIndex];
    if (step && (step.type === "choice" || step.type === "multiselect") && step.options) {
      if (draggedOptIndex !== targetIndex) {
        const [moved] = step.options.splice(draggedOptIndex, 1);
        step.options.splice(targetIndex, 0, moved);
        renderInspector();
        onFunnelEdited();
      }
    }
    draggedOptIndex = null;
  });

  host.addEventListener("dragend", () => {
    qsa(".option-edit-card", host).forEach((c) => c.classList.remove("is-dragging", "drop-before", "drop-after"));
    draggedOptIndex = null;
  });
}

let draggedBlockIndex = null;
let draggedBlockType = null;

function bindBlockDragAndDrop() {
  const host = $("inspector");
  if (!host || host.dataset.blockDragBound) return;
  host.dataset.blockDragBound = "true";

  host.addEventListener("dragstart", (e) => {
    const chip = e.target.closest(".block-chip");
    if (chip) {
      draggedBlockType = chip.dataset.blockAdd;
      draggedBlockIndex = null;
      chip.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", `block-add:${draggedBlockType}`);
      }
      return;
    }
    const card = e.target.closest(".block-card");
    if (card) {
      draggedBlockIndex = Number(card.dataset.blockIndex);
      draggedBlockType = null;
      card.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `block-move:${draggedBlockIndex}`);
      }
    }
  });

  host.addEventListener("dragover", (e) => {
    const card = e.target.closest(".block-card");
    const container = e.target.closest(".inspector-section");
    if (!card && !container) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = draggedBlockType ? "copy" : "move";

    qsa(".block-card", host).forEach((c) => c.classList.remove("drop-before", "drop-after"));
    if (card) {
      const rect = card.getBoundingClientRect();
      const isAfter = e.clientY > rect.top + rect.height / 2;
      card.classList.add(isAfter ? "drop-after" : "drop-before");
    }
  });

  host.addEventListener("dragleave", (e) => {
    const card = e.target.closest(".block-card");
    if (card && (!e.relatedTarget || !card.contains(e.relatedTarget))) {
      card.classList.remove("drop-before", "drop-after");
    }
  });

  host.addEventListener("drop", (e) => {
    const card = e.target.closest(".block-card");
    const container = e.target.closest(".inspector-section");
    if (!card && !container) return;
    e.preventDefault();

    const isAfter = card ? e.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2 : true;
    qsa(".block-card, .block-chip", host).forEach((c) => c.classList.remove("drop-before", "drop-after", "is-dragging"));

    const step = state.funnel?.steps[state.stepIndex];
    if (!step) return;
    if (!step.blocks) step.blocks = [];

    let targetIdx = card ? (isAfter ? Number(card.dataset.blockIndex) + 1 : Number(card.dataset.blockIndex)) : step.blocks.length;

    if (draggedBlockType) {
      const make = BLOCK_SCHEMA[draggedBlockType]?.make;
      if (make) {
        step.blocks.splice(targetIdx, 0, make());
        renderInspector();
        onFunnelEdited();
        toast("Block added", "success");
      }
    } else if (draggedBlockIndex !== null) {
      if (draggedBlockIndex < targetIdx) targetIdx--;
      if (draggedBlockIndex !== targetIdx) {
        const [moved] = step.blocks.splice(draggedBlockIndex, 1);
        step.blocks.splice(targetIdx, 0, moved);
        renderInspector();
        onFunnelEdited();
      }
    }
    draggedBlockIndex = null;
    draggedBlockType = null;
  });

  host.addEventListener("dragend", () => {
    qsa(".block-card, .block-chip", host).forEach((c) => c.classList.remove("is-dragging", "drop-before", "drop-after"));
    draggedBlockIndex = null;
    draggedBlockType = null;
  });
}

const POPULAR_SYMBOLS = [
  "⚡", "🔥", "🎯", "💎", "🚀", "💡", "⭐", "🏆", "📦", "💼",
  "📱", "✉️", "👤", "🔒", "🎨", "📈", "📍", "🎁", "🌟", "✨",
  "🥇", "👑", "🧠", "💪", "🏃", "🥗", "🍎", "🧘", "🚗", "🏡",
  "💰", "💳", "🛒", "🔑", "⏰", "📅", "💬", "🌐", "✈️", "📷",
  "🟢", "🔴", "🟡", "🔵", "🟣", "⬛", "⬜", "🔺", "🔻", "🔘", "✅", "❌"
];

let activeSymbolCallback = null;

function initSymbolPicker() {
  const grid = $("symbolGrid");
  const searchInput = $("symbolSearch");
  const clearBtn = $("clearSymbolBtn");
  if (!grid) return;

  function renderGrid(filter = "") {
    const term = filter.toLowerCase().trim();
    const matches = POPULAR_SYMBOLS.filter((s) => !term || s.includes(term));
    grid.innerHTML = matches
      .map((sym) => `<button type="button" class="symbol-btn" data-symbol="${esc(sym)}">${esc(sym)}</button>`)
      .join("");
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-symbol]");
    if (!btn) return;
    const symbol = btn.dataset.symbol;
    if (activeSymbolCallback) activeSymbolCallback(symbol);
    closeModal("symbolPickerOverlay");
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (activeSymbolCallback) activeSymbolCallback("");
      closeModal("symbolPickerOverlay");
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", (e) => renderGrid(e.target.value));
  }

  renderGrid();
}

function openSymbolPicker(currentSymbol, onSelect) {
  activeSymbolCallback = onSelect;
  openModal("symbolPickerOverlay");
  if ($("symbolSearch")) $("symbolSearch").value = "";
}

/* ========================================================================== *
 *  Sidebar Resizing & Pane Toggle Engine
 * ========================================================================== */

function initSidebarResizers() {
  const layout = $("builderLayout");
  const leftResizer = $("resizerLeft");
  const rightResizer = $("resizerRight");
  const leftPane = $("paneLeft");
  const rightPane = $("paneRight");
  const toggleLeftBtn = $("toggleLeftPaneBtn");
  const toggleRightBtn = $("toggleRightPaneBtn");
  const restoreLeftBtn = $("restoreLeftBtn");
  const restoreRightBtn = $("restoreRightBtn");
  const expandSidesBtn = $("expandSidesBtn");

  if (!layout) return;

  // One-time repair. A collapsed pane's reopen chevron was inside the pane it
  // hid, so a single stray click deleted the inspector with no visible way back
  // — and because the choice is persisted, it stayed gone on every later reload.
  // Anyone who hit that is still stuck right now, and no amount of new UI helps
  // if the flag keeps re-hiding the pane on load. Clear it once; the edge
  // handles added alongside this keep the state recoverable from here on.
  if (localStorage.getItem("of.builder.paneStateVersion") !== "2") {
    localStorage.removeItem("of.builder.leftCollapsed");
    localStorage.removeItem("of.builder.rightCollapsed");
    localStorage.setItem("of.builder.paneStateVersion", "2");
  }

  // Restore saved width preferences from localStorage
  const savedLeft = localStorage.getItem("of.builder.leftWidth");
  const savedRight = localStorage.getItem("of.builder.rightWidth");
  const isLeftCollapsed = localStorage.getItem("of.builder.leftCollapsed") === "true";
  const isRightCollapsed = localStorage.getItem("of.builder.rightCollapsed") === "true";

  if (savedLeft) layout.style.setProperty("--left-pane-width", `${savedLeft}px`);
  if (savedRight) layout.style.setProperty("--right-pane-width", `${savedRight}px`);

  if (leftPane && isLeftCollapsed) leftPane.classList.add("is-collapsed");
  if (rightPane && isRightCollapsed) rightPane.classList.add("is-collapsed");

  /** Collapse or reveal one pane and persist the choice. */
  function setCollapsed(pane, key, collapsed) {
    if (!pane) return;
    pane.classList.toggle("is-collapsed", collapsed);
    localStorage.setItem(key, String(collapsed));
  }

  function updateToggleIcons() {
    const leftHidden = !!leftPane?.classList.contains("is-collapsed");
    const rightHidden = !!rightPane?.classList.contains("is-collapsed");

    // The in-pane chevron can only ever collapse: the moment it hides its pane it
    // goes with it, so labelling it "Expand" would describe a button nobody can
    // reach. Reopening belongs to the edge handles and to Restore Sidebars.
    if (toggleLeftBtn) toggleLeftBtn.setAttribute("aria-expanded", String(!leftHidden));
    if (toggleRightBtn) toggleRightBtn.setAttribute("aria-expanded", String(!rightHidden));

    if (expandSidesBtn) {
      const anyCollapsed = leftHidden || rightHidden;
      const label = $("expandSidesLabel");
      if (label) label.textContent = anyCollapsed ? "Restore Sidebars" : "Expand Canvas";
      expandSidesBtn.title = anyCollapsed ? "Bring the sidebars back" : "Expand canvas workspace";
    }
  }
  updateToggleIcons();

  if (toggleLeftBtn && leftPane) {
    toggleLeftBtn.addEventListener("click", () => {
      setCollapsed(leftPane, "of.builder.leftCollapsed", true);
      updateToggleIcons();
    });
  }

  if (toggleRightBtn && rightPane) {
    toggleRightBtn.addEventListener("click", () => {
      setCollapsed(rightPane, "of.builder.rightCollapsed", true);
      updateToggleIcons();
    });
  }

  // Edge handles: the counterpart to the in-pane chevrons, and the reason
  // collapsing is no longer a one-way door. CSS reveals each one only while its
  // pane is collapsed, so they cost nothing in the normal layout.
  if (restoreLeftBtn && leftPane) {
    restoreLeftBtn.addEventListener("click", () => {
      setCollapsed(leftPane, "of.builder.leftCollapsed", false);
      updateToggleIcons();
    });
  }

  if (restoreRightBtn && rightPane) {
    restoreRightBtn.addEventListener("click", () => {
      setCollapsed(rightPane, "of.builder.rightCollapsed", false);
      updateToggleIcons();
    });
  }

  if (expandSidesBtn) {
    expandSidesBtn.addEventListener("click", () => {
      // Restore when EITHER side is hidden. Requiring both collapsed meant that
      // with one pane already closed, the escape hatch closed the other one too.
      const anyCollapsed =
        leftPane?.classList.contains("is-collapsed") || rightPane?.classList.contains("is-collapsed");
      setCollapsed(leftPane, "of.builder.leftCollapsed", !anyCollapsed);
      setCollapsed(rightPane, "of.builder.rightCollapsed", !anyCollapsed);
      updateToggleIcons();
    });
  }

  // Mouse Drag Resizing Logic for Left Sidebar
  if (leftResizer && leftPane) {
    let startX = 0;
    let startWidth = 0;

    const onMouseMoveLeft = (e) => {
      const deltaX = e.clientX - startX;
      const newWidth = Math.max(160, Math.min(600, startWidth + deltaX));
      layout.style.setProperty("--left-pane-width", `${newWidth}px`);
      localStorage.setItem("of.builder.leftWidth", String(newWidth));
    };

    const onMouseUpLeft = () => {
      leftResizer.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMoveLeft);
      window.removeEventListener("mouseup", onMouseUpLeft);
    };

    leftResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = leftPane.getBoundingClientRect().width;
      leftResizer.classList.add("is-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMouseMoveLeft);
      window.addEventListener("mouseup", onMouseUpLeft);
    });
  }

  // Mouse Drag Resizing Logic for Right Sidebar
  if (rightResizer && rightPane) {
    let startX = 0;
    let startWidth = 0;

    const onMouseMoveRight = (e) => {
      const deltaX = startX - e.clientX;
      const newWidth = Math.max(260, Math.min(700, startWidth + deltaX));
      layout.style.setProperty("--right-pane-width", `${newWidth}px`);
      localStorage.setItem("of.builder.rightWidth", String(newWidth));
    };

    const onMouseUpRight = () => {
      rightResizer.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMoveRight);
      window.removeEventListener("mouseup", onMouseUpRight);
    };

    rightResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = rightPane.getBoundingClientRect().width;
      rightResizer.classList.add("is-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMouseMoveRight);
      window.addEventListener("mouseup", onMouseUpRight);
    });
  }
}

/* ========================================================================== *
 *  Boot
 * ========================================================================== */

async function init() {
  setTheme(document.documentElement.dataset.theme || "light");
  loadSettings();
  bindChrome();
  bindDashboard();
  bindBuilder();
  bindLeads();
  bindDelivery();
  bindDomains();
  bindReports();
  bindModals();
  bindKeys();
  initSymbolPicker();
  initSidebarResizers();
  renderTemplates();

  await loadFunnelList();
  // Fired here rather than awaited: a deep link straight into /builder never
  // hits the "dashboard" branch in showView() that otherwise triggers this,
  // and the banner is meant to be visible on first paint of an edit session.
  void loadGates();

  const first = state.funnels[0];
  if (first) await openFunnel(first.slug);
  else {
    renderDashboard();
    renderSpine();
    renderInspector();
  }

  showView(viewFromLocation(), false);
  await refreshData();
}

init();
