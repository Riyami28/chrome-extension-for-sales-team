/**
 * Semantic chunker — splits raw KB text on paragraph → sentence → word
 * boundaries with a small overlap between chunks. Each chunk is a coherent
 * thought of bounded size, suitable for embedding and cosine retrieval.
 *
 * Ported from content-engine `engine/sync/chunker.ts`. Defaults tuned for
 * Groq Llama-3.3 context: ~400 tokens with 50-token (≈12.5%) overlap.
 */

export interface RawChunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
}

interface ChunkOptions {
  maxTokens?: number;
  overlapPercent?: number;
}

const ABBREVIATIONS = new Set([
  "Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "St",
  "Ave", "Blvd", "Dept", "Est", "Fig", "Gen", "Gov",
  "Inc", "Ltd", "Corp", "Vol", "vs", "etc", "approx",
  "i.e", "e.g", "cf", "al", "no", "Jan", "Feb", "Mar",
  "Apr", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]);

/** Rough token estimate: words × 1.3. Good enough for chunk-size budgeting. */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/** Split text into sentences, respecting common abbreviations and initials. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";

  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    current += chars[i];
    if (chars[i] === "." || chars[i] === "?" || chars[i] === "!") {
      if (chars[i] === ".") {
        const before = current.slice(0, -1).trimEnd();
        const lastWord = before.split(/\s/).pop() ?? "";
        const clean = lastWord.replace(/^[("']+/, "").replace(/\.+$/, "");
        if (ABBREVIATIONS.has(clean)) continue;
        if (/^[A-Z]$/.test(clean)) continue; // initials like "J."
      }
      const next = i + 1 < chars.length ? chars[i + 1] : undefined;
      if (next === undefined || /\s/.test(next)) {
        sentences.push(current.trim());
        current = "";
      }
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences.filter(Boolean);
}

function splitOnWords(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const segments: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    if (estimateTokens(current.join(" ")) > maxTokens) {
      if (current.length === 1) {
        segments.push(current.join(" "));
        current = [];
      } else {
        current.pop();
        segments.push(current.join(" "));
        current = [word];
      }
    }
  }
  if (current.length > 0) segments.push(current.join(" "));
  return segments;
}

function splitToSegments(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    const segments: string[] = [];
    let current: string[] = [];
    for (const sentence of sentences) {
      current.push(sentence);
      if (estimateTokens(current.join(" ")) > maxTokens) {
        if (current.length === 1) {
          segments.push(...splitOnWords(sentence, maxTokens));
          current = [];
        } else {
          current.pop();
          segments.push(current.join(" "));
          current = [sentence];
        }
      }
    }
    if (current.length > 0) {
      const joined = current.join(" ");
      if (estimateTokens(joined) > maxTokens) {
        segments.push(...splitOnWords(joined, maxTokens));
      } else {
        segments.push(joined);
      }
    }
    return segments;
  }

  return splitOnWords(text, maxTokens);
}

/**
 * Split text into chunks under maxTokens, walking paragraph → sentence → word
 * boundaries and prepending a small slice of the previous chunk for context.
 */
export function semanticChunk(text: string, options?: ChunkOptions): RawChunk[] {
  const maxTokens = options?.maxTokens ?? 400;
  const overlapPercent = options?.overlapPercent ?? 12;

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());

  const rawSegments: string[] = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (estimateTokens(trimmed) <= maxTokens) {
      rawSegments.push(trimmed);
    } else {
      rawSegments.push(...splitToSegments(trimmed, maxTokens));
    }
  }

  // Merge small adjacent segments greedily so we don't end up with dozens of
  // 1-sentence chunks for short bullet-list KB entries.
  const merged: string[] = [];
  let buffer = "";
  for (const seg of rawSegments) {
    if (!buffer) { buffer = seg; continue; }
    const combined = buffer + "\n\n" + seg;
    if (estimateTokens(combined) <= maxTokens) {
      buffer = combined;
    } else {
      merged.push(buffer);
      buffer = seg;
    }
  }
  if (buffer) merged.push(buffer);

  const chunks: RawChunk[] = [];
  let charOffset = 0;

  for (let i = 0; i < merged.length; i++) {
    let chunkText = merged[i];

    if (i > 0 && overlapPercent > 0) {
      const prevText = merged[i - 1];
      const overlapChars = Math.floor(prevText.length * (overlapPercent / 100));
      if (overlapChars > 0) {
        const overlap = prevText.slice(-overlapChars);
        chunkText = overlap + " " + chunkText;
      }
    }

    const coreText = merged[i];
    const startChar = text.indexOf(coreText, charOffset);
    const resolvedStart = startChar >= 0 ? startChar : charOffset;
    const endChar = resolvedStart + coreText.length;

    chunks.push({ text: chunkText, index: i, startChar: resolvedStart, endChar });
    charOffset = resolvedStart + coreText.length;
  }

  return chunks;
}
