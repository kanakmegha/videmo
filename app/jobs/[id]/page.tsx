"use client";

import { useEffect, useReducer, useCallback, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Globe } from "lucide-react";
import type {
  Phase, PlanStep, PageInfo, LogLine,
  PhaseEvent, PageFoundEvent, PageScoredEvent, PlanReadyEvent,
  StepStartEvent, StepCompleteEvent, CompleteEvent, ErrorEvent,
} from "@/lib/types";
import PhaseIndicator from "@/components/phase-indicator";
import PlanViewer from "@/components/plan-viewer";
import ExecutionLog from "@/components/execution-log";
import VideoPlayer from "@/components/video-player";

// ── State ─────────────────────────────────────────────────────────────────────

interface State {
  phase: Phase;
  phaseMessage: string;
  pages: PageInfo[];
  steps: PlanStep[];
  log: LogLine[];
  executingIndex: number | null;
  completedIndices: Set<number>;
  failedIndices: Set<number>;
  videoReady: boolean;
  error: string | null;
  jobUrl: string;
}

type Action =
  | { type: "PHASE";            payload: PhaseEvent }
  | { type: "PAGE_FOUND";       payload: PageFoundEvent }
  | { type: "PAGE_SCORED";      payload: PageScoredEvent }
  | { type: "PLAN_READY";       payload: PlanReadyEvent }
  | { type: "AWAITING_APPROVAL" }
  | { type: "STEP_START";       payload: StepStartEvent }
  | { type: "STEP_COMPLETE";    payload: StepCompleteEvent }
  | { type: "COMPLETE";         payload: CompleteEvent }
  | { type: "ERROR";            payload: ErrorEvent }
  | { type: "LOG";              entry: LogLine }
  | { type: "SET_JOB_URL";      url: string };

function makeLog(level: LogLine["level"], text: string): LogLine {
  return { id: `${Date.now()}-${Math.random()}`, level, text, ts: Date.now() };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_JOB_URL":
      return { ...state, jobUrl: action.url };

    case "PHASE":
      return {
        ...state,
        phase: action.payload.phase,
        phaseMessage: action.payload.message,
        log: [...state.log, makeLog("info", action.payload.message)],
      };

    case "PAGE_FOUND": {
      const existing = state.pages.find(p => p.url === action.payload.url);
      if (existing) return state;
      return {
        ...state,
        pages: [...state.pages, action.payload],
        log: [...state.log, makeLog("info", `Found: ${action.payload.title} (${action.payload.url})`)],
      };
    }

    case "PAGE_SCORED": {
      const updated = state.pages.map(p =>
        p.url === action.payload.url
          ? { ...p, purpose: action.payload.purpose, demo_value: action.payload.value }
          : p
      );
      return {
        ...state,
        pages: updated,
        log: [...state.log, makeLog("info", `Scored "${action.payload.url}" → ${action.payload.value}/10: ${action.payload.purpose}`)],
      };
    }

    case "PLAN_READY":
      return {
        ...state,
        steps: action.payload.steps,
        log: [...state.log, makeLog("success", `Plan ready — ${action.payload.steps.length} steps generated.`)],
      };

    case "AWAITING_APPROVAL":
      return {
        ...state,
        phase: "awaiting_approval",
        phaseMessage: "Review your plan and click Execute to start.",
        log: [...state.log, makeLog("info", "Awaiting your approval to start recording…")],
      };

    case "STEP_START":
      return {
        ...state,
        executingIndex: action.payload.index,
        log: [
          ...state.log,
          makeLog(
            "info",
            `Step ${action.payload.index + 1}/${action.payload.total}: ${action.payload.action}` +
              (action.payload.reasoning ? ` — ${action.payload.reasoning}` : "")
          ),
        ],
      };

    case "STEP_COMPLETE": {
      const newCompleted = new Set(state.completedIndices);
      const newFailed = new Set(state.failedIndices);
      newCompleted.add(action.payload.index);
      if (!action.payload.success) newFailed.add(action.payload.index);
      return {
        ...state,
        executingIndex: null,
        completedIndices: newCompleted,
        failedIndices: newFailed,
        log: [
          ...state.log,
          makeLog(
            action.payload.success ? "success" : "warn",
            `Step ${action.payload.index + 1} ${action.payload.success ? "completed" : "failed (skipping)"}`
          ),
        ],
      };
    }

    case "COMPLETE":
      return {
        ...state,
        phase: "complete",
        phaseMessage: "Demo recording complete!",
        videoReady: Boolean(action.payload.video_path),
        log: [
          ...state.log,
          makeLog("success", action.payload.video_path ? "Video saved. Ready to download!" : "Job complete."),
        ],
      };

    case "ERROR":
      return {
        ...state,
        phase: "error",
        phaseMessage: action.payload.message,
        error: action.payload.message,
        log: [...state.log, makeLog("error", action.payload.message)],
      };

    case "LOG":
      return { ...state, log: [...state.log, action.entry] };

    default:
      return state;
  }
}

const INITIAL_STATE: State = {
  phase: "idle",
  phaseMessage: "Connecting…",
  pages: [],
  steps: [],
  log: [],
  executingIndex: null,
  completedIndices: new Set(),
  failedIndices: new Set(),
  videoReady: false,
  error: null,
  jobUrl: "",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function JobPage() {
  const { id: jobId } = useParams<{ id: string }>();
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [approving, setApproving] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Fetch initial job info
  useEffect(() => {
    fetch(`/api/jobs/${jobId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.url) dispatch({ type: "SET_JOB_URL", url: data.url });
      })
      .catch(() => {});
  }, [jobId]);

  // Connect to SSE stream
  useEffect(() => {
    if (!jobId) return;

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    esRef.current = es;

    const on = (eventName: string, handler: (data: unknown) => void) =>
      es.addEventListener(eventName, (e: MessageEvent) => handler(JSON.parse(e.data)));

    on("phase",             d => dispatch({ type: "PHASE",         payload: d as PhaseEvent }));
    on("page_found",        d => dispatch({ type: "PAGE_FOUND",    payload: d as PageFoundEvent }));
    on("page_scored",       d => dispatch({ type: "PAGE_SCORED",   payload: d as PageScoredEvent }));
    on("plan_ready",        d => dispatch({ type: "PLAN_READY",    payload: d as PlanReadyEvent }));
    on("awaiting_approval", () => dispatch({ type: "AWAITING_APPROVAL" }));
    on("step_start",        d => dispatch({ type: "STEP_START",    payload: d as StepStartEvent }));
    on("step_complete",     d => dispatch({ type: "STEP_COMPLETE", payload: d as StepCompleteEvent }));
    on("complete",          d => dispatch({ type: "COMPLETE",      payload: d as CompleteEvent }));
    on("error",             d => dispatch({ type: "ERROR",         payload: d as ErrorEvent }));

    on("discovering_page",  d => dispatch({ type: "LOG", entry: makeLog("info", `Crawling: ${(d as { url: string }).url}`) }));
    on("plan_fallback",     () => dispatch({ type: "LOG", entry: makeLog("warn", "LLM plan failed — using fallback plan.") }));
    on("score_error",       d => dispatch({ type: "LOG", entry: makeLog("warn", `Could not score: ${(d as { url: string }).url}`) }));

    es.onerror = () =>
      dispatch({ type: "LOG", entry: makeLog("warn", "SSE connection interrupted.") });

    return () => es.close();
  }, [jobId]);

  const handleApprove = useCallback(async () => {
    setApproving(true);
    try {
      await fetch(`/api/jobs/${jobId}/approve`, { method: "POST" });
      dispatch({ type: "LOG", entry: makeLog("success", "Approval sent — starting execution…") });
    } catch {
      dispatch({ type: "LOG", entry: makeLog("error", "Failed to send approval. Please try again.") });
      setApproving(false);
    }
  }, [jobId]);

  const showApproveButton =
    state.phase === "awaiting_approval" && state.steps.length > 0 && !approving;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar */}
      <header className="border-b border-zinc-800/50 px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => router.push("/")}
          className="btn-secondary text-xs px-3 py-1.5"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </button>

        <div className="flex items-center gap-2 min-w-0">
          <Globe className="w-4 h-4 text-zinc-500 shrink-0" />
          <span className="text-sm text-zinc-300 truncate font-mono">
            {state.jobUrl || "Loading…"}
          </span>
        </div>

        <div className="ml-auto shrink-0">
          <PhaseIndicator phase={state.phase} message={state.phaseMessage} />
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 grid lg:grid-cols-[420px_1fr] divide-x divide-zinc-800/50 overflow-hidden">
        {/* Left panel: Plan */}
        <div className="overflow-y-auto p-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">Demo Plan</h2>
          <PlanViewer
            pages={state.pages}
            steps={state.steps}
            executingIndex={state.executingIndex}
            completedIndices={state.completedIndices}
            failedIndices={state.failedIndices}
            showApproveButton={showApproveButton}
            onApprove={handleApprove}
            approving={approving}
          />
        </div>

        {/* Right panel: Log + Video */}
        <div className="flex flex-col gap-4 p-6 overflow-y-auto">
          {state.videoReady ? (
            <>
              <VideoPlayer jobId={jobId} />
              <ExecutionLog lines={state.log} />
            </>
          ) : (
            <div className="flex-1 flex flex-col">
              <ExecutionLog lines={state.log} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
