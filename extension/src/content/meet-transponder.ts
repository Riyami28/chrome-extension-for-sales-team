// Transponder overlay for Google Meet. Injected only on meet.google.com.
// Vanilla DOM — content scripts run in their own world without React.
// Renders as a floating pill below the rep's self-view tile. Position is
// draggable; state persists to chrome.storage.local.

import type {
  AgendaItem,
  CoachRejection,
  CoachSuggestion,
  MeetingCopilotMessage,
  MeetingSessionInput,
  SentimentSnapshot,
  TranscriptSegment,
} from "../shared/types";

// Shapes mirrored in alongside the primary payload fields. Kept as local
// structural types so the content script doesn't have to import from the
// orchestrator-side helpers module.
interface SentimentTrend {
  energy: "low" | "medium" | "high";
  direction: "up" | "down" | "flat";
  label: string;
}
interface AgendaPacing {
  coveredCount: number;
  totalCount: number;
  coveredRatio: number;
  expectedRatio: number;
  drift: number;
  label: string;
}

interface TransponderState {
  status: "idle" | "listening" | "paused" | "ended" | "error";
  suggestion?: CoachSuggestion;
  // Rolling buffer of recent coach suggestions so the panel can split them
  // into SAY THIS / AVOID columns instead of showing only the last one.
  suggestions: CoachSuggestion[];
  sentiment?: SentimentSnapshot;
  sentimentTrend?: SentimentTrend;
  pacing?: AgendaPacing;
  // Keep the last few validator rejections so reps can see what was blocked
  // instead of silently losing the nudge.
  rejections: CoachRejection[];
  errorBanner?: string | null;
  agenda?: AgendaItem[];
  latest?: TranscriptSegment;
  transcript: TranscriptSegment[];
  lastFinalAt?: number; // Date.now ms
  silenceWarning?: boolean;
  input?: MeetingSessionInput;
  startedAt?: number;
  // Layout: collapsed = pill mode (one-line summary under the camera);
  // expanded = full strip with mood + say/avoid + transcript drawer.
  collapsed?: boolean;
  showLog?: boolean;
  expanded?: boolean;
  // Live "thinking" preview — streamed text while the coach LLM is generating.
  // Cleared when the structured suggestion lands.
  thinking?: { kind: "coach"; text: string } | null;
  // Ask-KB thread. Each entry is a question the rep typed during the call;
  // the answer fills in once the side-panel returns it. New asks while one
  // is still pending mark the previous as cancelled so reps never lose
  // track of which answer maps to which question.
  kbThread: KbThreadEntry[];
}

interface KbThreadEntry {
  id: string;
  question: string;
  answer?: string;
  status: "pending" | "done" | "cancelled" | "error";
  createdAt: number;
}

const ROOT_ID = "clientlens-transponder";
const PROMPT_ID = "clientlens-start-prompt";
const STORAGE_KEY = "clientlens.transponder.pos"; // legacy floating-panel position; cleared on first dock
const DOCK_KEY = "clientlens.transponder.dock";   // legacy vertical-dock prefs; ignored now
const LAYOUT_KEY = "clientlens.transponder.layout";
const AUTOSTART_KEY = "clientlens.autostart";
// User-pinned body height (px). Default 320; persists across sessions so the
// rep's preferred panel size sticks. Re-renders never change height — only
// dragging the resize grip does.
const BODY_HEIGHT_KEY = "clientlens.transponder.body_h";
const BODY_HEIGHT_DEFAULT = 320;
const BODY_HEIGHT_MIN = 160;
const BODY_HEIGHT_MAX = 720;

// The strip sits under the physical laptop camera — narrow enough that the
// rep can flick their eyes between the camera lens and the prompts without
// breaking eye contact. Width caps mean it never covers the remote tile.
const STRIP_W = 560;
const STRIP_W_PILL = 320;
const STRIP_W_WIDE = 960;

let root: HTMLDivElement | null = null;
let promptEl: HTMLDivElement | null = null;
let sessionStarted = false;
let lastMeetingSignature = "";
let state: TransponderState = { status: "idle", transcript: [], suggestions: [], rejections: [], collapsed: false, showLog: false, kbThread: [] };
let silenceTimer: number | undefined;
const SILENCE_MS = 30_000;
const TRANSCRIPT_TAIL = 12;

// After an extension reload the previously-injected copy of this script is
// "orphaned": the DOM still has it, but `chrome.runtime.id` is undefined and
// any chrome.* call throws "Extension context invalidated". We check this on
// every entry point and tear down quietly so we don't spam the page with
// errors. The freshly-injected build will re-mount cleanly.
function isExtensionAlive(): boolean {
  try { return Boolean(chrome.runtime?.id); } catch { return false; }
}

let teardownDone = false;
function teardownOrphan() {
  if (teardownDone) return;
  teardownDone = true;
  try { observer.disconnect(); } catch { /* observer may not exist yet */ }
  if (silenceTimer) window.clearTimeout(silenceTimer);
  stopTick();
  if (root) { try { root.remove(); } catch { /* noop */ } root = null; }
  if (promptEl) { try { promptEl.remove(); } catch { /* noop */ } promptEl = null; }
}

function injectFonts() {
  if (document.getElementById("clientlens-fonts")) return;
  const preconnect1 = document.createElement("link");
  preconnect1.rel = "preconnect";
  preconnect1.href = "https://fonts.googleapis.com";
  const preconnect2 = document.createElement("link");
  preconnect2.rel = "preconnect";
  preconnect2.href = "https://fonts.gstatic.com";
  preconnect2.crossOrigin = "anonymous";
  const fonts = document.createElement("link");
  fonts.id = "clientlens-fonts";
  fonts.rel = "stylesheet";
  fonts.href =
    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap";
  document.head.appendChild(preconnect1);
  document.head.appendChild(preconnect2);
  document.head.appendChild(fonts);
}

function css() {
  return `
  #${ROOT_ID}, #${ROOT_ID} *, #${ROOT_ID} *::before, #${ROOT_ID} *::after,
  #${PROMPT_ID}, #${PROMPT_ID} *, #${PROMPT_ID} *::before, #${PROMPT_ID} *::after {
    border-radius: 0;
    letter-spacing: -0.02em;
    box-sizing: border-box;
  }
  #${ROOT_ID} .num, #${ROOT_ID} .mono, #${ROOT_ID} pre,
  #${PROMPT_ID} .num, #${PROMPT_ID} .mono {
    font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }
  #${ROOT_ID} {
    position: fixed; z-index: 2147483000;
    top: 0; left: 50%; transform: translateX(-50%);
    width: ${STRIP_W}px; max-width: calc(100vw - 32px);
    font-family: 'Space Grotesk', system-ui, sans-serif;
    color: #F0EBDB; background: #0E0E12;
    border: 1px solid #2A2A34; border-top: 0;
    box-shadow: 0 4px 0 -2px #F58549, 0 12px 32px rgba(0,0,0,0.4);
    font-size: 12px; line-height: 1.4;
    user-select: none;
    display: flex; flex-direction: column;
    transition: width 140ms ease;
  }
  #${ROOT_ID}.collapsed { width: ${STRIP_W_PILL}px; }
  #${ROOT_ID}.expanded  { width: ${STRIP_W_WIDE}px; }
  #${ROOT_ID}.expanded .cl-primary-body { font-size: 16px; line-height: 1.55; }
  #${ROOT_ID}.expanded .cl-primary-hint { font-size: 12px; }
  #${ROOT_ID}.expanded .cl-chip-co { max-width: 320px; font-size: 13px; }
  #${ROOT_ID} .cl-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 10px; border-bottom: 1px solid #2A2A34;
    letter-spacing: 0.14em; text-transform: uppercase;
    font-size: 9px; color: #A8A195;
    flex: none; gap: 8px;
  }
  #${ROOT_ID}.collapsed .cl-body { display: none; }
  #${ROOT_ID} .cl-head-actions { display: flex; gap: 4px; align-items: center; }
  #${ROOT_ID} .cl-head-btn {
    background: transparent; color: #A8A195; border: 0; cursor: pointer;
    font-size: 13px; font-family: inherit; padding: 2px 6px; line-height: 1;
  }
  #${ROOT_ID} .cl-head-btn:hover { color: #F0EBDB; }
  #${ROOT_ID} .cl-dot {
    width: 8px; height: 8px; background: #34d399; display: inline-block;
    margin-right: 8px;
  }
  #${ROOT_ID}.idle .cl-dot { background: #5A5A62; }
  #${ROOT_ID}.error .cl-dot { background: #F87171; }
  #${ROOT_ID} .cl-body {
    padding: 10px 12px; flex: 1;
    height: ${BODY_HEIGHT_DEFAULT}px;
    min-height: ${BODY_HEIGHT_MIN}px;
    max-height: ${BODY_HEIGHT_MAX}px;
    overflow-y: auto;
    overflow-x: hidden;
    resize: vertical;
    /* Custom grip below makes the resize affordance obvious — Chrome's
       default corner triangle is invisible on dark themes. */
    position: relative;
  }
  #${ROOT_ID} .cl-grip {
    position: sticky; bottom: 0; left: 0; right: 0;
    height: 14px; margin: 10px -12px -10px;
    cursor: ns-resize;
    background: linear-gradient(to bottom, transparent, rgba(245,133,73,0.06));
    border-top: 1px dashed #2A2A34;
    pointer-events: none;
    display: flex; align-items: center; justify-content: center; gap: 3px;
  }
  #${ROOT_ID} .cl-grip::before,
  #${ROOT_ID} .cl-grip::after {
    content: ""; width: 18px; height: 2px; background: #F58549; opacity: 0.55;
  }
  #${ROOT_ID} .cl-grip::after { width: 28px; }
  #${ROOT_ID} .cl-foot {
    display: flex; gap: 6px; align-items: center;
    margin-top: 8px; padding-top: 8px; border-top: 1px dashed #2A2A34;
  }
  #${ROOT_ID} .cl-drawer { display: none; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #2A2A34; max-height: 220px; overflow-y: auto; }
  #${ROOT_ID}.show-log .cl-drawer { display: block; }

  /* ── Header chip: compact company + mood summary ───────────────────── */
  #${ROOT_ID} .cl-chip {
    display: flex; align-items: center; gap: 10px;
    font-size: 11px; color: #A8A195;
    flex: 1; min-width: 0;
    letter-spacing: 0;
    text-transform: none;
  }
  #${ROOT_ID} .cl-chip-co {
    font-weight: 600; color: #F0EBDB; font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 180px;
  }
  #${ROOT_ID} .cl-chip-mood { display: inline-flex; gap: 4px; align-items: center; }
  #${ROOT_ID} .cl-chip-mood.pos { color: #7FB236; }
  #${ROOT_ID} .cl-chip-mood.neg { color: #F87171; }
  #${ROOT_ID} .cl-chip-mood.mix { color: #FBBF24; }
  #${ROOT_ID} .cl-chip-sep { color: #3A3A46; }

  /* ── Coach cards: SAY THIS (green) + AVOID (red).
       Side-by-side only when the panel is wide enough; stacked otherwise so
       the body stays readable at 560px without horizontal scrolling. ─────── */
  #${ROOT_ID} .cl-cards {
    display: flex; gap: 8px; align-items: stretch;
    flex-direction: column;
  }
  #${ROOT_ID}.expanded .cl-cards { flex-direction: row; }
  #${ROOT_ID}.expanded .cl-cards > * { flex: 1; min-width: 0; }
  #${ROOT_ID} .cl-primary,
  #${ROOT_ID} .cl-avoid {
    background: #060608;
    border: 1px solid #2A2A34;
    padding: 10px 12px;
    display: flex; flex-direction: column;
  }
  #${ROOT_ID} .cl-primary { border-left: 3px solid #7FB236; }
  #${ROOT_ID} .cl-avoid   { border-left: 3px solid #F87171; }
  /* Confidence border: overrides the default green when validator returns
     medium/low confidence. High confidence keeps the default #7FB236. */
  #${ROOT_ID} .cl-primary.conf-med   { border-left-color: #FBBF24; }
  #${ROOT_ID} .cl-primary.conf-low   { border-left-color: #F87171; opacity: 0.88; }
  #${ROOT_ID} .cl-avoid-title {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #F87171; margin-bottom: 6px;
  }
  #${ROOT_ID} .cl-avoid-body { font-size: 13px; line-height: 1.5; color: #F0EBDB; }
  #${ROOT_ID} .cl-avoid-empty { font-size: 12px; color: #5A5A62; font-style: italic; }
  #${ROOT_ID} .cl-avoid-rationale {
    margin-top: 6px; padding-top: 6px;
    border-top: 1px dashed #2A2A34;
    font-size: 10px; color: #A8A195; line-height: 1.4; font-style: italic;
  }
  #${ROOT_ID} .cl-avoid-rationale b { color: #D4CDB5; font-style: normal; font-weight: 500; margin-right: 4px; }
  #${ROOT_ID} .cl-primary-rationale {
    margin-top: 6px; padding-top: 6px;
    border-top: 1px dashed #2A2A34;
    font-size: 10px; color: #A8A195; line-height: 1.4;
    font-style: italic;
  }
  #${ROOT_ID} .cl-primary-rationale b { color: #D4CDB5; font-style: normal; font-weight: 500; margin-right: 4px; }
  #${ROOT_ID} .cl-conf-chip {
    display: inline-block; margin-left: 6px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 9px; letter-spacing: 0.04em;
    padding: 1px 5px; border: 1px solid #3A3A46; color: #A8A195;
    vertical-align: middle;
  }
  #${ROOT_ID} .cl-conf-chip.high { color: #7FB236; border-color: #7FB236; }
  #${ROOT_ID} .cl-conf-chip.med  { color: #FBBF24; border-color: #FBBF24; }
  #${ROOT_ID} .cl-conf-chip.low  { color: #F87171; border-color: #F87171; }
  /* Rejection pill — faint so it never competes with an active suggestion. */
  #${ROOT_ID} .cl-reject {
    margin-top: 6px; padding: 6px 8px;
    background: rgba(248,113,113,0.04);
    border: 1px dashed #3A3A46;
    font-size: 10px; color: #A8A195; line-height: 1.4;
  }
  #${ROOT_ID} .cl-reject b { color: #F87171; font-weight: 600; margin-right: 4px; }
  #${ROOT_ID} .cl-reject-body { color: #D4CDB5; margin-top: 2px; }
  #${ROOT_ID} .cl-reject-issues { color: #A8A195; font-size: 9px; margin-top: 2px; font-style: italic; }
  /* Pacing + trend chips — sit inline in the header. */
  #${ROOT_ID} .cl-pace {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; letter-spacing: 0.04em;
    padding: 1px 5px; border: 1px solid #3A3A46; color: #A8A195;
  }
  #${ROOT_ID} .cl-pace.behind { color: #FBBF24; border-color: #FBBF24; }
  #${ROOT_ID} .cl-pace.ahead  { color: #7FB236; border-color: #7FB236; }
  #${ROOT_ID} .cl-trend { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; color: #A8A195; }
  /* Error banner — shown after 3 back-to-back agent failures. */
  #${ROOT_ID} .cl-errbanner {
    margin: 0 0 6px; padding: 6px 8px;
    background: rgba(248,113,113,0.08); border: 1px solid #F87171;
    color: #F87171; font-size: 11px; line-height: 1.4;
    display: flex; gap: 6px; align-items: center;
  }
  #${ROOT_ID} .cl-errbanner b { color: #F87171; font-weight: 600; }
  #${ROOT_ID} .cl-primary-title {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #7FB236; margin-bottom: 6px;
  }
  #${ROOT_ID} .cl-primary-body {
    font-size: 14px; line-height: 1.5; color: #F0EBDB;
  }
  #${ROOT_ID} .cl-primary-hint {
    font-size: 11px; line-height: 1.4; color: #A8A195;
    margin-top: 8px; padding-top: 6px; border-top: 1px dashed #2A2A34;
  }
  #${ROOT_ID} .cl-primary-hint b { color: #F87171; font-weight: 600; margin-right: 4px; }
  #${ROOT_ID} .cl-primary-empty {
    font-size: 12px; color: #5A5A62; font-style: italic;
  }

  /* ── Stacked secondary items in expanded mode ──────────────────────── */
  #${ROOT_ID} .cl-secondary {
    margin-top: 8px; padding: 8px 10px;
    background: #060608; border: 1px solid #2A2A34;
    border-left: 2px solid #F58549;
    font-size: 12px; line-height: 1.4; color: #D4CDB5;
  }
  #${ROOT_ID} .cl-secondary b { color: #F0EBDB; font-weight: 600; }
  #${ROOT_ID} .cl-rationale {
    margin-top: 8px;
    font-size: 11px; font-style: italic; color: #A8A195; line-height: 1.4;
  }
  #${ROOT_ID} .cl-body::-webkit-scrollbar { width: 8px; }
  #${ROOT_ID} .cl-body::-webkit-scrollbar-thumb { background: #2A2A34; }
  #${ROOT_ID} .cl-sug {
    border-left: 3px solid #F58549; padding: 8px 10px; margin-bottom: 10px;
    background: rgba(245,133,73,0.06);
  }
  #${ROOT_ID} .cl-sug.high { border-left-color: #F87171; background: rgba(248,113,113,0.08); }
  #${ROOT_ID} .cl-sug.low { border-left-color: #7FB236; background: rgba(127,178,54,0.06); }
  #${ROOT_ID} .cl-sug-kind {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #D4CDB5; margin-bottom: 4px;
  }
  #${ROOT_ID} .cl-sug-title { font-weight: 600; margin-bottom: 2px; }
  #${ROOT_ID} .cl-sug-body { color: #D4CDB5; }
  #${ROOT_ID} .cl-meta {
    display: flex; gap: 8px; flex-wrap: wrap; font-size: 11px;
    color: #A8A195; margin-bottom: 10px;
  }
  #${ROOT_ID} .cl-pill {
    border: 1px solid #3A3A46; padding: 2px 8px; letter-spacing: 0.04em;
  }
  #${ROOT_ID} .cl-pill.pos { border-color: #7FB236; color: #7FB236; }
  #${ROOT_ID} .cl-pill.neg { border-color: #F87171; color: #F87171; }
  #${ROOT_ID} .cl-pill.mix { border-color: #FBBF24; color: #FBBF24; }
  #${ROOT_ID} .cl-ask-wrap { display: flex; gap: 6px; }
  #${ROOT_ID} .cl-ask {
    flex: 1; background: #060608; color: #F0EBDB; border: 1px solid #2A2A34;
    padding: 6px 8px; font: inherit;
  }
  #${ROOT_ID} .cl-ask:focus { outline: none; border-color: #F58549; }
  #${ROOT_ID} .cl-btn {
    background: #F58549; color: #0A0A0A; border: 0; padding: 6px 10px;
    font: inherit; font-weight: 600; cursor: pointer;
  }
  #${ROOT_ID} .cl-agenda {
    margin-top: 10px; padding-top: 10px; border-top: 1px dashed #2A2A34;
  }
  #${ROOT_ID} .cl-agenda-item {
    display: flex; gap: 8px; align-items: flex-start; margin-bottom: 4px;
    font-size: 12px; color: #A8A195;
  }
  #${ROOT_ID} .cl-agenda-item.covered { color: #7FB236; }
  #${ROOT_ID} .cl-agenda-item.in_progress { color: #F0EBDB; }
  #${ROOT_ID} .cl-agenda-mark { width: 14px; flex: none; }
  #${ROOT_ID} .cl-close {
    background: transparent; color: #A8A195; border: 0; cursor: pointer;
    font-size: 14px; font-family: inherit;
  }
  #${ROOT_ID} .cl-answer {
    margin-top: 8px; padding: 8px; background: #060608;
    border: 1px solid #2A2A34; font-size: 12px; color: #D4CDB5;
  }
  #${ROOT_ID} .cl-kb-thread { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  #${ROOT_ID} .cl-kb-row {
    padding: 8px; background: #060608; border: 1px solid #2A2A34;
    font-size: 12px; line-height: 1.45;
  }
  #${ROOT_ID} .cl-kb-q {
    color: #F0EBDB; font-weight: 500; margin-bottom: 4px;
    display: flex; gap: 6px; align-items: flex-start;
  }
  #${ROOT_ID} .cl-kb-tag {
    background: #F58549; color: #0A0A0A; padding: 0 5px;
    font-size: 10px; font-weight: 600; line-height: 16px;
    flex: none;
  }
  #${ROOT_ID} .cl-kb-ans { color: #D4CDB5; }
  #${ROOT_ID} .cl-kb-pending {
    color: #A8A195; font-style: italic;
    display: flex; gap: 6px; align-items: center;
  }
  #${ROOT_ID} .cl-kb-pending .cl-thinking-dot {
    width: 6px; height: 6px; background: #F58549;
    animation: cl-pulse 1s infinite;
  }
  #${ROOT_ID} .cl-kb-cancelled { color: #FBBF24; font-size: 11px; font-style: italic; }
  #${ROOT_ID} .cl-kb-err { color: #F87171; font-size: 11px; }
  #${ROOT_ID} .cl-log {
    margin-top: 10px; padding-top: 10px; border-top: 1px dashed #2A2A34;
    max-height: 140px; overflow-y: auto;
  }
  #${ROOT_ID} .cl-log-row {
    font-size: 11px; line-height: 1.45; margin-bottom: 4px;
    color: #D4CDB5;
  }
  #${ROOT_ID} .cl-log-tag {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 9px; letter-spacing: 0.08em;
    padding: 1px 4px; margin-right: 6px;
    border: 1px solid #3A3A46;
  }
  #${ROOT_ID} .cl-log-tag.rep { color: #F58549; border-color: #F58549; }
  #${ROOT_ID} .cl-log-tag.prospect { color: #7FB236; border-color: #7FB236; }
  #${ROOT_ID} .cl-log-tag.unknown { color: #A8A195; }
  #${ROOT_ID} .cl-silence {
    margin-top: 8px; padding: 6px 8px;
    background: rgba(251,191,36,0.08); border: 1px solid #FBBF24;
    color: #FBBF24; font-size: 11px; line-height: 1.4;
  }
  #${ROOT_ID} .cl-prospect {
    padding: 6px 8px;
    background: #060608;
    border: 1px solid #2A2A34;
    border-left: 2px solid #F58549;
    height: 100%;
    display: flex; flex-direction: column; gap: 2px;
  }
  #${ROOT_ID} .cl-prospect-co {
    font-size: 12px; font-weight: 600; color: #F0EBDB;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #${ROOT_ID} .cl-prospect-meta {
    font-size: 10px; color: #A8A195;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #${ROOT_ID} .cl-stat-row {
    display: flex; gap: 4px; margin-top: 2px; flex-wrap: wrap;
  }
  #${ROOT_ID} .cl-stat {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; padding: 2px 6px;
    border: 1px solid #3A3A46; color: #D4CDB5;
  }
  #${ROOT_ID} .cl-stat strong { color: #F58549; font-weight: 600; }
  #${ROOT_ID} .cl-mood {
    margin-bottom: 10px; padding: 8px 10px;
    background: #060608; border: 1px solid #2A2A34;
    border-left: 2px solid #A8A195;
  }
  #${ROOT_ID} .cl-mood.pos { border-left-color: #7FB236; }
  #${ROOT_ID} .cl-mood.neg { border-left-color: #F87171; }
  #${ROOT_ID} .cl-mood.mix { border-left-color: #FBBF24; }
  #${ROOT_ID} .cl-mood-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #D4CDB5;
  }
  #${ROOT_ID} .cl-mood-emoji { font-size: 16px; }
  #${ROOT_ID} .cl-mood-label { font-weight: 600; color: #F0EBDB; letter-spacing: 0; text-transform: none; font-size: 12px; }
  #${ROOT_ID} .cl-mood-meta { font-size: 11px; color: #A8A195; margin-top: 4px; }
  #${ROOT_ID} .cl-mood-rationale { font-size: 11px; color: #D4CDB5; margin-top: 4px; line-height: 1.4; font-style: italic; }
  #${ROOT_ID} .cl-coach-col {
    background: #060608; border: 1px solid #2A2A34;
    padding: 6px 8px; min-height: 56px; height: 100%;
  }
  #${ROOT_ID} .cl-coach-col.say { border-left: 2px solid #7FB236; }
  #${ROOT_ID} .cl-coach-col.avoid { border-left: 2px solid #F87171; }
  #${ROOT_ID} .cl-coach-h {
    font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
    margin-bottom: 4px;
  }
  #${ROOT_ID} .cl-coach-col.say .cl-coach-h { color: #7FB236; }
  #${ROOT_ID} .cl-coach-col.avoid .cl-coach-h { color: #F87171; }
  #${ROOT_ID} .cl-coach-item {
    font-size: 11px; line-height: 1.4; color: #D4CDB5;
    margin-bottom: 4px; padding-bottom: 4px;
    border-bottom: 1px dashed #2A2A34;
  }
  #${ROOT_ID} .cl-coach-item:last-child { border-bottom: 0; margin-bottom: 0; padding-bottom: 0; }
  #${ROOT_ID} .cl-coach-item b { color: #F0EBDB; font-weight: 600; }
  #${ROOT_ID} .cl-coach-empty { font-size: 10px; color: #5A5A62; font-style: italic; }
  #${ROOT_ID} .cl-thinking {
    margin: 0 0 6px;
    padding: 4px 8px;
    background: #060608;
    border: 1px dashed #F58549;
    color: #D4CDB5;
    font-size: 11px; line-height: 1.4;
    display: flex; gap: 6px; align-items: center;
  }
  #${ROOT_ID} .cl-thinking-dot {
    width: 6px; height: 6px; background: #F58549;
    animation: cl-pulse 0.9s ease-in-out infinite;
  }
  @keyframes cl-pulse {
    0%, 100% { opacity: 0.3; transform: scale(0.85); }
    50%      { opacity: 1;   transform: scale(1.15); }
  }
  #${ROOT_ID} .cl-thinking-text {
    flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #${PROMPT_ID} {
    position: fixed; z-index: 2147483000;
    right: 24px; bottom: 120px; width: 320px;
    font-family: 'Space Grotesk', system-ui, sans-serif;
    color: #F0EBDB; background: #0E0E12;
    border: 1px solid #2A2A34;
    box-shadow: 0 8px 0 -4px #F58549;
    padding: 14px; font-size: 13px; line-height: 1.45;
  }
  #${PROMPT_ID} .cl-p-title {
    font-weight: 600; margin-bottom: 4px; letter-spacing: -0.02em;
  }
  #${PROMPT_ID} .cl-p-sub { color: #A8A195; font-size: 12px; margin-bottom: 12px; }
  #${PROMPT_ID} .cl-p-row { display: flex; gap: 8px; align-items: center; }
  #${PROMPT_ID} .cl-p-btn {
    background: #F58549; color: #0A0A0A; border: 0; padding: 8px 14px;
    font: inherit; font-weight: 600; cursor: pointer;
  }
  #${PROMPT_ID} .cl-p-btn.ghost {
    background: transparent; color: #A8A195; border: 1px solid #3A3A46;
  }
  #${PROMPT_ID} .cl-p-check {
    display: flex; gap: 6px; align-items: center; margin-top: 10px;
    color: #A8A195; font-size: 11px; cursor: pointer;
  }
  `;
}

function mount() {
  if (root) return;
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  injectFonts();
  const style = document.createElement("style");
  style.id = `${ROOT_ID}-css`;
  style.textContent = css();
  document.head.appendChild(style);

  root = document.createElement("div");
  root.id = ROOT_ID;
  root.className = "idle";
  document.body.appendChild(root);
  // Drop legacy floating-panel + vertical-dock state from older builds.
  try { chrome.storage?.local.remove([STORAGE_KEY, DOCK_KEY]); } catch { /* noop */ }
  loadLayoutPrefs();
  applyLayout();
  render();
  loadBodyHeight();
  observeBodyResize();
}

function loadBodyHeight() {
  if (!root) return;
  let h = BODY_HEIGHT_DEFAULT;
  try {
    const raw = localStorage.getItem(BODY_HEIGHT_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= BODY_HEIGHT_MIN && n <= BODY_HEIGHT_MAX) h = n;
    }
  } catch { /* noop */ }
  const body = root.querySelector<HTMLDivElement>(".cl-body");
  if (body) body.style.height = `${h}px`;
}

let bodyResizeObserver: ResizeObserver | null = null;
function observeBodyResize() {
  if (!root || bodyResizeObserver) return;
  const body = root.querySelector<HTMLDivElement>(".cl-body");
  if (!body) return;
  let saveTimer: number | undefined;
  bodyResizeObserver = new ResizeObserver((entries) => {
    const e = entries[0];
    if (!e) return;
    const h = Math.round(e.contentRect.height + 20); // padding (10+10)
    if (h < BODY_HEIGHT_MIN || h > BODY_HEIGHT_MAX) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try { localStorage.setItem(BODY_HEIGHT_KEY, String(h)); } catch { /* noop */ }
    }, 200) as unknown as number;
  });
  bodyResizeObserver.observe(body);
}

function loadLayoutPrefs() {
  try {
    chrome.storage?.local.get(LAYOUT_KEY, (r) => {
      const p = r?.[LAYOUT_KEY];
      if (p && typeof p === "object") {
        if (typeof p.collapsed === "boolean") state.collapsed = p.collapsed;
        if (typeof p.showLog === "boolean") state.showLog = p.showLog;
        if (typeof p.expanded === "boolean") state.expanded = p.expanded;
        applyLayout();
      }
    });
  } catch { /* noop */ }
}

function saveLayoutPrefs() {
  try {
    chrome.storage?.local.set({
      [LAYOUT_KEY]: { collapsed: state.collapsed, showLog: state.showLog, expanded: state.expanded },
    });
  } catch { /* noop */ }
}

function applyLayout() {
  if (!root) return;
  root.classList.toggle("collapsed", !!state.collapsed);
  root.classList.toggle("show-log", !!state.showLog);
  root.classList.toggle("expanded", !!state.expanded && !state.collapsed);
}

function toggleCollapsed() {
  state.collapsed = !state.collapsed;
  applyLayout();
  saveLayoutPrefs();
  render();
}

function toggleLog() {
  state.showLog = !state.showLog;
  applyLayout();
  saveLayoutPrefs();
  render();
}

function toggleExpanded() {
  state.expanded = !state.expanded;
  if (state.expanded) state.collapsed = false;
  applyLayout();
  saveLayoutPrefs();
  render();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

function pillClass(label?: string): string {
  if (label === "positive") return "pos";
  if (label === "negative") return "neg";
  if (label === "mixed") return "mix";
  return "";
}

function moodEmoji(label?: string): string {
  if (label === "positive") return "🟢";
  if (label === "negative") return "🔴";
  if (label === "mixed") return "🟡";
  return "⚪";
}

// Coach kinds we show under "SAY THIS" — anything actionable the rep should do
// or say next. Anything we want the rep to back off of goes in AVOID.
const SAY_KINDS: CoachSuggestion["kind"][] = [
  "say_next",
  "ask_question",
  "handle_objection",
  "cover_agenda",
  "kb_answer",
];
const AVOID_KINDS: CoachSuggestion["kind"][] = ["avoid", "sentiment_shift"];

function activeSuggestions(list: CoachSuggestion[]) {
  const live = list.filter((s) => !s.dismissed && !s.acted_on);
  const say = live.filter((s) => SAY_KINDS.includes(s.kind)).slice(-2);
  const avoid = live.filter((s) => AVOID_KINDS.includes(s.kind)).slice(-2);
  return { say, avoid };
}

function render() {
  if (!root) return;
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  root.className = state.status;

  const sent = state.sentiment;
  const trend = state.sentimentTrend;
  const pacing = state.pacing;
  const inp = state.input;

  // ── Header chip: company name + inline mood pill + trend + pacing ──
  const moodCls = pillClass(sent?.prospect);
  // Show the trend arrow next to the mood label so a dip is visible at a glance.
  const moodText = trend?.label || (sent ? sent.prospect : "reading…");
  const moodPill = `<span class="cl-chip-mood ${moodCls}">${moodEmoji(sent?.prospect)} ${escapeHtml(moodText)}</span>`;
  const elapsedMin = state.startedAt
    ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 60000))
    : 0;
  const paceCls = pacing ? (pacing.drift < -0.15 ? "behind" : pacing.drift > 0.15 ? "ahead" : "") : "";
  const pacingHtml = pacing
    ? `<span class="cl-pace ${paceCls}" title="${escapeHtml(pacing.label)}">${pacing.coveredCount}/${pacing.totalCount} agenda</span>`
    : "";
  const chipHtml = `<span class="cl-chip">
      <span class="cl-chip-co">${escapeHtml(inp?.company_name || "ClientLens")}</span>
      <span class="cl-chip-sep">·</span>
      ${moodPill}
      <span class="cl-chip-sep">·</span>
      <span>${elapsedMin}m</span>
      ${pacingHtml ? `<span class="cl-chip-sep">·</span>${pacingHtml}` : ""}
    </span>`;

  // ── Primary card: one say-this with avoid as inline footnote ───────
  const { say, avoid } = activeSuggestions(state.suggestions);
  const latestSay = say[say.length - 1];
  const latestAvoid = avoid[avoid.length - 1];

  // Confidence drives the left-border color. Missing = treat as high.
  const conf = latestSay?.confidence;
  const confCls = conf == null ? "" : conf >= 0.7 ? "" : conf >= 0.45 ? "conf-med" : "conf-low";
  const confLabel = conf == null ? "" : conf >= 0.7 ? "high" : conf >= 0.45 ? "med" : "low";
  const confChip = conf != null
    ? `<span class="cl-conf-chip ${confLabel}" title="Validator confidence">${Math.round(conf * 100)}%</span>`
    : "";
  const rationaleHtml = latestSay?.rationale
    ? `<div class="cl-primary-rationale"><b>Why:</b>${escapeHtml(latestSay.rationale)}</div>`
    : "";

  const primaryBody = latestSay
    ? `<div class="cl-primary-title">→ ${escapeHtml(latestSay.title)}${confChip}</div>
       <div class="cl-primary-body">${escapeHtml(latestSay.body)}</div>
       ${rationaleHtml}`
    : `<div class="cl-primary-title">→ Say this</div>
       <div class="cl-primary-empty">Coach is listening — a nudge will appear the moment the prospect raises a question or objection.</div>`;

  const avoidRationaleHtml = latestAvoid?.rationale
    ? `<div class="cl-avoid-rationale"><b>Why:</b>${escapeHtml(latestAvoid.rationale)}</div>`
    : "";
  const avoidBody = latestAvoid
    ? `<div class="cl-avoid-title">⚠ ${escapeHtml(latestAvoid.title || "Avoid this")}</div>
       <div class="cl-avoid-body">${escapeHtml(latestAvoid.body)}</div>
       ${avoidRationaleHtml}`
    : `<div class="cl-avoid-title">⚠ Avoid this</div>
       <div class="cl-avoid-empty">No traps flagged yet — the coach will warn here when the prospect signals risk.</div>`;

  // ── Rejection trail (most recent only, when expanded or no active say) ──
  const lastReject = state.rejections[state.rejections.length - 1];
  const showReject = !!lastReject && (state.expanded || !latestSay);
  const rejectHtml = showReject && lastReject
    ? `<div class="cl-reject">
         <div><b>Blocked:</b>${escapeHtml(lastReject.title)}</div>
         <div class="cl-reject-body">${escapeHtml(lastReject.body)}</div>
         ${lastReject.issues.length
            ? `<div class="cl-reject-issues">${escapeHtml(lastReject.issues.join(" · "))}</div>`
            : ""}
       </div>`
    : "";

  const errorBannerHtml = state.errorBanner
    ? `<div class="cl-errbanner"><b>Coach offline:</b><span>${escapeHtml(state.errorBanner)}</span></div>`
    : "";

  // In expanded mode, show the second-most-recent say-this below, plus
  // mood rationale so the rep sees *why* the panel reads this sentiment.
  const prevSay = say.length >= 2 ? say[say.length - 2] : undefined;
  const secondaryHtml = state.expanded && prevSay
    ? `<div class="cl-secondary"><b>Earlier:</b> ${escapeHtml(prevSay.title)} — ${escapeHtml(prevSay.body)}</div>`
    : "";
  const moodRationaleHtml = state.expanded && sent?.rationale
    ? `<div class="cl-rationale">Mood read: ${escapeHtml(sent.rationale)}</div>`
    : "";

  // ── Transcript drawer (only when Log is toggled) ───────────────────
  const tail = state.transcript.slice(-TRANSCRIPT_TAIL);
  const logHtml = tail.length
    ? tail
        .map(
          (t) =>
            `<div class="cl-log-row"><span class="cl-log-tag ${t.speaker}">${t.speaker.toUpperCase()}</span>${escapeHtml(t.text)}</div>`,
        )
        .join("")
    : `<div class="cl-primary-empty">Transcript will appear here as the call progresses.</div>`;

  const silenceHtml = state.silenceWarning && state.status === "listening"
    ? `<div class="cl-silence" style="margin:0 0 6px">No new speech in 30s — summarize or ask a question?</div>`
    : "";

  const thinkingHtml = state.thinking
    ? `<div class="cl-thinking">
         <span class="cl-thinking-dot"></span>
         <span class="cl-thinking-text">${state.thinking.text ? escapeHtml(state.thinking.text) : "Coach is thinking…"}</span>
       </div>`
    : "";

  const collapseGlyph = state.collapsed ? "▾" : "▴";
  const logGlyph = state.showLog ? "⌃ Log" : "⌄ Log";
  const expandGlyph = state.expanded ? "⇤⇥" : "⇥⇤";
  const expandTitle = state.expanded ? "Shrink" : "Expand wider";

  // ── Ask KB thread: each entry shows the question + answer (or status) ──
  const kbThreadHtml = state.kbThread.length
    ? `<div class="cl-kb-thread" data-kb-thread>${state.kbThread
        .map((e) => {
          let body = "";
          if (e.status === "pending") {
            body = `<div class="cl-kb-pending"><span class="cl-thinking-dot"></span> Thinking…</div>`;
          } else if (e.status === "cancelled") {
            body = `<div class="cl-kb-cancelled">Cancelled — moved on to next question.</div>`;
          } else if (e.status === "error") {
            body = `<div class="cl-kb-err">${escapeHtml(e.answer || "Error")}</div>`;
          } else {
            body = `<div class="cl-kb-ans">${escapeHtml(e.answer || "")}</div>`;
          }
          return `<div class="cl-kb-row" data-kb-id="${e.id}">
            <div class="cl-kb-q"><span class="cl-kb-tag">Q</span>${escapeHtml(e.question)}</div>
            ${body}
          </div>`;
        })
        .join("")}</div>`
    : "";

  // Snapshot volatile UI bits so background re-renders (coach/mood updates,
  // 30s tick) don't blow away what the user is typing into Ask KB. The Q&A
  // thread itself lives in state so it's re-rendered from the source of truth.
  const prevInput = root.querySelector<HTMLInputElement>(".cl-ask");
  const askWasFocused = !!prevInput && document.activeElement === prevInput;
  const askValue = prevInput?.value ?? "";
  const askSelStart = prevInput?.selectionStart ?? null;
  const askSelEnd = prevInput?.selectionEnd ?? null;

  root.innerHTML = `
    <div class="cl-head">
      ${chipHtml}
      <span class="cl-head-actions">
        <button class="cl-head-btn" data-action="log" title="Show/hide transcript">${logGlyph}</button>
        <button class="cl-head-btn" data-action="expand" title="${expandTitle}">${expandGlyph}</button>
        <button class="cl-head-btn" data-action="collapse" title="${state.collapsed ? "Expand" : "Collapse"}">${collapseGlyph}</button>
        <button class="cl-head-btn" data-action="close" title="Hide">×</button>
      </span>
    </div>
    <div class="cl-body">
      ${errorBannerHtml}
      ${silenceHtml}
      ${thinkingHtml}
      <div class="cl-cards">
        <div class="cl-primary ${confCls}">${primaryBody}</div>
        <div class="cl-avoid">${avoidBody}</div>
      </div>
      ${rejectHtml}
      ${secondaryHtml}
      ${moodRationaleHtml}
      <div class="cl-foot">
        <input class="cl-ask" placeholder="Ask KB…" title="Type a quick question — agents query your indexed KB (playbooks, product docs, case studies, security, pricing)." />
        <button class="cl-btn" data-action="ask">Ask</button>
      </div>
      ${kbThreadHtml}
      <div class="cl-drawer">${logHtml}</div>
      <div class="cl-grip" title="Drag the panel's bottom-right corner to resize"></div>
    </div>
  `;

  root.querySelector<HTMLButtonElement>('[data-action="close"]')?.addEventListener("click", () => {
    root?.remove();
    root = null;
  });
  root.querySelector<HTMLButtonElement>('[data-action="collapse"]')?.addEventListener("click", () => toggleCollapsed());
  root.querySelector<HTMLButtonElement>('[data-action="log"]')?.addEventListener("click", () => toggleLog());
  root.querySelector<HTMLButtonElement>('[data-action="expand"]')?.addEventListener("click", () => toggleExpanded());

  root.querySelector<HTMLButtonElement>('[data-action="ask"]')?.addEventListener("click", handleAsk);
  const newInput = root.querySelector<HTMLInputElement>(".cl-ask");
  newInput?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") handleAsk();
  });

  // Restore Ask KB input value, focus, and caret position so a re-render
  // mid-typing doesn't drop characters or steal focus.
  if (newInput) {
    if (askValue) newInput.value = askValue;
    if (askWasFocused) {
      newInput.focus({ preventScroll: true });
      if (askSelStart != null && askSelEnd != null) {
        try { newInput.setSelectionRange(askSelStart, askSelEnd); } catch { /* noop */ }
      }
    }
  }
  // The innerHTML rewrite above recreated .cl-body, so its inline height
  // (the user's pinned size) and the ResizeObserver binding were both lost.
  // Reapply both so the panel keeps the rep's chosen size across re-renders.
  loadBodyHeight();
  if (bodyResizeObserver) {
    bodyResizeObserver.disconnect();
    bodyResizeObserver = null;
  }
  observeBodyResize();
}

function handleAsk() {
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  const input = root?.querySelector<HTMLInputElement>(".cl-ask");
  if (!input) return;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";

  // If a previous question is still pending, mark it cancelled so the rep
  // sees clearly that the in-flight answer was abandoned in favour of the
  // new question. (We can't abort the upstream HTTP request without an
  // AbortSignal wired through the LLM client; instead we drop the response
  // when it arrives by id-matching against thread state.)
  for (const e of state.kbThread) {
    if (e.status === "pending") e.status = "cancelled";
  }

  const id = `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // Newest first: latest question always sits at the top of the thread, so
  // the rep's eye lands on the active answer without scrolling. Old asks
  // remain visible below until they fall off the 12-entry cap.
  state.kbThread.unshift({ id, question: q, status: "pending", createdAt: Date.now() });
  if (state.kbThread.length > 12) state.kbThread.length = 12;
  render();
  // Scroll the body to the top so the new active entry is in view.
  const body = root?.querySelector<HTMLDivElement>(".cl-body");
  if (body) body.scrollTop = 0;

  try {
    chrome.runtime.sendMessage<MeetingCopilotMessage>({
      type: "MC_ASK_KB",
      payload: { question: q, id },
    }).catch(() => { /* sidebar may be closed */ });
  } catch { teardownOrphan(); }
}

function resetSilenceTimer() {
  if (silenceTimer) window.clearTimeout(silenceTimer);
  state.silenceWarning = false;
  silenceTimer = window.setTimeout(() => {
    if (state.status !== "listening") return;
    state.silenceWarning = true;
    render();
  }, SILENCE_MS) as unknown as number;
}

// Re-render every 30s so the elapsed counter ticks (cheap; the panel is small).
let tickHandle: number | undefined;
function startTick() {
  if (tickHandle) return;
  tickHandle = window.setInterval(() => {
    if (root && state.status === "listening") render();
  }, 30_000) as unknown as number;
}
function stopTick() {
  if (tickHandle) window.clearInterval(tickHandle);
  tickHandle = undefined;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type: string; payload?: unknown };
  if (m.type === "MC_TRANSPONDER_OPEN") {
    // Session was started from the side-panel entry point. Suppress the
    // in-call "Start ClientLens?" prompt and tear it down if already shown,
    // so the rep doesn't get asked twice for the same call.
    sessionStarted = true;
    dismissPrompt();
    mount();
    state = {
      ...state,
      status: "listening",
      startedAt: Date.now(),
      ...(m.payload as Partial<TransponderState> || {}),
    };
    // Horizontal strip — CSS centers under the camera; no positioning math.
    applyLayout();
    resetSilenceTimer();
    startTick();
    render();
  } else if (m.type === "MC_TRANSPONDER_CLOSE") {
    if (silenceTimer) window.clearTimeout(silenceTimer);
    stopTick();
    if (root) { root.remove(); root = null; }
    // Re-enable the in-call prompt for any *future* call on this tab.
    sessionStarted = false;
  } else if (m.type === "MC_SESSION_UPDATED") {
    // Defensive: if updates arrive without an explicit OPEN (e.g., resumed
    // session, page reload race), still treat the session as live.
    sessionStarted = true;
    dismissPrompt();
    if (!root) mount();
    const patch = (m.payload as Partial<TransponderState> & {
      suggestion?: CoachSuggestion;
      rejection?: CoachRejection;
    }) || {};
    // Append to suggestions buffer rather than overwrite — the panel needs the
    // recent history to fill the SAY THIS / AVOID columns.
    if (patch.suggestion) {
      const sug = patch.suggestion;
      const exists = state.suggestions.some((x) => x.id === sug.id);
      if (!exists) {
        state.suggestions = [...state.suggestions, sug].slice(-12);
      }
      state.suggestion = sug;
    }
    if (patch.rejection) {
      const rej = patch.rejection;
      const exists = state.rejections.some((x) => x.id === rej.id);
      if (!exists) state.rejections = [...state.rejections, rej].slice(-6);
    }
    if (patch.sentiment) state.sentiment = patch.sentiment;
    if (patch.sentimentTrend) state.sentimentTrend = patch.sentimentTrend;
    if (patch.pacing) state.pacing = patch.pacing;
    if ("errorBanner" in patch) state.errorBanner = patch.errorBanner ?? null;
    if (patch.agenda) state.agenda = patch.agenda;
    if (patch.input) state.input = { ...(state.input || {}), ...patch.input } as typeof state.input;
    // `thinking: null` clears the live preview pill; an object replaces it.
    // Use `in` so an explicit null clears, but undefined is left alone.
    if ("thinking" in patch) state.thinking = patch.thinking ?? null;
    // Manage silence timer on status transitions:
    // - Pause: clear the running timer so it doesn't fire spuriously mid-pause.
    // - Resume to listening: restart a fresh timer from zero.
    if (patch.status && patch.status !== state.status) {
      if (patch.status !== "listening") {
        if (silenceTimer) { window.clearTimeout(silenceTimer); silenceTimer = undefined; }
        state.silenceWarning = false;
      } else if (patch.status === "listening") {
        resetSilenceTimer();
      }
    }
    if (patch.status) state.status = patch.status;
    const seg = patch.latest;
    if (seg && seg.text && seg.id !== state.transcript[state.transcript.length - 1]?.id) {
      state.transcript = [...state.transcript, seg].slice(-50);
      if (seg.is_final) {
        state.lastFinalAt = Date.now();
        resetSilenceTimer();
      }
    }
    render();
  } else if (m.type === "MC_KB_ANSWER") {
    const payload = m.payload as { answer?: string; error?: string; id?: string };
    // Match the response back to the question by id. If the user already
    // moved on (cancelled it by asking another question), drop the stale
    // answer instead of overwriting the active "Thinking…" state.
    if (payload?.id) {
      const entry = state.kbThread.find((e) => e.id === payload.id);
      if (!entry) return;
      if (entry.status === "cancelled") return;
      entry.status = payload.error ? "error" : "done";
      entry.answer = payload.answer || payload.error || "No answer.";
    } else {
      // Backward-compat: id missing — apply to the most recent pending entry
      // (now at the top of the thread since newest is unshifted to index 0).
      const pending = state.kbThread.find((e) => e.status === "pending");
      if (pending) {
        pending.status = payload?.error ? "error" : "done";
        pending.answer = payload?.answer || payload?.error || "No answer.";
      }
    }
    render();
    // Latest is at the top; pin scroll there so reps see the freshest answer.
    const body = root?.querySelector<HTMLDivElement>(".cl-body");
    if (body) body.scrollTop = 0;
  }
});

function ensureStyle() {
  if (document.getElementById(`${ROOT_ID}-css`)) return;
  const style = document.createElement("style");
  style.id = `${ROOT_ID}-css`;
  style.textContent = css();
  document.head.appendChild(style);
}

function isMeetingLive(): boolean {
  // Heuristics for "call is active" rather than the landing page:
  // - Any path that looks like a meeting code: standard /abc-defg-hij OR
  //   Google Workspace persistent rooms (/lookup/myroom, /my-room-name, etc.)
  // - Presence of the bottom control bar (mic/camera/leave buttons)
  const path = location.pathname;
  // Exclude known non-meeting paths: root, /landing, /about, /new, empty.
  if (!path || path === "/" || /^\/(landing|about|new|u\/|_)\b/i.test(path)) return false;
  // Require at least one alphanumeric segment — filters out bare "/" variants.
  if (!/\/[a-z0-9]/i.test(path)) return false;
  const hasControls =
    !!document.querySelector('[aria-label*="microphone" i]') ||
    !!document.querySelector('[aria-label*="leave call" i]') ||
    !!document.querySelector('[data-meeting-code]');
  return hasControls;
}

function meetingSignature(): string {
  return `${location.pathname}@${document.title}`;
}

async function hasAutoStart(): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      chrome.storage?.local.get(AUTOSTART_KEY, (r) => resolve(Boolean(r?.[AUTOSTART_KEY])));
    });
  } catch { return false; }
}

function setAutoStart(v: boolean) {
  try { chrome.storage?.local.set({ [AUTOSTART_KEY]: v }); } catch { /* noop */ }
}

function dismissPrompt() {
  if (promptEl) { promptEl.remove(); promptEl = null; }
}

function startSession(autoStart: boolean) {
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  sessionStarted = true;
  dismissPrompt();
  const meetingTitle = document.title.replace(/^Meet[\s·\-—]*/i, "").trim() || "Untitled meeting";
  try {
    chrome.runtime.sendMessage({
      type: "MC_START_SESSION",
      payload: {
        source: "meet_auto",
        auto_started: autoStart,
        meeting_url: location.href,
        meeting_title: meetingTitle,
      },
    }).catch(() => { /* sidebar may be closed */ });
  } catch { teardownOrphan(); return; }
  mount();
  state = {
    ...state,
    status: "listening",
    startedAt: Date.now(),
    // Seed a minimal input so the panel shows the meeting title right away,
    // even when the user hasn't filled in company/persona in the sidebar yet.
    input: state.input || {
      company_name: "",
      persona_role: "",
      meeting_title: meetingTitle,
      agenda: [],
    },
  };
  resetSilenceTimer();
  startTick();
  render();
}

function showStartPrompt() {
  if (promptEl || sessionStarted) return;
  injectFonts();
  ensureStyle();
  promptEl = document.createElement("div");
  promptEl.id = PROMPT_ID;
  promptEl.innerHTML = `
    <div class="cl-p-title">Start ClientLens for this call?</div>
    <div class="cl-p-sub">Live transcription, sentiment and coach nudges. Read-only — nothing is posted anywhere.</div>
    <div class="cl-p-row">
      <button class="cl-p-btn" data-p="start">Start copilot</button>
      <button class="cl-p-btn ghost" data-p="skip">Not now</button>
    </div>
    <label class="cl-p-check">
      <input type="checkbox" data-p="remember" />
      Don't ask again on future calls
    </label>
  `;
  document.body.appendChild(promptEl);
  promptEl.querySelector<HTMLButtonElement>('[data-p="start"]')?.addEventListener("click", () => {
    const remember = promptEl?.querySelector<HTMLInputElement>('[data-p="remember"]')?.checked;
    if (remember) setAutoStart(true);
    startSession(false);
  });
  promptEl.querySelector<HTMLButtonElement>('[data-p="skip"]')?.addEventListener("click", () => {
    dismissPrompt();
  });
}

async function considerAutoLaunch() {
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  if (sessionStarted) return;
  if (!isMeetingLive()) return;
  const sig = meetingSignature();
  if (sig === lastMeetingSignature) return;
  lastMeetingSignature = sig;

  if (await hasAutoStart()) {
    startSession(true);
  } else {
    showStartPrompt();
  }
}

// Watch for the Meet call UI coming up; debounce through MutationObserver.
let debounce: number | undefined;
const observer = new MutationObserver(() => {
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  if (debounce) window.clearTimeout(debounce);
  debounce = window.setTimeout(() => { void considerAutoLaunch(); }, 500) as unknown as number;
});
observer.observe(document.body, { childList: true, subtree: true });
void considerAutoLaunch();

// Reset if the user navigates out of the call.
window.addEventListener("popstate", () => {
  if (!isExtensionAlive()) { teardownOrphan(); return; }
  if (!isMeetingLive()) {
    sessionStarted = false;
    lastMeetingSignature = "";
    if (root) { root.remove(); root = null; }
    dismissPrompt();
    try {
      chrome.runtime.sendMessage({ type: "MC_STOP_SESSION" }).catch(() => { /* noop */ });
    } catch { /* runtime gone */ }
  }
});
