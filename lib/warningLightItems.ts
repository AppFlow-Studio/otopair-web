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

/**
 * The light-type IDs persisted in `vehicle_owners.knownIssues[1..]`
 * when the status sentinel (`knownIssues[0]`) is `"other"`. Plus the
 * special `not_sure_which` sentinel used when the user can't identify
 * which light is lit.
 */
type WarningLightId =
  | "tpms"
  | "battery_charging"
  | "temperature"
  | "oil_pressure"
  | "abs"
  | "airbag_srs"
  | "transmission"
  | "not_sure_which";

/** Lights that ALREADY surface via the paired-tile escalation in
 *  useMergedMaintenance. The consolidated card filters these out so
 *  the user doesn't get two prompts for one root cause. */
const PAIRED_LIGHTS: ReadonlySet<WarningLightId> = new Set([
  "oil_pressure",
  "battery_charging",
  "abs",
  "tpms",
]);

/** Display labels for each light. Used in the description copy when one
 *  or more unpaired lights are active. */
const LIGHT_LABELS: Record<WarningLightId, string> = {
  tpms: "Tire pressure",
  battery_charging: "Battery / charging",
  temperature: "Temperature",
  oil_pressure: "Oil pressure",
  abs: "ABS / brake",
  airbag_srs: "Airbag",
  transmission: "Transmission",
  not_sure_which: "Unknown warning",
};

export interface BuildWarningLightItemArgs {
  /** Raw `vehicle_owners.knownIssues` array. `[0]` is the status
   *  sentinel (`no_all_clear` / `check_engine` / `other` / `not_sure`),
   *  `[1..]` are the specific light type IDs when status is `"other"`. */
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
  if (!knownIssues || knownIssues.length === 0) return null;

  const status = knownIssues[0];
  if (status === "no_all_clear") return null;

  // Resolve the set of active lights for the consolidated card.
  // Status sentinels:
  //   "check_engine" → one synthetic light: check engine.
  //   "other"        → knownIssues[1..] holds the picked light type IDs.
  //   "not_sure"     → user knows a light is on but not which → treat
  //                    as a single "not_sure_which" sentinel.
  let lights: WarningLightId[];
  if (status === "check_engine") {
    // Check engine isn't in the light-type enum; we surface it under
    // its own synthetic id so the description copy is clear.
    return buildItemForCheckEngine(scopeId);
  } else if (status === "not_sure") {
    lights = ["not_sure_which"];
  } else if (status === "other") {
    const candidates = knownIssues.slice(1).filter(isWarningLightId);
    lights = candidates;
  } else {
    // Unknown sentinel — be defensive, surface nothing.
    return null;
  }

  // Filter out paired lights (the paired-tile escalation in
  // useMergedMaintenance already prompts the user for these).
  const unpaired = lights.filter((id) => !PAIRED_LIGHTS.has(id));
  if (unpaired.length === 0) return null;

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
  lights: readonly WarningLightId[],
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

function isWarningLightId(s: string): s is WarningLightId {
  return s in LIGHT_LABELS;
}

