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
  videoUrl: string | null;
  jobUrl: string;
}

type Action =
  | { type: "SET_URL";          url: string }
  | { type: "PHASE";            payload: PhaseEvent }
  | { type: "PAGE_FOUND";       payload: PageFoundEvent }
  | { type: "PAGE_SCORED";      payload: PageScoredEvent }
  | { type: "PLAN_READY";       payload: PlanReadyEvent }
  | { type: "STEP_START";       payload: StepStartEvent }
  | { type: "STEP_COMPLETE";    payload: StepCompleteEvent }
  | { type: "COMPLETE";         payload: CompleteEvent }
  | { type: "ERROR";            payload: ErrorEvent }
  | { type: "LOG";              entry: LogLine };

function log(level: LogLine["level"], text: string): LogLine {
  return { id: `${Date.now()}-${Math.random()}`, level, text, ts: Date.now() };
}

const INIT: State = {
  phase: "idle",
  phaseMessage: "Connecting…",
  pages: [],
  steps: [],
  log: [],
  executingIndex: null,
  completedIndices: new Set(),
  failedIndices: new Set(),
  videoUrl: null,
  jobUrl: "",
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "SET_URL":
      return { ...s, jobUrl: a.url };

    case "PHASE":
      return {
        ...s,
        phase: a.payload.phase,
        phaseMessage: a.payload.message,
        log: [...s.log, log("info", a.payload.message)],
      };

    case "PAGE_FOUND":
      if (s.pages.some((p) => p.url === a.payload.url)) return s;
      return {
        ...s,
        pages: [...s.pages, a.payload],
        log: [...s.log, log("info", `Found: ${a.payload.title || a.payload.url}`)],
      };

    case "PAGE_SCORED": {
      const pages = s.pages.map((p) =>
        p.url === a.payload.url
          ? { ...p, purpose: a.payload.purpose, demo_value: a.payload.value }
          : p
      );
      return {
        ...s,
        pages,
        log: [...s.log, log("info", `Scored "${a.payload.url}" → ${a.payload.value}/10`)],
      };
    }

    case "PLAN_READY":
      return {
        ...s,
        phase: "awaiting_approval",
        phaseMessage: "Review your plan, then click Execute to start recording.",
        steps: a.payload.steps,
        log: [
          ...s.log,
          log("success", `Plan ready — ${a.payload.steps.length} steps. Click Execute to start.`),
        ],
      };

    case "STEP_START":
      return {
        ...s,
        executingIndex: a.payload.index,
        log: [
          ...s.log,
          log(
            "info",
            `Step ${a.payload.index + 1}/${a.payload.total}: ${a.payload.action}` +
              (a.payload.reasoning ? ` — ${a.payload.reasoning}` : "")
          ),
        ],
      };

    case "STEP_COMPLETE": {
      const completed = new Set(s.completedIndices);
      const failed    = new Set(s.failedIndices);
      completed.add(a.payload.index);
      if (!a.payload.success) failed.add(a.payload.index);
      return {
        ...s,
        executingIndex: null,
        completedIndices: completed,
        failedIndices: failed,
        log: [
          ...s.log,
          log(
            a.payload.success ? "success" : "warn",
            `Step ${a.payload.index + 1} ${a.payload.success ? "✓" : "failed (skipping)"}`
          ),
        ],
      };
    }

    case "COMPLETE":
      return {
        ...s,
        phase: "complete",
        phaseMessage: "Demo recording complete!",
        videoUrl: a.payload.video_url,
        log: [
          ...s.log,
          log("success", a.payload.video_url ? "Video ready — streaming from CDN." : "Job complete."),
        ],
      };

    case "ERROR":
      return {
        ...s,
        phase: "error",
        phaseMessage: a.payload.message,
        log: [...s.log, log("error", a.payload.message)],
      };

    case "LOG":
      return { ...s, log: [...s.log, a.entry] };

    default:
      return s;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function on<T>(
  es: EventSource,
  name: string,
  handler: (d: T) => void
) {
  es.addEventListener(name, (e: MessageEvent) => handler(JSON.parse(e.data) as T));
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function JobPage() {
  const { id: jobId } = useParams<{ id: string }>();
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, INIT);
  const [executing, setExecuting] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Fetch initial job metadata (url, existing video_url if any)
  useEffect(() => {
    fetch(`/api/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.url) dispatch({ type: "SET_URL", url: d.url });
        if (d?.video_url) dispatch({ type: "COMPLETE", payload: { video_url: d.video_url } });
        if (d?.status === "error") dispatch({ type: "ERROR", payload: { message: d.error ?? "Unknown error" } });
      });
  }, [jobId]);

  // Phase 1: connect to plan-stream automatically
  useEffect(() => {
    if (!jobId) return;
    const es = new EventSource(`/api/jobs/${jobId}/plan-stream`);
    esRef.current = es;

    on<PhaseEvent>      (es, "phase",          (d) => dispatch({ type: "PHASE",       payload: d }));
    on<PageFoundEvent>  (es, "page_found",      (d) => dispatch({ type: "PAGE_FOUND", payload: d }));
    on<PageScoredEvent> (es, "page_scored",     (d) => dispatch({ type: "PAGE_SCORED",payload: d }));
    on<PlanReadyEvent>  (es, "plan_ready",      (d) => { dispatch({ type: "PLAN_READY", payload: d }); es.close(); });
    on<ErrorEvent>      (es, "error",           (d) => { dispatch({ type: "ERROR",    payload: d }); es.close(); });

    es.addEventListener("discovering_page", (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      dispatch({ type: "LOG", entry: { id: Date.now() + "", level: "info", text: `Crawling: ${d.url}`, ts: Date.now() } });
    });

    es.onerror = () =>
      dispatch({ type: "LOG", entry: { id: Date.now() + "", level: "warn", text: "Connection interrupted — retrying…", ts: Date.now() } });

    return () => es.close();
  }, [jobId]);

  // Phase 2: user clicks "Execute Demo" → open execute-stream
  const handleExecute = useCallback(() => {
    setExecuting(true);
    dispatch({ type: "PHASE", payload: { phase: "execute", message: "Launching browser and recording…" } });

    const es = new EventSource(`/api/jobs/${jobId}/execute-stream`);
    esRef.current = es;

    on<PhaseEvent>       (es, "phase",         (d) => dispatch({ type: "PHASE",        payload: d }));
    on<StepStartEvent>   (es, "step_start",    (d) => dispatch({ type: "STEP_START",   payload: d }));
    on<StepCompleteEvent>(es, "step_complete", (d) => dispatch({ type: "STEP_COMPLETE",payload: d }));
    on<CompleteEvent>    (es, "complete",      (d) => { dispatch({ type: "COMPLETE",   payload: d }); es.close(); });
    on<ErrorEvent>       (es, "error",         (d) => { dispatch({ type: "ERROR",      payload: d }); es.close(); setExecuting(false); });

    es.onerror = () =>
      dispatch({ type: "LOG", entry: { id: Date.now() + "", level: "warn", text: "Connection interrupted — retrying…", ts: Date.now() } });
  }, [jobId]);

  const showExecuteButton =
    state.phase === "awaiting_approval" && state.steps.length > 0 && !executing;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-800/50 px-6 py-4 flex items-center gap-4">
        <button onClick={() => router.push("/")} className="btn-secondary text-xs px-3 py-1.5">
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

      {/* Body */}
      <div className="flex-1 grid lg:grid-cols-[420px_1fr] divide-x divide-zinc-800/50 overflow-hidden">
        {/* Left: Plan */}
        <div className="overflow-y-auto p-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">Demo Plan</h2>
          <PlanViewer
            pages={state.pages}
            steps={state.steps}
            executingIndex={state.executingIndex}
            completedIndices={state.completedIndices}
            failedIndices={state.failedIndices}
            showApproveButton={showExecuteButton}
            onApprove={handleExecute}
            approving={executing}
          />
        </div>

        {/* Right: Log + Video */}
        <div className="flex flex-col gap-4 p-6 overflow-y-auto">
          {state.videoUrl ? (
            <>
              <VideoPlayer videoUrl={state.videoUrl} jobId={jobId} />
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
