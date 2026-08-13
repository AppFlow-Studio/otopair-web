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
import {
  MAINTENANCE_LABELS,
  computeMaintenanceStatus,
  type MaintenanceType,
  type OemServiceIntervalsInput,
} from "./maintenanceStatus";

// ============================================================================
// URGENT ITEM ENRICHMENT — copy shown when an item is overdue/due_soon/needs_attention
// ============================================================================

type DetailFields = Pick<MaintenanceItem, 'lastService' | 'urgency' | 'impacts' | 'recommendation'>;

export const URGENT_DETAILS: Record<string, Partial<Record<MaintenanceStatus, DetailFields>>> = {
  oil: {
    overdue: {
      lastService: "~14 months ago",
      urgency: "Immediate oil change recommended",
      impacts: [
        { label: "Engine wear", severity: "high" },
        { label: "Fuel efficiency", severity: "medium" },
        { label: "Engine overheating risk", severity: "medium" },
      ],
      recommendation: "Oil degrades over time and loses its ability to protect engine internals. Schedule an oil change as soon as possible to prevent long-term damage.",
    },
    due_soon: {
      lastService: "~5 months ago",
      urgency: "Service within 2 weeks",
      impacts: [
        { label: "Engine lubrication", severity: "medium" },
        { label: "Fuel efficiency", severity: "low" },
      ],
      recommendation: "Your oil is approaching the end of its service life. Plan an oil change soon to keep your engine running smoothly.",
    },
    needs_attention: {
      lastService: "Unknown",
      urgency: "Check oil level and condition",
      impacts: [
        { label: "Engine protection", severity: "medium" },
        { label: "Oil contamination", severity: "medium" },
      ],
      recommendation: "There are signs your oil may need attention. Have a technician check oil level and condition at your earliest convenience.",
    },
  },
  brakes: {
    overdue: {
      lastService: "~18 months ago",
      urgency: "Immediate inspection needed",
      impacts: [
        { label: "Stopping distance", severity: "high" },
        { label: "Rotor damage", severity: "high" },
        { label: "Safety risk", severity: "high" },
      ],
      recommendation: "Worn brake pads significantly increase stopping distance and can damage rotors. Have your brakes inspected immediately for your safety.",
    },
    due_soon: {
      lastService: "~10 months ago",
      urgency: "Inspection within 2 weeks",
      impacts: [
        { label: "Stopping distance", severity: "medium" },
        { label: "Rotor damage", severity: "medium" },
      ],
      recommendation: "Brake pads wear down with use and reduced pad thickness increases stopping distance. Have a technician inspect pad thickness and rotor condition.",
    },
    needs_attention: {
      lastService: "Unknown",
      urgency: "Have brakes checked soon",
      impacts: [
        { label: "Braking performance", severity: "medium" },
        { label: "Rotor wear", severity: "low" },
      ],
      recommendation: "Your brakes may need attention based on available data. A quick inspection can confirm whether pads or rotors need servicing.",
    },
  },
  tires: {
    overdue: {
      lastService: "~24 months ago",
      urgency: "Replace or rotate immediately",
      impacts: [
        { label: "Traction & grip", severity: "high" },
        { label: "Blowout risk", severity: "high" },
        { label: "Fuel efficiency", severity: "medium" },
      ],
      recommendation: "Worn tires lose grip on wet and dry surfaces and are at higher risk of blowout. Replace or rotate your tires as soon as possible.",
    },
    due_soon: {
      lastService: "~8 months ago",
      urgency: "Rotation or inspection within 1 month",
      impacts: [
        { label: "Uneven tread wear", severity: "medium" },
        { label: "Handling", severity: "low" },
      ],
      recommendation: "Regular tire rotation extends tire life and ensures even tread wear. Schedule a rotation or have tread depth checked soon.",
    },
    needs_attention: {
      lastService: "Unknown",
      urgency: "Check tire pressure and tread",
      impacts: [
        { label: "Tire pressure", severity: "medium" },
        { label: "Tread depth", severity: "medium" },
      ],
      recommendation: "Your tires may need attention. Check tire pressure and inspect tread depth to ensure safe driving conditions.",
    },
  },
  battery: {
    overdue: {
      lastService: "~4 years ago",
      urgency: "Test or replace battery now",
      impacts: [
        { label: "Starting reliability", severity: "high" },
        { label: "Electrical system", severity: "medium" },
        { label: "Stranding risk", severity: "high" },
      ],
      recommendation: "Car batteries typically last 3–5 years. An aging battery can leave you stranded without warning. Have it tested or replaced promptly.",
    },
    due_soon: {
      lastService: "~3 years ago",
      urgency: "Test within 2 weeks",
      impacts: [
        { label: "Starting reliability", severity: "medium" },
        { label: "Cold-weather performance", severity: "medium" },
      ],
      recommendation: "Your battery is approaching the end of its expected lifespan. A quick load test can determine if it still holds a full charge.",
    },
    needs_attention: {
      lastService: "Unknown",
      urgency: "Have battery tested",
      impacts: [
        { label: "Charge capacity", severity: "medium" },
        { label: "Starting reliability", severity: "low" },
      ],
      recommendation: "There are indications your battery may need attention. A load test at any auto shop takes minutes and can prevent unexpected breakdowns.",
    },
  },
};

export function enrichUrgentItem(item: MaintenanceItem): MaintenanceItem {
  const isUrgent = item.status === "overdue" || item.status === "due_soon" || item.status === "needs_attention";
  if (!isUrgent) return item;

  const type = item.id.replace(/^(unknown-|user-|smartcar-)/, "");
  const details = URGENT_DETAILS[type]?.[item.status];
  if (!details) {
    return {
      ...item,
      urgency: item.status === "overdue" ? "Service overdue" : "Service recommended soon",
      impacts: [{ label: "Vehicle health", severity: item.status === "overdue" ? "high" : "medium" }],
      recommendation: "Schedule a service appointment to address this maintenance item.",
    };
  }
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
    );

    map.set(type, {
      id: `user-${type}`,
      serviceName: MAINTENANCE_LABELS[type] || type,
      description: result.description,
      detail: result.detail,
      status: result.status,
      percentUsed: result.percentUsed,
    });
  }

  return map;
}
