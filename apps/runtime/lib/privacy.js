/**
 * @file WO-D7 — the Datenschutzerklärung module: `privacyNotice(facts)`.
 *
 * PLAN.md §8.5: a *fill-in-the-blanks Datenschutzerklärung module* Enno hands
 * the client for their own privacy notice, generated from the funnel's actual
 * configuration — "a product feature, not paperwork". The client is the
 * DSGVO controller and this platform's operator is the processor (Art. 28);
 * the output says so in its own first lines and never claims to be a complete
 * Datenschutzerklärung or legal advice.
 *
 * PURE ON PURPOSE. No `fetch`, no database, no `process.env` read in this
 * file — every fact it renders arrives already resolved in `facts`, which is
 * what makes the derivation unit-testable and keeps `routes/admin.js` thin.
 * `GET /api/admin/privacy-notice` is the only caller; it assembles `facts`
 * from the funnel document, the client row (when a database is configured),
 * `delivery_target` rows (kinds only — see below), the active mail transport
 * and `process.env.VERCEL_REGION`.
 *
 * THE ONE RULE THAT MATTERS MORE THAN THE WORDING: every paragraph is
 * switched on by something real in `facts`. A funnel that configures nothing
 * (no pixels, no client row, no delivery target) produces a short text —
 * inventing a sentence about a thing this install does not do is the
 * unforgivable bug here, because the client publishes this under their own
 * name. `apps/runtime/test/privacy.test.js` asserts on which sentences
 * appear, not on the wording, so the prose below may be edited freely as
 * long as that switching logic stays intact.
 *
 * `facts.deliveryTargets` entries may carry a `config` field (real
 * `delivery_target` rows do — it holds the webhook secret, CLAUDE.md). This
 * function reads `.kind` only and NEVER `.config`, on any entry, anywhere —
 * `privacy.test.js` proves it by handing in a `config` that carries a secret
 * string and grepping the whole rendered text for it.
 */

/** FieldType (packages/engine/src/types.js) → a German description for the list of what is collected. */
const FIELD_TYPE_LABELS = /** @type {Record<string, string>} */ ({
  text: "Freitext",
  name: "Name",
  email: "E-Mail-Adresse",
  tel: "Telefonnummer",
  textarea: "Freitext",
  select: "Auswahl",
  date: "Datum",
  number: "Zahl",
  file: "Datei-Upload",
  address: "Adresse",
});

/** `FunnelIntegrations` key → the pixel's name and the transfer it entails. Order is the order named in the text. */
const PIXELS = /** @type {Array<[string, string]>} */ ([
  ["metaPixelId", "Meta Pixel (Meta Platforms Ireland Ltd. / Meta Platforms, Inc., USA — Datenübermittlung in die USA)"],
  ["ga4Id", "Google Analytics 4 (Google Ireland Ltd. / Google LLC, USA — Datenübermittlung in die USA)"],
  ["gtmId", "Google Tag Manager (Google Ireland Ltd. / Google LLC, USA — Datenübermittlung in die USA)"],
  ["tiktokPixelId", "TikTok Pixel (TikTok Technology Ltd. / ByteDance Ltd., USA — Datenübermittlung in die USA)"],
]);

/** `activeEmailProvider()`'s result (lib/email.js) → who actually processes the notification mail. */
const EMAIL_PROVIDER_LABELS = /** @type {Record<string, string>} */ ({
  brevo: "Brevo SAS (Frankreich, OVHcloud-Infrastruktur)",
  resend: "Resend (USA — Datenübermittlung in die USA)",
  http_relay: "einem vom Betreiber selbst konfigurierten E-Mail-Relay (Standort vom Betreiber zu benennen)",
});

/** Vercel region codes with a known country, so the hosting paragraph never guesses. */
const US_VERCEL_REGIONS = new Set(["iad1", "sfo1", "pdx1", "cle1"]);
const EU_VERCEL_REGIONS = new Set(["dub1", "fra1", "arn1", "cdg1"]);

/**
 * @typedef {Object} PrivacyClientFacts
 * @property {string} name
 * @property {string} contactEmail
 * @property {number} retentionMonths
 * @property {string|null} avvSignedAt
 */

/**
 * @typedef {Object} PrivacyDeliveryTarget
 * @property {string} kind        "email" | "webhook" | "sheet" — the only column this function reads.
 * @property {unknown} [config]   NEVER read. Present in real rows; kept in the type so a caller
 *                                 that passes one through has nothing to strip first.
 */

/**
 * Everything `privacyNotice()` needs, already resolved by the caller.
 *
 * @typedef {Object} PrivacyFacts
 * @property {string} slug
 * @property {any[]} steps                          The funnel document's own `steps` — walked for `form` fields only.
 * @property {Record<string, any>} integrations      The funnel document's own `integrations`.
 * @property {{ enabled?: boolean, textVersion?: string }} consent
 * @property {PrivacyClientFacts|null} client         null when no client row backs this funnel (no database, or self-hosted).
 * @property {boolean} dbConfigured                   Whether this install runs against Postgres at all.
 * @property {PrivacyDeliveryTarget[]} deliveryTargets
 * @property {"brevo"|"resend"|"http_relay"|null} emailProvider  The transport that would actually send, if any.
 * @property {string|null|undefined} vercelRegion      Raw `process.env.VERCEL_REGION`.
 * @property {"impressum_url_missing"|"privacy_url_missing"|"avv_unsigned"|null} blockedReason
 *   The exact reason `funnelGates()` / the page-serve gate would refuse this funnel — reused rather
 *   than re-derived, so the notice's legal-URL and AVV warnings can never disagree with the gate that
 *   actually decides whether the page renders.
 */

/**
 * Every field of every `form` step, deduplicated by field name (first occurrence wins — a funnel
 * asking for the same field twice across two form steps still describes it once).
 *
 * @param {any[]} steps
 * @returns {Array<{ name: string, label: string, type: string }>}
 */
function collectFormFields(steps) {
  /** @type {Map<string, { name: string, label: string, type: string }>} */
  const byName = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step?.type !== "form" || !Array.isArray(step.fields)) continue;
    for (const field of step.fields) {
      const name = String(field?.name || "").trim();
      if (!name || byName.has(name)) continue;
      byName.set(name, { name, label: String(field?.label || name), type: String(field?.type || "text") });
    }
  }
  return [...byName.values()];
}

/** @param {Record<string, any>} integrations @returns {string[]} pixel descriptions, in `PIXELS` order. */
function collectPixels(integrations) {
  const ig = integrations || {};
  /** @type {string[]} */
  const found = [];
  for (const [key, label] of PIXELS) if (ig[key]) found.push(label);
  return found;
}

/**
 * A timestamptz as a German date. Reformatted rather than interpolated: only
 * digits from a parsed Date reach a text the client publishes, whatever shape
 * the column actually holds. UTC parts, so the day cannot shift under the
 * server's timezone.
 *
 * @param {string} value
 * @returns {string}
 */
function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "[Datum des AVV einsetzen]";
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** @param {string|null|undefined} code @returns {string} */
function describeRegion(code) {
  if (!code) return 'den USA (Vercel-Standardregion "iad1" — es ist keine Region konfiguriert)';
  if (US_VERCEL_REGIONS.has(code)) return `den USA (Vercel-Region "${code}")`;
  if (EU_VERCEL_REGIONS.has(code)) return `der EU (Vercel-Region "${code}")`;
  return `der Vercel-Region "${code}" (Standort vor Veröffentlichung prüfen)`;
}

/**
 * Renders the Baustein.
 *
 * @param {PrivacyFacts} facts
 * @returns {{ text: string, warnings: string[] }}
 */
export function privacyNotice(facts) {
  const client = facts.client || null;
  const formFields = collectFormFields(facts.steps);
  const pixels = collectPixels(facts.integrations);
  const consentEnabled = Boolean(facts.consent?.enabled);
  const kinds = new Set((facts.deliveryTargets || []).map((t) => t?.kind).filter(Boolean));

  /** @type {string[]} */
  const warnings = [];
  if (pixels.length > 0 && !consentEnabled) {
    warnings.push(
      "Es ist ein Tracking-Pixel eingebunden, aber der Consent-Banner ist nicht aktiviert — das ist eine " +
        "Datenweitergabe an Dritte ohne Einwilligung und unzulässig. Consent-Banner aktivieren oder Pixel entfernen.",
    );
  }
  if (facts.blockedReason === "impressum_url_missing") {
    warnings.push("Es fehlt eine gültige Impressum-URL — die Funnel-Seite wird deshalb nicht ausgeliefert.");
  }
  if (facts.blockedReason === "privacy_url_missing") {
    warnings.push("Es fehlt eine gültige Datenschutz-URL — die Funnel-Seite wird deshalb nicht ausgeliefert.");
  }
  if (!client || !client.avvSignedAt) {
    warnings.push(
      "Für diesen Kunden liegt keine unterschriebene Auftragsverarbeitungsvereinbarung (AVV) vor — ohne AVV " +
        "gibt es keine rechtmäßige Verarbeitungsgrundlage für diese Plattform.",
    );
  }
  if (kinds.has("sheet")) {
    warnings.push(
      "Ein Sheet-Ziel ist konfiguriert, aber diese Version hat keinen Sheets-Dispatcher — die betroffenen Leads " +
        "landen im Dead-Letter und werden NICHT übertragen. Ziel entfernen und ein funktionierendes wählen.",
    );
  }
  if (kinds.has("webhook")) {
    warnings.push(
      "Ein Webhook-Ziel ist konfiguriert. Dieses Zielsystem kann dieser Text nicht benennen — der Kunde muss " +
        "es selbst in seine eigene Datenschutzerklärung als Empfänger aufnehmen.",
    );
  }
  if (client && client.retentionMonths > 24) {
    warnings.push(
      `Die Aufbewahrungsfrist für Leads beträgt ${client.retentionMonths} Monate. Das ist rechtlich zulässig, ` +
        "aber für eine einfache Anfrage selten zu rechtfertigen — prüfen, ob eine kürzere Frist reicht.",
    );
  }

  /** @type {string[]} */
  const p = [];

  p.push(
    "DATENSCHUTZERKLÄRUNG — BAUSTEIN (automatisch erzeugt, unvollständig)\n" +
      "Dieser Text ist ein Baustein für die Datenschutzerklärung DIESES Funnels, keine vollständige " +
      "Datenschutzerklärung und keine Rechtsberatung. Er muss vor Veröffentlichung durch den Kunden geprüft " +
      "und in dessen eigene Erklärung eingefügt werden.",
  );

  p.push(
    `Verantwortlicher im Sinne der DSGVO ist ${client ? client.name : "[Name des Verantwortlichen einsetzen]"}` +
      ` (${client ? client.contactEmail : "[Kontakt-E-Mail einsetzen]"}).`,
  );

  // The processor sentence is the one an operator most wants to be true, so it
  // is stated only where it IS true. Three distinct situations, and the old
  // single sentence asserted the first one in all three:
  //  - a client with a signed AVV: the sentence holds, with its date;
  //  - a client without one: Art. 28 requires that contract in writing BEFORE
  //    the processing starts, so the claim would be false in the one direction
  //    that matters — it names a safeguard a supervisory authority can check
  //    and find missing. The marker goes in the body, not just `warnings`, for
  //    the same reason the pixel case does;
  //  - no client record at all (self-hosted, no database): there is no separate
  //    platform operator to name, so nothing is claimed.
  if (client && client.avvSignedAt) {
    p.push(
      "Der Betreiber dieser Plattform (OpenFunnel) verarbeitet die Daten ausschließlich im Auftrag des " +
        `Verantwortlichen; ein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO besteht seit ${formatDate(client.avvSignedAt)}.`,
    );
  } else if (client) {
    p.push(
      "[ACHTUNG — NICHT VERÖFFENTLICHEN: Der Betreiber dieser Plattform (OpenFunnel) verarbeitet die Daten im " +
        "Auftrag des Verantwortlichen, es liegt aber KEIN unterschriebener Auftragsverarbeitungsvertrag nach " +
        "Art. 28 DSGVO vor. Dieser Vertrag muss vor der Verarbeitung geschlossen werden — erst danach darf an " +
        "dieser Stelle ein Auftragsverarbeitungsverhältnis genannt werden.]",
    );
  }

  if (formFields.length > 0) {
    const list = formFields.map((f) => `${f.label} (${FIELD_TYPE_LABELS[f.type] || "Angabe"})`).join(", ");
    p.push(
      `Bei Nutzung des Formulars werden folgende Angaben erhoben: ${list}. Zweck der Verarbeitung ist die ` +
        "Kontaktaufnahme und Erstellung eines Angebots auf Anfrage der nutzenden Person (Art. 6 Abs. 1 lit. b DSGVO).",
    );
  }

  p.push(
    `Die Funnel-Seite wird über Vercel ausgeliefert, mit Serverausführung in ${describeRegion(facts.vercelRegion)}. ` +
      "Vercel Inc. ist als US-Unternehmen im Rahmen eines Auftragsverarbeitungsvertrags mit Standardvertragsklauseln eingebunden.",
  );

  if (facts.dbConfigured) {
    p.push(
      "Leads und Verlaufsdaten (Events) werden in einer Postgres-Datenbank bei Supabase Inc. (Region Irland, " +
        "eu-west-1) gespeichert — ebenfalls ein US-Unternehmen mit Auftragsverarbeitungsvertrag und Standardvertragsklauseln. " +
        "Zusätzlich existieren Datensicherungen (Backups) innerhalb des bei Supabase konfigurierten Zeitfensters.",
    );
  } else {
    p.push(
      "Es ist keine Datenbank konfiguriert: Leads und Events werden ausschließlich in Protokolldateien auf dem " +
        "Server selbst gespeichert, ohne automatische zeitbasierte Löschfrist (Rotation nach Dateigröße).",
    );
  }

  if (client) {
    p.push(`Lead-Daten werden ${client.retentionMonths} Monate aufbewahrt und danach automatisch gelöscht.`);
  }
  if (facts.dbConfigured) {
    p.push(
      "Event-Daten (Schrittverlauf, Absprungpunkte) werden 90 Tage aufbewahrt; danach verbleibt nur eine " +
        "aggregierte, nicht mehr personenbezogene Tageszusammenfassung. Eine Löschung wird spätestens 24 Stunden " +
        "nach Auslösung endgültig wirksam.",
    );
  }

  if (kinds.has("email")) {
    const providerLabel = facts.emailProvider ? EMAIL_PROVIDER_LABELS[facts.emailProvider] : null;
    p.push(
      providerLabel
        ? `Eine Benachrichtigung über jeden neuen Lead wird per E-Mail über ${providerLabel} versendet.`
        : "Eine Benachrichtigung über jeden neuen Lead wird per E-Mail versendet.",
    );
  }
  if (kinds.has("webhook")) {
    p.push(
      "Jeder Lead wird zusätzlich per Webhook an ein vom Kunden gewähltes Drittsystem übertragen (siehe Warnhinweis oben).",
    );
  }
  // No paragraph for `sheet`: `lib/delivery.js` has no dispatcher for that kind
  // and fails it as permanent, so the leads dead-letter and NOTHING reaches
  // Google. Disclosing a transfer that does not happen is the same false
  // statement as omitting one that does — it just fails in the flattering
  // direction. The warning above says what actually became of those leads.

  if (pixels.length > 0) {
    p.push(`Auf dieser Funnel-Seite sind folgende Tracking-Pixel eingebunden: ${pixels.join("; ")}.`);
    if (consentEnabled) {
      p.push(
        "Diese Pixel werden erst nach ausdrücklicher Einwilligung über den Consent-Banner geladen " +
          `(Art. 6 Abs. 1 lit. a DSGVO${facts.consent?.textVersion ? `, Einwilligungstext Version "${facts.consent.textVersion}"` : ""}).`,
      );
    } else {
      // The warning above this text says the same thing, but a warning lives in
      // the console and this text gets pasted into a document. Without the
      // marker travelling WITH the paragraph, the client publishes a notice
      // that describes third-party tracking and simply omits any legal basis —
      // which reads as normal to everyone except a supervisory authority.
      // Deliberately not phrased as a legal basis: there is none.
      p.push(
        "[ACHTUNG — NICHT VERÖFFENTLICHEN: Für diese Pixel wird derzeit keine Einwilligung eingeholt. " +
          "Damit fehlt die Rechtsgrundlage nach Art. 6 Abs. 1 lit. a DSGVO. Entweder den Consent-Banner " +
          "aktivieren oder die Pixel entfernen, bevor dieser Text verwendet wird.]",
      );
    }
  }

  p.push(
    "Die IP-Adresse der besuchenden Person wird nicht im Klartext gespeichert; es wird höchstens ein " +
      "nicht umkehrbarer, gesalzener Hashwert abgelegt.",
  );

  return { text: p.join("\n\n"), warnings };
}
