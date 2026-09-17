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
  timing_belt: 22,          // catastrophic if it snaps
  brake_fluid_flush: 18,    // touches the braking system
  transmission_service: 18, // wrong or skipped fluid → kills the box
  tires: 20,
  oil: 20,
  spark_plugs: 15,
  coolant_flush: 15,        // overheating chain-reaction on the engine
  serpentine_belt: 15,      // fails → immediate stranded breakdown
  differential_service: 12,
  battery: 13,
  inspection: 12,
  filter_replacement: 8,
  power_steering_flush: 8,
  fuel_system_cleaning: 8,
  other: 10,
} as const;

/** Outer formula weights: score = maintenance×0.85 + safetyReserve×0.15 − penalty.
 *  Mileage/usage was removed entirely (not just zeroed) — Otopair only
 *  scores what a driver can act on through the app, and raw mileage never
 *  mapped to a fixable item. The freed 20 points went to maintenance
 *  (Upkeep), not a proportional split across both remaining components. */
export const COMPONENT_WEIGHTS = {
  maintenance: 0.85,
  safetyReserve: 0.15,
} as const;

/** Open-issue penalty cap. Was 25 (recPenalty) + 20 (mileageRecPenalty);
 *  v1 collapses to a single 0–15 deduction, "upcoming" moves to urgency. */
export const OPEN_ISSUE_PENALTY_MAX = 15;

/** Default Upkeep share; Warning Lights is the remainder. Mirrors
 *  convex/healthScoreWeights.ts DEFAULT_UPKEEP_WEIGHT. */
export const DEFAULT_UPKEEP_SPLIT = 85;

// Urgency-engine constants — read by Change 3 (utils/urgency.ts).
export const URGENCY_WEIGHTS = { severity: 0.50, proximity: 0.35 } as const;
export const URGENCY_TIEBREAKER_WINDOW = 5;
/** Three tiers ship (NOW / SOON / HEALTHY) but four cutoffs are kept.
 *  `now` (75) is the NOW floor and `soonish` (25) is the SOON floor —
 *  everything below 25 rests. `soon` (55) no longer splits anything; it is
 *  retained so the 75/55/25 thresholds logged to urgency_tier_events stay
 *  comparable across the tier change and remain available if the middle
 *  band is ever re-separated. Key names are shared with the web repo — do
 *  not rename without porting. */
export const URGENCY_TIER_CUTOFFS = { now: 75, soon: 55, soonish: 25 } as const;

/** Resolve a maintenance item's id to the CATEGORY_WEIGHTS bucket. Items
 *  whose type isn't a recognized safety/reliability category fall into
 *  "other" (10% weight). */
/** A catalog row's id is `catalog-<taxonomy slug>`. `extractMaintenanceType`
 *  stops at the first dash and returns "catalog", which is not a weight
 *  bucket — so the slug has to be recovered here. */
function catalogSlugFromId(id?: string): string | undefined {
  return id?.startsWith("catalog-") ? id.slice("catalog-".length) : undefined;
}

function categoryWeightForItem(item: MaintenanceItem): number {
  // Bigger services carry their own weights in the table above —
  // transmission 18, spark plugs 15, differential 12 — and those numbers were
  // written for exactly these rows. Reading them as "catalog" dropped every
  // one to the generic 10.
  const slug = catalogSlugFromId(item.id);
  if (slug && slug in CATEGORY_WEIGHTS) {
    return CATEGORY_WEIGHTS[slug as keyof typeof CATEGORY_WEIGHTS];
  }
  const type = extractMaintenanceType(item.id);
  if (type in CATEGORY_WEIGHTS) {
    return CATEGORY_WEIGHTS[type as keyof typeof CATEGORY_WEIGHTS];
  }
  return CATEGORY_WEIGHTS.other;
}

// ============================================================================
// STATUS → SCORE (graduated, not binary)
// ============================================================================

/**
 * The only types that may deduct on interval.
 *
 * The five core tiles, plus `warning` for the consolidated active-lights card.
 * maintenance_records.type is an unconstrained v.string() and
 * buildMaintenanceItems casts whatever it finds to MaintenanceType, so records
 * of types outside the union (`fluids`, `diagnostics`, `transmission_service`,
 * `filters`, `wipers`, `engine_parts`) were becoming scored items and losing
 * the driver points purely because time or mileage had passed. Those are
 * exactly the rows the model says must never score without a mechanic behind
 * them.
 */
const SCORING_TYPES: ReadonlySet<string> = new Set([
  "oil",
  "brakes",
  "tires",
  "battery",
  "inspection",
  "warning",
]);

/**
 * How full the Warning Lights reserve still is, 0–100, for ring display.
 * The reserve starts full and drains by warningLightPenalty; `reserveWeight`
 * is the director-set Warning Lights budget (default 15) so the ring tracks
 * the same number the score uses.
 */
export function warningLightsReservePct(
  knownIssues?: string[],
  reserveWeight: number = 100 - DEFAULT_UPKEEP_SPLIT,
): number {
  if (reserveWeight <= 0) return 100;
  const remaining = Math.max(0, reserveWeight - warningLightPenalty(knownIssues));
  return Math.round((remaining / reserveWeight) * 100);
}

/**
 * Does this item contribute to the Upkeep term?
 *
 * Two kinds of row are shown to the driver but must never move the score:
 *  - recommendation cards (`sourceRecommendationId`) — the matching core or
 *    minor tile already scores that finding, and the Open-recs penalty covers
 *    it a second time; counting the card would be a third.
 *  - catalog-inference rows (`excludeFromScore`) — derived from an OEM
 *    interval and an odometer alone, with no record and no mechanic behind
 *    them. Only the five core tiles score by default.
 *
 * Exported so any UI that *describes* the score (the x/y maintenance counter)
 * filters on exactly the same rule the score itself uses, instead of keeping a
 * second definition that drifts.
 */
export function isScorableMaintenanceItem(item: {
  id?: string;
  sourceRecommendationId?: string;
  excludeFromScore?: boolean;
}): boolean {
  if (item.sourceRecommendationId || item.excludeFromScore) return false;
  if (!item.id) return true;
  const type = extractMaintenanceType(item.id);
  // Mechanic-graded minor items (Consolidated model) keep their weight-10
  // deduction — that is the whole point of the model, and the `minor_` prefix
  // only exists on records a mechanic graded yellow or red.
  if (type.startsWith("minor_")) return true;
  // A catalog row the DRIVER answered scores, at the weight of the service
  // itself. Yassin, 2026-09-02: "when a user answers a question for any of the
  // bigger services, we affect the score the same way a mechanic's feedback
  // would — but only if the user actually has an answer for it."
  //
  // The "only if" is carried by `excludeFromScore`, which is checked above:
  // `utils/mergedMaintenance.ts` clears it solely for a definite answer, so an
  // unanswered or "not sure" row still leaves the average entirely rather than
  // being scored as though the passage of time were a finding. That last part
  // is what this gate originally existed to prevent, and it still does.
  if (type === "catalog") return true;
  return SCORING_TYPES.has(type);
}

const STATUS_SCORE: Record<MaintenanceStatus, number> = {
  on_time: 1.0,
  due_soon: 0.7,
  needs_attention: 0.35,
  overdue: 0.1,
  unknown: -1, // sentinel — excluded from average
};

// ============================================================================
// UNKNOWN-ITEM SCORE BY MILEAGE
// ============================================================================



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
/** Points drained from the Warning Lights reserve by the currently-lit
 *  dashboard lights. Exported so UI that displays the reserve uses the same
 *  arithmetic the score does rather than a second, drifting copy. */
export function warningLightPenalty(knownIssues?: string[]): number {
  let penalty = 0;
  for (const light of canonicalWarningLights(knownIssues)) {
    penalty += LIGHT_PENALTY[light] ?? 6;
  }
  return Math.min(penalty, 25);
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/** Director-adjustable outer weights. Upkeep vs. Warning Lights must sum to
 *  100, so only `upkeepWeight` is director-set — Warning Lights is always
 *  `100 - upkeepWeight`. `openIssuePenaltyMax` is a separate, independent
 *  value since it's a subtraction, not part of the 100 base. Both default to
 *  today's shipped values when omitted, so an unconfigured deployment scores
 *  byte-for-byte the same as the hardcoded constants. */
export interface HealthScoreWeights {
  upkeepWeight?: number;
  openIssuePenaltyMax?: number;
}

export interface HealthScoreInput {
  maintenanceItems: MaintenanceItem[];
  odometerMiles: number;
  knownIssues?: string[];
  /** Pipeline-computed health score from vehicle_owners.health_score */
  pipelineHealthScore?: number | null;
  /** Whether the pipeline score is an estimate (quarterly check-in overdue) */
  pipelineIsEstimated?: boolean;
  /** Health Points buffer (0–3). Rewards are paused for now — this field is
   *  kept for compatibility with existing callers and a future rewards
   *  relaunch, but is no longer applied to the score (matches the shared
   *  backend's convex/oto/vehicleHealth.ts, which stopped passing it too —
   *  see the "must agree" contract this file has with Oto's score). */
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
 * Compute the overall 0–100 vehicle health score.
 *
 *   score = maintenance(85%) + safetyReserve(15%) − openIssuePenalty
 *
 * Changes from v1:
 *   1. Maintenance term is a CATEGORY-WEIGHTED average (brakes 25, tires 20,
 *      oil 20, battery 13, inspection 12, other 10) — unchanged. Categories
 *      with no item present effectively redistribute their weight because
 *      they drop out of the denominator. Items with `status: "unknown"`
 *      keep their weight but score with the mileage-aware inference curve.
 *   2. The mileage/usage component is removed entirely (not just zeroed) —
 *      Otopair only scores what a driver can act on; raw mileage never
 *      mapped to a fixable item. The freed 20 points went to maintenance
 *      (65 → 85), not a proportional split.
 *   3. Rewards (`hpBuffer`) are paused — see the HealthScoreInput comment.
 *   4. `upkeepWeight`/`openIssuePenaltyMax` are director-adjustable
 *      (defaulting to 85/15), replacing the previously-hardcoded constants
 *      for these two specifically.
 */
export function computeVehicleHealthScore(
  input: HealthScoreInput,
  weights?: HealthScoreWeights,
): number {
  const { maintenanceItems, odometerMiles, knownIssues } = input;
  const upkeepWeight = weights?.upkeepWeight ?? COMPONENT_WEIGHTS.maintenance * 100;
  const warningLightsWeight = 100 - upkeepWeight;
  const openIssuePenaltyMax = weights?.openIssuePenaltyMax ?? OPEN_ISSUE_PENALTY_MAX;

  // The pipeline score is stored on vehicle_owners for cron/check-in use,
  // but the client always computes its own score so the health ring reacts
  // immediately to stepper answers without waiting for the async pipeline.

  // ── Maintenance component (category-weighted) ─────────────────
  // For each present item, score it and weight it by its category's
  // share. Items we hold no record for ("unknown") are skipped outright —
  // §08: mileage alone never deducts. Categories with no item drop out of
  // the denominator as well — their weight
  // redistributes naturally across the remaining ones. An item with a
  // precomputed `rawScore` (brakes' per-corner blend today) uses that float
  // directly instead of the 4-value STATUS_SCORE lookup.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of maintenanceItems) {
    // Consolidated Upkeep scoring model: a job_recommendations-derived card
    // (sourceRecommendationId set) exists purely to tell the driver and ramp
    // the Open-recs penalty above — it never creates a weighted Upkeep item
    // of its own, for anything, core or minor. Without this skip,
    // categoryWeightForItem can't match a recommendation's `rec-<id>` to a
    // real category and falls it to the generic weight-10 "other" bucket —
    // double-counting the same physical problem the matching core/minor
    // tile already scores, on top of a third time via the Open-recs cap.
    if (!isScorableMaintenanceItem(item)) continue;
    // A type we hold no record for scores nothing and weighs nothing: it
    // leaves the average entirely rather than being guessed at from the
    // odometer. Mileage on its own must never cost points — it matters only
    // through the intervals it makes due on services we DO have records for.
    // The old behaviour ran every unknown through a mileage curve, so a
    // high-mileage car was docked for the absence of data alone.
    if (item.status === "unknown") continue;
    const w = categoryWeightForItem(item);
    const score = item.rawScore ?? STATUS_SCORE[item.status];
    weightedSum += w * score;
    weightTotal += w;
  }
  // No records at all → nothing is known against the driver. The UI already
  // labels this state "Estimated" and asks for service history.
  const maintenanceAvg = weightTotal > 0 ? weightedSum / weightTotal : 1;
  const maintenancePct = maintenanceAvg * 100;

  // ── Warning-light penalty + reserve ────────────────────────────
  const lightPenalty = warningLightPenalty(knownIssues);
  const warningReserve = Math.max(0, warningLightsWeight - lightPenalty);

  // ── Blend (upkeepWeight/warningLightsWeight, default 85/15) ────
  let raw =
    maintenancePct * (upkeepWeight / 100) +
    warningReserve;

  // ── Open-issue penalty (single, capped at openIssuePenaltyMax) ──
  const openIssuePenalty = Math.min(
    openIssuePenaltyMax,
    Math.max(0, input.recPenalty ?? 0),
  );
  raw -= openIssuePenalty;

  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Compute what the health score would be if a specific maintenance item
 * were resolved (status flipped to on_time).
 */
export function computeProjectedHealthScore(
  input: HealthScoreInput,
  fixedItemId: string,
  weights?: HealthScoreWeights,
): number {
  const adjustedItems = input.maintenanceItems.map((item) =>
    item.id === fixedItemId
      ? { ...item, status: 'on_time' as MaintenanceStatus, rawScore: undefined }
      : item
  );
  return computeVehicleHealthScore({ ...input, maintenanceItems: adjustedItems }, weights);
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
export function computeHealthScoreFactors(
  input: HealthScoreInput,
  weights?: HealthScoreWeights,
): {
  positives: HealthFactor[];
  negatives: HealthFactor[];
} {
  const { maintenanceItems, odometerMiles, knownIssues } = input;
  const upkeepWeight = weights?.upkeepWeight ?? COMPONENT_WEIGHTS.maintenance * 100;
  const warningLightsWeight = 100 - upkeepWeight;
  const positives: HealthFactor[] = [];
  const negatives: HealthFactor[] = [];

  // ── Maintenance (upkeepWeight, default 85, weighted by category) ──
  // Each item's share of the maintenance budget = its category weight as a
  // fraction of the *present* category weights. Mirrors the
  // computeVehicleHealthScore math so the breakdown always reconciles —
  // including skipping recommendation-derived cards (Consolidated model:
  // they never create a weighted Upkeep item, only the core/minor tile
  // that already covers the same finding does).
  const scorableItems = maintenanceItems.filter(isScorableMaintenanceItem);
  const knownCount = scorableItems.filter((i) => i.status !== "unknown").length;
  let weightTotal = 0;
  // Same set the score weights: unknowns are excluded there, so counting them
  // here would give every other item a smaller share than it really has and
  // the breakdown would stop reconciling with the headline number.
  for (const item of scorableItems) {
    if (item.status === "unknown") continue;
    weightTotal += categoryWeightForItem(item);
  }
  const maintenanceBudget = upkeepWeight;
  const perWeightUnit = weightTotal > 0 ? maintenanceBudget / weightTotal : 0;

  for (const item of scorableItems) {
    if (item.status === "unknown") continue;
    const itemWeight = categoryWeightForItem(item);
    const itemShare = itemWeight * perWeightUnit;
    const score = item.rawScore ?? STATUS_SCORE[item.status];
    // Confidence hold (Fallback v2 §5): the item is due or overdue, but the
    // interval behind it is a class default, so it raises a recommendation
    // without deducting. It genuinely belongs in neither bucket.
    //
    // Explicit rather than incidental. Without this branch the item still
    // produces nothing — it takes the `else` below, computes (1 - 1.0) = 0 and
    // is swallowed by the `pts <= 0` guard — but only by accident, which is
    // how it would silently regress. This function's contract is that the
    // breakdown reconciles with the headline; honour it deliberately.
    if (item.factorApplied === 1 && item.status !== "on_time") continue;
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

  // Unknowns are deliberately absent from both buckets now. They cost
  // nothing, so listing them under "what's hurting" would report a deduction
  // the score does not apply.

  // ── Warning lights (warningLightsWeight reserve, minus penalty) ──
  // Same canonical, format-agnostic read as warningLightPenalty so the
  // breakdown always reconciles with the score: one negative per active
  // canonical light, sharing the 25-pt running cap. (Previously switched on
  // knownIssues[0] as a sentinel, so a flat/symptom-vocab array silently
  // emitted neither the "No warning lights" positive nor any negative.)
  const activeLights = canonicalWarningLights(knownIssues);
  if (activeLights.length === 0) {
    positives.push({ label: "No warning lights", pts: warningLightsWeight });
  } else {
    let remaining = 25; // matches the cap inside warningLightPenalty
    for (const id of activeLights) {
      const penalty = Math.min(LIGHT_PENALTY[id] ?? 6, remaining);
      if (penalty <= 0) break;
      remaining -= penalty;
      negatives.push({ label: LIGHT_LABELS[id] ?? `Warning light: ${id}`, pts: penalty });
    }
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
