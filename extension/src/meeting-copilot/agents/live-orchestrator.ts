// Runs the three live agents on timed cadences against the meeting copilot
// store. Kept independent of React so it can be driven from anywhere.

import { useMeetingCopilotStore } from "../../sidebar/stores/meeting-copilot-store";
import type { KBEntry } from "../../shared/types";
import { runAgendaTracker, runCoachAgent, runLiveCouncilValidator, runSentimentAgent } from "./live-agents";
import { computeSentimentTrend, computeAgendaPacing, rejectionFromOutcome } from "./live-helpers";

const SENTIMENT_INTERVAL_MS = 20_000;
const AGENDA_INTERVAL_MS = 30_000;
const COACH_INTERVAL_MS = 15_000;

const LIVE_COACH_MIN_GAP_MS = 2_500;
const LIVE_SENTIMENT_MIN_GAP_MS = 4_000;
const LIVE_TRIGGER_DEBOUNCE_MS = 350;

const AGENT_ERROR_THRESHOLD = 3;
const THINKING_LINGER_MS = 200;

let timers: number[] = [];
let getKb: () => KBEntry[] = () => [];
let lastCoachAt = 0;
let lastSentimentAt = 0;
let coachInFlight = false;
let sentimentInFlight = false;
// Pending re-trigger flags — set when the live trigger fires during an
// in-flight call. Critical for Opus (5-9s round trips): without this, every
// segment spoken during the call is dropped and the coach is permanently
// behind the conversation.
let coachPending = false;
let sentimentPending = false;
let liveTriggerTimer: number | undefined;
let pollHandle: number | undefined;
let transcriptUnsub: (() => void) | undefined;

// Consecutive failure counters per agent — used to surface a single banner
// after 3 back-to-back errors rather than spamming the user every 15s.
let coachErrorStreak = 0;
let sentimentErrorStreak = 0;
let agendaErrorStreak = 0;
let errorBanner: string | null = null;

function friendlyErr(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0].slice(0, 140);
  return String(err).slice(0, 140);
}

function noteAgentError(agent: "coach" | "sentiment" | "agenda", err: unknown): void {
  const msg = friendlyErr(err);
  if (agent === "coach") coachErrorStreak++;
  if (agent === "sentiment") sentimentErrorStreak++;
  if (agent === "agenda") agendaErrorStreak++;
  const streak = agent === "coach" ? coachErrorStreak : agent === "sentiment" ? sentimentErrorStreak : agendaErrorStreak;
  if (streak >= AGENT_ERROR_THRESHOLD && errorBanner !== msg) {
    errorBanner = msg;
    mirrorToTab({ errorBanner: msg });
  }
  console.debug(`[live-orch] ${agent} error (streak=${streak}):`, msg);
}

function noteAgentSuccess(agent: "coach" | "sentiment" | "agenda"): void {
  if (agent === "coach") coachErrorStreak = 0;
  if (agent === "sentiment") sentimentErrorStreak = 0;
  if (agent === "agenda") agendaErrorStreak = 0;
  if (errorBanner) {
    errorBanner = null;
    mirrorToTab({ errorBanner: null });
  }
}

function scheduleLoop(fn: () => void | Promise<void>, every: number) {
  const id = setInterval(() => { void fn(); }, every) as unknown as number;
  timers.push(id);
}

// Mirror an agent output to the Meet-tab transponder.
function mirrorToTab(payload: Record<string, unknown>) {
  const tabId = useMeetingCopilotStore.getState().session?.tab_id;
  if (!tabId) return;
  chrome.tabs
    .sendMessage(tabId, { type: "MC_SESSION_UPDATED", payload })
    .catch(() => { /* tab closed or transponder not mounted */ });
}

async function runSentimentNow(): Promise<void> {
  if (sentimentInFlight) { sentimentPending = true; return; }
  const session = useMeetingCopilotStore.getState().session;
  if (!session || session.status !== "listening") return;
  sentimentInFlight = true;
  lastSentimentAt = Date.now();
  try {
    let snap = null;
    try {
      snap = await runSentimentAgent(session);
      noteAgentSuccess("sentiment");
    } catch (err) {
      noteAgentError("sentiment", err);
      return;
    }
    if (snap) {
      useMeetingCopilotStore.getState().pushSentiment(snap);
      const latest = useMeetingCopilotStore.getState().session?.sentiment_history || [];
      const trend = computeSentimentTrend(latest);
      mirrorToTab({ sentiment: snap, sentimentTrend: trend });
    }
  } finally {
    sentimentInFlight = false;
    if (sentimentPending) {
      sentimentPending = false;
      setTimeout(() => void runSentimentNow(), 0);
    }
  }
}

async function runCoachNow(): Promise<void> {
  if (coachInFlight) { coachPending = true; return; }
  const session = useMeetingCopilotStore.getState().session;
  if (!session || session.status !== "listening") return;
  coachInFlight = true;
  lastCoachAt = Date.now();
  mirrorToTab({ thinking: { kind: "coach", text: "" } });
  try {
    const kb = getKb();
    let suggestions: Awaited<ReturnType<typeof runCoachAgent>> = [];
    try {
      suggestions = await runCoachAgent(session, kb, (text) => {
        mirrorToTab({ thinking: { kind: "coach", text } });
      });
      noteAgentSuccess("coach");
    } catch (err) {
      noteAgentError("coach", err);
      return;
    }
    // Run validators in parallel — they don't depend on each other.
    const outcomes = await Promise.all(
      suggestions.map((s) => runLiveCouncilValidator(s, session, kb)),
    );
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      const original = suggestions[i];
      if (outcome.verdict === "reject" || !outcome.suggestion) {
        const rejection = rejectionFromOutcome(outcome, original.title, original.body, original.kind);
        mirrorToTab({ rejection });
        continue;
      }
      const existing = useMeetingCopilotStore.getState().session?.suggestions || [];
      const dup = existing.some(
        (e) => e.title === outcome.suggestion!.title && e.kind === outcome.suggestion!.kind,
      );
      if (dup) continue;
      useMeetingCopilotStore.getState().pushSuggestion(outcome.suggestion);
      mirrorToTab({ suggestion: outcome.suggestion });
    }
  } finally {
    coachInFlight = false;
    setTimeout(() => mirrorToTab({ thinking: null }), THINKING_LINGER_MS);
    if (coachPending) {
      coachPending = false;
      setTimeout(() => void runCoachNow(), 0);
    }
  }
}

// Debounced live trigger. Called by the transcript poller below whenever a
// new final segment lands; runs coach + sentiment immediately so Say-this and
// Avoid update in lock-step with the conversation instead of every 15s.
function scheduleLiveTrigger() {
  if (liveTriggerTimer) clearTimeout(liveTriggerTimer);
  liveTriggerTimer = setTimeout(() => {
    const now = Date.now();
    // Don't gate on inFlight — runCoachNow/runSentimentNow set the *Pending
    // flag and re-fire on completion, so Opus (5-9s round trips) catches up
    // to the conversation instead of dropping every segment spoken mid-call.
    if (coachInFlight || now - lastCoachAt >= LIVE_COACH_MIN_GAP_MS) void runCoachNow();
    if (sentimentInFlight || now - lastSentimentAt >= LIVE_SENTIMENT_MIN_GAP_MS) void runSentimentNow();
  }, LIVE_TRIGGER_DEBOUNCE_MS) as unknown as number;
}

// Subscribe to transcript mutations instead of polling. Zustand's subscribe
// fires on every set()—we compare final-segment counts and fire the trigger
// only when a new final lands. Cheaper than 250ms polling and immune to the
// double-mount edge case that gave us 8 polls/sec.
function startTranscriptWatch() {
  stopTranscriptWatch();
  let lastFinalLen = useMeetingCopilotStore.getState().session?.transcript.filter((s) => s.is_final).length || 0;
  transcriptUnsub = useMeetingCopilotStore.subscribe((state) => {
    const t = state.session?.transcript || [];
    const finals = t.filter((s) => s.is_final).length;
    if (finals > lastFinalLen) {
      lastFinalLen = finals;
      scheduleLiveTrigger();
    }
  });
}

function stopTranscriptWatch() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = undefined; } // legacy cleanup
  if (transcriptUnsub) { transcriptUnsub(); transcriptUnsub = undefined; }
  if (liveTriggerTimer) clearTimeout(liveTriggerTimer);
  liveTriggerTimer = undefined;
}

export function startLiveOrchestrator(kbProvider: () => KBEntry[]): void {
  stopLiveOrchestrator();
  getKb = kbProvider;

  scheduleLoop(() => void runSentimentNow(), SENTIMENT_INTERVAL_MS);

  scheduleLoop(async () => {
    const session = useMeetingCopilotStore.getState().session;
    if (!session || session.status !== "listening") return;
    let agenda = null;
    try {
      agenda = await runAgendaTracker(session);
      noteAgentSuccess("agenda");
    } catch (err) {
      noteAgentError("agenda", err);
      return;
    }
    if (agenda) {
      useMeetingCopilotStore.getState().updateAgenda(agenda);
      const startedMs = session.started_at ? Date.parse(session.started_at) : undefined;
      const pacing = computeAgendaPacing(agenda, startedMs);
      mirrorToTab({ agenda, pacing });
    }
  }, AGENDA_INTERVAL_MS);

  scheduleLoop(() => void runCoachNow(), COACH_INTERVAL_MS);

  startTranscriptWatch();
}

export function stopLiveOrchestrator(): void {
  for (const id of timers) clearInterval(id);
  timers = [];
  stopTranscriptWatch();
  coachErrorStreak = 0; sentimentErrorStreak = 0; agendaErrorStreak = 0;
  errorBanner = null;
}
