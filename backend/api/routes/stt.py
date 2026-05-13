"""
STT token endpoint — mints a short-lived Deepgram temporary key.

The Deepgram API key lives in backend .env (DEEPGRAM_API_KEY) and is never
sent to the extension. Instead, each session fetches a 60-second temp key
from this endpoint and opens the Deepgram WebSocket with that. Once the
WebSocket is open, Deepgram keeps it alive even after the key expires.

Requires DEEPGRAM_API_KEY + DEEPGRAM_PROJECT_ID in .env.
Get your project ID from https://console.deepgram.com → Settings → Projects.
"""

from fastapi import APIRouter, HTTPException, Request
import httpx
import structlog

from config import settings

router = APIRouter()
log = structlog.get_logger()

_DEEPGRAM_KEYS_URL = "https://api.deepgram.com/v1/projects/{project_id}/keys"


@router.get("/v1/stt/token")
async def get_stt_token(request: Request) -> dict:
    """
    Return a short-lived Deepgram temporary key (TTL 60 s).

    Auth: requires valid Supabase JWT (enforced by AuthMiddleware).
    The key is scoped to `usage:write` only — sufficient for live transcription,
    cannot be used to read usage data or manage the project.
    """
    # Auth is already enforced by AuthMiddleware — request.state.user is set.
    user = request.state.user
    if not settings.deepgram_api_key or not settings.deepgram_project_id:
        log.warning("stt.token.not_configured", user_id=user.get("id"))
        raise HTTPException(
            status_code=503,
            detail="STT service is not configured on this server.",
        )

    url = _DEEPGRAM_KEYS_URL.format(project_id=settings.deepgram_project_id)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(
                url,
                headers={
                    "Authorization": f"Token {settings.deepgram_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "comment": f"clientlens-session-{user.get('id', 'unknown')[:8]}",
                    "scopes": ["usage:write"],
                    "time_to_live_in_seconds": 60,
                    "tags": ["clientlens", "ephemeral"],
                },
            )
    except httpx.RequestError as exc:
        log.error("stt.token.network_error", error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Deepgram API.")

    if not res.is_success:
        log.warning("stt.token.deepgram_error", status=res.status_code, body=res.text[:200])
        raise HTTPException(status_code=502, detail="Deepgram rejected the token request.")

    data = res.json()
    temp_key = data.get("key")
    if not temp_key:
        log.error("stt.token.missing_key", response=str(data)[:200])
        raise HTTPException(status_code=502, detail="Deepgram response missing key field.")

    log.info("stt.token.issued", user_id=user.get("id"), key_id=data.get("api_key_id"))
    return {"token": temp_key, "expires_in": 60}
