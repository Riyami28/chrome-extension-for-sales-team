import type { TranscriptSegment } from "../../shared/types";
import type { SttProvider, SttStartOptions } from "./types";

// Canned sales conversation used when VITE_STT_PROVIDER=mock.
// Segments play out in real time so the rest of the pipeline behaves
// like it would in a real meeting.
const MOCK_SCRIPT: { speaker: "rep" | "prospect"; text: string; delay_ms: number }[] = [
  { speaker: "rep", text: "Thanks for joining today. Before we dive in, I'd love to hear how your team thinks about cloud spend right now.", delay_ms: 3500 },
  { speaker: "prospect", text: "Honestly, we're drowning. Our AWS bill doubled last quarter and finance is breathing down our neck.", delay_ms: 4200 },
  { speaker: "prospect", text: "We tried CloudHealth but it felt like reporting without real action.", delay_ms: 3000 },
  { speaker: "rep", text: "That's a very common pattern. Can you share roughly what portion of that spend is EC2 versus managed services?", delay_ms: 3800 },
  { speaker: "prospect", text: "Compute is the biggest chunk, maybe sixty percent. Then databases and data transfer.", delay_ms: 3500 },
  { speaker: "rep", text: "Got it. Where we've seen the fastest ROI is rightsizing plus idle scheduling for non-prod. Would savings of twenty to thirty percent in the first ninety days move the needle?", delay_ms: 5000 },
  { speaker: "prospect", text: "That would be huge, but I'm skeptical. Everyone promises that and it never lands.", delay_ms: 3800 },
  { speaker: "rep", text: "Fair pushback. What if we ran a two-week read-only assessment on your prod account and showed you a line-item savings plan before you commit to anything?", delay_ms: 4800 },
  { speaker: "prospect", text: "Read-only, no changes? That I can probably get security to approve.", delay_ms: 3200 },
  { speaker: "prospect", text: "How does pricing work if we move forward?", delay_ms: 2800 },
  { speaker: "rep", text: "Usage-based, tied to realized savings. You only pay once we've actually saved you money.", delay_ms: 3500 },
];

export class MockSttProvider implements SttProvider {
  name = "mock" as const;
  private running = false;
  private timers: number[] = [];
  private t0 = 0;

  async start(options: SttStartOptions): Promise<void> {
    this.running = true;
    this.t0 = Date.now();
    let cumulative = 0;

    for (const entry of MOCK_SCRIPT) {
      cumulative += entry.delay_ms;
      const scheduledAt = cumulative;
      const timerId = setTimeout(() => {
        if (!this.running) return;
        const now = Date.now() - this.t0;
        const seg: TranscriptSegment = {
          id: `mock-${scheduledAt}`,
          speaker: entry.speaker,
          text: entry.text,
          ts_start: now - 1500,
          ts_end: now,
          confidence: 0.94,
          is_final: true,
        };
        options.onSegment(seg);
      }, scheduledAt) as unknown as number;
      this.timers.push(timerId);
    }
  }

  pushAudio(_chunk: ArrayBuffer): void {
    // Mock ignores audio; it replays the canned script on its own timer.
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
  }

  isRunning(): boolean {
    return this.running;
  }
}
