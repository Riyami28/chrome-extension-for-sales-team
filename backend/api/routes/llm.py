"""
LLM proxy router.

Replaces direct provider calls from the Chrome extension. The extension calls
this backend with a Supabase JWT; the backend owns the provider keys and
forwards the request, logging usage to `generation_history`.

Closes part of #1 (security: provider keys exposed in browser).

Slice 1 — Anthropic only. Gemini / Groq / OpenAI-compatible providers return
501 Not Implemented and are tracked as follow-up work in the same issue.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import AsyncIterator, Optional

import structlog
from anthropic import APIError, APIStatusError, AsyncAnthropic
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config import settings
from db.supabase_client import supabase_client
from rbac.roles import require_permission

router = APIRouter()
log = structlog.get_logger()


# ── Request / response shapes ────────────────────────────────────────────────


class LLMRequest(BaseModel):
    """Shared shape for both `/complete` and `/stream`."""

    provider: str = Field(..., description="anthropic | groq | gemini | custom")
    model: str
    system: Optional[str] = None
    user: str
    max_tokens: int = Field(default=2048, ge=1, le=64_000)
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)


class LLMUsage(BaseModel):
    input_tokens: int
    output_tokens: int


class LLMResponse(BaseModel):
    text: str
    model: str
    usage: LLMUsage
    request_id: Optional[str] = None


# ── Anthropic client (lazy singleton) ────────────────────────────────────────


_anthropic_client: Optional[AsyncAnthropic] = None


def _anthropic() -> AsyncAnthropic:
    """Lazy-init so we don't crash module load when the env var isn't set in tests."""
    global _anthropic_client
    if _anthropic_client is None:
        api_key = settings.anthropic_api_key
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="ANTHROPIC_API_KEY is not configured on the backend.",
            )
        _anthropic_client = AsyncAnthropic(api_key=api_key)
    return _anthropic_client


# ── Usage logging (best-effort) ──────────────────────────────────────────────


async def _log_usage(
    user_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    duration_ms: int,
    streamed: bool,
    request_id: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    """
    Record one LLM call to the `llm_usage` table. Best-effort — a Supabase
    failure must not break the user-facing call. See migration 002_llm_usage.sql.
    """
    try:
        supabase_client().table("llm_usage").insert(
            {
                "user_id": user_id,
                "provider": provider,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "duration_ms": duration_ms,
                "streamed": streamed,
                "request_id": request_id,
                "error": error,
            }
        ).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("llm_usage.log_failed", error=str(e), user_id=user_id)


# ── Provider dispatchers ─────────────────────────────────────────────────────


async def _complete_anthropic(req: LLMRequest) -> LLMResponse:
    client = _anthropic()
    # The Anthropic SDK uses a `NOT_GIVEN` sentinel for omitted optional
    # params. Passing Python `None` triggers a validation error. Build kwargs
    # so `temperature` is only included when the caller actually supplied it.
    kwargs: dict = {
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system or "",
        "messages": [{"role": "user", "content": req.user}],
    }
    if req.temperature is not None:
        kwargs["temperature"] = req.temperature
    try:
        resp = await client.messages.create(**kwargs)
    except APIStatusError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    except APIError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Anthropic API error: {e}"
        ) from e

    # Anthropic returns content as a list of blocks; concat the text blocks.
    text_parts = [
        block.text for block in resp.content if getattr(block, "type", None) == "text"
    ]
    return LLMResponse(
        text="".join(text_parts),
        model=resp.model,
        usage=LLMUsage(
            input_tokens=resp.usage.input_tokens,
            output_tokens=resp.usage.output_tokens,
        ),
        request_id=getattr(resp, "id", None),
    )


async def _stream_anthropic(req: LLMRequest, user_id: str) -> AsyncIterator[bytes]:
    """SSE relay — re-emit Anthropic's stream events as plain SSE.

    Logs to llm_usage in a finally block so disconnects and provider errors
    still produce a row (with `error` set) for cost-attribution accuracy.
    """
    client = _anthropic()
    input_tokens = 0
    output_tokens = 0
    model_used = req.model
    request_id: Optional[str] = None
    error_msg: Optional[str] = None
    started = time.perf_counter()

    # Same NOT_GIVEN concern as _complete_anthropic — only pass `temperature`
    # when the caller supplied a value.
    stream_kwargs: dict = {
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system or "",
        "messages": [{"role": "user", "content": req.user}],
    }
    if req.temperature is not None:
        stream_kwargs["temperature"] = req.temperature
    try:
        async with client.messages.stream(**stream_kwargs) as stream:
            async for delta in stream.text_stream:
                if delta:
                    payload = json.dumps({"text": delta})
                    yield f"event: delta\ndata: {payload}\n\n".encode()
            final = await stream.get_final_message()
            input_tokens = final.usage.input_tokens
            output_tokens = final.usage.output_tokens
            model_used = final.model
            request_id = getattr(final, "id", None)

        done = json.dumps(
            {
                "model": model_used,
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
                "request_id": request_id,
            }
        )
        yield f"event: done\ndata: {done}\n\n".encode()
    except APIStatusError as e:
        error_msg = f"anthropic_status_{e.status_code}: {e}"
        err = json.dumps({"error": error_msg})
        yield f"event: error\ndata: {err}\n\n".encode()
    except APIError as e:
        error_msg = f"anthropic_api_error: {e}"
        err = json.dumps({"error": error_msg})
        yield f"event: error\ndata: {err}\n\n".encode()
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        # Fire-and-forget so logging never blocks teardown.
        asyncio.create_task(
            _log_usage(
                user_id=user_id,
                provider=req.provider,
                model=req.model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                duration_ms=elapsed_ms,
                streamed=True,
                request_id=request_id,
                error=error_msg,
            )
        )


# ── Public endpoints ─────────────────────────────────────────────────────────


@router.post("/v1/llm/complete", response_model=LLMResponse)
async def complete(request: Request, body: LLMRequest) -> LLMResponse:
    """
    Non-streaming LLM completion.

    Auth: requires Supabase JWT (enforced by AuthMiddleware).
    Permission: `generate:create` (sales_rep, pmm, designer, admin).
    """
    user = request.state.user
    require_permission(user["role"], "generate:create")

    if body.provider != "anthropic":
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                f"Provider '{body.provider}' is not yet wired through the proxy. "
                f"Tracked as follow-up in the same issue."
            ),
        )

    started = time.perf_counter()
    error_msg: Optional[str] = None
    response: Optional[LLMResponse] = None
    try:
        response = await _complete_anthropic(body)
        return response
    except HTTPException as e:
        error_msg = f"http_{e.status_code}: {e.detail}"
        raise
    except Exception as e:  # noqa: BLE001
        error_msg = str(e)
        raise
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        in_tok = response.usage.input_tokens if response else 0
        out_tok = response.usage.output_tokens if response else 0
        req_id = response.request_id if response else None
        # Fire-and-forget so logging never blocks the response.
        asyncio.create_task(
            _log_usage(
                user_id=user["id"],
                provider=body.provider,
                model=body.model,
                input_tokens=in_tok,
                output_tokens=out_tok,
                duration_ms=elapsed_ms,
                streamed=False,
                request_id=req_id,
                error=error_msg,
            )
        )


@router.post("/v1/llm/stream")
async def stream(request: Request, body: LLMRequest) -> StreamingResponse:
    """
    Streaming LLM completion via SSE.

    Events:
      - `delta` — partial text chunk: `{ "text": "..." }`
      - `done`  — final usage + model: `{ "model", "usage", "request_id" }`
      - `error` — terminal error: `{ "error": "..." }`

    Auth: requires Supabase JWT (enforced by AuthMiddleware).
    """
    user = request.state.user
    require_permission(user["role"], "generate:create")

    if body.provider != "anthropic":
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                f"Provider '{body.provider}' is not yet wired through the proxy. "
                f"Tracked as follow-up in the same issue."
            ),
        )

    return StreamingResponse(
        _stream_anthropic(body, user["id"]),
        media_type="text/event-stream",
        headers={
            # Disable proxy buffering so deltas arrive promptly.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
        },
    )


@router.get("/v1/llm/health")
async def llm_health() -> dict:
    """Lightweight health check — confirms the module loaded and the key is set."""
    return {
        "status": "ok",
        "providers_wired": ["anthropic"],
        "providers_pending": ["gemini", "groq", "custom"],
        "anthropic_key_configured": bool(settings.anthropic_api_key),
    }
