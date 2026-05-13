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

    # Deepgram — kept server-side so the API key is never baked into the
    # extension bundle. The /api/v1/stt/token endpoint mints short-lived
    # (60 s) temporary keys for the extension to use directly with Deepgram.
    deepgram_api_key: str = ""
    deepgram_project_id: str = ""  # required to mint temp keys; get from Deepgram console

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

# Fail-fast if someone ships the placeholder jwt_secret to a non-dev deployment.
# pydantic-settings silently accepts it, so we guard here instead.
if settings.jwt_secret == "change-me-in-production" and not settings.dev_mode:
    raise RuntimeError(
        "JWT_SECRET is still set to the placeholder value 'change-me-in-production'. "
        "Set a real secret in your .env before starting the server. "
        "If you are running local dev without JWT auth, set DEV_MODE=true."
    )
