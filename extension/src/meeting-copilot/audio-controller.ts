// Runs inside the service worker. Manages the offscreen document lifecycle
// and hands off a tabCapture streamId for the live meeting tab.

import { getSttProvider } from "../shared/meeting-copilot/feature-flag";

const OFFSCREEN_PATH = "offscreen.html";

async function hasOffscreen(): Promise<boolean> {
  // chrome.offscreen.hasDocument exists in Chrome 116+.
  const api = (chrome as unknown as { offscreen?: { hasDocument?: () => Promise<boolean> } }).offscreen;
  if (api?.hasDocument) {
    try { return await api.hasDocument(); } catch { return false; }
  }
  // Fallback: try listing matched clients.
  try {
    const ctxs = await (chrome.runtime as unknown as {
      getContexts?: (q: { contextTypes: string[] }) => Promise<unknown[]>;
    }).getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return Array.isArray(ctxs) && ctxs.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
    justification: "Capture tab audio for live meeting transcription.",
  });
}

async function closeOffscreen(): Promise<void> {
  if (!(await hasOffscreen())) return;
  try { await chrome.offscreen.closeDocument(); } catch { /* noop */ }
}

export async function startAudioForSession(opts: { sessionId: string; tabId?: number }): Promise<{ ok: boolean; error?: string }> {
  await ensureOffscreen();
  const useMock = getSttProvider() === "mock" || !opts.tabId;

  if (useMock) {
    try {
      await chrome.runtime.sendMessage({
        type: "MC_OFFSCREEN_START",
        payload: { session_id: opts.sessionId, mock: true },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  try {
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: opts.tabId! },
        (id) => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message || "no streamId"));
          } else resolve(id);
        },
      );
    });
    await chrome.runtime.sendMessage({
      type: "MC_OFFSCREEN_START",
      payload: { session_id: opts.sessionId, streamId },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function stopAudio(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "MC_OFFSCREEN_STOP" });
  } catch { /* noop */ }
  await closeOffscreen();
}
