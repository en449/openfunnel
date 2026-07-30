/**
 * @file OpenFunnel funnel schema.
 *
 * This file contains ONLY JSDoc typedefs — no runtime code. It is the single
 * source of truth for the funnel JSON contract that every other part of the
 * platform (runtime, builder, storage, docs) agrees on.
 *
 * A funnel is a plain, serialisable JSON object: `{ ...meta, steps: [...] }`.
 * Steps are a discriminated union keyed by `type`. The engine walks the steps
 * as a state machine; branching is expressed by an optional `next` on a step or
 * on an individual choice option (a step/option with no `next` falls through to
 * the following step in document order).
 */

/* ========================================================================== *
 *  Theme & settings
 * ========================================================================== */

/**
 * Visual theme. All values are optional; the engine supplies sensible defaults.
 * These are surfaced as CSS custom properties (`--of-*`) so a funnel can be
 * fully re-skinned from JSON without touching CSS.
 *
 * @typedef {Object} FunnelTheme
 * @property {string} [preset]       Optional preset theme identifier.
 * @property {string} [primary]      Accent / CTA colour (e.g. "#4f46e5").
 * @property {string} [primaryText]  Text colour on top of `primary`.
 * @property {string} [bg]           Page background (behind the phone canvas).
 * @property {string} [surface]      Canvas / card background.
 * @property {string} [text]         Primary text colour.
 * @property {string} [muted]        Secondary / subtext colour.
 * @property {string} [border]       Border / divider colour.
 * @property {string} [radius]       Base border-radius (e.g. "16px").
 * @property {string} [font]         CSS font-family stack.
 * @property {"light"|"dark"} [mode] Base colour mode for defaults.
 */

/**
 * Funnel-wide behaviour flags.
 *
 * @typedef {Object} FunnelSettings
 * @property {boolean} [showProgress]   Show the top progress bar. Default true.
 * @property {boolean} [allowBack]      Show a back button. Default true.
 * @property {boolean} [persist]        Persist progress to localStorage so a
 *                                      returning visitor resumes. Default true.
 * @property {boolean} [enableSwipe]    Allow horizontal swipe/drag to advance on
 *                                      simple steps. Default true.
 * @property {"slide"|"fade"|"none"} [transition] Between-step animation. Default "slide".
 */

/**
 * Analytics / integration configuration for a funnel.
 *
 * @typedef {Object} FunnelIntegrations
 * @property {string} [metaPixelId]     Meta (Facebook) pixel id for client `fbq()`.
 * @property {string} [gtmId]           Google Tag Manager container id.
 * @property {string} [ga4Id]           GA4 measurement id for `gtag()`.
 * @property {string} [tiktokPixelId]  TikTok pixel id.
 * @property {string} [webhookUrl]      Zapier / Make / custom webhook endpoint.
 * @property {string} [leadEndpoint]    URL that receives the lead payload (POST).
 *                                      Defaults to the platform's own edge function.
 */

/* ========================================================================== *
 *  Content blocks (reusable rich content that can appear on any step header)
 * ========================================================================== */

/**
 * @typedef {Object} ImageBlock
 * @property {"image"} type
 * @property {string} src
 * @property {string} [alt]
 * @property {"cover"|"contain"} [fit]
 * @property {string} [aspect]  CSS aspect-ratio, e.g. "16/9".
 */
/**
 * @typedef {Object} VideoBlock
 * @property {"video"} type
 * @property {string} src        MP4/HLS url, or a YouTube/Vimeo/embed url.
 * @property {string} [poster]
 * @property {boolean} [autoplay]
 * @property {boolean} [controls] Default true.
 */
/**
 * @typedef {Object} TextBlock
 * @property {"text"} type
 * @property {string} value       Supports answer piping, e.g. "Nice, {{name}}!".
 * @property {"sm"|"md"|"lg"} [size]
 * @property {"left"|"center"} [align]
 */
/**
 * @typedef {Object} ListBlock
 * @property {"list"} type
 * @property {Array<{ icon?: string, text: string }>} items
 */
/**
 * @typedef {Object} ReviewsBlock
 * @property {"reviews"} type
 * @property {Array<{ name: string, text: string, avatar?: string, rating?: number }>} items
 */
/**
 * @typedef {Object} CountdownBlock
 * @property {"countdown"} type
 * @property {number} minutes     Countdown duration from first view.
 * @property {string} [label]
 */
/**
 * @typedef {Object} TrustBlock  Row of small trust badges / logos.
 * @property {"trust"} type
 * @property {Array<{ src?: string, label?: string }>} items
 */
/**
 * @typedef {Object} SpacerBlock
 * @property {"spacer"} type
 * @property {number} [size]  px. Default 12.
 */

/**
 * @typedef {Object} CalculatorBlock
 * @property {"calculator"} type
 * @property {string} formula      Formula string (e.g., "{{q1_val}} * 50 + 100").
 * @property {string} [label]      Label text above calculated amount.
 * @property {string} [currency]   Currency symbol (e.g. "$").
 */

/**
 * @typedef {ImageBlock|VideoBlock|TextBlock|ListBlock|ReviewsBlock|CountdownBlock|TrustBlock|SpacerBlock|CalculatorBlock} ContentBlock
 */

/* ========================================================================== *
 *  Form fields
 * ========================================================================== */

/**
 * @typedef {"text"|"name"|"email"|"tel"|"textarea"|"select"|"date"|"number"|"file"|"address"|"calculation"} FieldType
 */

/**
 * A single input on a `form` step.
 *
 * @typedef {Object} FormField
 * @property {string} name           Key the value is stored under in `lead`.
 * @property {FieldType} type
 * @property {string} [label]
 * @property {string} [placeholder]
 * @property {boolean} [required]    Default false.
 * @property {string} [autocomplete] HTML autocomplete token (e.g. "email").
 * @property {Array<{ value: string, label: string }>} [options]  For `select`.
 * @property {string} [pattern]      Optional regex (string) for custom validation.
 * @property {string} [error]        Custom validation message.
 */

/* ========================================================================== *
 *  Steps (discriminated union on `type`)
 * ========================================================================== */

/**
 * Fields shared by every step.
 *
 * @typedef {Object} StepBase
 * @property {string} id               Unique within the funnel; used by `next`.
 * @property {string} [headline]       Supports answer piping.
 * @property {string} [subtext]        Supports answer piping.
 * @property {ContentBlock[]} [blocks] Rich content rendered above the interaction.
 * @property {boolean} [progress]      Per-step override of the progress bar.
 * @property {string|null} [next]      Explicit next step id. `null` = end funnel.
 * @property {string} [image]          Hero image rendered above the headline.
 * @property {string} [heroImage]      Alias for `image`; `image` wins if both set.
 */

/**
 * A single-select question. Tapping an option records the answer and
 * auto-advances (unless `autoAdvance` is false). This is the classic
 * Perspective "quiz" step.
 *
 * @typedef {StepBase & {
 *   type: "choice",
 *   options: ChoiceOption[],
 *   autoAdvance?: boolean,
 *   layout?: "list"|"grid",
 * }} ChoiceStep
 *
 * @typedef {Object} ChoiceOption
 * @property {string} id
 * @property {string} label
 * @property {string} [value]     Stored value (defaults to `label`).
 * @property {string} [icon]      Emoji or short glyph.
 * @property {string} [image]     Image url → renders as an "answer box".
 * @property {string} [subtext]
 * @property {string|null} [next] Per-option branch target.
 */

/**
 * A multi-select question. The visitor picks one or more options and taps a
 * continue button.
 *
 * @typedef {StepBase & {
 *   type: "multiselect",
 *   options: ChoiceOption[],
 *   min?: number,
 *   max?: number,
 *   submitLabel?: string,
 *   layout?: "list"|"grid",
 * }} MultiSelectStep
 */

/**
 * A contact-capture form.
 *
 * @typedef {StepBase & {
 *   type: "form",
 *   fields: FormField[],
 *   submitLabel?: string,
 *   consent?: string,
 *   verifyEmail?: boolean,
 * }} FormStep
 */

/**
 * A content / VSL / storytelling screen with a single continue CTA.
 *
 * @typedef {StepBase & {
 *   type: "content",
 *   ctaLabel?: string,
 * }} ContentStep
 */

/**
 * A "warming" loader screen: an animated progress bar with sequential
 * checkmarks that auto-advances when complete. Perspective's signature
 * conversion device ("Analysing your answers…").
 *
 * @typedef {StepBase & {
 *   type: "loader",
 *   items?: string[],
 *   durationMs?: number,
 * }} LoaderStep
 */

/**
 * Terminal thank-you screen with an external redirect.
 *
 * @typedef {StepBase & {
 *   type: "success",
 *   buttonLabel?: string,
 *   redirectUrl?: string,
 *   autoRedirectMs?: number,
 * }} SuccessStep
 */

/**
 * @typedef {ChoiceStep|MultiSelectStep|FormStep|ContentStep|LoaderStep|SuccessStep} Step
 */

/* ========================================================================== *
 *  Funnel
 * ========================================================================== */

/**
 * The complete funnel document.
 *
 * @typedef {Object} Funnel
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [slug]
 * @property {FunnelTheme} [theme]
 * @property {FunnelSettings} [settings]
 * @property {FunnelIntegrations} [integrations]
 * @property {Step[]} steps
 */

/* ========================================================================== *
 *  Runtime state & events
 * ========================================================================== */

/**
 * @typedef {"funnel_start"|"step_view"|"step_complete"|"lead"|"complete"|"abandon"} FunnelEventType
 */

/**
 * @typedef {Object} FunnelEvent
 * @property {FunnelEventType} type
 * @property {string} sessionId
 * @property {string} [funnelId]
 * @property {string} [stepId]
 * @property {number} [stepIndex]
 * @property {Record<string, unknown>} [meta]
 * @property {number} ts       Epoch ms.
 */

/**
 * Serialisable snapshot of a visitor's progress (persisted to localStorage).
 *
 * @typedef {Object} FunnelState
 * @property {string} sessionId
 * @property {number} index                     Current step index.
 * @property {string[]} history                 Visited step ids (for back nav).
 * @property {Record<string, unknown>} answers  Keyed by step id.
 * @property {Record<string, unknown>} lead     Merged form field values.
 * @property {number} startedAt
 */

/**
 * Runtime options passed to createFunnel.
 *
 * @typedef {Object} FunnelOptions
 * @property {(e: FunnelEvent) => void} [onEvent]
 * @property {string} [leadEndpoint]
 * @property {boolean} [isPreview]
 * @property {boolean} [isEditor]
 */

export {}; // keep this a module
