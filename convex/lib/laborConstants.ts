/**
 * laborConstants.ts — shared empirical sample-size gates.
 *
 * Deliberately IMPORT-FREE (a leaf module) so it can be imported by both
 * quoteEngine and labor_aggregation without forming a cycle. labor_aggregation
 * imports detectTier from quoteEngine; quoteEngine imports these gates. Capturing
 * a value across that cycle risks `undefined` at module-init under esbuild's CJS
 * bundling (Convex), which would silently disable the empirical gate — a leaf
 * module avoids it entirely.
 */

/** Post-job actuals must reach this count before empirical is WRITTEN. */
export const LABOR_EMPIRICAL_MIN_SAMPLES = 3;

/**
 * Minimum empirical sample size to surface empirical hours in a customer-facing
 * QUOTE or any read path (quoteEngine, v3queries, service_vehicle_specs,
 * laborTimes). Higher than the write gate (3) so quotes wait for a more stable
 * median before trusting post-job actuals over book data.
 */
export const LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES = 5;
