/**
 * Public type surface for @openfunnel/engine.
 * Mirrors the JSDoc typedefs in src/types.js for TypeScript consumers.
 */

export type ColorMode = "light" | "dark";

export interface FunnelTheme {
  primary?: string;
  primaryText?: string;
  bg?: string;
  surface?: string;
  text?: string;
  muted?: string;
  border?: string;
  radius?: string;
  font?: string;
  mode?: ColorMode;
}

export interface FunnelSettings {
  showProgress?: boolean;
  allowBack?: boolean;
  persist?: boolean;
  enableSwipe?: boolean;
  transition?: "slide" | "fade" | "none";
}

export interface FunnelIntegrations {
  metaPixelId?: string;
  gtmId?: string;
  ga4Id?: string;
  leadEndpoint?: string;
}

export type ImageBlock = { type: "image"; src: string; alt?: string; fit?: "cover" | "contain"; aspect?: string };
export type VideoBlock = { type: "video"; src: string; poster?: string; autoplay?: boolean; controls?: boolean };

export type ContentBlock =
  | ImageBlock
  | VideoBlock
  | { type: "text"; value: string; size?: "sm" | "md" | "lg"; align?: "left" | "center" }
  | { type: "list"; items: Array<{ icon?: string; text: string }> }
  | { type: "reviews"; items: Array<{ name: string; text: string; avatar?: string; rating?: number }> }
  | { type: "countdown"; minutes: number; label?: string }
  /** A bare string is accepted as shorthand for `{ label }`. */
  | { type: "trust"; items: Array<{ src?: string; label?: string } | string> }
  | { type: "spacer"; size?: number }
  | { type: "calculator"; formula: string; label?: string; currency?: string }
  /* Landing-page sections — ordinary blocks, so any step type can use them. */
  | { type: "heading"; value: string; eyebrow?: string; sub?: string; align?: "left" | "center" }
  | {
      type: "features";
      columns?: 1 | 2 | 3;
      items: Array<{ icon?: string; image?: string; title: string; text?: string }>;
    }
  | { type: "steps"; items: Array<{ title: string; text?: string }> }
  | { type: "stats"; columns?: 2 | 3; items: Array<{ value: string; label?: string }> }
  | { type: "faq"; items: Array<{ q: string; a: string }> }
  | {
      type: "pricing";
      plans: Array<{
        name: string;
        price: string;
        period?: string;
        badge?: string;
        features?: string[];
        ctaLabel?: string;
        highlight?: boolean;
        next?: string | null;
      }>;
    }
  | {
      type: "gallery";
      layout?: "scroll" | "grid";
      items: Array<{ src: string; alt?: string; caption?: string }>;
    }
  | { type: "compare"; left: { title: string; items: string[] }; right: { title: string; items: string[] } }
  | { type: "quote"; text: string; name?: string; role?: string; avatar?: string; rating?: number }
  | { type: "cta"; label?: string; note?: string; url?: string; next?: string | null; variant?: "solid" | "outline" }
  | { type: "divider"; label?: string };

export type FieldType =
  | "text" | "name" | "email" | "tel" | "textarea" | "select" | "date" | "number" | "file"
  | "address";

export interface FormField {
  name: string;
  type: FieldType;
  label?: string;
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
  options?: Array<{ value: string; label: string }>;
  pattern?: string;
  error?: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
  value?: string;
  icon?: string;
  image?: string;
  subtext?: string;
  badge?: string;
  next?: string | null;
}

interface StepBase {
  id: string;
  headline?: string;
  subtext?: string;
  blocks?: ContentBlock[];
  progress?: boolean;
  next?: string | null;
  image?: string;
  /** Alias for `image`; `image` wins if both are set. */
  heroImage?: string;
}

export type ChoiceStep = StepBase & {
  type: "choice";
  options: ChoiceOption[];
  autoAdvance?: boolean;
  layout?: "list" | "grid" | "grid3";
};
export type MultiSelectStep = StepBase & {
  type: "multiselect";
  options: ChoiceOption[];
  min?: number;
  max?: number;
  submitLabel?: string;
  layout?: "list" | "grid" | "grid3";
};
export type FormStep = StepBase & { type: "form"; fields: FormField[]; submitLabel?: string; consent?: string };
export type ContentStep = StepBase & { type: "content"; ctaLabel?: string };
export type LoaderStep = StepBase & { type: "loader"; items?: string[]; durationMs?: number };
export type SuccessStep = StepBase & {
  type: "success";
  buttonLabel?: string;
  redirectUrl?: string;
  autoRedirectMs?: number;
};

export interface LandingLink {
  label: string;
  href?: string;
}

/** With neither `url` nor `next`, the button simply advances the funnel. */
export interface LandingCta {
  label?: string;
  note?: string;
  icon?: string;
  url?: string;
  next?: string | null;
  variant?: "solid" | "outline" | "ghost";
}

export interface LandingBackground {
  image?: string;
  video?: string;
  color?: string;
  gradient?: string;
  /** 0–1 scrim over media. Default 0.45. */
  overlay?: number;
  blur?: number;
  ink?: "light" | "dark";
  position?: string;
}

export interface LandingNav {
  logo?: string;
  brand?: string;
  links?: LandingLink[];
  ctaLabel?: string;
}

export interface LandingProof {
  avatars?: string[];
  rating?: number;
  text?: string;
}

export interface LandingFooter {
  text?: string;
  links?: LandingLink[];
}

/**
 * A full marketing page rendered as a funnel step. It owns its whole screen —
 * the shared step header is not drawn for it, and `blocks` is the page body
 * below the hero rather than content above an interaction.
 */
export type LandingStep = StepBase & {
  type: "landing";
  layout?: "centered" | "left" | "split" | "fullBleed" | "minimal";
  height?: "auto" | "tall" | "full";
  /** "wide" breaks the 9:16 phone frame on desktop. */
  width?: "phone" | "wide";
  eyebrow?: string;
  media?: ImageBlock | VideoBlock;
  background?: LandingBackground;
  nav?: LandingNav;
  cta?: LandingCta;
  secondaryCta?: LandingCta;
  stickyCta?: boolean;
  scrollHint?: boolean;
  proof?: LandingProof;
  footer?: LandingFooter;
};

export type Step =
  | ChoiceStep
  | MultiSelectStep
  | FormStep
  | ContentStep
  | LandingStep
  | LoaderStep
  | SuccessStep;

/**
 * Visitor consent for third-party data sharing. On the funnel document rather
 * than a console setting, because the funnel page is rendered for visitors from
 * this JSON. Enabling it gates the browser pixels, the server's Meta CAPI
 * forward, and the theme webfont; lead capture is deliberately not gated.
 */
export interface FunnelConsent {
  enabled?: boolean;
  text?: string;
  acceptLabel?: string;
  declineLabel?: string;
  policyUrl?: string;
}

/** "Powered by OpenFunnel" footer. Shown unless `hidden` is set. */
export interface FunnelBranding {
  hidden?: boolean;
}

export interface Funnel {
  id?: string;
  name?: string;
  slug?: string;
  theme?: FunnelTheme;
  settings?: FunnelSettings;
  integrations?: FunnelIntegrations;
  consent?: FunnelConsent;
  branding?: FunnelBranding;
  steps: Step[];
}

export type FunnelEventType =
  | "funnel_start" | "step_view" | "step_complete" | "lead" | "complete" | "abandon";

export interface FunnelEvent {
  type: FunnelEventType;
  sessionId: string;
  funnelId?: string;
  stepId?: string;
  stepIndex?: number;
  meta?: Record<string, unknown>;
  ts: number;
}

export interface FunnelOptions {
  onEvent?: (event: FunnelEvent) => void;
  trackEvents?: boolean;
  eventEndpoint?: string;
  leadEndpoint?: string;
  resume?: boolean;
  /** Suppresses analytics. Set by the builder preview, never from a URL param. */
  isPreview?: boolean;
  /** Enables in-canvas editing affordances. Builder-only. */
  isEditor?: boolean;
  stepIndex?: number;
  /** Suppress the "Powered by OpenFunnel" footer for this mount. */
  hideBranding?: boolean;
}

export declare class Controller {
  constructor(container: HTMLElement, funnel: Funnel, options?: FunnelOptions);
  readonly data: { lead: Record<string, unknown>; answers: Record<string, unknown> };
  mount(): this;
  destroy(): void;
  updateFunnel(funnel: Funnel, stepIndex?: number): void;
  goToStep(indexOrId: number | string): void;
  answer(value: unknown, branch: { optionId?: string; next?: string | null }): void;
  submitForm(values: Record<string, unknown>): void;
  advance(branch?: { next?: string | null }): void;
  back(): void;
  redirect(url: string | undefined): void;
  /** Repaint the current step in place, without touching index or history. */
  refresh(): void;
}

export declare function createFunnel(
  container: HTMLElement,
  funnel: Funnel,
  options?: FunnelOptions,
): Controller;

export declare function firePixel(
  eventName: FunnelEventType,
  payload: Record<string, unknown>,
  integrations?: FunnelIntegrations,
): void;
export declare function installPixels(integrations?: FunnelIntegrations): void;

/* ----- consent -------------------------------------------------------------
 * An embedder that mounts the engine itself is responsible for the same gate the
 * Controller applies: check `marketingAllowed` before firing anything outward.
 */
export type ConsentDecision = "granted" | "denied";
export declare function consentRequired(funnel: Funnel): boolean;
export declare function marketingAllowed(funnel: Funnel, key: string): boolean;
export declare function readDecision(key: string): ConsentDecision | null;
export declare function writeDecision(key: string, decision: ConsentDecision): void;

export declare function submitLead(
  lead: Record<string, unknown>,
  answers: Record<string, unknown>,
  ctx?: { endpoint?: string; funnelId?: string; sessionId?: string; meta?: Record<string, unknown> },
): Promise<boolean>;
export declare function trackEvent(event: FunnelEvent, ctx?: { endpoint?: string }): void;
export declare function validateField(field: FormField, raw: unknown): string;
export declare function validateForm(
  fields: FormField[],
  values: Record<string, unknown>,
): Record<string, string>;
export declare function pipe(
  template: string | undefined | null,
  data: { lead?: Record<string, unknown>; answers?: Record<string, unknown> },
): string;
