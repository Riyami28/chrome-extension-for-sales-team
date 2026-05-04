"""
Multi-agent orchestration pipeline.

Flow:
  Agent 1 (Retrieval)  →  Agent 2 (Brand Compliance)
                                    ↓
  Agent 3 (ICP Personalization)  →  Agent 4 (Validation)
                                    ↓
                              Final Output
"""

import asyncio
import uuid
from typing import AsyncIterator
from datetime import datetime

import structlog

from agents.retrieval_agent import RetrievalAgent
from agents.brand_compliance_agent import BrandComplianceAgent
from agents.icp_personalization_agent import ICPPersonalizationAgent
from agents.validation_agent import ValidationAgent
from models import GenerationRequest, PipelineResult, AgentResult

log = structlog.get_logger()


class AgentOrchestrator:
    def __init__(self):
        self.retrieval = RetrievalAgent()
        self.brand = BrandComplianceAgent()
        self.icp = ICPPersonalizationAgent()
        self.validator = ValidationAgent()

    async def run(self, request: GenerationRequest) -> AsyncIterator[dict]:
        request_id = str(uuid.uuid4())
        log.info("pipeline.start", request_id=request_id, company=request.company.name)

        agent_results: list[AgentResult] = []

        # ── Stage 1: Retrieval ──────────────────────────────────────────────
        yield {"type": "progress", "stage": "retrieval"}

        retrieval_result = await self.retrieval.run(request)
        agent_results.append(retrieval_result)

        if retrieval_result.status == "fail":
            yield {"type": "error", "message": "Retrieval failed: " + str(retrieval_result.issues)}
            return

        # ── Stage 2: Brand Compliance ───────────────────────────────────────
        yield {"type": "progress", "stage": "brand_check"}

        brand_result = await self.brand.run(request, retrieval_result.output)
        agent_results.append(brand_result)

        # Brand check failure is a hard stop
        if brand_result.status == "fail":
            yield {
                "type": "error",
                "message": "Brand compliance check failed: " + str(brand_result.issues),
            }
            return

        # ── Stage 3: ICP Personalization ────────────────────────────────────
        yield {"type": "progress", "stage": "icp_personalize"}

        icp_result = await self.icp.run(request, brand_result.output)
        agent_results.append(icp_result)

        # ── Stage 4: Validation & Fact-check ───────────────────────────────
        yield {"type": "progress", "stage": "validation"}

        validation_result = await self.validator.run(
            request=request,
            raw_content=retrieval_result.output,
            personalized_content=icp_result.output,
        )
        agent_results.append(validation_result)

        if validation_result.status == "fail":
            yield {
                "type": "error",
                "message": "Validation failed — content may contain hallucinations: " + str(validation_result.issues),
            }
            return

        # ── Final Assembly ──────────────────────────────────────────────────
        yield {"type": "progress", "stage": "generating"}

        final_output = validation_result.output
        renderable_text = _build_renderable_text(final_output.get("slides", []))

        result = PipelineResult(
            request_id=request_id,
            agents=agent_results,
            final_output={
                "slides": final_output.get("slides", []),
                "renderable_text": renderable_text,
                "structured_json": final_output,
            },
            metadata={
                "sources_used": retrieval_result.output.get("sources", []),
                "brand_compliant": brand_result.status != "fail",
                "hallucination_check": "clean" if validation_result.status == "pass" else "flagged",
                "generated_at": datetime.utcnow().isoformat(),
            },
        )

        yield {"type": "result", "data": result.model_dump()}
        log.info("pipeline.complete", request_id=request_id)


def _build_renderable_text(slides: list[dict]) -> str:
    lines = []
    for i, slide in enumerate(slides, 1):
        lines.append(f"Slide {i}: {slide.get('title', '')}")
        lines.append("─" * 40)
        for component in slide.get("components", []):
            content = component.get("content", "")
            if isinstance(content, str):
                lines.append(content)
            elif isinstance(content, dict):
                for k, v in content.items():
                    lines.append(f"  {k}: {v}")
        if slide.get("speaker_notes"):
            lines.append(f"\n[Notes]: {slide['speaker_notes']}")
        lines.append("")
    return "\n".join(lines)
