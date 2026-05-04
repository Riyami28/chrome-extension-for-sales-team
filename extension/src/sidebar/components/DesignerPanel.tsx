import React, { useEffect, useState } from "react";
import { Palette, Upload, Lock, FileText, Trash2, Check } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { addKB, listKB, removeKB } from "../../shared/utils/kb-storage";
import type { KBEntry, KBNamespace } from "../../shared/types";

const PARSEABLE = [".md", ".markdown", ".txt", ".json", ".csv"];
const ACCEPT = ".md,.markdown,.txt,.json,.csv";

export function DesignerPanel() {
  const { user } = useAppStore();
  const isDesigner = user?.role === "designer" || user?.role === "admin";
  const isPMM = user?.role === "pmm" || user?.role === "admin";

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-3 space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide">
        <Palette size={12} />
        Content Management
      </div>

      <NamespaceUploader
        title="Design System"
        namespace="design_system"
        accent="violet"
        canEdit={!!isDesigner}
        deniedMsg="Only Designers can update the Design System"
      />

      <NamespaceUploader
        title="Brand Voice & Tone"
        namespace="brand_voice"
        accent="green"
        canEdit={!!isPMM}
        deniedMsg="Only PMMs can update Brand Voice & Tone"
      />
    </div>
  );
}

function NamespaceUploader({
  title,
  namespace,
  accent,
  canEdit,
  deniedMsg,
}: {
  title: string;
  namespace: KBNamespace;
  accent: "violet" | "green";
  canEdit: boolean;
  deniedMsg: string;
}) {
  const { user } = useAppStore();
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [paste, setPaste] = useState("");
  const [pasteName, setPasteName] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [entries, setEntries] = useState<KBEntry[]>([]);

  const accentBorder = accent === "violet" ? "border-violet-700/50 bg-violet-900/10" : "border-green-700/50 bg-green-900/10";
  const accentBtn = accent === "violet" ? "bg-violet-600 hover:bg-violet-500" : "bg-green-700 hover:bg-green-600";

  useEffect(() => {
    listKB().then((all) => setEntries(all.filter((e) => e.namespace === namespace)));
  }, [namespace, flash]);

  async function clearNamespace() {
    const all = await listKB();
    for (const e of all.filter((x) => x.namespace === namespace)) {
      await removeKB(e.id);
    }
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length || !user) return;
    setBusy(true);
    await clearNamespace();
    for (const file of files) {
      const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
      const parseable = PARSEABLE.includes(ext);
      const content = parseable ? await file.text() : "";
      await addKB({
        id: crypto.randomUUID(),
        name: file.name,
        namespace,
        source_type: "file",
        content,
        file_type: ext,
        file_size: file.size,
        status: parseable ? "ready" : "pending_parse",
        status_reason: parseable ? undefined : `${ext.toUpperCase()} requires backend extraction`,
        uploaded_by: user.email,
        uploaded_by_role: user.role,
        uploaded_at: new Date().toISOString(),
      });
    }
    e.target.value = "";
    setFlash(`Replaced — ${files.length} file${files.length > 1 ? "s" : ""}`);
    setTimeout(() => setFlash(null), 2000);
    setBusy(false);
  }

  async function handlePaste() {
    if (!user || !paste.trim() || !pasteName.trim()) return;
    setBusy(true);
    await clearNamespace();
    await addKB({
      id: crypto.randomUUID(),
      name: pasteName.trim(),
      namespace,
      source_type: "text",
      content: paste,
      status: "ready",
      uploaded_by: user.email,
      uploaded_by_role: user.role,
      uploaded_at: new Date().toISOString(),
    });
    setPaste("");
    setPasteName("");
    setFlash("Replaced — pasted content");
    setTimeout(() => setFlash(null), 2000);
    setBusy(false);
  }

  async function handleRemove(id: string) {
    await removeKB(id);
    setFlash(" ");
    setTimeout(() => setFlash(null), 50);
  }

  return (
    <div className={`p-2.5 rounded-lg border ${canEdit ? accentBorder : "border-slate-800 bg-slate-800/30 opacity-60"}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-slate-300">{title}</span>
        {!canEdit && <Lock size={11} className="text-slate-600" />}
      </div>

      {!canEdit ? (
        <p className="text-xs text-slate-600">{deniedMsg}</p>
      ) : (
        <>
          <div className="flex gap-1 bg-slate-800/50 rounded-md p-0.5 mb-2">
            <button
              onClick={() => setMode("file")}
              className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors ${
                mode === "file" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Upload files
            </button>
            <button
              onClick={() => setMode("paste")}
              className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors ${
                mode === "paste" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Paste content
            </button>
          </div>

          {mode === "file" ? (
            <label className="block">
              <input
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={handleFiles}
                disabled={busy}
              />
              <div className={`flex items-center justify-center gap-1.5 px-2.5 py-2 ${accentBtn} text-white text-xs rounded-lg transition-colors cursor-pointer`}>
                <Upload size={11} />
                {busy ? "Replacing…" : "Upload & Replace"}
              </div>
              <span className="block text-[10px] text-slate-500 mt-1">
                .md / .markdown / .txt / .json / .csv — replaces existing
              </span>
            </label>
          ) : (
            <div className="space-y-1.5">
              <input
                type="text"
                value={pasteName}
                onChange={(e) => setPasteName(e.target.value)}
                placeholder="Name (e.g. Brand Voice v2)"
                className="input text-xs py-1.5"
              />
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={`Paste ${title.toLowerCase()} markdown / text here…`}
                rows={4}
                className="input text-xs resize-none"
              />
              <button
                onClick={handlePaste}
                disabled={!paste.trim() || !pasteName.trim() || busy}
                className={`w-full py-1.5 ${accentBtn} disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1.5`}
              >
                <FileText size={11} />
                {busy ? "Replacing…" : "Save & Replace"}
              </button>
            </div>
          )}

          {flash && flash.trim() && (
            <p className="text-[11px] text-emerald-400 mt-1.5 flex items-center gap-1">
              <Check size={11} /> {flash}
            </p>
          )}

          {entries.length > 0 && (
            <ul className="mt-2 pt-2 border-t border-slate-800/60 space-y-1">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-[11px] text-slate-300">
                  <FileText size={10} className="text-slate-500 shrink-0" />
                  <span className="flex-1 truncate">{e.name}</span>
                  <button
                    onClick={() => handleRemove(e.id)}
                    className="text-slate-500 hover:text-red-400"
                    aria-label="Remove"
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
