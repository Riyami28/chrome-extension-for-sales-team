import React, { useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { useEmailCouncil } from "../hooks/useEmailCouncil";
import type { EmailIntent, DealSizeBand } from "../../shared/types";

const INTENTS: { id: EmailIntent; label: string; hint: string }[] = [
  { id: "intro", label: "Intro", hint: "Cold outreach" },
  { id: "follow_up", label: "Follow-up", hint: "Nudge after silence" },
  { id: "post_call", label: "Post-call", hint: "Recap + next steps" },
  { id: "objection", label: "Objection", hint: "Handle a concern" },
  { id: "close", label: "Close", hint: "Push to pilot/contract" },
  { id: "custom", label: "Custom", hint: "Your own instruction" },
];

export function EmailForm() {
  const { emailInput, setEmailInput, isGenerating } = useAppStore();
  const { run } = useEmailCouncil();

  const [recipient, setRecipient] = useState(emailInput?.recipient_name ?? "");
  const [company, setCompany] = useState(emailInput?.company_name ?? "");
  const [persona, setPersona] = useState(emailInput?.persona_role ?? "");
  const [intent, setIntent] = useState<EmailIntent>(emailInput?.intent ?? "intro");
  const [context, setContext] = useState(emailInput?.context ?? "");
  const [thread, setThread] = useState(emailInput?.thread_excerpt ?? "");
  const [dealSize, setDealSize] = useState<DealSizeBand | "">(emailInput?.deal_size ?? "");
  const [competitor, setCompetitor] = useState(emailInput?.competitor ?? "");
  const [custom, setCustom] = useState(emailInput?.custom_instruction ?? "");

  const canSubmit = recipient.trim() && company.trim() && persona.trim() && context.trim() && !isGenerating;

  async function handleSubmit() {
    setEmailInput({
      recipient_name: recipient.trim(),
      company_name: company.trim(),
      persona_role: persona.trim(),
      intent,
      context: context.trim(),
      thread_excerpt: thread.trim() || undefined,
      deal_size: (dealSize || undefined) as DealSizeBand | undefined,
      competitor: competitor.trim() || undefined,
      custom_instruction: custom.trim() || undefined,
    });
    await run();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-violet-400" />
        <h2 className="text-sm font-semibold text-slate-100">Draft a grounded email</h2>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Recipient name</span>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Priya Sharma" className="input" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Company</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Ltd" className="input" />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-slate-400">Role / title</span>
        <input value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="CFO" className="input" />
      </label>

      <div className="space-y-1">
        <span className="text-xs text-slate-400">Intent</span>
        <div className="grid grid-cols-3 gap-1.5">
          {INTENTS.map((i) => (
            <button
              key={i.id}
              onClick={() => setIntent(i.id)}
              title={i.hint}
              className={`py-1.5 px-2 rounded-md text-[11px] font-medium transition-colors border ${
                intent === i.id
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-slate-400">Context — what happened / what you want</span>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Met at KubeCon last week. They're on AWS, big spend, CFO wants to cut 20%."
          rows={3}
          className="input resize-none"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-slate-400">Thread excerpt <span className="text-slate-500">(optional)</span></span>
        <textarea
          value={thread}
          onChange={(e) => setThread(e.target.value)}
          placeholder="Paste their last message if replying"
          rows={2}
          className="input resize-none"
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Deal size</span>
          <select value={dealSize} onChange={(e) => setDealSize(e.target.value as DealSizeBand | "")} className="input">
            <option value="">—</option>
            <option value="lt_100k">&lt; $100k</option>
            <option value="100k_1m">$100k–$1M</option>
            <option value="gt_1m">&gt; $1M</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Competitor</span>
          <input value={competitor} onChange={(e) => setCompetitor(e.target.value)} placeholder="cast.ai" className="input" />
        </label>
      </div>

      {intent === "custom" && (
        <label className="block space-y-1">
          <span className="text-xs text-slate-400">Custom instruction</span>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Ask for a 15-min slot next week" className="input" />
        </label>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
      >
        <Send size={14} /> Draft email
      </button>
    </div>
  );
}
