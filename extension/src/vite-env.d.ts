/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_MODE?: string;
  readonly VITE_ANTHROPIC_API_KEY?: string;
  readonly VITE_GROQ_API_KEY?: string;
  readonly VITE_LLM_PROVIDER?: "anthropic" | "groq" | "ollama" | "gemini";
  readonly VITE_OLLAMA_MODEL?: string;
  readonly VITE_OLLAMA_BASE_URL?: string;
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_GEMINI_MODEL?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;

  // ─── V2 Meeting Copilot ────────────────────────────────────────────────────
  readonly VITE_MEETING_COPILOT?: string;       // "true" enables the live copilot feature
  readonly VITE_STT_PROVIDER?: "deepgram" | "assemblyai" | "mock";
  readonly VITE_DEEPGRAM_API_KEY?: string;
  readonly VITE_ASSEMBLYAI_API_KEY?: string;
  readonly VITE_ZOHO_CLIENT_ID?: string;
  readonly VITE_ZOHO_CLIENT_SECRET?: string;
  readonly VITE_ZOHO_REDIRECT_URI?: string;
  readonly VITE_ZOHO_DC?: string;               // "com" | "in" | "eu" — Zoho data center
  readonly VITE_GOOGLE_CALENDAR_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
