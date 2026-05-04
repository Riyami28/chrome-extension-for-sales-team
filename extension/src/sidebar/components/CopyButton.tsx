import React, { useState } from "react";
import { Check, Copy } from "lucide-react";

interface Props {
  text: string;
  label?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "solid";
  title?: string;
}

export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
  variant = "ghost",
  title,
}: Props) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  const iconSize = size === "sm" ? 11 : 13;
  const padding = size === "sm" ? "px-2 py-1" : "px-2.5 py-1.5";
  const base = "flex items-center gap-1 text-[11px] font-medium transition-colors";
  const skin =
    variant === "solid"
      ? "bg-zop-orange text-zop-black hover:shadow-hover-orange"
      : "border border-line text-ink-3 hover:text-ink hover:border-line-2 bg-surface-2";

  return (
    <button
      type="button"
      onClick={onCopy}
      title={title || "Copy to clipboard"}
      className={`${base} ${skin} ${padding}`}
    >
      {copied ? (
        <>
          <Check size={iconSize} className="text-zop-green" />
          <span>Copied</span>
        </>
      ) : (
        <>
          <Copy size={iconSize} />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
