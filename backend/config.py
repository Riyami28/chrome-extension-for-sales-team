from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # Anthropic
    anthropic_api_key: str

    # Supabase
    supabase_url: str
    supabase_service_key: str

    # Pinecone
    pinecone_api_key: str
    pinecone_index: str = "clientlens"

    # Google
    google_client_id: str = ""
    google_client_secret: str = ""

    # App
    backend_url: str = "http://localhost:8000"
    allowed_origins: List[str] = ["chrome-extension://", "http://localhost:3000"]
    jwt_secret: str = "change-me-in-production"

    class Config:
        env_file = ".env"


settings = Settings()
