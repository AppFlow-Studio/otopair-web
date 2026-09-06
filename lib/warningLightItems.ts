/**
 * warningLightItems — synthesizes a consolidated "Warning Lights Active"
 * MaintenanceItem from the `vehicle_owners.knownIssues` payload so an
 * active dashboard warning prompts the user to book a service in
 * exactly the same UI surfaces as every other maintenance item: the
 * Cars-page MaintenanceTracker AND the Home `NowTierCallout`.
 *
 * Why a consolidated item (not one card per light):
 *  - Per Ahmad's design call, multiple lit lights collapse into a
 *    single Now-tier card per vehicle. Less visual noise; the diagnostic
 *    scan is a single booking either way.
 *
 * Why only UNPAIRED lights:
 *  - The 4 paired lights (`oil_pressure` / `battery_charging` / `abs` /
 *    `tpms`) already trigger an escalation on the matching maintenance
 *    tile via `hooks/useMaintenanceData.ts:WARNING_LIGHT_FOR_TYPE` —
 *    those tiles are bumped to `overdue` so they ALSO surface in the
 *    Now tier. Stacking a standalone card on top would double-prompt
 *    the user for the same root cause.
 *
 * Why `overdue` + `percentUsed: 100`:
 *  - `utils/urgency.ts` scores severity (0.50 weight) × category weight
 *    + proximity (0.35 weight). To land in the Now tier (score ≥ 75),
 *    the item needs both maxed out. We set status `overdue` (severity
 *    100) and percentUsed 100. The id `warning-active-…` resolves via
 *    `extractMaintenanceType` → `"warning"` → `CATEGORY_WEIGHTS.warning`
 *    (25, top tier — matches `brakes`), so the score lands at 85.
 *
 * Booking handoff:
 *  - The Cars-page `onBookNow` calls `extractMaintenanceType(id)` and
 *    looks up `MAINTENANCE_TYPE_TO_SLUG`. We register
 *    `warning → diagnostic_scan` + `warning → system_diagnostics` so
 *    Book Service pre-attaches the diagnostic scan and opens that
 *    booking tab automatically. No special-case code at the call site.
 */

import type { MaintenanceItem } from "@/components/cars/MaintenanceTracker";
import {
  canonicalWarningLights,
  PAIRED_WARNING_LIGHTS,
  type CanonicalWarningLight,
} from "@/lib/warningLightVocab";

/** Display labels for each canonical light. Used in the description copy
 *  when one or more unpaired lights are active. `check_engine` is included
 *  so a combined multi-light card keeps its label (its solo card uses the
 *  richer copy in buildItemForCheckEngine). */
export const LIGHT_LABELS: Record<CanonicalWarningLight, string> = {
  tpms: "Tire pressure",
  battery_charging: "Battery / charging",
  temperature: "Temperature",
  oil_pressure: "Oil pressure",
  abs: "ABS / brake",
  airbag_srs: "Airbag",
  transmission: "Transmission",
  check_engine: "Check engine",
  not_sure_which: "Unknown warning",
};

export interface BuildWarningLightItemArgs {
  /** Raw `vehicle_owners.knownIssues` array. Read format-agnostically via
   *  `canonicalWarningLights` — works for both the legacy sentinel-prefixed
   *  shape (`["other", ...lights]`) and the flat code-set shape
   *  (`["oil_pressure", "check_engine"]`), and folds symptom-code aliases
   *  (`brake_warning` → `abs`, etc.) onto their canonical light id. */
  knownIssues: readonly string[] | undefined;
  /** Identifier appended to the item id so multiple vehicles on Home
   *  produce distinct items (`warning-active-<scopeId>`). Pass the
   *  ownership row id, or the VIN — either works as long as it's
   *  unique per vehicle in the current view. */
  scopeId: string;
}

/**
 * Build the consolidated warning-light MaintenanceItem, or null when
 * there's nothing to surface (no active lights, or every active light
 * is already handled by paired-tile escalation).
 */
export function buildWarningLightItem(
  args: BuildWarningLightItemArgs,
): MaintenanceItem | null {
  const { knownIssues, scopeId } = args;

  // Every canonical dashboard light present, regardless of array shape or
  // vocabulary. Paired lights (oil_pressure / battery_charging / abs / tpms)
  // already surface via the matching maintenance tile's escalation in
  // useMergedMaintenance — filter them out so the user isn't double-prompted.
  const unpaired = canonicalWarningLights(knownIssues).filter(
    (id) => !PAIRED_WARNING_LIGHTS.has(id),
  );
  if (unpaired.length === 0) return null;

  // A lone check-engine light keeps its dedicated, richer copy.
  if (unpaired.length === 1 && unpaired[0] === "check_engine") {
    return buildItemForCheckEngine(scopeId);
  }

  return buildItemForUnpaired(unpaired, scopeId);
}

function buildItemForCheckEngine(scopeId: string): MaintenanceItem {
  return {
    // id pattern `warning-active-…` resolves via extractMaintenanceType
    // to "warning" so the urgency math picks CATEGORY_WEIGHTS.warning
    // and the booking handoff finds the diagnostic-scan service slug.
    id: `warning-active-${scopeId}`,
    serviceName: "Check engine light",
    description:
      "Check engine light is on — diagnostic scan recommended.",
    detail: "On now",
    status: "overdue",
    percentUsed: 100,
    urgency: "Have your car scanned to pull the code.",
  };
}

function buildItemForUnpaired(
  lights: readonly CanonicalWarningLight[],
  scopeId: string,
): MaintenanceItem {
  const labels = lights.map((id) => LIGHT_LABELS[id]).filter(Boolean);
  const isSingle = labels.length === 1;
  const serviceName = isSingle
    ? `${labels[0]} warning light`
    : `${labels.length} warning lights active`;
  // Single light: "Temperature warning light is on — diagnostic scan recommended."
  // Multiple:     "Active: Temperature, Airbag. Diagnostic scan recommended."
  const description = isSingle
    ? `${labels[0]} warning light is on — diagnostic scan recommended.`
    : `Active: ${labels.join(", ")}. Diagnostic scan recommended.`;
  return {
    id: `warning-active-${scopeId}`,
    serviceName,
    description,
    detail: "On now",
    status: "overdue",
    percentUsed: 100,
    urgency: "Have your car scanned to pull the code.",
  };
}

