import React from "react";
import { Users } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { ICP_PROFILES } from "../../shared/constants/icp-profiles";
import type { ICPRole } from "../../shared/types";

const ROLE_ICONS: Record<string, string> = {
  cfo: "💰", cto: "⚙️", coo: "🔄",
  vp_sales: "📈", vp_engineering: "🛠️", ceo: "🎯",
  procurement: "📋", custom: "✏️",
};

export function ICPSelector() {
  const { icpRole, setIcpRole } = useAppStore();

  const selected = ICP_PROFILES.find((p) => p.role === icpRole);

  return (
    <div className="border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4 mb-2">
        <Users size={12} />
        ICP Profile
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {ICP_PROFILES.map((profile) => {
          const active = icpRole === profile.role;
          return (
            <button
              key={profile.role}
              type="button"
              onClick={() => setIcpRole(profile.role as ICPRole)}
              className={`flex flex-col items-center gap-1 p-2 border text-center transition-colors ${
                active
                  ? "border-zop-orange bg-zop-orange/10 text-zop-orange"
                  : "border-line bg-surface-2 text-ink-3 hover:border-line-2 hover:text-ink"
              }`}
            >
              <span className="text-base">{ROLE_ICONS[profile.role] ?? "👤"}</span>
              <span className="text-[11px] font-medium leading-tight">{profile.label.split("/")[0].trim()}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="mt-2 px-2 py-1.5 border border-line bg-surface-2">
          <p className="text-[11px] text-ink-3 leading-relaxed">{selected.description}</p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {selected.content_rules.block_types.map((bt) => (
              <span
                key={bt}
                className="text-[10px] px-1.5 py-0.5 bg-zop-orange/10 text-zop-orange border border-zop-orange/40 font-mono"
              >
                {bt.replace("_", " ")}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
