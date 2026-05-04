// Content script: runs inside Google Slides/Docs/Notion pages
// Handles insertion of AI-generated content into the active document

import type { SlideContent } from "../shared/types";

// Listen for insert events dispatched by the background worker
window.addEventListener("CLIENTLENS_INSERT", (event: Event) => {
  const customEvent = event as CustomEvent;
  const payload = customEvent.detail as {
    action: string;
    slides?: SlideContent[];
    text?: string;
    target_slide_index?: number;
  };

  const url = window.location.href;

  if (url.includes("docs.google.com/presentation")) {
    handleSlidesInsert(payload);
  } else if (url.includes("docs.google.com/document")) {
    handleDocsInsert(payload);
  } else if (url.includes("notion.so")) {
    handleNotionInsert(payload);
  }
});

function handleSlidesInsert(payload: { action: string; slides?: SlideContent[]; text?: string }) {
  // Google Slides uses a canvas-based renderer.
  // We trigger the native "add slide" flow and paste structured text into speaker notes
  // for the user to apply. For full programmatic control, the backend uses Google Slides API.
  if (payload.action === "add_slide" && payload.slides?.length) {
    const slide = payload.slides[0];
    showInsertOverlay({
      title: slide.title,
      content: slide.components.map((c) => {
        if (typeof c.content === "string") return c.content;
        return JSON.stringify(c.content);
      }).join("\n\n"),
      type: "slide",
    });
  }
}

function handleDocsInsert(payload: { text?: string }) {
  if (!payload.text) return;

  // Focus the document editor and insert text at cursor
  const editor = document.querySelector<HTMLElement>(".kix-appview-editor");
  if (!editor) return;
  editor.focus();

  // Use execCommand for compatibility (Google Docs intercepts clipboard)
  document.execCommand("insertText", false, payload.text);
}

function handleNotionInsert(payload: { text?: string }) {
  if (!payload.text) return;

  const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
  if (!editor) return;
  editor.focus();

  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(payload.text));
  }
}

// Floating overlay to show generated content for user review before inserting
function showInsertOverlay(content: { title: string; content: string; type: string }) {
  const existing = document.getElementById("clientlens-insert-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "clientlens-insert-overlay";
  overlay.style.cssText = `
    position: fixed; top: 80px; right: 20px; z-index: 999999;
    width: 360px; background: #1a1a2e; color: #e2e8f0;
    border: 1px solid #7c3aed; border-radius: 12px;
    padding: 16px; font-family: -apple-system, sans-serif;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  `;

  // Build DOM nodes instead of innerHTML to prevent XSS from LLM-generated content
  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;";
  const headerLabel = document.createElement("span");
  headerLabel.style.cssText = "font-weight:600;color:#a78bfa;";
  headerLabel.textContent = "ClientLens — Generated Content";
  const closeBtn = document.createElement("button");
  closeBtn.id = "zn-close";
  closeBtn.style.cssText = "background:none;border:none;color:#94a3b8;cursor:pointer;font-size:18px;";
  closeBtn.textContent = "✕";
  header.append(headerLabel, closeBtn);

  const titleEl = document.createElement("div");
  titleEl.style.cssText = "font-size:13px;font-weight:600;color:#c4b5fd;margin-bottom:8px;";
  titleEl.textContent = content.title;

  const bodyEl = document.createElement("div");
  bodyEl.style.cssText = "font-size:12px;color:#cbd5e1;line-height:1.6;max-height:200px;overflow-y:auto;white-space:pre-wrap;background:#0f0f23;padding:10px;border-radius:8px;";
  bodyEl.textContent = content.content;

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;margin-top:12px;";
  const copyBtn = document.createElement("button");
  copyBtn.id = "zn-copy";
  copyBtn.style.cssText = "flex:1;padding:8px;background:#7c3aed;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;";
  copyBtn.textContent = "Copy";
  const dismissBtn = document.createElement("button");
  dismissBtn.id = "zn-dismiss";
  dismissBtn.style.cssText = "flex:1;padding:8px;background:#374151;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;font-size:12px;";
  dismissBtn.textContent = "Dismiss";
  actions.append(copyBtn, dismissBtn);

  overlay.append(header, titleEl, bodyEl, actions);
  document.body.appendChild(overlay);

  document.getElementById("zn-close")?.addEventListener("click", () => overlay.remove());
  document.getElementById("zn-dismiss")?.addEventListener("click", () => overlay.remove());
  document.getElementById("zn-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(`${content.title}\n\n${content.content}`);
    const btn = document.getElementById("zn-copy");
    if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 2000); }
  });
}
