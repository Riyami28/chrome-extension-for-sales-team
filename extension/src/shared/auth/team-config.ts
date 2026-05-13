/**
 * Team auth + role mapping.
 * Configure the allowed Google Workspace domain and role overrides below.
 *
 * Domain is read from VITE_ALLOWED_DOMAIN in extension/.env (or .env.local).
 * Example: VITE_ALLOWED_DOMAIN=acme.com
 * Falls back to "zop.dev" if not set (original default).
 */

import type { UserRole } from "../types";

// Read from build-time env so different teams can deploy without code changes.
export const ALLOWED_EMAIL_DOMAIN: string =
  (import.meta.env.VITE_ALLOWED_DOMAIN as string | undefined)?.toLowerCase().trim() || "zop.dev";

// Hard-coded role map for known team members. Emails not listed here default
// to "sales_rep". Edit this file to grant Admin / PMM / Designer rights.
export const ROLE_OVERRIDES: Record<string, UserRole> = {
  // "admin@example.com": "admin",
  // "pmm-lead@example.com": "pmm",
  // "design-lead@example.com": "designer",
};

export const DEFAULT_ROLE: UserRole = "sales_rep";

export function isAllowedEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

export function roleFor(email: string): UserRole {
  return ROLE_OVERRIDES[email.toLowerCase()] ?? DEFAULT_ROLE;
}
