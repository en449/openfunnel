/**
 * @file Field validation for `form` steps. Deliberately lenient — the goal of a
 * lead funnel is capture, not gatekeeping — but it catches obvious typos so you
 * don't collect junk. Returns a human-readable message, or "" when valid.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Accepts +, spaces, dashes, parens; requires at least 7 digits.
const PHONE_DIGITS_RE = /\d/g;

/**
 * @param {import('./types.js').FormField} field
 * @param {unknown} raw
 * @returns {string} Error message, or "" if the value is acceptable.
 */
export function validateField(field, raw) {
  const value = typeof raw === "string" ? raw.trim() : raw;
  const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);

  if (empty) return field.required ? field.error || "This field is required." : "";
  const str = String(value);

  switch (field.type) {
    case "email":
      return EMAIL_RE.test(str) ? "" : field.error || "Please enter a valid email address.";
    case "tel": {
      const digits = (str.match(PHONE_DIGITS_RE) || []).length;
      return digits >= 7 ? "" : field.error || "Please enter a valid phone number.";
    }
    case "number":
      return Number.isFinite(Number(str)) ? "" : field.error || "Please enter a number.";
    default:
      if (field.pattern) {
        try {
          return new RegExp(field.pattern).test(str) ? "" : field.error || "Please check this field.";
        } catch {
          return "";
        }
      }
      return "";
  }
}

/**
 * Validate a whole form step.
 * @param {import('./types.js').FormField[]} fields
 * @param {Record<string, unknown>} values
 * @returns {Record<string, string>} Map of field name → error (only invalid ones).
 */
export function validateForm(fields, values) {
  /** @type {Record<string, string>} */
  const errors = {};
  for (const field of fields) {
    const msg = validateField(field, values[field.name]);
    if (msg) errors[field.name] = msg;
  }
  return errors;
}
