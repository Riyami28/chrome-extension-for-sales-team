import React, { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { SettingsPanel } from "./SettingsPanel";
import { UsageMeter } from "./UsageMeter";
import { AdminGate } from "./AdminGate";
import { isAdminUnlocked } from "../../shared/utils/settings-storage";

interface OpenEventDetail {
  source?: string;
}

export function Header() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);

  function requestOpenSettings() {
    if (isAdminUnlocked()) {
      setSettingsOpen(true);
    } else {
      setGateOpen(true);
    }
  }

  useEffect(() => {
    function openFromElsewhere(e: Event) {
      const detail = (e as CustomEvent<OpenEventDetail>).detail;
      void detail;
      requestOpenSettings();
    }
    window.addEventListener("clientlens:open-settings", openFromElsewhere);
    return () => window.removeEventListener("clientlens:open-settings", openFromElsewhere);
  }, []);

  return (
    <>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-line bg-surface-1">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-zop-orange flex items-center justify-center">
            <span className="text-[11px] font-bold text-zop-black font-mono">CL</span>
          </div>
          <div className="flex flex-col leading-none">
            <span className="font-semibold text-ink text-[13px] tracking-[-0.02em]">ClientLens</span>
            <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-ink-4 mt-0.5">
              Sales Copilot
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <UsageMeter />
          <button
            onClick={requestOpenSettings}
            className="p-1.5 text-ink-3 hover:text-zop-orange hover:bg-surface-2 transition-colors"
            title="Settings — admin passcode required"
            aria-label="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      <AdminGate
        open={gateOpen}
        onClose={() => setGateOpen(false)}
        onUnlock={() => { setGateOpen(false); setSettingsOpen(true); }}
      />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

export function openSettings() {
  window.dispatchEvent(new CustomEvent("clientlens:open-settings"));
}
