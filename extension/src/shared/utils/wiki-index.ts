/**
 * Wiki index — derived view over the KB. Pure function, no storage of its
 * own; recompute on demand whenever we need:
 *   - "which entries mention concept X?" → cross-references
 *   - aggregate contradiction list → KB panel surface
 *   - orphan detection → entries whose concepts don't link to any other page
 *
 * Cheap to call: O(N × concepts/entry), no LLM. Run on every render.
 */

import type { KBEntry, WikiIndex } from "../types";

function normaliseConcept(c: string): string {
  return c.trim().toLowerCase();
}

export function computeWikiIndex(entries: KBEntry[]): WikiIndex {
  const ready = entries.filter((e) => e.wiki_page);

  // concept (normalised) → set of entry ids
  const conceptMap = new Map<string, Set<string>>();
  // tag (normalised) → count
  const tagMap = new Map<string, number>();

  for (const e of ready) {
    const page = e.wiki_page!;
    for (const c of page.concepts) {
      const key = normaliseConcept(c);
      if (!key) continue;
      let set = conceptMap.get(key);
      if (!set) { set = new Set(); conceptMap.set(key, set); }
      set.add(e.id);
    }
    for (const t of page.tags) {
      const key = t.trim().toLowerCase();
      if (!key) continue;
      tagMap.set(key, (tagMap.get(key) ?? 0) + 1);
    }
  }

  const concepts = [...conceptMap.entries()]
    .map(([name, set]) => ({ name, entry_ids: [...set] }))
    .sort((a, b) => b.entry_ids.length - a.entry_ids.length || a.name.localeCompare(b.name));

  const tags = [...tagMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Aggregate contradictions across all pages, deduped by (a, b) pair.
  const seen = new Set<string>();
  const contradictions: WikiIndex["contradictions"] = [];
  for (const e of ready) {
    for (const c of e.wiki_page!.contradictions) {
      const pair = [e.id, c.with_entry_id].sort().join("|");
      if (seen.has(pair)) continue;
      seen.add(pair);
      contradictions.push({
        entry_id: e.id,
        entry_name: e.name,
        with_entry_id: c.with_entry_id,
        with_entry_name: c.with_entry_name,
        note: c.note,
      });
    }
  }

  // Orphans = pages whose concepts don't intersect any other page's concepts.
  const orphan_entry_ids: string[] = [];
  for (const e of ready) {
    const myConcepts = new Set(e.wiki_page!.concepts.map(normaliseConcept).filter(Boolean));
    if (myConcepts.size === 0) { orphan_entry_ids.push(e.id); continue; }
    let linked = false;
    for (const c of myConcepts) {
      const set = conceptMap.get(c);
      if (set && set.size > 1) { linked = true; break; }
    }
    if (!linked) orphan_entry_ids.push(e.id);
  }

  return {
    total_pages: entries.length,
    ready_pages: ready.length,
    concepts,
    tags,
    contradictions,
    orphan_entry_ids,
  };
}

// ─── Compact map for the live coach prompt ───────────────────────────────────
//
// The full WikiIndex is too verbose to stuff into a 400-token live-coach
// prompt. This produces a tight string view: "TOC" of titles + tldrs, plus
// the top concepts with their entry counts. Coach uses this to know what
// the KB CONTAINS without reading any chunks.

export interface WikiCoachMap {
  toc: { entry_id: string; title: string; tldr: string; tags: string[] }[];
  top_concepts: { name: string; entry_count: number }[];
}

export function computeWikiCoachMap(entries: KBEntry[], limit = 30): WikiCoachMap {
  const ready = entries.filter((e) => e.wiki_page?.tldr);
  const toc = ready.slice(0, limit).map((e) => ({
    entry_id: e.id,
    title: e.wiki_page!.title,
    tldr: e.wiki_page!.tldr,
    tags: e.wiki_page!.tags.slice(0, 3),
  }));
  const idx = computeWikiIndex(entries);
  const top_concepts = idx.concepts.slice(0, 12).map((c) => ({ name: c.name, entry_count: c.entry_ids.length }));
  return { toc, top_concepts };
}
