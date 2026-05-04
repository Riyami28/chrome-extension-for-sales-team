// Offscreen document: captures tab audio (or microphone in mock mode),
// resamples to 16kHz PCM, and streams transcripts back to the service worker
// via chrome.runtime.sendMessage.
//
// The service worker wakes this doc via chrome.offscreen.createDocument
// before sending the START command. The doc self-closes on STOP.

import { createSttProvider } from "../meeting-copilot/stt";
import type { SttProvider } from "../meeting-copilot/stt";
import type { TranscriptSegment } from "../shared/types";

const TARGET_SAMPLE_RATE = 16000;

let audioCtx: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let processor: ScriptProcessorNode | null = null;
let stream: MediaStream | null = null;
let stt: SttProvider | null = null;
let sessionId: string | null = null;

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function downsample(buffer: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate === inRate) return buffer;
  const ratio = inRate / outRate;
  const newLen = Math.round(buffer.length / ratio);
  const out = new Float32Array(newLen);
  let oi = 0;
  let bi = 0;
  while (oi < newLen) {
    const nextBi = Math.round((oi + 1) * ratio);
    let acc = 0;
    let count = 0;
    for (let i = bi; i < nextBi && i < buffer.length; i++) {
      acc += buffer[i];
      count++;
    }
    out[oi] = count > 0 ? acc / count : 0;
    oi++;
    bi = nextBi;
  }
  return out;
}

async function startCapture(payload: { streamId: string; session_id: string }) {
  sessionId = payload.session_id;
  try {
    stream = await (navigator.mediaDevices.getUserMedia as unknown as (
      c: unknown,
    ) => Promise<MediaStream>)({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: payload.streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    postToSw({ type: "MC_AUDIO_STATE", session_id: sessionId, payload: { state: "error", error: String(err) } });
    return;
  }

  // Keep playing tab audio aloud — we're a silent listener, not a mute box.
  audioCtx = new AudioContext();
  const destination = audioCtx.createMediaStreamDestination();
  source = audioCtx.createMediaStreamSource(stream);
  const passthroughGain = audioCtx.createGain();
  source.connect(passthroughGain);
  passthroughGain.connect(audioCtx.destination);

  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(destination);

  stt = createSttProvider();
  await stt.start({
    sampleRate: TARGET_SAMPLE_RATE,
    defaultSpeaker: "prospect",
    onSegment: (seg: TranscriptSegment) => {
      postToSw({ type: "MC_TRANSCRIPT_APPEND", session_id: sessionId!, payload: seg });
    },
    onError: (err) => {
      postToSw({ type: "MC_AUDIO_STATE", session_id: sessionId!, payload: { state: "error", error: err } });
    },
  });

  const inRate = audioCtx.sampleRate;
  processor.onaudioprocess = (ev) => {
    if (!stt || !stt.isRunning()) return;
    const ch = ev.inputBuffer.getChannelData(0);
    const downsampled = downsample(ch, inRate, TARGET_SAMPLE_RATE);
    const pcm = floatTo16BitPCM(downsampled);
    stt.pushAudio(pcm);
  };

  postToSw({ type: "MC_AUDIO_STATE", session_id: sessionId, payload: { state: "listening" } });
}

async function startMockCapture(payload: { session_id: string }) {
  sessionId = payload.session_id;
  stt = createSttProvider();
  await stt.start({
    sampleRate: TARGET_SAMPLE_RATE,
    defaultSpeaker: "prospect",
    onSegment: (seg) => {
      postToSw({ type: "MC_TRANSCRIPT_APPEND", session_id: sessionId!, payload: seg });
    },
    onError: (err) => {
      postToSw({ type: "MC_AUDIO_STATE", session_id: sessionId!, payload: { state: "error", error: err } });
    },
  });
  postToSw({ type: "MC_AUDIO_STATE", session_id: sessionId, payload: { state: "listening" } });
}

async function stopCapture() {
  if (processor) { try { processor.disconnect(); } catch { /* noop */ } processor = null; }
  if (source) { try { source.disconnect(); } catch { /* noop */ } source = null; }
  if (audioCtx) { try { await audioCtx.close(); } catch { /* noop */ } audioCtx = null; }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (stt) {
    await stt.stop();
    stt = null;
  }
  postToSw({ type: "MC_AUDIO_STATE", session_id: sessionId || undefined, payload: { state: "stopped" } });
  sessionId = null;
}

function postToSw(msg: { type: string; session_id?: string; payload?: unknown }) {
  chrome.runtime.sendMessage(msg).catch(() => { /* sw may be asleep */ });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type: string; payload?: { streamId?: string; session_id?: string; mock?: boolean } };
  if (m.type === "MC_OFFSCREEN_START") {
    const p = m.payload || {};
    if (p.mock || !p.streamId) {
      startMockCapture({ session_id: p.session_id || "unknown" }).then(() => sendResponse({ ok: true }));
    } else {
      startCapture({ streamId: p.streamId, session_id: p.session_id || "unknown" }).then(() => sendResponse({ ok: true }));
    }
    return true;
  }
  if (m.type === "MC_OFFSCREEN_STOP") {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

postToSw({ type: "MC_AUDIO_STATE", payload: { state: "offscreen_ready" } });
