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
import { canonicalWarningLights } from "@/lib/warningLightVocab";

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

/** Resolve the user-selected driving level to miles/month. Falls back to 1000. */
function getMonthlyMiles(avgMonthlyDriving?: string): number {
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
const TYPE_TO_OEM_SLUG: Partial<Record<MaintenanceType, string>> = {
  oil: "oil_change",
  brakes: "brake_pad_replacement",
  tires: "tire_replacement",
  battery: "battery_replacement",
  inspection: "state_inspection",
};

/** Default intervals — used when no make-specific override exists */
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
): ServiceInterval {
  let interval: ServiceInterval;

  // Tier 1 — OEM enrichment (v3 pipeline).
  const oemSlug = TYPE_TO_OEM_SLUG[type];
  const oem = oemSlug ? oemIntervals?.[oemSlug] : undefined;
  if (oem && (oem.interval_miles != null || oem.interval_months != null)) {
    interval = {
      miles: oem.interval_miles ?? DEFAULT_INTERVALS[type].miles,
      months: oem.interval_months ?? DEFAULT_INTERVALS[type].months,
    };
  } else if (make) {
    // Tier 2 — per-make override.
    const normalized = make.toLowerCase().trim();
    const overrides = MAKE_OVERRIDES[normalized];
    if (overrides && overrides[type]) {
      interval = { ...overrides[type]! };
    } else {
      // Tier 3 — default.
      interval = { ...DEFAULT_INTERVALS[type] };
    }
  } else {
    // Tier 3 — default (no make signal).
    interval = { ...DEFAULT_INTERVALS[type] };
  }

  // Apply driving conditions multiplier
  if (drivingConditions) {
    const multipliers = DRIVING_CONDITION_MULTIPLIERS[drivingConditions.toLowerCase()];
    if (multipliers) {
      const mult = multipliers[type];
      if (mult != null) {
        if (interval.miles != null) interval.miles = Math.round(interval.miles * mult);
        if (interval.months != null) interval.months = Math.round(interval.months * mult);
      }
    }
  }

  return interval;
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
): StatusResult {
  const type = record.type as MaintenanceType;

  // Special case: Inspection uses expiration date
  if (type === "inspection") {
    return computeInspectionStatus(record, now);
  }

  // Special case: Tires — factor in tire pressure custom inputs
  if (type === "tires") {
    return computeTireStatus(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, knownIssues, vehicleYear, oemIntervals);
  }

  // Special case: Brakes — factor in symptoms + warning light
  if (type === "brakes") {
    return computeBrakeStatus(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, knownIssues, oemIntervals);
  }

  // Special case: Battery — time-based with specific thresholds + slow starts
  if (type === "battery") {
    return computeBatteryStatus(record, make, now, knownIssues, oemIntervals);
  }

  // Generic: Oil (hybrid mileage + time, whichever comes first)
  return computeOilStatus(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, knownIssues, oemIntervals);
}

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
): StatusResult {
  const result = computeHybridStatus("oil", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals);

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
  const SEVERITY_ORDER: MaintenanceStatus[] = ["on_time", "unknown", "due_soon", "needs_attention", "overdue"];
  const currentIdx = SEVERITY_ORDER.indexOf(result.status);
  const targetIdx = SEVERITY_ORDER.indexOf("needs_attention");
  if (currentIdx < targetIdx) {
    return { ...result, status: "needs_attention", description, percentUsed: Math.max(result.percentUsed, 75) };
  }
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
): StatusResult {
  const interval = getInterval(type, make, drivingConditions, oemIntervals);

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
  const status = ratioToStatus(ratio);

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

  return { status, percentUsed, description, detail, estimatedDueDate, milesRemaining, monthsRemaining };
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
): StatusResult {
  if (isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  const result = computeTireStatusCore(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, vehicleYear, oemIntervals);

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

  // Quick Read: user doesn't know tire status — flag for attention
  if (tireReplaced === "dont_know" && !record.lastServiceDate && !record.lastServiceMileage && !tp) {
    return {
      status: "due_soon",
      percentUsed: 50,
      description: "Tire condition uncertain — inspection recommended",
      detail: "Check soon",
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

  // Quick Read: patched/plugged tire — flag regardless of interval status
  if (tireRepaired === "yes") {
    const intervalResult = record.lastServiceDate
      ? computeHybridStatus("tires", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals)
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
  return computeHybridStatus("tires", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals);
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
): StatusResult {
  // Confirmed healthy overrides both interval and warning-light escalation
  if (isConfirmedHealthy(record, now)) {
    return { status: "on_time", percentUsed: 0, description: "Confirmed in good shape", detail: "On time" };
  }

  const result = computeBrakeStatusCore(record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals);

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
    const hybrid = computeHybridStatus("brakes", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals);
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
  return computeHybridStatus("brakes", record, currentOdometer, make, now, drivingConditions, avgMonthlyDriving, oemIntervals);
}

function computeBatteryStatus(
  record: MaintenanceRecord,
  make: string | undefined,
  now: number,
  knownIssues?: string[],
  oemIntervals?: OemServiceIntervalsInput,
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
  const interval = getInterval("battery", make, undefined, oemIntervals);
  const maxMonths = interval.months ?? 60;

  // Pure age-based
  if (monthsSince >= BATTERY_URGENT_MONTHS) {
    // 4.5+ years → overdue
    const yearsOld = (monthsSince / 12).toFixed(1);
    return {
      status: "overdue",
      percentUsed: 100,
      description: `Battery is ${yearsOld} years old — replacement recommended`,
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
    status = ratioToStatus(ratio);
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

function ratioToStatus(ratio: number): MaintenanceStatus {
  if (ratio > 1.0) return "overdue";
  if (ratio >= 0.75) return "due_soon";
  return "on_time";
}

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
