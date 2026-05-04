import React, { useState } from "react";
import { Copy, ArrowLeft, CheckCircle2, Mail, AlertTriangle } from "lucide-react";
import { useAppStore } from "../stores/app-store";

export function EmailResult() {
  const { lastEmail, setLastEmail } = useAppStore();
  const [copied, setCopied] = useState<"subject" | "body" | "full" | null>(null);

  if (!lastEmail) return null;
  const { final_output, agents, metadata } = lastEmail;

  async function copy(kind: "subject" | "body" | "full", text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  function openGmailCompose() {
    const subject = encodeURIComponent(final_output.subject);
    const body = encodeURIComponent(`${final_output.body}\n\n${final_output.cta}`);
    const url = `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`;
    chrome.tabs.create({ url });
  }

  const validation = agents.find((a) => a.agent === "validation");
  const brand = agents.find((a) => a.agent === "brand_compliance");

  return (
    <div className="space-y-3">
      <button
        onClick={() => setLastEmail(null)}
        className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
      >
        <ArrowLeft size={12} /> Draft another
      </button>

      <div className="flex items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${metadata.brand_compliant ? "bg-emerald-900/40 text-emerald-300" : "bg-amber-900/40 text-amber-300"}`}>
          <CheckCircle2 size={10} /> Brand {brand?.status ?? "?"}
        </span>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${validation?.status === "pass" ? "bg-emerald-900/40 text-emerald-300" : "bg-amber-900/40 text-amber-300"}`}>
          <CheckCircle2 size={10} /> Facts {validation?.status ?? "?"}
        </span>
      </div>

      {validation?.issues?.length ? (
        <div className="flex items-start gap-2 bg-amber-900/30 border border-amber-700/50 rounded-lg px-3 py-2">
          <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-amber-200 space-y-1">
            <p className="font-medium">Validation flagged:</p>
            {validation.issues.slice(0, 3).map((i, idx) => (
              <p key={idx}>• {i}</p>
            ))}
          </div>
        </div>
      ) : null}

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Subject</span>
          <button onClick={() => copy("subject", final_output.subject)} className="text-[10px] text-slate-400 hover:text-slate-200 flex items-center gap-1">
            <Copy size={10} /> {copied === "subject" ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-sm text-slate-100 font-medium">{final_output.subject}</p>
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Body</span>
          <button onClick={() => copy("body", final_output.body)} className="text-[10px] text-slate-400 hover:text-slate-200 flex items-center gap-1">
            <Copy size={10} /> {copied === "body" ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">{final_output.body}</p>
        {final_output.cta && (
          <>
            <div className="border-t border-slate-800 pt-2 mt-2">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">CTA</span>
              <p className="text-xs text-slate-200 mt-1">{final_output.cta}</p>
            </div>
          </>
        )}
      </div>

      {final_output.tone_notes && (
        <p className="text-[10px] text-slate-500 italic">Why this hits: {final_output.tone_notes}</p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => copy("full", `${final_output.subject}\n\n${final_output.body}\n\n${final_output.cta}`)}
          className="py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 flex items-center justify-center gap-1.5"
        >
          <Copy size={12} /> {copied === "full" ? "Copied" : "Copy all"}
        </button>
        <button
          onClick={openGmailCompose}
          className="py-2 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-500 text-white flex items-center justify-center gap-1.5"
        >
          <Mail size={12} /> Open in Gmail
        </button>
      </div>
    </div>
  );
}
