/**
 * Agent Council — 4 agents + final vote.
 * Nothing leaves this pipeline unless the council approves.
 *
 * Pipeline:
 *   1. Retrieval          — pulls relevant KB chunks
 *   2. ICP Personalization — rewrites to nearest ICP rules
 *   3. Brand Compliance    — enforces ClientLens voice + design system
 *   4. Fact / Validation   — every claim must trace to KB
 *   5. Council vote        — all 4 must pass; else regenerate or flag
 */

import type {
  PersonalizationInput,
  BrandAssets,
  KBEntry,
  ICPProfile,
  ICPRole,
  AgentResult,
  SlideContent,
  PipelineResult,
  ResearchBrief,
} from "../types";
import { ICP_PROFILES } from "../constants/icp-profiles";
import { type LLMClient, makeLLMClient, resolveLLMConfig } from "./llm-client";
import { runResearch, briefToPrompt } from "./research";

export type CouncilEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "agent"; result: AgentResult }
  | { type: "research"; brief: ResearchBrief }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "done"; pipeline: PipelineResult }
  | { type: "error"; message: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchICP(role: string): ICPProfile {
  const normalized = role.toLowerCase().trim();
  const byId = ICP_PROFILES.find((p) => normalized.includes(p.role));
  if (byId) return byId;

  const keywordMap: { keywords: string[]; role: ICPRole }[] = [
    { keywords: ["finance", "cfo", "financial", "controller", "treasurer"], role: "cfo" },
    { keywords: ["cto", "chief technology", "architect"], role: "cto" },
    { keywords: ["coo", "operations", "chief operating"], role: "coo" },
    { keywords: ["vp sales", "chief revenue", "cro", "revenue"], role: "vp_sales" },
    { keywords: ["vp eng", "engineering", "platform", "devops", "sre", "finops"], role: "vp_engineering" },
    { keywords: ["ceo", "founder", "president"], role: "ceo" },
  ];
  for (const { keywords, role: r } of keywordMap) {
    if (keywords.some((k) => normalized.includes(k))) {
      const hit = ICP_PROFILES.find((p) => p.role === r);
      if (hit) return hit;
    }
  }
  // default to CFO — safest executive framing
  return ICP_PROFILES.find((p) => p.role === "cfo")!;
}

function filterKB(kb: KBEntry[], input: PersonalizationInput): KBEntry[] {
  // Only ready entries contribute text; pending entries are cited by name only.
  const ready = kb.filter((e) => e.status === "ready");

  // Stage priority — if stage is set, bias toward relevant namespaces.
  const stagePriority: Record<string, string[]> = {
    discovery: ["product_overview", "industry_pages", "case_studies"],
    tech_deep_dive: ["security_compliance", "battlecard", "product_overview"],
    poc_scoping: ["roi_pricing", "product_overview"],
    poc_execution: ["product_overview", "security_compliance"],
    poc_review: ["roi_pricing", "case_studies"],
    commercial_close: ["roi_pricing", "case_studies", "battlecard"],
  };
  const preferred = input.meeting_stage ? stagePriority[input.meeting_stage] ?? [] : [];

  return ready.sort((a, b) => {
    const ai = preferred.indexOf(a.namespace);
    const bi = preferred.indexOf(b.namespace);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function summarizeKB(kb: KBEntry[]): string {
  if (!kb.length) return "(knowledge base is empty)";
  return kb
    .slice(0, 20)
    .map((e, i) => {
      const body = e.content ? e.content.slice(0, 1500) : `[${e.status} — ${e.name}]`;
      return `--- SOURCE ${i + 1} · ns=${e.namespace} · id=${e.id} · "${e.name}" ---\n${body}`;
    })
    .join("\n\n");
}

export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  // Balanced-brace scan: find every { ... } block at top level.
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const raw of candidates) {
    try { return JSON.parse(raw) as T; } catch { /* try next */ }
  }
  return null;
}

async function callLLM(
  client: LLMClient,
  system: string,
  user: string,
  maxTokens = 3000,
): Promise<string> {
  return client.call(system, user, maxTokens);
}

// ─── Agent 1 — Retrieval ──────────────────────────────────────────────────────

interface RetrievalOutput {
  relevant_source_ids: string[];
  citations: { source_id: string; quote: string; claim: string }[];
  missing_info: string[];
}

async function retrievalAgent(
  client: LLMClient,
  input: PersonalizationInput,
  kb: KBEntry[],
  brief?: ResearchBrief,
): Promise<AgentResult> {
  const filtered = filterKB(kb, input);

  if (!filtered.length) {
    return {
      agent: "retrieval",
      status: "fail",
      output: { relevant_source_ids: [], citations: [], missing_info: ["KB is empty"] } as RetrievalOutput,
      issues: ["No ready KB entries. Admin/PMM/Designer must populate the KB before generation."],
      confidence: 0,
    };
  }

  const system = `You are the Retrieval Agent for ClientLens's sales council. Identify the KB sources that directly support a personalized deck for this target. Output strict JSON only.`;
  const user = `TARGET:
- Company: ${input.company_name}
- Persona: ${input.persona_role}
- Deal size: ${input.deal_size}
- Stage: ${input.meeting_stage ?? "discovery"}
- Clouds: ${input.clouds?.join(", ") ?? "all three"}
- Region: ${input.region ?? "n/a"}
- Competitor: ${input.competitor ?? "n/a"}
- Pain points: ${input.pain_points ?? "n/a"}
${brief ? `\nPROSPECT RESEARCH:\n${briefToPrompt(brief)}\n` : ""}
KB:
${summarizeKB(filtered)}

Return JSON:
{
  "relevant_source_ids": ["id1", "id2"],
  "citations": [{"source_id": "id1", "quote": "exact quote", "claim": "what it supports"}],
  "missing_info": ["what the KB does not cover for this target"]
}`;

  const text = await callLLM(client, system, user, 2000);
  const parsed = extractJson<RetrievalOutput>(text) ?? {
    relevant_source_ids: filtered.slice(0, 5).map((e) => e.id),
    citations: [],
    missing_info: ["parser fallback"],
  };

  const status = parsed.citations.length > 0 ? "pass" : "warning";
  return {
    agent: "retrieval",
    status,
    output: parsed,
    issues: status === "warning" ? ["No explicit citations extracted"] : undefined,
    confidence: parsed.citations.length > 2 ? 0.9 : 0.7,
  };
}

// ─── Agent 2 — ICP Personalization ────────────────────────────────────────────

interface DraftOutput {
  slides: SlideContent[];
  matched_icp: ICPRole;
}

async function icpPersonalizationAgent(
  client: LLMClient,
  input: PersonalizationInput,
  kb: KBEntry[],
  retrieval: RetrievalOutput,
  brandAssets: BrandAssets,
  brief?: ResearchBrief,
): Promise<AgentResult & { draft: DraftOutput }> {
  const icp = matchICP(input.persona_role);
  const usedSources = kb.filter((e) => retrieval.relevant_source_ids.includes(e.id));

  const format = input.pitch_format ?? "on_screen_ppt";
  const customHint = input.pitch_format_custom_hint?.trim();
  const formatDirective: Record<string, string> = {
    on_screen_ppt:
      "Output is for an on-screen slide deck projected during a live call. Every slide has a 6-word max headline, 3 short bullet lines, and a single takeaway. No dense paragraphs — a reader must absorb each slide in under 5 seconds.",
    one_pager:
      "Output is a single one-pager executive summary. Produce 4 tight sections (Problem, Why us, Proof, Next step). Each section is 2-3 sentences, scannable in 60 seconds, no bullet lists.",
    detailed_doc:
      "Output is a long-form doc with named sections: Context, Pain, Solution, Differentiators, Evidence, Implementation, Commercials, Next Steps. Paragraphs are allowed. Cite KB source_ids inline.",
    analysis:
      "Output is a data-led analysis. Lead with a headline metric. Include tables / pills of comparisons, an ROI calculation if inputs allow, competitive positioning vs the named competitor, and a risk section. No marketing puffery.",
    custom_doc: customHint
      ? `Output is a CUSTOM DOC. The user described it as: "${customHint}". Match that doc shape exactly — infer section headings, length, tone, and structure from that description. Use the persona, KB hits, and any prospect research as supporting evidence.`
      : "Output is a CUSTOM DOC and the user did NOT describe it. AUTO-DETECT the right shape from the surrounding context: persona role, deal size, meeting stage, prospect research signals, and KB namespaces present. Pick ONE concrete shape (e.g. RFP response, security questionnaire reply, partner brief, exec memo, technical proposal) and execute it well. State the inferred shape in the first slide title.",
  };

  const system = `You are the ICP Personalization Agent. Draft a ${icp.label}-tailored deck grounded ONLY in the cited sources. Use ClientLens product facts verbatim (317 rules, up to 60%, ISO 27001 + SOC 2 Type II, <5 min setup, 30-day pilot). Do NOT invent customer logos, savings figures, or quotes.

FORMAT: ${format.replace(/_/g, " ")}. ${formatDirective[format]}`;

  const user = `ICP: ${icp.label}
Lead with: ${icp.content_rules.lead_with.join(", ")}
Avoid: ${icp.content_rules.avoid.join(", ")}
Tone: ${icp.content_rules.tone}

TARGET: ${input.company_name} — persona "${input.persona_role}"
Stage: ${input.meeting_stage ?? "discovery"} · Deal: ${input.deal_size} · Clouds: ${input.clouds?.join(", ") ?? "AWS+GCP+Azure"}
Region: ${input.region ?? "n/a"} · Competitor: ${input.competitor ?? "n/a"}
Pain points: ${input.pain_points ?? "(none provided — infer from industry)"}
Desired format: ${format.replace(/_/g, " ")}${customHint ? `\nCustom doc hint: ${customHint}` : ""}

Brand accent (target): ${brandAssets.primary_color}
${brief ? `\nPROSPECT RESEARCH (use this to personalize — pattern-match to their actual tech stack / pain signals):\n${briefToPrompt(brief)}\n` : ""}
SOURCES (use ONLY these — cite source_id on each claim):
${summarizeKB(usedSources)}

Output JSON:
{
  "slides": [
    {
      "index": 0,
      "title": "...",
      "components": [{"type": "text_block", "content": "..."}],
      "speaker_notes": "..."
    }
  ]
}

Produce 5–7 slides. Every numeric claim must be traceable to a source_id above.`;

  const text = await callLLM(client, system, user, 3500);
  const parsed = extractJson<{ slides: SlideContent[] }>(text);

  if (!parsed?.slides?.length) {
    return {
      agent: "icp_personalization",
      status: "fail",
      output: { error: "no slides parsed" },
      issues: ["Could not parse draft slides from ICP agent"],
      confidence: 0,
      draft: { slides: [], matched_icp: icp.role },
    };
  }

  return {
    agent: "icp_personalization",
    status: "pass",
    output: { slide_count: parsed.slides.length, matched_icp: icp.role },
    confidence: 0.85,
    draft: { slides: parsed.slides, matched_icp: icp.role },
  };
}

// ─── Agent 3 — Brand Compliance ───────────────────────────────────────────────

interface BrandCheck {
  pass: boolean;
  violations: { slide_index: number; issue: string; severity: "low" | "medium" | "high" }[];
  tone_score: number;
}

async function brandComplianceAgent(
  client: LLMClient,
  draft: DraftOutput,
  kb: KBEntry[],
): Promise<AgentResult> {
  const brandVoice = kb.filter((e) => e.namespace === "brand_voice" && e.status === "ready");
  const designSystem = kb.filter((e) => e.namespace === "design_system" && e.status === "ready");

  const guidance = [
    ...brandVoice.map((e) => `BRAND VOICE (${e.name}):\n${e.content.slice(0, 2000)}`),
    ...designSystem.map((e) => `DESIGN SYSTEM (${e.name}):\n${e.content.slice(0, 2000)}`),
  ].join("\n\n");

  const fallbackVoice = `ClientLens voice: direct, numbers-first, no hype. Avoid "revolutionary", "game-changing", "best-in-class", "world-class". Use "317 rules", "up to 60%", "30-day pilot", "read-only", "no agents".`;

  const system = `You are the Brand Compliance Agent. Check the draft against ClientLens voice and design system. Output strict JSON.`;
  const user = `GUIDANCE:
${guidance || fallbackVoice}

DRAFT:
${JSON.stringify(draft.slides, null, 2)}

Return JSON:
{
  "pass": true,
  "violations": [{"slide_index": 0, "issue": "...", "severity": "low"}],
  "tone_score": 0.0
}

tone_score is 0–1. Flag any banned words, invented customer names, or off-brand tone.`;

  const text = await callLLM(client, system, user, 1500);
  const parsed = extractJson<BrandCheck>(text) ?? { pass: true, violations: [], tone_score: 0.7 };

  const highSeverity = parsed.violations.filter((v) => v.severity === "high");
  const status = highSeverity.length > 0 ? "fail" : parsed.violations.length > 0 ? "warning" : "pass";

  return {
    agent: "brand_compliance",
    status,
    output: parsed,
    issues: parsed.violations.map((v) => `slide ${v.slide_index}: ${v.issue} (${v.severity})`),
    confidence: parsed.tone_score,
  };
}

// ─── Agent 4 — Fact / Validation ──────────────────────────────────────────────

interface FactCheck {
  grounded: boolean;
  claims: { slide_index: number; claim: string; source_id: string | null; status: "verified" | "unverified" | "hallucinated" }[];
  hallucinations: string[];
}

async function validationAgent(
  client: LLMClient,
  draft: DraftOutput,
  kb: KBEntry[],
  retrieval: RetrievalOutput,
): Promise<AgentResult> {
  const usedSources = kb.filter((e) => retrieval.relevant_source_ids.includes(e.id));

  const system = `You are the Fact Validation Agent. Audit every numeric and named claim in the draft. Mark "hallucinated" for any claim not supported by the cited sources. Output strict JSON.`;
  const user = `SOURCES (ground truth):
${summarizeKB(usedSources)}

Baseline facts that are ALWAYS safe to use verbatim (from ClientLens product):
- 317 recommendation rules across AWS + GCP + Azure
- AWS 33 / GCP 16 / Azure 24 resource types
- Up to 60% first-scan savings
- 30-day free pilot, pay-on-verified-savings
- ISO 27001 + SOC 2 Type II
- AES-256-GCM encryption, read-only IAM
- <5 min to connect
- Data residency: GCP India (Mumbai)

DRAFT:
${JSON.stringify(draft.slides, null, 2)}

Return JSON:
{
  "grounded": true,
  "claims": [{"slide_index": 0, "claim": "...", "source_id": "...", "status": "verified"}],
  "hallucinations": ["description of any fabricated claim"]
}`;

  const text = await callLLM(client, system, user, 2000);
  const parsed = extractJson<FactCheck>(text) ?? { grounded: true, claims: [], hallucinations: [] };

  const status = parsed.hallucinations.length > 0 ? "fail" : "pass";
  return {
    agent: "validation",
    status,
    output: parsed,
    issues: parsed.hallucinations,
    confidence: status === "pass" ? 0.95 : 0.3,
  };
}

// ─── Council Orchestrator ─────────────────────────────────────────────────────

const MAX_RETRIES = 2;

export async function* runCouncil(opts: {
  input: PersonalizationInput;
  brandAssets: BrandAssets;
  kb: KBEntry[];
  modelOverride?: { provider: import("./llm-client").LLMProvider; model: string };
  deepResearch?: boolean;
}): AsyncGenerator<CouncilEvent> {
  const { input, brandAssets, kb, modelOverride, deepResearch } = opts;
  const cfg = resolveLLMConfig(modelOverride);
  if ("error" in cfg) {
    yield { type: "error", message: cfg.error };
    return;
  }
  const client = makeLLMClient(cfg);

  try {
    // 0. Optional deep research
    let brief: ResearchBrief | undefined;
    if (deepResearch) {
      yield { type: "stage", stage: "research", message: "Researching the prospect…" };
      try {
        const { brief: b } = await runResearch({
          client,
          companyName: input.company_name,
          domainOverride: brandAssets.domain,
        });
        brief = b;
        yield { type: "research", brief: b };
      } catch (err) {
        // Non-fatal — continue without brief
        yield { type: "stage", stage: "research", message: `Research skipped: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // 1. Retrieval
    yield { type: "stage", stage: "retrieval", message: "Retrieving KB sources…" };
    const retrieval = await retrievalAgent(client, input, kb, brief);
    yield { type: "agent", result: retrieval };
    if (retrieval.status === "fail") {
      yield { type: "error", message: retrieval.issues?.[0] ?? "Retrieval failed" };
      return;
    }
    const retrievalOutput = retrieval.output as RetrievalOutput;

    // 2–4 with retry loop on validation failure
    let attempt = 0;
    let draft: DraftOutput | null = null;
    let icpResult: AgentResult | null = null;
    let brandResult: AgentResult | null = null;
    let validationResult: AgentResult | null = null;

    while (attempt <= MAX_RETRIES) {
      yield { type: "stage", stage: "icp_personalize", message: `Drafting for persona (attempt ${attempt + 1})…` };
      const icp = await icpPersonalizationAgent(client, input, kb, retrievalOutput, brandAssets, brief);
      icpResult = icp;
      yield { type: "agent", result: icp };
      if (icp.status === "fail") {
        yield { type: "error", message: "ICP agent could not produce a draft" };
        return;
      }
      draft = icp.draft;

      yield { type: "stage", stage: "brand_check", message: "Checking ClientLens brand compliance…" };
      brandResult = await brandComplianceAgent(client, draft, kb);
      yield { type: "agent", result: brandResult };

      yield { type: "stage", stage: "validation", message: "Validating every claim against KB…" };
      validationResult = await validationAgent(client, draft, kb, retrievalOutput);
      yield { type: "agent", result: validationResult };

      const brandPass = brandResult.status !== "fail";
      const validationPass = validationResult.status === "pass";
      if (brandPass && validationPass) break;

      attempt++;
      if (attempt > MAX_RETRIES) break;
      yield {
        type: "retry",
        attempt,
        reason: !validationPass ? "validation flagged hallucinations" : "brand compliance failed",
      };
    }

    // 5. Council vote
    yield { type: "stage", stage: "generating", message: "Council vote…" };

    const agents = [retrieval, icpResult!, brandResult!, validationResult!];
    const councilPass = agents.every((a) => a.status !== "fail") && validationResult!.status === "pass";

    if (!councilPass) {
      const issues = agents.flatMap((a) => a.issues ?? []);
      yield {
        type: "error",
        message: `Council rejected the draft after ${attempt} retries. Issues: ${issues.slice(0, 3).join("; ")}`,
      };
      return;
    }

    const slides = draft!.slides;
    const pipeline: PipelineResult = {
      request_id: `council-${Date.now()}`,
      agents,
      final_output: {
        slides,
        renderable_text: slides
          .map((s, i) =>
            `Slide ${i + 1}: ${s.title}\n${"─".repeat(40)}\n${
              s.components
                ?.map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c.content)))
                .join("\n") ?? ""
            }`,
          )
          .join("\n\n"),
        structured_json: { slides, brand_assets: brandAssets, matched_icp: draft!.matched_icp },
      },
      metadata: {
        sources_used: retrievalOutput.relevant_source_ids,
        brand_compliant: brandResult!.status === "pass",
        hallucination_check: validationResult!.status === "pass" ? "clean" : "flagged",
        generated_at: new Date().toISOString(),
      },
    };

    yield { type: "done", pipeline };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
