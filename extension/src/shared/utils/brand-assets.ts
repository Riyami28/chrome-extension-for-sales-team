import type { BrandAssets } from "../types";

/**
 * Brand assets resolver.
 *
 * Auto path: infer domain → try logo sources in order (Clearbit → Google s2 →
 * DuckDuckGo) → fetch as data URL (so canvas isn't tainted) → extract dominant
 * color via pixel sampling.
 *
 * Manual path: caller can pass `domainOverride`, or upload a logo + pick color
 * via buildUploadedAssets. Manual color always wins over extracted color.
 */

function inferDomain(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/\b(inc|corp|corporation|ltd|limited|llc|plc|ag|gmbh|co|company)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
  return `${slug}.com`;
}

const FALLBACK_COLORS = [
  "#0891b2", "#7c3aed", "#059669", "#dc2626", "#d97706",
  "#2563eb", "#db2777", "#0d9488", "#ea580c", "#4f46e5",
];
function fallbackColor(name: string): string {
  const idx = (name.charCodeAt(0) || 65) % FALLBACK_COLORS.length;
  return FALLBACK_COLORS[idx];
}

function logoSources(domain: string): string[] {
  return [
    `https://logo.clearbit.com/${domain}`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 100) return null; // tiny = likely a 1x1 placeholder
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Sample pixels from a logo image and pick the dominant non-white/non-black
 * non-grey color. Quantizes to 4-bit-per-channel buckets to coalesce near-
 * identical shades, then picks the most populated bucket weighted by saturation.
 */
async function extractDominantColor(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 64;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        const buckets = new Map<string, { r: number; g: number; b: number; weight: number }>();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 200) continue;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max < 25) continue; // near-black
          if (min > 235) continue; // near-white
          const sat = max === 0 ? 0 : (max - min) / max;
          if (sat < 0.18) continue; // grey
          const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
          const cur = buckets.get(key) ?? { r: 0, g: 0, b: 0, weight: 0 };
          const w = sat * sat;
          cur.r += r * w; cur.g += g * w; cur.b += b * w; cur.weight += w;
          buckets.set(key, cur);
        }

        if (buckets.size === 0) return resolve(null);
        let best: { r: number; g: number; b: number; weight: number } | null = null;
        for (const v of buckets.values()) {
          if (!best || v.weight > best.weight) best = v;
        }
        if (!best || best.weight === 0) return resolve(null);
        const r = Math.round(best.r / best.weight);
        const g = Math.round(best.g / best.weight);
        const b = Math.round(best.b / best.weight);
        const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
        resolve(hex);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export interface FetchOptions {
  domainOverride?: string;
}

export async function fetchBrandAssets(
  companyName: string,
  opts: FetchOptions = {},
): Promise<BrandAssets> {
  const domain = opts.domainOverride?.trim() || inferDomain(companyName);

  let logoDataUrl: string | null = null;
  for (const src of logoSources(domain)) {
    logoDataUrl = await fetchAsDataUrl(src);
    if (logoDataUrl) break;
  }

  let primaryColor = fallbackColor(companyName);
  if (logoDataUrl) {
    const extracted = await extractDominantColor(logoDataUrl);
    if (extracted) primaryColor = extracted;
  }

  return {
    company_name: companyName,
    domain,
    logo_url: logoDataUrl ?? undefined,
    logo_source: logoDataUrl ? "web" : "placeholder",
    primary_color: primaryColor,
    descriptor: undefined,
  };
}

export async function buildUploadedAssets(
  companyName: string,
  logoDataUrl: string,
  primaryColor?: string,
): Promise<BrandAssets> {
  let color = primaryColor;
  if (!color) {
    const extracted = await extractDominantColor(logoDataUrl);
    color = extracted ?? fallbackColor(companyName);
  }
  return {
    company_name: companyName,
    logo_url: logoDataUrl,
    logo_source: "uploaded",
    primary_color: color,
  };
}
