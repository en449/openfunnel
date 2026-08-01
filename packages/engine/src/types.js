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

/* -------------------------------------------------------------------------- *
 *  Landing-page section blocks
 *
 *  These are ordinary content blocks — usable on any step — but they exist for
 *  the `landing` step, where `step.blocks` is the page body below the hero.
 *  Everything a marketing page needs to say something before the first question
 *  is asked lives here, so a landing page needs no new step-level fields to grow
 *  a new section: add a block type and every step gains it at once.
 * -------------------------------------------------------------------------- */

/**
 * @typedef {Object} HeadingBlock  Section title, for breaking a long page up.
 * @property {"heading"} type
 * @property {string} value        Supports answer piping.
 * @property {string} [eyebrow]    Small label above the title.
 * @property {string} [sub]        Supporting line below the title.
 * @property {"left"|"center"} [align]
 */
/**
 * @typedef {Object} FeaturesBlock  Benefit / feature cards.
 * @property {"features"} type
 * @property {1|2|3} [columns]     Default 1 (stacked rows).
 * @property {Array<{ icon?: string, image?: string, title: string, text?: string }>} items
 */
/**
 * @typedef {Object} StepsBlock  Numbered "how it works" sequence.
 * @property {"steps"} type
 * @property {Array<{ title: string, text?: string }>} items
 */
/**
 * @typedef {Object} StatsBlock  Row of headline numbers.
 * @property {"stats"} type
 * @property {2|3} [columns]       Default 3.
 * @property {Array<{ value: string, label?: string }>} items
 */
/**
 * @typedef {Object} FaqBlock  Objection handling, one `<details>` per item.
 * @property {"faq"} type
 * @property {Array<{ q: string, a: string }>} items
 */
/**
 * @typedef {Object} PricingBlock
 * @property {"pricing"} type
 * @property {Array<{ name: string, price: string, period?: string, badge?: string,
 *                    features?: string[], ctaLabel?: string, highlight?: boolean,
 *                    next?: string|null }>} plans
 */
/**
 * @typedef {Object} GalleryBlock  Before/after shots, screenshots, product photos.
 * @property {"gallery"} type
 * @property {"scroll"|"grid"} [layout]  Default "scroll" (horizontal snap).
 * @property {Array<{ src: string, alt?: string, caption?: string }>} items
 */
/**
 * @typedef {Object} CompareBlock  Two-column "us vs them" list.
 * @property {"compare"} type
 * @property {{ title: string, items: string[] }} left    Rendered with ✕ marks.
 * @property {{ title: string, items: string[] }} right   Rendered with ✓ marks.
 */
/**
 * @typedef {Object} QuoteBlock  Single large pull quote.
 * @property {"quote"} type
 * @property {string} text
 * @property {string} [name]
 * @property {string} [role]
 * @property {string} [avatar]
 * @property {number} [rating]
 */
/**
 * @typedef {Object} CtaBlock  Mid-page call to action. Advances the funnel, so a
 *                             long landing page can convert without scrolling back.
 * @property {"cta"} type
 * @property {string} [label]
 * @property {string} [note]
 * @property {string} [url]        External link instead of advancing.
 * @property {string|null} [next]  Branch target when advancing.
 * @property {"solid"|"outline"} [variant]
 */
/**
 * @typedef {Object} DividerBlock
 * @property {"divider"} type
 * @property {string} [label]      Optional centred caption on the rule.
 */

/**
 * @typedef {ImageBlock|VideoBlock|TextBlock|ListBlock|ReviewsBlock|CountdownBlock|TrustBlock|SpacerBlock|CalculatorBlock|HeadingBlock|FeaturesBlock|StepsBlock|StatsBlock|FaqBlock|PricingBlock|GalleryBlock|CompareBlock|QuoteBlock|CtaBlock|DividerBlock} ContentBlock
 */

/* ========================================================================== *
 *  Form fields
 * ========================================================================== */

/**
 * Every member must have an entry in `FIELD_HTML` in `render/form.js`, or a
 * funnel using it renders nothing. (`"calculation"` was listed here with no
 * renderer — removed rather than left as a trap.)
 *
 * @typedef {"text"|"name"|"email"|"tel"|"textarea"|"select"|"date"|"number"|"file"|"address"} FieldType
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
 * @property {"left"|"center"|"right"} [align] Headline & header text alignment.
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
 *   layout?: "list"|"grid"|"grid3",
 * }} ChoiceStep
 *
 * @typedef {Object} ChoiceOption
 * @property {string} id
 * @property {string} label
 * @property {string} [value]     Stored value (defaults to `label`).
 * @property {string} [icon]      Emoji or short glyph.
 * @property {string} [image]     Image url → renders as an "answer box".
 * @property {string} [subtext]
 * @property {string} [badge]     Highlight tag (e.g. "Popular").
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

/* -------------------------------------------------------------------------- *
 *  Landing page
 * -------------------------------------------------------------------------- */

/** @typedef {{ label: string, href?: string }} LandingLink */

/**
 * A button on a landing page. With neither `url` nor `next` it simply advances
 * the funnel, which is the common case: the landing page is step 1 and the CTA
 * starts the quiz.
 *
 * @typedef {Object} LandingCta
 * @property {string} [label]
 * @property {string} [note]           Microcopy under the button ("Takes 60 seconds").
 * @property {string} [icon]           Leading glyph.
 * @property {string} [url]            Navigate away instead of advancing.
 * @property {string|null} [next]      Branch target when advancing.
 * @property {"solid"|"outline"|"ghost"} [variant]  Default "solid".
 */

/**
 * Hero backdrop. `image`/`video` sit behind a scrim so the headline stays
 * readable; `color`/`gradient` are used raw. A CSS gradient string is taken
 * verbatim, which is why `ink` exists — the engine cannot know whether an
 * operator's gradient is light or dark.
 *
 * @typedef {Object} LandingBackground
 * @property {string} [image]
 * @property {string} [video]          Muted, looping, autoplaying background video.
 * @property {string} [color]
 * @property {string} [gradient]       Full CSS value, e.g. "linear-gradient(...)".
 * @property {number} [overlay]        0–1 scrim over media. Default 0.45.
 * @property {number} [blur]           px blur applied to the media.
 * @property {"light"|"dark"} [ink]    Text colour over the backdrop. Default
 *                                     "light" (white text) when media is set.
 * @property {string} [position]       CSS object-position, e.g. "50% 20%".
 */

/**
 * @typedef {Object} LandingNav
 * @property {string} [logo]           Logo image url.
 * @property {string} [brand]          Wordmark text, shown when there is no logo.
 * @property {LandingLink[]} [links]
 * @property {string} [ctaLabel]       Nav button — advances like the hero CTA.
 */

/**
 * @typedef {Object} LandingProof  Social proof strip under the CTA.
 * @property {string[]} [avatars]      Face pile image urls.
 * @property {number} [rating]         0–5, drawn as stars.
 * @property {string} [text]           e.g. "Joined by 12,480 homeowners".
 */

/**
 * @typedef {Object} LandingFooter
 * @property {string} [text]
 * @property {LandingLink[]} [links]   Imprint / privacy, as paid traffic requires.
 */

/**
 * A full marketing page rendered as a funnel step — the thing a cold ad click
 * lands on before it is asked anything. Its CTAs advance into the quiz, so a
 * funnel is "landing page + questions" without a second system.
 *
 * Unlike every other step type this one owns its whole screen: `render/index.js`
 * does not draw the shared header for it, and `step.blocks` is the page body
 * below the hero rather than content above an interaction.
 *
 * @typedef {StepBase & {
 *   type: "landing",
 *   layout?: "centered"|"left"|"split"|"fullBleed"|"minimal",
 *   height?: "auto"|"tall"|"full",
 *   width?: "phone"|"wide",
 *   eyebrow?: string,
 *   media?: ImageBlock|VideoBlock,
 *   background?: LandingBackground,
 *   nav?: LandingNav,
 *   cta?: LandingCta,
 *   secondaryCta?: LandingCta,
 *   stickyCta?: boolean,
 *   scrollHint?: boolean,
 *   proof?: LandingProof,
 *   footer?: LandingFooter,
 * }} LandingStep
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
 * @typedef {ChoiceStep|MultiSelectStep|FormStep|ContentStep|LandingStep|LoaderStep|SuccessStep} Step
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
 * @property {FunnelConsent} [consent]
 * @property {FunnelBranding} [branding]
 * @property {Step[]} steps
 */

/**
 * "Powered by OpenFunnel" footer. On the funnel document rather than a console
 * setting for the usual reason: a per-browser localStorage value cannot reach a
 * visitor. `Controller.mount` also honours the `of.branding.hidden` key and the
 * `hideBranding` option, so the operator's own preview matches what ships.
 *
 * @typedef {Object} FunnelBranding
 * @property {boolean} [hidden]  Suppress the footer. Shown by default.
 */

/**
 * Visitor consent for third-party data sharing. Lives on the funnel document
 * because the funnel page is rendered for visitors from this JSON — a per-browser
 * console setting could never reach them. See `consent.js` for what it gates.
 *
 * @typedef {Object} FunnelConsent
 * @property {boolean} [enabled]       Show the consent bar. Off by default.
 * @property {string} [text]           Bar copy. A sensible default is used if unset.
 * @property {string} [acceptLabel]
 * @property {string} [declineLabel]
 * @property {string} [policyUrl]      Optional link to your privacy policy.
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
 * @property {number} [stepIndex]
 */

export {}; // keep this a module
