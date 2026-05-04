/**
 * Team auth + role mapping.
 * Configure the allowed Google Workspace domain and role overrides below.
 */

import type { UserRole } from "../types";

// Set this to your organization's Google Workspace domain.
// Locked to zop.dev — only ZopDev team accounts can sign in.
export const ALLOWED_EMAIL_DOMAIN = "zop.dev";

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
