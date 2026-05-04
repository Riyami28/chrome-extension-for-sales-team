import type { KBEntry, KBNamespace, UserRole } from "../types";

const STORAGE_KEY = "clientlens_kb";

// Role → namespaces the role is allowed to write to.
// Admin can write anywhere; PMM owns brand_voice; Designer owns design_system.
const ROLE_WRITE_SCOPE: Record<UserRole, KBNamespace[] | "all"> = {
  admin: "all",
  pmm: ["brand_voice", "icp_profiles"],
  designer: ["design_system"],
  sales_rep: [],
  viewer: [],
};

export function canWriteNamespace(role: UserRole, ns: KBNamespace): boolean {
  const scope = ROLE_WRITE_SCOPE[role];
  return scope === "all" || scope.includes(ns);
}

export function allowedNamespacesFor(role: UserRole): KBNamespace[] {
  const scope = ROLE_WRITE_SCOPE[role];
  if (scope === "all") {
    return [
      "product_overview",
      "industry_pages",
      "case_studies",
      "battlecard",
      "security_compliance",
      "roi_pricing",
      "brand_voice",
      "design_system",
      "icp_profiles",
    ];
  }
  return scope;
}

async function readAll(): Promise<KBEntry[]> {
  // In non-extension contexts (vite dev) chrome.storage isn't available.
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  }
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve((result[STORAGE_KEY] as KBEntry[]) ?? []);
    });
  });
}

async function writeAll(entries: KBEntry[]): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: entries }, () => resolve());
  });
}

export async function listKB(): Promise<KBEntry[]> {
  return readAll();
}

export async function addKB(entry: KBEntry): Promise<void> {
  const all = await readAll();
  all.unshift(entry);
  await writeAll(all);
}

export async function removeKB(id: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter((e) => e.id !== id));
}

/** Patch a single entry in place. Used by the indexer to write index_status. */
export async function updateKB(id: string, patch: Partial<KBEntry>): Promise<void> {
  const all = await readAll();
  let changed = false;
  const next = all.map((e) => {
    if (e.id !== id) return e;
    changed = true;
    return { ...e, ...patch };
  });
  if (changed) await writeAll(next);
}

export function namespaceLabel(ns: KBNamespace): string {
  const labels: Record<KBNamespace, string> = {
    product_overview: "Product Overview",
    industry_pages: "Industry One-Pagers",
    case_studies: "Case Studies",
    battlecard: "Competitive Battlecard",
    security_compliance: "Security & Compliance",
    roi_pricing: "ROI & Pricing",
    brand_voice: "Brand Voice (PMM)",
    design_system: "Design System (Designer)",
    icp_profiles: "ICP Profiles",
  };
  return labels[ns];
}
