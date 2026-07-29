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
  stepIndex: 0,
  /** @type {any[]} */
  leads: [],
  /** @type {any} */
  stats: null,
  dirty: false,
  view: "dashboard",
};

const VIEWS = ["dashboard", "builder", "leads", "analytics", "templates", "settings"];
const ROUTES = {
  dashboard: "/",
  builder: "/builder",
  leads: "/leads",
  analytics: "/analytics",
  templates: "/templates",
  settings: "/settings",
};

const STEP_TYPES = ["content", "choice", "multiselect", "form", "loader", "success"];
const FIELD_TYPES = ["text", "email", "tel"];

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

function useTemplate(key) {
  const template = FUNNEL_TEMPLATES[key];
  if (!template) return;
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
    toast(`${state.funnel.name || state.funnel.slug} saved`);
    await loadFunnelList();
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
      return `<article class="funnel-card${current ? " is-current" : ""}" style="--accent:${esc(color)}" data-slug="${esc(f.slug)}" tabindex="0" role="button">
        <div class="funnel-card-head">
          <div class="funnel-card-title-group">
            <div class="funnel-name">${esc(f.name)}</div>
            <div class="funnel-slug">/f/${esc(f.slug)}</div>
          </div>
          ${f.unsaved ? `<span class="tag tag-warning">unsaved</span>` : ""}
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
      const who = lead.lead?.email || lead.lead?.phone || lead.lead?.name || "Anonymous";
      const initial = who.charAt(0).toUpperCase();
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
            <span class="spine-type">${esc(step.type || "content")}</span>
            ${branches}
          </span>
        </span>
        <span class="spine-tools">
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

function addStep() {
  if (!state.funnel) return;
  state.funnel.steps.push({
    id: `step_${Date.now().toString(36).slice(-4)}`,
    type: "choice",
    headline: "New question",
    options: [
      { id: "opt_1", label: "Option one" },
      { id: "opt_2", label: "Option two" },
    ],
  });
  state.stepIndex = state.funnel.steps.length - 1;
  renderSpine();
  renderInspector();
  onFunnelEdited();
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

  host.innerHTML = `
    <div class="inspector-section">
      <div class="repeat-grid" style="grid-template-columns:1fr 1fr;gap:8px">
        <div class="field" style="margin:0">
          <label for="insType">Type</label>
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
        <p class="field-hint">Use <code>{{name}}</code> to pipe in an earlier answer.</p>
        <div id="headlineVariants" style="margin-top:8px"></div>
      </div>
      <div class="field">
        <label for="insSubtext">Supporting text</label>
        <textarea id="insSubtext" class="textarea" rows="2" placeholder="Optional">${esc(step.subtext || "")}</textarea>
      </div>
      <div class="field">
        <label for="insHeroImage">Step Hero Photo / Media URL</label>
        <input id="insHeroImage" class="input input-mono" type="text" value="${esc(step.image || step.heroImage || "")}" placeholder="https://images.unsplash.com/photo-…" />
        <p class="field-hint">Optional hero photo displayed at the top of this step.</p>
      </div>
      <button id="rewriteBtn" class="btn btn-sm">${icon("ai", 13)} Suggest headlines</button>
    </div>

    ${renderStepBody(step)}

    <div class="inspector-section">
      <div class="inspector-head"><span class="eyebrow">Flow</span></div>
      <div class="field">
        <label for="insNext">Next step</label>
        <input id="insNext" class="input input-mono" type="text" value="${esc(step.next || "")}" placeholder="${esc(nextStepHint())}" list="stepIds" />
        <p class="field-hint">Leave empty to continue in order. Options can override this individually.</p>
      </div>
      <datalist id="stepIds">
        ${state.funnel.steps.map((s) => `<option value="${esc(s.id)}"></option>`).join("")}
      </datalist>
    </div>

    <div class="inspector-section">
      <button id="deleteStepBtn" class="btn btn-sm btn-danger">${icon("trash", 13)} Delete step</button>
    </div>
  `;

  bindInspector(step);
}

function nextStepHint() {
  const next = state.funnel?.steps[state.stepIndex + 1];
  return next ? next.id : "end of funnel";
}

function renderStepBody(step) {
  if (step.type === "choice" || step.type === "multiselect") {
    const options = (step.options || [])
      .map(
        (opt, i) => `<div class="repeat option-edit-card" draggable="true" data-opt-index="${i}">
          <div class="repeat-head">
            <span class="drag-handle" title="Drag to reorder option">${icon("grid", 12)}</span>
            <span class="repeat-num">${String(i + 1).padStart(2, "0")}</span>
            <button type="button" class="btn btn-ghost btn-sm" data-pick-symbol="${i}" title="Pick symbol / icon" style="margin-left:auto">
              <span style="font-size:14px;line-height:1">${esc(opt.icon || "⚡")}</span>
              <span style="font-size:11.5px">Symbol</span>
            </button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-del-opt="${i}" title="Remove option" aria-label="Remove option">${icon("close", 12)}</button>
          </div>
          <div class="repeat-grid">
            <input class="input" type="text" data-opt-label="${i}" value="${esc(opt.label || "")}" placeholder="Label" />
            <input class="input" type="text" data-opt-icon="${i}" value="${esc(opt.icon || "")}" placeholder="Icon (emoji/symbol)" />
          </div>
          <div class="repeat-row">
            <input class="input input-mono" type="text" data-opt-image="${i}" value="${esc(opt.image || "")}" placeholder="Image URL (optional photo card)" />
          </div>
          <div class="repeat-row">
            <input class="input input-mono" type="text" data-opt-next="${i}" value="${esc(opt.next || "")}" placeholder="Branch to step ID" list="stepIds" />
          </div>
        </div>`
      )
      .join("");

    return `<div class="inspector-section">
      <div class="inspector-head">
        <span class="eyebrow">Options</span>
        <button id="addOptBtn" class="btn btn-ghost btn-sm">${icon("plus", 12)} Add</button>
      </div>
      ${options || `<p class="field-hint">No options yet.</p>`}
    </div>`;
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
    </div>`;
  }

  if (step.type === "loader") {
    return `<div class="inspector-section">
      <div class="field">
        <label for="insDuration">Duration (ms)</label>
        <input id="insDuration" class="input input-mono" type="number" min="200" step="100" value="${esc(step.durationMs ?? 2000)}" />
        <p class="field-hint">How long the progress animation runs before advancing.</p>
      </div>
    </div>`;
  }

  return "";
}

function bindInspector(step) {
  const onEdit = () => onFunnelEdited();

  $("insHeadline").addEventListener("input", (e) => {
    step.headline = e.target.value;
    renderSpine();
    onEdit();
  });

  $("insSubtext").addEventListener("input", (e) => {
    step.subtext = e.target.value || undefined;
    onEdit();
  });

  $("insType").addEventListener("change", (e) => {
    step.type = e.target.value;
    if ((step.type === "choice" || step.type === "multiselect") && !step.options) {
      step.options = [{ id: "opt_1", label: "Option one" }];
    }
    if (step.type === "form" && !step.fields) {
      step.fields = [{ name: "email", type: "email", label: "Email", required: true }];
    }
    renderSpine();
    renderInspector();
    onEdit();
  });

  $("insNext").addEventListener("input", (e) => {
    step.next = e.target.value.trim() || undefined;
    renderSpine();
    onEdit();
  });

  $("insId").addEventListener("input", (e) => {
    step.id = e.target.value.trim();
    renderSpine();
    onEdit();
  });

  $("deleteStepBtn").addEventListener("click", deleteStep);
  $("rewriteBtn").addEventListener("click", suggestHeadlines);

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

  inspector.addEventListener("input", (e) => {
    const t = e.target;
    const opts = step.options || [];
    const fields = step.fields || [];

    if (t.dataset.optLabel !== undefined) opts[+t.dataset.optLabel].label = t.value;
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
  });

  inspector.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.fType !== undefined) step.fields[+t.dataset.fType].type = t.value;
    else if (t.dataset.fReq !== undefined) step.fields[+t.dataset.fReq].required = t.checked || undefined;
    else return;
    onEdit();
  });

  inspector.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

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
  });

  bindOptionDragAndDrop();
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
      body: JSON.stringify({ headline: step.headline || "", tone: localStorage.getItem("of.ai.tone") || "direct" }),
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
    { type: "of:preview", funnel: JSON.parse(JSON.stringify(state.funnel)) },
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
      const who = lead.lead?.email || lead.lead?.phone || lead.lead?.name || "Anonymous";
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
  const who = contact.email || contact.phone || contact.name || "Anonymous Visitor";

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
      <span class="avatar-bubble" style="width:40px;height:40px;font-size:16px">${esc(who.charAt(0).toUpperCase())}</span>
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
      <div class="kv-val"><pre>${esc(JSON.stringify({ id: lead.id, received_at: lead.received_at, funnelId: lead.funnelId, ip: lead.ip || "127.0.0.1" }, null, 2))}</pre></div>
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
    "ip",
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
      l.ip || "",
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
 *  Templates
 * ========================================================================== */

function renderTemplates(filterCat = "all") {
  const entries = Object.entries(FUNNEL_TEMPLATES).filter(([key, tpl]) => {
    if (!filterCat || filterCat === "all") return true;
    if (filterCat === "lead-gen") return key.includes("lead") || key.includes("consultation") || key.includes("qualifier");
    if (filterCat === "quiz") return key.includes("quiz") || key.includes("assessment") || key.includes("fitness");
    if (filterCat === "booking") return key.includes("booking") || key.includes("demo") || key.includes("appointment");
    return true;
  });

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
}

function patchIntegrations(patch) {
  if (!state.funnel) return;
  state.funnel.integrations = { ...(state.funnel.integrations || {}), ...patch };
  markDirty(true);
}

async function generateFunnel() {
  const prompt = $("aiPrompt").value.trim();
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
        model: localStorage.getItem("of.ai.model") || "",
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

const PALETTE_ACTIONS = [
  { label: "Overview", icon: "grid", hint: "1", run: () => showView("dashboard") },
  { label: "Builder", icon: "layers", hint: "2", run: () => showView("builder") },
  { label: "Leads", icon: "inbox", hint: "3", run: () => showView("leads") },
  { label: "Analytics", icon: "chart", hint: "4", run: () => showView("analytics") },
  { label: "Templates", icon: "grid", hint: "5", run: () => showView("templates") },
  { label: "Settings", icon: "settings", hint: "6", run: () => showView("settings") },
  { label: "Save funnel", icon: "save", hint: "⌘S", run: saveFunnel },
  { label: "New funnel", icon: "plus", run: createFunnel },
  { label: "Generate with AI", icon: "ai", run: () => openModal("aiOverlay") },
  { label: "Funnel theme", icon: "palette", run: () => openModal("themeOverlay") },
  { label: "Pixels and integrations", icon: "broadcast", run: () => openModal("pixelsOverlay") },
  { label: "Add step", icon: "plus", run: () => { showView("builder"); addStep(); } },
  { label: "Export leads as CSV", icon: "download", run: exportCsv },
  { label: "Switch theme", icon: "moon", run: () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
];

let paletteItems = [];
let paletteIndex = 0;

function paletteCommands() {
  const funnelCommands = knownFunnels().map((f) => ({
    label: `Open ${f.name}`,
    icon: "layers",
    hint: f.slug,
    run: () => {
      if (f.unsaved) showView("builder");
      else openFunnel(f.slug).then(() => showView("builder"));
    },
  }));
  return [...PALETTE_ACTIONS, ...funnelCommands];
}

function renderPalette(query = "") {
  const q = query.trim().toLowerCase();
  paletteItems = paletteCommands().filter((c) => !q || c.label.toLowerCase().includes(q));
  paletteIndex = 0;

  const list = $("paletteList");
  if (!paletteItems.length) {
    list.innerHTML = `<p class="palette-empty">Nothing matches “${esc(query)}”.</p>`;
    return;
  }

  list.innerHTML = paletteItems
    .map(
      (c, i) =>
        `<button class="palette-item${i === 0 ? " is-selected" : ""}" data-index="${i}">
          ${icon(c.icon, 15)}<span>${esc(c.label)}</span>${c.hint ? `<span class="kbd">${esc(c.hint)}</span>` : ""}
        </button>`
    )
    .join("");
}

function movePalette(delta) {
  if (!paletteItems.length) return;
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  qsa(".palette-item").forEach((el, i) => el.classList.toggle("is-selected", i === paletteIndex));
  qsa(".palette-item")[paletteIndex]?.scrollIntoView({ block: "nearest" });
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
  ["setModel", "of.ai.model", "claude-opus-4-5"],
  ["setApiKey", "of.ai.key", ""],
];

function loadSettings() {
  SETTINGS.forEach(([id, key, fallback]) => {
    const el = $(id);
    if (el) el.value = localStorage.getItem(key) ?? fallback;
  });
  if ($("setGdpr")) $("setGdpr").checked = localStorage.getItem("of.gdpr.enabled") === "true";
  if ($("setBranding")) $("setBranding").checked = localStorage.getItem("of.branding.hidden") === "true";
  loadEmailSettings();
}

function saveSettings() {
  SETTINGS.forEach(([id, key]) => {
    const el = $(id);
    if (el) localStorage.setItem(key, el.value);
  });
  if ($("setGdpr")) localStorage.setItem("of.gdpr.enabled", String($("setGdpr").checked));
  if ($("setBranding")) localStorage.setItem("of.branding.hidden", String($("setBranding").checked));
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
    qsa("[data-blueprint]", newOverlay).forEach((card) => {
      card.addEventListener("click", () => {
        const bp = card.dataset.blueprint;
        closeModal("newFunnelOverlay");
        if (bp === "blank") {
          createFunnel();
        } else {
          useTemplate(bp);
        }
      });
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
  $("addStepBtn").addEventListener("click", addStep);
  $("aiStepBtn")?.addEventListener("click", () => openModal("aiOverlay"));
  $("themeModalBtn").addEventListener("click", () => openModal("themeOverlay"));
  $("pixelsModalBtn").addEventListener("click", () => openModal("pixelsOverlay"));
  $("reloadPreviewBtn").addEventListener("click", () => mountPreview(true));
  $("jsonBtn").addEventListener("click", () => {
    $("jsonArea").value = JSON.stringify(state.funnel, null, 2);
    openModal("jsonOverlay");
  });

  $("stepSpine").addEventListener("click", (e) => {
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
  ];
  pixelFields.forEach(([id, key]) =>
    $(id)?.addEventListener("input", (e) => patchIntegrations({ [key]: e.target.value.trim() || undefined }))
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

  $("saveSettingsBtn").addEventListener("click", saveSettings);
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
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const row = e.target.closest(".spine-row");
    if (!row) return;
    qsa(".spine-row", host).forEach((r) => r.classList.remove("drag-over"));
    row.classList.add("drag-over");
  });

  host.addEventListener("dragleave", (e) => {
    const row = e.target.closest(".spine-row");
    if (row) row.classList.remove("drag-over");
  });

  host.addEventListener("drop", (e) => {
    e.preventDefault();
    qsa(".spine-row", host).forEach((r) => r.classList.remove("drag-over", "is-dragging"));
    const row = e.target.closest(".spine-row");
    if (!row || draggedSpineIndex === null) return;
    const targetIndex = Number(row.dataset.step);
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
    qsa(".spine-row", host).forEach((r) => r.classList.remove("is-dragging", "drag-over"));
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
    qsa(".option-edit-card", host).forEach((c) => c.classList.remove("drag-over"));
    card.classList.add("drag-over");
  });

  host.addEventListener("dragleave", (e) => {
    const card = e.target.closest(".option-edit-card");
    if (card) card.classList.remove("drag-over");
  });

  host.addEventListener("drop", (e) => {
    e.preventDefault();
    qsa(".option-edit-card", host).forEach((c) => c.classList.remove("drag-over", "is-dragging"));
    const card = e.target.closest(".option-edit-card");
    if (!card || draggedOptIndex === null) return;
    const targetIndex = Number(card.dataset.optIndex);
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
    qsa(".option-edit-card", host).forEach((c) => c.classList.remove("is-dragging", "drag-over"));
    draggedOptIndex = null;
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
 *  Boot
 * ========================================================================== */

async function init() {
  setTheme(document.documentElement.dataset.theme || "light");
  loadSettings();
  bindChrome();
  bindDashboard();
  bindBuilder();
  bindLeads();
  bindModals();
  bindKeys();
  initSymbolPicker();
  renderTemplates();

  await loadFunnelList();

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
