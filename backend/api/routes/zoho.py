"""
Zoho CRM OAuth refresh proxy.

The extension stores only the refresh_token in chrome.storage.local.
The client_id + client_secret stay server-side so they're never exposed
in the extension bundle. Closes #33.

Route: POST /api/v1/zoho/refresh
Body:  { refresh_token: str, dc: str }   (dc = "com" | "eu" | "in" | ...)
Returns: { access_token: str, expires_in: int }
"""

from __future__ import annotations

import httpx
import structlog
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import settings

router = APIRouter()
log = structlog.get_logger()


class ZohoRefreshRequest(BaseModel):
    refresh_token: str
    dc: str = "com"  # data-centre suffix for accounts.zoho.<dc>


class ZohoExchangeRequest(BaseModel):
    code: str
    redirect_uri: str
    dc: str = "com"


@router.post("/v1/zoho/exchange")
async def zoho_exchange(body: ZohoExchangeRequest):
    """Exchange a Zoho authorization code for access + refresh tokens.

    The client_id and client_secret are read from server environment variables
    so they never touch the browser.
    """
    client_id = settings.zoho_client_id
    client_secret = settings.zoho_client_secret
    if not client_id or not client_secret:
        raise HTTPException(503, "Zoho credentials not configured on the server.")

    dc = "".join(c for c in body.dc if c.isalpha() or c == ".").strip(".") or "com"
    accounts_url = f"https://accounts.zoho.{dc}/oauth/v2/token"

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            accounts_url,
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": body.redirect_uri,
                "code": body.code,
            },
        )

    if resp.status_code != 200:
        raise HTTPException(resp.status_code, f"Zoho code exchange failed: {resp.status_code}")

    data = resp.json()
    if "access_token" not in data:
        raise HTTPException(502, f"Zoho returned no access_token: {data}")

    return {
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token", ""),
        "expires_in": data.get("expires_in", 3600),
    }


@router.post("/v1/zoho/refresh")
async def zoho_refresh(body: ZohoRefreshRequest):
    """Exchange a Zoho refresh token for a new access token.

    The client_id and client_secret are read from server environment variables
    (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET) so they never touch the browser.
    """
    client_id = settings.zoho_client_id
    client_secret = settings.zoho_client_secret
    if not client_id or not client_secret:
        raise HTTPException(
            503,
            "Zoho credentials not configured on the server. "
            "Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in the backend .env.",
        )

    # Sanitise the dc suffix — only lowercase letters and dots.
    dc = "".join(c for c in body.dc if c.isalpha() or c == ".").strip(".") or "com"
    accounts_url = f"https://accounts.zoho.{dc}/oauth/v2/token"

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            accounts_url,
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": body.refresh_token,
            },
        )

    if resp.status_code != 200:
        log.warning("zoho_refresh_failed", status=resp.status_code, body=resp.text[:200])
        raise HTTPException(resp.status_code, f"Zoho token refresh failed: {resp.status_code}")

    data = resp.json()
    if "access_token" not in data:
        raise HTTPException(502, f"Zoho returned no access_token: {data}")

    return {
        "access_token": data["access_token"],
        "expires_in": data.get("expires_in", 3600),
    }
