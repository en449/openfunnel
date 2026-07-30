/**
 * @file Turns a funnel's `theme` JSON into CSS custom properties on the root
 * element. Every colour/spacing token in styles.css reads from an `--of-*`
 * variable, so a funnel is fully re-skinnable from data alone.
 *
 * The one thing here that reaches outside the page is the webfont `<link>` for a
 * non-system `theme.font`. That is a third-party request, so the caller decides
 * whether it may happen (`applyTheme(..., { allowRemote })`) and can make it
 * later with `loadThemeFont`. This module stays independent of consent.js — the
 * decision is passed in as a boolean, never imported.
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

/* ========================================================================== *
 *  Webfonts
 *
 *  Loading a Google font is a third-party request: it sends the visitor's IP,
 *  user-agent and Referer to fonts.googleapis.com. So it is consent-gated like a
 *  pixel (the caller passes the decision in — theme.js deliberately knows nothing
 *  about consent.js), and the family extraction has to be conservative: a stack
 *  the browser can satisfy locally must produce no request at all.
 * ========================================================================== */

/**
 * Families we must never ask Google for, compared lower-case. CSS generic
 * families and the system-UI stack are already on the device, and the CSS-wide
 * keywords are not families at all. Requesting any of them leaks the visitor to
 * Google in exchange for a 404.
 */
const LOCAL_FAMILIES = new Set([
  // generic families
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "math", "emoji", "fangsong",
  // system stacks
  "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "blinkmacsystemfont",
  // faces that ship with the OS, not with Google Fonts
  "segoe ui", "arial", "helvetica", "helvetica neue", "times new roman", "times",
  "courier new", "courier", "georgia", "verdana", "tahoma",
  // CSS-wide keywords
  "inherit", "initial", "unset", "revert", "revert-layer",
]);

/**
 * The webfont family a font stack asks for, or `""` when nothing should be
 * fetched.
 *
 * Only the FIRST comma-separated segment counts — everything after it is a
 * fallback the browser already has. The segment is taken whole (the old regex
 * stopped at the first `-`, which turned the default `ui-sans-serif, …` stack
 * into a request for a font literally named "ui"), quotes are optional because
 * the console lets an operator type a bare `Playfair Display`, and anything that
 * is not a plain alphanumeric family name is refused rather than pasted into a
 * URL.
 *
 * @param {string} [fontStr]
 * @returns {string}
 */
function remoteFontFamily(fontStr) {
  const first = String(fontStr ?? "").split(",")[0] ?? "";
  const name = first.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim();
  if (!name) return "";
  const lower = name.toLowerCase();
  if (lower.startsWith("-") || lower.startsWith("ui-")) return ""; // -apple-system, ui-*
  if (LOCAL_FAMILIES.has(lower)) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9 ]*$/.test(name)) return ""; // var(), escapes, junk
  return name;
}

/**
 * Inject the `<link>` for a Google-hosted family. De-duped by element id, so
 * calling it again for the same family is free.
 *
 * @param {string} fontStr  A CSS font-family stack.
 */
function ensureGoogleFontLoaded(fontStr) {
  if (typeof document === "undefined") return;
  const fontName = remoteFontFamily(fontStr);
  if (!fontName) return;

  const fontId = `of-font-${fontName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  if (document.getElementById(fontId)) return;

  const link = document.createElement("link");
  link.id = fontId;
  link.rel = "stylesheet";
  const fontParam = encodeURIComponent(fontName).replace(/%20/g, "+");
  link.href = `https://fonts.googleapis.com/css2?family=${fontParam}:wght@400;500;600;700;800&display=swap`;
  document.head.appendChild(link);
}

/**
 * Resolve a funnel's `theme` against its preset and the light/dark defaults.
 * Shared by `applyTheme` and `loadThemeFont` so both agree on which font a
 * theme actually asks for.
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

/**
 * Fetch the webfont this theme asks for, if any. Exported so a caller that held
 * the request back can make it later — the Controller calls this when a visitor
 * accepts the consent bar. A theme whose stack is satisfied locally (including
 * the default) makes no request.
 *
 * @param {import('./types.js').FunnelTheme & { preset?: string }} [theme]
 */
export function loadThemeFont(theme = {}) {
  ensureGoogleFontLoaded(resolveTheme(theme).font);
}

/* ========================================================================== *
 *  Theme application
 * ========================================================================== */

/**
 * @param {HTMLElement} root
 * @param {import('./types.js').FunnelTheme & { preset?: string, btnStyle?: string }} [theme]
 * @param {{ allowRemote?: boolean }} [opts]  `allowRemote: false` applies the CSS
 *   variables but makes no webfont request — pass the visitor's consent decision
 *   here. Defaults to true so a direct embedder's behaviour is unchanged.
 */
export function applyTheme(root, theme = {}, { allowRemote = true } = {}) {
  const merged = resolveTheme(theme);

  if (allowRemote) {
    ensureGoogleFontLoaded(merged.font);
  }

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


