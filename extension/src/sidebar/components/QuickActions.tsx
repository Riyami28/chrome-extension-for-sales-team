import React from "react";
import { Zap } from "lucide-react";
import { useGeneration } from "../hooks/useGeneration";
import { useAppStore } from "../stores/app-store";
import { ICP_QUICK_ACTIONS } from "../../shared/constants/icp-profiles";

export function QuickActions() {
  const { isGenerating } = useAppStore();
  const { quickAction } = useGeneration();

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
        <Zap size={12} />
        Quick Actions
      </div>

      <div className="flex flex-wrap gap-1.5">
        {ICP_QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => quickAction(action.action, (action as { target_icp?: string }).target_icp)}
            disabled={isGenerating}
            className="px-2.5 py-1.5 text-xs bg-slate-800 border border-slate-700 hover:border-violet-500/50 hover:bg-violet-900/20 hover:text-violet-300 text-slate-300 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
