import React from "react";
import { FileText, Shield } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import type { OutputMode } from "../../shared/types";

// Email mode removed from the Generate Pitch surface per product direction.
// Draft-from-scratch emails now live outside this flow.
const MODES: { id: OutputMode; label: string; icon: React.ReactNode }[] = [
  { id: "pitch", label: "Pitch", icon: <FileText size={12} /> },
  { id: "objection", label: "Objection", icon: <Shield size={12} /> },
];

export function ModeSwitcher() {
  const { outputMode, setOutputMode } = useAppStore();
  return (
    <div className="flex gap-1 bg-[#0E0E12] border border-[#2A2A34] p-1">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => setOutputMode(m.id)}
          className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium transition-colors ${
            outputMode === m.id
              ? "bg-[#F58549] text-[#0A0A0A]"
              : "text-[#A8A195] hover:text-[#F0EBDB]"
          }`}
        >
          {m.icon}
          {m.label}
        </button>
      ))}
    </div>
  );
}
