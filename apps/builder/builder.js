/**
 * @file OpenFunnel Visual Builder Client Application
 */

let currentFunnel = null;
let currentStepIndex = 0;

// DOM Elements
const funnelSelect = document.getElementById("funnelSelect");
const funnelName = document.getElementById("funnelName");
const stepsList = document.getElementById("stepsList");
const stepCount = document.getElementById("stepCount");
const inspectorContent = document.getElementById("inspectorContent");
const previewIframe = document.getElementById("previewIframe");
const saveFunnelBtn = document.getElementById("saveFunnelBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const addStepBtn = document.getElementById("addStepBtn");
const resetPreviewBtn = document.getElementById("resetPreviewBtn");
const previewFunnelBtn = document.getElementById("previewFunnelBtn");

// Theme Drawer
const toggleThemeBtn = document.getElementById("toggleThemeBtn");
const themeDrawer = document.getElementById("themeDrawer");
const closeThemeBtn = document.getElementById("closeThemeBtn");
const themePrimaryColor = document.getElementById("themePrimaryColor");
const themePrimaryTextVal = document.getElementById("themePrimaryTextVal");
const themeMode = document.getElementById("themeMode");
const themeRadius = document.getElementById("themeRadius");
const themeBg = document.getElementById("themeBg");
const themeSurface = document.getElementById("themeSurface");

// Modal
const jsonModal = document.getElementById("jsonModal");
const jsonTextarea = document.getElementById("jsonTextarea");
const copyJsonBtn = document.getElementById("copyJsonBtn");
const closeJsonModalBtn = document.getElementById("closeJsonModalBtn");

async function init() {
  await loadFunnel(funnelSelect.value);

  funnelSelect.addEventListener("change", async (e) => {
    if (e.target.value === "+new") {
      createNewFunnel();
    } else {
      await loadFunnel(e.target.value);
    }
  });

  funnelName.addEventListener("input", (e) => {
    if (currentFunnel) {
      currentFunnel.name = e.target.value;
      updatePreview();
    }
  });

  addStepBtn.addEventListener("click", addNewStep);
  saveFunnelBtn.addEventListener("click", saveFunnel);
  exportJsonBtn.addEventListener("click", showJsonExport);
  resetPreviewBtn.addEventListener("click", reloadIframe);

  // Theme Drawer handlers
  toggleThemeBtn.addEventListener("click", () => themeDrawer.classList.toggle("hidden"));
  closeThemeBtn.addEventListener("click", () => themeDrawer.classList.add("hidden"));

  themePrimaryColor.addEventListener("input", (e) => {
    themePrimaryTextVal.value = e.target.value;
    updateTheme({ primary: e.target.value });
  });
  themeMode.addEventListener("change", (e) => updateTheme({ mode: e.target.value }));
  themeRadius.addEventListener("input", (e) => updateTheme({ radius: e.target.value }));
  themeBg.addEventListener("input", (e) => updateTheme({ bg: e.target.value }));
  themeSurface.addEventListener("input", (e) => updateTheme({ surface: e.target.value }));

  // Modal handlers
  copyJsonBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(jsonTextarea.value);
    copyJsonBtn.textContent = "Copied!";
    setTimeout(() => (copyJsonBtn.textContent = "Copy JSON"), 2000);
  });
  closeJsonModalBtn.addEventListener("click", () => jsonModal.close());
}

async function loadFunnel(slug) {
  try {
    const res = await fetch(`/api/funnels/${slug}`);
    if (!res.ok) throw new Error("Failed to load funnel");
    currentFunnel = await res.json();
    currentStepIndex = 0;

    funnelName.value = currentFunnel.name || currentFunnel.slug || slug;
    previewFunnelBtn.href = `/f/${currentFunnel.slug || slug}`;
    
    // Sync theme drawer inputs
    const theme = currentFunnel.theme || {};
    if (theme.primary) {
      themePrimaryColor.value = theme.primary;
      themePrimaryTextVal.value = theme.primary;
    }
    if (theme.mode) themeMode.value = theme.mode;
    if (theme.radius) themeRadius.value = theme.radius;

    renderStepsList();
    renderInspector();
    updatePreview();
  } catch (err) {
    console.error("Error loading funnel:", err);
  }
}

function createNewFunnel() {
  const newSlug = `custom-${Date.now().toString(36)}`;
  currentFunnel = {
    id: newSlug,
    slug: newSlug,
    name: "New Sales Funnel",
    theme: { primary: "#4f46e5", mode: "light", radius: "18px" },
    steps: [
      {
        id: "start",
        type: "choice",
        headline: "Welcome to OpenFunnel!",
        subtext: "Pick an option below to begin.",
        options: [
          { id: "opt1", label: "Get Started 🚀" },
          { id: "opt2", label: "Learn More ℹ️" }
        ]
      },
      {
        id: "contact",
        type: "form",
        headline: "Ready to take the next step?",
        fields: [{ name: "email", type: "email", label: "Email Address", required: true }]
      },
      {
        id: "done",
        type: "success",
        headline: "Thank you! You're all set 🎉"
      }
    ]
  };
  currentStepIndex = 0;
  funnelName.value = currentFunnel.name;
  renderStepsList();
  renderInspector();
  updatePreview();
}

function renderStepsList() {
  if (!currentFunnel || !currentFunnel.steps) return;
  stepCount.textContent = currentFunnel.steps.length;
  stepsList.innerHTML = "";

  currentFunnel.steps.forEach((step, idx) => {
    const item = document.createElement("div");
    item.className = `of-step-item ${idx === currentStepIndex ? "active" : ""}`;
    item.innerHTML = `
      <div class="of-step-info">
        <span class="of-step-type-badge">${esc(step.type)}</span>
        <span class="of-step-title">${esc(step.headline || step.id)}</span>
      </div>
      <div class="of-step-actions">
        ${idx > 0 ? `<button class="of-btn-xs move-up-btn" data-idx="${idx}">↑</button>` : ""}
        ${idx < currentFunnel.steps.length - 1 ? `<button class="of-btn-xs move-down-btn" data-idx="${idx}">↓</button>` : ""}
      </div>
    `;

    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("of-btn-xs")) return;
      currentStepIndex = idx;
      renderStepsList();
      renderInspector();
      updatePreview();
    });

    stepsList.appendChild(item);
  });

  // Attach reorder listeners
  document.querySelectorAll(".move-up-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      swapSteps(idx, idx - 1);
    });
  });

  document.querySelectorAll(".move-down-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      swapSteps(idx, idx + 1);
    });
  });
}

function swapSteps(from, to) {
  const temp = currentFunnel.steps[from];
  currentFunnel.steps[from] = currentFunnel.steps[to];
  currentFunnel.steps[to] = temp;
  currentStepIndex = to;
  renderStepsList();
  renderInspector();
  updatePreview();
}

function renderInspector() {
  if (!currentFunnel || !currentFunnel.steps[currentStepIndex]) {
    inspectorContent.innerHTML = "<p class='of-placeholder-text'>No step selected.</p>";
    return;
  }

  const step = currentFunnel.steps[currentStepIndex];

  inspectorContent.innerHTML = `
    <div class="of-field">
      <label>Step ID & Type</label>
      <div style="display:flex; gap:0.5rem">
        <input type="text" id="stepId" class="of-input" value="${esc(step.id)}" />
        <select id="stepType" class="of-select">
          <option value="choice" ${step.type === "choice" ? "selected" : ""}>choice</option>
          <option value="multiselect" ${step.type === "multiselect" ? "selected" : ""}>multiselect</option>
          <option value="form" ${step.type === "form" ? "selected" : ""}>form</option>
          <option value="loader" ${step.type === "loader" ? "selected" : ""}>loader</option>
          <option value="content" ${step.type === "content" ? "selected" : ""}>content</option>
          <option value="success" ${step.type === "success" ? "selected" : ""}>success</option>
        </select>
      </div>
    </div>

    <div class="of-field">
      <label>Headline Copy (supports piping e.g. {{name}})</label>
      <input type="text" id="stepHeadline" class="of-input" value="${esc(step.headline || "")}" />
    </div>

    <div class="of-field">
      <label>Subtext / Description</label>
      <textarea id="stepSubtext" class="of-textarea-input" rows="2">${esc(step.subtext || "")}</textarea>
    </div>

    <div class="of-field">
      <label>Next Step ID Target (Optional override)</label>
      <input type="text" id="stepNext" class="of-input" value="${esc(step.next || "")}" placeholder="Default: Next in order" />
    </div>

    ${renderTypeSpecificInspector(step)}

    <div style="margin-top: 1.5rem; display:flex; justify-content:space-between">
      <button id="deleteStepBtn" class="of-btn-xs" style="background:#ef4444; color:white; border:none">🗑️ Delete Step</button>
    </div>
  `;

  // Bind inspector listeners
  document.getElementById("stepId").addEventListener("input", (e) => {
    step.id = e.target.value;
    renderStepsList();
    updatePreview();
  });

  document.getElementById("stepType").addEventListener("change", (e) => {
    step.type = e.target.value;
    renderStepsList();
    renderInspector();
    updatePreview();
  });

  document.getElementById("stepHeadline").addEventListener("input", (e) => {
    step.headline = e.target.value;
    renderStepsList();
    updatePreview();
  });

  document.getElementById("stepSubtext").addEventListener("input", (e) => {
    step.subtext = e.target.value;
    updatePreview();
  });

  document.getElementById("stepNext").addEventListener("input", (e) => {
    step.next = e.target.value || undefined;
    updatePreview();
  });

  const deleteBtn = document.getElementById("deleteStepBtn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      if (currentFunnel.steps.length <= 1) return alert("Funnel must have at least 1 step.");
      currentFunnel.steps.splice(currentStepIndex, 1);
      currentStepIndex = Math.max(0, currentStepIndex - 1);
      renderStepsList();
      renderInspector();
      updatePreview();
    });
  }

  bindTypeSpecificListeners(step);
}

function renderTypeSpecificInspector(step) {
  if (step.type === "choice" || step.type === "multiselect") {
    const optionsHtml = (step.options || []).map((opt, i) => `
      <div class="of-option-card" style="display:flex; flex-direction:column; gap:0.4rem; padding:0.6rem; margin-bottom:0.5rem; border:1px solid #e2e8f0; border-radius:8px">
        <div class="of-option-row" style="display:flex; gap:0.5rem">
          <input type="text" class="of-input opt-label" data-idx="${i}" value="${esc(opt.label)}" placeholder="Label" style="flex:1" />
          <input type="text" class="of-input opt-icon" data-idx="${i}" value="${esc(opt.icon || "")}" style="width:60px" placeholder="Icon" />
        </div>
        <div class="of-option-row">
          <input type="text" class="of-input opt-subtext" data-idx="${i}" value="${esc(opt.subtext || "")}" placeholder="Subtext / Description (Optional)" />
        </div>
        <div class="of-option-row">
          <input type="text" class="of-input opt-badge" data-idx="${i}" value="${esc(opt.badge || "")}" placeholder="Badge tag (e.g. Popular)" />
        </div>
        <div class="of-option-row">
          <input type="text" class="of-input opt-next" data-idx="${i}" value="${esc(opt.next || "")}" placeholder="Branch target next (Optional)" />
        </div>
      </div>
    `).join("");

    return `
      <div class="of-field">
        <label>Option Layout</label>
        <select id="stepLayout" class="of-select">
          <option value="list" ${step.layout === "list" || !step.layout ? "selected" : ""}>Stacked List</option>
          <option value="grid" ${step.layout === "grid" ? "selected" : ""}>2-Column Grid</option>
          <option value="grid3" ${step.layout === "grid3" ? "selected" : ""}>3-Column Grid</option>
        </select>
      </div>

      <div class="of-field">
        <label>Options / Cards</label>
        ${optionsHtml}
        <button id="addOptionBtn" class="of-btn-xs" style="margin-top:0.3rem">+ Add Option</button>
      </div>
    `;
  }

  if (step.type === "form") {
    const fieldsHtml = (step.fields || []).map((f, i) => `
      <div class="of-option-card">
        <div class="of-option-row">
          <input type="text" class="of-input fld-name" data-idx="${i}" value="${esc(f.name)}" placeholder="Field Name (e.g. email)" />
          <input type="text" class="of-input fld-label" data-idx="${i}" value="${esc(f.label || "")}" placeholder="Label" />
        </div>
        <div class="of-option-row">
          <select class="of-select fld-type" data-idx="${i}">
            <option value="text" ${f.type === "text" ? "selected" : ""}>text</option>
            <option value="email" ${f.type === "email" ? "selected" : ""}>email</option>
            <option value="tel" ${f.type === "tel" ? "selected" : ""}>tel</option>
            <option value="number" ${f.type === "number" ? "selected" : ""}>number</option>
          </select>
          <label style="font-size:0.75rem"><input type="checkbox" class="fld-req" data-idx="${i}" ${f.required ? "checked" : ""} /> Required</label>
        </div>
      </div>
    `).join("");

    return `
      <div class="of-field">
        <label>Form Fields</label>
        ${fieldsHtml}
        <button id="addFieldBtn" class="of-btn-xs" style="margin-top:0.3rem">+ Add Input Field</button>
      </div>
    `;
  }

  return "";
}

function bindTypeSpecificListeners(step) {
  if (step.type === "choice" || step.type === "multiselect") {
    step.options ||= [];
    const layoutSel = document.getElementById("stepLayout");
    if (layoutSel) {
      layoutSel.addEventListener("change", (e) => {
        step.layout = e.target.value;
        updatePreview();
      });
    }
    document.querySelectorAll(".opt-label").forEach((input) => {
      input.addEventListener("input", (e) => {
        step.options[e.target.dataset.idx].label = e.target.value;
        updatePreview();
      });
    });
    document.querySelectorAll(".opt-subtext").forEach((input) => {
      input.addEventListener("input", (e) => {
        step.options[e.target.dataset.idx].subtext = e.target.value || undefined;
        updatePreview();
      });
    });
    document.querySelectorAll(".opt-badge").forEach((input) => {
      input.addEventListener("input", (e) => {
        step.options[e.target.dataset.idx].badge = e.target.value || undefined;
        updatePreview();
      });
    });
    document.querySelectorAll(".opt-icon").forEach((input) => {
      input.addEventListener("input", (e) => {
        step.options[e.target.dataset.idx].icon = e.target.value || undefined;
        updatePreview();
      });
    });
    document.querySelectorAll(".opt-next").forEach((input) => {
      input.addEventListener("input", (e) => {
        step.options[e.target.dataset.idx].next = e.target.value || undefined;
        updatePreview();
      });
    });
    const addOpt = document.getElementById("addOptionBtn");
    if (addOpt) {
      addOpt.addEventListener("click", () => {
        step.options.push({ id: `opt_${Date.now().toString(36)}`, label: "New Choice Option" });
        renderInspector();
        updatePreview();
      });
    }
  }

  if (step.type === "form") {
    step.fields ||= [];
    document.querySelectorAll(".fld-name").forEach((input) => {
      input.addEventListener("input", (e) => {
        step.fields[e.target.dataset.idx].name = e.target.value;
        updatePreview();
      });
    });
    document.querySelectorAll(".fld-label").forEach((input) => {
      input.addEventListener("input", (e) => {
        step.fields[e.target.dataset.idx].label = e.target.value;
        updatePreview();
      });
    });
    const addFld = document.getElementById("addFieldBtn");
    if (addFld) {
      addFld.addEventListener("click", () => {
        step.fields.push({ name: `field_${Date.now().toString(36)}`, type: "text", label: "New Input" });
        renderInspector();
        updatePreview();
      });
    }
  }
}

function addNewStep() {
  if (!currentFunnel) return;
  const newId = `step_${Date.now().toString(36)}`;
  currentFunnel.steps.push({
    id: newId,
    type: "choice",
    headline: "New Interactive Question",
    options: [
      { id: "a1", label: "Option A" },
      { id: "a2", label: "Option B" }
    ]
  });
  currentStepIndex = currentFunnel.steps.length - 1;
  renderStepsList();
  renderInspector();
  updatePreview();
}

function updateTheme(patch) {
  if (!currentFunnel) return;
  currentFunnel.theme = { ...(currentFunnel.theme || {}), ...patch };
  updatePreview();
}

function updatePreview() {
  if (!currentFunnel || !previewIframe) return;
  previewIframe.contentWindow?.postMessage(
    {
      type: "of:preview",
      funnel: JSON.parse(JSON.stringify(currentFunnel)),
      stepIndex: currentStepIndex,
    },
    "*"
  );
}

function reloadIframe() {
  if (!currentFunnel) return;
  previewIframe.src = `/f/${currentFunnel.slug || "lead-gen"}?t=${Date.now()}`;
}

async function saveFunnel() {
  if (!currentFunnel) return;
  saveFunnelBtn.textContent = "Saving...";
  try {
    const res = await fetch("/api/builder/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(currentFunnel)
    });
    if (!res.ok) throw new Error("Save failed");
    saveFunnelBtn.textContent = "Saved! ✅";
    setTimeout(() => (saveFunnelBtn.textContent = "💾 Save Funnel"), 2000);
  } catch (err) {
    alert("Failed to save funnel document.");
    saveFunnelBtn.textContent = "💾 Save Funnel";
  }
}

function showJsonExport() {
  if (!currentFunnel) return;
  jsonTextarea.value = JSON.stringify(currentFunnel, null, 2);
  jsonModal.showModal();
}

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Matches the console's escaper. Not required while every attribute here is
    // double-quoted, but four near-identical escapers that differ is how one of
    // them ends up being the wrong one to have copied.
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", init);
