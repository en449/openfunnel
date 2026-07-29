/**
 * @file Answer piping — personalise copy with previously captured data.
 *
 * Any headline / subtext / text block may contain `{{token}}` placeholders that
 * are replaced at render time from the lead fields and recorded answers, e.g.
 *   "Great choice, {{name}}!"  or  "Based on your goal of {{goal}}…"
 *
 * Tokens resolve against `lead` first (form field names), then `answers`
 * (keyed by step id). Unknown tokens render as empty string so a funnel never
 * shows raw `{{...}}` to a visitor.
 */

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * @param {string | undefined | null} template
 * @param {{ lead?: Record<string, unknown>, answers?: Record<string, unknown> }} data
 * @returns {string}
 */
export function pipe(template, data) {
  if (!template) return "";
  const lead = data.lead ?? {};
  const answers = data.answers ?? {};
  return template.replace(TOKEN, (_match, key) => {
    const value = key in lead ? lead[key] : answers[key];
    if (value == null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}
