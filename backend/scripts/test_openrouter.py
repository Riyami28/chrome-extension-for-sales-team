"""
Standalone smoke test for the OpenRouter proxy integration.

Tests the exact request shape that `backend/api/routes/llm.py` would build,
hitting the real OpenRouter API directly. Does NOT require Supabase, Pinecone,
or any other backend dependency.

Usage:
    export OPENROUTER_API_KEY=sk-or-v1-<your-rotated-key>
    python3 backend/scripts/test_openrouter.py

    # Optional overrides
    export OPENROUTER_MODEL="deepseek/deepseek-chat:free"
    export OPENROUTER_REFERER="https://clientlens.zopnight.com"
    export OPENROUTER_TITLE="ClientLens"

Exit codes:
    0  — both /complete and /stream paths returned valid responses
    1  — key missing or test failed
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Optional

import httpx


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free"

# ── Request shape (mirrors backend/api/routes/llm.py) ─────────────────────────


def make_headers(api_key: str, referer: str, title: str) -> dict:
    """Same headers the FastAPI proxy sends — incl. OpenRouter app attribution."""
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": title,
    }


def make_body(
    model: str,
    system: str,
    user: str,
    *,
    max_tokens: int = 256,
    temperature: float = 0.3,
    stream: bool = False,
) -> dict:
    """Same body the FastAPI proxy builds. JSON-only instruction in system role."""
    return {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": stream,
        "messages": [
            {
                "role": "system",
                "content": f"{system}\nRespond with a single JSON object. No prose, no markdown fences.".strip(),
            },
            {"role": "user", "content": user},
        ],
    }


# ── Tests ─────────────────────────────────────────────────────────────────────


def test_complete(client: httpx.Client, headers: dict, model: str) -> tuple[bool, Optional[str]]:
    print(f"\n── /complete · {model} ──")
    body = make_body(
        model=model,
        system="You write structured sales pitches.",
        user='Return a JSON object with one key "headline" set to a 6-word sales pitch for a cloud cost optimization tool.',
    )
    started = time.perf_counter()
    try:
        res = client.post(OPENROUTER_URL, headers=headers, json=body, timeout=60.0)
    except httpx.HTTPError as e:
        print(f"  HTTP error: {e}")
        return False, None

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    print(f"  status={res.status_code}  latency={elapsed_ms}ms")
    if res.status_code >= 400:
        print(f"  body: {res.text[:400]}")
        return False, None

    data = res.json()
    choices = data.get("choices") or []
    if not choices:
        print(f"  no choices in response: {json.dumps(data)[:200]}")
        return False, None
    text = choices[0].get("message", {}).get("content", "")
    usage = data.get("usage") or {}
    request_id = data.get("id")
    print(f"  request_id={request_id}")
    print(f"  usage      prompt={usage.get('prompt_tokens', 0)}  completion={usage.get('completion_tokens', 0)}")
    print(f"  text       {text[:240]!r}")
    return True, request_id


def test_stream(client: httpx.Client, headers: dict, model: str) -> bool:
    print(f"\n── /stream · {model} ──")
    body = make_body(
        model=model,
        system="You write structured sales pitches.",
        user='Return a JSON object with two keys: "headline" (8 words) and "bullets" (array of 2 short strings).',
        stream=True,
    )
    started = time.perf_counter()
    first_token_ms: Optional[int] = None
    delta_count = 0
    full_text = ""
    request_id: Optional[str] = None
    in_tok = 0
    out_tok = 0

    try:
        with client.stream("POST", OPENROUTER_URL, headers=headers, json=body, timeout=60.0) as res:
            print(f"  status={res.status_code}")
            if res.status_code >= 400:
                print(f"  body: {res.read()[:400].decode(errors='replace')}")
                return False

            for line in res.iter_lines():
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
                        delta_count += 1
                        full_text += delta
                        if first_token_ms is None:
                            first_token_ms = int((time.perf_counter() - started) * 1000)
                usage = chunk.get("usage")
                if usage:
                    in_tok = usage.get("prompt_tokens", in_tok)
                    out_tok = usage.get("completion_tokens", out_tok)
    except httpx.HTTPError as e:
        print(f"  HTTP error: {e}")
        return False

    total_ms = int((time.perf_counter() - started) * 1000)
    if delta_count == 0:
        print("  no delta chunks received — stream broke")
        return False

    print(f"  request_id={request_id}")
    print(f"  first_token={first_token_ms}ms  total={total_ms}ms  deltas={delta_count}")
    print(f"  usage       prompt={in_tok}  completion={out_tok}")
    print(f"  text        {full_text[:240]!r}")
    return True


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> int:
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        print(
            "OPENROUTER_API_KEY is not set in the environment.\n"
            "  export OPENROUTER_API_KEY=sk-or-v1-<your-rotated-key>\n"
            "Do NOT paste the key in chat. Set it locally only.",
            file=sys.stderr,
        )
        return 1
    model = os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL)
    referer = os.environ.get("OPENROUTER_REFERER", "https://clientlens.zopnight.com")
    title = os.environ.get("OPENROUTER_TITLE", "ClientLens")

    print("OpenRouter proxy smoke test")
    print(f"  model    {model}")
    print(f"  referer  {referer}")
    print(f"  title    {title}")
    print(f"  key      sk-or-v1-...{api_key[-6:]}  ({len(api_key)} chars)")

    headers = make_headers(api_key, referer, title)
    with httpx.Client() as client:
        ok_complete, _ = test_complete(client, headers, model)
        ok_stream = test_stream(client, headers, model)

    print("\n── Result ──")
    print(f"  /complete : {'PASS' if ok_complete else 'FAIL'}")
    print(f"  /stream   : {'PASS' if ok_stream else 'FAIL'}")
    return 0 if (ok_complete and ok_stream) else 1


if __name__ == "__main__":
    sys.exit(main())
