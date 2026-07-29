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
    const res = await fetch(`/api/funnels/${encodeURIComponent(slug)}`);
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
    const res = await fetch("/api/builder/save", {
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
    fetch("/api/admin/leads"),
    fetch(`/api/admin/stats${scope}`),
    fetch("/api/admin/stats"),
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
      const color = normalizeHex(f.primary) || "#4f46e5";
      const s = perFunnel[f.slug] || {};
      const current = state.funnel?.slug === f.slug;
      return `<article class="funnel-card${current ? " is-current" : ""}" style="--accent:${esc(color)}" data-slug="${esc(f.slug)}" tabindex="0" role="button">
        <div>
          <div class="funnel-name">${esc(f.name)}</div>
          <div class="funnel-slug">/f/${esc(f.slug)}</div>
        </div>
        <div class="funnel-stats">
          <span class="funnel-stat"><b>${f.steps}</b> ${f.steps === 1 ? "step" : "steps"}</span>
          <span class="funnel-stat"><b>${s.starts || 0}</b> starts</span>
          <span class="funnel-stat"><b>${s.leads || 0}</b> leads</span>
        </div>
        <div class="funnel-actions">
          <button class="btn btn-sm" data-edit="${esc(f.slug)}">Edit</button>
          <a class="btn btn-sm" href="/f/${esc(f.slug)}" target="_blank" rel="noopener" data-open>
            ${icon("external", 12)} Open
          </a>
          ${f.unsaved ? `<span class="tag" style="margin-left:auto">unsaved</span>` : ""}
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
      return `<div class="feed-row">
        <span class="feed-who">${esc(who)}</span>
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
      return `<div class="spine-row${i === state.stepIndex ? " is-active" : ""}" data-step="${i}" role="button" tabindex="0">
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
        (opt, i) => `<div class="repeat">
          <div class="repeat-head">
            <span class="repeat-num">${String(i + 1).padStart(2, "0")}</span>
            <button class="btn btn-ghost btn-icon btn-sm" data-del-opt="${i}" title="Remove option" aria-label="Remove option">${icon("close", 12)}</button>
          </div>
          <div class="repeat-grid">
            <input class="input" type="text" data-opt-label="${i}" value="${esc(opt.label || "")}" placeholder="Label" />
            <input class="input" type="text" data-opt-icon="${i}" value="${esc(opt.icon || "")}" placeholder="Icon" />
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

  inspector.addEventListener("input", (e) => {
    const t = e.target;
    const opts = step.options || [];
    const fields = step.fields || [];

    if (t.dataset.optLabel !== undefined) opts[+t.dataset.optLabel].label = t.value;
    else if (t.dataset.optIcon !== undefined) opts[+t.dataset.optIcon].icon = t.value || undefined;
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
    const res = await fetch("/api/ai/improve-copy", {
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
  const rows = [
    ["Captured", lead.received_at ? new Date(lead.received_at).toLocaleString() : "Unknown"],
    ["Funnel", lead.funnelId || "unknown"],
  ];

  const contactRows = Object.entries(contact)
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><strong>${esc(k)}</strong> — ${esc(v)}</div>`)
    .join("");

  $("drawerBody").innerHTML = `
    ${rows
      .map(
        ([k, v]) => `<div class="kv"><div class="kv-key">${esc(k)}</div><div class="kv-val">${esc(v)}</div></div>`
      )
      .join("")}
    <div class="kv">
      <div class="kv-key">Contact</div>
      <div class="kv-val">${contactRows || "Nothing captured"}</div>
    </div>
    <div class="kv">
      <div class="kv-key">Answers</div>
      <div class="kv-val"><pre>${esc(JSON.stringify(answers, null, 2))}</pre></div>
    </div>
    <div class="kv">
      <div class="kv-key">Source</div>
      <div class="kv-val" style="font-family:var(--mono);font-size:12px">${esc(lead.ip || "unknown")}</div>
    </div>
  `;

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

  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
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

      const dropLabel =
        drop === null
          ? `<span class="spine-drop" style="color:var(--text-3)">—</span>`
          : `<span class="spine-drop ${drop > 0 ? "delta-neg" : "delta-pos"}">${drop > 0 ? `−${drop}%` : "0%"}</span>`;

      return `<div class="spine-row">
        <span class="spine-index">${String(i + 1).padStart(2, "0")}</span>
        <span class="spine-body">
          <span class="spine-title">${esc(s.title)}</span>
          <span class="spine-meta"><span class="spine-type">${esc(s.stepId)}</span></span>
        </span>
        <span class="spine-track"><span class="spine-fill" style="width:${Math.max(2, Math.round((s.sessions / peak) * 100))}%"></span></span>
        <span class="spine-figure">
          <span class="spine-count">${s.sessions}</span>
          ${dropLabel}
        </span>
      </div>`;
    })
    .join("");

  if (worst.title) {
    $("aWorst").textContent = `−${worst.drop}%`;
    $("aWorstNote").textContent = `Leaving at “${worst.title}”`;
  } else {
    $("aWorst").textContent = "0%";
    $("aWorstNote").textContent = "No drop-off recorded";
  }
}

/* ========================================================================== *
 *  Templates
 * ========================================================================== */

function renderTemplates() {
  $("templateGrid").innerHTML = Object.entries(FUNNEL_TEMPLATES)
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
  $("thPreset").value = theme.preset || "";
  $("thPrimary").value = color;
  $("thPrimaryHex").value = color;
  $("thMode").value = theme.mode || "light";
  $("thRadius").value = theme.radius || "18px";
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
  $("pxMeta").value = i.metaPixelId || "";
  $("pxGtm").value = i.gtmId || "";
  $("pxGa4").value = i.ga4Id || "";
  $("pxTiktok").value = i.tiktokPixelId || "";
  $("pxWebhook").value = i.webhookUrl || "";
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
    const res = await fetch("/api/ai/generate", {
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
  ["setProvider", "of.ai.provider", "builtin"],
  ["setModel", "of.ai.model", "claude-opus-4-5"],
  ["setApiKey", "of.ai.key", ""],
  ["setTone", "of.ai.tone", "direct"],
];

function loadSettings() {
  SETTINGS.forEach(([id, key, fallback]) => {
    const el = $(id);
    if (el) el.value = localStorage.getItem(key) ?? fallback;
  });
  $("setBranding").checked = localStorage.getItem("of.branding.hidden") === "true";
}

function saveSettings() {
  SETTINGS.forEach(([id, key]) => {
    const el = $(id);
    if (el) localStorage.setItem(key, el.value);
  });
  localStorage.setItem("of.branding.hidden", String($("setBranding").checked));
  toast("Settings saved");
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
  $("newFunnelBtn").addEventListener("click", createFunnel);
  $("aiGenerateBtn").addEventListener("click", () => openModal("aiOverlay"));
  $("allLeadsBtn").addEventListener("click", () => showView("leads"));
  $("funnelSearch").addEventListener("input", renderFunnelGrid);

  $("funnelGrid").addEventListener("click", (e) => {
    if (e.target.closest("[data-open]")) return;
    if (e.target.closest("[data-new-funnel]")) return createFunnel();
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
  $("aiStepBtn").addEventListener("click", () => openModal("aiOverlay"));
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
  $("thMode").addEventListener("change", (e) => patchTheme({ mode: e.target.value }));
  $("thRadius").addEventListener("input", (e) => patchTheme({ radius: e.target.value || undefined }));

  const pixelFields = [
    ["pxMeta", "metaPixelId"],
    ["pxGtm", "gtmId"],
    ["pxGa4", "ga4Id"],
    ["pxTiktok", "tiktokPixelId"],
    ["pxWebhook", "webhookUrl"],
  ];
  pixelFields.forEach(([id, key]) =>
    $(id).addEventListener("input", (e) => patchIntegrations({ [key]: e.target.value.trim() || undefined }))
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

  $("saveSettingsBtn").addEventListener("click", saveSettings);
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
