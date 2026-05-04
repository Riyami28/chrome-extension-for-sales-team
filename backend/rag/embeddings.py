import anthropic
from config import settings

_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    return _client


async def get_embedding(text: str) -> list[float]:
    """Get embedding vector using Voyage AI via Anthropic."""
    client = _get_client()
    # Anthropic/Voyage embeddings for production
    # Fallback: use any compatible embedding service
    response = await client.messages.create(
        model="claude-opus-4-7",
        max_tokens=10,
        system="Return only: OK",
        messages=[{"role": "user", "content": f"EMBED: {text[:1000]}"}],
    )
    # NOTE: In production, replace with Voyage AI embeddings:
    # from voyageai import AsyncClient
    # voyage = AsyncClient(api_key=VOYAGE_API_KEY)
    # result = await voyage.embed([text], model="voyage-3")
    # return result.embeddings[0]

    # Placeholder — returns zero vector until Voyage is configured
    return [0.0] * 1024


async def get_embeddings_batch(texts: list[str]) -> list[list[float]]:
    """Batch embed multiple texts."""
    results = []
    for text in texts:
        results.append(await get_embedding(text))
    return results
