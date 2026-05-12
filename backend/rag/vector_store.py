from pinecone import Pinecone, ServerlessSpec
from config import settings
import structlog

log = structlog.get_logger()

NAMESPACES = ["product_docs", "case_studies", "metrics", "brand_guidelines", "competitor_intel"]


async def init_vector_store():
    """Initialize Pinecone index on startup. Creates if not exists.

    Skips entirely when PINECONE_API_KEY is not set — local dev path. Embeddings
    are stubbed elsewhere so RAG search returns nothing useful anyway; this just
    keeps boot clean instead of logging a noisy init_failed warning.
    """
    if not settings.pinecone_api_key:
        log.info("vector_store.skipped", reason="PINECONE_API_KEY not set (local dev)")
        return
    try:
        pc = Pinecone(api_key=settings.pinecone_api_key)
        existing = [i.name for i in pc.list_indexes()]

        if settings.pinecone_index not in existing:
            pc.create_index(
                name=settings.pinecone_index,
                dimension=1024,
                metric="cosine",
                spec=ServerlessSpec(cloud="aws", region="us-east-1"),
            )
            log.info("vector_store.created", index=settings.pinecone_index)
        else:
            log.info("vector_store.ready", index=settings.pinecone_index)
    except Exception as e:
        log.warning("vector_store.init_failed", error=str(e))
