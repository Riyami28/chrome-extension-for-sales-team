import React, { useEffect, useState } from "react";
import { Shield, Copy, ArrowLeft, Zap, AlertTriangle } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { useObjection } from "../hooks/useObjection";
import type { ObjectionInput } from "../../shared/types";

export function ObjectionPanel() {
  const {
    objectionInput,
    setObjectionInput,
    lastObjection,
    setLastObjection,
    isGenerating,
  } = useAppStore();
  const { run } = useObjection();

  const [text, setText] = useState(objectionInput?.objection_text ?? "");
  const [competitor, setCompetitor] = useState(objectionInput?.competitor_hint ?? "");
  const [copied, setCopied] = useState(false);

  // Pick up context-menu captures routed via chrome.storage.session.
  useEffect(() => {
    chrome.storage.session.get("pending_objection").then((data) => {
      const pending = data.pending_objection as ObjectionInput | undefined;
      if (pending?.objection_text) {
        setText(pending.objection_text);
        setObjectionInput(pending);
        chrome.storage.session.remove("pending_objection");
      }
    });

    const handler = (message: { type: string; payload?: ObjectionInput }) => {
      if (message.type === "OBJECTION_CAPTURE" && message.payload?.objection_text) {
        setText(message.payload.objection_text);
        setObjectionInput(message.payload);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [setObjectionInput]);

  async function handleSubmit() {
    if (!text.trim()) return;
    setObjectionInput({
      objection_text: text.trim(),
      competitor_hint: competitor.trim() || undefined,
      source_url: objectionInput?.source_url,
      source_title: objectionInput?.source_title,
    });
    await run();
  }

  async function copyResponse() {
    if (!lastObjection) return;
    await navigator.clipboard.writeText(lastObjection.response);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (lastObjection) {
    return (
      <div className="space-y-3">
        <button onClick={() => setLastObjection(null)} className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
          <ArrowLeft size={12} /> New objection
        </button>

        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 space-y-2">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Objection</span>
          <p className="text-xs text-slate-400 italic">"{objectionInput?.objection_text}"</p>
        </div>

        <div className="bg-violet-900/20 border border-violet-700/40 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-violet-300">Grounded response</span>
            <span className="text-[10px] text-slate-400">conf {Math.round(lastObjection.confidence * 100)}%</span>
          </div>
          {lastObjection.summary && (
            <p className="text-[11px] text-slate-400 italic">{lastObjection.summary}</p>
          )}
          <p className="text-xs text-slate-100 whitespace-pre-wrap leading-relaxed">{lastObjection.response}</p>
        </div>

        {lastObjection.citations.length > 0 && (
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 space-y-1.5">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Citations ({lastObjection.citations.length})</span>
            {lastObjection.citations.slice(0, 4).map((c, i) => (
              <p key={i} className="text-[10px] text-slate-400">
                <span className="text-slate-500">{c.source_id}:</span> "{c.quote}"
              </p>
            ))}
          </div>
        )}

        <button onClick={copyResponse} className="w-full py-2 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white flex items-center justify-center gap-1.5">
          <Copy size={12} /> {copied ? "Copied" : "Copy response"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-violet-400" />
        <h2 className="text-sm font-semibold text-slate-100">Handle an objection</h2>
      </div>

      <p className="text-[11px] text-slate-500">
        Paste the prospect's objection, or right-click any selected text on a page and pick
        <span className="text-slate-300"> "ClientLens: Handle objection"</span>.
      </p>

      {objectionInput?.source_url && (
        <div className="flex items-start gap-2 bg-slate-900/60 border border-slate-800 rounded px-3 py-2">
          <AlertTriangle size={11} className="text-cyan-400 mt-0.5 shrink-0" />
          <p className="text-[10px] text-slate-400 truncate">
            Captured from: <span className="text-slate-300">{objectionInput.source_title || objectionInput.source_url}</span>
          </p>
        </div>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-slate-400">Objection</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='e.g. "Cast.ai already does this. Why pay again?"'
          rows={4}
          className="input resize-none"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-slate-400">Competitor hint <span className="text-slate-500">(optional)</span></span>
        <input value={competitor} onChange={(e) => setCompetitor(e.target.value)} placeholder="cast.ai" className="input" />
      </label>

      <button
        onClick={handleSubmit}
        disabled={!text.trim() || isGenerating}
        className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
      >
        <Zap size={14} /> Get grounded response
      </button>
    </div>
  );
}
