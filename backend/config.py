from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # LLM provider keys — optional per deployment. The proxy returns 503 if a
    # request comes in for a provider whose key isn't configured.
    anthropic_api_key: str = ""
    gemini_api_key: str = ""
    groq_api_key: str = ""
    openrouter_api_key: str = ""

    # OpenRouter app attribution headers — recommended but optional.
    # https://openrouter.ai/docs/api-reference/overview#app-attribution
    openrouter_referer: str = "https://clientlens.zopnight.com"
    openrouter_title: str = "ClientLens"

    # Supabase
    supabase_url: str
    supabase_service_key: str

    # Pinecone — optional for local dev. Embeddings are stubbed (zero vectors)
    # so RAG search is non-functional regardless; init is skipped if key empty.
    pinecone_api_key: str = ""
    pinecone_index: str = "clientlens"

    # Google
    google_client_id: str = ""
    google_client_secret: str = ""

    # App
    backend_url: str = "http://localhost:8000"
    allowed_origins: List[str] = ["chrome-extension://", "http://localhost:3000"]
    jwt_secret: str = "change-me-in-production"

    # Local dev: skip JWT verification, inject stub user in AuthMiddleware.
    # Never enable in production.
    dev_mode: bool = False

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
