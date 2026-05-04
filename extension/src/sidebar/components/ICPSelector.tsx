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
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
        <Users size={12} />
        ICP Profile
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {ICP_PROFILES.map((profile) => (
          <button
            key={profile.role}
            onClick={() => setIcpRole(profile.role as ICPRole)}
            className={`flex flex-col items-center gap-1 p-2 rounded-lg border text-center transition-all ${
              icpRole === profile.role
                ? "border-violet-500 bg-violet-500/10 text-violet-300"
                : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-300"
            }`}
          >
            <span className="text-base">{ROLE_ICONS[profile.role] ?? "👤"}</span>
            <span className="text-xs font-medium leading-tight">{profile.label.split("/")[0].trim()}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="mt-2 px-2 py-1.5 bg-slate-800 rounded-lg">
          <p className="text-xs text-slate-400 leading-relaxed">{selected.description}</p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {selected.content_rules.block_types.map((bt) => (
              <span
                key={bt}
                className="text-[10px] px-1.5 py-0.5 bg-violet-900/50 text-violet-300 rounded-full border border-violet-700/50"
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
