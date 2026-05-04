import type { ICPProfile } from "../types";

export const ICP_PROFILES: ICPProfile[] = [
  {
    id: "cfo",
    role: "cfo",
    label: "CFO / Finance Leader",
    description: "Focus on ROI, cost reduction, payback period, financial risk",
    content_rules: {
      lead_with: ["ROI metrics", "cost savings", "payback period", "financial risk reduction"],
      avoid: ["technical jargon", "architecture diagrams", "implementation complexity"],
      block_types: ["metric_block", "comparison_table", "cta_block"],
      tone: "executive, numbers-first, concise",
    },
  },
  {
    id: "cto",
    role: "cto",
    label: "CTO / Engineering Leader",
    description: "Focus on architecture, integrations, scalability, security, engineering effort",
    content_rules: {
      lead_with: ["architecture overview", "integration points", "security posture", "scalability"],
      avoid: ["vague claims", "marketing language", "unsupported metrics"],
      block_types: ["architecture_block", "bullet_list", "comparison_table"],
      tone: "technical, precise, evidence-based",
    },
  },
  {
    id: "coo",
    role: "coo",
    label: "COO / Operations Leader",
    description: "Focus on operational efficiency, process improvement, team productivity",
    content_rules: {
      lead_with: ["operational efficiency gains", "process automation", "team productivity"],
      avoid: ["deep technical specs", "financial modeling"],
      block_types: ["metric_block", "bullet_list", "case_study_block"],
      tone: "operational, results-focused, practical",
    },
  },
  {
    id: "vp_sales",
    role: "vp_sales",
    label: "VP Sales / Revenue Leader",
    description: "Focus on competitive differentiation, win rates, pipeline acceleration",
    content_rules: {
      lead_with: ["competitive advantage", "win rate improvement", "deal acceleration", "social proof"],
      avoid: ["technical complexity", "internal jargon"],
      block_types: ["quote_block", "case_study_block", "comparison_table", "metric_block"],
      tone: "compelling, competitive, proof-heavy",
    },
  },
  {
    id: "vp_engineering",
    role: "vp_engineering",
    label: "VP Engineering",
    description: "Focus on developer experience, integration effort, maintenance overhead",
    content_rules: {
      lead_with: ["integration ease", "developer experience", "maintenance burden reduction"],
      avoid: ["business jargon", "unsupported benchmarks"],
      block_types: ["architecture_block", "bullet_list"],
      tone: "pragmatic, developer-first, honest about tradeoffs",
    },
  },
  {
    id: "ceo",
    role: "ceo",
    label: "CEO / Founder",
    description: "Focus on strategic value, market position, competitive moat, growth",
    content_rules: {
      lead_with: ["strategic value", "market differentiation", "growth impact", "competitive moat"],
      avoid: ["granular technical detail", "minor operational metrics"],
      block_types: ["title_block", "metric_block", "quote_block", "cta_block"],
      tone: "visionary, strategic, high-signal",
    },
  },
];

export const ICP_QUICK_ACTIONS = [
  { label: "Make CFO-friendly", action: "make_icp_friendly", target_icp: "cfo" },
  { label: "Make CTO-friendly", action: "make_icp_friendly", target_icp: "cto" },
  { label: "Add ROI slide", action: "add_roi_slide" },
  { label: "Simplify this", action: "simplify" },
  { label: "Add technical depth", action: "make_technical" },
  { label: "Add case study", action: "add_slide", slide_type: "case_study" },
];
