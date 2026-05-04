/**
 * Objection handling — lightweight 2-agent pipeline.
 *   1. Retrieval — scoped to battlecard, case_studies, security_compliance
 *   2. Respond   — returns a concise grounded response with citations
 *
 * Called from the context menu on highlighted text anywhere (email, Slack, etc.).
 */

import type {
  AgentResult,
  ObjectionInput,
  ObjectionResponse,
  KBEntry,
} from "../types";
import { type LLMClient, makeLLMClient, resolveLLMConfig, type LLMProvider } from "./llm-client";
import { extractJson } from "./council";

export type ObjectionEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "agent"; result: AgentResult }
  | { type: "done"; response: ObjectionResponse }
  | { type: "error"; message: string };

const OBJECTION_NAMESPACES = new Set(["battlecard", "case_studies", "security_compliance", "roi_pricing", "product_overview"]);

function summarizeKB(kb: KBEntry[], limit = 8): string {
  if (!kb.length) return "(no scoped KB entries)";
  return kb
    .slice(0, limit)
    .map((e, i) => `--- SOURCE ${i + 1} · ns=${e.namespace} · id=${e.id} · "${e.name}" ---\n${e.content.slice(0, 1200)}`)
    .join("\n\n");
}

async function retrievalAgent(
  client: LLMClient,
  input: ObjectionInput,
  kb: KBEntry[],
): Promise<AgentResult & { relevant_ids: string[] }> {
  const scoped = kb.filter((e) => e.status === "ready" && OBJECTION_NAMESPACES.has(e.namespace));

  if (!scoped.length) {
    return {
      agent: "retrieval",
      status: "fail",
      output: { relevant_source_ids: [] },
      issues: ["No battlecard / case study / compliance KB entries. Ask admin to seed."],
      confidence: 0,
      relevant_ids: [],
    };
  }

  const system = `You are the Retrieval Agent. Pick KB sources that answer this objection. Output strict JSON only.`;
  const user = `OBJECTION: ${input.objection_text}
${input.competitor_hint ? `COMPETITOR HINT: ${input.competitor_hint}` : ""}

KB:
${summarizeKB(scoped, 12)}

Return JSON: {"relevant_source_ids": ["id1","id2","id3"]}`;

  const text = await client.call(system, user, 1000);
  const parsed = extractJson<{ relevant_source_ids: string[] }>(text);
  const ids = parsed?.relevant_source_ids ?? scoped.slice(0, 3).map((e) => e.id);

  return {
    agent: "retrieval",
    status: ids.length ? "pass" : "warning",
    output: { relevant_source_ids: ids },
    confidence: parsed ? 0.9 : 0.5,
    relevant_ids: ids,
  };
}

async function respondAgent(
  client: LLMClient,
  input: ObjectionInput,
  kb: KBEntry[],
  relevantIds: string[],
): Promise<AgentResult & { response: ObjectionResponse }> {
  const used = kb.filter((e) => relevantIds.includes(e.id));

  const system = `You are the Objection Response Agent for ClientLens. Respond to the prospect's objection using ONLY the cited sources. Be concise, specific, numerical. No hype words. Never invent customers. Output strict JSON only.`;
  const user = `OBJECTION (from prospect):
"${input.objection_text}"
${input.source_url ? `\nContext: ${input.source_title ?? ""} (${input.source_url})` : ""}
${input.competitor_hint ? `Likely competitor framing: ${input.competitor_hint}` : ""}

SOURCES (cite source_id on each supporting point):
${summarizeKB(used, 8)}

Return JSON:
{
  "summary": "...",          // one line — what's the objection really asking
  "response": "...",         // 60-120 words, direct, usable as a reply
  "citations": [{"source_id": "...", "quote": "exact quote from sources"}],
  "confidence": 0.0          // 0-1 based on source coverage
}`;

  const text = await client.call(system, user, 1500);
  const parsed = extractJson<ObjectionResponse>(text);

  if (!parsed?.response) {
    return {
      agent: "icp_personalization",
      status: "fail",
      output: { error: "no response produced" },
      issues: ["Response agent returned empty"],
      confidence: 0,
      response: { summary: "", response: "", citations: [], confidence: 0 },
    };
  }

  return {
    agent: "icp_personalization",
    status: "pass",
    output: { length: parsed.response.length, cites: parsed.citations?.length ?? 0 },
    confidence: parsed.confidence ?? 0.7,
    response: {
      summary: parsed.summary ?? "",
      response: parsed.response,
      citations: parsed.citations ?? [],
      confidence: parsed.confidence ?? 0.7,
    },
  };
}

export async function* runObjectionCouncil(opts: {
  input: ObjectionInput;
  kb: KBEntry[];
  modelOverride?: { provider: LLMProvider; model: string };
}): AsyncGenerator<ObjectionEvent> {
  const { input, kb, modelOverride } = opts;
  const cfg = resolveLLMConfig(modelOverride);
  if ("error" in cfg) {
    yield { type: "error", message: cfg.error };
    return;
  }
  const client = makeLLMClient(cfg);

  try {
    yield { type: "stage", stage: "retrieval", message: "Pulling battlecard + case studies..." };
    const retrieval = await retrievalAgent(client, input, kb);
    yield { type: "agent", result: retrieval };
    if (retrieval.status === "fail") {
      yield { type: "error", message: retrieval.issues?.[0] ?? "Retrieval failed" };
      return;
    }

    yield { type: "stage", stage: "responding", message: "Crafting grounded response..." };
    const responded = await respondAgent(client, input, kb, retrieval.relevant_ids);
    yield { type: "agent", result: responded };
    if (responded.status === "fail") {
      yield { type: "error", message: "Response agent failed" };
      return;
    }

    yield { type: "done", response: responded.response };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
