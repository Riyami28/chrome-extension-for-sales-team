// Runtime check for the V2 Meeting Copilot feature flag.
// Reads VITE_MEETING_COPILOT from the bundler-injected env. Default: off.

export function isMeetingCopilotEnabled(): boolean {
  const raw = import.meta.env.VITE_MEETING_COPILOT;
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export function getSttProvider(): "deepgram" | "assemblyai" | "mock" {
  const v = import.meta.env.VITE_STT_PROVIDER;
  if (v === "deepgram" || v === "assemblyai") return v;
  return "mock";
}
