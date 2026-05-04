import { create } from "zustand";
import type {
  MeetingSession,
  MeetingSessionInput,
  MeetingSessionStatus,
  TranscriptSegment,
  SentimentSnapshot,
  CoachSuggestion,
  AgendaItem,
  CalendarEvent,
  CRMContext,
  MeetingPostCallSummary,
} from "../../shared/types";

interface MeetingCopilotState {
  session: MeetingSession | null;
  lastSummary: MeetingPostCallSummary | null;

  // Upcoming events / pre-call prep
  upcomingEvents: CalendarEvent[];
  setUpcomingEvents: (events: CalendarEvent[]) => void;

  crmContext: CRMContext | null;
  setCrmContext: (ctx: CRMContext | null) => void;

  // Session lifecycle
  prepareSession: (input: MeetingSessionInput, tabId?: number) => void;
  setStatus: (status: MeetingSessionStatus, error?: string) => void;
  endSession: () => void;
  resetSession: () => void;

  // Live updates
  appendTranscript: (seg: TranscriptSegment) => void;
  pushSuggestion: (s: CoachSuggestion) => void;
  dismissSuggestion: (id: string) => void;
  markSuggestionActed: (id: string) => void;
  pushSentiment: (s: SentimentSnapshot) => void;
  updateAgenda: (items: AgendaItem[]) => void;

  // Post-call
  setSummary: (summary: MeetingPostCallSummary | null) => void;
}

function makeId(): string {
  return `mc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useMeetingCopilotStore = create<MeetingCopilotState>((set) => ({
  session: null,
  lastSummary: null,
  upcomingEvents: [],
  crmContext: null,

  setUpcomingEvents: (events) => set({ upcomingEvents: events }),
  setCrmContext: (ctx) => set({ crmContext: ctx }),

  prepareSession: (input, tabId) =>
    set({
      session: {
        id: makeId(),
        status: "preparing",
        platform: "google_meet",
        tab_id: tabId,
        input,
        transcript: [],
        sentiment_history: [],
        suggestions: [],
        agenda: input.agenda.map((a) => ({ ...a, status: a.status || "pending" })),
      },
      lastSummary: null,
    }),

  setStatus: (status, error) =>
    set((s) => {
      if (!s.session) return s;
      const patch: Partial<MeetingSession> = { status };
      if (status === "listening" && !s.session.started_at) patch.started_at = new Date().toISOString();
      if (status === "ended") patch.ended_at = new Date().toISOString();
      if (error) patch.error = error;
      return { session: { ...s.session, ...patch } };
    }),

  endSession: () =>
    set((s) => {
      if (!s.session) return s;
      return {
        session: { ...s.session, status: "ended", ended_at: new Date().toISOString() },
      };
    }),

  resetSession: () => set({ session: null, lastSummary: null }),

  appendTranscript: (seg) =>
    set((s) => {
      if (!s.session) return s;
      // Replace trailing interim of same speaker with latest, else append.
      const trimmed = s.session.transcript.slice();
      const last = trimmed[trimmed.length - 1];
      if (last && !last.is_final && last.speaker === seg.speaker && !seg.is_final) {
        trimmed[trimmed.length - 1] = seg;
      } else if (last && !last.is_final && last.speaker === seg.speaker && seg.is_final) {
        trimmed[trimmed.length - 1] = seg;
      } else {
        trimmed.push(seg);
      }
      return { session: { ...s.session, transcript: trimmed } };
    }),

  pushSuggestion: (sug) =>
    set((s) => {
      if (!s.session) return s;
      // Dedupe by title to avoid repeat nags.
      const existing = s.session.suggestions.find(
        (x) => !x.dismissed && !x.acted_on && x.title === sug.title,
      );
      if (existing) return s;
      return { session: { ...s.session, suggestions: [...s.session.suggestions, sug] } };
    }),

  dismissSuggestion: (id) =>
    set((s) => {
      if (!s.session) return s;
      return {
        session: {
          ...s.session,
          suggestions: s.session.suggestions.map((x) =>
            x.id === id ? { ...x, dismissed: true } : x,
          ),
        },
      };
    }),

  markSuggestionActed: (id) =>
    set((s) => {
      if (!s.session) return s;
      return {
        session: {
          ...s.session,
          suggestions: s.session.suggestions.map((x) =>
            x.id === id ? { ...x, acted_on: true } : x,
          ),
        },
      };
    }),

  pushSentiment: (sent) =>
    set((s) => {
      if (!s.session) return s;
      return { session: { ...s.session, sentiment_history: [...s.session.sentiment_history, sent] } };
    }),

  updateAgenda: (items) =>
    set((s) => {
      if (!s.session) return s;
      return { session: { ...s.session, agenda: items } };
    }),

  setSummary: (summary) => set({ lastSummary: summary }),
}));
