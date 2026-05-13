import React, { useEffect, useMemo, useState } from "react";
import {
  X,
  Eye,
  EyeOff,
  Check,
  ExternalLink,
  Plug,
  Video,
  Database,
  Wrench,
  Upload,
  Download,
  ChevronDown,
  Zap,
  Loader2,
  AlertTriangle,
  Trash2,
  Lock,
} from "lucide-react";
import {
  getSettings,
  saveSettings,
  clearAllSessionData,
  lockAdmin,
  type UserSettings,
  type IntegrationId,
  type IntegrationConfig,
} from "../../shared/utils/settings-storage";
import {
  testZoho,
  testGoogleMeet,
  testZoom,
  testCustomTool,
  type TestResult,
} from "../../shared/utils/integrations";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  help?: string;
}

interface IntegrationDef {
  id: IntegrationId;
  name: string;
  tagline: string;
  icon: React.ReactNode;
  accent: string;
  docsUrl?: string;
  docsLabel?: string;
  pullLabel: string;
  pushLabel: string;
  fields: FieldDef[];
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "zoho",
    name: "Zoho CRM",
    tagline: "Sync accounts, contacts and deal notes.",
    icon: <Database size={14} />,
    accent: "zop-orange",
    docsUrl: "https://api-console.zoho.com",
    docsLabel: "Zoho API console",
    pullLabel: "Pull accounts, contacts, open deals",
    pushLabel: "Push meeting notes and next steps back to the deal",
    fields: [
      { key: "apiDomain", label: "API domain", placeholder: "https://www.zohoapis.com" },
      { key: "clientId", label: "Client ID", placeholder: "1000.XXXXXXXXXXXXXXXX" },
      { key: "clientSecret", label: "Client secret", placeholder: "•••••", secret: true },
      { key: "refreshToken", label: "Refresh token", placeholder: "1000.xxxxxx.xxxxxx", secret: true },
    ],
  },
  {
    id: "googleMeet",
    name: "Google Meet",
    tagline: "Attach the on-screen transponder to live calls.",
    icon: <Video size={14} />,
    accent: "zop-blue",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    docsLabel: "Google Cloud credentials",
    pullLabel: "Pull upcoming meeting titles and invite metadata",
    pushLabel: "Push meeting summaries back as calendar notes",
    fields: [
      { key: "clientId", label: "OAuth client ID", placeholder: "xxxxxxxx.apps.googleusercontent.com" },
      { key: "clientSecret", label: "Client secret", placeholder: "•••••", secret: true },
      { key: "refreshToken", label: "Refresh token", placeholder: "1//0g-…", secret: true },
    ],
  },
  {
    id: "zoom",
    name: "Zoom",
    tagline: "Use Zoom meeting transcripts as the live stream.",
    icon: <Video size={14} />,
    accent: "zop-green",
    docsUrl: "https://marketplace.zoom.us",
    docsLabel: "Zoom Marketplace",
    pullLabel: "Pull scheduled meetings and recorded transcripts",
    pushLabel: "Push post-call summaries to the meeting record",
    fields: [
      { key: "accountId", label: "Account ID", placeholder: "abcDEF123" },
      { key: "clientId", label: "Client ID", placeholder: "xxxxxxxxxxxxxxxxxxxx" },
      { key: "clientSecret", label: "Client secret", placeholder: "•••••", secret: true },
    ],
  },
  {
    id: "customTool",
    name: "Custom tool",
    tagline: "Any CRM, data warehouse, or internal service.",
    icon: <Wrench size={14} />,
    accent: "zop-cream",
    pullLabel: "Pull data from your system before each call",
    pushLabel: "Push call outcomes to your system after each call",
    fields: [
      { key: "label", label: "Display name", placeholder: "e.g. Salesforce, HubSpot, Internal CRM" },
      { key: "pullUrl", label: "Pull endpoint", placeholder: "https://api.yourco.com/accounts" },
      { key: "pushUrl", label: "Push endpoint", placeholder: "https://api.yourco.com/notes" },
      { key: "apiKey", label: "API key / token", placeholder: "•••••", secret: true },
    ],
  },
];

export function SettingsPanel({ open, onClose }: Props) {
  const [settings, setSettings] = useState<UserSettings>(() => getSettings());
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState<IntegrationId | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [showModels, setShowModels] = useState(false);
  const [wipeState, setWipeState] = useState<"idle" | "confirm" | "done">("idle");
  const [wipeNote, setWipeNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSettings(getSettings());
      setSaved(false);
      setExpanded(null);
      setShowModels(false);
      setWipeState("idle");
      setWipeNote(null);
    }
  }, [open]);

  function onWipe() {
    const { removed } = clearAllSessionData();
    setWipeState("done");
    setWipeNote(
      removed.length
        ? `Cleared ${removed.length} item${removed.length === 1 ? "" : "s"}.`
        : "Nothing to clear.",
    );
  }

  function onLockAdmin() {
    lockAdmin();
    onClose();
  }

  function updateIntegration(id: IntegrationId, patch: Partial<IntegrationConfig>) {
    setSettings((prev) => ({
      ...prev,
      integrations: {
        ...prev.integrations,
        [id]: { ...prev.integrations[id], ...patch },
      },
    }));
    setSaved(false);
  }

  function updateField(id: IntegrationId, key: string, value: string) {
    setSettings((prev) => ({
      ...prev,
      integrations: {
        ...prev.integrations,
        [id]: {
          ...prev.integrations[id],
          fields: { ...prev.integrations[id].fields, [key]: value },
        },
      },
    }));
    setSaved(false);
  }

  function update<K extends keyof UserSettings>(k: K, v: UserSettings[K]) {
    setSettings((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  }

  function connect(id: IntegrationId) {
    const def = INTEGRATIONS.find((d) => d.id === id)!;
    const cfg = settings.integrations[id];
    const requiredKeys = def.fields.filter((f) => f.key !== "pullUrl" && f.key !== "pushUrl").map((f) => f.key);
    const hasAny = requiredKeys.some((k) => (cfg.fields[k] || "").trim().length > 0);
    updateIntegration(id, { connected: hasAny });
  }

  async function runTest(id: IntegrationId): Promise<TestResult> {
    const cfg = settings.integrations[id];
    if (id === "zoho") return testZoho(cfg);
    if (id === "googleMeet") return testGoogleMeet(cfg);
    if (id === "zoom") return testZoom(cfg);
    return testCustomTool(cfg);
  }

  function onSave() {
    saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  }

  const integrationsReady = useMemo(
    () => INTEGRATIONS.filter((d) => settings.integrations[d.id].connected).length,
    [settings.integrations],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[rgba(6,6,8,0.72)]" onClick={onClose}>
      <div
        className="mt-auto bg-surface-1 border-t border-line max-h-[92vh] flex flex-col w-full max-w-[720px] mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-ink-3">Settings</div>
            <div className="text-sm font-semibold text-ink mt-0.5">Integrations</div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pt-4 pb-2 flex items-center gap-3">
            <div className="flex items-center gap-2 text-[11px] text-ink-3">
              <Plug size={12} className="text-zop-orange" />
              <span className="font-mono uppercase tracking-[0.14em]">
                {integrationsReady} of {INTEGRATIONS.length} connected
              </span>
            </div>
            <div className="flex-1 h-px bg-line" />
          </div>

          <div className="px-4 pb-2 space-y-2">
            {INTEGRATIONS.map((def) => {
              const cfg = settings.integrations[def.id];
              const open = expanded === def.id;
              return (
                <IntegrationCard
                  key={def.id}
                  def={def}
                  config={cfg}
                  open={open}
                  onToggleOpen={() => setExpanded(open ? null : def.id)}
                  onPatchConfig={(patch) => updateIntegration(def.id, patch)}
                  onFieldChange={(k, v) => updateField(def.id, k, v)}
                  onConnect={() => connect(def.id)}
                  onDisconnect={() => updateIntegration(def.id, { connected: false })}
                  onTest={() => runTest(def.id)}
                  reveal={reveal}
                  onToggleReveal={(k) => setReveal((r) => ({ ...r, [k]: !r[k] }))}
                />
              );
            })}
          </div>

          <div className="px-4 py-3 mt-1 border-t border-line">
            <button
              type="button"
              onClick={() => setShowModels((s) => !s)}
              className="w-full flex items-center justify-between text-left py-1 text-[11px] font-mono uppercase tracking-[0.14em] text-ink-4 hover:text-ink-3 transition-colors"
            >
              <span>Advanced · Model provider</span>
              <ChevronDown
                size={12}
                className={`transition-transform ${showModels ? "rotate-180" : ""}`}
              />
            </button>

            {showModels && (
              <div className="mt-3 space-y-3">
                <ProviderPicker settings={settings} onPick={(p) => update("provider", p)} />
                {settings.provider === "gemini" && (
                  <CompactKey
                    label="Google Gemini"
                    value={settings.geminiKey}
                    onChange={(v) => update("geminiKey", v)}
                    revealed={!!reveal.geminiKey}
                    onToggleReveal={() => setReveal((r) => ({ ...r, geminiKey: !r.geminiKey }))}
                    link="https://aistudio.google.com/apikey"
                    hint="Free · 1,500 requests/day"
                  />
                )}
                {settings.provider === "anthropic" && (
                  <CompactKey
                    label="Anthropic Claude"
                    value={settings.anthropicKey}
                    onChange={(v) => update("anthropicKey", v)}
                    revealed={!!reveal.anthropicKey}
                    onToggleReveal={() => setReveal((r) => ({ ...r, anthropicKey: !r.anthropicKey }))}
                    link="https://console.anthropic.com/settings/keys"
                    hint="Paid · highest quality"
                  />
                )}
                {settings.provider === "custom" && (
                  <CustomProviderCard
                    settings={settings}
                    onChange={update}
                    revealed={!!reveal.customKey}
                    onToggleReveal={() => setReveal((r) => ({ ...r, customKey: !r.customKey }))}
                  />
                )}
              </div>
            )}
          </div>

          <div className="px-4 py-3 mt-1 border-t border-line space-y-3">
            <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-ink-4">
              Danger zone · Admin
            </div>
            <div className="border border-red-500/30 bg-red-500/5 p-3 space-y-2">
              <div className="flex items-start gap-2">
                <Trash2 size={13} className="text-red-300 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-ink">Clear all session data</div>
                  <div className="text-[11px] text-ink-4 mt-0.5 leading-snug">
                    Wipes saved call summaries, calendar cache, transponder layout and auto-start flag from this browser.
                    API keys and integration credentials are kept.
                  </div>
                </div>
              </div>
              {wipeState === "done" ? (
                <div className="text-[11px] text-zop-green flex items-center gap-1.5">
                  <Check size={11} /> {wipeNote}
                </div>
              ) : wipeState === "confirm" ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onWipe}
                    className="px-3 py-1.5 text-[11px] font-semibold bg-red-500/80 text-white hover:bg-red-500 transition-colors"
                  >
                    Yes, wipe
                  </button>
                  <button
                    type="button"
                    onClick={() => setWipeState("idle")}
                    className="px-3 py-1.5 text-[11px] font-semibold text-ink-3 hover:text-ink border border-line hover:border-line-2 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setWipeState("confirm")}
                  className="px-3 py-1.5 text-[11px] font-semibold text-red-300 border border-red-500/40 hover:border-red-500/70 hover:bg-red-500/10 transition-colors"
                >
                  Clear session data…
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onLockAdmin}
              className="text-[11px] text-ink-4 hover:text-ink flex items-center gap-1.5"
            >
              <Lock size={11} /> Lock admin & close
            </button>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-line flex items-center justify-between gap-3 bg-surface-1">
          <div className="text-[11px] text-ink-4">
            {saved ? (
              <span className="flex items-center gap-1 text-zop-green">
                <Check size={12} /> Saved
              </span>
            ) : (
              "Credentials stay in this browser."
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-ink-3 hover:text-ink border border-line hover:border-line-2 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              className="px-4 py-1.5 text-xs font-semibold bg-zop-orange text-zop-black hover:shadow-hover-orange transition-all"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function IntegrationCard({
  def,
  config,
  open,
  onToggleOpen,
  onPatchConfig,
  onFieldChange,
  onConnect,
  onDisconnect,
  onTest,
  reveal,
  onToggleReveal,
}: {
  def: IntegrationDef;
  config: IntegrationConfig;
  open: boolean;
  onToggleOpen: () => void;
  onPatchConfig: (patch: Partial<IntegrationConfig>) => void;
  onFieldChange: (key: string, value: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest: () => Promise<TestResult>;
  reveal: Record<string, boolean>;
  onToggleReveal: (key: string) => void;
}) {
  const connected = config.connected;
  const accentText = `text-${def.accent}`;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest();
      setTestResult(r);
      if (r.ok && !connected) onConnect();
    } finally {
      setTesting(false);
    }
  }

  return (
    <div
      className={`border bg-surface-2 transition-colors ${
        connected ? "border-zop-green/40" : "border-line"
      }`}
    >
      <button
        type="button"
        onClick={onToggleOpen}
        className="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-surface-3 transition-colors"
      >
        <div
          className={`w-7 h-7 shrink-0 flex items-center justify-center border border-line bg-surface-1 ${accentText}`}
        >
          {def.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-ink truncate">{def.name}</span>
            {connected ? (
              <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-zop-green border border-zop-green/40 px-1 py-px">
                connected
              </span>
            ) : (
              <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-ink-4 border border-line px-1 py-px">
                not connected
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-4 mt-0.5 truncate">{def.tagline}</div>
        </div>
        <ChevronDown
          size={14}
          className={`text-ink-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 border-t border-line space-y-3 pt-3">
          <div className="grid grid-cols-2 gap-2">
            <DirectionToggle
              icon={<Download size={11} />}
              label="Data pull"
              sub={def.pullLabel}
              active={config.pullEnabled}
              onToggle={() => onPatchConfig({ pullEnabled: !config.pullEnabled })}
            />
            <DirectionToggle
              icon={<Upload size={11} />}
              label="Data push"
              sub={def.pushLabel}
              active={config.pushEnabled}
              onToggle={() => onPatchConfig({ pushEnabled: !config.pushEnabled })}
            />
          </div>

          <div className="space-y-2">
            {def.fields.map((f) => {
              const value = config.fields[f.key] || "";
              const fieldId = `${def.id}_${f.key}`;
              const showVal = f.secret ? !!reveal[fieldId] : true;
              return (
                <div key={f.key}>
                  <label className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4 block mb-1">
                    {f.label}
                  </label>
                  <div className="flex items-stretch border border-line bg-surface-1">
                    <input
                      type={showVal ? "text" : "password"}
                      value={value}
                      onChange={(e) => onFieldChange(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      spellCheck={false}
                      autoComplete="off"
                      className="flex-1 bg-transparent px-2.5 py-2 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none"
                    />
                    {f.secret && (
                      <button
                        type="button"
                        onClick={() => onToggleReveal(fieldId)}
                        className="px-2.5 text-ink-3 hover:text-ink border-l border-line"
                        aria-label={showVal ? "Hide" : "Show"}
                      >
                        {showVal ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {testResult && (
            <div
              className={`flex items-start gap-1.5 text-[11px] px-2 py-1.5 border ${
                testResult.ok
                  ? "border-zop-green/40 bg-zop-green/5 text-zop-green"
                  : "border-red-500/40 bg-red-500/5 text-red-300"
              }`}
            >
              {testResult.ok ? (
                <Check size={11} className="mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              )}
              <span className="leading-snug">{testResult.detail}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            {def.docsUrl ? (
              <a
                href={def.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-zop-orange"
              >
                {def.docsLabel || "Get credentials"} <ExternalLink size={10} />
              </a>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="px-3 py-1.5 text-[11px] font-semibold text-ink-3 hover:text-ink border border-line hover:border-line-2 transition-colors flex items-center gap-1 disabled:opacity-60"
              >
                {testing ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Zap size={11} />
                )}
                {testing ? "Testing…" : "Test"}
              </button>
              {connected ? (
                <button
                  type="button"
                  onClick={onDisconnect}
                  className="px-3 py-1.5 text-[11px] font-semibold text-ink-3 hover:text-ink border border-line hover:border-line-2 transition-colors"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onConnect}
                  className="px-3 py-1.5 text-[11px] font-semibold bg-zop-orange text-zop-black hover:shadow-hover-orange transition-all"
                >
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DirectionToggle({
  icon,
  label,
  sub,
  active,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`text-left p-2 border transition-colors ${
        active
          ? "border-zop-green/50 bg-zop-green/5"
          : "border-line bg-surface-1 hover:border-line-2"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={active ? "text-zop-green" : "text-ink-3"}>{icon}</span>
        <span className="text-[11px] font-semibold text-ink">{label}</span>
        <span
          className={`ml-auto w-6 h-3 flex items-center ${
            active ? "bg-zop-green/60 justify-end" : "bg-surface-3 justify-start"
          }`}
        >
          <span className="w-3 h-3 bg-ink" />
        </span>
      </div>
      <div className="text-[10px] text-ink-4 mt-1 leading-snug">{sub}</div>
    </button>
  );
}

function ProviderPicker({
  settings,
  onPick,
}: {
  settings: UserSettings;
  onPick: (p: UserSettings["provider"]) => void;
}) {
  // Providers proxied through the backend — no client-side API key needed.
  const PROXIED = new Set(["anthropic", "gemini", "groq", "openrouter"]);

  const providers: { id: UserSettings["provider"]; label: string }[] = [
    { id: "openrouter", label: "OpenRouter" },
    { id: "gemini", label: "Gemini" },
    { id: "anthropic", label: "Claude" },
    { id: "groq", label: "Groq" },
    { id: "ollama", label: "Ollama" },
    { id: "custom", label: settings.customLabel || "Custom" },
  ];
  const isProxied = PROXIED.has(settings.provider);
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4 mb-1.5">
        Active provider
      </div>
      <div className="grid grid-cols-3 gap-1 border border-line bg-surface-2 p-1">
        {providers.map((p) => {
          const active = settings.provider === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className={`text-xs font-medium py-1.5 px-2 transition-colors truncate ${
                active
                  ? "bg-zop-orange text-zop-black"
                  : "text-ink-3 hover:text-ink hover:bg-surface-3"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {isProxied && (
        <div className="mt-1.5 text-[10px] text-ink-4 leading-snug">
          API key is managed by the backend — no client-side key needed.
          Set <span className="font-mono">OPENROUTER_API_KEY</span> /
          <span className="font-mono"> ANTHROPIC_API_KEY</span> /
          <span className="font-mono"> GROQ_API_KEY</span> in{" "}
          <span className="font-mono">backend/.env</span>.
        </div>
      )}
    </div>
  );
}

function CustomProviderCard({
  settings,
  onChange,
  revealed,
  onToggleReveal,
}: {
  settings: UserSettings;
  onChange: <K extends keyof UserSettings>(k: K, v: UserSettings[K]) => void;
  revealed: boolean;
  onToggleReveal: () => void;
}) {
  const ready = !!settings.customBaseUrl && !!settings.customModel;
  return (
    <div className="border border-line bg-surface-2 p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">Custom provider</span>
          <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-ink-4 border border-line px-1 py-px">
            OpenAI-compatible
          </span>
          {ready && (
            <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-zop-green border border-zop-green/40 px-1 py-px">
              ready
            </span>
          )}
        </div>
      </div>
      <div className="text-[10px] text-ink-4 mb-2 leading-relaxed">
        Point at any OpenAI-compatible <span className="font-mono">/chat/completions</span> endpoint —
        OpenAI, OpenRouter, Together, Fireworks, Mistral, DeepSeek, a local LLM, or your own proxy.
      </div>
      <div className="space-y-2">
        <input
          type="text"
          value={settings.customLabel}
          onChange={(e) => onChange("customLabel", e.target.value)}
          placeholder="Display name (e.g. OpenAI, OpenRouter)"
          spellCheck={false}
          className="w-full border border-line bg-surface-1 px-2.5 py-1.5 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
        />
        <input
          type="text"
          value={settings.customBaseUrl}
          onChange={(e) => onChange("customBaseUrl", e.target.value)}
          placeholder="Endpoint URL (e.g. https://api.openai.com/v1)"
          spellCheck={false}
          autoComplete="off"
          className="w-full border border-line bg-surface-1 px-2.5 py-1.5 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
        />
        <input
          type="text"
          value={settings.customModel}
          onChange={(e) => onChange("customModel", e.target.value)}
          placeholder="Model name (e.g. gpt-4o-mini)"
          spellCheck={false}
          className="w-full border border-line bg-surface-1 px-2.5 py-1.5 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
        />
        <div className="flex items-stretch border border-line bg-surface-1">
          <input
            type={revealed ? "text" : "password"}
            value={settings.customKey}
            onChange={(e) => onChange("customKey", e.target.value)}
            placeholder="API key (optional for local endpoints)"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent px-2.5 py-1.5 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none"
          />
          <button
            type="button"
            onClick={onToggleReveal}
            className="px-2.5 text-ink-3 hover:text-ink border-l border-line"
            aria-label={revealed ? "Hide key" : "Show key"}
          >
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function CompactKey({
  label,
  value,
  onChange,
  revealed,
  onToggleReveal,
  link,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  revealed: boolean;
  onToggleReveal: () => void;
  link?: string;
  hint?: string;
}) {
  return (
    <div className="border border-line bg-surface-2 p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-ink">{label}</span>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-ink-3 hover:text-zop-orange"
          >
            Get key <ExternalLink size={9} />
          </a>
        )}
      </div>
      {hint && <div className="text-[10px] text-ink-4 mb-1.5">{hint}</div>}
      <div className="flex items-stretch border border-line bg-surface-1">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Paste ${label} key`}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent px-2.5 py-1.5 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none"
        />
        <button
          type="button"
          onClick={onToggleReveal}
          className="px-2.5 text-ink-3 hover:text-ink border-l border-line"
          aria-label={revealed ? "Hide key" : "Show key"}
        >
          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
    </div>
  );
}
