"""
Agent 3 — ICP Personalization Agent

Adapts content structure, tone, and component selection
to the specific ICP role and target company.
"""

import anthropic
import json
from models import GenerationRequest, AgentResult
from config import settings

ICP_RULES = {
    "cfo": {
        "lead_with": ["ROI metrics", "cost savings", "payback period", "financial risk reduction"],
        "avoid": ["technical jargon", "architecture diagrams", "implementation complexity"],
        "preferred_blocks": ["metric_block", "comparison_table", "cta_block"],
        "tone": "executive, numbers-first, concise — assume limited time",
        "slide_structure": ["Problem/Cost", "Our Solution", "ROI Summary", "Customer Proof", "Next Step"],
    },
    "cto": {
        "lead_with": ["architecture overview", "integration points", "security posture", "scalability"],
        "avoid": ["vague claims", "marketing language", "unsupported metrics"],
        "preferred_blocks": ["architecture_block", "bullet_list", "comparison_table"],
        "tone": "technical, precise, evidence-based — respect engineering intelligence",
        "slide_structure": ["Problem Statement", "Technical Architecture", "Integration Map", "Security & Compliance", "Proof of Work", "Next Step"],
    },
    "coo": {
        "lead_with": ["operational efficiency", "process automation", "team productivity"],
        "avoid": ["deep technical specs", "financial modeling"],
        "preferred_blocks": ["metric_block", "bullet_list", "case_study_block"],
        "tone": "operational, results-focused, practical",
        "slide_structure": ["Operational Pain", "Solution Overview", "Efficiency Gains", "Case Study", "Implementation Timeline"],
    },
    "vp_sales": {
        "lead_with": ["competitive advantage", "win rate improvement", "deal acceleration"],
        "avoid": ["technical complexity", "internal jargon"],
        "preferred_blocks": ["quote_block", "case_study_block", "comparison_table", "metric_block"],
        "tone": "compelling, competitive, proof-heavy",
        "slide_structure": ["Market Opportunity", "Why We Win", "Competitive Comparison", "Customer Stories", "Revenue Impact", "Next Step"],
    },
    "ceo": {
        "lead_with": ["strategic value", "market differentiation", "growth impact", "competitive moat"],
        "avoid": ["granular technical detail", "minor operational metrics"],
        "preferred_blocks": ["title_block", "metric_block", "quote_block", "cta_block"],
        "tone": "visionary, strategic, high-signal — 3 ideas maximum per slide",
        "slide_structure": ["The Opportunity", "Why Now", "Our Differentiation", "Traction", "The Ask"],
    },
}

SYSTEM_PROMPT = """You are an ICP Personalization Agent for ClientLens's sales intelligence system.

Your job is to restructure and rewrite content specifically for the target ICP role.

RULES:
1. Follow the ICP content rules exactly
2. Reorganize slides to match the ICP's mental model
3. Emphasize what matters to this persona — deprioritize the rest
4. Adapt tone as specified (do NOT change facts)
5. Use ONLY approved component types from the Design System

OUTPUT FORMAT (JSON):
{
  "slides": [
    {
      "index": 0,
      "title": "...",
      "components": [
        {"type": "metric_block", "content": "..."}
      ],
      "speaker_notes": "Talking point for sales rep..."
    }
  ],
  "icp_adaptations": ["What was changed and why"],
  "personalization_confidence": 0.9
}"""


class ICPPersonalizationAgent:
    def __init__(self):
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    async def run(self, request: GenerationRequest, brand_compliant_content: dict) -> AgentResult:
        rules = ICP_RULES.get(request.icp_role, ICP_RULES["cfo"])

        prompt = f"""Target Company: {request.company.name}
Industry: {request.company.industry or 'Technology'}
ICP Role: {request.icp_role.upper()}
Use Case: {request.use_case}
Action Type: {request.action_type}
Live Meeting Mode: {getattr(request, 'live_mode', False)}

ICP Rules for {request.icp_role.upper()}:
- Lead with: {', '.join(rules['lead_with'])}
- Avoid: {', '.join(rules['avoid'])}
- Preferred blocks: {', '.join(rules['preferred_blocks'])}
- Tone: {rules['tone']}
- Recommended slide structure: {' → '.join(rules['slide_structure'])}

Available Content (brand-approved):
{json.dumps(brand_compliant_content, indent=2)}

{"LIVE MODE: Be concise. Optimize for speed. Max 3 bullets per slide." if getattr(request, 'live_mode', False) else ""}

Generate personalized slides following the ICP rules. Return valid JSON."""

        try:
            response = await self.client.messages.create(
                model="claude-opus-4-7",
                max_tokens=6000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )

            output = json.loads(response.content[0].text)

            return AgentResult(
                agent="icp_personalization",
                status="pass",
                output=output,
                confidence=output.get("personalization_confidence", 0.85),
            )

        except Exception as e:
            return AgentResult(
                agent="icp_personalization",
                status="fail",
                output={},
                issues=[str(e)],
                confidence=0.0,
            )
