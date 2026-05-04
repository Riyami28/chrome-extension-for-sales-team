"""
Agent 4 — Validation & Fact-Check Agent

Cross-checks final content against:
- Original retrieved sources (hallucination detection)
- Agent 1 raw facts and metrics
- Internal consistency (no contradictory claims)
- Completeness check
"""

import anthropic
import json
from models import GenerationRequest, AgentResult
from config import settings

SYSTEM_PROMPT = """You are a Validation and Fact-Checking Agent for ClientLens's sales intelligence system.

Your job is the FINAL quality gate before content reaches a customer.

CHECKS TO PERFORM:
1. HALLUCINATION CHECK: Every claim in the slides must be traceable to the retrieved source context
2. METRIC ACCURACY: All numbers, percentages, and statistics must match the source data exactly
3. CONSISTENCY CHECK: No contradictory statements across slides
4. COMPLETENESS: Required slide structure for the ICP must be present
5. SOURCE INTEGRITY: Flag any claim with no clear source

GRADING:
- "pass": All checks pass, content is approved for delivery
- "warning": Minor issues found, corrections applied — content is usable but flag for review
- "fail": Hallucinated claims found that cannot be corrected — reject and request regeneration

OUTPUT FORMAT (JSON):
{
  "validated_slides": [...same as input slides but corrected...],
  "hallucination_flags": [
    {"slide": 1, "claim": "...", "issue": "no source found", "action": "removed|corrected|flagged"}
  ],
  "metrics_verified": [
    {"metric": "40% cost reduction", "source": "case_study_acme.pdf", "status": "verified"}
  ],
  "overall_status": "pass|warning|fail",
  "validation_confidence": 0.95,
  "issues": []
}

CRITICAL: When in doubt, REMOVE the claim rather than leave a potentially false statement."""


class ValidationAgent:
    def __init__(self):
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    async def run(
        self,
        request: GenerationRequest,
        raw_content: dict,
        personalized_content: dict,
    ) -> AgentResult:

        prompt = f"""SOURCE OF TRUTH (retrieved facts — Agent 1 output):
{json.dumps(raw_content, indent=2)}

CONTENT TO VALIDATE (Agent 3 personalized output):
{json.dumps(personalized_content, indent=2)}

Target: {request.company.name} | ICP: {request.icp_role} | Action: {request.action_type}

Validate ALL claims in the personalized content against the source of truth.
Any metric, statistic, or outcome not found in the source of truth must be flagged.
Return valid JSON with validated_slides (corrected) and full audit trail."""

        try:
            response = await self.client.messages.create(
                model="claude-opus-4-7",
                max_tokens=6000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )

            output = json.loads(response.content[0].text)
            status = output.get("overall_status", "pass")
            hallucination_flags = output.get("hallucination_flags", [])

            # Hard fail if hallucinations found that couldn't be corrected
            hard_fails = [f for f in hallucination_flags if f.get("action") == "flagged"]

            return AgentResult(
                agent="validation",
                status="fail" if hard_fails else status,
                output={
                    "slides": output.get("validated_slides", []),
                    "sources": list({
                        m.get("source", "")
                        for m in output.get("metrics_verified", [])
                        if m.get("source")
                    }),
                },
                issues=(
                    [f"Unverified claim on slide {f['slide']}: {f['claim']}" for f in hard_fails]
                    if hard_fails else output.get("issues", [])
                ),
                confidence=output.get("validation_confidence", 0.9),
            )

        except Exception as e:
            return AgentResult(
                agent="validation",
                status="fail",
                output={},
                issues=[str(e)],
                confidence=0.0,
            )
