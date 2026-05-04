import React from "react";
import { Search } from "lucide-react";
import type { ResearchBrief } from "../../shared/types";

export function ResearchBriefCard({ brief }: { brief: ResearchBrief }) {
  return (
    <div className="bg-cyan-900/20 border border-cyan-700/40 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-1.5">
        <Search size={12} className="text-cyan-400" />
        <span className="text-[10px] uppercase tracking-wide text-cyan-300">Research brief</span>
      </div>
      <p className="text-xs text-slate-100">{brief.one_liner}</p>

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        {brief.industry && <Field label="Industry" value={brief.industry} />}
        {brief.size_signal && <Field label="Size" value={brief.size_signal} />}
      </div>

      {brief.tech_signals.length > 0 && <ChipRow label="Tech" items={brief.tech_signals} />}
      {brief.named_customers.length > 0 && <ChipRow label="Customers" items={brief.named_customers} />}
      {brief.pain_signals.length > 0 && <ChipRow label="Pains" items={brief.pain_signals} />}
      {brief.recent_signals.length > 0 && <ChipRow label="Recent" items={brief.recent_signals} />}

      {brief.raw_sources.length > 0 && (
        <p className="text-[9px] text-slate-500">
          Sourced from: {brief.raw_sources.map((s) => s.url).join(", ")}
        </p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-slate-200">{value}</div>
    </div>
  );
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1">
        {items.slice(0, 8).map((t, i) => (
          <span key={i} className="px-1.5 py-0.5 rounded bg-slate-900/60 border border-slate-800 text-[10px] text-slate-300">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
