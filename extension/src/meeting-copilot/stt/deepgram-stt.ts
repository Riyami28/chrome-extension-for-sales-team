import type { TranscriptSegment } from "../../shared/types";
import type { SttProvider, SttStartOptions } from "./types";

// Thin wrapper over Deepgram's live websocket API. Audio is pushed in as
// linear16 PCM @ 16kHz. Interim results stream back as is_final=false,
// followed by a final segment at the end of each utterance.
export class DeepgramSttProvider implements SttProvider {
  name = "deepgram" as const;
  private ws: WebSocket | null = null;
  private running = false;
  private apiKey: string;
  private t0 = 0;
  private utteranceStart = 0;
  private onError: (err: string) => void = () => {};

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async start(options: SttStartOptions): Promise<void> {
    if (!this.apiKey) {
      options.onError("Deepgram API key missing");
      return;
    }
    this.onError = options.onError;
    this.t0 = Date.now();

    const params = new URLSearchParams({
      model: "nova-2",
      punctuate: "true",
      interim_results: "true",
      smart_format: "true",
      encoding: "linear16",
      sample_rate: String(options.sampleRate || 16000),
      channels: "1",
      endpointing: "250",
    });
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.ws = new WebSocket(url, ["token", this.apiKey]);
    this.ws.binaryType = "arraybuffer";

    this.ws.addEventListener("open", () => {
      this.running = true;
    });
    this.ws.addEventListener("error", () => {
      this.onError("Deepgram socket error");
    });
    this.ws.addEventListener("close", () => {
      this.running = false;
    });
    this.ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        const alt = data?.channel?.alternatives?.[0];
        if (!alt?.transcript) return;
        const isFinal = Boolean(data.is_final);
        const now = Date.now() - this.t0;
        if (isFinal) {
          const seg: TranscriptSegment = {
            id: `dg-${now}`,
            speaker: options.defaultSpeaker || "unknown",
            text: alt.transcript.trim(),
            ts_start: this.utteranceStart,
            ts_end: now,
            confidence: alt.confidence,
            is_final: true,
          };
          options.onSegment(seg);
          this.utteranceStart = now;
        } else if (alt.transcript.trim().length > 0) {
          options.onSegment({
            id: `dg-interim-${now}`,
            speaker: options.defaultSpeaker || "unknown",
            text: alt.transcript.trim(),
            ts_start: this.utteranceStart,
            ts_end: now,
            confidence: alt.confidence,
            is_final: false,
          });
        }
      } catch (err) {
        console.warn("[deepgram] parse error", err);
      }
    });
  }

  pushAudio(chunk: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(chunk);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        }
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
