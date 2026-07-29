/**
 * @file localStorage persistence so a returning visitor resumes where they left
 * off. Fails silently in private-mode / storage-disabled browsers — persistence
 * is a nicety, never a requirement.
 */

const PREFIX = "openfunnel:";

/**
 * @param {string} key  Usually the funnel id/slug.
 * @returns {import('./types.js').FunnelState | null}
 */
export function loadState(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {import('./types.js').FunnelState} state
 */
export function saveState(key, state) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(state));
  } catch {
    /* storage full or unavailable — ignore */
  }
}

/** @param {string} key */
export function clearState(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
