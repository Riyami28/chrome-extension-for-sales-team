/**
 * Thin client helpers for the four integrations surfaced in Settings.
 * Everything is manual + credential-based — no OAuth dance handled here.
 *
 * Each helper pings a read endpoint to validate credentials ("Test connection")
 * or hits a write endpoint ("Push note"). Errors bubble up so the caller can
 * render a clear success/fail pill.
 */

import type { IntegrationConfig } from "./settings-storage";

export interface TestResult {
  ok: boolean;
  detail: string;
}

// ─── Zoho CRM ─────────────────────────────────────────────────────────────────

export async function testZoho(cfg: IntegrationConfig): Promise<TestResult> {
  const { apiDomain, clientId, clientSecret, refreshToken } = cfg.fields;
  if (!apiDomain || !clientId || !clientSecret || !refreshToken) {
    return { ok: false, detail: "Fill API domain, client ID/secret, and refresh token." };
  }
  try {
    const token = await refreshZohoToken(cfg);
    const url = `${apiDomain.replace(/\/$/, "")}/crm/v5/users?type=CurrentUser`;
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, detail: `Zoho ${res.status}: ${body.slice(0, 120)}` };
    }
    const data = (await res.json()) as { users?: { full_name?: string; email?: string }[] };
    const me = data.users?.[0];
    return {
      ok: true,
      detail: `Verified as ${me?.full_name || me?.email || "current user"}.`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshZohoToken(cfg: IntegrationConfig): Promise<string> {
  const { clientId, clientSecret, refreshToken } = cfg.fields;
  const accountsHost = (cfg.fields.accountsUrl || "https://accounts.zoho.com").replace(/\/$/, "");
  const url = `${accountsHost}/oauth/v2/token?refresh_token=${encodeURIComponent(
    refreshToken,
  )}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(
    clientSecret,
  )}&grant_type=refresh_token`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoho token refresh ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`Zoho token refresh: ${data.error || "no access_token"}`);
  return data.access_token;
}

export async function pushZohoNote(
  cfg: IntegrationConfig,
  opts: { parentModule: string; parentId: string; title: string; content: string },
): Promise<TestResult> {
  try {
    const token = await refreshZohoToken(cfg);
    const url = `${cfg.fields.apiDomain.replace(/\/$/, "")}/crm/v5/Notes`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: [
          {
            Note_Title: opts.title,
            Note_Content: opts.content,
            Parent_Id: opts.parentId,
            se_module: opts.parentModule,
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, detail: `Zoho ${res.status}: ${body.slice(0, 160)}` };
    }
    return { ok: true, detail: "Note pushed to Zoho." };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────

export async function testZoom(cfg: IntegrationConfig): Promise<TestResult> {
  const { accountId, clientId, clientSecret } = cfg.fields;
  if (!accountId || !clientId || !clientSecret) {
    return { ok: false, detail: "Fill account ID, client ID, and client secret." };
  }
  try {
    const token = await zoomToken(cfg);
    const res = await fetch("https://api.zoom.us/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, detail: `Zoom ${res.status}: ${body.slice(0, 120)}` };
    }
    const data = (await res.json()) as { email?: string; display_name?: string };
    return { ok: true, detail: `Verified as ${data.display_name || data.email}.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function zoomToken(cfg: IntegrationConfig): Promise<string> {
  const { accountId, clientId, clientSecret } = cfg.fields;
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(
    accountId,
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoom token ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`Zoom token: ${data.error || "no access_token"}`);
  return data.access_token;
}

// ─── Google Meet / Google (via OAuth refresh token) ───────────────────────────

export async function testGoogleMeet(cfg: IntegrationConfig): Promise<TestResult> {
  const { clientId, clientSecret, refreshToken } = cfg.fields;
  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, detail: "Fill client ID, client secret, and refresh token." };
  }
  try {
    const token = await googleToken(cfg);
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, detail: `Google ${res.status}: ${body.slice(0, 120)}` };
    }
    const data = (await res.json()) as { email?: string; name?: string };
    return { ok: true, detail: `Verified as ${data.name || data.email}.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function googleToken(cfg: IntegrationConfig): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.fields.clientId,
    client_secret: cfg.fields.clientSecret,
    refresh_token: cfg.fields.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token ${res.status}: ${text.slice(0, 120)}`);
  }
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`Google token: ${data.error || "no access_token"}`);
  return data.access_token;
}

// ─── Custom tool ──────────────────────────────────────────────────────────────

export async function testCustomTool(cfg: IntegrationConfig): Promise<TestResult> {
  const url = cfg.fields.pullUrl || cfg.fields.pushUrl;
  if (!url) {
    return { ok: false, detail: "Add at least a pull endpoint or push endpoint." };
  }
  try {
    const headers: Record<string, string> = {};
    if (cfg.fields.apiKey) headers.Authorization = `Bearer ${cfg.fields.apiKey}`;
    const res = await fetch(url, { method: "GET", headers });
    return res.ok
      ? { ok: true, detail: `Endpoint reachable (${res.status}).` }
      : { ok: false, detail: `Endpoint ${res.status}.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function pushCustomTool(
  cfg: IntegrationConfig,
  payload: Record<string, unknown>,
): Promise<TestResult> {
  const url = cfg.fields.pushUrl;
  if (!url) return { ok: false, detail: "No push endpoint configured." };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.fields.apiKey) headers.Authorization = `Bearer ${cfg.fields.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return res.ok
      ? { ok: true, detail: `Pushed (${res.status}).` }
      : { ok: false, detail: `Push failed ${res.status}.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
