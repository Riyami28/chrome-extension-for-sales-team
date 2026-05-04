import React, { useMemo, useState } from "react";
import { CheckCircle2, Circle, Sparkles, X } from "lucide-react";
import { getSettings } from "../../shared/utils/settings-storage";

interface Props {
  kbCount: number;
  onOpenSettings: () => void;
}

const DISMISS_KEY = "clientlens_onboarding_dismissed_v1";

export function OnboardingChecklist({ kbCount, onOpenSettings }: Props) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const steps = useMemo(() => {
    const s = getSettings();
    const keyOk =
      !!s.geminiKey ||
      !!s.anthropicKey ||
      !!s.groqKey ||
      (!!s.customBaseUrl && !!s.customModel);
    const anyIntegration = Object.values(s.integrations).some((c) => c.connected);
    const hasKB = kbCount > 0;
    return [
      { id: "key", label: "Add a model API key", done: keyOk, action: onOpenSettings },
      { id: "integ", label: "Connect one integration (optional)", done: anyIntegration, action: onOpenSettings },
      { id: "kb", label: "Add at least one KB entry", done: hasKB },
    ];
  }, [kbCount, onOpenSettings]);

  const remaining = steps.filter((s) => !s.done).length;
  if (dismissed || remaining === 0) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  return (
    <div className="border border-zop-orange/40 bg-zop-orange/5 p-3 relative">
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute top-2 right-2 p-1 text-ink-4 hover:text-ink"
      >
        <X size={12} />
      </button>
      <div className="flex items-center gap-1.5 mb-2">
        <Sparkles size={12} className="text-zop-orange" />
        <span className="text-[11px] font-semibold text-ink">Get set up</span>
        <span className="text-[10px] font-mono text-ink-4 ml-auto mr-4">
          {steps.length - remaining} / {steps.length}
        </span>
      </div>
      <ul className="space-y-1">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-[11px]">
            {s.done ? (
              <CheckCircle2 size={12} className="text-zop-green shrink-0" />
            ) : (
              <Circle size={12} className="text-ink-4 shrink-0" />
            )}
            <span className={s.done ? "text-ink-3 line-through" : "text-ink"}>{s.label}</span>
            {!s.done && s.action && (
              <button
                onClick={s.action}
                className="ml-auto text-[10px] font-mono uppercase tracking-[0.14em] text-zop-orange hover:underline"
              >
                Open
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
