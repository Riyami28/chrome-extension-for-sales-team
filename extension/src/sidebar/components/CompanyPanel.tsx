import React, { useState } from "react";
import { Building2, RefreshCw, Check } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { usePageContext } from "../hooks/usePageContext";

export function CompanyPanel() {
  const { company, setCompany } = useAppStore();
  const { detectContext } = usePageContext();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(company?.name ?? "");

  function handleManualSet() {
    if (!input.trim()) return;
    setCompany({ name: input.trim(), detected_from: "manual" });
    setEditing(false);
  }

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide">
          <Building2 size={12} />
          Company Context
        </div>
        <button
          onClick={detectContext}
          className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-slate-300 transition-colors"
          title="Re-detect from page"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {company && !editing ? (
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-slate-100">{company.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              {company.industry && <span>{company.industry} · </span>}
              <span className="capitalize">{company.detected_from ?? "manual"}</span>
            </div>
          </div>
          <button
            onClick={() => { setInput(company.name); setEditing(true); }}
            className="text-xs text-violet-400 hover:text-violet-300"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleManualSet()}
            placeholder="Enter company name..."
            className="flex-1 bg-slate-800 text-slate-100 placeholder-slate-500 rounded-lg px-3 py-2 text-sm outline-none border border-slate-700 focus:border-violet-500 transition-colors"
            autoFocus
          />
          <button
            onClick={handleManualSet}
            className="p-2 bg-violet-600 hover:bg-violet-500 rounded-lg transition-colors"
          >
            <Check size={14} className="text-white" />
          </button>
        </div>
      )}
    </div>
  );
}
