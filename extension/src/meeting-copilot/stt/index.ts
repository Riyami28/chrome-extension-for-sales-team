import { getSttProvider } from "../../shared/meeting-copilot/feature-flag";
import { DeepgramSttProvider } from "./deepgram-stt";
import { MockSttProvider } from "./mock-stt";
import type { SttProvider } from "./types";

export function createSttProvider(): SttProvider {
  const which = getSttProvider();
  if (which === "deepgram") {
    const key = import.meta.env.VITE_DEEPGRAM_API_KEY;
    if (!key || key.startsWith("YOUR_")) {
      console.warn("[stt] deepgram selected but no key; falling back to mock");
      return new MockSttProvider();
    }
    return new DeepgramSttProvider(key);
  }
  if (which === "assemblyai") {
    console.warn("[stt] assemblyai provider not implemented yet; using mock");
    return new MockSttProvider();
  }
  return new MockSttProvider();
}

export type { SttProvider, SttStartOptions } from "./types";
