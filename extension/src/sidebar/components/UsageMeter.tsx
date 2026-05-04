import React, { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { getSettings, getUsage } from "../../shared/utils/settings-storage";

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  anthropic: "Claude",
  groq: "Groq",
  ollama: "Ollama",
  custom: "Custom",
};

const DAILY_CAP: Record<string, number> = {
  gemini: 1500,
  anthropic: 0,
  groq: 0,
  ollama: 0,
  custom: 0,
};

export function UsageMeter() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 4000);
    return () => window.clearInterval(id);
  }, []);

  const settings = getSettings();
  const usage = getUsage();
  const provider = settings.provider;
  const used = usage.counts[provider] || 0;
  const cap = DAILY_CAP[provider] || 0;
  const label = PROVIDER_LABEL[provider] || provider;

  const near = cap > 0 && used / cap > 0.8;
  // keep tick referenced to force re-read
  void tick;

  return (
    <div
      className={`hidden sm:flex items-center gap-1.5 px-2 py-1 border ${
        near ? "border-zop-orange text-zop-orange" : "border-line text-ink-4"
      } bg-surface-2`}
      title={cap > 0 ? `${used} of ${cap} ${label} requests today` : `${used} ${label} requests today`}
    >
      <Activity size={10} />
      <span className="font-mono text-[10px] tracking-tight">
        {label} · {used}
        {cap > 0 ? `/${cap}` : ""}
      </span>
    </div>
  );
}
