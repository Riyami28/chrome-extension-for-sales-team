"""
RAG Retrieval — Pinecone vector search with namespace routing.

Namespaces:
  product_docs      — product documentation, feature specs
  case_studies      — customer case studies and outcomes
  metrics           — KPIs, benchmark data, proof points
  brand_guidelines  — DS + brand voice (used by Agent 2)
  competitor_intel  — competitive analysis and positioning
"""

from typing import Optional
from pinecone import Pinecone
from rag.embeddings import get_embedding
from config import settings

_pc: Optional[Pinecone] = None
_index = None


def _get_index():
    global _pc, _index
    if _index is None:
        _pc = Pinecone(api_key=settings.pinecone_api_key)
        _index = _pc.Index(settings.pinecone_index)
    return _index


async def retrieve_context(
    query: str,
    namespaces: list[str],
    top_k: int = 8,
    score_threshold: float = 0.6,
) -> list[dict]:
    """Retrieve top-k relevant chunks across specified namespaces."""

    embedding = await get_embedding(query)
    index = _get_index()

    all_results = []

    for namespace in namespaces:
        try:
            results = index.query(
                vector=embedding,
                top_k=top_k,
                namespace=namespace,
                include_metadata=True,
            )
            for match in results.matches:
                if match.score >= score_threshold:
                    all_results.append({
                        "source": match.metadata.get("source", namespace),
                        "content": match.metadata.get("text", ""),
                        "namespace": namespace,
                        "score": match.score,
                        "doc_id": match.id,
                    })
        except Exception:
            continue  # Skip unavailable namespaces gracefully

    # Sort by relevance score, deduplicate by doc_id
    seen = set()
    unique_results = []
    for r in sorted(all_results, key=lambda x: x["score"], reverse=True):
        if r["doc_id"] not in seen:
            seen.add(r["doc_id"])
            unique_results.append(r)

    return unique_results[:top_k]


async def upsert_document(
    doc_id: str,
    text: str,
    namespace: str,
    metadata: dict,
) -> None:
    """Embed and upsert a document chunk into the vector store."""
    embedding = await get_embedding(text)
    index = _get_index()

    index.upsert(
        vectors=[{
            "id": doc_id,
            "values": embedding,
            "metadata": {
                "text": text[:4000],  # Pinecone metadata limit
                **metadata,
            },
        }],
        namespace=namespace,
    )


async def delete_document(doc_id: str, namespace: str) -> None:
    index = _get_index()
    index.delete(ids=[doc_id], namespace=namespace)
