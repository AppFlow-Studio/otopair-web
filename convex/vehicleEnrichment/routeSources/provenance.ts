// =============================================================================
// routeSources/provenance.ts — what a route-ingested value is allowed to claim.
//
// THE ONE DECISION THIS FILE MAKES
// --------------------------------
// `service_intervals` is written by BOTH pipelines — one row per
// (vehicle_config_id, service_id) — and `shouldOverwriteInterval` arbitrates
// entirely on the existing row's `data_quality`:
//
//     PROTECTED_DATA_QUALITY = ["deterministic", "oem_manual"]
//
// If a route-ingested interval were stamped `oem_manual`, it would become
// protected, and the PDF extraction of the actual factory manual — the better
// source — would later be REFUSED with `protected_oem_manual`. The cheap read
// would permanently outrank the good one, and nothing would report it.
//
// So route sources never stamp `oem_manual`, not even from an OEM host. They
// stamp a quality outside the protected set, which means:
//
//   - a route interval fills a gap (no_existing_row) or upgrades a weaker row,
//   - a later PDF extraction overwrites it freely (upgrade_from_route_*),
//   - `mechanic_verified` still outranks both, unchanged.
//
// The justification for refusing OEM-hosted route text the `oem_manual` stamp
// is the citation asymmetry: the PDF path carries page-level citations from the
// Files API, the route path carries a section URL resolved by string search
// (see assemble.locateQuote). Same words, weaker evidence, so weaker rights.
// =============================================================================

import type { DirectSourceTier } from "../manualDirectSources";
import type { RouteSource } from "./types";

/**
 * `data_quality` values written by the route path.
 *
 * Deliberately NOT members of PROTECTED_DATA_QUALITY in manualLibrary.ts. If
 * either string is ever added there, route ingest silently starts blocking the
 * PDF pipeline — that list and this one are a matched pair.
 */
export const ROUTE_QUALITY_OEM = "route_oem";
export const ROUTE_QUALITY_REDISTRIBUTOR = "route_redistributor";

export const ROUTE_DATA_QUALITIES: readonly string[] = [
  ROUTE_QUALITY_OEM,
  ROUTE_QUALITY_REDISTRIBUTOR,
];

export type RouteIntervalProvenance = {
  data_quality: string;
  confidence: number;
};

/**
 * Interval provenance for a source's tier.
 *
 * Confidences sit below the PDF path's 0.95 and are ordered by how much of the
 * chain we can vouch for: an OEM host serving its own text loses only the
 * citation precision (0.80); a third-party transcription also loses the
 * guarantee that the text is unaltered (0.70).
 */
export function routeIntervalProvenance(tier: DirectSourceTier): RouteIntervalProvenance {
  return tier === "oem"
    ? { data_quality: ROUTE_QUALITY_OEM, confidence: 0.8 }
    : { data_quality: ROUTE_QUALITY_REDISTRIBUTOR, confidence: 0.7 };
}

/**
 * Guard for the manifest: a source that would launder provenance is refused
 * before it can be walked.
 *
 * `owners_manual` is the family manualSpecs assigns to a manufacturer's OWN
 * manual. A republisher claiming it would make PDF + route look like two
 * independent families of one claim and inflate a spec over the quote gate on
 * what is really a single source read twice. `resolveOperator` dedups by
 * operator within a family, but only for hosts it maps — an unmapped
 * republisher would slip through.
 */
export function assertRouteProvenanceSane(source: RouteSource): string | null {
  if (source.family === "owners_manual" && source.tier !== "oem") {
    return `${source.id}: family "owners_manual" requires tier "oem" (would claim manufacturer authority for a third-party host)`;
  }
  if (source.family === "human" || source.family === "gov") {
    return `${source.id}: family "${source.family}" cannot come from a route walk`;
  }
  return null;
}
