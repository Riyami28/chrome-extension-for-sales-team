import React, { useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { signInWithGoogle } from "../../shared/auth/google-sso";
import { ALLOWED_EMAIL_DOMAIN } from "../../shared/auth/team-config";

const IS_PREVIEW = import.meta.env.VITE_MOCK_MODE === "true";

export function AuthGate() {
  const { setUser } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setLoading(true);
    setError(null);
    try {
      const user = await signInWithGoogle(true);
      setUser(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  function handlePreview() {
    setUser({
      id: "preview-user",
      email: "preview@zop.dev",
      name: "Preview User",
      role: "admin",
    });
  }

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-ink items-center justify-center px-6 font-sans">
      <div className="w-full max-w-xs space-y-6">
        <div className="text-center">
          <div className="w-14 h-14 bg-zop-orange flex items-center justify-center mx-auto mb-4">
            <span className="text-xl font-bold text-zop-black font-mono">CL</span>
          </div>
          <h1 className="text-xl font-bold text-ink tracking-[-0.03em]">ClientLens</h1>
          <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4 mt-1">
            Sales Copilot
          </p>
          <p className="text-xs text-ink-3 mt-3 leading-relaxed">
            Internal tool. Sign-in is restricted to{" "}
            <span className="text-ink-2 font-mono">@{ALLOWED_EMAIL_DOMAIN}</span> accounts.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.4)] px-3 py-2">
            <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-400 leading-relaxed">{error}</p>
          </div>
        )}

        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full py-2.5 bg-zop-cream hover:shadow-hover-ink disabled:opacity-60 text-zop-black font-semibold transition-all flex items-center justify-center gap-2 text-sm"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <GoogleMark />}
          {loading ? "Signing in…" : "Sign in with Google"}
        </button>

        <div className="flex items-start gap-2 text-[11px] text-ink-4 leading-relaxed">
          <ShieldCheck size={12} className="text-zop-green mt-0.5 shrink-0" />
          <p>
            Signs you in with your <span className="font-mono text-ink-3">@{ALLOWED_EMAIL_DOMAIN}</span>{" "}
            Google Workspace account through Google's standard OAuth flow. The extension never
            sees your password.
          </p>
        </div>

        {IS_PREVIEW && (
          <button
            onClick={handlePreview}
            className="w-full py-2 text-[11px] text-ink-4 hover:text-ink-2 underline underline-offset-4"
          >
            Preview mode (skip sign-in)
          </button>
        )}
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.71v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.61z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.71H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.71A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l2.99-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96L3.95 7.3C4.66 5.18 6.65 3.58 9 3.58z" />
    </svg>
  );
}
