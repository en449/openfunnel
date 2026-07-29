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

export type ContentBlock =
  | { type: "image"; src: string; alt?: string; fit?: "cover" | "contain"; aspect?: string }
  | { type: "video"; src: string; poster?: string; autoplay?: boolean; controls?: boolean }
  | { type: "text"; value: string; size?: "sm" | "md" | "lg"; align?: "left" | "center" }
  | { type: "list"; items: Array<{ icon?: string; text: string }> }
  | { type: "reviews"; items: Array<{ name: string; text: string; avatar?: string; rating?: number }> }
  | { type: "countdown"; minutes: number; label?: string }
  | { type: "trust"; items: Array<{ src?: string; label?: string }> }
  | { type: "spacer"; size?: number };

export type FieldType =
  | "text" | "name" | "email" | "tel" | "textarea" | "select" | "date" | "number" | "file";

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
  next?: string | null;
}

interface StepBase {
  id: string;
  headline?: string;
  subtext?: string;
  blocks?: ContentBlock[];
  progress?: boolean;
  next?: string | null;
}

export type ChoiceStep = StepBase & {
  type: "choice";
  options: ChoiceOption[];
  autoAdvance?: boolean;
  layout?: "list" | "grid";
};
export type MultiSelectStep = StepBase & {
  type: "multiselect";
  options: ChoiceOption[];
  min?: number;
  max?: number;
  submitLabel?: string;
  layout?: "list" | "grid";
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

export type Step = ChoiceStep | MultiSelectStep | FormStep | ContentStep | LoaderStep | SuccessStep;

export interface Funnel {
  id?: string;
  name?: string;
  slug?: string;
  theme?: FunnelTheme;
  settings?: FunnelSettings;
  integrations?: FunnelIntegrations;
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
}

export declare class Controller {
  constructor(container: HTMLElement, funnel: Funnel, options?: FunnelOptions);
  readonly data: { lead: Record<string, unknown>; answers: Record<string, unknown> };
  mount(): this;
  destroy(): void;
  answer(value: unknown, branch: { optionId?: string; next?: string | null }): void;
  submitForm(values: Record<string, unknown>): void;
  advance(branch?: { next?: string | null }): void;
  back(): void;
  redirect(url: string | undefined): void;
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
