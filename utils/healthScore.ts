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
import { extractMaintenanceType } from "@/lib/maintenanceServiceMapping";
import { canonicalWarningLights } from "@/lib/warningLightVocab";

// ============================================================================
// v1 SPEC CONSTANTS (Yassin Otopair_Core_Systems_Spec_v1_1)
// ----------------------------------------------------------------------------
// Declared here so the team can review the numeric values before any logic
// consumes them. Change 1 of the build sequence: nothing reads these yet —
// Change 2 swaps the flat category mean for the weighted version against
// CATEGORY_WEIGHTS, lowers usage 25 → 20, and caps recPenalty at
// OPEN_ISSUE_PENALTY_MAX (drops mileageRecPenalty entirely). All thresholds
// stay tunable post-launch without code review per spec §7.
// ============================================================================

/** Per-category weights for the maintenance term (sum = 100). Safety items
 *  dominate; paperwork/compliance is lowest.
 *
 *  `warning` mirrors `brakes` (top weight) because a lit dashboard
 *  warning light is treated as safety-critical for the urgency model in
 *  `utils/urgency.ts` — the consolidated "Warning Lights Active"
 *  MaintenanceItem (id `warning-active-…`) needs to score into the Now
 *  tier so it surfaces on Home + the Cars MaintenanceTracker. This
 *  weight is NOT consumed by the maintenance-term sum (no real
 *  maintenance record carries `type: "warning"`); it only routes
 *  through the urgency layer's `extractMaintenanceType` lookup. */
export const CATEGORY_WEIGHTS = {
  brakes: 25,
  warning: 25,
  tires: 20,
  oil: 20,
  battery: 13,
  inspection: 12,
  other: 10,
} as const;

/** Outer formula weights: score = maintenance×0.65 + usage×0.20 + safetyReserve×0.15 − penalty. */
export const COMPONENT_WEIGHTS = {
  maintenance: 0.65,
  usage: 0.20,
  safetyReserve: 0.15,
} as const;

/** Open-issue penalty cap. Was 25 (recPenalty) + 20 (mileageRecPenalty);
 *  v1 collapses to a single 0–15 deduction, "upcoming" moves to urgency. */
export const OPEN_ISSUE_PENALTY_MAX = 15;

// Urgency-engine constants — read by Change 3 (utils/urgency.ts).
export const URGENCY_WEIGHTS = { severity: 0.50, proximity: 0.35 } as const;
export const URGENCY_TIEBREAKER_WINDOW = 5;
export const URGENCY_TIER_CUTOFFS = { now: 75, soon: 55, soonish: 25 } as const;

/** Resolve a maintenance item's id to the CATEGORY_WEIGHTS bucket. Items
 *  whose type isn't a recognized safety/reliability category fall into
 *  "other" (10% weight). */
function categoryWeightForItem(item: MaintenanceItem): number {
  const type = extractMaintenanceType(item.id);
  if (type in CATEGORY_WEIGHTS) {
    return CATEGORY_WEIGHTS[type as keyof typeof CATEGORY_WEIGHTS];
  }
  return CATEGORY_WEIGHTS.other;
}

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
 * Compute the warning-light penalty from a knownIssues array.
 *
 * Reads via `canonicalWarningLights`, so it is agnostic to the array's SHAPE
 * (legacy sentinel-prefixed `["other", ...lights]` OR the flat code-set
 * `["oil_pressure", "check_engine"]` written by Oto / the check-in) and to its
 * VOCABULARY (symptom aliases like `brake_warning` fold to `abs`). The previous
 * implementation keyed off `knownIssues[0]` as a status sentinel and summed
 * penalties from index 1, so a light written in the flat shape (or appended
 * after a stale `no_all_clear`) scored zero — the exact bug where an Oto-logged
 * light never dented the score. Penalty is summed per canonical light, capped
 * at 25 (the reserve floors at 0 regardless).
 */
function warningLightPenalty(knownIssues?: string[]): number {
  let penalty = 0;
  for (const light of canonicalWarningLights(knownIssues)) {
    penalty += LIGHT_PENALTY[light] ?? 6;
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
  /** Open mileage-based recommendations from job_recommendations.
   *  Read by the Action Engine's urgency proximity term (Change 3); no
   *  longer affects the Health Score directly per v1 spec §2.6
   *  (mileageRecPenalty was dropped). Kept on this input shape so
   *  existing callers compile unchanged. */
  mileageRecs?: Array<{ target_mileage: number }>;
}

/**
 * Compute the overall 0–100 vehicle health score (v1 — Yassin spec v1.1).
 *
 *   score = maintenance(65%) + usage(20%) + safetyReserve(15%) − openIssuePenalty
 *
 * Three changes from v0:
 *   1. Maintenance term is a CATEGORY-WEIGHTED average (brakes 25, tires 20,
 *      oil 20, battery 13, inspection 12, other 10) instead of a flat
 *      mean. Categories with no item present effectively redistribute
 *      their weight because they drop out of the denominator. Items with
 *      `status: "unknown"` keep their weight but score with the v0
 *      mileage-aware inference curve.
 *   2. Component split shifts 60/25/15 → 65/20/15 to cut the
 *      mileage-double-count between usage and interval-based items.
 *   3. Penalties collapse 0–45 (recPenalty + mileageRecPenalty) → 0–15
 *      (open mechanic recs only). "Upcoming services" no longer drag the
 *      truth number — that signal moves to the Action Engine's urgency.
 */
export function computeVehicleHealthScore(input: HealthScoreInput): number {
  const { maintenanceItems, odometerMiles, knownIssues, hpBuffer } = input;

  // The pipeline score is stored on vehicle_owners for cron/check-in use,
  // but the client always computes its own score so the health ring reacts
  // immediately to stepper answers without waiting for the async pipeline.

  // ── Maintenance component (category-weighted) ─────────────────
  // For each present item, score it and weight it by its category's
  // share. Unknown items use the mileage-aware inference curve from v0
  // (so a brand-new car stays healthy, an old car gets appropriate
  // suspicion). Categories with no item drop out of the denominator —
  // their weight redistributes naturally across the remaining ones.
  const unknownInferredScore = unknownScoreForMileage(odometerMiles);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of maintenanceItems) {
    const w = categoryWeightForItem(item);
    const score = item.status === "unknown"
      ? unknownInferredScore
      : STATUS_SCORE[item.status];
    weightedSum += w * score;
    weightTotal += w;
  }
  const maintenanceAvg = weightTotal > 0
    ? weightedSum / weightTotal
    : unknownInferredScore;
  const maintenancePct = maintenanceAvg * 100;

  // ── Usage component ───────────────────────────────────────────
  const usagePct = mileageScore(odometerMiles);

  // ── Warning-light penalty + reserve (15 pts) ──────────────────
  const lightPenalty = warningLightPenalty(knownIssues);
  const warningReserve = Math.max(0, 15 - lightPenalty);

  // ── Blend (65/20/15) ──────────────────────────────────────────
  let raw =
    maintenancePct * COMPONENT_WEIGHTS.maintenance +
    usagePct * COMPONENT_WEIGHTS.usage +
    warningReserve;

  // ── Open-issue penalty (single, capped at OPEN_ISSUE_PENALTY_MAX) ──
  // v0 stacked recPenalty (0–25) + mileageRecPenalty (0–20). v1 collapses
  // to one capped deduction from mechanic-flagged open issues only.
  const openIssuePenalty = Math.min(
    OPEN_ISSUE_PENALTY_MAX,
    Math.max(0, input.recPenalty ?? 0),
  );
  raw -= openIssuePenalty;

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
  /** Optional third line, used by booking entries for the completion date. */
  subDetail?: string;
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

  // ── Maintenance (65% weight, weighted by category) ─────────────
  // Each item's share of the 65-pt maintenance budget = its category
  // weight as a fraction of the *present* category weights. Mirrors the
  // computeVehicleHealthScore math so the breakdown always reconciles.
  const knownCount = maintenanceItems.filter((i) => i.status !== "unknown").length;
  let weightTotal = 0;
  for (const item of maintenanceItems) weightTotal += categoryWeightForItem(item);
  const maintenanceBudget = 100 * COMPONENT_WEIGHTS.maintenance;
  const perWeightUnit = weightTotal > 0 ? maintenanceBudget / weightTotal : 0;

  let unknownCount = 0;
  for (const item of maintenanceItems) {
    if (item.status === "unknown") {
      unknownCount += 1;
      continue;
    }
    const itemWeight = categoryWeightForItem(item);
    const itemShare = itemWeight * perWeightUnit;
    const score = STATUS_SCORE[item.status];
    if (item.status === "on_time") {
      // Headroom above baseline 0.5 — what the on-time status "earns" you.
      const pts = Math.round((score - 0.5) * itemShare);
      if (pts > 0) {
        positives.push({ label: `On-time: ${item.serviceName}`, pts });
      }
    } else {
      // Anything short of on_time loses (1 - score) × per-item share.
      const pts = Math.round((1 - score) * itemShare);
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
    // Aggregate the unknowns' weighted share.
    let unknownShare = 0;
    for (const item of maintenanceItems) {
      if (item.status === "unknown") {
        unknownShare += categoryWeightForItem(item) * perWeightUnit;
      }
    }
    const totalPts = Math.round((1 - inferred) * unknownShare);
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

  // ── Usage / mileage (20% weight per v1) ────────────────────────
  const usagePct = mileageScore(odometerMiles);
  const usagePts = Math.round(usagePct * COMPONENT_WEIGHTS.usage);
  const usageDetail = `${odometerMiles.toLocaleString()} mi`;
  if (odometerMiles <= 30_000) {
    positives.push({ label: "Low mileage", detail: usageDetail, pts: usagePts });
  } else if (usagePct >= 75) {
    positives.push({ label: "Healthy mileage", detail: usageDetail, pts: usagePts });
  } else {
    const lost = Math.round((100 - usagePct) * COMPONENT_WEIGHTS.usage);
    if (lost > 0) {
      negatives.push({ label: "High mileage", detail: usageDetail, pts: lost });
    }
  }

  // ── Warning lights (15% reserve, minus penalty) ────────────────
  // Same canonical, format-agnostic read as warningLightPenalty so the
  // breakdown always reconciles with the score: one negative per active
  // canonical light, sharing the 25-pt running cap. (Previously switched on
  // knownIssues[0] as a sentinel, so a flat/symptom-vocab array silently
  // emitted neither the "No warning lights" positive nor any negative.)
  const activeLights = canonicalWarningLights(knownIssues);
  if (activeLights.length === 0) {
    positives.push({ label: "No warning lights", pts: 15 });
  } else {
    let remaining = 25; // matches the cap inside warningLightPenalty
    for (const id of activeLights) {
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

// ============================================================================
// PER-BOOKING HELPING FACTORS
// ============================================================================

export interface CompletedBooking {
  /** Convex bookings _id as string. */
  id: string;
  /** Display names of services covered by the booking, e.g. ["Oil Change", "Tire Rotation"]. */
  services: string[];
  /** Unix ms; null if the booking row has no completion timestamp. */
  completedAt: number | null;
  /** Resolved shop display name. Empty string falls back to "Service center" at render time. */
  shopName: string;
}

/**
 * Attributes each currently-on-time maintenance item's score
 * contribution to the most-recent completed booking that touched
 * it. Returns one HealthFactor per booking that holds at least one
 * maintenance type on_time. Older bookings for the same type are
 * folded into the most-recent one (no double counting).
 *
 * The per-booking pts sum equals the per-item on_time pts that
 * `computeHealthScoreFactors` would have generated — so the
 * headline score is unchanged; we're just regrouping the credit
 * from "per maintenance item" to "per booking the user completed."
 *
 * Bookings that touched only untracked services (body work,
 * diagnostics, etc.) don't appear here — they have no maintenance
 * coverage signal.
 */
// Substring keywords used to map a maintenance type (oil, brakes, …)
// to specific booking service names ("Oil Change", "Brake Pad
// Replacement", "Battery Replacement", …). Mirrors the SLUG_TO_TYPE
// table in convex/bookings.ts so client-side attribution and the
// backend's maintenance-record upsert stay aligned. Lowercase keys.
const TYPE_KEYWORDS: Record<string, string[]> = {
  oil: ["oil"],
  brakes: ["brake"],
  tires: ["tire", "wheel"],
  battery: ["battery"],
  inspection: ["inspect", "emission"],
  fluids: ["fluid", "flush", "coolant"],
  filters: ["filter"],
  wipers: ["wiper", "blade"],
  engine_parts: ["spark plug", "belt"],
  diagnostics: ["diagnostic"],
};

export function computeBookingHelpingFactors(
  input: HealthScoreInput,
  completedBookings: CompletedBooking[],
): HealthFactor[] {
  const { maintenanceItems } = input;
  if (!completedBookings || completedBookings.length === 0) return [];

  const totalForWeighting = Math.max(maintenanceItems.length, 1);
  const perItemWeight = 60 / totalForWeighting;

  // Sort bookings newest → oldest so "find" returns the most recent.
  const sorted = [...completedBookings].sort(
    (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
  );

  // Accumulator: bookingId → { booking, serviceLabels, totalPts }
  // `serviceLabels` collects the BOOKING's own service names that
  // matched (e.g. "Battery Replacement") — those are user-facing and
  // descriptive. The maintenance item's type-level label
  // ("Battery check") would read awkwardly in the entry.
  const acc = new Map<
    string,
    { booking: CompletedBooking; serviceLabels: string[]; pts: number }
  >();

  for (const item of maintenanceItems) {
    if (item.status !== "on_time") continue;
    const score = STATUS_SCORE[item.status];
    const pts = Math.round((score - 0.5) * perItemWeight);
    if (pts <= 0) continue;

    // `item.id` is e.g. "user-battery" or "unknown-oil" — strip the
    // prefix to get the type identifier, then look up its keywords.
    const itemType = item.id.replace(/^(unknown-|user-)/, "");
    const keywords = TYPE_KEYWORDS[itemType] ?? [];
    const itemKey = item.serviceName.trim().toLowerCase();

    // Score-factor → booking match: a booking matches when any of
    // its service names contains a keyword for the item's type.
    // Falls back to exact-name match so existing behavior never
    // regresses on types not yet in TYPE_KEYWORDS.
    const matchesItem = (s: string) => {
      const lower = s.toLowerCase();
      if (keywords.some((kw) => lower.includes(kw))) return true;
      return lower.trim() === itemKey;
    };

    const match = sorted.find((b) => b.services.some(matchesItem));
    if (!match) continue; // credit came from a user-entered record, not a booking

    // Pull the booking's own labels that matched this type — those
    // are what we show to the user.
    const matchedLabels = match.services.filter(matchesItem);

    const existing = acc.get(match.id);
    if (existing) {
      for (const label of matchedLabels) {
        if (!existing.serviceLabels.includes(label)) {
          existing.serviceLabels.push(label);
        }
      }
      existing.pts += pts;
    } else {
      acc.set(match.id, {
        booking: match,
        serviceLabels: [...new Set(matchedLabels)],
        pts,
      });
    }
  }

  const result: HealthFactor[] = [];
  for (const { booking, serviceLabels, pts } of acc.values()) {
    const label = booking.shopName.trim() || "Service center";
    const detail =
      serviceLabels.length === 1
        ? serviceLabels[0]
        : serviceLabels.join(" · ");
    const subDetail = formatBookingCompletionDate(booking.completedAt);
    result.push({ label, detail, subDetail, pts });
  }
  result.sort((a, b) => b.pts - a.pts);
  return result;
}

function formatBookingCompletionDate(
  completedAt: number | null,
): string | undefined {
  if (!completedAt) return undefined;
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(completedAt));
  return `Completed ${formatted}`;
}
