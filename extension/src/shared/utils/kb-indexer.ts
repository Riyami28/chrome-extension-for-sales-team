/**
 * KB indexer — turns a raw KBEntry into chunks + embeddings stored in
 * IndexedDB. Single-flight queue ensures we don't fan out 50 concurrent
 * embed calls during a "Re-index all" backfill and trip Gemini RPM limits.
 *
 * The indexer never touches the LLM; it only embeds. Wiki/summary
 * transformation was deliberately skipped — pure semantic retrieval.
 */

import type { KBEntry, KBChunk } from "../types";
import { semanticChunk } from "./chunker";
import { embedTexts } from "../agents/llm-client";
import { listKB, updateKB } from "./kb-storage";
import { putEntryChunks, deleteEntryChunks } from "./kb-vector-store";
import { buildWikiPage, lintWiki } from "./wiki-builder";

interface QueueItem {
  entryId: string;
  resolve: (ok: boolean) => void;
}

const queue: QueueItem[] = [];
let running = false;

// Listeners notified on every status change so the KB panel can re-render
// without prop-drilling. Set-of-functions; cleared as panels unmount.
type Listener = (entryId: string) => void;
const listeners = new Set<Listener>();

export function onIndexProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(entryId: string): void {
  for (const fn of listeners) {
    try { fn(entryId); } catch { /* listener errors must not abort the queue */ }
  }
}

/**
 * Queue an entry for indexing. Resolves once the entry has either succeeded
 * or failed. Safe to call multiple times for the same entryId; later calls
 * coalesce onto the in-flight job.
 */
export function indexEntry(entryId: string): Promise<boolean> {
  // Coalesce — if we already have a queued job for this id, ride along.
  const existing = queue.find((q) => q.entryId === entryId);
  if (existing) {
    return new Promise((resolve) => {
      const orig = existing.resolve;
      existing.resolve = (ok) => { orig(ok); resolve(ok); };
    });
  }
  return new Promise((resolve) => {
    queue.push({ entryId, resolve });
    void runQueue();
  });
}

/** Re-index every entry that isn't currently `ready`. Returns count queued. */
export async function reindexAll(): Promise<number> {
  const entries = await listKB();
  let queued = 0;
  for (const e of entries) {
    if (e.index_status === "ready") continue;
    void indexEntry(e.id);
    queued++;
  }
  return queued;
}

/** Force re-index every entry, including ones already marked ready. */
export async function reindexEverything(): Promise<number> {
  const entries = await listKB();
  for (const e of entries) {
    void indexEntry(e.id);
  }
  return entries.length;
}

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const ok = await runOne(item.entryId);
      try { item.resolve(ok); } catch { /* ignore */ }
    }
  } finally {
    running = false;
  }
}

async function runOne(entryId: string): Promise<boolean> {
  const entries = await listKB();
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) return false;

  if (!entry.content || !entry.content.trim()) {
    // Nothing to embed — mark ready with zero chunks. Ask KB will fall back
    // to lexical for this entry, which already handles empty content.
    await updateKB(entryId, {
      index_status: "ready",
      index_chunk_count: 0,
      indexed_at: new Date().toISOString(),
      index_error: undefined,
    });
    notify(entryId);
    return true;
  }

  await updateKB(entryId, { index_status: "indexing", index_error: undefined });
  notify(entryId);

  let embedOk = false;
  try {
    const rawChunks = semanticChunk(entry.content);
    const texts = rawChunks.map((c) => c.text);
    const vectors = await embedTexts(texts);
    if (vectors.length !== texts.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${texts.length} chunks`);
    }
    const chunks: KBChunk[] = texts.map((text, i) => ({ text, embedding: vectors[i] }));

    await putEntryChunks({
      entryId,
      namespace: entry.namespace,
      name: entry.name,
      chunks,
      updated_at: new Date().toISOString(),
    });

    await updateKB(entryId, {
      index_status: "ready",
      index_chunk_count: chunks.length,
      indexed_at: new Date().toISOString(),
      index_error: undefined,
    });
    notify(entryId);
    embedOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateKB(entryId, { index_status: "failed", index_error: msg.slice(0, 300) });
    notify(entryId);
    // Don't return — wiki build is independent and may still succeed even
    // when embedding is broken (different provider/key).
  }

  // ── Wiki ingest pass ──────────────────────────────────────────────────────
  // Re-read the latest entry list so contradiction detection sees any pages
  // built since this run started. Other entries' wiki_pages are the input;
  // our own previous wiki_page is replaced wholesale.
  await updateKB(entryId, { wiki_status: "building", wiki_error: undefined });
  notify(entryId);
  try {
    const fresh = await listKB();
    const target = fresh.find((e) => e.id === entryId) ?? entry;
    const others = fresh.filter((e) => e.id !== entryId);
    const wiki = await buildWikiPage(target, others);
    await updateKB(entryId, {
      wiki_status: "ready",
      wiki_page: wiki,
      wiki_error: undefined,
    });
    notify(entryId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateKB(entryId, { wiki_status: "failed", wiki_error: msg.slice(0, 300) });
    notify(entryId);
    return embedOk; // wiki failure alone doesn't fail the whole run
  }

  return true;
}

/** Drop chunk store entries for a removed KBEntry. Best-effort. */
export async function dropEntryFromIndex(entryId: string): Promise<void> {
  try { await deleteEntryChunks(entryId); } catch { /* ignore */ }
}

/**
 * Run the global wiki lint pass — re-checks every page for contradictions
 * with every other page. One LLM call regardless of KB size. Writes the
 * refreshed contradiction list back onto each entry's wiki_page.
 */
export async function runWikiLint(): Promise<{ checked: number; flagged: number }> {
  const entries = await listKB();
  const updates = await lintWiki(entries);
  let flagged = 0;
  for (const [entryId, contradictions] of updates) {
    const target = entries.find((e) => e.id === entryId);
    if (!target?.wiki_page) continue;
    const next = { ...target.wiki_page, contradictions };
    await updateKB(entryId, { wiki_page: next });
    if (contradictions.length > 0) flagged += contradictions.length;
    notify(entryId);
  }
  return { checked: updates.size, flagged };
}
