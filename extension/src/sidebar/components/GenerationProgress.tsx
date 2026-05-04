import React from "react";
import type { GenerationProgress as ProgressType } from "../stores/app-store";

const STAGE_ICONS: Record<string, string> = {
  retrieval: "🔍",
  brand_check: "🎨",
  icp_personalize: "👤",
  validation: "✅",
  generating: "⚡",
  done: "🎉",
};

const AGENT_LABELS: Record<string, string> = {
  retrieval: "Agent 1: Retrieving context",
  brand_check: "Agent 2: Brand compliance check",
  icp_personalize: "Agent 3: ICP personalization",
  validation: "Agent 4: Fact-check & validate",
  generating: "Assembling final output",
  done: "Complete",
};

interface Props {
  progress: ProgressType;
}

export function GenerationProgress({ progress }: Props) {
  const stages = ["retrieval", "brand_check", "icp_personalize", "validation", "generating", "done"];
  const currentIndex = stages.indexOf(progress.stage);

  return (
    <div className="bg-slate-900 rounded-xl border border-violet-500/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-violet-300">Multi-Agent Pipeline</span>
        <span className="text-xs text-slate-500">{progress.percent}%</span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-violet-500 rounded-full transition-all duration-500"
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      {/* Stage list */}
      <div className="space-y-1.5">
        {stages.slice(0, -1).map((stage, i) => {
          const status = i < currentIndex ? "done" : i === currentIndex ? "active" : "pending";
          return (
            <div key={stage} className="flex items-center gap-2">
              <span className={`text-sm ${status === "active" ? "animate-pulse" : ""}`}>
                {status === "done" ? "✅" : status === "active" ? STAGE_ICONS[stage] : "⬜"}
              </span>
              <span className={`text-xs ${
                status === "done" ? "text-slate-500 line-through" :
                status === "active" ? "text-violet-300 font-medium" :
                "text-slate-600"
              }`}>
                {AGENT_LABELS[stage]}
              </span>
              {status === "active" && (
                <span className="w-3 h-3 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin ml-auto" />
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-slate-400 italic">{progress.message}</p>
    </div>
  );
}
