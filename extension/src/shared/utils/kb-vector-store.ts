/**
 * IndexedDB-backed store for KB chunk embeddings. We don't keep these on the
 * KBEntry itself because chrome.storage.local has a 10MB cap and a few hundred
 * chunks of 768-dim Float32 vectors can blow past that.
 *
 * Schema: one object store "chunks", keyed by entry id. Value is a record:
 *   { entryId, namespace, name, chunks: [{ text, embedding }], updated_at }
 *
 * Embeddings are stored as Float32Array (4 bytes/dim) — half the size of
 * plain number[]. Search reconstructs them on read.
 */

import type { KBChunk, KBNamespace } from "../types";

const DB_NAME = "clientlens_kb_vectors_v1";
const STORE_NAME = "chunks";
const DB_VERSION = 1;

export interface StoredEntryChunks {
  entryId: string;
  namespace: KBNamespace;
  name: string;
  chunks: KBChunk[];
  updated_at: string;
}

interface StoredEntryChunksRaw {
  entryId: string;
  namespace: KBNamespace;
  name: string;
  chunks: { text: string; embedding: Float32Array }[];
  updated_at: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "entryId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function toFloat32(chunks: KBChunk[]): { text: string; embedding: Float32Array }[] {
  return chunks.map((c) => ({ text: c.text, embedding: Float32Array.from(c.embedding) }));
}

function fromFloat32(chunks: { text: string; embedding: Float32Array }[]): KBChunk[] {
  return chunks.map((c) => ({ text: c.text, embedding: Array.from(c.embedding) }));
}

export async function putEntryChunks(record: StoredEntryChunks): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const raw: StoredEntryChunksRaw = {
      entryId: record.entryId,
      namespace: record.namespace,
      name: record.name,
      chunks: toFloat32(record.chunks),
      updated_at: record.updated_at,
    };
    const req = store.put(raw);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("put failed"));
  });
}

export async function getEntryChunks(entryId: string): Promise<StoredEntryChunks | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(entryId);
    req.onsuccess = () => {
      const raw = req.result as StoredEntryChunksRaw | undefined;
      if (!raw) { resolve(null); return; }
      resolve({
        entryId: raw.entryId,
        namespace: raw.namespace,
        name: raw.name,
        chunks: fromFloat32(raw.chunks),
        updated_at: raw.updated_at,
      });
    };
    req.onerror = () => reject(req.error ?? new Error("get failed"));
  });
}

export async function getAllEntryChunks(): Promise<StoredEntryChunks[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const raws = (req.result as StoredEntryChunksRaw[]) ?? [];
      resolve(raws.map((raw) => ({
        entryId: raw.entryId,
        namespace: raw.namespace,
        name: raw.name,
        chunks: fromFloat32(raw.chunks),
        updated_at: raw.updated_at,
      })));
    };
    req.onerror = () => reject(req.error ?? new Error("getAll failed"));
  });
}

export async function deleteEntryChunks(entryId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(entryId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
  });
}

export async function clearAllChunks(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("clear failed"));
  });
}

// ─── Cosine search ───────────────────────────────────────────────────────────
//
// Brute-force cosine across all chunks. At our scale (200 entries × ~5 chunks
// × 768 dims) this runs in a few ms in the browser. No ANN index needed.

function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SearchHit {
  entryId: string;
  entryName: string;
  namespace: KBNamespace;
  text: string;
  score: number;
}

/**
 * Search across all stored chunks. Optional `entryIds` restricts the search to
 * a subset (useful when a downstream agent only cares about a namespace).
 */
export async function searchChunks(
  queryEmbedding: number[],
  topK: number,
  entryIds?: string[],
): Promise<SearchHit[]> {
  const all = await getAllEntryChunks();
  const filtered = entryIds ? all.filter((r) => entryIds.includes(r.entryId)) : all;

  const hits: SearchHit[] = [];
  for (const record of filtered) {
    for (const chunk of record.chunks) {
      const score = cosine(queryEmbedding, chunk.embedding);
      hits.push({
        entryId: record.entryId,
        entryName: record.name,
        namespace: record.namespace,
        text: chunk.text,
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
