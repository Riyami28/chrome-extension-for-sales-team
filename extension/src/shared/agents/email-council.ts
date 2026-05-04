/**
 * Email drafting council. Lighter than the pitch council:
 *   1. Retrieval    — pull KB relevant to intent + persona
 *   2. Draft        — produce subject / body / cta grounded in sources
 *   3. Brand check  — voice compliance (banned words, tone)
 *   4. Validation   — every claim traceable to a source
 *
 * Emits the same CouncilEvent shape as the pitch council so the UI can reuse
 * progress rendering. `done` event carries EmailPipelineResult.
 */

import type {
  AgentResult,
  EmailInput,
  EmailDraft,
  EmailPipelineResult,
  KBEntry,
  ICPRole,
} from "../types";
import { ICP_PROFILES } from "../constants/icp-profiles";
import { type LLMClient, makeLLMClient, resolveLLMConfig, type LLMProvider } from "./llm-client";
import { extractJson } from "./council";

export type EmailCouncilEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "agent"; result: AgentResult }
  | { type: "done"; pipeline: EmailPipelineResult }
  | { type: "error"; message: string };

function matchICP(role: string): ICPRole {
  const n = role.toLowerCase();
  const map: [RegExp, ICPRole][] = [
    [/cfo|finance|controller|treasurer/, "cfo"],
    [/cto|architect|chief tech/, "cto"],
    [/coo|operations/, "coo"],
    [/vp sales|cro|revenue/, "vp_sales"],
    [/vp eng|engineering|platform|devops|sre|finops/, "vp_engineering"],
    [/ceo|founder|president/, "ceo"],
    [/procure|purchasing/, "procurement"],
  ];
  for (const [re, r] of map) if (re.test(n)) return r;
  return "cfo";
}

function summarizeKB(kb: KBEntry[], limit = 10): string {
  if (!kb.length) return "(knowledge base is empty)";
  return kb
    .slice(0, limit)
    .map((e, i) => `--- SOURCE ${i + 1} · ns=${e.namespace} · id=${e.id} · "${e.name}" ---\n${e.content.slice(0, 1200)}`)
    .join("\n\n");
}

function filterKBForIntent(kb: KBEntry[], input: EmailInput): KBEntry[] {
  const ready = kb.filter((e) => e.status === "ready");
  const priority: Record<string, string[]> = {
    intro: ["product_overview", "industry_pages", "case_studies"],
    follow_up: ["roi_pricing", "case_studies", "product_overview"],
    post_call: ["roi_pricing", "product_overview"],
    objection: ["battlecard", "security_compliance", "case_studies"],
    close: ["roi_pricing", "case_studies"],
    custom: ["product_overview"],
  };
  const preferred = priority[input.intent] ?? [];
  return ready.sort((a, b) => {
    const ai = preferred.indexOf(a.namespace);
    const bi = preferred.indexOf(b.namespace);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

async function retrievalAgent(
  client: LLMClient,
  input: EmailInput,
  kb: KBEntry[],
): Promise<AgentResult & { relevant_ids: string[] }> {
  const filtered = filterKBForIntent(kb, input);
  if (!filtered.length) {
    return {
      agent: "retrieval",
      status: "fail",
      output: { relevant_source_ids: [] },
      issues: ["KB is empty — seed it before drafting"],
      confidence: 0,
      relevant_ids: [],
    };
  }

  const system = `You are the Retrieval Agent. Pick KB sources that support an email for this intent and persona. Output strict JSON only.`;
  const user = `INTENT: ${input.intent}
RECIPIENT: ${input.recipient_name} · ${input.persona_role} at ${input.company_name}
CONTEXT: ${input.context}
${input.thread_excerpt ? `THREAD EXCERPT:\n${input.thread_excerpt}\n` : ""}
KB:
${summarizeKB(filtered, 12)}

Return JSON: {"relevant_source_ids": ["id1","id2"], "reason": "one line"}`;

  const text = await client.call(system, user, 1500);
  const parsed = extractJson<{ relevant_source_ids: string[] }>(text);
  const ids = parsed?.relevant_source_ids ?? filtered.slice(0, 4).map((e) => e.id);
  return {
    agent: "retrieval",
    status: ids.length ? "pass" : "warning",
    output: { relevant_source_ids: ids },
    confidence: parsed ? 0.9 : 0.5,
    relevant_ids: ids,
  };
}

async function draftAgent(
  client: LLMClient,
  input: EmailInput,
  kb: KBEntry[],
  relevantIds: string[],
): Promise<AgentResult & { draft: EmailDraft }> {
  const icp = matchICP(input.persona_role);
  const profile = ICP_PROFILES.find((p) => p.role === icp);
  const used = kb.filter((e) => relevantIds.includes(e.id));

  const intentHint: Record<typeof input.intent, string> = {
    intro: "Cold intro — pattern-match their industry + persona to a specific ClientLens outcome, offer a 20-min call. No product dump.",
    follow_up: "Polite follow-up after silence. Add one new data point or case study. Soft CTA.",
    post_call: "Post-call recap. Mirror what they said, confirm next steps, attach proof points for anything flagged.",
    objection: "Handle the objection with specific facts. Don't argue — reframe with a comparable customer.",
    close: "Close nudge. Re-anchor the ROI math. Propose a 30-day pilot if not already on the table.",
    custom: "Follow the user's custom instruction.",
  };

  const system = `You are the Email Drafting Agent for ClientLens sales. Produce a concise, grounded email. No hype words ("revolutionary", "game-changing", "best-in-class"). Every numeric claim cites a source_id. Output strict JSON only.`;
  const user = `TONE RULES (persona=${profile?.label ?? input.persona_role}):
Lead with: ${profile?.content_rules.lead_with.join(", ") ?? "business outcomes"}
Avoid: ${profile?.content_rules.avoid.join(", ") ?? "jargon"}
Voice: ${profile?.content_rules.tone ?? "direct, numbers-first"}

INTENT: ${input.intent} — ${intentHint[input.intent]}
RECIPIENT: ${input.recipient_name}
CONTEXT: ${input.context}
${input.deal_size ? `DEAL SIZE: ${input.deal_size}` : ""}
${input.competitor ? `COMPETITOR: ${input.competitor}` : ""}
${input.thread_excerpt ? `THREAD EXCERPT:\n${input.thread_excerpt}` : ""}
${input.custom_instruction ? `CUSTOM INSTRUCTION: ${input.custom_instruction}` : ""}

SOURCES (cite source_id on claims):
${summarizeKB(used, 8)}

Return JSON:
{
  "subject": "...",            // under 60 chars, no emoji, no clickbait
  "body": "...",               // plain text, 80-140 words, paragraphs separated by \\n\\n
  "cta": "...",                // single sentence, one ask
  "tone_notes": "...",         // one line — why this hits the persona
  "sources_used": ["id1"]
}`;

  const text = await client.call(system, user, 1800);
  const parsed = extractJson<EmailDraft>(text);
  if (!parsed?.subject || !parsed?.body) {
    return {
      agent: "icp_personalization",
      status: "fail",
      output: { error: "draft not parseable" },
      issues: ["Draft agent did not return subject/body"],
      confidence: 0,
      draft: { subject: "", body: "", cta: "", sources_used: [] },
    };
  }
  const draft: EmailDraft = {
    subject: parsed.subject.trim(),
    body: parsed.body.trim(),
    cta: parsed.cta?.trim() ?? "",
    tone_notes: parsed.tone_notes,
    sources_used: parsed.sources_used ?? relevantIds,
  };
  return {
    agent: "icp_personalization",
    status: "pass",
    output: { subject: draft.subject, length: draft.body.length, sources: draft.sources_used },
    confidence: 0.85,
    draft,
  };
}

async function brandCheckAgent(client: LLMClient, draft: EmailDraft, kb: KBEntry[]): Promise<AgentResult> {
  const brandVoice = kb.filter((e) => e.namespace === "brand_voice" && e.status === "ready");
  const guidance = brandVoice.map((e) => e.content.slice(0, 1500)).join("\n\n");

  const system = `You are the Brand Compliance Agent. Score the email against ClientLens voice. Output strict JSON.`;
  const user = `GUIDANCE:
${guidance || "ClientLens voice: direct, numbers-first, no hype. Banned: revolutionary, game-changing, best-in-class, world-class, synergy, cutting-edge."}

EMAIL:
Subject: ${draft.subject}
Body: ${draft.body}
CTA: ${draft.cta}

Return JSON:
{"pass": true, "violations": [{"issue": "...", "severity": "low|medium|high"}], "tone_score": 0.0}`;

  const text = await client.call(system, user, 800);
  const parsed = extractJson<{
    pass: boolean;
    violations: { issue: string; severity: "low" | "medium" | "high" }[];
    tone_score: number;
  }>(text) ?? { pass: true, violations: [], tone_score: 0.7 };

  const status =
    parsed.violations.some((v) => v.severity === "high") ? "fail" :
    parsed.violations.length > 0 ? "warning" : "pass";

  return {
    agent: "brand_compliance",
    status,
    output: parsed,
    issues: parsed.violations.map((v) => `${v.issue} (${v.severity})`),
    confidence: parsed.tone_score,
  };
}

async function validationAgent(
  client: LLMClient,
  draft: EmailDraft,
  kb: KBEntry[],
  relevantIds: string[],
): Promise<AgentResult> {
  const used = kb.filter((e) => relevantIds.includes(e.id));

  const system = `You are the Fact Validation Agent. Mark any claim not supported by the sources as hallucinated. Output strict JSON.`;
  const user = `SOURCES:
${summarizeKB(used, 8)}

Baseline facts always safe: 317 rules; AWS 33 / GCP 16 / Azure 24 resource types; up to 60% savings; 30-day pilot; ISO 27001 + SOC 2 Type II; read-only IAM.

EMAIL:
Subject: ${draft.subject}
Body: ${draft.body}

Return JSON:
{"grounded": true, "hallucinations": ["description"]}`;

  const text = await client.call(system, user, 800);
  const parsed = extractJson<{ grounded: boolean; hallucinations: string[] }>(text) ?? {
    grounded: true,
    hallucinations: [],
  };
  return {
    agent: "validation",
    status: parsed.hallucinations.length > 0 ? "fail" : "pass",
    output: parsed,
    issues: parsed.hallucinations,
    confidence: parsed.hallucinations.length > 0 ? 0.3 : 0.95,
  };
}

export async function* runEmailCouncil(opts: {
  input: EmailInput;
  kb: KBEntry[];
  modelOverride?: { provider: LLMProvider; model: string };
}): AsyncGenerator<EmailCouncilEvent> {
  const { input, kb, modelOverride } = opts;
  const cfg = resolveLLMConfig(modelOverride);
  if ("error" in cfg) {
    yield { type: "error", message: cfg.error };
    return;
  }
  const client = makeLLMClient(cfg);

  try {
    yield { type: "stage", stage: "retrieval", message: "Retrieving KB for this intent..." };
    const retrieval = await retrievalAgent(client, input, kb);
    yield { type: "agent", result: retrieval };
    if (retrieval.status === "fail") {
      yield { type: "error", message: retrieval.issues?.[0] ?? "Retrieval failed" };
      return;
    }

    yield { type: "stage", stage: "drafting", message: "Drafting email..." };
    const drafted = await draftAgent(client, input, kb, retrieval.relevant_ids);
    yield { type: "agent", result: drafted };
    if (drafted.status === "fail") {
      yield { type: "error", message: "Email draft failed" };
      return;
    }

    yield { type: "stage", stage: "brand_check", message: "Checking brand voice..." };
    const brand = await brandCheckAgent(client, drafted.draft, kb);
    yield { type: "agent", result: brand };

    yield { type: "stage", stage: "validation", message: "Validating claims..." };
    const validation = await validationAgent(client, drafted.draft, kb, retrieval.relevant_ids);
    yield { type: "agent", result: validation };

    const pipeline: EmailPipelineResult = {
      request_id: `email-${Date.now()}`,
      agents: [retrieval, drafted, brand, validation],
      final_output: drafted.draft,
      metadata: {
        sources_used: retrieval.relevant_ids,
        brand_compliant: brand.status !== "fail",
        generated_at: new Date().toISOString(),
        intent: input.intent,
      },
    };
    yield { type: "done", pipeline };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
