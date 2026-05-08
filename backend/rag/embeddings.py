async def get_embedding(text: str) -> list[float]:
    """Placeholder embedding — returns zero vector until Voyage AI is wired up.

    The previous version made a real (paid) Anthropic completion call and threw
    the result away, returning a zero vector — a money leak whenever RAG ran.

    Production wiring:
        from voyageai import AsyncClient
        voyage = AsyncClient(api_key=VOYAGE_API_KEY)
        result = await voyage.embed([text], model="voyage-3")
        return result.embeddings[0]
    """
    _ = text
    return [0.0] * 1024


async def get_embeddings_batch(texts: list[str]) -> list[list[float]]:
    """Batch embed multiple texts."""
    return [await get_embedding(t) for t in texts]
