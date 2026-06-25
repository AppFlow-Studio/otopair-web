// convex/lib/laborBands.ts
/**
 * laborBands.ts — Tolerance bands and source classification for the
 * multi-source labor model (spec 2026-06-13-labor-multisource-design).
 *
 * Two bands, both expressed in HOURS:
 *  - GUARDRAIL: source-result vs the Pricing-v2 tier fallback. Flat 15 min.
 *  - AGREEMENT: source-vs-source. max(15 min, 10% of value) so a 4.5h job
 *    isn't held to a ~5% window.
 *
 * Promoted to a director-adjustable setting later; constants for now.
 */

/** Source-vs-fallback guardrail: flat 15 minutes. */
export const GUARDRAIL_BAND_HOURS = 0.25;
/** Source-vs-source agreement floor: 15 minutes. */
export const AGREEMENT_BAND_MIN_HOURS = 0.25;
/** Source-vs-source agreement widens to this fraction of the larger value. */
export const AGREEMENT_BAND_PCT = 0.1;

/**
 * Web/portal-extracted labor sources eligible to anchor a quote-grade value.
 * VDB (too generic) and LLM (guesswork) are NOT strong; the retired
 * `repairpal_motor` / `repairpal_labor` ($→hr hacks) are NOT strong. `web_labor`
 * and `oem_labor` are added by later phases but classified now so the agreement
 * rule is forward-compatible.
 */
export const STRONG_LABOR_SOURCES: ReadonlySet<string> = new Set([
  "repairpal_endpoint", // exact MOTOR flat-rate minutes — authoritative; drives book_hours when present
  "olp_labor",
  "web_labor",
  "oem_labor",
]);

/** Source result is corroborated by the tier fallback (within 15 min). */
export function withinGuardrail(a: number, b: number): boolean {
  return Math.abs(a - b) <= GUARDRAIL_BAND_HOURS + 1e-9;
}

/** Two source hours agree: within max(15 min, 10% of the larger value). */
export function withinAgreementBand(a: number, b: number): boolean {
  const band = Math.max(AGREEMENT_BAND_MIN_HOURS, AGREEMENT_BAND_PCT * Math.max(a, b));
  return Math.abs(a - b) <= band + 1e-9;
}
