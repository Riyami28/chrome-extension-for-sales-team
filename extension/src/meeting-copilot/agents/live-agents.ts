// Three lightweight live agents that run against the rolling transcript:
//   1. Sentiment — tone/engagement snapshot.
//   2. Agenda tracker — marks items covered as they come up.
//   3. Coach — suggests "say next" / "avoid" / objection handling.
//
// Each agent is a pure function over (session state, KB) that returns
// an incremental update. Orchestration cadence lives in live-orchestrator.ts.

import { embedText, makeLLMClient, resolveLLMConfig, type LLMProvider } from "../../shared/agents/llm-client";
import type {
  AgendaItem,
  CoachSuggestion,
  MeetingSession,
  SentimentSnapshot,
  TranscriptSegment,
  KBEntry,
} from "../../shared/types";
import { searchChunks, type SearchHit } from "../../shared/utils/kb-vector-store";
import { computeWikiCoachMap } from "../../shared/utils/wiki-index";

const WINDOW_CHARS = 2400;
// Live agents (coach + sentiment) only need the last few turns to stay in
// lock-step with the conversation. Trimming to last-5-segments cuts input
// tokens ~6× and Haiku latency from ~2s to ~800ms.
const LIVE_WINDOW_SEGMENTS = 5;
const LIVE_WINDOW_CHARS = 800;

function rollingWindow(transcript: TranscriptSegment[]): string {
  const finals = transcript.filter((t) => t.is_final);
  const joined = finals.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
  return joined.length > WINDOW_CHARS ? joined.slice(-WINDOW_CHARS) : joined;
}

// Tight window for live coach + sentiment — last 5 final segments only,
// hard-capped at 800 chars so the prompt stays small even if someone
// monologues. Council/email path still uses the full rollingWindow.
function liveWindow(transcript: TranscriptSegment[]): string {
  const finals = transcript.filter((t) => t.is_final);
  const tail = finals.slice(-LIVE_WINDOW_SEGMENTS);
  const joined = tail.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
  return joined.length > LIVE_WINDOW_CHARS ? joined.slice(-LIVE_WINDOW_CHARS) : joined;
}

// Per-provider fast-tier model. Live agents use this; council/email keep
// whatever the user picked in Settings.
const LIVE_MODELS: Record<LLMProvider, string | undefined> = {
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.0-flash-lite",
  groq: "llama-3.1-8b-instant",
  ollama: undefined,   // user's local model
  custom: undefined,   // user's custom endpoint
};

function liveModelOverride(): { provider: LLMProvider; model: string } | undefined {
  const cfg = resolveLLMConfig();
  if ("error" in cfg) return undefined;
  const fast = LIVE_MODELS[cfg.provider];
  if (!fast) return undefined;
  return { provider: cfg.provider, model: fast };
}

function safeJson<T>(raw: string): T | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]) as T; } catch { /* fall through */ }
  }
  // Log the head of the raw output so we can see which model/provider is
  // producing bad JSON without silently dropping the coach.
  console.warn("[live-agents] JSON parse failed, raw head:", raw.slice(0, 200));
  return null;
}

// Plain-text fallback: if JSON parsing fails for a coach response, try to
// salvage the first sentence as a raw "say next" suggestion rather than
// leaving the rep with nothing on screen.
function firstSentenceFallback(raw: string): string | null {
  const cleaned = raw.replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  // Skip anything that looks like leftover JSON braces.
  const prose = cleaned.replace(/[{}\[\]"]/g, " ").trim();
  if (!prose) return null;
  const first = prose.split(/(?<=[.!?])\s/)[0]?.trim();
  return first && first.length > 8 ? first.slice(0, 180) : null;
}

async function callLLM(system: string, user: string, maxTokens = 500): Promise<string> {
  const cfg = resolveLLMConfig();
  if ("error" in cfg) throw new Error(cfg.error);
  const client = makeLLMClient(cfg);
  return client.call(system, user, maxTokens);
}

// Fast-tier LLM call for live agents. Uses Haiku/flash-lite/8B etc.
// `onDelta` (optional) streams partial text as tokens arrive — used by the
// coach to render a live "thinking" preview in the transponder.
async function callLiveLLM(
  system: string,
  user: string,
  maxTokens = 400,
  onDelta?: (delta: string, full: string) => void,
): Promise<string> {
  const cfg = resolveLLMConfig(liveModelOverride());
  if ("error" in cfg) throw new Error(cfg.error);
  const client = makeLLMClient(cfg);
  if (onDelta && client.callStream) return client.callStream(system, user, maxTokens, onDelta);
  return client.call(system, user, maxTokens);
}

// ─── KB retrieval (semantic + lexical fallback) ─────────────────────────────
//
// Three consumers (coach, validator, Ask KB) all need "give me the top-K most
// relevant KB excerpts for this query." Behaviour:
//   1. Embed query via Gemini, cosine-search the IndexedDB chunk store.
//   2. For any KBEntry whose index_status !== "ready", fall back to a cheap
//      lexical match against raw `content` so the rep doesn't lose access to
//      un-indexed entries (e.g. just-uploaded files mid-call).
//   3. If the embed call itself throws (no Gemini key, quota hit), degrade
//      gracefully to pure lexical for the whole KB.
//
// Returns objects shaped like the LLM-prompt snippets we used to build by
// hand, so the call sites just JSON.stringify the result.

export interface RetrievedSnippet {
  id: string;            // kb_entry_id (carries through to source citations)
  name: string;
  namespace: string;
  excerpt: string;
  score?: number;        // cosine score when from vector store; lexical = match count
}

function lexicalFallback(query: string, entries: KBEntry[], topK: number, maxChars: number): RetrievedSnippet[] {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  if (terms.length === 0) {
    return entries.slice(0, topK).map((e) => ({
      id: e.id, name: e.name, namespace: e.namespace, excerpt: (e.content || "").slice(0, maxChars), score: 0,
    }));
  }
  return entries
    .map((entry) => {
      const hay = `${entry.name}\n${entry.content || ""}`.toLowerCase();
      const score = terms.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => ({
      id: r.entry.id,
      name: r.entry.name,
      namespace: r.entry.namespace,
      excerpt: (r.entry.content || "").slice(0, maxChars),
      score: r.score,
    }));
}

async function retrieveKB(
  query: string,
  kb: KBEntry[],
  topK: number,
  maxCharsPerSnippet = 500,
): Promise<RetrievedSnippet[]> {
  if (!query.trim() || kb.length === 0) return [];

  const indexedIds = new Set(kb.filter((e) => e.index_status === "ready").map((e) => e.id));
  const unindexed = kb.filter((e) => !indexedIds.has(e.id));

  // No indexed entries at all → pure lexical, same shape as before.
  if (indexedIds.size === 0) {
    return lexicalFallback(query, kb, topK, maxCharsPerSnippet);
  }

  let semanticHits: SearchHit[] = [];
  try {
    const queryVec = await embedText(query);
    semanticHits = await searchChunks(queryVec, topK, [...indexedIds]);
  } catch (err) {
    // Embed failed (key bad, quota, network). Fall through to lexical for
    // the whole KB so the rep still gets *something*.
    console.warn("[live-agents] embed failed, falling back to lexical:", err);
    return lexicalFallback(query, kb, topK, maxCharsPerSnippet);
  }

  const semantic: RetrievedSnippet[] = semanticHits.map((h) => ({
    id: h.entryId,
    name: h.entryName,
    namespace: h.namespace,
    excerpt: h.text.length > maxCharsPerSnippet ? h.text.slice(0, maxCharsPerSnippet) : h.text,
    score: h.score,
  }));

  // Top up with lexical hits from un-indexed entries so newly-added KB isn't
  // invisible while it's still indexing.
  const remaining = topK - semantic.length;
  if (remaining > 0 && unindexed.length > 0) {
    const lex = lexicalFallback(query, unindexed, remaining, maxCharsPerSnippet);
    return [...semantic, ...lex];
  }
  return semantic;
}

// ─── Sentiment ──────────────────────────────────────────────────────────────
const SENTIMENT_SYSTEM = `You analyze live sales call conversations.
Return a compact JSON object only, no prose. Schema:
{
  "prospect": "positive|neutral|negative|mixed",
  "rep": "positive|neutral|negative|mixed",
  "energy": "low|medium|high",
  "engagement": "low|medium|high",
  "signals": ["short", "tags"],
  "rationale": "one short sentence"
}
Signals should be short labels like "price-sensitive", "skeptical", "buying-signals", "unfocused", "technical-deep-dive", "competitor-mentioned", "objection".`;

export async function runSentimentAgent(session: MeetingSession): Promise<SentimentSnapshot | null> {
  if (session.transcript.length < 2) return null;
  const window = liveWindow(session.transcript);
  if (!window.trim()) return null;

  const user = `Conversation so far (rep = our salesperson, prospect = buyer):\n\n${window}\n\nAnalyze the last few turns. JSON only.`;
  let raw = "";
  try { raw = await callLiveLLM(SENTIMENT_SYSTEM, user, 250); } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const parsed = safeJson<{
    prospect: SentimentSnapshot["prospect"];
    rep: SentimentSnapshot["rep"];
    energy: SentimentSnapshot["energy"];
    engagement: SentimentSnapshot["engagement"];
    signals: string[];
    rationale: string;
  }>(raw);
  if (!parsed) return null;

  const capturedAt = session.transcript[session.transcript.length - 1]?.ts_end || 0;
  return {
    id: `sent-${capturedAt}`,
    captured_at: capturedAt,
    prospect: parsed.prospect,
    rep: parsed.rep,
    energy: parsed.energy,
    engagement: parsed.engagement,
    signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 6) : [],
    rationale: parsed.rationale,
  };
}

// ─── Agenda tracker ─────────────────────────────────────────────────────────
const AGENDA_SYSTEM = `You track whether a salesperson has covered each planned agenda item based on the live call transcript.
Return JSON only with shape:
{ "updates": [{ "id": "<agenda id>", "status": "pending|in_progress|covered|skipped", "evidence_segment_ids": ["<seg id>", ...] }] }
Only include items whose status should change from their current value.`;

export async function runAgendaTracker(session: MeetingSession): Promise<AgendaItem[] | null> {
  if (!session.agenda.length) return null;
  const window = rollingWindow(session.transcript);
  if (!window.trim()) return null;

  const agendaJson = JSON.stringify(
    session.agenda.map((a) => ({ id: a.id, title: a.title, description: a.description, status: a.status })),
  );
  const user = `Planned agenda:\n${agendaJson}\n\nTranscript window:\n${window}\n\nWhich items changed status? JSON only.`;
  let raw = "";
  try { raw = await callLLM(AGENDA_SYSTEM, user, 400); } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const parsed = safeJson<{ updates: { id: string; status: AgendaItem["status"]; evidence_segment_ids?: string[] }[] }>(raw);
  if (!parsed?.updates?.length) return null;

  const byId = new Map(parsed.updates.map((u) => [u.id, u]));
  const lastSegEnd = session.transcript[session.transcript.length - 1]?.ts_end;
  return session.agenda.map((item) => {
    const upd = byId.get(item.id);
    if (!upd) return item;
    return {
      ...item,
      status: upd.status,
      covered_at_ms: upd.status === "covered" ? item.covered_at_ms ?? lastSegEnd : item.covered_at_ms,
      evidence_segment_ids: upd.evidence_segment_ids?.length ? upd.evidence_segment_ids : item.evidence_segment_ids,
    };
  });
}

// ─── Coach ─────────────────────────────────────────────────────────────────
const COACH_SYSTEM = `You are a real-time sales coach whispering in the rep's ear during a live call.
Output JSON only: { "suggestions": [ ... ] }
Each suggestion:
{
  "kind": "say_next|avoid|ask_question|handle_objection|cover_agenda|kb_answer|sentiment_shift",
  "title": "short label shown on the transponder (<= 6 words)",
  "body": "what to actually say or do (1-2 short sentences)",
  "urgency": "low|medium|high",
  "rationale": "one short sentence naming the trigger from the transcript — e.g. 'Prospect hesitated when timeline came up'",
  "sources": [{"kb_entry_id": "...", "quote": "..."}]
}
Rules:
- At most 2 suggestions per call.
- Only urgent suggestions (high) if the prospect just raised an objection or a buying signal.
- Quote KB entries verbatim when grounding an answer.
- Never invent facts. If KB does not support a claim, skip.
- ALWAYS include a rationale — the rep needs to know *why* you raised this.`;

export async function runCoachAgent(
  session: MeetingSession,
  kb: KBEntry[],
  onPreview?: (text: string) => void,
): Promise<CoachSuggestion[]> {
  if (session.transcript.length === 0) return [];
  const window = liveWindow(session.transcript);
  if (!window.trim()) return [];

  // Two-layer KB grounding (Karpathy-style wiki map + RAG drill-down):
  //   1. Wiki map = TLDRs + top concepts. Tiny, sent for the WHOLE KB.
  //      Coach uses this to know what the KB CONTAINS.
  //   2. Cosine retrieval = top chunks for actual quoting / detail.
  // Total prompt budget is similar to before but coverage is much wider.
  const wikiMap = computeWikiCoachMap(kb, 24);
  const kbSnippets = await retrieveKB(window, kb, 4, 240);

  const pending = session.agenda.filter((a) => a.status === "pending" || a.status === "in_progress");
  const lastSentiment = session.sentiment_history[session.sentiment_history.length - 1];

  const user = `Prospect: ${session.input.company_name} (${session.input.persona_role})
Pending agenda: ${JSON.stringify(pending.map((p) => p.title))}
Last sentiment: ${lastSentiment ? JSON.stringify(lastSentiment) : "none"}

KB wiki map (titles + tldrs — use to know what we have, not for quoting):
${JSON.stringify(wikiMap.toc)}
Top concepts: ${JSON.stringify(wikiMap.top_concepts)}

KB excerpts most relevant to the current transcript window (use these to ground specific claims):
${JSON.stringify(kbSnippets)}

Live transcript (latest chunk):
${window}

Produce JSON only.`;

  // Streaming preview: extract whatever sits inside the latest "body":"..."
  // partial as tokens land. Lets the transponder show the answer being
  // typed live instead of waiting for the full JSON to parse.
  const streamCb = onPreview
    ? (_delta: string, full: string) => {
        const m = full.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)$/);
        if (m) onPreview(m[1].replace(/\\n/g, " ").replace(/\\"/g, '"'));
      }
    : undefined;

  let raw = "";
  try { raw = await callLiveLLM(COACH_SYSTEM, user, 500, streamCb); } catch (err) {
    // Rethrow so the orchestrator can count consecutive failures and surface
    // a banner. Returning [] silently hid kill-switch conditions (wrong key,
    // quota hit, stalled stream) from the user.
    throw err instanceof Error ? err : new Error(String(err));
  }
  const parsed = safeJson<{
    suggestions: {
      kind: CoachSuggestion["kind"];
      title: string;
      body: string;
      urgency: CoachSuggestion["urgency"];
      rationale?: string;
      sources?: { kb_entry_id: string; quote: string }[];
    }[];
  }>(raw);

  const lastTs = session.transcript[session.transcript.length - 1]?.ts_end || 0;
  const triggerId = session.transcript[session.transcript.length - 1]?.id;

  if (!parsed?.suggestions?.length) {
    // JSON parse failed — try to salvage a plain-text nudge so the rep sees
    // *something* rather than a blank card.
    const fallback = firstSentenceFallback(raw);
    if (!fallback) return [];
    return [{
      id: `coach-${lastTs}-fallback`,
      kind: "say_next" as const,
      title: "Coach nudge",
      body: fallback,
      urgency: "low" as const,
      created_at: lastTs,
      expires_at: lastTs + 45_000,
      trigger_segment_id: triggerId,
      rationale: "LLM returned malformed JSON — salvaged first sentence.",
    }];
  }

  return parsed.suggestions.slice(0, 2).map((s, i) => ({
    id: `coach-${lastTs}-${i}`,
    kind: s.kind,
    title: s.title,
    body: s.body,
    urgency: s.urgency,
    created_at: lastTs,
    expires_at: lastTs + 45_000,
    sources: s.sources,
    rationale: s.rationale,
    trigger_segment_id: triggerId,
  }));
}

// ─── Live Council Validator ────────────────────────────────────────────────
// Every coach suggestion passes through this before reaching the transponder.
// Mirrors the post-call council's validation agent: strips hallucinations,
// flags brand violations, rewrites if grounding exists.
const VALIDATOR_SYSTEM = `You are the live-call council validator. You review a single coach suggestion before it is shown to a salesperson mid-call.
Return JSON only:
{
  "verdict": "approve|revise|reject",
  "confidence": 0..1,
  "issues": ["short", "reasons"],
  "revised": { "title": "...", "body": "..." }  // only if verdict="revise"
}
Rules:
- REJECT if the body makes a factual claim not supported by the KB snippets below.
- REJECT if the body invents a customer name, metric, price, or roadmap item.
- REVISE if the suggestion is directionally right but over-promises; rewrite to be grounded.
- APPROVE if the suggestion is purely a coaching nudge (e.g. "ask about their timeline") with no factual claims needed.
- Brand voice: clear, specific, no marketing puffery, no emojis.`;

export interface LiveValidationOutcome {
  verdict: "approve" | "revise" | "reject";
  confidence: number;
  issues: string[];
  suggestion: CoachSuggestion | null;
}

// Cache validator verdicts by suggestion hash for 30s — the coach re-fires
// on every final segment and tends to produce identical nudges two ticks in
// a row. Without this we pay ~300 tokens + a round-trip per duplicate.
const VALIDATOR_CACHE = new Map<string, { outcome: LiveValidationOutcome; ts: number }>();
const VALIDATOR_TTL_MS = 30_000;

function validatorKey(s: CoachSuggestion): string {
  return `${s.kind}|${s.title}|${s.body}`;
}

function getCachedVerdict(s: CoachSuggestion): LiveValidationOutcome | null {
  const hit = VALIDATOR_CACHE.get(validatorKey(s));
  if (!hit) return null;
  if (Date.now() - hit.ts > VALIDATOR_TTL_MS) { VALIDATOR_CACHE.delete(validatorKey(s)); return null; }
  return hit.outcome;
}

function cacheVerdict(s: CoachSuggestion, outcome: LiveValidationOutcome): void {
  VALIDATOR_CACHE.set(validatorKey(s), { outcome, ts: Date.now() });
  // Prevent unbounded growth during long calls.
  if (VALIDATOR_CACHE.size > 200) {
    const oldest = [...VALIDATOR_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) VALIDATOR_CACHE.delete(oldest[0]);
  }
}

export async function runLiveCouncilValidator(
  suggestion: CoachSuggestion,
  session: MeetingSession,
  kb: KBEntry[],
): Promise<LiveValidationOutcome> {
  const cached = getCachedVerdict(suggestion);
  if (cached) return cached;

  // Validator needs grounding for the *suggestion* — pull KB chunks that
  // semantically match the suggestion's body, not just whatever the coach
  // happened to cite. This catches over-promises that aren't supported.
  const validatorQuery = `${suggestion.title}\n${suggestion.body}`;
  const kbSnippets = await retrieveKB(validatorQuery, kb, 8, 360);

  const user = `Prospect: ${session.input.company_name} (${session.input.persona_role})

Suggestion under review:
${JSON.stringify({ kind: suggestion.kind, title: suggestion.title, body: suggestion.body, sources: suggestion.sources })}

KB grounding available:
${JSON.stringify(kbSnippets)}

Review the suggestion. JSON only.`;

  let raw = "";
  try { raw = await callLLM(VALIDATOR_SYSTEM, user, 400); } catch (err) {
    console.debug("[live-validator] LLM error", err);
    // Fail-safe: if the validator can't run, only let pure coaching nudges through.
    const lowRisk = suggestion.kind === "ask_question" || suggestion.kind === "cover_agenda" || suggestion.kind === "sentiment_shift";
    const outcome: LiveValidationOutcome = {
      verdict: lowRisk ? "approve" : "reject",
      confidence: 0.2,
      issues: ["validator_unavailable"],
      suggestion: lowRisk ? { ...suggestion, confidence: 0.2 } : null,
    };
    // Don't cache validator_unavailable — we want to retry next call.
    return outcome;
  }
  const parsed = safeJson<{
    verdict: "approve" | "revise" | "reject";
    confidence: number;
    issues?: string[];
    revised?: { title?: string; body?: string };
  }>(raw);
  if (!parsed) {
    const outcome: LiveValidationOutcome = {
      verdict: "reject",
      confidence: 0,
      issues: ["unparseable_validator_response"],
      suggestion: null,
    };
    cacheVerdict(suggestion, outcome);
    return outcome;
  }

  let outcome: LiveValidationOutcome;
  if (parsed.verdict === "reject") {
    outcome = { verdict: "reject", confidence: parsed.confidence, issues: parsed.issues || [], suggestion: null };
  } else if (parsed.verdict === "revise" && parsed.revised) {
    outcome = {
      verdict: "revise",
      confidence: parsed.confidence,
      issues: parsed.issues || [],
      suggestion: {
        ...suggestion,
        title: parsed.revised.title || suggestion.title,
        body: parsed.revised.body || suggestion.body,
        confidence: parsed.confidence,
      },
    };
  } else {
    outcome = {
      verdict: "approve",
      confidence: parsed.confidence,
      issues: parsed.issues || [],
      suggestion: { ...suggestion, confidence: parsed.confidence },
    };
  }
  cacheVerdict(suggestion, outcome);
  return outcome;
}

// Agent registry — surfaces the live council in the UI and debug logs.
export const LIVE_COUNCIL_AGENTS = [
  { id: "live_sentiment", label: "Sentiment Agent" },
  { id: "live_agenda_tracker", label: "Agenda Tracker" },
  { id: "live_coach", label: "Live Coach" },
  { id: "live_validator", label: "Live Validator" },
] as const;

// ─── Push-to-ask KB ────────────────────────────────────────────────────────
// Rep types a question on the transponder mid-call. Retrieve → answer →
// validate via the same council gate, then return the approved answer.
const KB_ASK_SYSTEM = `You answer a salesperson's live question using ONLY the KB snippets provided.
Return JSON only:
{ "answer": "one or two crisp sentences", "sources": [{"kb_entry_id": "...", "quote": "..."}] }
Rules:
- If the KB does not answer the question, return { "answer": "Not in KB.", "sources": [] }.
- Never invent. Quote KB verbatim when grounding.`;

export async function runLiveKbAsk(
  question: string,
  session: MeetingSession,
  kb: KBEntry[],
): Promise<{ answer: string; sources?: { kb_entry_id: string; quote: string }[]; rejected?: boolean }> {
  const q = question.trim();
  if (!q) return { answer: "Empty question." };

  // Semantic top-K with lexical fallback for un-indexed entries. Replaces
  // the old keyword prefilter, which missed paraphrases (e.g. "how much for
  // big customers?" never matched a chunk titled "enterprise pricing").
  const kbJson = await retrieveKB(q, kb, 6, 500);

  const user = `Question: ${q}\n\nKB:\n${JSON.stringify(kbJson)}\n\nJSON only.`;

  // Mid-call latency budget is tight — the rep asked while the prospect is
  // talking. Use the fast live-tier model (haiku/flash-lite) and skip the
  // validator pass: the answer prompt already enforces "quote KB verbatim,
  // never invent," which is enough for a quick-look in-call answer. The
  // earlier 2-call (answer + council) flow took ~6-10s and was unusable
  // live. `session` is intentionally unused now but kept in the signature
  // for callers that may re-add validation later.
  void session;
  let raw = "";
  try { raw = await callLiveLLM(KB_ASK_SYSTEM, user, 350); } catch (err) {
    return { answer: `Error: ${String(err)}` };
  }
  const parsed = safeJson<{ answer: string; sources?: { kb_entry_id: string; quote: string }[] }>(raw);
  if (!parsed?.answer) return { answer: "No answer available." };
  return { answer: parsed.answer, sources: parsed.sources };
}
