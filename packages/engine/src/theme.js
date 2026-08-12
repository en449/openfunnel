/**
 * @file Turns a funnel's `theme` JSON into CSS custom properties on the root
 * element. Every colour/spacing token in styles.css reads from an `--of-*`
 * variable, so a funnel is fully re-skinnable from data alone.
 *
 * **Nothing here reaches outside the page.** It used to: a non-system
 * `theme.font` was fetched from Google with a `<link>` injected at runtime, and
 * the request was consent-gated because it hands the visitor's IP, user-agent
 * and Referer to a third party. The families the presets use are now self-hosted
 * (`fonts/fonts.css`, PHASE-1-PLAN.md §4.9), so the request, the gate around it
 * and the `allowRemote` option are all gone rather than repointed — a gate
 * around a same-origin request protects nothing and tells the next reader it
 * does.
 *
 * The consequence is deliberate: `theme.font` naming a family the page does not
 * already have resolves through the stack to a system font instead of summoning
 * a third party onto a visitor's page. A funnel that wants a different face
 * self-hosts it the way these do.
 */

/** @type {Omit<Required<import('./types.js').FunnelTheme>, 'preset'>} */
const LIGHT = {
  primary: "#4f46e5",
  primaryText: "#ffffff",
  bg: "#eef1f6",
  surface: "#ffffff",
  text: "#0f172a",
  muted: "#64748b",
  border: "#e2e8f0",
  radius: "16px",
  font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mode: "light",
};

/** @type {Partial<import('./types.js').FunnelTheme>} */
const DARK = {
  bg: "#0b1020",
  surface: "#131a2c",
  text: "#f1f5f9",
  muted: "#94a3b8",
  border: "#26314b",
};

export const THEME_PRESETS = {
  "midnight-glass": {
    presetName: "Midnight Glass",
    primary: "#6366f1",
    primaryText: "#ffffff",
    bg: "#060814",
    surface: "rgba(20, 24, 45, 0.85)",
    text: "#f8fafc",
    muted: "#94a3b8",
    border: "rgba(255, 255, 255, 0.14)",
    radius: "20px",
    font: "'Plus Jakarta Sans', system-ui, sans-serif",
    mode: "dark"
  },
  "neo-brutalist": {
    presetName: "Neo Brutalist",
    primary: "#ff3366",
    primaryText: "#ffffff",
    bg: "#fffbe8",
    surface: "#ffffff",
    text: "#000000",
    muted: "#555555",
    border: "#000000",
    radius: "6px",
    font: "'Space Grotesk', system-ui, sans-serif",
    mode: "light"
  },
  "warm-editorial": {
    presetName: "Warm Editorial",
    primary: "#d97706",
    primaryText: "#ffffff",
    bg: "#fefce8",
    surface: "#ffffff",
    text: "#1c1917",
    muted: "#78716c",
    border: "#e7e5e4",
    radius: "14px",
    font: "'Playfair Display', serif",
    mode: "light"
  },
  "saas-gradient": {
    presetName: "SaaS Indigo Pop",
    primary: "#4f46e5",
    primaryText: "#ffffff",
    bg: "#090d16",
    surface: "#111827",
    text: "#f9fafb",
    muted: "#9ca3af",
    border: "#1f2937",
    radius: "18px",
    font: "'Inter', system-ui, sans-serif",
    mode: "dark"
  },
  "clean-light": {
    presetName: "Clean SaaS Light",
    primary: "#2563eb",
    primaryText: "#ffffff",
    bg: "#f8fafc",
    surface: "#ffffff",
    text: "#0f172a",
    muted: "#64748b",
    border: "#e2e8f0",
    radius: "16px",
    font: "'Plus Jakarta Sans', system-ui, sans-serif",
    mode: "light"
  },
  "emerald-glow": {
    presetName: "Emerald Performance",
    primary: "#059669",
    primaryText: "#ffffff",
    bg: "#022c22",
    surface: "#064e3b",
    text: "#ecfdf5",
    muted: "#a7f3d0",
    border: "rgba(167, 243, 208, 0.2)",
    radius: "18px",
    font: "'Plus Jakarta Sans', system-ui, sans-serif",
    mode: "dark"
  },
  "violet-pulse": {
    presetName: "Violet Agency Luxe",
    primary: "#7c3aed",
    primaryText: "#ffffff",
    bg: "#0f0728",
    surface: "#1e1045",
    text: "#f5f3ff",
    muted: "#ddd6fe",
    border: "rgba(221, 214, 254, 0.2)",
    radius: "20px",
    font: "'Inter', system-ui, sans-serif",
    mode: "dark"
  },
  "sunset-coral": {
    presetName: "Sunset Coral Light",
    primary: "#f43f5e",
    primaryText: "#ffffff",
    bg: "#fff1f2",
    surface: "#ffffff",
    text: "#1e293b",
    muted: "#64748b",
    border: "#ffe4e6",
    radius: "16px",
    font: "'Plus Jakarta Sans', system-ui, sans-serif",
    mode: "light"
  }
};

/**
 * Resolve a funnel's `theme` against its preset and the light/dark defaults.
 * The one place preset + explicit theme + light/dark defaults are merged, so
 * every caller sees the same resolved values.
 *
 * @param {import('./types.js').FunnelTheme & { preset?: string, btnStyle?: string }} [theme]
 * @returns {Record<string, any>}
 */
function resolveTheme(theme = {}) {
  const presetsMap = /** @type {Record<string, any>} */ (THEME_PRESETS);
  const presetTheme = theme.preset && presetsMap[theme.preset] ? presetsMap[theme.preset] : {};
  const mergedTheme = { ...presetTheme, ...theme };
  const base = mergedTheme.mode === "dark" ? { ...LIGHT, ...DARK } : LIGHT;
  return { ...base, ...mergedTheme };
}

/* ========================================================================== *
 *  Theme application
 * ========================================================================== */

/**
 * @param {HTMLElement} root
 * @param {import('./types.js').FunnelTheme & { preset?: string, btnStyle?: string }} [theme]
 */
export function applyTheme(root, theme = {}) {
  const merged = resolveTheme(theme);

  const btnStyle = merged.btnStyle || "glow";
  root.setAttribute("data-btn-style", btnStyle);

  /** @type {Record<string,string>} */
  const vars = {
    "--of-primary": merged.primary,
    "--of-primary-text": merged.primaryText,
    "--of-bg": merged.bg,
    "--of-surface": merged.surface,
    "--of-text": merged.text,
    "--of-muted": merged.muted,
    "--of-border": merged.border,
    "--of-radius": merged.radius,
    "--of-font": merged.font,
    "--of-btn-style": btnStyle,
  };
  for (const [k, v] of Object.entries(vars)) if (v) root.style.setProperty(k, v);
}


