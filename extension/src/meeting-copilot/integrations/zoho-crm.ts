// Minimal Zoho CRM client. Auth via chrome.identity.launchWebAuthFlow.
// Tokens are cached in chrome.storage.local and refreshed on 401.
// Only pulls what we need for pre-call context: account, deal, contact, recent note.

import type { CRMContext } from "../../shared/types";

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
  const clientSecret = import.meta.env.VITE_ZOHO_CLIENT_SECRET;
  const redirectUri = import.meta.env.VITE_ZOHO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Zoho OAuth env vars missing. Set VITE_ZOHO_CLIENT_ID / _SECRET / _REDIRECT_URI.");
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

  const tokenRes = await fetch(`${accountsBase()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }).toString(),
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
  const clientId = import.meta.env.VITE_ZOHO_CLIENT_ID!;
  const clientSecret = import.meta.env.VITE_ZOHO_CLIENT_SECRET!;
  const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
    }).toString(),
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

export async function lookupContext(opts: { attendeeEmails?: string[]; companyName?: string }): Promise<CRMContext> {
  const ctx: CRMContext = { provider: "zoho" };
  const tokens = await loadTokens();
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
      const deals = await zohoGet<{ data?: { id: string; Deal_Name: string; Stage?: string; Amount?: number }[] }>(
        `/Deals/search?criteria=(Account_Name:equals:${ctx.account_id})`,
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
