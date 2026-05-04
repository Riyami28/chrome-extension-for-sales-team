import type { TranscriptSegment, TranscriptSpeaker } from "../../shared/types";

export interface SttProvider {
  name: "deepgram" | "assemblyai" | "mock";
  start(options: SttStartOptions): Promise<void>;
  pushAudio(chunk: ArrayBuffer): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export interface SttStartOptions {
  sampleRate: number;
  onSegment: (seg: TranscriptSegment) => void;
  onError: (err: string) => void;
  defaultSpeaker?: TranscriptSpeaker;
}
