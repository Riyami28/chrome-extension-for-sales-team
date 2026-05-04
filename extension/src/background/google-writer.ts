/**
 * Google Slides / Docs API writer — runs in the service worker, which is
 * where chrome.identity + stored OAuth tokens live.
 *
 * Strategy: preserve the master deck's design. Replace text in existing
 * slides in-order (title + body). Append new slides only if the generated
 * deck is longer than the open deck.
 *
 * Undo: we snapshot the pre-write text and keep it in chrome.storage.session.
 */

import type { SlideContent } from "../shared/types";

const SLIDES_API = "https://slides.googleapis.com/v1/presentations";
const DOCS_API = "https://docs.googleapis.com/v1/documents";

export interface WriteResult {
  success: boolean;
  slides_written?: number;
  snapshot_id?: string;
  error?: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getToken(interactive = true): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome.identity?.getAuthToken) {
      reject(new Error("chrome.identity unavailable — set oauth2.client_id in manifest"));
      return;
    }
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "OAuth failed"));
        return;
      }
      if (!token) {
        reject(new Error("No OAuth token"));
        return;
      }
      resolve(typeof token === "string" ? token : (token as { token: string }).token);
    });
  });
}

async function gFetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// ─── ID extraction ────────────────────────────────────────────────────────────

export function parseDocIdFromUrl(url: string): { type: "slides" | "docs" | null; id: string | null } {
  const slides = url.match(/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (slides) return { type: "slides", id: slides[1] };
  const docs = url.match(/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docs) return { type: "docs", id: docs[1] };
  return { type: null, id: null };
}

// ─── Slides writer ────────────────────────────────────────────────────────────

interface SlidesPresentation {
  presentationId: string;
  slides: {
    objectId: string;
    pageElements?: {
      objectId: string;
      shape?: {
        placeholder?: { type: string };
        text?: { textElements?: { textRun?: { content: string } }[] };
      };
    }[];
  }[];
}

function stringifySlide(slide: SlideContent): { title: string; body: string } {
  const bodyParts = slide.components.map((c) =>
    typeof c.content === "string" ? c.content : JSON.stringify(c.content, null, 2),
  );
  return { title: slide.title, body: bodyParts.join("\n\n") };
}

async function writeSlides(
  presentationId: string,
  generated: SlideContent[],
  token: string,
): Promise<WriteResult> {
  const pres = await gFetch<SlidesPresentation>(`${SLIDES_API}/${presentationId}?fields=slides(objectId,pageElements(objectId,shape(placeholder(type),text(textElements(textRun(content))))))`, token);

  const snapshot: { slideId: string; shapeId: string; text: string }[] = [];
  const requests: unknown[] = [];

  const existingSlides = pres.slides ?? [];
  const existingCount = existingSlides.length;
  const genCount = generated.length;
  const slotCount = Math.min(existingCount, genCount);

  // Pass 1: rewrite existing slides in-order
  for (let i = 0; i < slotCount; i++) {
    const slide = existingSlides[i];
    const { title, body } = stringifySlide(generated[i]);

    const titleShape = slide.pageElements?.find(
      (e) => e.shape?.placeholder?.type === "TITLE" || e.shape?.placeholder?.type === "CENTERED_TITLE",
    );
    const bodyShape = slide.pageElements?.find((e) => e.shape?.placeholder?.type === "BODY");

    if (titleShape) {
      const existing =
        titleShape.shape?.text?.textElements
          ?.map((t) => t.textRun?.content ?? "")
          .join("") ?? "";
      snapshot.push({ slideId: slide.objectId, shapeId: titleShape.objectId, text: existing });
      requests.push({ deleteText: { objectId: titleShape.objectId, textRange: { type: "ALL" } } });
      requests.push({ insertText: { objectId: titleShape.objectId, text: title, insertionIndex: 0 } });
    }

    if (bodyShape) {
      const existing =
        bodyShape.shape?.text?.textElements
          ?.map((t) => t.textRun?.content ?? "")
          .join("") ?? "";
      snapshot.push({ slideId: slide.objectId, shapeId: bodyShape.objectId, text: existing });
      requests.push({ deleteText: { objectId: bodyShape.objectId, textRange: { type: "ALL" } } });
      requests.push({ insertText: { objectId: bodyShape.objectId, text: body, insertionIndex: 0 } });
    }
  }

  // Pass 2: if generated has extras, append new slides with title+body layout
  if (genCount > existingCount) {
    for (let i = existingCount; i < genCount; i++) {
      const slide = generated[i];
      const slideId = `zn_${Date.now()}_${i}`;
      const titleId = `${slideId}_title`;
      const bodyId = `${slideId}_body`;
      const { title, body } = stringifySlide(slide);
      requests.push({
        createSlide: {
          objectId: slideId,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: "TITLE" }, objectId: titleId },
            { layoutPlaceholder: { type: "BODY" }, objectId: bodyId },
          ],
        },
      });
      requests.push({ insertText: { objectId: titleId, text: title, insertionIndex: 0 } });
      requests.push({ insertText: { objectId: bodyId, text: body, insertionIndex: 0 } });
    }
  }

  if (!requests.length) {
    return { success: false, error: "No matching placeholders found in master deck" };
  }

  await gFetch<{ replies: unknown[] }>(`${SLIDES_API}/${presentationId}:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });

  const snapshotId = `snap-${presentationId}-${Date.now()}`;
  await chrome.storage.local.set({
    [snapshotId]: { type: "slides", docId: presentationId, snapshot, created_at: Date.now() },
  });

  return { success: true, slides_written: genCount, snapshot_id: snapshotId };
}

// ─── Docs writer ──────────────────────────────────────────────────────────────

interface DocsDocument {
  documentId: string;
  body: { content: { endIndex?: number }[] };
}

async function writeDocs(
  documentId: string,
  generated: SlideContent[],
  token: string,
): Promise<WriteResult> {
  const doc = await gFetch<DocsDocument>(`${DOCS_API}/${documentId}`, token);

  const endIndex = (doc.body.content[doc.body.content.length - 1]?.endIndex ?? 1) - 1;

  const text =
    "\n\n" +
    generated
      .map((s, i) => {
        const body = s.components
          .map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c.content, null, 2)))
          .join("\n\n");
        return `${i + 1}. ${s.title}\n${"─".repeat(40)}\n${body}`;
      })
      .join("\n\n");

  await gFetch<{ replies: unknown[] }>(`${DOCS_API}/${documentId}:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: endIndex }, text } }],
    }),
  });

  const snapshotId = `snap-${documentId}-${Date.now()}`;
  await chrome.storage.local.set({
    [snapshotId]: {
      type: "docs",
      docId: documentId,
      insertedAt: endIndex,
      length: text.length,
      created_at: Date.now(),
    },
  });

  return { success: true, slides_written: generated.length, snapshot_id: snapshotId };
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

export async function undoWrite(snapshotId: string): Promise<WriteResult> {
  const data = await chrome.storage.local.get(snapshotId);
  const snap = data[snapshotId];
  if (!snap) return { success: false, error: "Snapshot not found" };

  const token = await getToken(false);

  if (snap.type === "slides") {
    const requests: unknown[] = [];
    for (const entry of snap.snapshot as { shapeId: string; text: string }[]) {
      requests.push({ deleteText: { objectId: entry.shapeId, textRange: { type: "ALL" } } });
      requests.push({ insertText: { objectId: entry.shapeId, text: entry.text, insertionIndex: 0 } });
    }
    await gFetch<{ replies: unknown[] }>(`${SLIDES_API}/${snap.docId}:batchUpdate`, token, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  } else if (snap.type === "docs") {
    await gFetch<{ replies: unknown[] }>(`${DOCS_API}/${snap.docId}:batchUpdate`, token, {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            deleteContentRange: {
              range: { startIndex: snap.insertedAt, endIndex: snap.insertedAt + snap.length },
            },
          },
        ],
      }),
    });
  }

  await chrome.storage.local.remove(snapshotId);
  return { success: true };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function writeToDoc(params: {
  url: string;
  slides: SlideContent[];
}): Promise<WriteResult> {
  const { type, id } = parseDocIdFromUrl(params.url);
  if (!type || !id) {
    return { success: false, error: "Active tab is not a Google Slides or Docs document" };
  }
  if (!params.slides.length) {
    return { success: false, error: "No slides to write" };
  }

  try {
    const token = await getToken(true);
    if (type === "slides") return writeSlides(id, params.slides, token);
    return writeDocs(id, params.slides, token);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
