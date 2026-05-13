"""
LLM proxy router.

Replaces direct provider calls from the Chrome extension. The extension calls
this backend with a Supabase JWT; the backend owns the provider keys and
forwards the request, logging usage to `llm_usage`.

Closes #1 (security: provider keys exposed in browser).

Providers handled here:
  - anthropic — via the official `anthropic` SDK (streaming via SDK)
  - gemini    — via direct HTTPS to `generativelanguage.googleapis.com`
  - groq      — via direct HTTPS to `api.groq.com` (OpenAI-compatible chat)
  - custom    — REJECTED at this proxy. Custom is the user-supplied endpoint
                escape hatch; the extension calls it directly. Documented.

Embeddings (`/embed`) are Gemini-only and used by the in-browser vector store.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import AsyncIterator, Optional

import httpx
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


# ── OpenRouter global rate-limiter ───────────────────────────────────────────
# Free tier allows ~10 req/min per model. We enforce a 3-second minimum gap
# between calls + a concurrency cap of 1 so burst requests from the council
# pipeline (4 sequential agents) and live copilot don't stack up and 429.
# Requests queue here rather than failing — worst case a pitch takes ~12s
# instead of ~3s, which is far better than an error.

_or_lock = asyncio.Semaphore(1)       # only 1 OpenRouter call in-flight at a time
_or_last_call: float = 0.0            # epoch seconds of last completed call
_OR_MIN_GAP_S = 3.0                   # minimum seconds between calls


async def _or_post(headers: dict, body: dict) -> httpx.Response:
    """Rate-limited POST to OpenRouter. Queues callers instead of 429-ing."""
    global _or_last_call
    async with _or_lock:
        gap = _OR_MIN_GAP_S - (time.monotonic() - _or_last_call)
        if gap > 0:
            log.debug("openrouter.throttle", wait_s=round(gap, 2))
            await asyncio.sleep(gap)
        try:
            return await _http().post(OPENROUTER_URL, headers=headers, json=body)
        finally:
            _or_last_call = time.monotonic()


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


# ── Provider clients (lazy singletons) ───────────────────────────────────────


_anthropic_client: Optional[AsyncAnthropic] = None
_httpx_client: Optional[httpx.AsyncClient] = None


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


def _http() -> httpx.AsyncClient:
    """Shared httpx client for Gemini / Groq. 60s timeout covers slow models."""
    global _httpx_client
    if _httpx_client is None:
        _httpx_client = httpx.AsyncClient(timeout=60.0)
    return _httpx_client


def _gemini_key() -> str:
    if not settings.gemini_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GEMINI_API_KEY is not configured on the backend.",
        )
    return settings.gemini_api_key


def _groq_key() -> str:
    if not settings.groq_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GROQ_API_KEY is not configured on the backend.",
        )
    return settings.groq_api_key


def _openrouter_key() -> str:
    if not settings.openrouter_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENROUTER_API_KEY is not configured on the backend.",
        )
    return settings.openrouter_api_key


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
    # Dev-mode stub user has no row in user_profiles — skip DB write to avoid
    # FK violation noise in logs. Usage tracking is irrelevant for local dev.
    if settings.dev_mode:
        return
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


# ── Gemini dispatch ──────────────────────────────────────────────────────────


def _gemini_url(model: str, action: str) -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:{action}"


def _gemini_body(req: LLMRequest, *, json_mode: bool = True) -> dict:
    """
    Build a Gemini generateContent body. Council prompts expect JSON-only
    responses; the original GeminiClient appends a JSON instruction and sets
    `responseMimeType: application/json`. We preserve that contract.
    """
    sys_text = (req.system or "")
    if json_mode:
        sys_text = f"{sys_text}\nRespond with a single JSON object. No prose, no markdown fences.".strip()
    body: dict = {
        "contents": [{"role": "user", "parts": [{"text": req.user}]}],
        "generationConfig": {
            "maxOutputTokens": req.max_tokens,
            "temperature": req.temperature if req.temperature is not None else 0.3,
        },
    }
    if sys_text:
        body["systemInstruction"] = {"parts": [{"text": sys_text}]}
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    return body


async def _complete_gemini(req: LLMRequest) -> LLMResponse:
    api_key = _gemini_key()
    url = _gemini_url(req.model, "generateContent")
    res = await _http().post(
        url,
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        json=_gemini_body(req),
    )
    if res.status_code >= 400:
        raise HTTPException(status_code=res.status_code, detail=f"Gemini {res.status_code}: {res.text[:300]}")
    data = res.json()
    text = ""
    candidates = data.get("candidates") or []
    if candidates:
        parts = candidates[0].get("content", {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts)
    usage = data.get("usageMetadata") or {}
    return LLMResponse(
        text=text,
        model=req.model,
        usage=LLMUsage(
            input_tokens=usage.get("promptTokenCount", 0),
            output_tokens=usage.get("candidatesTokenCount", 0),
        ),
        request_id=None,
    )


async def _stream_gemini(req: LLMRequest, user_id: str) -> AsyncIterator[bytes]:
    """
    Gemini streaming via :streamGenerateContent.
    Returns a JSON array streamed in chunks, each chunk a partial generateContent
    result. We extract text and re-emit as standard SSE deltas to keep the
    extension-side parser provider-agnostic.
    """
    api_key = _gemini_key()
    url = _gemini_url(req.model, "streamGenerateContent") + "?alt=sse"
    input_tokens = 0
    output_tokens = 0
    error_msg: Optional[str] = None
    started = time.perf_counter()

    try:
        async with _http().stream(
            "POST",
            url,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json=_gemini_body(req),
        ) as res:
            if res.status_code >= 400:
                body = await res.aread()
                error_msg = f"gemini_status_{res.status_code}: {body[:300].decode(errors='replace')}"
                yield f"event: error\ndata: {json.dumps({'error': error_msg})}\n\n".encode()
                return

            async for line in res.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                # Extract text from candidates[0].content.parts[*].text
                cand = (chunk.get("candidates") or [{}])[0]
                parts = cand.get("content", {}).get("parts") or []
                delta = "".join(p.get("text", "") for p in parts)
                if delta:
                    yield f"event: delta\ndata: {json.dumps({'text': delta})}\n\n".encode()
                # Some chunks carry running usage; keep last seen.
                u = chunk.get("usageMetadata") or {}
                input_tokens = u.get("promptTokenCount", input_tokens)
                output_tokens = u.get("candidatesTokenCount", output_tokens)

        done = json.dumps(
            {
                "model": req.model,
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
                "request_id": None,
            }
        )
        yield f"event: done\ndata: {done}\n\n".encode()
    except httpx.HTTPError as e:
        error_msg = f"gemini_http_error: {e}"
        yield f"event: error\ndata: {json.dumps({'error': error_msg})}\n\n".encode()
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        asyncio.create_task(
            _log_usage(
                user_id=user_id,
                provider=req.provider,
                model=req.model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                duration_ms=elapsed_ms,
                streamed=True,
                error=error_msg,
            )
        )


# ── Groq dispatch (OpenAI-compatible chat completions) ────────────────────────

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


def _groq_body(req: LLMRequest, *, stream: bool = False) -> dict:
    return {
        "model": req.model,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature if req.temperature is not None else 0.3,
        "response_format": {"type": "json_object"},
        "stream": stream,
        "messages": [
            {
                "role": "system",
                "content": f"{req.system or ''}\nRespond with a single JSON object. No prose, no markdown fences.".strip(),
            },
            {"role": "user", "content": req.user},
        ],
    }


async def _complete_groq(req: LLMRequest) -> LLMResponse:
    api_key = _groq_key()
    res = await _http().post(
        GROQ_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=_groq_body(req),
    )
    if res.status_code >= 400:
        raise HTTPException(status_code=res.status_code, detail=f"Groq {res.status_code}: {res.text[:300]}")
    data = res.json()
    text = ""
    choices = data.get("choices") or []
    if choices:
        text = choices[0].get("message", {}).get("content", "") or ""
    usage = data.get("usage") or {}
    return LLMResponse(
        text=text,
        model=data.get("model", req.model),
        usage=LLMUsage(
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
        ),
        request_id=data.get("id"),
    )


async def _stream_groq(req: LLMRequest, user_id: str) -> AsyncIterator[bytes]:
    """Groq SSE re-emit. Groq returns standard OpenAI chunked SSE."""
    api_key = _groq_key()
    input_tokens = 0
    output_tokens = 0
    request_id: Optional[str] = None
    error_msg: Optional[str] = None
    started = time.perf_counter()

    try:
        async with _http().stream(
            "POST",
            GROQ_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=_groq_body(req, stream=True),
        ) as res:
            if res.status_code >= 400:
                body = await res.aread()
                error_msg = f"groq_status_{res.status_code}: {body[:300].decode(errors='replace')}"
                yield f"event: error\ndata: {json.dumps({'error': error_msg})}\n\n".encode()
                return

            async for line in res.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                request_id = chunk.get("id") or request_id
                choices = chunk.get("choices") or []
                if choices:
                    delta = choices[0].get("delta", {}).get("content")
                    if delta:
                        yield f"event: delta\ndata: {json.dumps({'text': delta})}\n\n".encode()
                # Groq sometimes includes usage on the final chunk.
                usage = chunk.get("x_groq", {}).get("usage") if "x_groq" in chunk else chunk.get("usage")
                if usage:
                    input_tokens = usage.get("prompt_tokens", input_tokens)
                    output_tokens = usage.get("completion_tokens", output_tokens)

        done = json.dumps(
            {
                "model": req.model,
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
                "request_id": request_id,
            }
        )
        yield f"event: done\ndata: {done}\n\n".encode()
    except httpx.HTTPError as e:
        error_msg = f"groq_http_error: {e}"
        yield f"event: error\ndata: {json.dumps({'error': error_msg})}\n\n".encode()
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
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


# ── OpenRouter dispatch (OpenAI-compatible chat completions) ─────────────────
#
# OpenRouter is a gateway. Same wire format as Groq, but model IDs are
# namespaced (e.g. `meta-llama/llama-3.3-70b-instruct:free`). We skip
# `response_format: json_object` here because not every routed model supports
# it; the council code already parses JSON from prose/fenced blocks. The system
# prompt still nudges JSON-only output to keep parser hit-rate high.

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Free-tier OpenRouter rate limits recover in ~10s. We retry up to 2 times
# with a short sleep rather than immediately surfacing a 429 to the user.
_OR_RETRY_DELAYS = [5, 12]  # seconds before 1st and 2nd retry


def _openrouter_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        # App attribution — visible on openrouter.ai/activity. Optional.
        "HTTP-Referer": settings.openrouter_referer,
        "X-Title": settings.openrouter_title,
    }


def _openrouter_body(req: LLMRequest, *, stream: bool = False) -> dict:
    return {
        "model": req.model,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature if req.temperature is not None else 0.3,
        "stream": stream,
        "messages": [
            {
                "role": "system",
                "content": f"{req.system or ''}\nRespond with a single JSON object. No prose, no markdown fences.".strip(),
            },
            {"role": "user", "content": req.user},
        ],
    }


async def _complete_openrouter(req: LLMRequest) -> LLMResponse:
    import asyncio as _asyncio
    import uuid as _uuid
    api_key = _openrouter_key()
    res = None
    for attempt, delay in enumerate([0] + _OR_RETRY_DELAYS):
        if delay:
            log.info("openrouter.retry", attempt=attempt, delay_s=delay, model=req.model)
            await _asyncio.sleep(delay)
        res = await _or_post(_openrouter_headers(api_key), _openrouter_body(req))
        if res.status_code != 429:
            break
        log.warning("openrouter.rate_limited", attempt=attempt, model=req.model)
    assert res is not None
    if res.status_code >= 400:
        req_id = str(_uuid.uuid4())
        # Log full upstream body server-side; never echo it to the client —
        # OpenRouter bodies can contain prompt fragments or routing metadata.
        log.warning(
            "openrouter.upstream_error",
            status=res.status_code,
            body=res.text[:500],
            request_id=req_id,
        )
        raise HTTPException(
            status_code=res.status_code,
            detail={"error": "upstream_error", "request_id": req_id},
        )
    data = res.json()
    text = ""
    choices = data.get("choices") or []
    if choices:
        text = choices[0].get("message", {}).get("content", "") or ""
    usage = data.get("usage") or {}
    return LLMResponse(
        text=text,
        model=data.get("model", req.model),
        usage=LLMUsage(
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
        ),
        request_id=data.get("id"),
    )


async def _stream_openrouter(req: LLMRequest, user_id: str) -> AsyncIterator[bytes]:
    """OpenRouter SSE re-emit. Standard OpenAI chunked SSE.

    Retries up to 2 times on 429 with short sleeps before opening the stream,
    so transient free-tier rate limits don't surface as errors to the client.
    """
    import asyncio as _asyncio
    import uuid as _uuid
    api_key = _openrouter_key()
    input_tokens = 0
    output_tokens = 0
    request_id: Optional[str] = None
    error_msg: Optional[str] = None
    started = time.perf_counter()

    # Pre-flight 429 check: send a non-streaming probe first so we can
    # retry the rate limit before opening the SSE stream (can't re-open
    # a generator mid-flight once yielding has started).
    for attempt, delay in enumerate([0] + _OR_RETRY_DELAYS):
        if delay:
            log.info("openrouter.stream_retry", attempt=attempt, delay_s=delay, model=req.model)
            await _asyncio.sleep(delay)
        probe = await _or_post(_openrouter_headers(api_key), _openrouter_body(req))
        if probe.status_code != 429:
            break
        log.warning("openrouter.stream_rate_limited", attempt=attempt, model=req.model)
    else:
        # All retries exhausted on 429 — surface it as an SSE error event.
        req_id = str(_uuid.uuid4())
        log.warning("openrouter.stream_rate_limited_fatal", model=req.model, request_id=req_id)
        yield f"event: error\ndata: {json.dumps({'error': 'upstream_error', 'request_id': req_id})}\n\n".encode()
        return

    # If the probe itself returned a non-429 error, surface it.
    if probe.status_code >= 400:
        req_id = str(_uuid.uuid4())
        log.warning("openrouter.stream_upstream_error", status=probe.status_code,
                    body=probe.text[:500], request_id=req_id)
        yield f"event: error\ndata: {json.dumps({'error': 'upstream_error', 'request_id': req_id})}\n\n".encode()
        return

    # Probe succeeded — use its response directly (avoids a second round-trip).
    try:
        data = probe.json()
        choices = data.get("choices") or []
        text = choices[0].get("message", {}).get("content", "") if choices else ""
        usage_d = data.get("usage") or {}
        input_tokens = usage_d.get("prompt_tokens", 0)
        output_tokens = usage_d.get("completion_tokens", 0)
        request_id = data.get("id")
        if text:
            yield f"event: delta\ndata: {json.dumps({'text': text})}\n\n".encode()
        done = json.dumps({
            "model": data.get("model", req.model),
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
            "request_id": request_id,
        })
        yield f"event: done\ndata: {done}\n\n".encode()
    except Exception as exc:
        error_msg = f"openrouter_parse_error: {exc}"
        yield f"event: error\ndata: {json.dumps({'error': error_msg})}\n\n".encode()
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        asyncio.create_task(
            _log_usage(user_id=user_id, provider=req.provider, model=req.model,
                       input_tokens=input_tokens, output_tokens=output_tokens,
                       duration_ms=elapsed_ms, streamed=True,
                       request_id=request_id, error=error_msg)
        )


# ── Embeddings (Gemini text-embedding-004) ───────────────────────────────────


class EmbedRequest(BaseModel):
    """One or many texts to embed. Gemini accepts up to 100 per batch call."""

    texts: list[str] = Field(..., min_length=1, max_length=100)
    model: str = Field(default="text-embedding-004")


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    model: str
    dims: int


# ── Public endpoints ─────────────────────────────────────────────────────────


_PROXIED_PROVIDERS = {"anthropic", "gemini", "groq", "openrouter"}


def _reject_unproxied(provider: str) -> None:
    """
    Reject providers that intentionally do not flow through the proxy.

    `custom` — user-supplied OpenAI-compatible endpoint. The user picks both
        the URL and the credential. Routing through the backend would require
        accepting attacker-controlled URLs and credentials, which is worse than
        leaving the call direct. Documented in the README.

    `ollama` — local-only (`http://localhost:11434`). No security concern;
        the backend can't reach the user's localhost anyway.

    Anything else not in the proxied set is unsupported.
    """
    if provider in {"custom", "ollama"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Provider '{provider}' is intentionally direct-only and must not be "
                f"routed through the proxy. Call it from the extension directly."
            ),
        )
    if provider not in _PROXIED_PROVIDERS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown provider '{provider}'. Supported: {sorted(_PROXIED_PROVIDERS)}.",
        )


@router.post("/v1/llm/complete", response_model=LLMResponse)
async def complete(request: Request, body: LLMRequest) -> LLMResponse:
    """
    Non-streaming LLM completion.

    Auth: requires Supabase JWT (enforced by AuthMiddleware).
    Permission: `generate:create` (sales_rep, pmm, designer, admin).
    """
    user = request.state.user
    require_permission(user["role"], "generate:create")
    _reject_unproxied(body.provider)

    started = time.perf_counter()
    error_msg: Optional[str] = None
    response: Optional[LLMResponse] = None
    try:
        if body.provider == "anthropic":
            response = await _complete_anthropic(body)
        elif body.provider == "gemini":
            response = await _complete_gemini(body)
        elif body.provider == "groq":
            response = await _complete_groq(body)
        elif body.provider == "openrouter":
            response = await _complete_openrouter(body)
        else:
            # Unreachable — _reject_unproxied above guards this.
            raise HTTPException(status_code=500, detail="provider dispatch fell through")
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
    _reject_unproxied(body.provider)

    if body.provider == "anthropic":
        gen = _stream_anthropic(body, user["id"])
    elif body.provider == "gemini":
        gen = _stream_gemini(body, user["id"])
    elif body.provider == "groq":
        gen = _stream_groq(body, user["id"])
    elif body.provider == "openrouter":
        gen = _stream_openrouter(body, user["id"])
    else:
        # Unreachable — _reject_unproxied above guards this.
        raise HTTPException(status_code=500, detail="provider dispatch fell through")

    return StreamingResponse(
        gen,
        media_type="text/event-stream",
        headers={
            # Disable proxy buffering so deltas arrive promptly.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
        },
    )


@router.post("/v1/llm/embed", response_model=EmbedResponse)
async def embed(request: Request, body: EmbedRequest) -> EmbedResponse:
    """
    Embed text via Gemini `text-embedding-004`. Used by the in-browser KB
    vector store; replaces direct `generativelanguage.googleapis.com` calls
    from the extension. Returns 768-dim vectors.

    Auth: requires Supabase JWT.
    Permission: `generate:create`.
    """
    user = request.state.user
    require_permission(user["role"], "generate:create")
    api_key = _gemini_key()
    started = time.perf_counter()
    error_msg: Optional[str] = None
    total_input_tokens = 0
    vectors: list[list[float]] = []

    try:
        # Use batchEmbedContents for >1, embedContent for 1 (smaller payload).
        if len(body.texts) == 1:
            url = _gemini_url(body.model, "embedContent")
            res = await _http().post(
                url,
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json={"content": {"parts": [{"text": body.texts[0]}]}},
            )
            if res.status_code >= 400:
                raise HTTPException(status_code=res.status_code, detail=f"Gemini embed {res.status_code}: {res.text[:300]}")
            data = res.json()
            v = (data.get("embedding") or {}).get("values") or []
            if not isinstance(v, list):
                raise HTTPException(status_code=502, detail="Gemini embed returned no vector")
            vectors.append(v)
        else:
            url = _gemini_url(body.model, "batchEmbedContents")
            res = await _http().post(
                url,
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json={
                    "requests": [
                        {
                            "model": f"models/{body.model}",
                            "content": {"parts": [{"text": t}]},
                        }
                        for t in body.texts
                    ],
                },
            )
            if res.status_code >= 400:
                raise HTTPException(status_code=res.status_code, detail=f"Gemini embed batch {res.status_code}: {res.text[:300]}")
            data = res.json()
            for emb in data.get("embeddings") or []:
                v = emb.get("values") or []
                if not isinstance(v, list):
                    raise HTTPException(status_code=502, detail="Gemini batch embed returned a malformed vector")
                vectors.append(v)

        dims = len(vectors[0]) if vectors else 0
        # Approximate input token usage as total characters / 4. Gemini doesn't
        # return precise tokens for embeddings; we just want a cost-attribution
        # estimate, not an exact figure.
        total_input_tokens = sum(len(t) for t in body.texts) // 4
        return EmbedResponse(vectors=vectors, model=body.model, dims=dims)
    except HTTPException as e:
        error_msg = f"http_{e.status_code}: {e.detail}"
        raise
    except Exception as e:  # noqa: BLE001
        error_msg = str(e)
        raise
    finally:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        asyncio.create_task(
            _log_usage(
                user_id=user["id"],
                provider="gemini-embed",
                model=body.model,
                input_tokens=total_input_tokens,
                output_tokens=0,
                duration_ms=elapsed_ms,
                streamed=False,
                error=error_msg,
            )
        )


@router.get("/v1/llm/health")
async def llm_health() -> dict:
    """Lightweight health check — confirms the module loaded and which keys are set."""
    return {
        "status": "ok",
        "providers_wired": sorted(_PROXIED_PROVIDERS),
        "providers_direct": ["custom", "ollama"],
        "anthropic_key_configured": bool(settings.anthropic_api_key),
        "gemini_key_configured": bool(settings.gemini_api_key),
        "groq_key_configured": bool(settings.groq_api_key),
        "openrouter_key_configured": bool(settings.openrouter_api_key),
        "embed_endpoint": "/api/v1/llm/embed",
    }
