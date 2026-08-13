import type { Service, ServiceCategory } from "@/stores/types/store.types";

/**
 * Maps a MaintenanceTracker / VehicleMaintenanceCard row's maintenance type
 * (oil | tires | brakes | battery | inspection) onto the booking flow:
 *
 *   - MAINTENANCE_TYPE_TO_CATEGORY drives which service category tab opens
 *   - MAINTENANCE_TYPE_TO_SLUG names the single service we pre-attach to the
 *     cart so the user lands on /booking/map with the right service ticked
 *
 * If the slug isn't in availableServices (e.g., Convex still hydrating or
 * the seed catalog differs), we silently fall back to category-only.
 */

export const MAINTENANCE_TYPE_TO_CATEGORY: Record<string, ServiceCategory> = {
  oil: "basic_maintenance",
  brakes: "brakes_suspension",
  tires: "tires_wheels",
  battery: "basic_maintenance",
  inspection: "basic_maintenance",
  // Consolidated "Warning Lights Active" item (id `warning-…`) opens
  // the system_diagnostics tab so the diagnostic scan is the first
  // thing the user sees. A lit warning light is rarely fixable by a
  // single specific service — scan first, then scope.
  warning: "system_diagnostics",
};

// Conservative defaults — used only when the description-based matcher
// can't find anything more specific. Picking the inspection/test variants
// for brakes/battery avoids preselecting an invasive replacement when the
// status copy only suggested checking the system.
export const MAINTENANCE_TYPE_TO_SLUG: Record<string, string> = {
  oil: "oil_change",
  brakes: "brake_system_inspection",
  tires: "tire_rotation",
  battery: "battery_test",
  inspection: "ny_state_inspection",
  // Warning-light item → diagnostic scan. Matches the SLUG_DIAGNOSTIC_SCAN
  // constant in constants/serviceTaxonomy.ts (same string, kept
  // hard-coded here to avoid the lib/ → constants/ import cycle).
  warning: "diagnostic_scan",
};

/**
 * Strip the row id back to a maintenance type key.
 *   Cars MaintenanceTracker: "oil" / "unknown-oil" / "user-oil"
 *   Home VehicleMaintenanceCard: "oil-<ownershipId>"
 */
export function extractMaintenanceType(id: string): string {
  const stripped = id.replace(/^(unknown-|user-)/, "");
  const dash = stripped.indexOf("-");
  return dash === -1 ? stripped : stripped.slice(0, dash);
}

/**
 * Find the pre-attach service for a maintenance type, or undefined.
 * Matches slug hyphen/underscore-insensitively because the deployed Convex
 * catalog uses underscores ("oil_change") while older seed scripts use
 * hyphens ("oil-change") — we want to match either without forcing a sync.
 */
const normalizeSlug = (s: string | undefined) =>
  s ? s.toLowerCase().replace(/-/g, "_") : "";

export function findServiceForMaintenanceType(
  type: string,
  available: readonly Service[],
): Service | undefined {
  const wanted = normalizeSlug(MAINTENANCE_TYPE_TO_SLUG[type]);
  if (!wanted) return undefined;
  return available.find((s) => normalizeSlug(s.slug) === wanted);
}

/**
 * When the maintenance status description suggests a specific catalog
 * service (e.g. "have brakes inspected soon" → Brake System Inspection,
 * "Tires over 6 years old — replacement recommended" → Tire Replacement),
 * return that service so the Home card label + booking-flow preselection
 * both surface the recommendation. Returns undefined when no candidate
 * clears the threshold; callers fall back to the slug default.
 *
 * Scans ALL services regardless of category. The matcher's specificity
 * rules (≥2 token hits for multi-word names, ratio ≥ 0.5) keep
 * cross-category false positives rare. Callers should use the matched
 * service's `category` to drive `setInitialServiceCategory` so the sheet
 * opens on the correct tab — important when e.g. Brake System Inspection
 * lives in `system_diagnostics` while the maintenance type is "brakes".
 *
 * Match rule:
 *   - Tokenize both sides on whitespace + punctuation (lowercase).
 *   - Two tokens are considered the same if they share a 4-char prefix
 *     ("inspected" ↔ "inspection", "tested" ↔ "test", "tires" ↔ "tire").
 *   - Count name-tokens that have an overlap with any description token.
 *   - Skip services with <2 hits when the name has multiple tokens
 *     (avoids "Brake [anything]" winning on the word "brake"), or with
 *     a matched-ratio below 0.5.
 *   - Among survivors, prefer the highest matched count, ties broken by
 *     ratio.
 */
const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

// True when either token equals the other, or they share a 4-char prefix.
// Length-3 tokens (e.g. "abs", "oil") must match exactly.
const tokensOverlap = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.slice(0, 4) === b.slice(0, 4);
};

export function findServiceFromDescription(
  description: string | undefined,
  available: readonly Service[],
): Service | undefined {
  if (!description) return undefined;
  const descTokens = tokenize(description);
  if (descTokens.length === 0) return undefined;
  let best: { service: Service; matched: number; ratio: number } | null = null;
  for (const svc of available) {
    const nameTokens = tokenize(svc.name);
    if (nameTokens.length === 0) continue;
    const matched = nameTokens.filter((nt) =>
      descTokens.some((dt) => tokensOverlap(nt, dt))
    ).length;
    if (matched === 0) continue;
    // Multi-token names need at least 2 hits — single-word services can win on 1.
    if (matched < 2 && nameTokens.length > 1) continue;
    const ratio = matched / nameTokens.length;
    if (ratio < 0.5) continue;
    if (
      !best ||
      matched > best.matched ||
      (matched === best.matched && ratio > best.ratio)
    ) {
      best = { service: svc, matched, ratio };
    }
  }
  return best?.service;
}
