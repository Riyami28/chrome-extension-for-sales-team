/**
 * Google SSO via chrome.identity. Returns the signed-in Google profile,
 * gated to the Workspace domain configured in team-config.ts.
 */

import type { User } from "../types";
import { isAllowedEmail, roleFor, ALLOWED_EMAIL_DOMAIN } from "./team-config";

interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  hd?: string; // hosted domain — present only for Workspace accounts
}

async function getGoogleToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome?.identity?.getAuthToken) {
      reject(new Error("chrome.identity unavailable. Set oauth2.client_id in manifest.json."));
      return;
    }
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "Google sign-in failed"));
        return;
      }
      if (!token) {
        reject(new Error("No Google token returned"));
        return;
      }
      resolve(typeof token === "string" ? token : (token as { token: string }).token);
    });
  });
}

async function fetchUserInfo(token: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`);
  return res.json();
}

export async function signInWithGoogle(interactive = true): Promise<User> {
  const token = await getGoogleToken(interactive);
  const info = await fetchUserInfo(token);

  if (!isAllowedEmail(info.email)) {
    // Revoke so the next attempt re-prompts a different account
    await revokeGoogleToken(token);
    throw new Error(
      `Access restricted to @${ALLOWED_EMAIL_DOMAIN} accounts. You signed in as ${info.email}.`,
    );
  }

  return {
    id: info.sub,
    email: info.email,
    name: info.name,
    role: roleFor(info.email),
    avatar_url: info.picture,
  };
}

export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" });
  } catch {
    /* best-effort */
  }
  return new Promise((resolve) => {
    chrome.identity?.removeCachedAuthToken?.({ token }, () => resolve());
  });
}

export async function signOut(): Promise<void> {
  try {
    const token = await getGoogleToken(false);
    await revokeGoogleToken(token);
  } catch {
    /* already signed out */
  }
}
