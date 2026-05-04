// Small pure helpers shared by the sidebar-side and background-side
// orchestrators. Keeps sentiment trend + agenda pacing logic in one place so
// adding a new derived signal doesn't require editing both orchestrators.

import type { AgendaItem, SentimentSnapshot, CoachRejection } from "../../shared/types";
import type { LiveValidationOutcome } from "./live-agents";

export type EnergyDirection = "up" | "down" | "flat";

export interface SentimentTrend {
  energy: SentimentSnapshot["energy"];
  direction: EnergyDirection;
  // Shown on the transponder as e.g. "High ↘ Med".
  label: string;
}

const ENERGY_RANK: Record<SentimentSnapshot["energy"], number> = { low: 0, medium: 1, high: 2 };

// Compare the last snapshot to the one N steps back. Anything more elaborate
// (linear regression, slope) is overkill for 2-3 samples per minute.
export function computeSentimentTrend(history: SentimentSnapshot[]): SentimentTrend | null {
  const last = history[history.length - 1];
  if (!last) return null;
  const prev = history[history.length - 3] || history[history.length - 2];
  if (!prev) return { energy: last.energy, direction: "flat", label: cap(last.energy) };
  const d = ENERGY_RANK[last.energy] - ENERGY_RANK[prev.energy];
  const direction: EnergyDirection = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const arrow = direction === "up" ? "↗" : direction === "down" ? "↘" : "→";
  return {
    energy: last.energy,
    direction,
    label: direction === "flat" ? cap(last.energy) : `${cap(prev.energy)} ${arrow} ${cap(last.energy)}`,
  };
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

export interface AgendaPacing {
  coveredCount: number;
  totalCount: number;
  coveredRatio: number;
  expectedRatio: number;
  // Negative = behind, positive = ahead, ~0 = on pace.
  drift: number;
  label: string;
}

// Expected meeting duration defaults to 30 min if the caller can't supply one.
// Drift is a simple (actual - expected) ratio.
export function computeAgendaPacing(
  agenda: AgendaItem[],
  sessionStartedAtMs: number | undefined,
  expectedDurationMs = 30 * 60_000,
): AgendaPacing | null {
  if (!agenda.length || !sessionStartedAtMs) return null;
  const total = agenda.length;
  const covered = agenda.filter((a) => a.status === "covered").length;
  const coveredRatio = covered / total;
  const elapsed = Date.now() - sessionStartedAtMs;
  const expectedRatio = Math.min(1, elapsed / expectedDurationMs);
  const drift = coveredRatio - expectedRatio;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const label = `Pacing: ${pct(coveredRatio)} · expected ${pct(expectedRatio)}`;
  return { coveredCount: covered, totalCount: total, coveredRatio, expectedRatio, drift, label };
}

// Build a CoachRejection payload from a validator outcome + the original
// suggestion (since the outcome's suggestion field is null for rejects).
export function rejectionFromOutcome(
  outcome: LiveValidationOutcome,
  originalTitle: string,
  originalBody: string,
  originalKind: CoachRejection["kind"],
): CoachRejection {
  return {
    id: `rej-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    created_at: Date.now(),
    title: originalTitle,
    body: originalBody,
    kind: originalKind,
    issues: outcome.issues,
    confidence: outcome.confidence,
  };
}
