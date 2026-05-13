/**
 * Provider-agnostic LLM client. Picks Anthropic or Groq based on
 * VITE_LLM_PROVIDER. Both return plain text; council parses JSON out.
 *
 * Anthropic is routed through the FastAPI backend (`/api/v1/llm/{complete,stream}`)
 * because the SDK requires `dangerouslyAllowBrowser` and the API key must
 * never live in `chrome.storage`. See issue #1 and `backend/api/routes/llm.py`.
 *
 * Other providers (Gemini / Groq / Ollama / Custom) still call directly. They
 * are tracked in the same issue for follow-up migration.
 */

import { bumpUsage, getSettings } from "../utils/settings-storage";

export type LLMProvider = "anthropic" | "groq" | "ollama" | "gemini" | "openrouter" | "custom";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const ANTHROPIC_MODEL = "claude-opus-4-7";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const OLLAMA_MODEL = "llama3.1:8b";
const OLLAMA_BASE = "http://localhost:11434";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_EMBED_MODEL = "text-embedding-004"; // 768 dims, free tier
// OpenRouter model IDs are namespaced (`vendor/model[:tag]`). Default to a
// free-tier Llama; users override via Settings or the ModelPicker.
const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

// Timeout constants. AbortSignal.timeout() is Chrome 103+ (2022) — safe for
// an extension that only runs in modern Chrome.
const LLM_TIMEOUT_MS = 30_000;    // non-streaming: 30 s should be ample
const STREAM_TIMEOUT_MS = 120_000; // streaming: allow up to 2 min for large models

/**
 * Translate a raw upstream error body into a concise user-facing message.
 * Credential / quota / rate-limit failures get a hint pointing to Settings;
 * everything else falls through as a trimmed raw message.
 */
function friendlyLLMError(provider: string, status: number, body: string): Error {
  const text = body.toLowerCase();
  const isAuth =
    status === 401 ||
    status === 403 ||
    text.includes("api_key_invalid") ||
    text.includes("api key not valid") ||
    text.includes("invalid api key") ||
    text.includes("incorrect api key") ||
    text.includes("authentication") ||
    text.includes("unauthorized");
  const isQuota =
    status === 429 || text.includes("quota") || text.includes("rate limit") || text.includes("insufficient_quota");

  if (isAuth) {
    return new Error(`${provider} API key is invalid. Open Settings → Advanced · Model provider and paste a working key.`);
  }
  if (isQuota) {
    return new Error(`${provider} rate limit or quota hit. Wait a moment or switch provider in Settings.`);
  }
  return new Error(`${provider} ${status}: ${body.slice(0, 200)}`);
}

export function resolveLLMConfig(override?: { provider: LLMProvider; model: string }): LLMConfig | { error: string } {
  const settings = getSettings();
  const provider = (override?.provider ?? settings.provider ?? import.meta.env.VITE_LLM_PROVIDER ?? "custom") as LLMProvider;
  const modelOverride = override?.model;

  if (provider === "gemini") {
    // Proxied via backend (#1) — no extension-side key needed.
    return { provider, apiKey: "", model: modelOverride ?? import.meta.env.VITE_GEMINI_MODEL ?? GEMINI_MODEL };
  }

  if (provider === "ollama") {
    return {
      provider,
      apiKey: "",
      model: modelOverride ?? import.meta.env.VITE_OLLAMA_MODEL ?? OLLAMA_MODEL,
      baseUrl: import.meta.env.VITE_OLLAMA_BASE_URL ?? OLLAMA_BASE,
    };
  }

  if (provider === "groq") {
    // Proxied via backend (#1) — no extension-side key needed.
    return { provider, apiKey: "", model: modelOverride ?? GROQ_MODEL };
  }

  if (provider === "openrouter") {
    // Proxied via backend — no extension-side key. Backend env owns OPENROUTER_API_KEY.
    return { provider, apiKey: "", model: modelOverride ?? import.meta.env.VITE_OPENROUTER_MODEL ?? OPENROUTER_MODEL };
  }

  if (provider === "custom") {
    const apiKey = settings.customKey;
    const baseUrl = settings.customBaseUrl;
    const model = modelOverride ?? settings.customModel;
    if (!baseUrl) return { error: "Add a custom endpoint URL in Settings." };
    if (!model) return { error: "Add a custom model name in Settings." };
    return { provider, apiKey, model, baseUrl };
  }

  // Anthropic routes through the backend proxy — no extension-side API key needed.
  // The (now-deprecated) `anthropicKey` setting is ignored; backend env owns the key.
  // We keep the provider entry for council selection but apiKey is intentionally empty.
  return { provider: "anthropic", apiKey: "", model: modelOverride ?? ANTHROPIC_MODEL };
}

export interface LLMClient {
  call(system: string, user: string, maxTokens: number): Promise<string>;
  // Streaming variant — `onDelta` is invoked with each text chunk as it arrives.
  // Resolves with the full concatenated text. Providers without native
  // streaming fall back to a single onDelta with the full string at the end.
  callStream?(
    system: string,
    user: string,
    maxTokens: number,
    onDelta: (delta: string, full: string) => void,
  ): Promise<string>;
}

// ── Backend proxy helpers ────────────────────────────────────────────────────
//
// The extension never holds an Anthropic API key. All Anthropic traffic flows
// through the FastAPI backend at `${BACKEND_URL}/api/v1/llm/{complete,stream}`,
// authenticated with the user's Supabase JWT. See `backend/api/routes/llm.py`.

export function backendUrl(): string {
  const url = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/$/, "");
  if (!url) {
    throw new Error(
      "VITE_BACKEND_URL is not configured. The extension can't reach the backend LLM proxy. " +
        "Set it in extension/.env (e.g. VITE_BACKEND_URL=http://localhost:8000).",
    );
  }
  return url;
}

export async function backendJwt(): Promise<string> {
  // Local dev bypass: extension's chrome.identity sign-in doesn't produce a
  // Supabase JWT (auth-wiring gap in the original code), so when
  // VITE_DEV_MODE=true we send a stub bearer and the backend's AuthMiddleware
  // (with DEV_MODE=true) accepts it.
  if ((import.meta.env.VITE_DEV_MODE as string | undefined) === "true") {
    return "dev-mode-bypass";
  }
  // Lazy-import Supabase so unrelated provider code paths (Gemini / Groq /
  // smoke tests) don't require a real Supabase URL at module load.
  const { supabase } = await import("../utils/supabase");
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error("Sign in with Google to use Claude. The session is missing a Supabase JWT.");
  }
  return token;
}

/**
 * Parse a fetch Response body as Server-Sent Events. Yields one frame per
 * `\n\n`-separated chunk. Each frame is `{ event, data }`.
 *
 * Manual parser because EventSource doesn't support POST + custom headers,
 * which we need for the JWT and the request body.
 */
async function* readSSE(
  res: Response,
): AsyncGenerator<{ event: string; data: string }, void, void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
        sep = buf.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Provider-agnostic proxy client. Anthropic / Gemini / Groq all flow through
 * the same backend endpoints (`/api/v1/llm/complete`, `/api/v1/llm/stream`)
 * with a `provider` field selecting the upstream. Custom + Ollama stay
 * direct-only — see `makeLLMClient` for dispatch.
 */
class ProxiedLLMClient implements LLMClient {
  constructor(private provider: "anthropic" | "gemini" | "groq" | "openrouter", private model: string, private label: string) {}

  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const url = `${backendUrl()}/api/v1/llm/complete`;
    const jwt = await backendJwt();
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        provider: this.provider,
        model: this.model,
        system,
        user,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError(`${this.label} (proxy)`, res.status, body);
    }
    const data = (await res.json()) as { text?: string };
    return data.text ?? "";
  }

  async callStream(
    system: string,
    user: string,
    maxTokens: number,
    onDelta: (delta: string, full: string) => void,
  ): Promise<string> {
    const url = `${backendUrl()}/api/v1/llm/stream`;
    const jwt = await backendJwt();
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        provider: this.provider,
        model: this.model,
        system,
        user,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError(`${this.label} (proxy)`, res.status, body);
    }

    let full = "";
    for await (const frame of readSSE(res)) {
      if (frame.event === "delta") {
        try {
          const { text } = JSON.parse(frame.data) as { text?: string };
          if (text) {
            full += text;
            try { onDelta(text, full); } catch { /* listener errors must not abort the stream */ }
          }
        } catch { /* malformed delta — skip */ }
      } else if (frame.event === "error") {
        try {
          const { error } = JSON.parse(frame.data) as { error?: string };
          throw friendlyLLMError(`${this.label} (proxy)`, 0, error ?? "Unknown SSE error");
        } catch (err) {
          if (err instanceof Error) throw err;
          throw new Error(`${this.label} (proxy) stream errored`);
        }
      }
      // `done` is informational — nothing to do client-side.
    }
    return full;
  }
}

// Groq is proxied via the backend (#1). See ProxiedLLMClient.

class OllamaClient implements LLMClient {
  constructor(private cfg: LLMConfig) {}
  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const base = this.cfg.baseUrl ?? OLLAMA_BASE;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: maxTokens,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\nRespond with a single JSON object. No prose, no markdown fences.` },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError("Ollama", res.status, body);
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }
}

// Gemini is proxied via the backend (#1). See ProxiedLLMClient.

class CustomOpenAICompatClient implements LLMClient {
  constructor(private cfg: LLMConfig) {}
  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const base = (this.cfg.baseUrl ?? "").replace(/\/$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      headers,
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: maxTokens,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\nRespond with a single JSON object. No prose, no markdown fences.` },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError("Custom provider", res.status, body);
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }
}

// ─── Gemini embeddings (proxied) ─────────────────────────────────────────────
//
// Embeddings use Gemini text-embedding-004. As of #1 they route through the
// backend's `/api/v1/llm/embed` endpoint, so the extension never holds a
// Gemini API key. The backend batches up to 100 texts per upstream call;
// we keep that batching here so callers can pass arbitrarily long lists.

export const EMBEDDING_DIMS = 768;

interface ProxyEmbedResponse {
  vectors: number[][];
  model: string;
  dims: number;
}

async function postEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const url = `${backendUrl()}/api/v1/llm/embed`;
  const jwt = await backendJwt();
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ texts, model: GEMINI_EMBED_MODEL }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw friendlyLLMError("Gemini embed (proxy)", res.status, body);
  }
  const data = (await res.json()) as ProxyEmbedResponse;
  if (!data.vectors || !Array.isArray(data.vectors)) {
    throw new Error("Gemini embed proxy returned no vectors");
  }
  return data.vectors;
}

/**
 * Embed a single string. Returns 768 floats.
 * Throws a friendlyLLMError-style message on credential / quota failures.
 */
export async function embedText(text: string): Promise<number[]> {
  const vecs = await postEmbed([text]);
  const vec = vecs[0];
  if (!vec || !Array.isArray(vec)) throw new Error("Gemini embed returned no vector");
  return vec;
}

/**
 * Embed many strings. Backend caps at 100 per call; we batch on the client
 * side so callers don't need to know the limit.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  const BATCH = 100;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const vecs = await postEmbed(slice);
    for (const v of vecs) {
      if (!v || !Array.isArray(v)) throw new Error("Gemini embed returned a malformed vector");
      out.push(v);
    }
  }
  return out;
}

export function makeLLMClient(cfg: LLMConfig): LLMClient {
  // Anthropic / Gemini / Groq route through the backend proxy (#1).
  // Custom / Ollama stay direct — see notes on each.
  const inner: LLMClient =
    cfg.provider === "anthropic"
      ? new ProxiedLLMClient("anthropic", cfg.model, "Claude")
      : cfg.provider === "gemini"
      ? new ProxiedLLMClient("gemini", cfg.model, "Gemini")
      : cfg.provider === "groq"
      ? new ProxiedLLMClient("groq", cfg.model, "Groq")
      : cfg.provider === "openrouter"
      ? new ProxiedLLMClient("openrouter", cfg.model, "OpenRouter")
      : cfg.provider === "ollama"
      ? new OllamaClient(cfg)
      : new CustomOpenAICompatClient(cfg);
  return {
    async call(system, user, maxTokens) {
      const out = await inner.call(system, user, maxTokens);
      bumpUsage(cfg.provider);
      return out;
    },
    async callStream(system, user, maxTokens, onDelta) {
      let full: string;
      if (inner.callStream) {
        full = await inner.callStream(system, user, maxTokens, onDelta);
      } else {
        // Provider doesn't stream natively — fire one delta with the full text.
        full = await inner.call(system, user, maxTokens);
        try { onDelta(full, full); } catch { /* noop */ }
      }
      bumpUsage(cfg.provider);
      return full;
    },
  };
}
