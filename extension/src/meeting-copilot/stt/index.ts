import { getSttProvider } from "../../shared/meeting-copilot/feature-flag";
import { DeepgramSttProvider } from "./deepgram-stt";
import { MockSttProvider } from "./mock-stt";
import { backendUrl, backendJwt } from "../../shared/agents/llm-client";
import type { SttProvider } from "./types";

/**
 * Fetch a short-lived Deepgram temp key from the backend proxy.
 * DEEPGRAM_API_KEY lives in backend .env only — never bundled into the
 * extension. Token TTL is 60 s; Deepgram holds the WebSocket open once
 * authenticated so one token per session is sufficient.
 */
async function fetchDeepgramToken(): Promise<string | null> {
  try {
    const jwt = await backendJwt();
    const res = await fetch(`${backendUrl()}/api/v1/stt/token`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) {
      console.warn("[stt] backend /stt/token returned", res.status, "— mock fallback");
      return null;
    }
    const data = await res.json() as { token?: string };
    return data.token ?? null;
  } catch (err) {
    console.warn("[stt] token fetch failed:", err);
    return null;
  }
}

// Async factory — was sync before; callers that used createSttProvider()
// must now await it. Audio controller updated accordingly.
export async function createSttProvider(): Promise<SttProvider> {
  const which = getSttProvider();

  if (which === "deepgram") {
    const token = await fetchDeepgramToken();
    if (!token) {
      console.warn("[stt] no Deepgram token available — using mock STT");
      return new MockSttProvider();
    }
    return new DeepgramSttProvider(token);
  }

  if (which === "assemblyai") {
    console.warn("[stt] assemblyai not implemented — using mock");
    return new MockSttProvider();
  }

  return new MockSttProvider();
}

export type { SttProvider, SttStartOptions } from "./types";
