"use client";

import { Globe, Zap, ListChecks, Play, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import type { Phase } from "@/lib/types";

const PHASES: { id: Phase; label: string; icon: React.ElementType }[] = [
  { id: "discover",          label: "Discover",  icon: Globe        },
  { id: "strategize",        label: "Analyse",   icon: Zap          },
  { id: "plan",              label: "Plan",      icon: ListChecks   },
  { id: "awaiting_approval", label: "Review",    icon: ListChecks   },
  { id: "execute",           label: "Execute",   icon: Play         },
  { id: "complete",          label: "Done",      icon: CheckCircle2 },
];

const PHASE_ORDER: Phase[] = [
  "idle", "discover", "strategize", "plan", "awaiting_approval", "execute", "complete",
];

function phaseIndex(p: Phase): number {
  return PHASE_ORDER.indexOf(p);
}

interface Props {
  phase: Phase;
  message: string;
}

export default function PhaseIndicator({ phase, message }: Props) {
  const current = phaseIndex(phase);
  const isError = phase === "error";

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-red-400 text-sm">
        <AlertCircle className="w-4 h-4 shrink-0" />
        <span>{message || "An error occurred."}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Step pills */}
      <div className="flex items-center gap-1 flex-wrap">
        {PHASES.filter(p => p.id !== "awaiting_approval").map((p, i) => {
          const idx = phaseIndex(p.id);
          const done    = current > idx;
          const active  = current === idx || (p.id === "plan" && phase === "awaiting_approval");
          const Icon    = p.icon;

          return (
            <div key={p.id} className="flex items-center gap-1">
              <div
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all
                  ${done   ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                  : active ? "bg-brand-500/15 text-brand-400 border border-brand-500/30"
                            : "bg-zinc-800/60 text-zinc-500 border border-zinc-700/50"}`}
              >
                {active && !done ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Icon className="w-3 h-3" />
                )}
                {p.label}
              </div>
              {i < PHASES.filter(x => x.id !== "awaiting_approval").length - 1 && (
                <div className={`w-4 h-px ${done ? "bg-emerald-500/40" : "bg-zinc-700"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Current message */}
      {message && (
        <p className="text-xs text-zinc-400 flex items-center gap-1.5">
          {phase !== "complete" && <Loader2 className="w-3 h-3 animate-spin text-brand-400 shrink-0" />}
          {message}
        </p>
      )}
    </div>
  );
}
