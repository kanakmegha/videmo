export type ActionType = "navigate" | "click" | "type" | "scroll" | "wait";

export interface PlanStep {
  action: ActionType;
  url?: string;
  aria_name?: string;
  value?: string;
  reasoning: string;
}

export interface PageInfo {
  url: string;
  title: string;
  purpose?: string;
  demo_value?: number;
  element_count?: number;
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
export interface CompleteEvent    { video_path: string | null; error?: string }
export interface ErrorEvent       { message: string }
