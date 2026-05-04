/**
 * Provider-agnostic LLM client. Picks Anthropic or Groq based on
 * VITE_LLM_PROVIDER. Both return plain text; council parses JSON out.
 */

import Anthropic from "@anthropic-ai/sdk";
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

  const apiKey = settings.anthropicKey || envKey("VITE_ANTHROPIC_API_KEY");
  if (!apiKey) return { error: "Add an Anthropic API key in Settings." };
  return { provider: "anthropic", apiKey, model: modelOverride ?? ANTHROPIC_MODEL };
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

class AnthropicClient implements LLMClient {
  private client: Anthropic;
  constructor(private cfg: LLMConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, dangerouslyAllowBrowser: true });
  }
  async call(system: string, user: string, maxTokens: number): Promise<string> {
    try {
      const res = await this.client.messages.create({
        model: this.cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      return res.content[0]?.type === "text" ? res.content[0].text : "";
    } catch (err) {
      const anyErr = err as { status?: number; message?: string };
      throw friendlyLLMError("Claude", anyErr.status ?? 0, anyErr.message ?? String(err));
    }
  }
  async callStream(
    system: string,
    user: string,
    maxTokens: number,
    onDelta: (delta: string, full: string) => void,
  ): Promise<string> {
    try {
      let full = "";
      const stream = this.client.messages.stream({
        model: this.cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      stream.on("text", (delta: string) => {
        full += delta;
        try { onDelta(delta, full); } catch { /* listener errors must not abort the stream */ }
      });
      await stream.finalMessage();
      return full;
    } catch (err) {
      const anyErr = err as { status?: number; message?: string };
      throw friendlyLLMError("Claude", anyErr.status ?? 0, anyErr.message ?? String(err));
    }
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
