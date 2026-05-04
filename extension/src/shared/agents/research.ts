/**
 * Deep research agent — pre-council phase.
 *
 * Steps:
 *   1. Fetch prospect homepage HTML (proxy via service worker to bypass CORS).
 *   2. Extract visible text, title, og:description, og:site_name.
 *   3. Infer signals (tech keywords, named customers, hiring signals).
 *   4. LLM distills into a ResearchBrief.
 *
 * The brief is passed to the retrieval agent as extra context so ICP
 * personalization can reference concrete prospect-specific facts.
 */

import type { KBEntry, ResearchBrief } from "../types";
import type { LLMClient } from "./llm-client";
import { extractJson } from "./council";

export type ResearchEvent =
  | { type: "fetch"; url: string }
  | { type: "skip"; reason: string }
  | { type: "done"; brief: ResearchBrief };

const TECH_KEYWORDS = [
  "aws", "gcp", "azure", "kubernetes", "k8s", "terraform", "snowflake", "databricks",
  "datadog", "new relic", "splunk", "grafana", "prometheus", "kafka", "airflow",
  "spark", "redshift", "bigquery", "s3", "lambda", "ec2", "eks", "gke", "aks",
];

const CUSTOMER_RE = /\b(?:trusted by|our customers include|clients include|used by|powering)\b[^.]{0,200}/gi;

function inferDomain(name: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const slug = name.toLowerCase().replace(/\b(inc|corp|ltd|llc|plc|ag|gmbh|co|company|limited)\b/g, "").replace(/[^a-z0-9]/g, "");
  return `${slug}.com`;
}

function stripTags(html: string): { text: string; title: string; description: string; siteName: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
  const metaDesc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  const ogSite = html.match(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i);

  // Strip scripts/styles first, then all tags
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    text: stripped,
    title: titleMatch?.[1]?.trim() ?? "",
    description: (ogDesc?.[1] ?? metaDesc?.[1] ?? "").trim(),
    siteName: ogSite?.[1]?.trim() ?? "",
  };
}

function extractSignals(text: string): { tech: string[]; customers: string[] } {
  const lower = text.toLowerCase();
  const tech = Array.from(new Set(TECH_KEYWORDS.filter((kw) => lower.includes(kw))));
  const customerMatches = text.match(CUSTOMER_RE) ?? [];
  const customers = Array.from(new Set(customerMatches.map((m) => m.slice(0, 200).trim()))).slice(0, 3);
  return { tech, customers };
}

async function fetchHomepage(url: string): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return { ok: false, reason: `non-html (${ct})` };
    const html = await res.text();
    if (html.length < 200) return { ok: false, reason: "tiny body" };
    return { ok: true, html };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function runResearch(opts: {
  client: LLMClient;
  companyName: string;
  domainOverride?: string;
  _kb?: KBEntry[];
}): Promise<{ brief: ResearchBrief; events: ResearchEvent[] }> {
  const { client, companyName, domainOverride } = opts;
  const events: ResearchEvent[] = [];
  const domain = inferDomain(companyName, domainOverride);
  const candidates = [`https://${domain}`, `https://www.${domain}`];

  const raw_sources: ResearchBrief["raw_sources"] = [];
  let text = "";
  let title = "";
  let description = "";

  for (const url of candidates) {
    events.push({ type: "fetch", url });
    const res = await fetchHomepage(url);
    if (res.ok) {
      const parsed = stripTags(res.html);
      text = parsed.text.slice(0, 8000);
      title = parsed.title;
      description = parsed.description;
      raw_sources.push({ url, title: parsed.title, excerpt: parsed.text.slice(0, 400) });
      break;
    } else {
      events.push({ type: "skip", reason: `${url}: ${res.reason}` });
    }
  }

  const { tech, customers } = extractSignals(text);

  // Fallback brief if homepage fetch failed entirely.
  if (!text) {
    const brief: ResearchBrief = {
      company_name: companyName,
      domain,
      one_liner: description || `${companyName} — homepage unreachable, research limited`,
      tech_signals: [],
      named_customers: [],
      pain_signals: [],
      recent_signals: [],
      raw_sources,
      generated_at: new Date().toISOString(),
    };
    return { brief, events };
  }

  // LLM distillation pass.
  const system = `You are a sales research analyst. Given a prospect's homepage text, extract concrete facts only. Never invent. Output strict JSON only.`;
  const user = `COMPANY: ${companyName}
DOMAIN: ${domain}
HOMEPAGE TITLE: ${title}
META DESCRIPTION: ${description}
DETECTED TECH KEYWORDS: ${tech.join(", ") || "(none)"}
CUSTOMER MENTIONS (raw): ${customers.join(" | ") || "(none)"}

HOMEPAGE TEXT (truncated):
${text.slice(0, 5000)}

Return JSON:
{
  "one_liner": "...",             // what the company does, 15 words max
  "industry": "...",              // best guess
  "size_signal": "...",           // e.g. "mid-market SaaS", "enterprise fintech", or "unknown"
  "tech_signals": ["..."],        // concrete stacks/tools they mention using
  "named_customers": ["..."],     // only if a logo wall or explicit name appears
  "pain_signals": ["..."],        // concrete challenges that ClientLens could help (cloud spend, scale, compliance)
  "recent_signals": ["..."]       // launches, funding, hiring hints
}`;

  const raw = await client.call(system, user, 1200);
  const distilled = extractJson<Partial<ResearchBrief>>(raw) ?? {};

  const brief: ResearchBrief = {
    company_name: companyName,
    domain,
    one_liner: distilled.one_liner ?? description ?? title ?? `${companyName}`,
    industry: distilled.industry,
    size_signal: distilled.size_signal,
    tech_signals: distilled.tech_signals ?? tech,
    named_customers: distilled.named_customers ?? [],
    pain_signals: distilled.pain_signals ?? [],
    recent_signals: distilled.recent_signals ?? [],
    raw_sources,
    generated_at: new Date().toISOString(),
  };

  events.push({ type: "done", brief });
  return { brief, events };
}

export function briefToPrompt(brief: ResearchBrief): string {
  const lines = [
    `RESEARCH BRIEF — ${brief.company_name} (${brief.domain})`,
    `One-liner: ${brief.one_liner}`,
    brief.industry ? `Industry: ${brief.industry}` : null,
    brief.size_signal ? `Size signal: ${brief.size_signal}` : null,
    brief.tech_signals.length ? `Tech: ${brief.tech_signals.join(", ")}` : null,
    brief.named_customers.length ? `Named customers: ${brief.named_customers.join(", ")}` : null,
    brief.pain_signals.length ? `Pain signals: ${brief.pain_signals.join(", ")}` : null,
    brief.recent_signals.length ? `Recent: ${brief.recent_signals.join(", ")}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}
