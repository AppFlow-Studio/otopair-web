/**
 * Enrichment system constants — thresholds, floors, and display logic.
 * Shared across the pipeline, consensus, source scoring, and UI.
 */

/** Minimum confidence for data to be shown as "estimated" vs "unverified" in the UI. */
export const CONFIDENCE_FLOOR = 0.75;

/** Number of independent sources needed before data is marked "confirmed". */
export const MIN_SOURCES_FOR_CONFIRMED = 2;

/** Days before a cached enrichment is considered stale and re-enriched on next access. */
export const CACHE_STALENESS_DAYS = 180;

/** Sanity floor for coolant flush interval in miles. Anything at or below this is rejected
 *  as contaminated training data (known kbb.com misparse: coolant → 10K = oil change interval). */
export const COOLANT_FLUSH_FLOOR_MILES = 15000;

/** Source accuracy rate below which a source gets auto-blocked after sufficient observations. */
export const SOURCE_AUTOBLOCK_THRESHOLD = 0.40;

/** Minimum observations a source must have before auto-blocking can trigger.
 *  Prevents blocking sources based on 1-2 unlucky extractions. */
export const SOURCE_AUTOBLOCK_MIN_OBSERVATIONS = 20;

/**
 * Determines how enriched data should be displayed in the UI.
 *
 * - "verified" — a mechanic confirmed this value on a real job
 * - "confirmed" — multiple independent sources agree with high confidence
 * - "estimated" — single source or moderate confidence; shown with caveat
 * - "unverified" — low confidence; may be wrong, shown with strong caveat
 */
export function getDisplayConfidence(
  confidence: number,
  sourceCount: number,
  mechanicVerified: boolean,
): "verified" | "confirmed" | "estimated" | "unverified" {
  if (mechanicVerified) return "verified";
  if (confidence >= 0.85 && sourceCount >= MIN_SOURCES_FOR_CONFIRMED) return "confirmed";
  if (confidence >= CONFIDENCE_FLOOR) return "estimated";
  return "unverified";
}
