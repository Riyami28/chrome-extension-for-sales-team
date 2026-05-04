import React, { useEffect, useRef, useState } from "react";
import { Cpu, ChevronDown, Sparkles, Gem } from "lucide-react";
import { MODEL_CATALOG, getStoredModel, setStoredModel } from "../../shared/agents/model-catalog";
import { resolveLLMConfig } from "../../shared/agents/llm-client";

export function ModelPicker() {
  const [open, setOpen] = useState(false);
  const [_, force] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const stored = getStoredModel();
  const cfg = resolveLLMConfig(stored ?? undefined);
  const ok = !("error" in cfg);
  const activeProvider = ok ? cfg.provider : null;
  const activeModel = ok ? cfg.model : null;
  const activeOption =
    MODEL_CATALOG.find((m) => m.provider === activeProvider && m.model === activeModel) ??
    MODEL_CATALOG.find((m) => m.provider === activeProvider);
  const label = activeOption?.label ?? (ok ? `${cfg.provider} · ${cfg.model}` : "no model");

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function pick(provider: typeof MODEL_CATALOG[number]["provider"], model: string) {
    setStoredModel({ provider, model });
    force((n) => n + 1);
    setOpen(false);
  }

  const free = MODEL_CATALOG.filter((m) => m.tier === "free");
  const premium = MODEL_CATALOG.filter((m) => m.tier === "premium");

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={ok ? `Active LLM: ${cfg.provider} · ${cfg.model}` : (cfg as { error: string }).error}
        className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
          ok
            ? "border-cyan-700/50 bg-cyan-900/20 text-cyan-300 hover:bg-cyan-900/40"
            : "border-red-700/50 bg-red-900/20 text-red-300 hover:bg-red-900/40"
        }`}
      >
        <Cpu size={10} />
        <span className="max-w-[110px] truncate">{label}</span>
        <ChevronDown size={9} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl z-50 overflow-hidden">
          <Section title="Free / Cheap" icon={<Sparkles size={10} className="text-emerald-400" />} />
          {free.map((m) => (
            <ModelRow
              key={`${m.provider}-${m.model}`}
              option={m}
              active={m.provider === activeProvider && m.model === activeModel}
              onClick={() => pick(m.provider, m.model)}
            />
          ))}
          <Section title="Premium" icon={<Gem size={10} className="text-violet-400" />} />
          {premium.map((m) => (
            <ModelRow
              key={`${m.provider}-${m.model}`}
              option={m}
              active={m.provider === activeProvider && m.model === activeModel}
              onClick={() => pick(m.provider, m.model)}
            />
          ))}
          <div className="px-2 py-1.5 text-[9px] text-slate-500 border-t border-slate-800 leading-tight">
            Reload not required. Selection persists across sessions.
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-800/40">
      {icon}
      {title}
    </div>
  );
}

function ModelRow({
  option,
  active,
  onClick,
}: {
  option: typeof MODEL_CATALOG[number];
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 transition-colors ${
        active ? "bg-cyan-900/30" : "hover:bg-slate-800"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-medium ${active ? "text-cyan-300" : "text-slate-200"}`}>
          {option.label}
        </span>
        <span className="text-[9px] font-mono text-slate-500 uppercase">{option.provider}</span>
      </div>
      <div className="text-[9px] text-slate-500 mt-0.5">{option.note}</div>
    </button>
  );
}
