export type ActionType = "navigate" | "click" | "type" | "scroll" | "wait" | "wait_for_mutation";

export interface PlanStep {
  action: ActionType;
  url?: string;
  aria_name?: string;
  selector_strategy?: "placeholder" | "button_text" | "aria_label" | "css" | "text";
  selector_value?: string;
  value?: string;
  scroll_amount?: number;
  reasoning: string;
}

export interface ProductProfile {
  product_name: string;
  product_category: "speech_ai" | "coding_tool" | "design_tool" | "data_tool" | "productivity" | "ecommerce" | "other";
  core_action: string;
  hero_input_placeholder: string | null;
  hero_button_text: string | null;
  hero_nav_link: string | null;
  demo_input_value: string;
  demo_wow_moment: string;
  page_sections: string[];
}

export interface InteractiveElement {
  id: string;
  name: string;
  role: string;
  aria_label: string;
  placeholder: string;
  x: number;
  y: number;
  isInput?: boolean;
}

export type PageCategory = "HERO_FEATURE" | "DASHBOARD" | "EDITOR" | "FORM" | "STATIC" | "AUTH";

export interface PageInfo {
  url: string;
  title: string;
  purpose?: string;
  demo_value?: number;
  category?: PageCategory;
  element_count?: number;
  interactive_elements?: InteractiveElement[];
}

export type Phase = "idle" | "discover" | "strategize" | "plan" | "awaiting_approval" | "execute" | "complete" | "error";

export interface JobState {
  phase: Phase;
  phaseMessage: string;
  pages: PageInfo[];
  steps: PlanStep[];
  log: LogLine[];
  videoUrl: string | null;
  error: string | null;
}

export interface LogLine {
  id: string;
  level: "info" | "success" | "warn" | "error";
  text: string;
  ts: number;
}

// SSE event shapes
export interface PhaseEvent       { phase: Phase; message: string }
export interface PageFoundEvent   { url: string; title: string; element_count: number }
export interface PageScoredEvent  { url: string; purpose: string; value: number }
export interface PlanReadyEvent   { steps: PlanStep[] }
export interface AwaitingApprovalEvent { message: string }
export interface StepStartEvent   { index: number; total: number; action: string; reasoning: string; aria_name: string; value: string }
export interface StepCompleteEvent{ index: number; success: boolean }
export interface CompleteEvent    { video_url: string | null; error?: string }
export interface ErrorEvent       { message: string }
export interface InputRequiredEvent { step_index: number; message: string; default_value: string }
