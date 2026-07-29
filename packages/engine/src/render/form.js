/**
 * @file `form` step — contact capture. Renders configurable fields with inline
 * validation (email/phone/etc). On a valid submit it merges values into the
 * lead, fires the `lead` event + `submitLead()`, then advances.
 */

import { el } from "../dom.js";
import { validateForm } from "../validate.js";

/** @type {Record<string, { input: string, type?: string, autocomplete?: string }>} */
const FIELD_HTML = {
  text: { input: "input", type: "text" },
  name: { input: "input", type: "text", autocomplete: "name" },
  email: { input: "input", type: "email", autocomplete: "email" },
  tel: { input: "input", type: "tel", autocomplete: "tel" },
  number: { input: "input", type: "number" },
  date: { input: "input", type: "date" },
  textarea: { input: "textarea" },
  select: { input: "select" },
  file: { input: "input", type: "file" },
};

/**
 * @param {import('../types.js').FormStep} step
 * @param {import('../controller.js').Controller} ctrl
 * @returns {HTMLElement}
 */
export function renderForm(step, ctrl) {
  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Record<string, HTMLElement>} */
  const errorEls = {};

  /** @type {HTMLElement | null} */
  let otpCard = null;

  const form = el("form", {
    class: "of-form",
    novalidate: true,
    onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const errors = validateForm(step.fields, values);
      let firstBad = /** @type {HTMLElement | null} */ (null);
      for (const field of step.fields) {
        const msg = errors[field.name] || "";
        const errEl = errorEls[field.name];
        if (errEl) errEl.textContent = msg;
        const wrap = errEl?.closest(".of-field");
        wrap?.classList.toggle("has-error", Boolean(msg));
        if (msg && !firstBad) firstBad = /** @type {HTMLElement} */ (wrap?.querySelector("input, textarea, select") || null);
      }
      if (Object.keys(errors).length) {
        firstBad?.focus();
        return;
      }

      // Check if real-time email OTP verification is enabled for this step
      const targetEmail = String(values.email || "").trim();
      if (step.verifyEmail && targetEmail && !values.email_verified) {
        const ctaBtn = form.querySelector(".of-cta");
        if (ctaBtn) ctaBtn.setAttribute("disabled", "true");

        try {
          await fetch("/api/otp/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: targetEmail }),
          });

          // Render 4-digit OTP Verification UI overlay
          if (!otpCard) {
            let otpVal = "";
            const otpError = el("span", { class: "of-field-error", role: "alert" });

            const otpInput = el("input", {
              type: "text",
              class: "of-input of-otp-input",
              placeholder: "1234",
              maxLength: 6,
              inputmode: "numeric",
              autocomplete: "one-time-code",
              oninput: (/** @type {Event} */ ev) => {
                otpVal = /** @type {HTMLInputElement} */ (ev.target).value.trim();
                otpError.textContent = "";
              },
            });

            otpCard = el("div", { class: "of-otp-card" }, [
              el("div", { class: "of-otp-title", text: "✉️ Verify your email" }),
              el("div", { class: "of-otp-sub", text: `We sent a 4-digit verification code to ${targetEmail}` }),
              el("label", { class: "of-field", style: { marginTop: "12px" } }, [otpInput, otpError]),
              el("div", { class: "of-actions", style: { display: "flex", gap: "8px" } }, [
                el("button", {
                  type: "button",
                  class: "of-cta",
                  text: "Verify & Submit",
                  onclick: async () => {
                    if (!otpVal || otpVal.length < 4) {
                      otpError.textContent = "Please enter the 4-digit code";
                      return;
                    }
                    try {
                      const vRes = await fetch("/api/otp/verify", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ email: targetEmail, code: otpVal }),
                      });
                      const vData = await vRes.json();
                      if (vData.ok || vData.valid) {
                        values.email_verified = true;
                        ctrl.submitForm(values);
                      } else {
                        otpError.textContent = "Incorrect verification code. Please try again.";
                      }
                    } catch {
                      otpError.textContent = "Verification check failed.";
                    }
                  },
                }),
              ]),
            ]);
            form.innerHTML = "";
            form.appendChild(otpCard);
            setTimeout(() => otpInput.focus(), 100);
            return;
          }
        } catch {
          // If server fails or offline, fall through safely
        }
      }

      ctrl.submitForm(values);
    },
  });

  for (const field of step.fields) {
    const spec = FIELD_HTML[field.type] || FIELD_HTML.text;
    const id = `of-f-${field.name}`;
    const onInput = (/** @type {Event} */ e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      values[field.name] = t.type === "file" ? t.files?.[0]?.name ?? "" : t.value;
      // Clear the error as soon as the visitor starts fixing it.
      const wrap = t.closest(".of-field");
      if (wrap?.classList.contains("has-error")) {
        wrap.classList.remove("has-error");
        if (errorEls[field.name]) errorEls[field.name].textContent = "";
      }
    };

    /** @type {HTMLElement} */
    let input;
    if (spec.input === "select") {
      input = el(
        "select",
        { id, class: "of-input", name: field.name, oninput: onInput, required: field.required || undefined },
        [
          el("option", { value: "", text: field.placeholder || "Select…", disabled: true, selected: true }),
          ...(field.options || []).map((o) => el("option", { value: o.value, text: o.label })),
        ],
      );
    } else if (spec.input === "textarea") {
      input = el("textarea", {
        id, class: "of-input", name: field.name, rows: 3,
        placeholder: field.placeholder || "", oninput: onInput,
      });
    } else {
      input = el("input", {
        id, class: "of-input", name: field.name,
        type: spec.type, placeholder: field.placeholder || "",
        autocomplete: field.autocomplete || spec.autocomplete,
        oninput: onInput,
        inputmode: field.type === "tel" ? "tel" : field.type === "number" ? "numeric" : undefined,
      });
    }

    const errEl = el("span", { class: "of-field-error", role: "alert", "aria-live": "polite" });
    errorEls[field.name] = errEl;

    form.appendChild(
      el("label", { class: "of-field", for: id }, [
        field.label ? el("span", { class: "of-field-label", text: field.label }) : null,
        input,
        errEl,
      ]),
    );
  }

  if (step.consent) form.appendChild(el("p", { class: "of-consent", html: step.consent }));

  form.appendChild(
    el("div", { class: "of-actions" }, [
      el("button", { type: "submit", class: "of-cta", text: step.submitLabel || "Continue" }),
    ]),
  );

  return form;
}
