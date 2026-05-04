// Post-call summary generator. Runs the full transcript through the LLM once
// the session ends, producing a structured recap + suggested follow-up email
// + suggested CRM note. Council validator gates every factual field.

import { makeLLMClient, resolveLLMConfig } from "../../shared/agents/llm-client";
import type {
  EmailDraft,
  KBEntry,
  MeetingPostCallSummary,
  MeetingSession,
} from "../../shared/types";
import { runLiveCouncilValidator } from "./live-agents";

function safeJson<T>(raw: string): T | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]) as T; } catch { return null; } }
  return null;
}

async function callLLM(system: string, user: string, maxTokens: number): Promise<string> {
  const cfg = resolveLLMConfig();
  if ("error" in cfg) throw new Error(cfg.error);
  return makeLLMClient(cfg).call(system, user, maxTokens);
}

const SYSTEM = `You are a sales meeting reviewer. Read the full transcript of a sales call and produce a structured JSON summary.
Schema:
{
  "headline": "one sentence — did the call advance the deal?",
  "what_went_well": ["short", "bullets"],
  "what_to_improve": ["short", "bullets"],
  "objections_raised": [{"objection": "...", "response_quality": "good|weak|missed"}],
  "action_items": [{"owner": "rep|prospect", "text": "...", "due": "optional ISO date"}],
  "agenda_coverage": [{"item": "...", "status": "pending|in_progress|covered|skipped"}],
  "suggested_followup_email": {"subject": "...", "body": "...", "cta": "...", "tone_notes": ""},
  "suggested_crm_note": "2-3 lines suitable for pasting into CRM"
}
Rules:
- Ground every claim in the transcript. No invented numbers, names, or commitments.
- Tone: direct, specific, no marketing puffery, no emojis.`;

export async function generatePostCallSummary(
  session: MeetingSession,
  kb: KBEntry[],
): Promise<MeetingPostCallSummary> {
  const finals = session.transcript.filter((t) => t.is_final);
  const transcript = finals.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join("\n");

  const agendaJson = JSON.stringify(
    session.agenda.map((a) => ({ title: a.title, status: a.status })),
  );

  const user = `Prospect: ${session.input.company_name} (${session.input.persona_role})
Agenda outcome: ${agendaJson}

Full transcript:
${transcript}

JSON only.`;

  let raw: string;
  try {
    raw = await callLLM(SYSTEM, user, 1200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return emptySummary(session.id, msg);
  }
  const parsed = safeJson<MeetingPostCallSummary & { suggested_followup_email?: EmailDraft }>(raw);
  if (!parsed) {
    return emptySummary(session.id);
  }

  // Council gate on the email and CRM note, since those are the two outputs
  // that could leak into a customer's inbox or CRM.
  const validatedEmail = parsed.suggested_followup_email
    ? await validateEmail(parsed.suggested_followup_email, session, kb)
    : undefined;
  const validatedNote = parsed.suggested_crm_note
    ? await validateNote(parsed.suggested_crm_note, session, kb)
    : undefined;

  return {
    session_id: session.id,
    headline: parsed.headline || "",
    what_went_well: parsed.what_went_well || [],
    what_to_improve: parsed.what_to_improve || [],
    objections_raised: parsed.objections_raised || [],
    action_items: parsed.action_items || [],
    agenda_coverage: parsed.agenda_coverage || session.agenda.map((a) => ({ item: a.title, status: a.status })),
    suggested_followup_email: validatedEmail,
    suggested_crm_note: validatedNote,
    generated_at: new Date().toISOString(),
  };
}

async function validateEmail(email: EmailDraft, session: MeetingSession, kb: KBEntry[]): Promise<EmailDraft | undefined> {
  const outcome = await runLiveCouncilValidator(
    {
      id: `summary-email-${session.id}`,
      kind: "kb_answer",
      title: email.subject,
      body: email.body,
      urgency: "low",
      created_at: Date.now(),
    },
    session,
    kb,
  );
  if (outcome.verdict === "reject" || !outcome.suggestion) return undefined;
  return {
    ...email,
    subject: outcome.suggestion.title || email.subject,
    body: outcome.suggestion.body || email.body,
    sources_used: email.sources_used || [],
  };
}

async function validateNote(note: string, session: MeetingSession, kb: KBEntry[]): Promise<string | undefined> {
  const outcome = await runLiveCouncilValidator(
    {
      id: `summary-note-${session.id}`,
      kind: "kb_answer",
      title: "CRM note",
      body: note,
      urgency: "low",
      created_at: Date.now(),
    },
    session,
    kb,
  );
  return outcome.verdict === "reject" ? undefined : outcome.suggestion?.body;
}

function emptySummary(sessionId: string, reason?: string): MeetingPostCallSummary {
  return {
    session_id: sessionId,
    headline: reason
      ? `Summary unavailable — ${reason}`
      : "Summary unavailable — transcript was empty or the model returned no JSON.",
    what_went_well: [],
    what_to_improve: [],
    objections_raised: [],
    action_items: [],
    agenda_coverage: [],
    generated_at: new Date().toISOString(),
  };
}
