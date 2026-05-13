/**
 * User-settable settings: LLM provider keys + integration credentials.
 *
 * Stored in localStorage (sync read path for `resolveLLMConfig`) and
 * mirrored to chrome.storage.local for cross-surface persistence.
 *
 * Integrations are fully manual — users paste their own credentials.
 * The extension never handles an OAuth flow; each card collects the
 * tokens/secrets the user obtained from the third-party console.
 */

import type { LLMProvider } from "../agents/llm-client";

const STORAGE_KEY = "clientlens_user_settings_v1";

export type IntegrationId = "zoho" | "googleMeet" | "zoom" | "customTool";

export interface IntegrationConfig {
  connected: boolean;
  pullEnabled: boolean;
  pushEnabled: boolean;
  fields: Record<string, string>;
}

export interface UserSettings {
  provider: LLMProvider;
  /**
   * @deprecated since #1 — Anthropic is routed through the FastAPI backend.
   * The extension never holds an Anthropic key. Field kept to avoid breaking
   * older hydrated payloads; ignored on read. Will be removed in a follow-up
   * after the migration window.
   */
  anthropicKey: string;
  /**
   * @deprecated since #1 — Gemini chat + embeddings are routed through the
   * FastAPI backend (`/api/v1/llm/{complete,stream,embed}`). The extension
   * never holds a Gemini key. Field kept to avoid breaking older hydrated
   * payloads; ignored on read.
   */
  geminiKey: string;
  /**
   * @deprecated since #1 — Groq is routed through the FastAPI backend.
   * The extension never holds a Groq key. Field kept to avoid breaking
   * older hydrated payloads; ignored on read.
   */
  groqKey: string;
  customLabel: string;
  customBaseUrl: string;
  customModel: string;
  customKey: string;
  integrations: Record<IntegrationId, IntegrationConfig>;
}

const EMPTY_INTEGRATION: IntegrationConfig = {
  connected: false,
  pullEnabled: false,
  pushEnabled: false,
  fields: {},
};

// Shipped Gemini key — historically backfilled so the Gemini provider had a
// working credential. As of #1, Gemini is proxied via the backend and no
// extension-side key is ever used. The constant is retained only for
// backwards-compat with imports; new installs leave `geminiKey` empty.
const GEMINI_PRESET_KEY = "";
void (import.meta.env.VITE_GEMINI_PRESET_KEY); // silence unused-env lint

// Active default: Custom provider pointed at Groq's OpenAI-compatible endpoint.
// Groq is faster than Gemini for the live coach loop and the user supplied a
// fresh key for this purpose.
const GROQ_CUSTOM_PRESET = {
  customLabel: "Groq",
  customBaseUrl: "https://api.groq.com/openai/v1",
  customModel: "llama-3.3-70b-versatile",
  customKey: import.meta.env.VITE_GROQ_PRESET_KEY ?? "",
} as const;

// Known-stale shipped credentials we proactively migrate away from when an
// older install loads the new build. Without these checks, hydrate's
// blank-only backfill would leave the dead value in place.
const DEAD_OPENROUTER_KEY = "";
const SUPERSEDED_GEMINI_KEYS: readonly string[] = [];
const SUPERSEDED_CUSTOM_KEYS = [DEAD_OPENROUTER_KEY] as const;

const DEFAULTS: UserSettings = {
  // Default to OpenRouter only in dev-mode builds so existing users on other
  // providers aren't silently switched when they update the extension.
  // In production builds (VITE_DEV_MODE unset/false) we keep "custom" as the
  // factory default — matches the pre-PR behaviour so no hydrate migration is
  // needed for existing installs.
  provider: (import.meta.env.VITE_DEV_MODE as string | undefined) === "true"
    ? "openrouter"
    : "custom",
  anthropicKey: "",
  geminiKey: GEMINI_PRESET_KEY,
  groqKey: "",
  customLabel: GROQ_CUSTOM_PRESET.customLabel,
  customBaseUrl: GROQ_CUSTOM_PRESET.customBaseUrl,
  customModel: GROQ_CUSTOM_PRESET.customModel,
  customKey: GROQ_CUSTOM_PRESET.customKey,
  integrations: {
    zoho: { ...EMPTY_INTEGRATION, fields: {} },
    googleMeet: { ...EMPTY_INTEGRATION, fields: {} },
    zoom: { ...EMPTY_INTEGRATION, fields: {} },
    customTool: { ...EMPTY_INTEGRATION, fields: {} },
  },
};

function hydrate(partial: Partial<UserSettings> | null | undefined): UserSettings {
  const base = { ...DEFAULTS, ...(partial || {}) };
  // Scrub deprecated provider keys from older hydrated payloads (#1).
  // Anthropic / Gemini / Groq are all proxied via the backend now; the
  // extension has no use for these keys. Clearing them prevents stale values
  // from lingering in chrome.storage.
  base.anthropicKey = "";
  base.geminiKey = "";
  base.groqKey = "";
  void SUPERSEDED_GEMINI_KEYS; // legacy migration list, kept for future use
  // Force-roll forward any install pinned to a known-dead Custom preset
  // (e.g. the OpenRouter key that ran out of credits). Replace the slot
  // entirely with the current Groq preset so reps don't keep hitting 402s.
  if (
    !base.customKey ||
    (SUPERSEDED_CUSTOM_KEYS as readonly string[]).includes(base.customKey)
  ) {
    base.customLabel = GROQ_CUSTOM_PRESET.customLabel;
    base.customBaseUrl = GROQ_CUSTOM_PRESET.customBaseUrl;
    base.customModel = GROQ_CUSTOM_PRESET.customModel;
    base.customKey = GROQ_CUSTOM_PRESET.customKey;
  }
  const integrations = { ...DEFAULTS.integrations, ...((partial?.integrations as UserSettings["integrations"]) || {}) };
  for (const id of Object.keys(DEFAULTS.integrations) as IntegrationId[]) {
    integrations[id] = {
      ...EMPTY_INTEGRATION,
      ...(integrations[id] || {}),
      fields: { ...(integrations[id]?.fields || {}) },
    };
  }
  return { ...base, integrations };
}

export function getSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return hydrate(null);
    return hydrate(JSON.parse(raw) as Partial<UserSettings>);
  } catch {
    return hydrate(null);
  }
}

export function saveSettings(next: UserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  try {
    chrome.storage?.local?.set({ [STORAGE_KEY]: next });
  } catch {
    /* ignore */
  }
}

// ─── Admin passcode (RBAC for Settings panel) ────────────────────────────────
// Client-side gate: the hash lives in localStorage and anyone with devtools
// can bypass it. Goal is "casual user can't change provider/keys on a shared
// laptop," not cryptographic access control.

const ADMIN_HASH_KEY = "clientlens_admin_hash_v1";
const ADMIN_UNLOCK_KEY = "clientlens_admin_unlocked_v1"; // sessionStorage flag

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hasAdminPasscode(): boolean {
  try {
    return !!localStorage.getItem(ADMIN_HASH_KEY);
  } catch {
    return false;
  }
}

export async function setAdminPasscode(passcode: string): Promise<void> {
  const hash = await sha256Hex(passcode);
  try { localStorage.setItem(ADMIN_HASH_KEY, hash); } catch { /* ignore */ }
  markAdminUnlocked();
}

export async function verifyAdminPasscode(passcode: string): Promise<boolean> {
  try {
    const stored = localStorage.getItem(ADMIN_HASH_KEY);
    if (!stored) return false;
    const hash = await sha256Hex(passcode);
    if (hash === stored) {
      markAdminUnlocked();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isAdminUnlocked(): boolean {
  try {
    return sessionStorage.getItem(ADMIN_UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAdminUnlocked(): void {
  try { sessionStorage.setItem(ADMIN_UNLOCK_KEY, "1"); } catch { /* ignore */ }
}

export function lockAdmin(): void {
  try { sessionStorage.removeItem(ADMIN_UNLOCK_KEY); } catch { /* ignore */ }
}

export function apiKeyFor(provider: LLMProvider): string {
  const s = getSettings();
  // Anthropic / Gemini / Groq are proxied via the backend (#1) — extension
  // never holds those keys. Only custom (user-supplied endpoint) returns one.
  if (provider === "custom") return s.customKey;
  return "";
}

// ─── Usage counter (per-provider, per-day) ────────────────────────────────────

const USAGE_KEY = "clientlens_usage_v1";

interface UsageRecord {
  date: string; // YYYY-MM-DD
  counts: Record<string, number>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getUsage(): UsageRecord {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return { date: today(), counts: {} };
    const parsed = JSON.parse(raw) as UsageRecord;
    if (parsed.date !== today()) return { date: today(), counts: {} };
    return parsed;
  } catch {
    return { date: today(), counts: {} };
  }
}

export function bumpUsage(provider: string): void {
  const u = getUsage();
  u.counts[provider] = (u.counts[provider] || 0) + 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}

// ─── Session history (last N meeting copilot sessions) ────────────────────────

const HISTORY_KEY = "clientlens_session_history_v1";
const HISTORY_LIMIT = 20;

export interface StoredSessionSummary {
  id: string;
  saved_at: string;
  company: string;
  persona: string;
  headline: string;
  summary_markdown: string;
}

// Transcripts and per-call summaries include prospect PII (names, pricing
// discussions, verbatim quotes). We cap retention to 24 hours so the
// extension never hoards call data indefinitely. Sales reps who need longer
// retention should push to their CRM via the Integrations flow — the
// extension is not the system of record.
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

function withinRetention(e: StoredSessionSummary): boolean {
  const t = Date.parse(e.saved_at);
  if (!isFinite(t)) return false;
  return Date.now() - t < SESSION_RETENTION_MS;
}

export function listSessionHistory(): StoredSessionSummary[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const all = raw ? (JSON.parse(raw) as StoredSessionSummary[]) : [];
    const fresh = all.filter(withinRetention);
    // Prune expired entries on every read so the PII retention policy is
    // enforced even if the user never opens Settings.
    if (fresh.length !== all.length) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(fresh)); } catch { /* ignore */ }
    }
    return fresh;
  } catch {
    return [];
  }
}

export function saveSessionToHistory(entry: StoredSessionSummary): void {
  try {
    const existing = listSessionHistory().filter((e) => e.id !== entry.id);
    const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function clearSessionHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

// Wipe every persisted artefact associated with meetings: session history,
// transponder layout, auto-start flag, calendar cache, transcript drafts.
// Leaves API keys + integration credentials intact. Admin-only surface.
export function clearAllSessionData(): { removed: string[] } {
  const keys = [
    "clientlens_session_history_v1",
    "clientlens_calendar_status_v1",
    "clientlens.transponder.pos",
    "clientlens.transponder.dock",
    "clientlens.transponder.layout",
    "clientlens.autostart",
  ];
  const removed: string[] = [];
  for (const k of keys) {
    try {
      if (localStorage.getItem(k) != null) {
        localStorage.removeItem(k);
        removed.push(k);
      }
    } catch { /* ignore */ }
    try { chrome.storage?.local?.remove(k); } catch { /* ignore */ }
  }
  return { removed };
}
