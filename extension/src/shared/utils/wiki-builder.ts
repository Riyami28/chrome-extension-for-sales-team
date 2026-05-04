/**
 * Wiki builder — turns a raw KBEntry into a structured WikiPage at ingest
 * time, in the spirit of Karpathy's "compile knowledge once, query forever."
 *
 * One LLM call per entry produces:
 *   - TLDR (one standalone sentence, used in the live-coach map)
 *   - body_markdown (cleaned restatement of the source)
 *   - concepts (specific noun phrases for cross-references)
 *   - tags (broader categories)
 *   - claims (factual assertions, used for contradiction detection)
 *   - data_gaps (what's referenced but not explained)
 *   - contradictions vs. the existing wiki (flagged, not auto-resolved)
 *
 * Failures here don't block embedding-based retrieval — wiki_status tracks
 * itself and the live agents fall back to chunks if the wiki isn't ready.
 */

import type { KBEntry, WikiPage } from "../types";
import { makeLLMClient, resolveLLMConfig } from "../agents/llm-client";

const WIKI_INGEST_SYSTEM = `You are a knowledge engineer building a structured sales knowledge base.

Read the SOURCE document and produce ONE structured wiki page that captures it. Also compare the source's claims against EXISTING claims listed below and flag any contradictions.

Output ONLY a single valid JSON object — no markdown fences, no prose. Schema:
{
  "type": "concept|case_study|product_overview|battlecard|pricing|process|other",
  "title": "short canonical name (max 60 chars)",
  "tldr": "ONE sentence, max 200 chars, that stands alone without further context",
  "body_markdown": "structured restatement of the source as markdown — sections, bullets, tables. Distill, don't quote at length.",
  "concepts": ["specific noun phrases — companies, features, metrics, customer names. Lower-case unless proper noun. 3-12 items."],
  "tags": ["broader categories like 'pricing', 'competitor', 'security'. 1-5 items."],
  "claims": [
    { "text": "specific assertion someone could verify", "kind": "metric|positioning|customer|capability|pricing|other" }
  ],
  "data_gaps": ["concrete things referenced in the source but not explained"],
  "confidence": "high|medium|low",
  "contradictions": [
    { "with_entry_id": "<id from EXISTING list>", "their_claim": "what the other page asserts", "my_claim": "what the new source asserts", "note": "one short sentence on the conflict" }
  ]
}

Rules:
- TLDR must read clearly without context — no "this document covers..." style.
- Concepts are SPECIFIC (e.g. "Vantage", "AWS Reserved Instances", "Tier 2 pricing"). NOT broad words like "cloud" or "savings".
- A contradiction is when two pages assert different VALUES for the same metric, or contradictory positioning about the same entity. Phrasing differences are NOT contradictions.
- If no contradictions exist, return an empty array.
- If the source is sparse / a transcript / jumbled notes, distill what's actually claimed. Do not invent.

Return JSON only.`;

/** Compact view of an existing entry the LLM uses for contradiction checks. */
interface ExistingClaimRow {
  entry_id: string;
  title: string;
  claims: { text: string; kind: string }[];
}

function buildExistingClaimContext(existing: KBEntry[]): ExistingClaimRow[] {
  return existing
    .filter((e) => e.wiki_page?.claims?.length)
    .map((e) => ({
      entry_id: e.id,
      title: e.wiki_page!.title || e.name,
      // Cap at 6 claims/entry so the prompt doesn't balloon on large KBs.
      claims: e.wiki_page!.claims.slice(0, 6).map((c) => ({ text: c.text, kind: c.kind })),
    }));
}

function safeJson<T>(raw: string): T | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]) as T; } catch { /* fall through */ }
  }
  return null;
}

interface WikiBuildOutput {
  type?: string;
  title?: string;
  tldr?: string;
  body_markdown?: string;
  concepts?: string[];
  tags?: string[];
  claims?: { text: string; kind: string }[];
  data_gaps?: string[];
  confidence?: string;
  contradictions?: { with_entry_id: string; their_claim: string; my_claim: string; note: string }[];
}

const ALLOWED_TYPES = new Set(["concept", "case_study", "product_overview", "battlecard", "pricing", "process", "other"]);
const ALLOWED_CLAIM_KINDS = new Set(["metric", "positioning", "customer", "capability", "pricing", "other"]);
const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);

function normaliseWikiPage(
  parsed: WikiBuildOutput,
  entry: KBEntry,
  existing: KBEntry[],
  generatorModel: string,
): WikiPage {
  const existingById = new Map(existing.map((e) => [e.id, e]));

  const type = (parsed.type && ALLOWED_TYPES.has(parsed.type) ? parsed.type : "other") as WikiPage["type"];
  const confidence = (parsed.confidence && ALLOWED_CONFIDENCE.has(parsed.confidence) ? parsed.confidence : "medium") as WikiPage["confidence"];

  const concepts = (parsed.concepts ?? [])
    .filter((c): c is string => typeof c === "string" && !!c.trim())
    .map((c) => c.trim())
    .slice(0, 16);
  const tags = (parsed.tags ?? [])
    .filter((t): t is string => typeof t === "string" && !!t.trim())
    .map((t) => t.trim().toLowerCase())
    .slice(0, 8);
  const claims = (parsed.claims ?? [])
    .filter((c) => c && typeof c.text === "string" && c.text.trim())
    .map((c) => ({
      text: c.text.trim().slice(0, 280),
      kind: (ALLOWED_CLAIM_KINDS.has(c.kind) ? c.kind : "other") as WikiPage["claims"][number]["kind"],
    }))
    .slice(0, 20);
  const data_gaps = (parsed.data_gaps ?? [])
    .filter((g): g is string => typeof g === "string" && !!g.trim())
    .map((g) => g.trim())
    .slice(0, 10);

  // Resolve contradictions — drop ones that point at a non-existent entry id
  // (LLM hallucination) and stamp the partner page's name at detection time.
  const contradictions = (parsed.contradictions ?? [])
    .filter((c) => c && typeof c.with_entry_id === "string" && existingById.has(c.with_entry_id))
    .map((c) => ({
      with_entry_id: c.with_entry_id,
      with_entry_name: existingById.get(c.with_entry_id)?.name,
      their_claim: (c.their_claim ?? "").toString().slice(0, 280),
      my_claim: (c.my_claim ?? "").toString().slice(0, 280),
      note: (c.note ?? "").toString().slice(0, 280),
    }))
    .filter((c) => c.my_claim && c.their_claim);

  return {
    type,
    title: (parsed.title || entry.name).slice(0, 120),
    tldr: (parsed.tldr || "").slice(0, 240),
    body_markdown: (parsed.body_markdown || "").slice(0, 12_000),
    concepts,
    tags,
    claims,
    data_gaps,
    confidence,
    contradictions,
    generated_at: new Date().toISOString(),
    generator_model: generatorModel,
  };
}

/**
 * Build the wiki page for a single entry. `existing` is every other entry's
 * current state (used for contradiction detection). Throws on LLM error.
 */
export async function buildWikiPage(entry: KBEntry, existing: KBEntry[]): Promise<WikiPage> {
  const cfg = resolveLLMConfig();
  if ("error" in cfg) throw new Error(cfg.error);
  const client = makeLLMClient(cfg);

  const existingRows = buildExistingClaimContext(existing.filter((e) => e.id !== entry.id));

  const sourceText = (entry.content || "").trim();
  if (!sourceText) {
    // Empty source — return a minimal page without an LLM call.
    return {
      type: "other",
      title: entry.name,
      tldr: "",
      body_markdown: "",
      concepts: [],
      tags: [],
      claims: [],
      data_gaps: ["Source body is empty — backend parser may not have run yet."],
      confidence: "low",
      contradictions: [],
      generated_at: new Date().toISOString(),
      generator_model: cfg.model,
    };
  }

  // Cap source at 12K chars — Llama 3.3 70B handles much more, but anything
  // longer almost always means the chunker should be authoritative for
  // retrieval and the wiki page should stay distilled.
  const cappedSource = sourceText.length > 12_000 ? sourceText.slice(0, 12_000) + "\n\n[…truncated]" : sourceText;

  const user = `SOURCE METADATA:
- name: ${entry.name}
- namespace: ${entry.namespace}
- source_type: ${entry.source_type}${entry.url ? `\n- url: ${entry.url}` : ""}

EXISTING WIKI CLAIMS (for contradiction detection — use the entry_id values verbatim if you flag a conflict):
${existingRows.length === 0 ? "(none yet)" : JSON.stringify(existingRows, null, 2)}

SOURCE:
${cappedSource}

Produce the wiki page JSON now.`;

  const raw = await client.call(WIKI_INGEST_SYSTEM, user, 1800);
  const parsed = safeJson<WikiBuildOutput>(raw);
  if (!parsed) throw new Error("Wiki builder returned unparseable JSON");
  return normaliseWikiPage(parsed, entry, existing, cfg.model);
}

// ─── Lint pass ──────────────────────────────────────────────────────────────
//
// Re-audit the WHOLE wiki against itself, asking the LLM to surface any
// contradictions across pages. Used for the "Lint wiki" button. Single LLM
// call regardless of KB size — we send only TLDRs + claims, not bodies.

const WIKI_LINT_SYSTEM = `You are auditing a sales knowledge base for contradictions across pages.

Each page is presented as { entry_id, title, tldr, claims }. Identify any pairs of pages whose claims contradict each other.

Output JSON only:
{ "contradictions": [
  { "entry_id": "page A", "with_entry_id": "page B", "my_claim": "from A", "their_claim": "from B", "note": "1 sentence" }
] }

Same rules as ingest:
- A contradiction is conflicting VALUES for the same metric/positioning/etc. Phrasing differences don't count.
- Use entry_ids verbatim from the input list.
- Empty array if nothing contradicts.

JSON only.`;

interface LintOutput {
  contradictions?: { entry_id: string; with_entry_id: string; my_claim: string; their_claim: string; note: string }[];
}

/**
 * Run the lint pass. Returns a map of entry_id → updated contradiction list.
 * Caller is responsible for writing these back onto each entry's wiki_page.
 */
export async function lintWiki(entries: KBEntry[]): Promise<Map<string, WikiPage["contradictions"]>> {
  const withWiki = entries.filter((e) => e.wiki_page);
  if (withWiki.length < 2) return new Map();

  const cfg = resolveLLMConfig();
  if ("error" in cfg) throw new Error(cfg.error);
  const client = makeLLMClient(cfg);

  const rows = withWiki.map((e) => ({
    entry_id: e.id,
    title: e.wiki_page!.title,
    tldr: e.wiki_page!.tldr,
    claims: e.wiki_page!.claims.slice(0, 8),
  }));

  const user = `Pages:\n${JSON.stringify(rows, null, 2)}\n\nFind contradictions. JSON only.`;

  const raw = await client.call(WIKI_LINT_SYSTEM, user, 1500);
  const parsed = safeJson<LintOutput>(raw);
  if (!parsed) throw new Error("Lint pass returned unparseable JSON");

  const byId = new Map(withWiki.map((e) => [e.id, e]));
  const out = new Map<string, WikiPage["contradictions"]>();

  // Initialize every entry to "no contradictions" so callers can write the
  // empty array back and clear stale flags.
  for (const e of withWiki) out.set(e.id, []);

  for (const c of parsed.contradictions ?? []) {
    const a = byId.get(c.entry_id);
    const b = byId.get(c.with_entry_id);
    if (!a || !b) continue;
    if (a.id === b.id) continue;
    const list = out.get(a.id) ?? [];
    list.push({
      with_entry_id: b.id,
      with_entry_name: b.name,
      my_claim: (c.my_claim ?? "").slice(0, 280),
      their_claim: (c.their_claim ?? "").slice(0, 280),
      note: (c.note ?? "").slice(0, 280),
    });
    out.set(a.id, list);
  }

  return out;
}
