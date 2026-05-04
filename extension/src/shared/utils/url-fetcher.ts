/**
 * Client-side URL fetcher for Knowledge Base ingestion.
 *
 * Fetches the page, strips scripts/styles/nav, and returns readable text.
 * Runs in the side-panel context, which has <all_urls> via host_permissions
 * so cross-origin fetches work without the backend.
 */

const MAX_TEXT_BYTES = 200_000; // 200KB of text — keeps localStorage healthy
const FETCH_TIMEOUT_MS = 15_000;

export interface FetchedUrlContent {
  title: string;
  text: string;
  url: string;
  fetched_at: string;
  truncated: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Request timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

function extractReadableText(html: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Strip noise.
  doc.querySelectorAll("script, style, noscript, iframe, svg, nav, header, footer, aside, form").forEach((el) => el.remove());

  // Prefer <main> or <article> if present, else fall back to <body>.
  const root =
    doc.querySelector("main") ??
    doc.querySelector("article") ??
    doc.body;

  const title = (doc.querySelector("title")?.textContent ?? "").trim() || (doc.querySelector("h1")?.textContent ?? "").trim();

  // innerText preserves visible whitespace better than textContent.
  const raw = (root as HTMLElement)?.innerText ?? root?.textContent ?? "";
  // Collapse runs of blank lines / whitespace.
  const text = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

  return { title, text };
}

export async function fetchUrlContent(url: string): Promise<FetchedUrlContent> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("URL is empty");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Not a valid URL — include https://");
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("Only http(s) URLs are supported");
  }

  const res = await withTimeout(
    fetch(trimmed, { redirect: "follow", credentials: "omit" }),
    FETCH_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let title = "";
  let text = "";

  if (contentType.includes("text/html") || contentType === "" /* assume html */) {
    const html = await res.text();
    const extracted = extractReadableText(html);
    title = extracted.title;
    text = extracted.text;
  } else if (contentType.includes("text/") || contentType.includes("application/json") || contentType.includes("application/xml")) {
    text = await res.text();
  } else {
    throw new Error(`Unsupported content-type: ${contentType}. Save as a file instead.`);
  }

  if (!text.trim()) {
    throw new Error("Page returned no readable text. Some sites block fetchers — paste the content as text instead.");
  }

  let truncated = false;
  if (text.length > MAX_TEXT_BYTES) {
    text = text.slice(0, MAX_TEXT_BYTES);
    truncated = true;
  }

  return {
    title: title || parsed.hostname,
    text,
    url: trimmed,
    fetched_at: new Date().toISOString(),
    truncated,
  };
}
