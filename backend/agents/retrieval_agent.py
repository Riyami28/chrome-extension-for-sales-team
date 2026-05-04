"""
Agent 1 — RAG Retrieval Agent

Pulls relevant content from:
- Internal product docs (Pinecone vector store)
- Case studies
- Metrics / proof points
- Competitor intel
"""

import anthropic
from models import GenerationRequest, AgentResult
from rag.retriever import retrieve_context
from config import settings

SYSTEM_PROMPT = """You are a RAG retrieval agent for ClientLens's sales intelligence system.

Your job is to:
1. Identify what content is needed based on the generation request
2. Evaluate the retrieved context for relevance and quality
3. Return ONLY factual, sourced content — never invent data
4. Flag if retrieved context is insufficient to generate accurate content

OUTPUT FORMAT (JSON):
{
  "relevant_chunks": [
    {"source": "doc_name", "content": "...", "relevance_score": 0.95}
  ],
  "key_facts": ["fact 1", "fact 2"],
  "metrics": [{"label": "Cost saved", "value": "40%", "source": "case_study_acme"}],
  "case_studies": [{"company": "...", "outcome": "...", "source": "..."}],
  "sources": ["source1", "source2"],
  "retrieval_confidence": 0.85,
  "missing_context": ["what is missing if anything"]
}

HARD RULE: Only return data you found in retrieved context. Never fabricate metrics or outcomes."""


class RetrievalAgent:
    def __init__(self):
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    async def run(self, request: GenerationRequest) -> AgentResult:
        # Build retrieval query from request
        query = _build_query(request)

        # Retrieve from vector store
        chunks = await retrieve_context(
            query=query,
            namespaces=["product_docs", "case_studies", "metrics", "brand_guidelines"],
            top_k=12,
        )

        if not chunks:
            return AgentResult(
                agent="retrieval",
                status="warning",
                output={"relevant_chunks": [], "sources": [], "key_facts": [], "metrics": [], "case_studies": []},
                issues=["No relevant content found in knowledge base — generation will be limited"],
                confidence=0.3,
            )

        context_text = "\n\n".join(
            f"[Source: {c['source']}]\n{c['content']}" for c in chunks
        )

        prompt = f"""Generation Request:
Company: {request.company.name}
Industry: {request.company.industry or 'Unknown'}
ICP Role: {request.icp_role}
Use Case: {request.use_case}
Action: {request.action_type}

Retrieved Context:
{context_text}

Based on the request and retrieved context above, extract and structure the relevant information.
Return valid JSON matching the output format."""

        try:
            response = await self.client.messages.create(
                model="claude-opus-4-7",
                max_tokens=3000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )

            import json
            output = json.loads(response.content[0].text)
            confidence = output.get("retrieval_confidence", 0.7)

            return AgentResult(
                agent="retrieval",
                status="pass" if confidence > 0.5 else "warning",
                output=output,
                confidence=confidence,
            )

        except Exception as e:
            return AgentResult(
                agent="retrieval",
                status="fail",
                output={},
                issues=[str(e)],
                confidence=0.0,
            )


def _build_query(request: GenerationRequest) -> str:
    parts = [
        request.use_case,
        request.company.name,
        request.company.industry or "",
        request.icp_role,
        request.action_type,
    ]
    return " ".join(p for p in parts if p)
