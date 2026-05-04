from pinecone import Pinecone, ServerlessSpec
from config import settings
import structlog

log = structlog.get_logger()

NAMESPACES = ["product_docs", "case_studies", "metrics", "brand_guidelines", "competitor_intel"]


async def init_vector_store():
    """Initialize Pinecone index on startup. Creates if not exists."""
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
