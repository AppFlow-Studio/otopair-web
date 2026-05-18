/**
 * healthScore.ts — Vehicle Health Score Computation
 *
 * Single source of truth for the health ring score shown in
 * CarCarousel and MaintenanceTracker.
 *
 * SCORING MODEL (0–100):
 *   Maintenance component  — weighted average of per-item graduated scores
 *   Usage component        — mileage-based diminishing curve
 *   Warning-light penalty  — direct deduction for active dashboard warnings
 *
 * USED IN: app/(main-tabs)/cars/index.tsx
 */

import type { MaintenanceItem, MaintenanceStatus } from "@/components/cars/MaintenanceTracker";

// ============================================================================
// STATUS → SCORE (graduated, not binary)
// ============================================================================

const STATUS_SCORE: Record<MaintenanceStatus, number> = {
  on_time: 1.0,
  due_soon: 0.7,
  needs_attention: 0.35,
  overdue: 0.1,
  unknown: -1, // sentinel — excluded from average
};

// ============================================================================
// MILEAGE CURVE (piecewise linear)
// ============================================================================

function mileageScore(miles: number): number {
  if (miles <= 0) return 100;
  if (miles <= 30_000) return 100;
  if (miles <= 60_000) return 100 - ((miles - 30_000) / 30_000) * 10;   // 100→90
  if (miles <= 100_000) return 90 - ((miles - 60_000) / 40_000) * 15;   // 90→75
  if (miles <= 150_000) return 75 - ((miles - 100_000) / 50_000) * 20;  // 75→55
  return Math.max(30, 55 - ((miles - 150_000) / 50_000) * 15);          // 55→40→30 floor
}

// ============================================================================
// UNKNOWN-ITEM SCORE BY MILEAGE
// ============================================================================

/**
 * When a maintenance item has no data ("unknown"), its implied health
 * depends on how far the car has been driven.
 *
 *   ≤15k mi  → 0.95  (brand new, no service expected yet)
 *   ≤30k mi  → 0.85  (still early, most items haven't come due)
 *   ≤60k mi  → 0.55  (some service should have happened by now)
 *   ≤100k mi → 0.35  (missing records is a yellow flag)
 *   >100k mi → 0.20  (high mileage + no records is concerning)
 */
function unknownScoreForMileage(miles: number): number {
  if (miles <= 15_000) return 0.95;
  if (miles <= 30_000) return 0.95 - ((miles - 15_000) / 15_000) * 0.10;  // 0.95→0.85
  if (miles <= 60_000) return 0.85 - ((miles - 30_000) / 30_000) * 0.30;  // 0.85→0.55
  if (miles <= 100_000) return 0.55 - ((miles - 60_000) / 40_000) * 0.20; // 0.55→0.35
  return Math.max(0.15, 0.35 - ((miles - 100_000) / 50_000) * 0.15);     // 0.35→0.20→0.15 floor
}

// ============================================================================
// WARNING-LIGHT PENALTY
// ============================================================================

const LIGHT_PENALTY: Record<string, number> = {
  oil_pressure: 15,
  temperature: 15,
  check_engine: 12,
  battery_charging: 10,
  transmission: 10,
  abs: 8,
  airbag_srs: 7,
  tpms: 5,
  not_sure_which: 6,
};

/**
 * Compute penalty from knownIssues array.
 * knownIssues[0] = top-level answer (no_all_clear | check_engine | different_light | not_sure)
 * knownIssues[1..n] = specific light type ids (when answer was "different_light")
 */
function warningLightPenalty(knownIssues?: string[]): number {
  if (!knownIssues || knownIssues.length === 0) return 0;

  const status = knownIssues[0];
  if (status === "no_all_clear") return 0;
  if (status === "not_sure") return 5;
  if (status === "check_engine") return LIGHT_PENALTY.check_engine;

  // "different_light" — sum individual penalties (capped)
  let penalty = 0;
  for (let i = 1; i < knownIssues.length; i++) {
    penalty += LIGHT_PENALTY[knownIssues[i]] ?? 6;
  }
  return Math.min(penalty, 25);
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

export interface HealthScoreInput {
  maintenanceItems: MaintenanceItem[];
  odometerMiles: number;
  knownIssues?: string[];
  /** Pipeline-computed health score from vehicle_owners.health_score */
  pipelineHealthScore?: number | null;
  /** Whether the pipeline score is an estimate (quarterly check-in overdue) */
  pipelineIsEstimated?: boolean;
  /** Health Points buffer (0–3) — added on top of the raw score per
   * Rewards Framework v3 §11. Every 15 HP yields +1 to the displayed
   * score, capped at +3. Never hides real problems — score still can't
   * exceed 100. Caller supplies the buffer via `api.healthPoints.getPoints`. */
  hpBuffer?: number;
  /** Additive penalty (0–25) from open mechanic recommendations.
   *  Read from vehicle_owners.health_score_rec_penalty; subtracted before clamp. */
  recPenalty?: number;
  /** Open mileage-based recommendations from job_recommendations. Each
   *  rec contributes a penalty that ramps in as the odometer approaches
   *  target_mileage and pegs at full once the threshold is reached. */
  mileageRecs?: Array<{ target_mileage: number }>;
}

const MILEAGE_REC_PENALTY_PER_REC = 8;
const MILEAGE_REC_RAMP_WINDOW = 5_000;
const MILEAGE_REC_PENALTY_CAP = 20;

/**
 * Penalty for open recommendations with a target_mileage threshold.
 * Zero until the vehicle is within MILEAGE_REC_RAMP_WINDOW miles of the
 * target, then linearly ramps to MILEAGE_REC_PENALTY_PER_REC, pinned at
 * that value once the odometer crosses the threshold. Summed across recs,
 * capped at MILEAGE_REC_PENALTY_CAP so a single vehicle can't be zeroed
 * out by recs alone.
 */
function mileageRecPenalty(
  odometerMiles: number,
  recs?: Array<{ target_mileage: number }>,
): number {
  if (!recs || recs.length === 0) return 0;
  let total = 0;
  for (const rec of recs) {
    const target = rec.target_mileage;
    if (!Number.isFinite(target) || target <= 0) continue;
    const distance = target - odometerMiles;
    if (distance <= 0) {
      total += MILEAGE_REC_PENALTY_PER_REC;
    } else if (distance < MILEAGE_REC_RAMP_WINDOW) {
      const proximity = 1 - distance / MILEAGE_REC_RAMP_WINDOW;
      total += MILEAGE_REC_PENALTY_PER_REC * proximity;
    }
  }
  return Math.min(MILEAGE_REC_PENALTY_CAP, total);
}

/**
 * Compute the overall 0–100 vehicle health score.
 *
 *   score = maintenance(60%) + mileage(25%) + warningLightReserve(15%) − penalties
 */
export function computeVehicleHealthScore(input: HealthScoreInput): number {
  const { maintenanceItems, odometerMiles, knownIssues, hpBuffer } = input;

  // The pipeline score is stored on vehicle_owners for cron/check-in use,
  // but the client always computes its own score so the health ring reacts
  // immediately to stepper answers without waiting for the async pipeline.

  // ── Maintenance component (graduated) ─────────────────────────
  // Unknown items get a mileage-aware inferred score instead of being
  // dropped. A brand-new car with no service history is healthy — the
  // absence of records only becomes concerning at higher mileage.
  const unknownInferredScore = unknownScoreForMileage(odometerMiles);

  const scoredItems = maintenanceItems.map((item) =>
    item.status === "unknown" ? unknownInferredScore : STATUS_SCORE[item.status]
  );

  const maintenanceAvg = scoredItems.length > 0
    ? scoredItems.reduce((a, b) => a + b, 0) / scoredItems.length
    : unknownInferredScore;

  const maintenancePct = maintenanceAvg * 100;

  // ── Usage component ───────────────────────────────────────────
  const usagePct = mileageScore(odometerMiles);

  // ── Warning-light penalty ─────────────────────────────────────
  const penalty = warningLightPenalty(knownIssues);

  // ── Warning-light reserve (15 pts) ────────────────────────────
  const warningReserve = Math.max(0, 15 - penalty);

  // ── Blend ─────────────────────────────────────────────────────
  let raw = (maintenancePct * 0.60) + (usagePct * 0.25) + warningReserve;

  // Subtract open-recommendation penalty before clamp so 0/100 bounds still hold.
  raw -= input.recPenalty ?? 0;
  raw -= mileageRecPenalty(odometerMiles, input.mileageRecs);

  const rounded = Math.max(0, Math.min(100, Math.round(raw)));
  // HP buffer adds on top of the clamped score (Rewards Framework v3 §11),
  // capped so total can't exceed 100.
  const buffer = Math.max(0, Math.min(3, hpBuffer ?? 0));
  return Math.min(100, rounded + buffer);
}

/**
 * Compute what the health score would be if a specific maintenance item
 * were resolved (status flipped to on_time).
 */
export function computeProjectedHealthScore(
  input: HealthScoreInput,
  fixedItemId: string,
): number {
  const adjustedItems = input.maintenanceItems.map((item) =>
    item.id === fixedItemId ? { ...item, status: 'on_time' as MaintenanceStatus } : item
  );
  return computeVehicleHealthScore({ ...input, maintenanceItems: adjustedItems });
}

// ============================================================================
// SCORE FACTORS BREAKDOWN
// ============================================================================

export interface HealthFactor {
  /** Short headline, e.g. "On-time: Oil change", "Overdue: Battery", "Low mileage". */
  label: string;
  /** Optional supporting line, e.g. mileage figure or item description. */
  detail?: string;
  /** Absolute pts contribution — always positive; the bucket implies sign. */
  pts: number;
}

const LIGHT_LABELS: Record<string, string> = {
  oil_pressure: "Oil pressure warning",
  temperature: "Engine temperature warning",
  check_engine: "Check engine light",
  battery_charging: "Battery / charging warning",
  transmission: "Transmission warning",
  abs: "ABS warning",
  airbag_srs: "Airbag / SRS warning",
  tpms: "Tire pressure warning",
  not_sure_which: "Unidentified warning light",
};

/**
 * Breakdown of what's helping vs hurting the overall health score.
 * Uses the same inputs and weights as `computeVehicleHealthScore` so the
 * deltas always reconcile with the displayed total.
 */
export function computeHealthScoreFactors(input: HealthScoreInput): {
  positives: HealthFactor[];
  negatives: HealthFactor[];
} {
  const { maintenanceItems, odometerMiles, knownIssues, hpBuffer } = input;
  const positives: HealthFactor[] = [];
  const negatives: HealthFactor[] = [];

  // ── Maintenance (60% weight, split across items) ───────────────
  const knownCount = maintenanceItems.filter((i) => i.status !== "unknown").length;
  const totalForWeighting = Math.max(maintenanceItems.length, 1);
  const perItemWeight = 60 / totalForWeighting;

  let unknownCount = 0;
  for (const item of maintenanceItems) {
    if (item.status === "unknown") {
      unknownCount += 1;
      continue;
    }
    const score = STATUS_SCORE[item.status];
    if (item.status === "on_time") {
      // Headroom above baseline 0.5 — what the on-time status "earns" you.
      const pts = Math.round((score - 0.5) * perItemWeight);
      if (pts > 0) {
        positives.push({ label: `On-time: ${item.serviceName}`, pts });
      }
    } else {
      // Anything short of on_time loses (1 - score) × per-item weight.
      const pts = Math.round((1 - score) * perItemWeight);
      if (pts <= 0) continue;
      const prefix =
        item.status === "overdue" ? "Overdue" :
        item.status === "needs_attention" ? "Needs attention" :
        "Due soon";
      negatives.push({
        label: `${prefix}: ${item.serviceName}`,
        detail: item.description,
        pts,
      });
    }
  }

  if (unknownCount > 0) {
    const inferred = unknownScoreForMileage(odometerMiles);
    const totalPts = Math.round((1 - inferred) * perItemWeight * unknownCount);
    if (totalPts > 0) {
      negatives.push({
        label: unknownCount === 1
          ? "Service history pending"
          : `Service history pending (${unknownCount})`,
        detail: knownCount === 0
          ? "Add records to refine your score"
          : "Logging more services will improve accuracy",
        pts: totalPts,
      });
    }
  }

  // ── Usage / mileage (25% weight) ───────────────────────────────
  const usagePct = mileageScore(odometerMiles);
  const usagePts = Math.round(usagePct * 0.25);
  const usageDetail = `${odometerMiles.toLocaleString()} mi`;
  if (odometerMiles <= 30_000) {
    positives.push({ label: "Low mileage", detail: usageDetail, pts: usagePts });
  } else if (usagePct >= 75) {
    positives.push({ label: "Healthy mileage", detail: usageDetail, pts: usagePts });
  } else {
    const lost = Math.round((100 - usagePct) * 0.25);
    if (lost > 0) {
      negatives.push({ label: "High mileage", detail: usageDetail, pts: lost });
    }
  }

  // ── Warning lights (15% reserve, minus penalty) ────────────────
  const status = knownIssues?.[0];
  if (!status || status === "no_all_clear") {
    positives.push({ label: "No warning lights", pts: 15 });
  } else if (status === "check_engine") {
    negatives.push({
      label: LIGHT_LABELS.check_engine,
      pts: LIGHT_PENALTY.check_engine,
    });
  } else if (status === "not_sure") {
    negatives.push({ label: "Unsure about dashboard lights", pts: 5 });
  } else if (status === "different_light") {
    let remaining = 25; // matches the cap inside warningLightPenalty
    for (let i = 1; i < (knownIssues?.length ?? 0); i++) {
      const id = knownIssues![i];
      const penalty = Math.min(LIGHT_PENALTY[id] ?? 6, remaining);
      if (penalty <= 0) break;
      remaining -= penalty;
      negatives.push({ label: LIGHT_LABELS[id] ?? `Warning light: ${id}`, pts: penalty });
    }
  }

  // ── HP buffer bonus ────────────────────────────────────────────
  const buffer = Math.max(0, Math.min(3, hpBuffer ?? 0));
  if (buffer > 0) {
    positives.push({ label: "Rewards bonus", detail: "From Health Points", pts: buffer });
  }

  positives.sort((a, b) => b.pts - a.pts);
  negatives.sort((a, b) => b.pts - a.pts);

  return { positives, negatives };
}
