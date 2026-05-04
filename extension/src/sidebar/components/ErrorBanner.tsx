import React from "react";
import { AlertTriangle, X } from "lucide-react";

interface Props {
  message: string;
  onDismiss?: () => void;
  onOpenSettings?: () => void;
}

export function ErrorBanner({ message, onDismiss, onOpenSettings }: Props) {
  const looksLikeKeyIssue = /API key|Settings|invalid|rate limit|quota/i.test(message);

  return (
    <div className="flex items-start gap-2 bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.4)] px-3 py-2">
      <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-red-400 leading-relaxed">{message}</p>
        {looksLikeKeyIssue && onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="mt-1 text-[10px] font-mono uppercase tracking-[0.14em] text-red-300 hover:text-red-200 underline"
          >
            Open Settings →
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-red-400/60 hover:text-red-300 shrink-0"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
