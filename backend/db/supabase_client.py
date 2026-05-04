from supabase import create_client, Client
from config import settings
from typing import Optional
import structlog

log = structlog.get_logger()

_client: Optional[Client] = None


def supabase_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(settings.supabase_url, settings.supabase_service_key)
    return _client


async def init_supabase():
    supabase_client()
    log.info("supabase.ready")


async def verify_token(token: str) -> Optional[dict]:
    """Verify a Supabase JWT and return user profile."""
    try:
        result = supabase_client().auth.get_user(token)
        if not result.user:
            return None

        profile = (
            supabase_client()
            .table("user_profiles")
            .select("id, email, name, role")
            .eq("id", result.user.id)
            .single()
            .execute()
        )
        return profile.data
    except Exception:
        return None


async def get_design_system() -> Optional[dict]:
    try:
        result = (
            supabase_client()
            .table("design_systems")
            .select("*")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None
    except Exception:
        return None


async def get_brand_voice() -> Optional[dict]:
    try:
        result = (
            supabase_client()
            .table("brand_voice")
            .select("*")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None
    except Exception:
        return None
