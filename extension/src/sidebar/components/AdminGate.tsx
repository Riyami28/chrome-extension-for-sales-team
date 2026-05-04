import React, { useEffect, useRef, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { hasAdminPasscode, setAdminPasscode, verifyAdminPasscode } from "../../shared/utils/settings-storage";

interface Props {
  open: boolean;
  onUnlock: () => void;
  onClose: () => void;
}

type Mode = "set" | "verify";

export function AdminGate({ open, onUnlock, onClose }: Props) {
  const [mode, setMode] = useState<Mode>(() => (hasAdminPasscode() ? "verify" : "set"));
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setMode(hasAdminPasscode() ? "verify" : "set");
    setPass("");
    setConfirm("");
    setError(null);
    setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === "set") {
        if (pass.length < 4) { setError("Passcode must be at least 4 characters."); return; }
        if (pass !== confirm) { setError("Passcodes don't match."); return; }
        await setAdminPasscode(pass);
        onUnlock();
      } else {
        const ok = await verifyAdminPasscode(pass);
        if (!ok) { setError("Wrong passcode."); return; }
        onUnlock();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[10000] bg-black/70 flex items-start justify-center pt-24">
      <div className="w-[320px] bg-surface-1 border border-line shadow-xl">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
          {mode === "set" ? <ShieldCheck size={14} className="text-zop-orange" /> : <Lock size={14} className="text-zop-orange" />}
          <span className="text-[12px] font-semibold text-ink">
            {mode === "set" ? "Set admin passcode" : "Admin access required"}
          </span>
        </div>
        <form onSubmit={handleSubmit} className="p-3 space-y-2">
          <p className="text-[11px] text-ink-3 leading-relaxed">
            {mode === "set"
              ? "Settings are gated behind an admin passcode. Set one now — you'll need it to change providers, API keys, or integrations later."
              : "Enter the admin passcode to open Settings."}
          </p>
          <input
            ref={inputRef}
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Passcode"
            autoComplete="off"
            spellCheck={false}
            className="w-full border border-line bg-surface-0 px-2.5 py-1.5 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
          />
          {mode === "set" && (
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm passcode"
              autoComplete="off"
              spellCheck={false}
              className="w-full border border-line bg-surface-0 px-2.5 py-1.5 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
            />
          )}
          {error && <div className="text-[11px] text-red-400">{error}</div>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-2.5 py-1 text-[11px] text-ink-3 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1 text-[11px] font-semibold bg-zop-orange text-zop-black hover:brightness-110 disabled:opacity-50"
            >
              {mode === "set" ? "Set & unlock" : "Unlock"}
            </button>
          </div>
          {mode === "verify" && (
            <div className="text-[10px] text-ink-4 pt-1 border-t border-line mt-2">
              Forgot the code? Clear <span className="font-mono">clientlens_admin_hash_v1</span> in
              DevTools → Application → Local Storage, then reopen Settings to set a new one.
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
