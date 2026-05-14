"use client";

import { Globe, MousePointer2, Keyboard, ArrowDown, Clock, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { PlanStep, PageInfo } from "@/lib/types";

// ── Action type metadata ──────────────────────────────────────────────────────

const ACTION_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  navigate: { label: "Navigate",  icon: Globe,         color: "text-sky-400 bg-sky-400/10 border-sky-400/20" },
  click:    { label: "Click",     icon: MousePointer2, color: "text-violet-400 bg-violet-400/10 border-violet-400/20" },
  type:     { label: "Type",      icon: Keyboard,      color: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
  scroll:   { label: "Scroll",    icon: ArrowDown,     color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
  wait:     { label: "Wait",      icon: Clock,         color: "text-zinc-400 bg-zinc-400/10 border-zinc-700" },
};

// ── Step Card ─────────────────────────────────────────────────────────────────

interface StepCardProps {
  step: PlanStep;
  index: number;
  total: number;
  executingIndex: number | null;
  completedIndices: Set<number>;
  failedIndices: Set<number>;
}

function StepCard({ step, index, executingIndex, completedIndices, failedIndices }: StepCardProps) {
  const meta = ACTION_META[step.action] ?? ACTION_META.navigate;
  const Icon = meta.icon;
  const isExecuting = executingIndex === index;
  const isDone = completedIndices.has(index);
  const isFailed = failedIndices.has(index);

  return (
    <div
      className={`step-card transition-all duration-300 ${
        isExecuting ? "ring-1 ring-brand-500/40 border-brand-500/30" :
        isDone      ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Index */}
        <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500 shrink-0 mt-0.5">
          {isDone ? (
            <CheckCircle2 className={`w-4 h-4 ${isFailed ? "text-red-400" : "text-emerald-400"}`} />
          ) : isExecuting ? (
            <Loader2 className="w-3.5 h-3.5 text-brand-400 animate-spin" />
          ) : (
            <span>{index + 1}</span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`badge border ${meta.color} text-xs`}>
              <Icon className="w-3 h-3" />
              {meta.label}
            </span>
            {step.aria_name && (
              <span className="text-xs text-zinc-400 font-mono truncate max-w-[160px]">
                "{step.aria_name}"
              </span>
            )}
            {step.value && step.action === "type" && (
              <span className="text-xs text-amber-300/80 font-mono truncate max-w-[180px]">
                ↦ "{step.value}"
              </span>
            )}
          </div>

          {/* Reasoning */}
          <p className="text-xs text-zinc-400 leading-relaxed">{step.reasoning}</p>

          {/* URL for navigate */}
          {step.url && step.action === "navigate" && (
            <p className="text-xs text-zinc-600 font-mono mt-1 truncate">{step.url}</p>
          )}
        </div>

        {/* Status icon */}
        {isFailed && <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />}
      </div>
    </div>
  );
}

// ── Page Card ─────────────────────────────────────────────────────────────────

function PageCard({ page }: { page: PageInfo }) {
  return (
    <div className="glass rounded-xl p-3 animate-fade-in">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium truncate">{page.title || page.url}</p>
          {page.purpose && (
            <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{page.purpose}</p>
          )}
          <p className="text-xs text-zinc-600 font-mono mt-1 truncate">{page.url}</p>
        </div>
        {page.demo_value !== undefined && page.demo_value > 0 && (
          <div className="shrink-0 flex flex-col items-end gap-0.5">
            <span className="text-xs text-zinc-500">demo value</span>
            <div className="flex gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className={`w-2 h-2 rounded-sm ${
                    i < Math.round(page.demo_value! / 2)
                      ? "bg-brand-500"
                      : "bg-zinc-700"
                  }`}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main PlanViewer ───────────────────────────────────────────────────────────

interface Props {
  pages: PageInfo[];
  steps: PlanStep[];
  executingIndex: number | null;
  completedIndices: Set<number>;
  failedIndices: Set<number>;
  showApproveButton: boolean;
  onApprove: () => void;
  approving: boolean;
}

export default function PlanViewer({
  pages,
  steps,
  executingIndex,
  completedIndices,
  failedIndices,
  showApproveButton,
  onApprove,
  approving,
}: Props) {
  return (
    <div className="space-y-6">
      {/* Discovered pages */}
      {pages.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            Discovered Pages ({pages.length})
          </h3>
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {pages.map((p) => (
              <PageCard key={p.url} page={p} />
            ))}
          </div>
        </div>
      )}

      {/* Plan steps */}
      {steps.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            Demo Plan ({steps.length} steps)
          </h3>
          <div className="space-y-2">
            {steps.map((step, i) => (
              <StepCard
                key={i}
                step={step}
                index={i}
                total={steps.length}
                executingIndex={executingIndex}
                completedIndices={completedIndices}
                failedIndices={failedIndices}
              />
            ))}
          </div>

          {showApproveButton && (
            <button
              onClick={onApprove}
              disabled={approving}
              className="btn-primary w-full justify-center mt-4"
            >
              {approving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Starting recording…
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Execute Demo
                </>
              )}
            </button>
          )}
        </div>
      )}

      {pages.length === 0 && steps.length === 0 && (
        <div className="text-xs text-zinc-500 italic">Waiting for agent…</div>
      )}
    </div>
  );
}

function Play(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
