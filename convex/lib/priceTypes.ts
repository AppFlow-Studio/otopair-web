/**
 * convex/lib/priceTypes.ts — the single source of truth for part_prices
 * price_type trust tiers, shared by the aggregator (part_prices.ts), the
 * re-extraction caller (directorConfigBackfills / v3pipeline), the corpus
 * backfill (vehicleEnrichment/backfills.ts), and the inspector
 * (devOnly/verifyParts) so the vocabulary can never drift between them.
 *
 *   - POISON: a known-wrong figure (online_discount / you_save — the MSRP /
 *     "was" / "You Save" capture bug) or a value no tier could verify
 *     (unverified). NEVER counts toward the customer-facing price.
 *   - Everything else (sale, llm_estimate, manual_seed, and legacy untyped
 *     rows) is trusted enough to aggregate.
 */

/** price_type values that must be excluded from the customer-facing aggregate. */
export const POISON_PRICE_TYPES = new Set<string>([
  "online_discount",
  "you_save",
  "unverified",
]);

/** The tag stamped on a row that no tier could verify (kept for audit, excluded
 *  from the median). */
export const UNVERIFIED_PRICE_TYPE = "unverified";

/** True when a row must NOT count toward the headline price (median/average/band). */
export function isPoisonPriceType(priceType: string | null | undefined): boolean {
  return priceType != null && POISON_PRICE_TYPES.has(priceType);
}

/** Valid market signals that are RESERVED as per-part fallbacks (not poison),
 *  excluded from the pooled SKU aggregate. The RepairPal endpoint averaged
 *  per-unit point is the first member — only resolvePartsCost's gated real-band
 *  block reads it; summarizePriceRows (booking_quotes/serviceParts/job_actuals)
 *  must not. */
export const REPAIRPAL_ENDPOINT_PRICE_TYPE = "repairpal_endpoint";

/** price_type values that are valid but reserved as per-part fallbacks —
 *  excluded from the pooled SKU aggregate (mirrors POISON_PRICE_TYPES' shape). */
export const NON_POOLED_PRICE_TYPES = new Set<string>([REPAIRPAL_ENDPOINT_PRICE_TYPE]);

/** True when a row is valid but must NOT enter the pooled per-part aggregate. */
export function isNonPooledPriceType(priceType: string | null | undefined): boolean {
  return priceType != null && NON_POOLED_PRICE_TYPES.has(priceType);
}
