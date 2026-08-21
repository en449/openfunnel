/**
 * @file WO-D7 — `privacyNotice()` is pure, so this file asserts on the
 * DERIVATION rather than on prose: which sentences and warnings a given set of
 * facts switches on, never the exact wording (PLAN.md §8.5 calls the wording
 * free to edit; the switching logic is what a client publishes under their
 * own name, and it is what must not drift).
 */

import { expect, test } from "bun:test";
import { privacyNotice } from "../lib/privacy.js";

/** A minimal, fully-off fact set — every test overrides only what it needs. */
function baseFacts(overrides = {}) {
  return {
    slug: "wo-d7",
    steps: [],
    integrations: {},
    consent: {},
    client: null,
    dbConfigured: false,
    deliveryTargets: [],
    emailProvider: null,
    vercelRegion: undefined,
    blockedReason: null,
    ...overrides,
  };
}

const client = (overrides = {}) => ({
  name: "Musterfirma GmbH",
  contactEmail: "info@musterfirma.example",
  retentionMonths: 12,
  avvSignedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const formStep = (fields) => ({ id: "contact", type: "form", fields });

/* ========================================================================== *
 *  A funnel that configures nothing
 * ========================================================================== */

test("a funnel with nothing configured still produces a text, and it is short", () => {
  const { text, warnings } = privacyNotice(baseFacts());
  expect(text.length).toBeGreaterThan(0);
  // No form step, no pixels, no delivery target, no client, no retention over
  // 24 months, no gate block — the only warning left standing is the AVV one,
  // because there genuinely is no client row.
  expect(warnings).toEqual([expect.stringContaining("Auftragsverarbeitungsvereinbarung")]);
  // Nothing this install does not do gets a paragraph.
  expect(text).not.toMatch(/Tracking-Pixel/);
  expect(text).not.toMatch(/Webhook-Ziel|Google-Sheets/);
  expect(text).not.toMatch(/E-Mail über/);
});

/* ========================================================================== *
 *  Pixels and consent — the derivation the whole gate exists for
 * ========================================================================== */

test("no pixels configured produces no pixel/third-country paragraph", () => {
  const { text } = privacyNotice(baseFacts());
  expect(text).not.toMatch(/Tracking-Pixel|Meta Pixel|USA — Datenübermittlung/);
});

test("a configured Meta pixel produces a paragraph naming it", () => {
  const { text } = privacyNotice(baseFacts({ integrations: { metaPixelId: "123456" }, consent: { enabled: true } }));
  expect(text).toContain("Meta Pixel");
});

test("a pixel with consent disabled warns, and the text never claims consent was obtained", () => {
  const { text, warnings } = privacyNotice(
    baseFacts({ integrations: { metaPixelId: "123456" }, consent: { enabled: false } }),
  );
  expect(warnings.some((w) => /Consent-Banner/.test(w))).toBe(true);
  expect(text).toContain("Meta Pixel"); // the pixel itself is still named…
  // …no consent CLAIM is made — the sentence that would assert one is absent…
  expect(text).not.toContain("erst nach ausdrücklicher Einwilligung");
  expect(text).not.toContain("Art. 6 Abs. 1 lit. a DSGVO)");
  // …and the defect travels INSIDE the text, not only in `warnings`. A warning
  // lives in the console; this text gets pasted into a document, and without
  // the marker the client publishes a notice that describes third-party
  // tracking with no legal basis at all and reads as perfectly normal.
  expect(text).toContain("[ACHTUNG — NICHT VERÖFFENTLICHEN:");
});

test("a pixel with consent enabled names the consent text version", () => {
  const { text, warnings } = privacyNotice(
    baseFacts({
      integrations: { metaPixelId: "123456" },
      consent: { enabled: true, textVersion: "v3" },
    }),
  );
  expect(text).toMatch(/Einwilligung/);
  expect(text).toContain('"v3"');
  expect(warnings.some((w) => /Consent-Banner/.test(w))).toBe(false);
});

/* ========================================================================== *
 *  Retention — the client's actual number, named
 * ========================================================================== */

test("the retention sentence names the client's actual retention_months", () => {
  const { text } = privacyNotice(baseFacts({ client: client({ retentionMonths: 18 }) }));
  expect(text).toContain("18 Monate");
});

test("no client fact means no invented retention number", () => {
  const { text } = privacyNotice(baseFacts());
  expect(text).not.toMatch(/Monate aufbewahrt/);
});

test("retention over 24 months warns; 24 or under does not", () => {
  const over = privacyNotice(baseFacts({ client: client({ retentionMonths: 25 }) }));
  expect(over.warnings.some((w) => /Aufbewahrungsfrist/.test(w))).toBe(true);

  const atLimit = privacyNotice(baseFacts({ client: client({ retentionMonths: 24 }) }));
  expect(atLimit.warnings.some((w) => /Aufbewahrungsfrist/.test(w))).toBe(false);
});

/* ========================================================================== *
 *  Form fields — only what is actually asked for
 * ========================================================================== */

test("form fields the funnel does not ask for never appear in the collected list", () => {
  const { text } = privacyNotice(
    baseFacts({ steps: [formStep([{ name: "email", type: "email", label: "E-Mail" }])] }),
  );
  expect(text).toContain("E-Mail");
  expect(text).not.toContain("Telefonnummer");
  expect(text).not.toContain("Datei-Upload");
});

test("fields across two form steps are each named once, not duplicated", () => {
  const { text } = privacyNotice(
    baseFacts({
      steps: [
        formStep([{ name: "email", type: "email", label: "E-Mail" }]),
        formStep([{ name: "email", type: "email", label: "E-Mail" }, { name: "phone", type: "tel", label: "Telefon" }]),
      ],
    }),
  );
  expect(text.match(/E-Mail \(E-Mail-Adresse\)/g)?.length).toBe(1);
  expect(text).toContain("Telefonnummer");
});

/* ========================================================================== *
 *  `delivery_target.config` — never read, never leaks, even carrying a secret
 * ========================================================================== */

test("delivery_target.config never reaches the output, even when it carries a secret", () => {
  const { text } = privacyNotice(
    baseFacts({
      deliveryTargets: [
        { kind: "webhook", config: { url: "https://hook.example.invalid/x", secret: "SUPER_SECRET_TOKEN_XYZ" } },
      ],
    }),
  );
  expect(text).not.toContain("SUPER_SECRET_TOKEN_XYZ");
  expect(text).not.toContain("hook.example.invalid");
  expect(text).toMatch(/Webhook/); // the KIND is still described…
});

test("a webhook delivery target warns that the notice cannot name the destination", () => {
  const { warnings } = privacyNotice(baseFacts({ deliveryTargets: [{ kind: "webhook", config: {} }] }));
  expect(warnings.some((w) => /Webhook-Ziel/.test(w))).toBe(true);
});

/* ========================================================================== *
 *  Region — follows VERCEL_REGION, US when unset
 * ========================================================================== */

test("an unset region reads as the US default", () => {
  const { text } = privacyNotice(baseFacts({ vercelRegion: undefined }));
  expect(text).toMatch(/USA/);
  expect(text).toContain("iad1");
});

test("a configured EU region is named as such, not as the US default", () => {
  const { text } = privacyNotice(baseFacts({ vercelRegion: "dub1" }));
  expect(text).toContain("dub1");
  expect(text).toMatch(/der EU/);
});

test("a configured US region is named explicitly rather than falling to the default wording", () => {
  const { text } = privacyNotice(baseFacts({ vercelRegion: "sfo1" }));
  expect(text).toContain("sfo1");
  expect(text).toMatch(/den USA/);
});

/* ========================================================================== *
 *  The legal gate's own reason, reused rather than re-derived
 * ========================================================================== */

test("a missing Impressum URL (per the page-serve gate) warns by name", () => {
  const { warnings } = privacyNotice(baseFacts({ blockedReason: "impressum_url_missing" }));
  expect(warnings.some((w) => /Impressum-URL/.test(w))).toBe(true);
});

test("a missing Datenschutz URL (per the page-serve gate) warns by name", () => {
  const { warnings } = privacyNotice(baseFacts({ blockedReason: "privacy_url_missing" }));
  expect(warnings.some((w) => /Datenschutz-URL/.test(w))).toBe(true);
});

test("no client row at all warns about the missing AVV", () => {
  const { warnings, text } = privacyNotice(baseFacts({ client: null }));
  expect(warnings.some((w) => /Auftragsverarbeitungsvereinbarung/.test(w))).toBe(true);
  // Self-hosted with no database: there is no second party processing anything,
  // so the text must not invent one to point the Art. 28 sentence at.
  expect(text).not.toContain("Art. 28 DSGVO");
  expect(text).toContain("[Name des Verantwortlichen einsetzen]");
});

test("a signed AVV is the only case that claims one, and it carries the date", () => {
  const { warnings, text } = privacyNotice(
    baseFacts({ client: client({ avvSignedAt: "2026-01-01T00:00:00.000Z" }) }),
  );
  expect(warnings.some((w) => /Auftragsverarbeitungsvereinbarung/.test(w))).toBe(false);
  expect(text).toContain("Auftragsverarbeitungsvertrag nach Art. 28 DSGVO besteht seit 01.01.2026");
  expect(text).not.toContain("NICHT VERÖFFENTLICHEN");
});

test("an unsigned AVV puts the defect in the published text, not only in the warnings", () => {
  const { warnings, text } = privacyNotice(baseFacts({ client: client({ avvSignedAt: null }) }));
  expect(warnings.some((w) => /Auftragsverarbeitungsvereinbarung/.test(w))).toBe(true);
  // The whole failure this guards against is a client who never reads the
  // console warning and pastes the text: it must not assert a contract that
  // does not exist, and it must say so where the text itself is read.
  expect(text).toContain("[ACHTUNG — NICHT VERÖFFENTLICHEN:");
  expect(text).toContain("KEIN unterschriebener Auftragsverarbeitungsvertrag");
  expect(text).not.toContain("besteht seit");
});

test("a malformed AVV date degrades to a placeholder rather than printing itself", () => {
  const { text } = privacyNotice(baseFacts({ client: client({ avvSignedAt: "not-a-date" }) }));
  expect(text).not.toContain("not-a-date");
  expect(text).toContain("[Datum des AVV einsetzen]");
});

/* ========================================================================== *
 *  Database vs. self-hosted architecture — different retention/storage claims
 * ========================================================================== */

test("with a database configured, the fixed event-retention paragraph appears", () => {
  const { text } = privacyNotice(baseFacts({ dbConfigured: true }));
  expect(text).toMatch(/90 Tage/);
  expect(text).toMatch(/Supabase/);
});

test("with no database, event retention is described as local log rotation instead", () => {
  const { text } = privacyNotice(baseFacts({ dbConfigured: false }));
  expect(text).not.toMatch(/90 Tage/);
  expect(text).not.toMatch(/Supabase/);
  expect(text).toMatch(/Protokolldateien/);
});

/* ========================================================================== *
 *  Delivery targets — kind-driven paragraphs
 * ========================================================================== */

test("an email delivery target names the actual mail processor when known", () => {
  const { text } = privacyNotice(
    baseFacts({ deliveryTargets: [{ kind: "email", config: {} }], emailProvider: "brevo" }),
  );
  expect(text).toContain("Brevo");
});

test("an email delivery target with no known provider still says a mail is sent, without inventing a vendor", () => {
  const { text } = privacyNotice(baseFacts({ deliveryTargets: [{ kind: "email", config: {} }], emailProvider: null }));
  expect(text).toMatch(/per E-Mail versendet/);
  expect(text).not.toMatch(/Brevo|Resend|Relay/);
});

test("a sheet delivery target discloses no transfer, because none happens", () => {
  // `lib/delivery.js` has no dispatcher for `sheet` and fails it as permanent.
  // Disclosing a Google transfer here would describe something the code does
  // not do — and it fails in the flattering direction, so nobody notices.
  const { text, warnings } = privacyNotice(baseFacts({ deliveryTargets: [{ kind: "sheet", config: {} }] }));
  expect(text).not.toMatch(/Google/);
  expect(warnings.some((w) => /Sheets-Dispatcher/.test(w))).toBe(true);
});
