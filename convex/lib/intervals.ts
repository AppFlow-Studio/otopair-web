/**
 * intervals.ts — Service Interval Calculator & Urgency Classifier
 *
 * Calculates adjusted intervals per service, determines due dates,
 * and classifies urgency. Also handles Quick Read overrides.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ServiceSpec {
  service_id: string;
  oem_interval_miles: number | null;
  oem_interval_months: number | null;
  is_applicable: boolean;
  exclusion_reason?: string;
  category?: string;
}

export interface ServiceAnchor {
  last_service_mileage?: number;
  last_service_date?: number; // Unix ms
  last_service_source?: string;
}

export interface IntervalResult {
  is_applicable: boolean;
  exclusion_reason?: string;
  adjusted_interval_miles?: number;
  adjusted_interval_months?: number;
  composite_modifier?: number;
  due_at_mileage?: number;
  due_at_date?: number;
  trigger_type?: "mileage" | "time" | "both";
}

export type Urgency = "none" | "low" | "moderate" | "high" | "critical";

export interface UrgencyResult {
  urgency: Urgency;
  urgency_score?: number;
  source?: string;
}

export interface QuickReadFlags {
  soft_brakes?: boolean;
  warning_light_brake?: boolean;
  warning_light_battery?: boolean;
  warning_light_engine?: boolean;
  warning_light_oil?: boolean;
  warning_light_temperature?: boolean;
  warning_light_transmission?: boolean;
  tire_issue?: boolean;
  // Symptom-derived flags from Q5
  symptom_alignment?: boolean;
  symptom_noise?: boolean;
}

// ============================================================================
// INTERVAL CALCULATOR
// ============================================================================

/**
 * Calculate the adjusted service interval for a specific service.
 * Applies composite modifier to OEM baselines, determines due dates
 * from the last service anchor.
 */
// Categories for unknown-service rule branching (MI doc TICKET-010)
// Low-cost (routine) + safety (brakes, tires) = assume due now (fallback else)
const LONG_INTERVAL_CATEGORIES = new Set(["diagnostics"]);
const TIME_BASED_CATEGORIES = new Set(["fluids"]);

export function calculateServiceInterval(
  spec: ServiceSpec,
  composite: number,
  currentMileage: number,
  annualMileageRate: number,
  anchor: ServiceAnchor,
  isCompliance: boolean,
  vehicleAgeYears?: number
): IntervalResult {
  if (!spec.is_applicable) {
    return { is_applicable: false, exclusion_reason: spec.exclusion_reason };
  }

  const adjustedMiles = spec.oem_interval_miles
    ? isCompliance
      ? spec.oem_interval_miles
      : spec.oem_interval_miles * composite
    : undefined;

  const adjustedMonths = spec.oem_interval_months
    ? isCompliance
      ? spec.oem_interval_months
      : spec.oem_interval_months * composite
    : undefined;

  const cat = spec.category ?? "routine";
  const hasServiceHistory = anchor.last_service_mileage != null || anchor.last_service_date != null;

  // Calculate mileage due point
  let dueAtMileage: number | undefined;
  if (adjustedMiles) {
    if (anchor.last_service_mileage != null) {
      dueAtMileage = anchor.last_service_mileage + adjustedMiles;
    } else if (LONG_INTERVAL_CATEGORIES.has(cat) && annualMileageRate > 0) {
      // Long-interval items: estimate from current mileage and OEM interval
      const estimatedServiceCount = Math.floor(currentMileage / adjustedMiles);
      dueAtMileage = (estimatedServiceCount + 1) * adjustedMiles;
      if (dueAtMileage < currentMileage) dueAtMileage = currentMileage;
    } else {
      // Low-cost + safety-critical: assume due now
      dueAtMileage = currentMileage;
    }
  }

  // Calculate date due point
  let dueAtDate: number | undefined;
  if (adjustedMonths) {
    if (anchor.last_service_date != null) {
      dueAtDate = anchor.last_service_date + adjustedMonths * 30.44 * 24 * 60 * 60 * 1000;
    } else if (
      TIME_BASED_CATEGORIES.has(cat) &&
      vehicleAgeYears != null &&
      vehicleAgeYears * 12 > adjustedMonths
    ) {
      // Time-based items: if vehicle age exceeds OEM interval, mark overdue
      dueAtDate = Date.now() - 30.44 * 24 * 60 * 60 * 1000; // 1 month in the past
    } else {
      dueAtDate = Date.now();
    }
  }

  // Determine which trigger fires first
  let triggerType: "mileage" | "time" | "both" | undefined;
  if (dueAtMileage != null && dueAtDate != null) {
    const milesUntilDue = dueAtMileage - currentMileage;
    const monthsUntilDueByMileage =
      annualMileageRate > 0 ? (milesUntilDue / annualMileageRate) * 12 : Infinity;
    const msUntilDue = dueAtDate - Date.now();
    const monthsUntilDueByTime = msUntilDue / (30.44 * 24 * 60 * 60 * 1000);

    if (Math.abs(monthsUntilDueByMileage - monthsUntilDueByTime) < 1) {
      triggerType = "both";
    } else {
      triggerType = monthsUntilDueByTime < monthsUntilDueByMileage ? "time" : "mileage";
    }
  } else if (dueAtMileage != null) {
    triggerType = "mileage";
  } else if (dueAtDate != null) {
    triggerType = "time";
  }

  return {
    is_applicable: true,
    adjusted_interval_miles: adjustedMiles,
    adjusted_interval_months: adjustedMonths,
    composite_modifier: composite,
    due_at_mileage: dueAtMileage,
    due_at_date: dueAtDate,
    trigger_type: triggerType,
  };
}

// ============================================================================
// URGENCY CLASSIFIER
// ============================================================================

/**
 * Classify urgency from interval result.
 * Quick Read safety overrides always win over calculated values.
 */
export function classifyUrgency(
  interval: IntervalResult,
  currentMileage: number,
  annualMileageRate: number,
  quickReadFlags: QuickReadFlags,
  serviceCategory?: string
): UrgencyResult {
  if (!interval.is_applicable) {
    return { urgency: "none" };
  }

  // Quick Read safety overrides — bypass all calculation
  if (quickReadFlags.soft_brakes && serviceCategory === "brakes") {
    return { urgency: "critical", source: "quick_read_override" };
  }
  if (
    quickReadFlags.warning_light_brake &&
    (serviceCategory === "brakes" || serviceCategory === "fluids")
  ) {
    return { urgency: "critical", source: "quick_read_override" };
  }
  if (quickReadFlags.warning_light_battery && serviceCategory === "battery") {
    return { urgency: "high", source: "quick_read_override" };
  }
  if (quickReadFlags.warning_light_engine && serviceCategory === "diagnostics") {
    return { urgency: "high", source: "quick_read_override" };
  }
  if (quickReadFlags.tire_issue && serviceCategory === "tires") {
    return { urgency: "high", source: "quick_read_override" };
  }
  // Symptom-derived overrides from Q5
  if (quickReadFlags.symptom_alignment && serviceCategory === "tires") {
    return { urgency: "high", source: "symptom_override" };
  }
  if (quickReadFlags.symptom_noise && serviceCategory === "diagnostics") {
    return { urgency: "high", source: "symptom_override" };
  }
  if (quickReadFlags.warning_light_oil && serviceCategory === "routine") {
    return { urgency: "high", source: "quick_read_override" };
  }
  if (quickReadFlags.warning_light_temperature && (serviceCategory === "routine" || serviceCategory === "fluids")) {
    return { urgency: "high", source: "quick_read_override" };
  }
  if (quickReadFlags.warning_light_transmission && serviceCategory === "routine") {
    return { urgency: "high", source: "quick_read_override" };
  }

  // Standard urgency from interval calculation
  const monthsUntilDue = getMonthsUntilDue(
    interval,
    currentMileage,
    annualMileageRate
  );

  if (monthsUntilDue == null) return { urgency: "low", urgency_score: 12 };
  if (monthsUntilDue < 0)
    return { urgency: "critical", urgency_score: Math.abs(monthsUntilDue) };
  if (monthsUntilDue === 0) return { urgency: "high", urgency_score: 0 };
  if (monthsUntilDue <= 2)
    return { urgency: "high", urgency_score: monthsUntilDue };
  if (monthsUntilDue <= 6)
    return { urgency: "moderate", urgency_score: monthsUntilDue };
  if (monthsUntilDue <= 12)
    return { urgency: "low", urgency_score: monthsUntilDue };
  return { urgency: "none", urgency_score: monthsUntilDue };
}

/**
 * Calculate months until due, taking whichever trigger fires first.
 */
function getMonthsUntilDue(
  interval: IntervalResult,
  currentMileage: number,
  annualMileageRate: number
): number | null {
  let monthsByMileage: number | null = null;
  let monthsByTime: number | null = null;

  if (interval.due_at_mileage != null && annualMileageRate > 0) {
    const milesRemaining = interval.due_at_mileage - currentMileage;
    monthsByMileage = (milesRemaining / annualMileageRate) * 12;
  }

  if (interval.due_at_date != null) {
    const msRemaining = interval.due_at_date - Date.now();
    monthsByTime = msRemaining / (30.44 * 24 * 60 * 60 * 1000);
  }

  if (monthsByMileage != null && monthsByTime != null) {
    return Math.min(monthsByMileage, monthsByTime);
  }
  return monthsByMileage ?? monthsByTime;
}

// ============================================================================
// SEGMENT C PHASING
// ============================================================================

interface PhasedState {
  service_id: string;
  urgency: Urgency;
  phase_visit?: number;
  is_surfaced: boolean;
  serviceCategory?: string;
  [key: string]: unknown;
}

const SAFETY_CATEGORIES = new Set(["brakes", "tires", "diagnostics"]);
const LONGEVITY_CATEGORIES = new Set(["fluids"]);

/**
 * Apply segment-aware surfacing logic.
 *
 * Segment A ("The Protected"): Show ALL due items at once
 * Segment B ("The Guided"):    Show 1 primary + 2 secondary (highest urgency)
 * Segment C ("The Catch-Up"):  Phase across 2-3 visits when ≥4 high-urgency
 * Segment D ("The Blank Slate"): Hold ALL recommendations until assessment
 */
export function applySegmentPhasing(
  states: PhasedState[],
  segment: string,
  visit1Complete?: boolean
): PhasedState[] {
  // Segment D: hold everything
  if (segment === "D") {
    return states.map((s) => ({ ...s, is_surfaced: false }));
  }

  // Segment A: surface everything that has urgency
  if (segment === "A") {
    return states.map((s) => ({
      ...s,
      is_surfaced: s.urgency !== "none",
    }));
  }

  // Segment B: 1 primary (highest urgency) + 2 secondary
  if (segment === "B") {
    const ranked = [...states]
      .map((s, i) => ({ ...s, _origIdx: i }))
      .filter((s) => s.urgency !== "none")
      .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);

    const surfacedIds = new Set<string>();
    for (let i = 0; i < Math.min(3, ranked.length); i++) {
      surfacedIds.add(ranked[i].service_id);
    }

    return states.map((s) => ({
      ...s,
      is_surfaced: surfacedIds.has(s.service_id),
    }));
  }

  // Segment C: phased visits
  const highUrgencyCount = states.filter(
    (s) => s.urgency === "critical" || s.urgency === "high"
  ).length;

  if (highUrgencyCount < 4) {
    return states.map((s) => ({ ...s, is_surfaced: s.urgency !== "none" }));
  }

  return states.map((s) => {
    if (s.urgency === "none" || s.urgency === "low") {
      return { ...s, phase_visit: undefined, is_surfaced: false };
    }

    if (SAFETY_CATEGORIES.has(s.serviceCategory ?? "")) {
      return { ...s, phase_visit: 1, is_surfaced: true };
    }
    if (LONGEVITY_CATEGORIES.has(s.serviceCategory ?? "")) {
      return { ...s, phase_visit: 3, is_surfaced: false };
    }
    // Visit 2: only surface if Visit 1 is booked/completed
    return { ...s, phase_visit: 2, is_surfaced: visit1Complete === true };
  });
}

const URGENCY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  none: 4,
};
