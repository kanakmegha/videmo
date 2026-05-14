"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import type { LogLine } from "@/lib/types";

const LEVEL_STYLE: Record<string, string> = {
  info:    "text-zinc-400",
  success: "text-emerald-400",
  warn:    "text-amber-400",
  error:   "text-red-400",
};

const LEVEL_PREFIX: Record<string, string> = {
  info:    "›",
  success: "✓",
  warn:    "⚠",
  error:   "✗",
};

interface Props {
  lines: LogLine[];
}

export default function ExecutionLog({ lines }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  return (
    <div className="glass rounded-2xl flex flex-col h-full min-h-[300px]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
        <Terminal className="w-4 h-4 text-zinc-500" />
        <span className="text-xs font-medium text-zinc-400">Live Log</span>
        <span className="ml-auto text-xs text-zinc-600">{lines.length} events</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 font-mono space-y-1 text-xs">
        {lines.length === 0 ? (
          <span className="text-zinc-600 italic">Waiting for agent to start…</span>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`log-line animate-fade-in ${LEVEL_STYLE[line.level]}`}>
              <span className="shrink-0 text-zinc-600 tabular-nums">
                {new Date(line.ts).toISOString().slice(11, 19)}
              </span>
              <span className="shrink-0">{LEVEL_PREFIX[line.level]}</span>
              <span className="flex-1 break-all whitespace-pre-wrap">{line.text}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
