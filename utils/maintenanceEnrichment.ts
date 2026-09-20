/**
 * maintenanceEnrichment.ts — Urgent-detail copy + record-to-item builder
 *
 * Shared between:
 *   • hooks/useMaintenanceData.ts (mobile My Cars page)
 *   • convex/oto/vehicleHealth.ts (AI tool get_vehicle_health)
 *
 * Extracted from useMaintenanceData.ts so the AI-tool path can produce the
 * same urgent-card copy without duplicating constants. The hook's behavior
 * is byte-identical after the refactor.
 */

import type { MaintenanceItem, MaintenanceStatus } from "../components/cars/MaintenanceTracker";
import type { IntervalClassContext } from "./maintenanceStatus";
import {
  MAINTENANCE_LABELS,
  computeMaintenanceStatus,
  type MaintenanceType,
  type OemServiceIntervalsInput,
} from "./maintenanceStatus";

// ============================================================================
// URGENT ITEM ENRICHMENT — copy shown when an item is overdue/due_soon/needs_attention
// ============================================================================
//
// SCOPE RULE (2026-08-09, Wave 0.1) — this table may only contain GENERIC ADVICE,
// never a claim about a specific vehicle.
//
// `lastService` and `urgency` used to live here as canned strings keyed on
// (type, status) alone — e.g. oil/due_soon carried `lastService: "~5 months ago"`
// and `urgency: "Service within 2 weeks"`. Because `enrichUrgentItem` applies this
// table as `{ ...item, ...details }`, those constants OVERWROTE the real record,
// and `convex/oto/vehicleHealth.ts` forwarded them to Oto as `last_service` /
// `urgency_label` — i.e. as measurements of the user's actual car.
//
// That is the source of the unstable oil timeline in the Aug-08 QA report
// ("5 months since service", "2 weeks") — the figures were identical across every
// vehicle because they were never derived from one. Both keys are now removed;
// neither had a real source, since `buildMaintenanceItems` never populates them.
//
// `impacts` and `recommendation` stay: they are category-level advice that reads
// as advice, and contain no vehicle-specific claim.
type DetailFields = Pick<MaintenanceItem, 'impacts' | 'recommendation'>;

export const URGENT_DETAILS: Record<string, Partial<Record<MaintenanceStatus, DetailFields>>> = {
  oil: {
    overdue: {
      impacts: [
        { label: "Engine wear", severity: "high" },
        { label: "Fuel efficiency", severity: "medium" },
        { label: "Engine overheating risk", severity: "medium" },
      ],
      recommendation: "Oil degrades over time and loses its ability to protect engine internals. Schedule an oil change as soon as possible to prevent long-term damage.",
    },
    due_soon: {
      impacts: [
        { label: "Engine lubrication", severity: "medium" },
        { label: "Fuel efficiency", severity: "low" },
      ],
      recommendation: "Your oil is approaching the end of its service life. Plan an oil change soon to keep your engine running smoothly.",
    },
    needs_attention: {
      impacts: [
        { label: "Engine protection", severity: "medium" },
        { label: "Oil contamination", severity: "medium" },
      ],
      recommendation: "There are signs your oil may need attention. Have a technician check oil level and condition at your earliest convenience.",
    },
  },
  brakes: {
    overdue: {
      impacts: [
        { label: "Stopping distance", severity: "high" },
        { label: "Rotor damage", severity: "high" },
        { label: "Safety risk", severity: "high" },
      ],
      recommendation: "Worn brake pads significantly increase stopping distance and can damage rotors. Have your brakes inspected immediately for your safety.",
    },
    due_soon: {
      impacts: [
        { label: "Stopping distance", severity: "medium" },
        { label: "Rotor damage", severity: "medium" },
      ],
      recommendation: "Brake pads wear down with use and reduced pad thickness increases stopping distance. Have a technician inspect pad thickness and rotor condition.",
    },
    needs_attention: {
      impacts: [
        { label: "Braking performance", severity: "medium" },
        { label: "Rotor wear", severity: "low" },
      ],
      recommendation: "Your brakes may need attention based on available data. A quick inspection can confirm whether pads or rotors need servicing.",
    },
  },
  tires: {
    overdue: {
      impacts: [
        { label: "Traction & grip", severity: "high" },
        { label: "Blowout risk", severity: "high" },
        { label: "Fuel efficiency", severity: "medium" },
      ],
      recommendation: "Worn tires lose grip on wet and dry surfaces and are at higher risk of blowout. Replace or rotate your tires as soon as possible.",
    },
    due_soon: {
      impacts: [
        { label: "Uneven tread wear", severity: "medium" },
        { label: "Handling", severity: "low" },
      ],
      recommendation: "Regular tire rotation extends tire life and ensures even tread wear. Schedule a rotation or have tread depth checked soon.",
    },
    needs_attention: {
      impacts: [
        { label: "Tire pressure", severity: "medium" },
        { label: "Tread depth", severity: "medium" },
      ],
      recommendation: "Your tires may need attention. Check tire pressure and inspect tread depth to ensure safe driving conditions.",
    },
  },
  battery: {
    overdue: {
      impacts: [
        { label: "Starting reliability", severity: "high" },
        { label: "Electrical system", severity: "medium" },
        { label: "Stranding risk", severity: "high" },
      ],
      recommendation: "Car batteries typically last 3–5 years. An aging battery can leave you stranded without warning. Have it tested or replaced promptly.",
    },
    due_soon: {
      impacts: [
        { label: "Starting reliability", severity: "medium" },
        { label: "Cold-weather performance", severity: "medium" },
      ],
      recommendation: "Your battery is approaching the end of its expected lifespan. A quick load test can determine if it still holds a full charge.",
    },
    needs_attention: {
      impacts: [
        { label: "Charge capacity", severity: "medium" },
        { label: "Starting reliability", severity: "low" },
      ],
      recommendation: "There are indications your battery may need attention. A load test at any auto shop takes minutes and can prevent unexpected breakdowns.",
    },
  },
};

/** Shop + date behind a yellow/red mechanic grade, for the "Flagged by …"
 *  line. Returns undefined when there is no grade, when it is green — green
 *  is inert and never changes a status, so claiming a shop flagged it would
 *  be wrong — or when the record carries neither source nor date, so the UI
 *  renders nothing rather than half a line. */
function mechanicFlagFrom(
  customInputs: Record<string, unknown> | undefined,
): { shopName?: string | null; gradedAt?: number | null } | undefined {
  const grade = customInputs?.mechanicGrade as "g" | "y" | "r" | undefined;
  if (!grade || grade === "g") return undefined;
  const shopName = (customInputs?.mechanicGradeSource as string | undefined) ?? null;
  const gradedAt = (customInputs?.mechanicGradedAt as number | undefined) ?? null;
  if (!shopName && !gradedAt) return undefined;
  return { shopName, gradedAt };
}

export function enrichUrgentItem(item: MaintenanceItem): MaintenanceItem {
  const isUrgent = item.status === "overdue" || item.status === "due_soon" || item.status === "needs_attention";
  if (!isUrgent) return item;

  const type = item.id.replace(/^(unknown-|user-|smartcar-)/, "");
  const details = URGENT_DETAILS[type]?.[item.status];
  if (!details) {
    return {
      ...item,
      impacts: [{ label: "Vehicle health", severity: item.status === "overdue" ? "high" : "medium" }],
      recommendation: "Schedule a service appointment to address this maintenance item.",
    };
  }
  // Spread order note: `details` lands AFTER `item`, so anything this table
  // defines wins over the real record. That is why it may only carry generic
  // advice — see the SCOPE RULE above.
  return { ...item, ...details };
}

// ============================================================================
// MAINTENANCE ITEM BUILDER — record → MaintenanceItem map
// ============================================================================

export interface MaintenanceRecordInput {
  type: string;
  lastServiceDate?: number;
  lastServiceMileage?: number;
  customInputs?: Record<string, unknown>;
  confirmedHealthyAt?: number;
}

/**
 * Convert each maintenance_records row into a MaintenanceItem keyed by type.
 * Mirrors the loop body previously inlined in useMaintenanceRecords (hooks/
 * useMaintenanceData.ts). Pure — no React, no Convex.
 */
export function buildMaintenanceItems(
  records: MaintenanceRecordInput[],
  currentOdometer: number | null,
  make?: string,
  drivingConditions?: string,
  avgMonthlyDriving?: string,
  knownIssues?: string[],
  vehicleYear?: number,
  // Slug-keyed OEM service intervals from the v3 enrichment pipeline.
  // Forwarded as-is to computeMaintenanceStatus → getInterval, which
  // applies the tier order (OEM → MAKE → DEFAULT). Optional; when
  // undefined the calc falls back to the existing chain — no behavior
  // change for callers that haven't wired this yet.
  oemIntervals?: OemServiceIntervalsInput,
  /** Interval class + drivetrain / turbo facts. When omitted the class table
   *  is skipped entirely and behaviour matches the pre-v2 tier order, so a
   *  caller that hasn't wired the profile yet is unaffected. */
  classCtx?: IntervalClassContext,
): Map<MaintenanceType, MaintenanceItem> {
  const map = new Map<MaintenanceType, MaintenanceItem>();

  for (const rec of records) {
    const type = rec.type as MaintenanceType;
    const result = computeMaintenanceStatus(
      {
        type: rec.type,
        lastServiceDate: rec.lastServiceDate ?? undefined,
        lastServiceMileage: rec.lastServiceMileage ?? undefined,
        customInputs: rec.customInputs,
        confirmedHealthyAt: rec.confirmedHealthyAt ?? undefined,
      },
      currentOdometer,
      make,
      undefined,
      drivingConditions,
      avgMonthlyDriving,
      knownIssues,
      vehicleYear,
      oemIntervals,
      classCtx,
    );

    map.set(type, {
      id: `user-${type}`,
      serviceName: MAINTENANCE_LABELS[type] || type,
      description: result.description,
      detail: result.detail,
      status: result.status,
      percentUsed: result.percentUsed,
      rawScore: result.rawScore,
      // Quick Check v2 §7 — the band and the applied factor travel with the
      // item so the score, the ordering and any audit read the same numbers.
      bandStatus: result.bandStatus,
      intervalSource: result.intervalSource,
      factorApplied: result.factorApplied,
      mechanicFlag: mechanicFlagFrom(rec.customInputs),
    });
  }

  return map;
}
