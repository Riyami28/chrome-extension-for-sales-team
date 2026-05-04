"""
Agent 2 — Brand Compliance Agent

Checks all content against:
- Design System component rules
- Brand Voice & Tone guidelines
- Approved messaging framework
- Disallowed words/phrases
"""

import anthropic
import json
from models import GenerationRequest, AgentResult
from db.supabase_client import get_design_system, get_brand_voice
from config import settings

SYSTEM_PROMPT = """You are a Brand Compliance Agent for ClientLens's sales team.

Your job is to:
1. Review the proposed content against the active Design System and Brand Voice guidelines
2. Flag any violations (wrong tone, disallowed words, unapproved component types)
3. Suggest compliant alternatives for flagged items
4. APPROVE content that meets all guidelines
5. REJECT content that fundamentally violates brand standards

OUTPUT FORMAT (JSON):
{
  "approved_content": { ...same structure as input, with corrections applied... },
  "violations": [
    {"type": "tone|word|component|claim", "original": "...", "corrected": "...", "reason": "..."}
  ],
  "overall_status": "pass|warning|fail",
  "brand_score": 0.95
}

PASS = minor adjustments made, output is usable
WARNING = notable violations corrected, flag for human review
FAIL = fundamental brand violation, content must be regenerated"""


class BrandComplianceAgent:
    def __init__(self):
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    async def run(self, request: GenerationRequest, retrieval_output: dict) -> AgentResult:
        # Load current DS and brand voice from DB
        design_system = await get_design_system()
        brand_voice = await get_brand_voice()

        if not design_system or not brand_voice:
            # No DS/BV configured yet — pass through with warning
            return AgentResult(
                agent="brand_compliance",
                status="warning",
                output=retrieval_output,
                issues=["No Design System or Brand Voice configured — skipping compliance check"],
                confidence=0.5,
            )

        prompt = f"""Design System (v{design_system.get('version', '1.0')}):
Allowed components: {', '.join(design_system.get('allowed_components', []))}
Color palette: {json.dumps(design_system.get('colors', {}), indent=2)}

Brand Voice & Tone:
Tone adjectives: {', '.join(brand_voice.get('tone_adjectives', []))}
Avoid words: {', '.join(brand_voice.get('avoid_words', []))}
Tagline: {brand_voice.get('messaging_framework', {}).get('tagline', '')}
Value props: {json.dumps(brand_voice.get('messaging_framework', {}).get('value_props', []))}

ICP-specific tone override for {request.icp_role}:
{json.dumps(brand_voice.get('icp_tone_overrides', {}).get(request.icp_role, []))}

Content to review:
{json.dumps(retrieval_output, indent=2)}

Review the content and return compliant output in the specified JSON format."""

        try:
            response = await self.client.messages.create(
                model="claude-opus-4-7",
                max_tokens=4000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )

            output = json.loads(response.content[0].text)
            status = output.get("overall_status", "pass")
            violations = output.get("violations", [])

            return AgentResult(
                agent="brand_compliance",
                status=status,
                output=output.get("approved_content", retrieval_output),
                issues=[v["reason"] for v in violations] if violations else None,
                confidence=output.get("brand_score", 0.8),
            )

        except Exception as e:
            return AgentResult(
                agent="brand_compliance",
                status="warning",
                output=retrieval_output,
                issues=[f"Brand check error: {e}"],
                confidence=0.5,
            )
