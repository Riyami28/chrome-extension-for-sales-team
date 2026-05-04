import React from "react";
import { Wand2, FileText, Presentation, FileDown } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { useGeneration } from "../hooks/useGeneration";
import type { ActionType, OutputType } from "../../shared/types";

const ACTION_OPTIONS: { value: ActionType; label: string }[] = [
  { value: "generate_new", label: "Generate full deck" },
  { value: "update_section", label: "Update section" },
  { value: "add_slide", label: "Add slide" },
  { value: "refine_content", label: "Refine content" },
];

const OUTPUT_OPTIONS: { value: OutputType; label: string; icon: React.ReactNode }[] = [
  { value: "google_slides", label: "Google Slides", icon: <Presentation size={13} /> },
  { value: "google_doc", label: "Google Doc", icon: <FileText size={13} /> },
  { value: "pdf", label: "PDF Export", icon: <FileDown size={13} /> },
];

export function ActionPanel() {
  const {
    actionType, setActionType,
    outputType, setOutputType,
    useCase, setUseCase,
    isGenerating, company,
  } = useAppStore();
  const { generate } = useGeneration();

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-3 space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide">
        <Wand2 size={12} />
        Generate
      </div>

      {/* Use case input */}
      <textarea
        value={useCase}
        onChange={(e) => setUseCase(e.target.value)}
        placeholder="Describe the use case or specific instruction... (e.g. 'cloud cost reduction for a 500-person fintech')"
        rows={3}
        className="w-full bg-slate-800 text-slate-100 placeholder-slate-500 rounded-lg px-3 py-2 text-xs outline-none border border-slate-700 focus:border-violet-500 transition-colors resize-none"
      />

      {/* Action type */}
      <div>
        <div className="text-xs text-slate-500 mb-1.5">Action</div>
        <div className="grid grid-cols-2 gap-1.5">
          {ACTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setActionType(opt.value)}
              className={`px-2 py-1.5 rounded-lg text-xs border transition-all text-left ${
                actionType === opt.value
                  ? "border-violet-500 bg-violet-500/10 text-violet-300"
                  : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Output type */}
      <div>
        <div className="text-xs text-slate-500 mb-1.5">Output format</div>
        <div className="flex gap-1.5">
          {OUTPUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setOutputType(opt.value)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all flex-1 justify-center ${
                outputType === opt.value
                  ? "border-violet-500 bg-violet-500/10 text-violet-300"
                  : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600"
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Generate button */}
      <button
        onClick={() => generate()}
        disabled={isGenerating || !company}
        className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg transition-all text-sm flex items-center justify-center gap-2"
      >
        {isGenerating ? (
          <>
            <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Generating...
          </>
        ) : (
          <>
            <Wand2 size={14} />
            Generate
          </>
        )}
      </button>

      {!company && (
        <p className="text-xs text-slate-500 text-center">Set a company above to generate</p>
      )}
    </div>
  );
}
