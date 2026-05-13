// Minimal Zoho CRM client. Auth via chrome.identity.launchWebAuthFlow.
// Tokens are cached in chrome.storage.local and refreshed on 401.
// Only pulls what we need for pre-call context: account, deal, contact, recent note.
//
// Security: the Zoho client_secret never touches the browser. All refresh-token
// exchanges go through the backend proxy at /api/v1/zoho/refresh which holds
// the client_id + client_secret server-side. Closes #33.

import type { CRMContext } from "../../shared/types";
import { backendUrl, backendJwt } from "../../shared/agents/llm-client";

const TOKEN_KEY = "clientlens.zoho.tokens";

interface ZohoTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms epoch
  dc: string;
}

function dc(): string {
  return import.meta.env.VITE_ZOHO_DC || "com";
}

function apiBase(): string {
  return `https://www.zohoapis.${dc()}/crm/v5`;
}

function accountsBase(): string {
  return `https://accounts.zoho.${dc()}`;
}

async function loadTokens(): Promise<ZohoTokens | null> {
  try {
    return await new Promise<ZohoTokens | null>((resolve) => {
      chrome.storage?.local.get(TOKEN_KEY, (r) => resolve((r?.[TOKEN_KEY] as ZohoTokens) || null));
    });
  } catch { return null; }
}

async function saveTokens(tokens: ZohoTokens): Promise<void> {
  try { chrome.storage?.local.set({ [TOKEN_KEY]: tokens }); } catch { /* noop */ }
}

async function clearTokens(): Promise<void> {
  try { chrome.storage?.local.remove(TOKEN_KEY); } catch { /* noop */ }
}

export async function connectZoho(): Promise<ZohoTokens> {
  const clientId = import.meta.env.VITE_ZOHO_CLIENT_ID;
  const redirectUri = import.meta.env.VITE_ZOHO_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error("Zoho OAuth env vars missing. Set VITE_ZOHO_CLIENT_ID and VITE_ZOHO_REDIRECT_URI.");
  }

  const authUrl = new URL(`${accountsBase()}/oauth/v2/auth`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", "ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.users.READ");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  const redirected = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, (redirectedUrl) => {
      if (chrome.runtime.lastError || !redirectedUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "Zoho auth cancelled"));
      } else {
        resolve(redirectedUrl);
      }
    });
  });

  const code = new URL(redirected).searchParams.get("code");
  if (!code) throw new Error("No auth code from Zoho");

  // Token exchange goes through the backend proxy so the client_secret stays
  // server-side and is never baked into the extension bundle. Closes #33.
  const proxyUrl = `${backendUrl()}/api/v1/zoho/exchange`;
  const jwt = await backendJwt();
  const tokenRes = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify({ code, redirect_uri: redirectUri, dc: dc() }),
  });
  if (!tokenRes.ok) throw new Error(`Zoho token exchange ${tokenRes.status}`);
  const body = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };

  const tokens: ZohoTokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
    dc: dc(),
  };
  await saveTokens(tokens);
  return tokens;
}

async function refresh(tokens: ZohoTokens): Promise<ZohoTokens> {
  // Proxy through the backend so the client_secret stays server-side. Closes #33.
  const jwt = await backendJwt();
  const res = await fetch(`${backendUrl()}/api/v1/zoho/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify({ refresh_token: tokens.refresh_token, dc: tokens.dc }),
  });
  if (!res.ok) {
    await clearTokens();
    throw new Error(`Zoho refresh ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  const next: ZohoTokens = {
    ...tokens,
    access_token: body.access_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
  };
  await saveTokens(next);
  return next;
}

async function currentTokens(): Promise<ZohoTokens | null> {
  let t = await loadTokens();
  if (!t) return null;
  if (Date.now() >= t.expires_at) {
    try { t = await refresh(t); } catch { return null; }
  }
  return t;
}

async function zohoGet<T>(path: string): Promise<T> {
  const t = await currentTokens();
  if (!t) throw new Error("Zoho not connected. Call connectZoho() first.");
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${t.access_token}` },
  });
  if (res.status === 401) {
    const refreshed = await refresh(t);
    const retry = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${refreshed.access_token}` },
    });
    if (!retry.ok) throw new Error(`Zoho ${retry.status}`);
    return retry.json() as Promise<T>;
  }
  if (!res.ok) throw new Error(`Zoho ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Build a ZohoTokens-shaped object from the settings-based credentials so
 * lookupContext can use the same code path regardless of how auth happened.
 * The Settings path stores a refresh token; we exchange it for an access token
 * on demand rather than caching it (it's only used for one lookup per call).
 */
async function tokensFromSettings(): Promise<ZohoTokens | null> {
  try {
    // Lazy-import settings to avoid circular deps with this file being used in BG context.
    const { getSettings } = await import("../../shared/utils/settings-storage");
    const cfg = getSettings().integrations.zoho;
    const { refreshToken, apiDomain } = cfg.fields;
    if (!refreshToken || !apiDomain) return null;

    // Derive DC from apiDomain (e.g. "https://www.zohoapis.eu/..." → "eu").
    const domainDc = (apiDomain.match(/zohoapis\.([a-z.]+)/)?.[1] || "com").replace(/\.$/, "");

    // Proxy through the backend so client_secret stays server-side. Closes #33.
    const jwt = await backendJwt();
    const res = await fetch(`${backendUrl()}/api/v1/zoho/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
      body: JSON.stringify({ refresh_token: refreshToken, dc: domainDc }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) return null;

    return {
      access_token: body.access_token,
      refresh_token: refreshToken,
      expires_at: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
      dc: domainDc,
    };
  } catch { return null; }
}

export async function lookupContext(opts: { attendeeEmails?: string[]; companyName?: string }): Promise<CRMContext> {
  const ctx: CRMContext = { provider: "zoho" };
  // Try OAuth tokens first (chrome.identity flow), then fall back to
  // settings-based credentials (manual client_id/secret/refresh_token entry).
  // This lets either connection path work for the pre-call CRM pull.
  let tokens = await loadTokens();
  if (!tokens) tokens = await tokensFromSettings();
  if (!tokens) return { provider: "none" };

  try {
    if (opts.attendeeEmails?.length) {
      const email = opts.attendeeEmails.find((e) => !/@(gmail|googlemail|outlook|hotmail)\.com$/i.test(e));
      if (email) {
        const q = encodeURIComponent(`(Email:equals:${email})`);
        const contacts = await zohoGet<{ data?: { id: string; Account_Name?: { name: string; id: string } }[] }>(
          `/Contacts/search?criteria=${q}`,
        ).catch(() => ({ data: [] }));
        if (contacts.data?.length) {
          const c = contacts.data[0];
          ctx.contact_ids = [c.id];
          if (c.Account_Name) {
            ctx.account_id = c.Account_Name.id;
            ctx.account_name = c.Account_Name.name;
          }
        }
      }
    }

    if (!ctx.account_id && opts.companyName) {
      const q = encodeURIComponent(`(Account_Name:equals:${opts.companyName})`);
      const accounts = await zohoGet<{ data?: { id: string; Account_Name?: string }[] }>(
        `/Accounts/search?criteria=${q}`,
      ).catch(() => ({ data: [] }));
      if (accounts.data?.length) {
        ctx.account_id = accounts.data[0].id;
        ctx.account_name = accounts.data[0].Account_Name;
      }
    }

    if (ctx.account_id) {
      // Use dot notation to search by the related account's ID.
      // Plain `Account_Name:equals:{id}` searches the display name string,
      // not the foreign key — it would always return zero results.
      const q = encodeURIComponent(`(Account_Name.id:equals:${ctx.account_id})`);
      const deals = await zohoGet<{ data?: { id: string; Deal_Name: string; Stage?: string; Amount?: number }[] }>(
        `/Deals/search?criteria=${q}`,
      ).catch(() => ({ data: [] }));
      if (deals.data?.length) {
        const d = deals.data[0];
        ctx.deal_id = d.id;
        ctx.deal_name = d.Deal_Name;
        ctx.deal_stage = d.Stage;
        ctx.deal_amount = d.Amount;
        ctx.notes_url = `https://crm.zoho.${dc()}/crm/EntityInfo.do?module=Potentials&id=${d.id}`;
      }
    }

    if (ctx.deal_id) {
      const notes = await zohoGet<{ data?: { Note_Content?: string }[] }>(
        `/Deals/${ctx.deal_id}/Notes?per_page=1&sort_by=Created_Time&sort_order=desc`,
      ).catch(() => ({ data: [] }));
      if (notes.data?.length) ctx.last_note_preview = notes.data[0].Note_Content?.slice(0, 280);
    }
  } catch (err) {
    console.warn("[zoho] lookup failed", err);
  }
  return ctx;
}

export async function logCallNote(opts: { dealId?: string; accountId?: string; title: string; content: string }): Promise<boolean> {
  const t = await currentTokens();
  if (!t) return false;
  const parentId = opts.dealId || opts.accountId;
  const parentModule = opts.dealId ? "Deals" : "Accounts";
  if (!parentId) return false;

  const res = await fetch(`${apiBase()}/Notes`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${t.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: [{
        Note_Title: opts.title,
        Note_Content: opts.content,
        Parent_Id: parentId,
        se_module: parentModule,
      }],
    }),
  });
  return res.ok;
}

export async function isZohoConnected(): Promise<boolean> {
  return Boolean(await loadTokens());
}
