/**
 * @file OpenFunnel Admin Dashboard Application Logic
 */

let allLeads = [];

const leadsTab = document.getElementById("leadsTab");
const analyticsTab = document.getElementById("analyticsTab");
const tabBtns = document.querySelectorAll(".of-tab-btn");
const leadsTableBody = document.getElementById("leadsTableBody");
const leadSearchInput = document.getElementById("leadSearchInput");
const exportCsvBtn = document.getElementById("exportCsvBtn");

const statStarts = document.getElementById("statStarts");
const statStepViews = document.getElementById("statStepViews");
const statLeads = document.getElementById("statLeads");
const statCompletes = document.getElementById("statCompletes");
const dropoffChart = document.getElementById("dropoffChart");

async function init() {
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (btn.dataset.tab === "leads") {
        leadsTab.classList.add("active");
        analyticsTab.classList.remove("active");
      } else {
        analyticsTab.classList.add("active");
        leadsTab.classList.remove("active");
        fetchStats();
      }
    });
  });

  leadSearchInput.addEventListener("input", filterLeads);
  exportCsvBtn.addEventListener("click", exportCsv);

  await fetchLeads();
  await fetchStats();
}

async function fetchLeads() {
  try {
    const res = await fetch("/api/admin/leads");
    if (!res.ok) throw new Error("Failed to fetch leads");
    const data = await res.json();
    allLeads = data.leads || [];
    renderLeads(allLeads);
  } catch (err) {
    leadsTableBody.innerHTML = `<tr><td colspan="5" class="of-loading-td">No leads captured yet or error loading.</td></tr>`;
  }
}

function renderLeads(leads) {
  if (!leads.length) {
    leadsTableBody.innerHTML = `<tr><td colspan="5" class="of-loading-td">No lead records found.</td></tr>`;
    return;
  }

  leadsTableBody.innerHTML = leads.map((item) => {
    const dateStr = item.received_at ? new Date(item.received_at).toLocaleString() : "Unknown";
    const leadData = item.lead || {};
    const contact = leadData.email || leadData.phone || leadData.name || JSON.stringify(leadData);
    const answersStr = JSON.stringify(item.answers || {});

    return `
      <tr>
        <td>${esc(dateStr)}</td>
        <td><span class="of-badge-tag">${esc(item.funnelId || "lead-gen")}</span></td>
        <td><strong>${esc(contact)}</strong></td>
        <td><div class="of-answer-json" title="${esc(answersStr)}">${esc(answersStr)}</div></td>
        <td><span style="color:#64748b">${esc(item.ip || "127.0.0.1")}</span></td>
      </tr>
    `;
  }).join("");
}

function filterLeads() {
  const query = leadSearchInput.value.toLowerCase().trim();
  if (!query) return renderLeads(allLeads);
  const filtered = allLeads.filter((item) => {
    const jsonStr = JSON.stringify(item).toLowerCase();
    return jsonStr.includes(query);
  });
  renderLeads(filtered);
}

function exportCsv() {
  if (!allLeads.length) return alert("No lead data to export.");
  const headers = ["received_at", "funnelId", "contact", "answers", "ip"];
  const rows = allLeads.map((l) => [
    l.received_at || "",
    l.funnelId || "",
    l.lead?.email || l.lead?.phone || l.lead?.name || "",
    JSON.stringify(l.answers || {}).replace(/"/g, '""'),
    l.ip || ""
  ]);

  const csvContent = [headers.join(","), ...rows.map((r) => r.map((cell) => `"${cell}"`).join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `openfunnel-leads-${Date.now()}.csv`;
  a.click();
}

async function fetchStats() {
  try {
    const res = await fetch("/api/admin/stats");
    if (!res.ok) return;
    const stats = await res.json();
    statStarts.textContent = stats.starts || 0;
    statStepViews.textContent = stats.stepViews || 0;
    statLeads.textContent = stats.leads || 0;
    statCompletes.textContent = stats.completes || 0;

    renderDropoffChart(stats);
  } catch (err) {
    console.error("Error fetching stats:", err);
  }
}

function renderDropoffChart(stats) {
  const stages = [
    { label: "Funnel Starts", val: stats.starts || 0 },
    { label: "Step Views", val: stats.stepViews || 0 },
    { label: "Lead Captures", val: stats.leads || 0 },
    { label: "Completes", val: stats.completes || 0 }
  ];

  const maxVal = Math.max(1, ...stages.map((s) => s.val));

  dropoffChart.innerHTML = stages.map((st) => {
    const pct = Math.round((st.val / maxVal) * 100);
    return `
      <div class="of-bar-row">
        <div class="of-bar-label">${esc(st.label)}</div>
        <div class="of-bar-track">
          <div class="of-bar-fill" style="width: ${pct}%"></div>
        </div>
        <div class="of-bar-val">${st.val}</div>
      </div>
    `;
  }).join("");
}

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", init);
