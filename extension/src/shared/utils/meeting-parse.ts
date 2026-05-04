/**
 * Parse a pasted meeting invite (URL, .ics body, raw email text) into the
 * fields the meeting copilot needs: company, persona role, title, notes,
 * agenda items.
 *
 * A bare Google Meet URL has no metadata — the parser returns what it can
 * (often nothing) and the caller falls back to manual entry. Calendar event
 * URLs without OAuth access are treated the same way.
 *
 * The actual extraction runs through the user's configured LLM so it works
 * across Outlook / Apple Calendar / Google Calendar / forwarded text.
 */

import { makeLLMClient, resolveLLMConfig } from "../agents/llm-client";
import type { AgendaItem } from "../types";

export interface ParsedInvite {
  company_name?: string;
  persona_role?: string;
  meeting_title?: string;
  meeting_notes?: string;
  agenda?: AgendaItem[];
}

const SYSTEM = `You extract structured sales-meeting context from a pasted calendar invite, email, or URL.

Return ONLY a JSON object with these keys (omit any you cannot infer):
{
  "company_name": string,        // prospect's company, NOT the rep's company
  "persona_role": string,        // primary attendee's role, e.g. "VP Engineering", "CFO"
  "meeting_title": string,       // calendar subject / event title
  "meeting_notes": string,       // 1-3 sentences of useful context (last call outcome, stakeholders, key questions). Pulled from the invite body.
  "agenda": [{ "title": string, "priority": "must_cover" | "should_cover" | "nice_to_have" }]
}

Rules:
- If the input is just a bare URL with no other text, return {}.
- Do not invent agenda items. Pull them from explicit bullet/numbered lists in the invite body. Default priority is "should_cover".
- For company_name, prefer the external attendee's email domain over the rep's domain. Skip free-mail domains (gmail/outlook/yahoo).
- Do not include the rep / sender as the persona unless the invite is clearly internal.
- Output JSON only, no prose, no code fences.`;

function extractJsonBlock(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

function coerceAgenda(raw: unknown): AgendaItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AgendaItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const item = r as { title?: unknown; priority?: unknown };
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const p = item.priority;
    const priority: AgendaItem["priority"] =
      p === "must_cover" || p === "should_cover" || p === "nice_to_have" ? p : "should_cover";
    out.push({
      id: `agenda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${out.length}`,
      title,
      priority,
      status: "pending",
    });
  }
  return out;
}

export async function parsePastedInvite(input: string): Promise<ParsedInvite> {
  const text = input.trim();
  if (!text) return {};

  const cfg = resolveLLMConfig();
  if ("error" in cfg) {
    throw new Error(cfg.error);
  }
  const client = makeLLMClient(cfg);
  const raw = await client.call(SYSTEM, text, 800);
  const json = extractJsonBlock(raw);

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }

  const result: ParsedInvite = {};
  if (typeof parsed.company_name === "string" && parsed.company_name.trim()) {
    result.company_name = parsed.company_name.trim();
  }
  if (typeof parsed.persona_role === "string" && parsed.persona_role.trim()) {
    result.persona_role = parsed.persona_role.trim();
  }
  if (typeof parsed.meeting_title === "string" && parsed.meeting_title.trim()) {
    result.meeting_title = parsed.meeting_title.trim();
  }
  if (typeof parsed.meeting_notes === "string" && parsed.meeting_notes.trim()) {
    result.meeting_notes = parsed.meeting_notes.trim();
  }
  const agenda = coerceAgenda(parsed.agenda);
  if (agenda.length) result.agenda = agenda;

  return result;
}
