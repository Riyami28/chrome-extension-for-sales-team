/**
 * Mock API for local preview/testing.
 * Simulates the backend streaming pipeline using Claude via the FastAPI proxy.
 * Toggle via VITE_MOCK_MODE=true in .env.local
 *
 * Note: as of issue #1, Anthropic calls go through the backend proxy
 * (`/api/v1/llm/complete`) — not direct from the extension. Mock mode requires
 * the backend to be reachable at VITE_BACKEND_URL.
 */

import { makeLLMClient, resolveLLMConfig } from "../agents/llm-client";
import type { GenerationRequest, PipelineResult } from "../types";

const STAGES = [
  { stage: "retrieval", delay: 800 },
  { stage: "brand_check", delay: 600 },
  { stage: "icp_personalize", delay: 700 },
  { stage: "validation", delay: 500 },
  { stage: "generating", delay: 400 },
];

export async function* mockGenerate(
  request: GenerationRequest,
  // The previous direct-SDK signature took an `apiKey` here. The proxy
  // owns the key, so callers no longer pass one. Kept for backwards-compat
  // call sites; ignored.
  _unused?: string,
): AsyncGenerator<{ type: string; stage?: string; data?: unknown; message?: string }> {
  void _unused;

  // Stream fake progress stages
  for (const { stage, delay } of STAGES) {
    await sleep(delay);
    yield { type: "progress", stage };
  }

  // Call Claude via the backend proxy (no API key in the extension).
  const cfg = resolveLLMConfig({ provider: "anthropic", model: "claude-sonnet-4-6" });
  if ("error" in cfg) {
    yield { type: "error", message: cfg.error };
    return;
  }
  const client = makeLLMClient(cfg);
  const prompt = buildPrompt(request);

  try {
    const rawText = await client.call(MOCK_SYSTEM_PROMPT, prompt, 4000);

    // Parse JSON from response
    const jsonMatch = rawText.match(/```json\n?([\s\S]+?)\n?```/) || rawText.match(/(\{[\s\S]+\})/);
    let slides = [];

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        slides = parsed.slides ?? [];
      } catch {
        slides = buildFallbackSlides(request, rawText);
      }
    } else {
      slides = buildFallbackSlides(request, rawText);
    }

    const result: PipelineResult = {
      request_id: `mock-${Date.now()}`,
      agents: [
        { agent: "retrieval", status: "pass", output: {}, confidence: 0.85 },
        { agent: "brand_compliance", status: "pass", output: {}, confidence: 0.90 },
        { agent: "icp_personalization", status: "pass", output: {}, confidence: 0.88 },
        { agent: "validation", status: "pass", output: {}, confidence: 0.92 },
      ],
      final_output: {
        slides,
        renderable_text: slides.map((s: { title: string; components: Array<{ content: unknown }> }, i: number) =>
          `Slide ${i + 1}: ${s.title}\n${"─".repeat(40)}\n${
            s.components?.map((c: { content: unknown }) => typeof c.content === "string" ? c.content : JSON.stringify(c.content)).join("\n") ?? ""
          }`
        ).join("\n\n"),
        structured_json: { slides },
      },
      metadata: {
        sources_used: ["product_docs", "case_studies"],
        brand_compliant: true,
        hallucination_check: "clean",
        generated_at: new Date().toISOString(),
      },
    };

    yield { type: "result", data: result };
  } catch (err) {
    yield { type: "error", message: String(err) };
  }
}

const MOCK_SYSTEM_PROMPT = `You are a sales presentation generator. Generate a personalized presentation in JSON format.

Output ONLY valid JSON in this exact structure:
\`\`\`json
{
  "slides": [
    {
      "index": 0,
      "title": "Slide Title",
      "components": [
        {"type": "text_block", "content": "Content here"}
      ],
      "speaker_notes": "What to say"
    }
  ]
}
\`\`\`

Generate 5-7 slides appropriate for the ICP role. Be specific to the company and use case.`;

function buildPrompt(request: GenerationRequest): string {
  return `Generate a personalized sales presentation for:

Company: ${request.company.name}
Industry: ${request.company.industry ?? "Technology"}
ICP Role: ${request.icp_role.toUpperCase()}
Use Case: ${request.use_case || "Cloud cost optimization"}
Action: ${request.action_type}
Live Mode: ${request.live_mode ? "YES — keep it concise" : "No"}

Generate slides tailored to the ${request.icp_role} persona at ${request.company.name}.`;
}

function buildFallbackSlides(request: GenerationRequest, text: string) {
  return [
    {
      index: 0,
      title: `ClientLens for ${request.company.name}`,
      components: [{ type: "title_block", content: text.slice(0, 500) }],
      speaker_notes: "Opening slide",
    },
  ];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
