"""
Knowledge-base smoke test for the OpenRouter proxy integration.

Loads two ZopNight KB markdown files (FEATURES + RECOMMENDATION-RULES), chunks
them the same way the extension's `chunker.ts` does, performs naive keyword
retrieval per query, and calls OpenRouter with the top-K chunks stuffed into
the system prompt. Validates that responses reference KB content.

This simulates what `council.ts` does end-to-end, but without needing Supabase,
Pinecone, Google SSO, or the Chrome extension itself. Pure OpenRouter +
retrieval validation.

Usage:
    export OPENROUTER_API_KEY=sk-or-v1-<your-rotated-key>
    python3 backend/scripts/test_openrouter_kb.py

    # Optional
    export OPENROUTER_MODEL="deepseek/deepseek-chat:free"
    export KB_FEATURES_PATH="/Users/zopdev/Downloads/FEATURES (1).md"
    export KB_RULES_PATH="/Users/zopdev/Downloads/RECOMMENDATION-RULES (1).md"

Exit codes:
    0  — all queries returned valid responses referencing KB content
    1  — key missing, KB file missing, or any query failed
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Optional

import httpx


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free"
DEFAULT_FEATURES = os.path.expanduser("~/Downloads/FEATURES (1).md")
DEFAULT_RULES = os.path.expanduser("~/Downloads/RECOMMENDATION-RULES (1).md")


# ── Chunking (mirrors extension/src/shared/utils/chunker.ts) ──────────────────
#
# Same strategy: split on paragraph → sentence → word, max ~400 tokens per
# chunk with ~12% tail overlap. Token estimate: words * 1.3.

MAX_TOKENS_PER_CHUNK = 400
OVERLAP_RATIO = 0.12


@dataclass
class Chunk:
    source: str
    text: str
    start_offset: int


def _estimate_tokens(text: str) -> int:
    return max(1, int(len(text.split()) * 1.3))


def chunk_markdown(source: str, text: str) -> list[Chunk]:
    """Paragraph-first split with sentence fallback for long paras."""
    chunks: list[Chunk] = []
    paragraphs = re.split(r"\n\s*\n", text)
    buf = ""
    buf_offset = 0
    cursor = 0

    def flush() -> None:
        nonlocal buf, buf_offset
        if buf.strip():
            chunks.append(Chunk(source=source, text=buf.strip(), start_offset=buf_offset))
        buf = ""

    for para in paragraphs:
        para_start = text.index(para, cursor) if para else cursor
        cursor = para_start + len(para)
        if not para.strip():
            continue

        para_tokens = _estimate_tokens(para)
        buf_tokens = _estimate_tokens(buf) if buf else 0

        if para_tokens > MAX_TOKENS_PER_CHUNK:
            # Sentence split for oversized paragraphs.
            if buf:
                flush()
                buf_offset = para_start
            sentences = re.split(r"(?<=[.!?])\s+", para)
            for sent in sentences:
                if not sent.strip():
                    continue
                if _estimate_tokens(buf + " " + sent) > MAX_TOKENS_PER_CHUNK and buf:
                    flush()
                    buf_offset = para_start
                buf = (buf + " " + sent).strip() if buf else sent
            continue

        if buf_tokens + para_tokens > MAX_TOKENS_PER_CHUNK and buf:
            flush()
            buf_offset = para_start
        if not buf:
            buf_offset = para_start
        buf = (buf + "\n\n" + para) if buf else para

    flush()

    # Add tail overlap between adjacent chunks for context continuity.
    if len(chunks) > 1 and OVERLAP_RATIO > 0:
        overlapped: list[Chunk] = [chunks[0]]
        for prev, cur in zip(chunks, chunks[1:]):
            tail_chars = int(len(prev.text) * OVERLAP_RATIO)
            if tail_chars > 0:
                tail = prev.text[-tail_chars:]
                overlapped.append(
                    Chunk(source=cur.source, text=f"{tail}\n\n{cur.text}", start_offset=cur.start_offset)
                )
            else:
                overlapped.append(cur)
        chunks = overlapped

    return chunks


# ── Naive keyword retrieval (lexical only; no embeddings) ─────────────────────


_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "in", "on", "at", "to", "of", "for", "with",
    "by", "from", "as", "is", "are", "was", "were", "be", "been", "being", "this", "that",
    "these", "those", "i", "you", "he", "she", "it", "we", "they", "what", "how", "do",
    "does", "did", "can", "could", "would", "should", "will", "shall", "may", "might",
    "must", "have", "has", "had", "our", "your", "their", "my",
}


def _tokenize(text: str) -> list[str]:
    return [t.lower() for t in re.findall(r"[A-Za-z0-9_-]+", text) if t.lower() not in _STOPWORDS and len(t) > 1]


def retrieve(query: str, chunks: list[Chunk], k: int = 5) -> list[tuple[Chunk, int]]:
    """Score each chunk by (a) query-word hit count + (b) unique-term overlap."""
    q_terms = set(_tokenize(query))
    if not q_terms:
        return []
    scored: list[tuple[Chunk, int]] = []
    for c in chunks:
        c_tokens = _tokenize(c.text)
        hits = sum(1 for t in c_tokens if t in q_terms)
        unique_hits = len(q_terms & set(c_tokens))
        score = hits + unique_hits * 5  # weight unique-term match higher
        if score > 0:
            scored.append((c, score))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:k]


# ── Prompt construction (council-style) ───────────────────────────────────────


SYSTEM_PROMPT = """You are a senior sales engineer at ZopNight, a cloud cost optimization platform.
You answer prospect questions using ONLY the knowledge base excerpts provided in the user message.
Never invent feature names, rule IDs, or numbers. If the KB does not cover the question, say so.

Output a single JSON object with this exact shape (no prose, no markdown fences):
{
  "answer": "<2-4 sentence response grounded in the KB>",
  "kb_references": ["<short KB phrase 1>", "<short KB phrase 2>"],
  "confidence": "high" | "medium" | "low"
}"""


def build_user_prompt(query: str, retrieved: list[tuple[Chunk, int]]) -> str:
    kb_section = "\n\n---\n\n".join(
        f"[{c.source} · score={score}]\n{c.text}" for c, score in retrieved
    )
    return f"""KB EXCERPTS:
{kb_section}

PROSPECT QUESTION:
{query}

Answer using ONLY the KB excerpts above."""


# ── OpenRouter call (same shape as backend/api/routes/llm.py) ─────────────────


def call_openrouter(
    client: httpx.Client,
    api_key: str,
    model: str,
    system: str,
    user: str,
    referer: str,
    title: str,
) -> tuple[Optional[str], dict]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": title,
    }
    body = {
        "model": model,
        "max_tokens": 512,
        "temperature": 0.3,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    res = client.post(OPENROUTER_URL, headers=headers, json=body, timeout=60.0)
    if res.status_code >= 400:
        return None, {"status": res.status_code, "body": res.text[:300]}
    data = res.json()
    text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    usage = data.get("usage") or {}
    return text, {
        "request_id": data.get("id"),
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "model": data.get("model"),
    }


def parse_json_envelope(text: str) -> Optional[dict]:
    """Mirror extractJson<T>() — try fenced block first, then balanced-brace scan."""
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL)
    candidate = fence.group(1) if fence else None
    if not candidate:
        first = text.find("{")
        last = text.rfind("}")
        if first != -1 and last != -1 and last > first:
            candidate = text[first : last + 1]
    if not candidate:
        return None
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


# ── Test queries ──────────────────────────────────────────────────────────────


QUERIES = [
    {
        "question": "We have 200 idle EC2 instances. What does ZopNight do about them?",
        "expect_terms": ["idle", "schedule", "ec2"],
    },
    {
        "question": "Does ZopNight track actual billing cost or just on-demand pricing? How does it handle reservations?",
        "expect_terms": ["billing", "reservation", "amortized"],
    },
    {
        "question": "Give me 2 specific recommendation rule categories for RDS or database cost savings.",
        "expect_terms": ["rds", "database"],
    },
    {
        "question": "How does ZopNight discover Kubernetes workloads across EKS, GKE, and AKS?",
        "expect_terms": ["k8s", "eks", "gke", "aks", "deployment"],
    },
]


# ── Entry ─────────────────────────────────────────────────────────────────────


def main() -> int:
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        print(
            "OPENROUTER_API_KEY is not set. export it locally and re-run.\n"
            "  export OPENROUTER_API_KEY=sk-or-v1-<your-rotated-key>",
            file=sys.stderr,
        )
        return 1
    model = os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL)
    referer = os.environ.get("OPENROUTER_REFERER", "https://clientlens.zopnight.com")
    title = os.environ.get("OPENROUTER_TITLE", "ClientLens")
    features_path = os.environ.get("KB_FEATURES_PATH", DEFAULT_FEATURES)
    rules_path = os.environ.get("KB_RULES_PATH", DEFAULT_RULES)

    for path in (features_path, rules_path):
        if not os.path.exists(path):
            print(f"KB file not found: {path}", file=sys.stderr)
            return 1

    print("ZopNight KB · OpenRouter smoke test")
    print(f"  model    {model}")
    print(f"  key      sk-or-v1-...  ({len(api_key)} chars)")

    # ── Load + chunk ─────────────────────────────────────────────────────────
    print("\n── Loading KB ──")
    chunks: list[Chunk] = []
    for path, label in ((features_path, "FEATURES"), (rules_path, "RULES")):
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        file_chunks = chunk_markdown(label, text)
        chunks.extend(file_chunks)
        print(f"  {label:<10} {len(text):>7} bytes → {len(file_chunks)} chunks")
    print(f"  TOTAL      {len(chunks)} chunks")

    # ── Run queries ──────────────────────────────────────────────────────────
    passed = 0
    with httpx.Client() as client:
        for i, q in enumerate(QUERIES, 1):
            print(f"\n── Q{i}: {q['question']!r}")
            retrieved = retrieve(q["question"], chunks, k=4)
            if not retrieved:
                print("  retrieval returned 0 chunks — query may be off-topic")
                continue
            print(f"  retrieved {len(retrieved)} chunks (top score={retrieved[0][1]})")
            for j, (c, s) in enumerate(retrieved):
                preview = c.text.replace("\n", " ")[:80]
                print(f"    [{j}] {c.source} score={s} · {preview}…")

            started = time.perf_counter()
            text, meta = call_openrouter(
                client, api_key, model, SYSTEM_PROMPT, build_user_prompt(q["question"], retrieved), referer, title
            )
            elapsed_ms = int((time.perf_counter() - started) * 1000)

            if text is None:
                print(f"  FAIL  upstream error: {meta}")
                continue

            envelope = parse_json_envelope(text)
            if not envelope or not isinstance(envelope, dict) or "answer" not in envelope:
                print(f"  FAIL  could not parse JSON envelope from response")
                print(f"  raw   {text[:200]!r}")
                continue

            answer = str(envelope.get("answer", ""))
            answer_lower = answer.lower()
            term_hits = sum(1 for t in q["expect_terms"] if t.lower() in answer_lower)

            print(f"  latency        {elapsed_ms}ms")
            print(f"  tokens         prompt={meta['prompt_tokens']}  completion={meta['completion_tokens']}")
            print(f"  confidence     {envelope.get('confidence')}")
            print(f"  kb_references  {envelope.get('kb_references')}")
            print(f"  answer         {answer[:240]}")
            print(f"  term coverage  {term_hits}/{len(q['expect_terms'])} expected terms")

            if term_hits >= 1:
                passed += 1
                print("  PASS")
            else:
                print("  FAIL  answer did not reference expected KB terms")

    print(f"\n── Result ── {passed}/{len(QUERIES)} queries passed")
    return 0 if passed == len(QUERIES) else 1


if __name__ == "__main__":
    sys.exit(main())
