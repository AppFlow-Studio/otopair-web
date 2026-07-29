/**
 * convex/lib/sourceNames.ts — canonical, vendor-neutral source vocabulary for
 * the external estimate provider ("estimator").
 *
 * This module is the ONLY place the estimator's source vocabulary is spelled
 * out. Every reader/writer of `labor_observations.source`,
 * `part_prices.price_type` and `part_prices.source_domain` must go through the
 * helpers here rather than comparing string literals, so the vocabulary can
 * never drift and a future rename is a one-file change.
 *
 * ── DUAL-READ WINDOW ──────────────────────────────────────────────────────
 * Rows written before the rename still carry the legacy provider-named values.
 * WRITES always emit the canonical names below; READS accept canonical OR
 * legacy until convex/migrations/purgeVendorNames.ts has run to completion on
 * every deployment.
 *
 * AFTER the migration is verified, delete the LEGACY_* constants and the
 * `...LEGACY` spreads — that removes the last provider strings from the repo.
 * Nothing else needs to change, because nothing else references them.
 */

// ─── Canonical source names (what we write) ───────────────────────────────

/** Exact flat-rate labor minutes from the estimator's estimate endpoint —
 *  the authoritative labor source; drives book_hours outright when present. */
export const ESTIMATOR_ENDPOINT_SOURCE = "estimator_endpoint";

/** Retired book-rate-derived labor observations (legacy $→hr conversion). */
export const ESTIMATOR_BOOK_SOURCE = "estimator_book";

/** Retired estimator labor observations (legacy $→hr conversion). */
export const ESTIMATOR_LABOR_SOURCE = "estimator_labor";

/** `part_prices.price_type` / `source_domain` stamped on the estimator's
 *  averaged per-unit point (a valid market signal, but reserved as a per-part
 *  fallback and excluded from the pooled SKU aggregate). */
export const ESTIMATOR_ENDPOINT_PRICE_TYPE = ESTIMATOR_ENDPOINT_SOURCE;

// ─── Legacy aliases (read-only; delete after migration) ───────────────────
// DO NOT write these. They exist solely so pre-rename rows keep resolving
// during the dual-read window.

const LEGACY_ENDPOINT_SOURCE = "repairpal_endpoint";
const LEGACY_BOOK_SOURCE = "repairpal_motor";
const LEGACY_LABOR_SOURCE = "repairpal_labor";

/** Every value that has ever meant "estimator estimate endpoint". */
export const ESTIMATOR_ENDPOINT_SOURCES: ReadonlySet<string> = new Set([
  ESTIMATOR_ENDPOINT_SOURCE,
  LEGACY_ENDPOINT_SOURCE,
]);

/** Every value that has ever meant one of the retired $→hr estimator sources. */
export const ESTIMATOR_RETIRED_SOURCES: ReadonlySet<string> = new Set([
  ESTIMATOR_BOOK_SOURCE,
  ESTIMATOR_LABOR_SOURCE,
  LEGACY_BOOK_SOURCE,
  LEGACY_LABOR_SOURCE,
]);

/** Every value that has ever meant the retired book-rate observation. */
export const ESTIMATOR_BOOK_SOURCES: ReadonlySet<string> = new Set([
  ESTIMATOR_BOOK_SOURCE,
  LEGACY_BOOK_SOURCE,
]);

/** True for the retired book-rate observation, canonical or legacy. */
export function isEstimatorBookSource(source: string | null | undefined): boolean {
  return source != null && ESTIMATOR_BOOK_SOURCES.has(source);
}

/** True for an estimate-endpoint observation, canonical or legacy. */
export function isEstimatorEndpointSource(source: string | null | undefined): boolean {
  return source != null && ESTIMATOR_ENDPOINT_SOURCES.has(source);
}

/** True for a retired estimator-derived labor observation, canonical or legacy. */
export function isEstimatorRetiredSource(source: string | null | undefined): boolean {
  return source != null && ESTIMATOR_RETIRED_SOURCES.has(source);
}

/**
 * Canonicalize any estimator source/price_type value to its current name.
 * Non-estimator values pass through untouched, so this is safe to apply
 * blanket-wise in a migration or a display layer.
 */
export function canonicalizeSourceName(source: string): string {
  switch (source) {
    case LEGACY_ENDPOINT_SOURCE:
      return ESTIMATOR_ENDPOINT_SOURCE;
    case LEGACY_BOOK_SOURCE:
      return ESTIMATOR_BOOK_SOURCE;
    case LEGACY_LABOR_SOURCE:
      return ESTIMATOR_LABOR_SOURCE;
    default:
      return source;
  }
}

/** Legacy values, exported ONLY for the migration's scan/rewrite pass. */
export const LEGACY_ESTIMATOR_SOURCE_VALUES: readonly string[] = [
  LEGACY_ENDPOINT_SOURCE,
  LEGACY_BOOK_SOURCE,
  LEGACY_LABOR_SOURCE,
];
