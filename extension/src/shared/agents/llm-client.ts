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

export type LLMProvider = "anthropic" | "groq" | "ollama" | "gemini" | "custom";

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

function envKey(name: string): string {
  const v = (import.meta.env as Record<string, string | undefined>)[name] ?? "";
  if (!v || v.includes("YOUR_KEY")) return "";
  return v;
}

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
    const apiKey = settings.geminiKey || envKey("VITE_GEMINI_API_KEY");
    if (!apiKey) return { error: "Add a Gemini API key in Settings." };
    return { provider, apiKey, model: modelOverride ?? import.meta.env.VITE_GEMINI_MODEL ?? GEMINI_MODEL };
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
    const apiKey = settings.groqKey || envKey("VITE_GROQ_API_KEY");
    if (!apiKey) return { error: "Add a Groq API key in Settings." };
    return { provider, apiKey, model: modelOverride ?? GROQ_MODEL };
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

function backendUrl(): string {
  const url = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/$/, "");
  if (!url) {
    throw new Error(
      "VITE_BACKEND_URL is not configured. The extension can't reach the backend LLM proxy. " +
        "Set it in extension/.env (e.g. VITE_BACKEND_URL=http://localhost:8000).",
    );
  }
  return url;
}

async function backendJwt(): Promise<string> {
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

class AnthropicClient implements LLMClient {
  constructor(private cfg: LLMConfig) {}

  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const url = `${backendUrl()}/api/v1/llm/complete`;
    const jwt = await backendJwt();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        provider: "anthropic",
        model: this.cfg.model,
        system,
        user,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError("Claude (proxy)", res.status, body);
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        provider: "anthropic",
        model: this.cfg.model,
        system,
        user,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError("Claude (proxy)", res.status, body);
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
          throw friendlyLLMError("Claude (proxy)", 0, error ?? "Unknown SSE error");
        } catch (err) {
          if (err instanceof Error) throw err;
          throw new Error("Claude (proxy) stream errored");
        }
      }
      // `done` is informational — nothing to do client-side.
    }
    return full;
  }
}

class GroqClient implements LLMClient {
  constructor(private cfg: LLMConfig) {}
  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
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
      throw friendlyLLMError("Groq", res.status, body);
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }
}

class OllamaClient implements LLMClient {
  constructor(private cfg: LLMConfig) {}
  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const base = this.cfg.baseUrl ?? OLLAMA_BASE;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
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

class GeminiClient implements LLMClient {
  constructor(private cfg: LLMConfig) {}
  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.model}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.cfg.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${system}\nRespond with a single JSON object. No prose, no markdown fences.` }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.3,
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError("Gemini", res.status, body);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
}

class CustomOpenAICompatClient implements LLMClient {
  constructor(private cfg: LLMConfig) {}
  async call(system: string, user: string, maxTokens: number): Promise<string> {
    const base = (this.cfg.baseUrl ?? "").replace(/\/$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
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

// ─── Gemini embeddings ────────────────────────────────────────────────────────
//
// Embeddings use Gemini regardless of the active chat provider. The Gemini
// free tier covers our scale (a few thousand embed calls/day) and the user
// already has a Gemini key wired up. Keeping a separate code path here means
// switching the chat provider doesn't break vector retrieval.

export const EMBEDDING_DIMS = 768;

function geminiEmbedKey(): string {
  const settings = getSettings();
  return settings.geminiKey || envKey("VITE_GEMINI_API_KEY") || "";
}

/**
 * Embed a single string with Gemini text-embedding-004. Returns 768 floats.
 * Throws a friendlyLLMError-style message on credential / quota failures.
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = geminiEmbedKey();
  if (!apiKey) throw new Error("Add a Gemini API key in Settings to enable semantic KB search.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw friendlyLLMError("Gemini embed", res.status, body);
  }
  const data = (await res.json()) as { embedding?: { values?: number[] } };
  const vec = data.embedding?.values;
  if (!vec || !Array.isArray(vec)) throw new Error("Gemini embed returned no vector");
  return vec;
}

/**
 * Embed many strings. Gemini's batchEmbedContents accepts up to 100 requests
 * per call. We batch internally so callers can pass an arbitrary list.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = geminiEmbedKey();
  if (!apiKey) throw new Error("Add a Gemini API key in Settings to enable semantic KB search.");
  const out: number[][] = [];
  const BATCH = 100;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        requests: slice.map((t) => ({
          model: `models/${GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text: t }] },
        })),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw friendlyLLMError("Gemini embed", res.status, body);
    }
    const data = (await res.json()) as { embeddings?: { values?: number[] }[] };
    const vecs = data.embeddings ?? [];
    for (const v of vecs) {
      if (!v.values || !Array.isArray(v.values)) throw new Error("Gemini embed returned a malformed vector");
      out.push(v.values);
    }
  }
  return out;
}

export function makeLLMClient(cfg: LLMConfig): LLMClient {
  const inner: LLMClient =
    cfg.provider === "gemini"
      ? new GeminiClient(cfg)
      : cfg.provider === "ollama"
      ? new OllamaClient(cfg)
      : cfg.provider === "groq"
      ? new GroqClient(cfg)
      : cfg.provider === "custom"
      ? new CustomOpenAICompatClient(cfg)
      : new AnthropicClient(cfg);
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
