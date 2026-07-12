/**
 * mergedMaintenance — the single, shared vehicle-item merge used by BOTH the
 * Cars-page health ring (hooks/useMaintenanceData.ts useMergedMaintenance) and
 * Oto's server-side get_vehicle_health score (convex/oto/vehicleHealth.ts).
 *
 * Extracted verbatim from useMergedMaintenance so the two consumers compute the
 * SAME MaintenanceItem[] from the same inputs — which is what lets Oto's stated
 * health score converge with the ring the user sees, with zero drift. It is a
 * pure function (takes an already-built per-type userItems map + records + the
 * per-vehicle signals); no React, no Convex, no `@/` value imports beyond the
 * pure builders it composes.
 *
 * The no-record fallbacks here are the ring's OPTIMISTIC ones (oil -> due_soon,
 * others -> on_time). Oto keeps its own conservative "unknown" fallback for the
 * items it REPORTS to the user (the F1 anti-fabrication behavior); this shared
 * merge is used only to compute the score that must match the ring.
 */

import type { MaintenanceItem } from "@/components/cars/MaintenanceTracker";
import {
  ALL_MAINTENANCE_TYPES,
  MAINTENANCE_LABELS,
  type MaintenanceType,
} from "@/utils/maintenanceStatus";
import { enrichUrgentItem } from "@/utils/maintenanceEnrichment";
import { buildWarningLightItem } from "@/lib/warningLightItems";
import { canonicalWarningLights } from "@/lib/warningLightVocab";

/** Minimal shape of a driver-visible mechanic recommendation, mirrored from
 *  api.jobRecommendations.getDriverVisibleRecsForVehicle. */
export interface DriverRecommendationLike {
  _id: string;
  service_id: string | null;
  service_name: string;
  urgency: "next_visit" | "within_3_months" | "soon";
  reason: string | null;
  shop_name: string | null;
  mechanic_name: string | null;
  target_mileage?: number | null;
  scheduled_at?: number | null;
  scheduled_mechanic_name?: string | null;
}

export function recUrgencyToStatus(
  urgency: DriverRecommendationLike["urgency"],
): MaintenanceItem["status"] {
  if (urgency === "soon") return "overdue";
  if (urgency === "next_visit") return "due_soon";
  return "needs_attention";
}

export function recUrgencyDetail(
  urgency: DriverRecommendationLike["urgency"],
): string {
  if (urgency === "soon") return "Service soon";
  if (urgency === "next_visit") return "Next visit";
  return "Within 3 months";
}

/** Paired maintenance type → canonical light id that escalates it to Now tier. */
const PAIRED_LIGHT_BY_TYPE: Partial<Record<MaintenanceType, string>> = {
  oil: "oil_pressure",
  battery: "battery_charging",
  brakes: "abs",
  tires: "tpms",
};

/** Minimal record shape the merge reads — type (to match a user item) plus the
 *  confirmed-healthy timestamp (the 90-day on_time override). */
export interface MergeRecordLike {
  type: string;
  confirmedHealthyAt?: number;
}

export interface BuildMergedMaintenanceInput {
  /** Per-type items already computed from the user's maintenance_records
   *  (buildMaintenanceItems output). */
  userItems: Map<MaintenanceType, MaintenanceItem>;
  /** Raw records — only `type` + `confirmedHealthyAt` are read. */
  records: readonly MergeRecordLike[] | undefined;
  knownIssues?: string[];
  vehicleYear?: number;
  driverRecommendations?: readonly DriverRecommendationLike[];
  /** Id appended to the consolidated warning item so multiple vehicles produce
   *  distinct items. Pass the vehicle_owner id (or VIN). When undefined, the
   *  consolidated card is skipped (matches useMergedMaintenance's guard). */
  scopeId?: string;
  /** Injectable clock for the confirmed-healthy TTL; defaults to Date.now(). */
  now?: number;
}

/**
 * Build the full merged MaintenanceItem[] the Cars ring renders / scores from:
 * per-type items (record > warning-light fallback > young-battery inference >
 * optimistic default), then appended inspection + mechanic driver recs, the
 * paired-light overdue escalation, enrichment, and the consolidated
 * unpaired-light card.
 */
export function buildMergedMaintenanceItems(
  input: BuildMergedMaintenanceInput,
): MaintenanceItem[] {
  const { userItems, records, knownIssues, vehicleYear, driverRecommendations, scopeId } = input;
  const now = input.now ?? Date.now();
  const result: MaintenanceItem[] = [];

  // Canonical dashboard lights present, folding both knownIssues shapes + the
  // symptom-code vocabulary so a light logged in ANY vocabulary escalates.
  const activeLights = canonicalWarningLights(knownIssues) as readonly string[];

  for (const type of ALL_MAINTENANCE_TYPES) {
    const userItem = userItems.get(type);

    // Recently confirmed-healthy → force on_time so a stale calculated status
    // doesn't override the user's direct input.
    const userRecord = records?.find((r) => r.type === type);
    const userConfirmedHealthy =
      userRecord?.confirmedHealthyAt &&
      now - userRecord.confirmedHealthyAt < 90 * 24 * 60 * 60 * 1000;

    if (userConfirmedHealthy && userItem) {
      if (userItem.status !== "on_time") {
        result.push({
          ...userItem,
          status: "on_time",
          description: "Confirmed in good shape",
          detail: "On time",
        });
      } else {
        result.push(userItem);
      }
      continue;
    }

    if (userItem) {
      result.push(userItem);
      continue;
    }

    // No record — a paired warning light escalates the tile to the Now tier.
    const WARNING_LIGHT_FOR_TYPE: Partial<Record<MaintenanceType, { lightId: string; label: string }>> = {
      oil: { lightId: "oil_pressure", label: "Oil pressure warning light active — service urgently needed" },
      battery: { lightId: "battery_charging", label: "Battery/charging warning light active — have it tested soon" },
      brakes: { lightId: "abs", label: "ABS / brake warning light active — have brakes inspected soon" },
      tires: { lightId: "tpms", label: "Tire pressure (TPMS) warning light active — check tires soon" },
    };
    const lightInfo = WARNING_LIGHT_FOR_TYPE[type];
    if (lightInfo && activeLights.includes(lightInfo.lightId)) {
      result.push({
        id: `unknown-${type}`,
        serviceName: MAINTENANCE_LABELS[type] || type,
        description: lightInfo.label,
        detail: "Warning light",
        status: "overdue",
        percentUsed: 100,
      });
      continue;
    }

    // Battery: infer healthy for young vehicles.
    if (type === "battery") {
      const vehicleAge = vehicleYear ? new Date().getFullYear() - vehicleYear : 0;
      if (vehicleAge < 3) {
        result.push({
          id: `unknown-${type}`,
          serviceName: MAINTENANCE_LABELS[type] || type,
          description: `Battery is ~${vehicleAge || "<1"} year${vehicleAge !== 1 ? "s" : ""} old — healthy`,
          detail: "On time",
          status: "on_time",
        });
        continue;
      }
    }

    const fallback: Record<string, { status: MaintenanceItem["status"]; description: string; detail: string }> = {
      oil:    { status: "due_soon",  description: "No oil change data — service recommended", detail: "Check soon" },
      brakes: { status: "on_time",   description: "No brake concerns reported",              detail: "On time" },
      tires:  { status: "on_time",   description: "No tire concerns reported",               detail: "On time" },
      battery:{ status: "on_time",   description: "No battery concerns reported",            detail: "On time" },
    };
    const fb = fallback[type] ?? { status: "on_time" as const, description: "No concerns reported", detail: "On time" };
    result.push({
      id: `unknown-${type}`,
      serviceName: MAINTENANCE_LABELS[type] || type,
      description: fb.description,
      detail: fb.detail,
      status: fb.status,
    });
  }

  // Inspection record (excluded from the default loop).
  const inspectionItem = userItems.get("inspection");
  if (inspectionItem) result.push(inspectionItem);

  // Mechanic-submitted job recommendations as urgent cards.
  if (driverRecommendations && driverRecommendations.length > 0) {
    for (const rec of driverRecommendations) {
      result.push({
        id: `rec-${rec._id}`,
        serviceName: rec.service_name,
        description: rec.reason ?? "Recommended by your mechanic",
        detail: recUrgencyDetail(rec.urgency),
        status: recUrgencyToStatus(rec.urgency),
        sourceRecommendationId: rec._id,
        mechanicProvenance: {
          shopName: rec.shop_name,
          mechanicName: rec.mechanic_name,
        },
        recUrgency: rec.urgency,
        scheduledAt: rec.scheduled_at ?? null,
        scheduledMechanicName: rec.scheduled_mechanic_name ?? null,
        serviceId: rec.service_id ?? null,
      });
    }
  }

  // Force any paired item up to overdue when its light is on (record-based or not).
  const escalated = result.map((item) => {
    const itemType = item.id.replace(/^(unknown-|user-|smartcar-)/, "");
    const lightId = PAIRED_LIGHT_BY_TYPE[itemType as MaintenanceType];
    if (!lightId || !activeLights.includes(lightId)) return item;
    if (item.status === "overdue") return item;
    return { ...item, status: "overdue" as const, percentUsed: 100 };
  });

  const enriched = escalated.map(enrichUrgentItem);

  // Consolidated unpaired-light item — appended AFTER enrichment so its
  // hand-tuned copy isn't clobbered by the generic URGENT_DETAILS fallback.
  if (scopeId) {
    const warningItem = buildWarningLightItem({ knownIssues, scopeId });
    if (warningItem) enriched.push(warningItem);
  }

  return enriched;
}
