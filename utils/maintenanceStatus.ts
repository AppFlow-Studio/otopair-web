/**
 * maintenanceStatus.ts - Prediction Engine & Maintenance Status Calculation
 *
 * PURPOSE:
 * Computes maintenance status (On Time / Due Soon / Overdue / Unknown / Needs Attention)
 * for user-provided maintenance records based on service intervals (mileage + time).
 *
 * PREDICTION ENGINE:
 * - Mileage-based: Remaining miles ÷ monthly driving average → estimated due date
 * - Time-based: Battery (3-5yr), inspection (12mo flag at 10mo), tires age (5-6yr flag at 4yr)
 * - Hybrid: Whichever comes first between mileage and time
 * - Driving conditions modifier: City -20% oil/brakes, Highway -15% tires
 *
 * Supports per-make overrides (VW vs BMW vs Ford, etc.) and factors in
 * custom inputs like tire pressure, squeaking, and slow starts.
 *
 * USED IN: hooks/useMaintenanceData.ts
 *
 * OWNER: Ahmad Hamoudeh
 */

import type { MaintenanceStatus } from "@/components/cars/MaintenanceTracker";
import { formatMileage } from "@/lib/vehicle-passport";
import { canonicalWarningLights } from "@/lib/warningLightVocab";
import { classInterval, type ClassIntervalOptions } from "@/utils/classIntervals";
import {
  BAND_FACTOR,
  BAND_TO_STATUS,
  appliedFactor,
  ratioToBand,
  type IntervalBand,
  type IntervalSource,
} from "@/utils/intervalBands";
import type { VehicleClass } from "@/utils/vehicleClass";

// ============================================================================
// TYPES
// ============================================================================

export type MaintenanceType =
  | "oil"
  | "brakes"
  | "tires"
  | "inspection"
  | "battery";

/** Display name for each maintenance type */
export const MAINTENANCE_LABELS: Record<MaintenanceType, string> = {
  oil: "Oil Change",
  brakes: "Brakes",
  tires: "Tires",
  inspection: "State Inspection",
  battery: "Battery",
};

/** All maintenance types in display order.
 *  Inspection is excluded — it only appears when a record exists
 *  (e.g. from autoCompleteNewVehicleOnboarding or manual entry). */
export const ALL_MAINTENANCE_TYPES: MaintenanceType[] = [
  "oil",
  "brakes",
  "tires",
  "battery",
];

// ============================================================================
// CONFIRMED HEALTHY (from quarterly check-in Q4b)
// ============================================================================

const CONFIRMED_HEALTHY_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function isConfirmedHealthy(record: MaintenanceRecord, now: number): boolean {
  const confirmedAt = record.confirmedHealthyAt;
  if (!confirmedAt) return false;
  return (now - confirmedAt) < CONFIRMED_HEALTHY_TTL_MS;
}

// ============================================================================
// MONTHLY DRIVING AVERAGE
// ============================================================================

/**
 * Maps the user-selected avgMonthlyDriving label to an approximate
 * number of miles driven per month.
 */
const AVG_MONTHLY_DRIVING_MAP: Record<string, number> = {
  light: 500,    // ~6,000 mi/year
  average: 1000, // ~12,000 mi/year
  heavy: 1500,   // ~18,000 mi/year
};

/** Resolve the user-selected driving level to miles/month. Falls back to 1000.
 *  Exported for `utils/quickCheckAnchor.ts`, which converts a Quick Check date
 *  answer into an odometer reading and must use the same three numbers — a
 *  second copy of the map is a silent drift waiting to happen. */
export function getMonthlyMiles(avgMonthlyDriving?: string): number {
  if (!avgMonthlyDriving) return 1000;
  return AVG_MONTHLY_DRIVING_MAP[avgMonthlyDriving.toLowerCase()] ?? 1000;
}


// ============================================================================
// SERVICE INTERVALS (with per-make overrides)
// ============================================================================

interface ServiceInterval {
  /** Miles between services (null if time-only, like battery) */
  miles: number | null;
  /** Months between services (null if mileage-only) */
  months: number | null;
}

/**
 * OEM interval rows fetched from `service_intervals` via
 * `hooks/useOemServiceIntervals`. Structural type — declared here
 * instead of imported from the Convex query file so this util stays
 * Convex-free (no `Id<>` types leaking in).
 *
 * Keys are taxonomy slugs (`oil_change`, `brake_pad_replacement`,
 * etc.). Missing keys mean "no usable OEM data for this slug" —
 * `getInterval` falls through to MAKE_OVERRIDES → DEFAULT_INTERVALS.
 */
export type OemServiceIntervalsInput = Record<
  string,
  { interval_miles: number | null; interval_months: number | null }
>;

/** Maps a tracker maintenance type onto the taxonomy slug whose OEM
 *  interval represents the same cadence. Intentionally separate from
 *  `lib/maintenanceServiceMapping.ts:MAINTENANCE_TYPE_TO_SLUG` —
 *  that table picks inspection/test variants for the booking flow,
 *  whereas these need to be the actual periodic-service rows the
 *  enrichment writes (e.g. brake-pad replacement IS the brakes
 *  cadence, brake_system_inspection is just a check-in). */
/**
 * Which class-table slug carries each core type's cadence. Deliberately
 * separate from TYPE_TO_OEM_SLUG below: brakes maps to brake PADS here (the
 * wear item the class table prices), while the OEM table keys the same idea
 * under its own slug.
 */
const TYPE_TO_CLASS_SLUG: Partial<Record<MaintenanceType, string>> = {
  oil: "oil_change",
  brakes: "brake_pad_replacement",
  tires: "tire_replacement",
  battery: "battery_replacement",
  inspection: "state_inspection",
};

const TYPE_TO_OEM_SLUG: Partial<Record<MaintenanceType, string>> = {
  oil: "oil_change",
  brakes: "brake_pad_replacement",
  tires: "tire_replacement",
  battery: "battery_replacement",
  inspection: "state_inspection",
};

/** Default intervals — used when no make-specific override exists */
/**
 * What `getInterval` returns: the interval plus where it came from.
 *
 * A structural superset of `ServiceInterval`, so every existing caller that
 * only reads `.miles` / `.months` compiles unchanged — the provenance is
 * opt-in for the callers that need it (the confidence hold does).
 */
/** Vehicle facts the class table needs, bundled so the wrapper chain grows by
 *  one parameter rather than two. */
export interface IntervalClassContext extends ClassIntervalOptions {
  vehicleClass?: VehicleClass | null;
}

export interface ResolvedInterval extends ServiceInterval {
  source: IntervalSource;
}

const DEFAULT_INTERVALS: Record<MaintenanceType, ServiceInterval> = {
  oil: { miles: 5_000, months: 6 },
  brakes: { miles: 40_000, months: 48 },
  tires: { miles: 50_000, months: 60 },
  inspection: { miles: null, months: 12 },
  battery: { miles: null, months: 60 }, // 5 years max; flag/urgent thresholds handled separately
};

/**
 * Per-make interval overrides.
 * Only specify the types that differ from the defaults.
 * Makes are normalized to lowercase for lookup.
 */
const MAKE_OVERRIDES: Record<string, Partial<Record<MaintenanceType, ServiceInterval>>> = {
  // European makes — typically longer oil intervals (synthetic)
  volkswagen: {
    oil: { miles: 10_000, months: 12 },
  },
  audi: {
    oil: { miles: 10_000, months: 12 },
  },
  bmw: {
    oil: { miles: 10_000, months: 12 },
    brakes: { miles: 50_000, months: 48 },
  },
  "mercedes-benz": {
    oil: { miles: 10_000, months: 12 },
    brakes: { miles: 50_000, months: 48 },
  },
  mercedes: {
    oil: { miles: 10_000, months: 12 },
    brakes: { miles: 50_000, months: 48 },
  },
  porsche: {
    oil: { miles: 10_000, months: 12 },
    brakes: { miles: 50_000, months: 48 },
  },
  volvo: {
    oil: { miles: 10_000, months: 12 },
  },
  // Japanese makes — generally shorter, conservative intervals
  toyota: {
    oil: { miles: 5_000, months: 6 },
    tires: { miles: 50_000, months: 60 },
  },
  honda: {
    oil: { miles: 7_500, months: 12 },
  },
  subaru: {
    oil: { miles: 6_000, months: 6 },
  },
  nissan: {
    oil: { miles: 5_000, months: 6 },
  },
  lexus: {
    oil: { miles: 10_000, months: 12 },
  },
  // American makes
  ford: {
    oil: { miles: 7_500, months: 12 },
  },
  chevrolet: {
    oil: { miles: 7_500, months: 12 },
  },
  gmc: {
    oil: { miles: 7_500, months: 12 },
  },
  ram: {
    oil: { miles: 10_000, months: 12 },
  },
  jeep: {
    oil: { miles: 7_500, months: 12 },
  },
  dodge: {
    oil: { miles: 7_500, months: 12 },
  },
  tesla: {
    // EVs: no oil, longer brake life
    oil: { miles: null, months: null },
    brakes: { miles: 100_000, months: 60 },
  },
  // Korean makes
  hyundai: {
    oil: { miles: 7_500, months: 12 },
  },
  kia: {
    oil: { miles: 7_500, months: 12 },
  },
  genesis: {
    oil: { miles: 7_500, months: 12 },
  },
};

/**
 * Driving-condition multipliers.
 * A multiplier < 1 means the interval is *shorter* (harsher conditions).
 *   - City: harder on oil + brakes → reduce intervals by 20%
 *   - Highway: harder on tires → reduce tire interval by 15%
 *   - Mixed: no adjustment
 */
const DRIVING_CONDITION_MULTIPLIERS: Record<string, Partial<Record<MaintenanceType, number>>> = {
  city: { oil: 0.80, brakes: 0.80 },
  highway: { tires: 0.85 },
  mixed: {},
};

/**
 * Get the service interval for a type, respecting OEM enrichment,
 * per-make overrides, and driving conditions.
 *
 * Tier order (locked with Ahmad):
 *  1. OEM intervals from the v3 enrichment pipeline (highest
 *     priority). Already filtered server-side to mechanic_verified
 *     OR confidence >= 0.75 in
 *     `convex/service_intervals_queries.ts`. Half-fallback for
 *     missing axes: e.g. a row with miles but no months keeps the
 *     OEM miles and pulls months from DEFAULT_INTERVALS so the
 *     downstream hybrid math has both numbers to work with.
 *  2. Per-make overrides (`MAKE_OVERRIDES`).
 *  3. Hardcoded `DEFAULT_INTERVALS`.
 *
 * The driving-conditions multiplier applies on top of whichever tier
 * won — that math doesn't care where the base number came from.
 */
function getInterval(
  type: MaintenanceType,
  make?: string,
  drivingConditions?: string,
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): ResolvedInterval {
  const vehicleClass = classCtx?.vehicleClass ?? null;
  const classOptions: ClassIntervalOptions = classCtx ?? {};
  let interval: ServiceInterval;
  let source: IntervalSource;

  // Tier 1 — OEM enrichment (v3 pipeline). Still wins over everything.
  const oemSlug = TYPE_TO_OEM_SLUG[type];
  const oem = oemSlug ? oemIntervals?.[oemSlug] : undefined;
  const classSlug = TYPE_TO_CLASS_SLUG[type];
  const classDefault =
    vehicleClass && classSlug
      ? classInterval(classSlug, vehicleClass, {
          ...classOptions,
          // Tire rotation "follows the oil interval" — resolve it against
          // whatever tier oil actually won, enrichment included, rather than
          // re-deriving the class number.
          resolveFollows: (slug) =>
            slug === "oil_change"
              ? getInterval("oil", make, drivingConditions, oemIntervals, classCtx)
              : null,
        })
      : null;

  if (oem && (oem.interval_miles != null || oem.interval_months != null)) {
    // Half-fallback: one axis from OEM, the other borrowed. Still counts as
    // OEM — the manufacturer data earned whatever deduction follows.
    const fallback = classDefault ?? DEFAULT_INTERVALS[type];
    interval = {
      miles: oem.interval_miles ?? fallback.miles,
      months: oem.interval_months ?? fallback.months,
    };
    source = "oem";
  } else if (classDefault) {
    // Tier 2 — the class default table (Fallback v2 §4). Ahmad's call: this is
    // the DEFAULT, not a fallback, because enrichment is not returning fast
    // enough to rely on. It sits ABOVE the make overrides deliberately — all 23
    // MAKE_OVERRIDES entries carry an `oil` key, so leaving make on top would
    // mean the class table never reaches Toyota, Honda, BMW or Ford, i.e. most
    // of the fleet. It also contradicts them outright (toyota.oil 5000/6 vs
    // Class A 7500/12).
    interval = { ...classDefault };
    source = "class_default";
  } else if (make) {
    // Tier 3 — per-make override. Only reached when no class is known.
    const normalized = make.toLowerCase().trim();
    const overrides = MAKE_OVERRIDES[normalized];
    if (overrides && overrides[type]) {
      interval = { ...overrides[type]! };
      source = "legacy_default";
    } else {
      interval = { ...DEFAULT_INTERVALS[type] };
      source = "legacy_default";
    }
  } else {
    // Tier 4 — the original defaults, as a floor.
    interval = { ...DEFAULT_INTERVALS[type] };
    source = "legacy_default";
  }

  // Driving conditions apply to OUR numbers, never to a manufacturer's.
  // A factory severe-service schedule already accounts for city driving, so
  // discounting it again is unjustified; a generic class bucket genuinely
  // should bend to usage. Ahmad signed this off 2026-08-30 — the visible
  // effect is a city-driven Toyota going from 5000*0.8=4000 to 7500*0.8=6000.
  if (drivingConditions && source !== "oem") {
    const multipliers = DRIVING_CONDITION_MULTIPLIERS[drivingConditions.toLowerCase()];
    if (multipliers) {
      const mult = multipliers[type];
      if (mult != null) {
        if (interval.miles != null) interval.miles = Math.round(interval.miles * mult);
        if (interval.months != null) interval.months = Math.round(interval.months * mult);
      }
    }
  }

  return { ...interval, source };
}

// ============================================================================
// TIRE PRESSURE THRESHOLDS
// ============================================================================

const TIRE_PSI_DANGER = 25;    // Below this = overdue (dangerous)
const TIRE_PSI_LOW = 30;       // Below this = due_soon (low)
const TIRE_PSI_HIGH = 40;      // Above this = due_soon (overinflated)
const TIRE_PSI_DANGER_HIGH = 44; // Above this = overdue (dangerous)

// ============================================================================
// BATTERY THRESHOLDS (from spec)
// ============================================================================

/** Flag battery at 3 years (36 months) */
const BATTERY_FLAG_MONTHS = 36;
/** Urgent at 4.5 years (54 months) */
const BATTERY_URGENT_MONTHS = 54;

// ============================================================================
// STATUS CALCULATION
// ============================================================================

interface MaintenanceRecord {
  type: string;
  lastServiceDate?: number; // Unix timestamp
  lastServiceMileage?: number;
  customInputs?: Record<string, unknown>;
  confirmedHealthyAt?: number;
}

interface StatusResult {
  status: MaintenanceStatus;
  /** 0–100, how far through the interval we are */
  percentUsed: number;
  description: string;
  detail: string;
  /** Estimated date the service will be due (if calculable) */
  estimatedDueDate?: Date;
  /** Miles remaining until service is due */
  milesRemaining?: number;
  /** Months remaining until service is due */
  monthsRemaining?: number;
  /** Precomputed 0–1 score bypassing the status→score lookup — set only
   *  for brakes, when a shop inspection wrote a per-corner blended float
   *  (customInputs.mechanicRawScore). See `applyMechanicGrade`. */
  rawScore?: number;
  /** The spec's four-way band (Quick Check v2 §7 step 4). Distinct from
   *  `status`, which stays the three-value display tier — this is what
   *  separates OVERDUE from SEVERELY OVERDUE for ordering and for the factor. */
  bandStatus?: IntervalBand;
  /** Where the interval came from. Drives the confidence hold. */
  intervalSource?: IntervalSource;
  /** The factor the score actually used, after the hold. Equals
   *  `BAND_FACTOR[bandStatus]` unless a class default is being held at 1.00. */
  factorApplied?: number;
}

// ============================================================================
// MECHANIC-GRADE WORST-OF (shop inspection findings, from convex/lib/
// inspectionHealth.ts's deriveCoreGrades — see convex/inspectionHealthDeferred.ts)
// ============================================================================
//
// A mechanic's pre-job inspection grade (g/y/r) is a second, independent
// signal on top of the calendar/mileage interval above. It can only ever
// make a status WORSE, never better — green is inert, so a healthy
// mechanic grade never rescues an item that's actually overdue by the
// calendar. No "confirmed healthy" promotion happens on this path (that
// stays exclusive to the quarterly check-in / Oto "confirm your oil" flows
// via `isConfirmedHealthy` above).

const STATUS_SEVERITY_ORDER: MaintenanceStatus[] = [
  "on_time",
  "unknown",
  "due_soon",
  "needs_attention",
  "overdue",
];

/** Interval-status → 0–1 score equivalent, mirrors utils/healthScore.ts's
 *  STATUS_SCORE so the brakes rawScore blend compares like-for-like. */
const INTERVAL_SCORE_EQUIVALENT: Partial<Record<MaintenanceStatus, number>> = {
  on_time: 1.0,
  due_soon: 0.7,
  needs_attention: 0.35,
  overdue: 0.1,
};

const MECHANIC_GRADE_STATUS: Record<string, MaintenanceStatus | null> = {
  g: null, // green is inert — never overrides the interval result
  y: "needs_attention",
  r: "overdue",
};

/** A mechanic's grade stops being current the moment a real service is
 *  recorded after it — e.g. oil flagged red pre-job, then actually changed
 *  during the same visit. The deferred job
 *  (convex/inspectionHealthDeferred.ts) can land up to 2 hours after the
 *  visit closes, well after any same-visit service write, so a write-time
 *  guard would race. Reading the two timestamps here instead — the same
 *  "check a timestamp against now/lastServiceDate" pattern
 *  isConfirmedHealthy already uses — is order-independent and
 *  self-correcting. The grade stays in customInputs either way (audit
 *  trail), it just stops being applied.
 *
 *  KNOWN LIMITATION (accepted): `maintenance_records` stores one row per
 *  type, with no per-corner granularity, so a front-only brake job retires
 *  a rear-corner finding too. Left as-is deliberately — the next
 *  inspection re-grades every corner, and per-corner service tracking is a
 *  much larger data-model change than the case warrants. */
function isMechanicGradeStale(record: MaintenanceRecord): boolean {
  const gradedAt = record.customInputs?.mechanicGradedAt as number | undefined;
  return (
    gradedAt != null &&
    record.lastServiceDate != null &&
    record.lastServiceDate > gradedAt
  );
}

/**
 * Worst-of the interval result against a mechanic-submitted inspection
 * grade stored in `customInputs.mechanicGrade`/`mechanicGradeReason` (and,
 * brakes-only, `mechanicRawScore` — the per-corner blended float). Returns
 * `result` unchanged when the grade has been superseded by a real service
 * since (see isMechanicGradeStale), when there's no grade, when the grade
 * is green, or when the grade's status isn't worse than what the interval
 * already produced.
 */
function applyMechanicGrade(result: StatusResult, record: MaintenanceRecord): StatusResult {
  if (isMechanicGradeStale(record)) return result;
  const grade = record.customInputs?.mechanicGrade as string | undefined;
  const gradeStatus = grade ? MECHANIC_GRADE_STATUS[grade] : undefined;

  let graded = result;
  if (gradeStatus) {
    const currentIdx = STATUS_SEVERITY_ORDER.indexOf(result.status);
    const gradeIdx = STATUS_SEVERITY_ORDER.indexOf(gradeStatus);
    if (gradeIdx > currentIdx) {
      const reason = record.customInputs?.mechanicGradeReason as string | undefined;
      graded = {
        ...result,
        status: gradeStatus,
        percentUsed: gradeStatus === "overdue" ? 100 : Math.max(result.percentUsed, 65),
        description: reason ?? result.description,
      };
    }
  }

  // Brakes-only: a precomputed per-corner blended float, min()'d against
  // the interval's own score-equivalent — never lets the mechanic's finding
  // make the score better than the calendar interval alone.
  const mechanicRawScore = record.customInputs?.mechanicRawScore as number | undefined;
  if (typeof mechanicRawScore === "number") {
    const intervalScoreEquivalent = INTERVAL_SCORE_EQUIVALENT[result.status];
    graded = {
      ...graded,
      rawScore:
        intervalScoreEquivalent != null
          ? Math.min(intervalScoreEquivalent, mechanicRawScore)
          : mechanicRawScore,
    };
  }

  return graded;
}

/**
 * Compute maintenance status for a single record.
 *
 * @param record - The maintenance record from DB
 * @param currentOdometer - Current odometer in miles (from user input)
 * @param make - Vehicle make (e.g. "Volkswagen", "BMW") for per-make intervals
 * @param now - Current timestamp (defaults to Date.now())
 * @param drivingConditions - "city" | "highway" | "mixed" — adjusts intervals
 * @param avgMonthlyDriving - "light" | "average" | "heavy" — for date estimation
 */
export function computeMaintenanceStatus(
  record: MaintenanceRecord,
  currentOdometer: number | null,
  make?: string,
  now: number = Date.now(),
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  knownIssues?: string[],
  vehicleYear?: number,
  // OEM intervals from the v3 enrichment pipeline. Passed all the way
  // down to `getInterval` which applies the tier order (OEM → MAKE →
  // DEFAULT). Optional — when undefined, behavior matches pre-v1.
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  const type = record.type as MaintenanceType;

  // Special case: Inspection uses expiration date
  if (type === "inspection") {
    return computeInspectionStatus(record, now);
  }

  // Special case: Tires — factor in tire pressure custom inputs
  if (type === "tires") {
    return computeTireStatus(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, knownIssues, vehicleYear, oemIntervals, classCtx);
  }

  // Special case: Brakes — factor in symptoms + warning light
  if (type === "brakes") {
    return computeBrakeStatus(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, knownIssues, oemIntervals, classCtx);
  }

  // Special case: Battery — time-based with specific thresholds + slow starts
  if (type === "battery") {
    return computeBatteryStatus(record, make, now, knownIssues, oemIntervals, classCtx);
  }

  // Generic: Oil (hybrid mileage + time, whichever comes first)
  return computeOilStatus(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, knownIssues, oemIntervals, classCtx);
}

// FROM-ODOMETER INFERENCE section deliberately NOT ported from mobile.
// The `interface FromOdometerInput` + `computeFromOdometerStatus` export
// exist to serve the catalog-coverage pass in utils/mergedMaintenance.ts,
// and web's mergedMaintenance.ts has no such consumer (§6 of the mobile-
// side port request). Pulling this primitive in would widen the module
// surface with no reader. When a web-side path needs it, port from mobile
// at that time — the function is self-contained.

// ============================================================================
// OIL STATUS (hybrid + warning light escalation)
// ============================================================================

function computeOilStatus(
  record: MaintenanceRecord,
  currentOdometer: number | null,
  make: string | undefined,
  now: number,
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  knownIssues?: string[],
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  const interval = computeHybridStatus("oil", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals, classCtx);
  const result = applyMechanicGrade(interval, record);

  // Confirmed healthy (Q4b) overrides both interval and warning-light escalation
  // because the user explicitly said "all good" in the same check-in that asks about lights
  if (isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  if (canonicalWarningLights(knownIssues).includes("oil_pressure")) {
    return escalateForWarningLight(result, "Oil pressure warning light active — service urgently needed");
  }

  // F1 fix (2026-05-18): never downgrade "unknown" to "due_soon" — that's
  // fabricating a service-due claim with no anchor. When oil has no recorded
  // service data, surface that honestly. Oto's prompt rule reads `status:
  // "unknown"` and prompts the user to add the record (see prompt/stable.ts
  // "Service History" section).
  if (result.status === "unknown") {
    const recency = record.customInputs?.recency as string | undefined;
    if (recency === "not_sure") {
      return { status: "unknown", percentUsed: 0, description: "Oil change history not on file", detail: "Not on file" };
    }
    return { status: "unknown", percentUsed: 0, description: "No oil change history on file", detail: "Not on file" };
  }

  return result;
}

function escalateForWarningLight(result: StatusResult, description: string): StatusResult {
  // Warning lights are assertive "act-now" signals per Yassin v1.1 §3.2.
  // Escalate straight to `overdue` with percentUsed=100 so items with a
  // paired light land in urgency tier "now" (for weight ≥20 categories:
  // oil / tires / brakes / warning). A base-status already at overdue
  // stays overdue but gets the warning-light copy prepended.
  const currentIdx = STATUS_SEVERITY_ORDER.indexOf(result.status);
  const targetIdx = STATUS_SEVERITY_ORDER.indexOf("overdue");
  if (currentIdx < targetIdx) {
    return { ...result, status: "overdue", description, percentUsed: 100 };
  }
  // Already at overdue — preserve the original percentUsed. Clamping to 100
  // would collapse "wildly overdue" (e.g. 130%) into "just crossed," and
  // downstream urgency sort ranks by percentUsed.
  return { ...result, description: `${description} · ${result.description}` };
}

// ============================================================================
// GENERIC HYBRID (mileage OR time, whichever comes first)
// ============================================================================

function computeHybridStatus(
  type: MaintenanceType,
  record: MaintenanceRecord,
  currentOdometer: number | null,
  make: string | undefined,
  now: number,
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  const interval = getInterval(type, make, drivingConditions, oemIntervals, classCtx);

  // No interval defined (e.g. Tesla oil)
  if (!interval.miles && !interval.months) {
    return { status: "on_time", percentUsed: 0, description: "Not applicable for this vehicle", detail: "N/A" };
  }

  // No service data at all → unknown
  if (!record.lastServiceDate && !record.lastServiceMileage) {
    return { status: "unknown", percentUsed: 0, description: "No service history", detail: "Unknown" };
  }

  const monthlyMiles = getMonthlyMiles(avgMonthlyDriving);

  // === Mileage-based calculation ===
  let mileageRatio = 0;
  let milesRemaining: number | undefined;
  let mileageDueDate: Date | undefined;

  if (interval.miles && record.lastServiceMileage != null && currentOdometer != null) {
    const milesSince = currentOdometer - record.lastServiceMileage;
    mileageRatio = milesSince / interval.miles;
    milesRemaining = Math.max(0, interval.miles - milesSince);

    // Estimate due date: remaining miles ÷ monthly driving → months from now
    if (milesRemaining > 0 && monthlyMiles > 0) {
      const monthsUntilDue = milesRemaining / monthlyMiles;
      mileageDueDate = new Date(now + monthsUntilDue * 30.44 * 24 * 60 * 60 * 1000);
    } else if (milesRemaining === 0) {
      mileageDueDate = new Date(now); // Due now
    }
  }

  // === Time-based calculation ===
  let timeRatio = 0;
  let monthsRemaining: number | undefined;
  let timeDueDate: Date | undefined;

  if (interval.months && record.lastServiceDate) {
    const msSince = now - record.lastServiceDate;
    const monthsSince = msSince / (1000 * 60 * 60 * 24 * 30.44);
    timeRatio = monthsSince / interval.months;
    monthsRemaining = Math.max(0, Math.round(interval.months - monthsSince));

    if (monthsRemaining > 0) {
      timeDueDate = new Date(record.lastServiceDate + interval.months * 30.44 * 24 * 60 * 60 * 1000);
    } else {
      timeDueDate = new Date(now); // Due now
    }
  }

  // Hybrid: whichever comes first
  const ratio = Math.max(mileageRatio, timeRatio);
  const percentUsed = Math.min(Math.round(ratio * 100), 100);

  // Quick Check v2 §7 step 4. The band carries the spec's four-way split;
  // `status` stays the three-value display value the tracker renders, so
  // needs_attention keeps meaning "a human graded this yellow".
  const band = ratioToBand(ratio);
  const status = BAND_TO_STATUS[band];

  // The conservative rule: a class default may raise a recommendation at 1.0x
  // but must not deduct until 1.5x. `confirmed` is left false here — the
  // per-type wrappers layer a mechanic grade on afterwards, and a "Never"
  // answer arrives as a real anchor rather than a flag on this path.
  const factorApplied = appliedFactor({ band, intervalSource: interval.source });

  // Pick the earliest due date
  let estimatedDueDate: Date | undefined;
  if (mileageDueDate && timeDueDate) {
    estimatedDueDate = mileageDueDate < timeDueDate ? mileageDueDate : timeDueDate;
  } else {
    estimatedDueDate = mileageDueDate ?? timeDueDate;
  }

  const description = buildHybridDescription(
    record, currentOdometer, interval, monthlyMiles, now, milesRemaining, monthsRemaining, estimatedDueDate
  );
  const detail = buildDetail(record.lastServiceDate);

  return {
    status,
    percentUsed,
    description,
    detail,
    estimatedDueDate,
    milesRemaining,
    monthsRemaining,
    bandStatus: band,
    intervalSource: interval.source,
    factorApplied,
    // Only set rawScore when the hold actually suppresses something. Leaving
    // it undefined otherwise keeps STATUS_SCORE[status] as the single source
    // for the ordinary case, and avoids shadowing the brakes per-corner blend
    // that applyMechanicGrade writes into this same field.
    ...(factorApplied !== BAND_FACTOR[band] ? { rawScore: factorApplied } : {}),
  };
}

// ============================================================================
// TYPE-SPECIFIC CALCULATORS
// ============================================================================

function computeTireStatus(
  record: MaintenanceRecord,
  currentOdometer: number | null,
  make: string | undefined,
  now: number,
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  knownIssues?: string[],
  vehicleYear?: number,
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  if (isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  const core = computeTireStatusCore(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, vehicleYear, oemIntervals, classCtx);
  // Mechanic-grade worst-of (tread + wear only — PSI stays a separate,
  // pre-existing client signal, not part of the shop-inspection grade).
  const result = applyMechanicGrade(core, record);

  if (canonicalWarningLights(knownIssues).includes("tpms")) {
    return escalateForWarningLight(result, "Tire pressure (TPMS) warning light active — check tires soon");
  }

  return result;
}

function computeTireStatusCore(
  record: MaintenanceRecord,
  currentOdometer: number | null,
  make: string | undefined,
  now: number,
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  vehicleYear?: number,
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  const tp = record.customInputs?.tirePressure as Record<string, number | null> | undefined;

  // Check tire pressure first — this is an immediate safety concern
  if (tp) {
    const pressures = [tp.fl, tp.fr, tp.rl, tp.rr].filter((v): v is number => v != null && v > 0);

    if (pressures.length > 0) {
      const minPsi = Math.min(...pressures);
      const maxPsi = Math.max(...pressures);
      const lowCount = pressures.filter((p) => p < TIRE_PSI_LOW).length;
      const dangerLowCount = pressures.filter((p) => p < TIRE_PSI_DANGER).length;
      const highCount = pressures.filter((p) => p > TIRE_PSI_HIGH).length;
      const dangerHighCount = pressures.filter((p) => p > TIRE_PSI_DANGER_HIGH).length;

      // Dangerously low or high (any tire)
      if (dangerLowCount > 0 || dangerHighCount > 0) {
        return {
          status: "overdue",
          percentUsed: 100,
          description: dangerLowCount > 0
            ? `Dangerously low tire pressure (${minPsi} PSI)`
            : `Dangerously high tire pressure (${maxPsi} PSI)`,
          detail: `${minPsi} PSI`,
        };
      }

      // Multiple tires low or high → due_soon
      if (lowCount >= 3 || highCount >= 3) {
        return {
          status: "due_soon",
          percentUsed: 85,
          description: lowCount >= 3
            ? `${lowCount} tires low (${minPsi} PSI)`
            : `${highCount} tires over-inflated (${maxPsi} PSI)`,
          detail: `${minPsi} PSI`,
        };
      }

      // 1-2 tires slightly low or high → needs_attention
      if (lowCount > 0 || highCount > 0) {
        return {
          status: "needs_attention",
          percentUsed: 65,
          description: lowCount > 0
            ? `${lowCount} tire${lowCount > 1 ? "s" : ""} low (${minPsi} PSI)`
            : `${highCount} tire${highCount > 1 ? "s" : ""} over-inflated (${maxPsi} PSI)`,
          detail: `${minPsi} PSI`,
        };
      }

      // All tires in range — if no interval data, just report OK
      if (!record.lastServiceDate && !record.lastServiceMileage) {
        return {
          status: "on_time",
          percentUsed: 20,
          description: `All tires in range (${minPsi}–${maxPsi} PSI)`,
          detail: `${minPsi}–${maxPsi} PSI`,
        };
      }
    }
  }

  // Confirmed healthy via check-in → on_time (tire pressure safety checks above still take priority)
  if (isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  // Quick Read fields
  const tireReplaced = record.customInputs?.tireReplaced as string | undefined;
  const tireRepaired = record.customInputs?.tireRepaired as string | undefined;

  // Original tires are as old as the car. If the user said "original" but
  // gave no service date, infer the install point from the model year
  // (Jan 1, 0 mi) so the age + mileage checks below produce a real status
  // (e.g. a 2024 reads healthy) instead of falling back to "age unknown".
  if (
    tireReplaced === "original" &&
    !record.lastServiceDate &&
    !record.lastServiceMileage &&
    vehicleYear
  ) {
    record = {
      ...record,
      lastServiceDate: new Date(vehicleYear, 0, 1).getTime(),
      lastServiceMileage: 0,
    };
  }

  // Quick Read: the driver answered "I'm not sure" to when the tires were
  // last replaced. That is an absence of information, not a finding. It used
  // to return `due_soon` / "Tire condition uncertain — inspection
  // recommended", which cost 26 points on a car where nothing about the tires
  // was ever reported — the driver was penalised for admitting they didn't
  // know. Same fix the battery path took on 2026-05-18 ("not_sure used to
  // fabricate a due_soon urgency with no anchor"); tires was missed then
  // because the stepper stores this answer under a different id.
  if (tireReplaced === "dont_know" && !record.lastServiceDate && !record.lastServiceMileage && !tp) {
    return {
      status: "unknown",
      percentUsed: 0,
      description: "Tire service history not on file",
      detail: "Not on file",
    };
  }

  // Quick Read: original tires with no service date → recommend inspection
  if (tireReplaced === "original" && !record.lastServiceDate && !record.lastServiceMileage && !tp) {
    return {
      status: "needs_attention",
      percentUsed: 60,
      description: "Original tires — age unknown, inspection recommended",
      detail: "Check soon",
    };
  }

  // Fall through to interval-based check (tire replacement age/mileage)
  if (!record.lastServiceDate && !record.lastServiceMileage) {
    if (tireReplaced === "replaced") {
      return { status: "on_time", percentUsed: 10, description: "Tires replaced — no service date on file", detail: "On time" };
    }
    // F1 fix (2026-05-18): no data + no symptoms + no confirmation ≠ "on time".
    // Surface honestly as "unknown" so Oto can prompt the user to add a record.
    return { status: "unknown", percentUsed: 0, description: "No tire service history on file", detail: "Not on file" };
  }

  // Tire age: flag at 4 years (48 months) for inspection, overdue at 6 years (72 months)
  if (record.lastServiceDate) {
    const msSince = now - record.lastServiceDate;
    const monthsSince = msSince / (1000 * 60 * 60 * 24 * 30.44);

    if (monthsSince >= 72) {
      return {
        status: "overdue",
        percentUsed: 100,
        description: "Tires over 6 years old — replacement recommended",
        detail: formatRelativeTime(record.lastServiceDate, now),
      };
    }
    if (monthsSince >= 48) {
      return {
        status: "due_soon",
        percentUsed: 80,
        description: `Tires ${Math.round(monthsSince / 12)} years old — inspection recommended`,
        detail: formatRelativeTime(record.lastServiceDate, now),
      };
    }
  }

  // Quick Check v2: "losing air" is a live symptom, and the v1 vocabulary has
  // no field for it — `tireRepaired` means a puncture was already patched,
  // which is a different thing with different copy. Handled the same way
  // though: a symptom outranks a healthy interval, because a tire that is
  // losing air now does not care how new it is.
  const tireSymptom = record.customInputs?.symptom as string | undefined;
  if (tireSymptom === "losing_air" || tireSymptom === "vibration") {
    const intervalResult = record.lastServiceDate
      ? computeHybridStatus("tires", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals, classCtx)
      : null;
    const label = tireSymptom === "losing_air" ? "Losing air" : "Vibration";
    const worstStatus: MaintenanceStatus =
      intervalResult && (intervalResult.status === "overdue" || intervalResult.status === "due_soon")
        ? intervalResult.status
        : "needs_attention";
    return {
      status: worstStatus,
      percentUsed: Math.max(60, intervalResult?.percentUsed ?? 0),
      description: intervalResult
        ? `${label} · ${intervalResult.description}`
        : `${label} — inspection recommended`,
      detail: "Check soon",
    };
  }

  // Quick Read: patched/plugged tire — flag regardless of interval status
  if (tireRepaired === "yes") {
    const intervalResult = record.lastServiceDate
      ? computeHybridStatus("tires", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals, classCtx)
      : null;
    const worstStatus: MaintenanceStatus =
      intervalResult && (intervalResult.status === "overdue" || intervalResult.status === "due_soon")
        ? intervalResult.status
        : "needs_attention";
    const desc = intervalResult
      ? `Patched/plugged tire · ${intervalResult.description}`
      : "Patched/plugged tire — inspection recommended";
    return {
      status: worstStatus,
      percentUsed: Math.max(intervalResult?.percentUsed ?? 60, 60),
      description: desc,
      detail: record.lastServiceDate ? formatRelativeTime(record.lastServiceDate, now) : "Check soon",
    };
  }

  // Standard hybrid interval (mileage + time)
  return computeHybridStatus("tires", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals, classCtx);
}

function computeBrakeStatus(
  record: MaintenanceRecord,
  currentOdometer: number | null,
  make: string | undefined,
  now: number,
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  knownIssues?: string[],
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  // Confirmed healthy overrides both interval and warning-light escalation
  if (isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  const core = computeBrakeStatusCore(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals, classCtx);
  // Mechanic-grade worst-of + the per-corner blended rawScore (brakes-only —
  // see applyMechanicGrade). Symptom-based logic inside computeBrakeStatusCore
  // (brakeFeel/squeaking) is a separate, pre-existing client signal.
  const result = applyMechanicGrade(core, record);

  if (canonicalWarningLights(knownIssues).includes("abs")) {
    return escalateForWarningLight(result, "ABS / brake warning light active — have brakes inspected soon");
  }

  return result;
}

function computeBrakeStatusCore(
  record: MaintenanceRecord,
  currentOdometer: number | null,
  make: string | undefined,
  now: number,
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  // Legacy field OR Quick Read brakeFeel → unified symptom flags
  const brakeFeel = record.customInputs?.brakeFeel as string | undefined;
  const squeaking = record.customInputs?.squeaking === true || brakeFeel === "squeak" || brakeFeel === "noise";
  const softSlow = brakeFeel === "soft_slow";
  const hasSymptom = squeaking || softSlow;

  const symptomLabel = softSlow
    ? "Soft/spongy pedal"
    : "Squeaking/grinding";

  // First compute interval-based status
  const hasIntervalData = !!record.lastServiceDate || !!record.lastServiceMileage;
  let intervalStatus: MaintenanceStatus = "unknown";
  let intervalRatio = 0;
  let intervalDescription = "No brake service history";

  if (hasIntervalData) {
    const hybrid = computeHybridStatus("brakes", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals, classCtx);
    intervalRatio = hybrid.percentUsed / 100;
    intervalDescription = hybrid.description;
    intervalStatus = hybrid.status;
  }

  // soft_slow is a safety signal — always at least overdue when interval is concerning
  if (softSlow && (intervalStatus === "due_soon" || intervalStatus === "overdue" || !hasIntervalData)) {
    const desc = record.lastServiceDate
      ? `${symptomLabel} reported · Last replaced ${formatRelativeTime(record.lastServiceDate, now)}`
      : "Soft/spongy brake pedal — inspection needed urgently";
    return {
      status: "overdue",
      percentUsed: 100,
      description: desc,
      detail: record.lastServiceDate ? formatRelativeTime(record.lastServiceDate, now) : "Check now",
    };
  }

  // Symptom + interval already due_soon or overdue → overdue
  if (hasSymptom && (intervalStatus === "due_soon" || intervalStatus === "overdue")) {
    const desc = record.lastServiceDate
      ? `${symptomLabel} reported · Last replaced ${formatRelativeTime(record.lastServiceDate, now)}`
      : `${symptomLabel} reported — inspection needed`;
    return {
      status: "overdue",
      percentUsed: 100,
      description: desc,
      detail: record.lastServiceDate ? formatRelativeTime(record.lastServiceDate, now) : "Check now",
    };
  }

  // Symptom but interval is fine → needs_attention
  if (hasSymptom) {
    const desc = hasIntervalData
      ? `${symptomLabel} reported · ${intervalDescription}`
      : `${symptomLabel} reported — inspection recommended`;
    return {
      status: "needs_attention",
      percentUsed: Math.max(65, Math.min(Math.round(intervalRatio * 100), 100)),
      description: desc,
      detail: record.lastServiceDate ? formatRelativeTime(record.lastServiceDate, now) : "Check soon",
    };
  }

  // No symptoms, confirmed healthy via check-in → on_time
  if (!hasSymptom && isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  // F1 fix (2026-05-18): without interval data we can't claim health.
  // But an explicit "Fine" self-report IS input — surface it as such
  // instead of pretending nothing was reported. Status stays "unknown"
  // so Oto still prompts the user to add a service date.
  if (!hasIntervalData) {
    if (brakeFeel === "fine") {
      return {
        status: "unknown",
        percentUsed: 0,
        description: "Brakes feel fine — no issues reported",
        detail: "Reported fine",
      };
    }
    return { status: "unknown", percentUsed: 0, description: "No brake service history on file", detail: "Not on file" };
  }

  // Return the hybrid result
  return computeHybridStatus("brakes", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals, classCtx);
}

function computeBatteryStatus(
  record: MaintenanceRecord,
  make: string | undefined,
  now: number,
  knownIssues?: string[],
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  const interval = computeBatteryStatusInterval(record, make, now, knownIssues, oemIntervals, classCtx);
  return applyMechanicGrade(interval, record);
}

function computeBatteryStatusInterval(
  record: MaintenanceRecord,
  make: string | undefined,
  now: number,
  knownIssues?: string[],
  oemIntervals?: OemServiceIntervalsInput,
  classCtx?: IntervalClassContext,
): StatusResult {
  // Confirmed healthy overrides both interval and warning-light escalation
  if (isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  const hasWarningLight = canonicalWarningLights(knownIssues).includes("battery_charging");

  if (!record.lastServiceDate) {
    if (hasWarningLight) {
      return {
        status: "needs_attention",
        percentUsed: 75,
        description: "Battery/charging warning light active — have it tested soon",
        detail: "Warning light",
      };
    }
    const batteryReplaced = record.customInputs?.batteryReplaced as string | undefined;
    if (batteryReplaced === "yes") {
      return { status: "on_time", percentUsed: 10, description: "Battery replaced — no date on file", detail: "On time" };
    }
    // F1 fix (2026-05-18): "not_sure" used to fabricate a `due_soon` urgency
    // with no anchor — and the empty-record default claimed "no concerns"
    // when really we have no data. Both become "unknown" so Oto prompts the
    // user to confirm rather than asserting either way.
    if (batteryReplaced === "not_sure") {
      return { status: "unknown", percentUsed: 0, description: "Battery service history not on file", detail: "Not on file" };
    }
    return { status: "unknown", percentUsed: 0, description: "No battery service history on file", detail: "Not on file" };
  }

  const msSince = now - record.lastServiceDate;
  const monthsSince = msSince / (1000 * 60 * 60 * 24 * 30.44);

  // Battery thresholds from spec:
  // Flag at 3 years (36 months), urgent at 4.5 years (54 months), max ~5 years (60 months)
  const interval = getInterval("battery", make, undefined, oemIntervals, classCtx);
  const maxMonths = interval.months ?? 60;

  // Pure age-based
  if (monthsSince >= BATTERY_URGENT_MONTHS) {
    // 4.5+ years → overdue. Round the age so copy reads human, not
    // machine-generated ("Battery is about 25 years old" vs 25.5).
    const yearsOld = Math.round(monthsSince / 12);
    return {
      status: "overdue",
      percentUsed: 100,
      description: `Battery is about ${yearsOld} years old — replacement recommended`,
      detail: formatRelativeTime(record.lastServiceDate, now),
    };
  }

  if (monthsSince >= BATTERY_FLAG_MONTHS) {
    // 3–4.5 years → due_soon
    const monthsLeft = Math.max(0, Math.round(BATTERY_URGENT_MONTHS - monthsSince));
    return {
      status: "due_soon",
      percentUsed: Math.min(Math.round((monthsSince / maxMonths) * 100), 95),
      description: `Battery ${Math.round(monthsSince / 12)} years old · ~${monthsLeft} months until replacement`,
      detail: formatRelativeTime(record.lastServiceDate, now),
      monthsRemaining: monthsLeft,
      estimatedDueDate: new Date(record.lastServiceDate + BATTERY_URGENT_MONTHS * 30.44 * 24 * 60 * 60 * 1000),
    };
  }

  // Under 3 years → on_time
  const percentUsed = Math.min(Math.round((monthsSince / BATTERY_FLAG_MONTHS) * 100), 100);
  const monthsLeft = Math.max(0, Math.round(BATTERY_FLAG_MONTHS - monthsSince));
  let description: string;
  if (monthsLeft <= 3) {
    description = `Battery check recommended in ~${monthsLeft} months`;
  } else if (monthsLeft > 12) {
    description = "In good standing";
  } else {
    description = `~${monthsLeft} months until check-up`;
  }

  const baseResult: StatusResult = {
    status: "on_time",
    percentUsed,
    description,
    detail: formatRelativeTime(record.lastServiceDate, now),
    monthsRemaining: monthsLeft,
    estimatedDueDate: new Date(record.lastServiceDate + BATTERY_FLAG_MONTHS * 30.44 * 24 * 60 * 60 * 1000),
  };

  if (hasWarningLight) {
    return escalateForWarningLight(baseResult, "Battery/charging warning light active — have it tested soon");
  }

  return baseResult;
}

// ============================================================================
// INSPECTION (time-based, flag at 10 months)
// ============================================================================

function computeInspectionStatus(record: MaintenanceRecord, now: number): StatusResult {
  const expiration = record.customInputs?.expirationDate as number | undefined;

  if (!expiration) {
    if (!record.lastServiceDate) {
      return {
        status: "unknown",
        percentUsed: 0,
        description: "No inspection data",
        detail: "Unknown",
      };
    }
    // User provided a service date but no expiration — don't fabricate one
    return {
      status: "on_time",
      percentUsed: 0,
      description: `Last inspected ${formatRelativeTime(record.lastServiceDate, now)}`,
      detail: formatRelativeTime(record.lastServiceDate, now),
    };
  }

  const lastService = record.lastServiceDate || expiration - 12 * 30.44 * 24 * 60 * 60 * 1000;
  return computeInspectionFromExpiration(lastService, expiration, now);
}

function computeInspectionFromExpiration(
  lastService: number,
  expiration: number,
  now: number
): StatusResult {
  const totalWindow = expiration - lastService;
  const elapsed = now - lastService;
  const ratio = totalWindow > 0 ? elapsed / totalWindow : 1;
  const percentUsed = Math.min(Math.round(ratio * 100), 100);

  const daysLeft = Math.max(0, Math.ceil((expiration - now) / (1000 * 60 * 60 * 24)));
  const monthsLeft = Math.max(0, Math.round(daysLeft / 30.44));

  let status: MaintenanceStatus;
  if (now > expiration) {
    status = "overdue";
  } else if (monthsLeft <= 2) {
    // Flag at 10 months (= 2 months remaining out of 12)
    status = "due_soon";
  } else {
    // Same bands as everything else. Inspection's own expiry branches above
    // take precedence; this only covers the "plenty of time left" middle.
    status = BAND_TO_STATUS[ratioToBand(ratio)];
  }

  const detail = formatShortDate(expiration);
  const description =
    status === "overdue"
      ? "Inspection expired"
      : daysLeft <= 30
        ? `Inspection expires in ${daysLeft} days`
        : `Expires ${detail} (${monthsLeft} months left)`;

  return {
    status,
    percentUsed,
    description,
    detail,
    estimatedDueDate: new Date(expiration),
    monthsRemaining: monthsLeft,
  };
}

// ============================================================================
// SHARED HELPERS
// ============================================================================


/**
 * Build a human-readable description for hybrid (mileage + time) services.
 * Includes estimated due date when calculable.
 */
function buildHybridDescription(
  record: MaintenanceRecord,
  currentOdometer: number | null,
  interval: ServiceInterval,
  monthlyMiles: number,
  now: number,
  milesRemaining?: number,
  monthsRemaining?: number,
  estimatedDueDate?: Date
): string {
  const parts: string[] = [];

  // Mileage info with prediction
  if (interval.miles && record.lastServiceMileage != null && currentOdometer != null && milesRemaining != null) {
    if (milesRemaining <= 0) {
      parts.push("Mileage interval reached");
    } else {
      parts.push(`${milesRemaining.toLocaleString()} mi remaining`);
    }
  }

  // Time info
  if (interval.months && record.lastServiceDate && monthsRemaining != null) {
    if (monthsRemaining <= 0) {
      parts.push("Time interval reached");
    } else if (monthsRemaining <= 1) {
      parts.push("due this month");
    } else if (monthsRemaining > 12) {
      parts.push("In good standing");
    } else {
      parts.push(`${monthsRemaining} months remaining`);
    }
  }

  // Estimated due date
  if (estimatedDueDate && estimatedDueDate.getTime() > now) {
    const daysUntil = Math.ceil((estimatedDueDate.getTime() - now) / (1000 * 60 * 60 * 24));
    if (daysUntil <= 7) {
      parts.push(`Due in ~${daysUntil} day${daysUntil !== 1 ? "s" : ""}`);
    } else if (daysUntil <= 60) {
      const weeks = Math.round(daysUntil / 7);
      parts.push(`Due in ~${weeks} week${weeks !== 1 ? "s" : ""}`);
    }
    // For longer timeframes, the months remaining already covers it
  }

  if (parts.length === 0) {
    return record.lastServiceDate ? `Last serviced ${formatRelativeTime(record.lastServiceDate)}` : "No data";
  }

  return parts.join(" · ");
}

function buildDetail(lastServiceDate?: number): string {
  if (!lastServiceDate) return "Unknown";
  return formatRelativeTime(lastServiceDate);
}

/**
 * Human-friendly relative time: "~2 weeks ago", "~3 months ago", "~2 years ago".
 * Used for estimated service dates so we don't display a fake-precise "Jan 2025".
 */
function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const ms = now - timestamp;
  if (ms < 0) return "Recently";
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (days < 7) return "This week";
  if (days < 30) {
    const weeks = Math.round(days / 7);
    return `~${weeks} week${weeks !== 1 ? "s" : ""} ago`;
  }
  const months = Math.round(days / 30.44);
  if (months < 12) return `~${months} month${months !== 1 ? "s" : ""} ago`;
  const years = +(months / 12).toFixed(1);
  if (years <= 1) return "~1 year ago";
  return `~${years % 1 === 0 ? Math.round(years) : years} years ago`;
}

/** Calendar format — only used for inspection expiration dates (user-selected). */
function formatShortDate(timestamp: number): string {
  const d = new Date(timestamp);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}
