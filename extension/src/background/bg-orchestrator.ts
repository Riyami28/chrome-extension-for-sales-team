// Background-side orchestrator. Runs the live agents (sentiment / agenda /
// coach) in the service worker so the in-Meet "Start copilot" flow doesn't
// have to pop open the sidebar to function. Mirrors agent output to the Meet
// tab as MC_SESSION_UPDATED so the on-screen transponder stays live.
//
// This intentionally duplicates a tiny slice of the sidebar's
// live-orchestrator. The sidebar still owns its own copy for users who start
// from the side panel (where they fill in company / persona / agenda).

import type {
  AgendaItem,
  CalendarEvent,
  CoachSuggestion,
  MeetingSession,
  MeetingSessionInput,
  SentimentSnapshot,
  TranscriptSegment,
} from "../shared/types";
import { listKB } from "../shared/utils/kb-storage";
import {
  runAgendaTracker,
  runCoachAgent,
  runLiveCouncilValidator,
  runSentimentAgent,
} from "../meeting-copilot/agents/live-agents";
import { computeSentimentTrend, computeAgendaPacing, rejectionFromOutcome } from "../meeting-copilot/agents/live-helpers";
import { findCurrentMeetingFromCalendar } from "../meeting-copilot/integrations/google-calendar";

// Background "tick" intervals — these are the *fallback* cadence when nothing
// new is being said. The moment a final transcript segment lands we also
// schedule an immediate coach + sentiment refresh (debounced) so Say-this /
// Avoid feel live, not 15-second-stale.
const SENTIMENT_INTERVAL_MS = 20_000;
const AGENDA_INTERVAL_MS = 30_000;
const COACH_INTERVAL_MS = 15_000;

// Don't fire more than once per ~2.5s per agent, even if the prospect is
// rattling off short sentences — gives the LLM time to return and avoids
// stomping on an in-flight call with another one.
const LIVE_COACH_MIN_GAP_MS = 2_500;
const LIVE_SENTIMENT_MIN_GAP_MS = 4_000;
// Tiny debounce so a burst of segments coalesces into a single trigger.
const LIVE_TRIGGER_DEBOUNCE_MS = 350;

// Surface an error banner on the transponder only after this many back-to-back
// agent failures — a single transient timeout shouldn't scare the rep mid-call.
const AGENT_ERROR_THRESHOLD = 3;
// Keep the "thinking…" pulse visible for ~200ms after the suggestion lands so
// the rep sees a visual anchor instead of an instant cut.
const THINKING_LINGER_MS = 200;

interface BgSessionState {
  id: string;
  tabId: number;
  session: MeetingSession;
  timers: number[];
  lastCoachAt: number;
  lastSentimentAt: number;
  coachInFlight: boolean;
  sentimentInFlight: boolean;
  // If new transcript lands while an LLM call is in flight, mark "pending"
  // and re-fire as soon as the in-flight call returns. Critical for Opus
  // (5-9s round trips): without this, every segment spoken during the call
  // gets dropped and the coach is permanently behind the conversation.
  coachPending: boolean;
  sentimentPending: boolean;
  liveTriggerTimer?: number;
  // Consecutive LLM failures per agent. Reset on success. Used to surface a
  // single "coach offline" banner rather than spamming every 15s.
  coachErrorStreak: number;
  sentimentErrorStreak: number;
  agendaErrorStreak: number;
  errorBanner: string | null;
}

let active: BgSessionState | null = null;

function emptySession(id: string, tabId: number, meetingTitle?: string): MeetingSession {
  return {
    id,
    status: "listening",
    started_at: new Date().toISOString(),
    platform: "google_meet",
    tab_id: tabId,
    input: {
      company_name: "",
      persona_role: "",
      meeting_title: meetingTitle,
      agenda: [],
    },
    transcript: [],
    sentiment_history: [],
    suggestions: [],
    agenda: [],
  };
}

// Domains we treat as the rep's own org or generic personal mail — these
// attendees are not the prospect, so we shouldn't infer the company from them.
const NON_PROSPECT_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com",
  "zop.dev", // rep's own org — extend or move into a setting later.
]);

function inferCompanyFromAttendees(event: CalendarEvent): string {
  const counts = new Map<string, number>();
  for (const a of event.attendees) {
    const dom = (a.domain || a.email.split("@")[1] || "").toLowerCase();
    if (!dom || NON_PROSPECT_DOMAINS.has(dom)) continue;
    counts.set(dom, (counts.get(dom) || 0) + 1);
  }
  // Pick the most common non-rep domain. Strip the TLD for the company name.
  let bestDom = "", bestCount = 0;
  for (const [d, c] of counts) if (c > bestCount) { bestDom = d; bestCount = c; }
  if (!bestDom) return "";
  const root = bestDom.split(".")[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
}

// Pull short bullet-shaped lines from a calendar description as the agenda.
// Calendar invites usually include a 3-5 line outline; longer paragraphs are
// kept as meeting_notes instead.
function extractAgendaFromDescription(desc?: string): { agenda: AgendaItem[]; notes?: string } {
  if (!desc) return { agenda: [] };
  const stripped = desc.replace(/<[^>]+>/g, "\n"); // calendar HTML → text
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^([-*•·]|\d+[.)])\s+/.test(l));
  const agenda: AgendaItem[] = bullets.slice(0, 8).map((l, i) => ({
    id: `cal-agenda-${Date.now()}-${i}`,
    title: l.replace(/^([-*•·]|\d+[.)])\s+/, "").slice(0, 140),
    priority: "should_cover",
    status: "pending",
  }));
  return { agenda, notes: stripped.slice(0, 800) };
}

function inputFromCalendar(event: CalendarEvent): MeetingSessionInput {
  const { agenda, notes } = extractAgendaFromDescription(event.description);
  return {
    company_name: inferCompanyFromAttendees(event),
    persona_role: "", // attendee titles aren't in calendar API; left blank for manual fill
    meeting_title: event.title,
    meeting_notes: notes,
    agenda,
    calendar_event: event,
  };
}

function mirrorToTab(payload: Record<string, unknown>) {
  if (!active) return;
  chrome.tabs
    .sendMessage(active.tabId, { type: "MC_SESSION_UPDATED", payload })
    .catch(() => { /* tab closed or transponder not mounted */ });
}

// Normalize an LLM error into a short sentence for the banner. Full error
// messages can be multi-line — we just want "API key invalid" or "Quota hit".
function friendlyErr(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0].slice(0, 140);
  return String(err).slice(0, 140);
}

function noteAgentError(agent: "coach" | "sentiment" | "agenda", err: unknown): void {
  if (!active) return;
  const msg = friendlyErr(err);
  if (agent === "coach") active.coachErrorStreak++;
  if (agent === "sentiment") active.sentimentErrorStreak++;
  if (agent === "agenda") active.agendaErrorStreak++;
  const streak =
    agent === "coach" ? active.coachErrorStreak :
    agent === "sentiment" ? active.sentimentErrorStreak :
    active.agendaErrorStreak;
  if (streak >= AGENT_ERROR_THRESHOLD && active.errorBanner !== msg) {
    active.errorBanner = msg;
    mirrorToTab({ errorBanner: msg });
  }
  console.debug(`[bg-orch] ${agent} error (streak=${streak}):`, msg);
}

function noteAgentSuccess(agent: "coach" | "sentiment" | "agenda"): void {
  if (!active) return;
  if (agent === "coach") active.coachErrorStreak = 0;
  if (agent === "sentiment") active.sentimentErrorStreak = 0;
  if (agent === "agenda") active.agendaErrorStreak = 0;
  // Clear the banner once the streak breaks.
  if (active.errorBanner) {
    active.errorBanner = null;
    mirrorToTab({ errorBanner: null });
  }
}

function schedule(fn: () => void | Promise<void>, every: number): number {
  return setInterval(() => { void fn(); }, every) as unknown as number;
}

export function startBgOrchestrator(args: {
  sessionId: string;
  tabId: number;
  meetingTitle?: string;
  meetingUrl?: string;
}): void {
  stopBgOrchestrator();

  active = {
    id: args.sessionId,
    tabId: args.tabId,
    session: emptySession(args.sessionId, args.tabId, args.meetingTitle),
    timers: [],
    lastCoachAt: 0,
    lastSentimentAt: 0,
    coachInFlight: false,
    sentimentInFlight: false,
    coachPending: false,
    sentimentPending: false,
    coachErrorStreak: 0,
    sentimentErrorStreak: 0,
    agendaErrorStreak: 0,
    errorBanner: null,
  };

  // Fire-and-forget: try to enrich the session from Google Calendar. If the
  // user hasn't connected calendar (no cached token) this returns null and we
  // stay with the bare meeting_title. The user can always open the sidebar
  // and fill in fields manually — those override what we seeded here.
  if (args.meetingUrl) {
    void findCurrentMeetingFromCalendar(args.meetingUrl)
      .then((event) => {
        if (!event || !active) return;
        const inferred = inputFromCalendar(event);
        // Merge non-empty fields onto whatever the session already has so a
        // later manual edit from the sidebar isn't blown away.
        const cur = active.session.input;
        active.session.input = {
          ...cur,
          ...Object.fromEntries(Object.entries(inferred).filter(([_, v]) => v !== "" && v != null)),
        };
        if (inferred.agenda.length) active.session.agenda = inferred.agenda;
        mirrorToTab({ input: active.session.input, agenda: active.session.agenda });
      })
      .catch(() => { /* calendar not connected — silent fallback */ });
  }

  active.timers.push(schedule(() => void runSentimentTick(), SENTIMENT_INTERVAL_MS));
  active.timers.push(schedule(() => void runAgendaTick(), AGENDA_INTERVAL_MS));
  active.timers.push(schedule(() => void runCoachTick(), COACH_INTERVAL_MS));
}

async function runSentimentTick(): Promise<void> {
  if (!active) return;
  if (active.sentimentInFlight) { active.sentimentPending = true; return; }
  active.sentimentInFlight = true;
  active.lastSentimentAt = Date.now();
  try {
    let snap: SentimentSnapshot | null = null;
    try {
      snap = await runSentimentAgent(active.session);
      noteAgentSuccess("sentiment");
    } catch (err) {
      noteAgentError("sentiment", err);
      return;
    }
    if (!snap || !active) return;
    active.session.sentiment_history.push(snap);
    const trend = computeSentimentTrend(active.session.sentiment_history);
    mirrorToTab({ sentiment: snap, sentimentTrend: trend });
  } finally {
    if (active) {
      active.sentimentInFlight = false;
      if (active.sentimentPending) {
        active.sentimentPending = false;
        // Re-fire on next tick so we don't recurse into the same try/finally.
        setTimeout(() => void runSentimentTick(), 0);
      }
    }
  }
}

async function runAgendaTick(): Promise<void> {
  if (!active) return;
  let items: AgendaItem[] | null = null;
  try {
    items = await runAgendaTracker(active.session);
    noteAgentSuccess("agenda");
  } catch (err) {
    noteAgentError("agenda", err);
    return;
  }
  if (!items || !active) return;
  active.session.agenda = items;
  const startedMs = active.session.started_at ? Date.parse(active.session.started_at) : undefined;
  const pacing = computeAgendaPacing(items, startedMs);
  mirrorToTab({ agenda: items, pacing });
}

async function runCoachTick(): Promise<void> {
  if (!active) return;
  if (active.coachInFlight) { active.coachPending = true; return; }
  active.coachInFlight = true;
  active.lastCoachAt = Date.now();
  // Tell the transponder a fresh coach pass just kicked off so it can drop
  // its "thinking" pill in place; it'll be replaced when the suggestion lands.
  mirrorToTab({ thinking: { kind: "coach", text: "" } });
  try {
    const kb = await listKB().catch(() => []);
    let suggestions: CoachSuggestion[] = [];
    try {
      suggestions = await runCoachAgent(active.session, kb, (text) => {
        mirrorToTab({ thinking: { kind: "coach", text } });
      });
      noteAgentSuccess("coach");
    } catch (err) {
      noteAgentError("coach", err);
      return;
    }
    // Validate suggestions in parallel — independent calls, no need to chain.
    const outcomes = await Promise.all(
      suggestions.map((s) => runLiveCouncilValidator(s, active!.session, kb)),
    );
    for (let i = 0; i < outcomes.length; i++) {
      if (!active) break;
      const outcome = outcomes[i];
      const original = suggestions[i];
      if (outcome.verdict === "reject" || !outcome.suggestion) {
        // Surface the rejection so reps see the validator working instead of
        // silently dropping ideas. This is the "why was nothing suggested?"
        // signal that builds trust in the coach.
        const rejection = rejectionFromOutcome(outcome, original.title, original.body, original.kind);
        mirrorToTab({ rejection });
        continue;
      }
      // Dedup against suggestions we've already shown — the live trigger fires
      // often, and the LLM tends to repeat the same nudge two ticks in a row.
      const existing = active.session.suggestions;
      const dup = existing.some(
        (e) => e.title === outcome.suggestion!.title && e.kind === outcome.suggestion!.kind,
      );
      if (dup) continue;
      active.session.suggestions.push(outcome.suggestion);
      mirrorToTab({ suggestion: outcome.suggestion });
    }
  } finally {
    if (active) {
      active.coachInFlight = false;
      // 200ms linger on the thinking pulse — feels anchored rather than glitchy.
      setTimeout(() => { if (active) mirrorToTab({ thinking: null }); }, THINKING_LINGER_MS);
      if (active.coachPending) {
        active.coachPending = false;
        setTimeout(() => void runCoachTick(), 0);
      }
    }
  }
}

// Called whenever a final transcript segment lands. Schedules an immediate
// coach + sentiment refresh so Say-this / Avoid stay in lock-step with the
// conversation instead of waiting up to 15s for the next interval tick.
function scheduleLiveTrigger(): void {
  if (!active) return;
  if (active.liveTriggerTimer) clearTimeout(active.liveTriggerTimer);
  active.liveTriggerTimer = setTimeout(() => {
    if (!active) return;
    const now = Date.now();
    // If a call is in-flight (common with Opus, ~5-9s), runCoachTick/runSentimentTick
    // will set the *Pending flag and re-fire on completion — don't gate on
    // inFlight here, otherwise the call gets dropped and we never catch up.
    if (active.coachInFlight || now - active.lastCoachAt >= LIVE_COACH_MIN_GAP_MS) {
      void runCoachTick();
    }
    if (active.sentimentInFlight || now - active.lastSentimentAt >= LIVE_SENTIMENT_MIN_GAP_MS) {
      void runSentimentTick();
    }
  }, LIVE_TRIGGER_DEBOUNCE_MS) as unknown as number;
}

export function stopBgOrchestrator(): void {
  if (!active) return;
  for (const id of active.timers) clearInterval(id);
  if (active.liveTriggerTimer) clearTimeout(active.liveTriggerTimer);
  active = null;
}

// Called by the service worker whenever the offscreen doc emits a transcript
// segment. We accumulate it into our session so the agents have something to
// chew on.
export function bgAppendTranscript(seg: TranscriptSegment): void {
  if (!active) return;
  const t = active.session.transcript;
  const last = t[t.length - 1];
  if (last && !last.is_final && last.speaker === seg.speaker) {
    t[t.length - 1] = seg;
  } else {
    t.push(seg);
  }
  // Only fire live coach on FINAL segments — partial/interim text mutates
  // every few hundred ms and would burn LLM calls. Final means the speaker
  // paused, which is exactly when fresh coaching is most useful.
  if (seg.is_final && seg.text?.trim()) scheduleLiveTrigger();
}

export function bgUpdateAgenda(items: AgendaItem[]): void {
  if (!active) return;
  active.session.agenda = items;
}

export function bgIsActive(): boolean {
  return active !== null;
}
