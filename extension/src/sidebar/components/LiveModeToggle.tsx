import React, { useState } from "react";
import { Radio, Info } from "lucide-react";
import { useAppStore } from "../stores/app-store";

const EXPLAINER =
  "Turn this on while you're on a live call. The pitch adapts to what's happening — " +
  "objections the prospect raised, priorities they mentioned — instead of starting from scratch. " +
  "Leave it off when you're prepping before the call.";

export function LiveModeToggle() {
  const { isLiveMode, setIsLiveMode } = useAppStore();
  const [showInfo, setShowInfo] = useState(false);

  return (
    <div className="relative">
      <div
        className={`w-full flex items-center justify-between px-3 py-2 border transition-colors ${
          isLiveMode
            ? "border-zop-orange/60 bg-[rgba(245,133,73,0.08)]"
            : "border-line bg-surface-1 hover:border-line-2"
        }`}
      >
        <button
          type="button"
          onClick={() => setIsLiveMode(!isLiveMode)}
          className="flex items-center gap-2 flex-1 text-left"
          aria-pressed={isLiveMode}
        >
          <Radio
            size={13}
            className={isLiveMode ? "text-zop-orange animate-pulse" : "text-ink-3"}
          />
          <span className={`text-xs font-semibold tracking-[-0.01em] ${isLiveMode ? "text-ink" : "text-ink-2"}`}>
            Live Meeting Mode
          </span>
          <span className={`text-[9px] font-mono uppercase tracking-[0.14em] ${
            isLiveMode ? "text-zop-orange" : "text-ink-4"
          }`}>
            {isLiveMode ? "ON" : "OFF"}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setShowInfo((v) => !v)}
          onBlur={() => setTimeout(() => setShowInfo(false), 120)}
          className="p-1 mr-1 text-ink-4 hover:text-ink transition-colors"
          aria-label="What is Live Meeting Mode?"
          title="What is this?"
        >
          <Info size={12} />
        </button>

        <button
          type="button"
          onClick={() => setIsLiveMode(!isLiveMode)}
          className={`relative w-8 h-4 transition-colors ${
            isLiveMode ? "bg-zop-orange" : "bg-surface-3 border border-line-2"
          }`}
          aria-label="Toggle Live Meeting Mode"
        >
          <span
            className={`absolute top-0.5 w-3 h-3 bg-zop-cream transition-all ${
              isLiveMode ? "left-[18px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {showInfo && (
        <div
          role="tooltip"
          className="absolute z-20 left-0 right-0 top-full mt-1 bg-surface-2 border border-line p-3 shadow-hover-ink"
        >
          <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-zop-orange mb-1.5">
            Live Meeting Mode
          </div>
          <p className="text-[11px] text-ink-2 leading-relaxed">{EXPLAINER}</p>
          <div className="mt-2 text-[10px] text-ink-4">
            Want live transcription and an on-call overlay? Open the{" "}
            <span className="text-ink-2 font-medium">Copilot</span> tab.
          </div>
        </div>
      )}
    </div>
  );
}
