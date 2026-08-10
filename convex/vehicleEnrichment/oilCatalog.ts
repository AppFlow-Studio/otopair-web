// =============================================================================
// vehicleEnrichment/oilCatalog.ts — OE engine-oil catalog keyed by VISCOSITY
// (Aug 2026).
//
// WHY: engine oil was the least reliable line in an oil-change quote. Across
// the last ten enriched vehicles only 6 carried a real engine-oil part; the
// other 4 (RDX, CX-30, XC90, Palisade) quoted oil at the generic $11/qt
// universalFallback — a placeholder that reaches the customer as, e.g.,
// 6 qt x $11 = $66. Two independent causes:
//   1. engines.oil_viscosity is missing on ~12% of engines, and oilProduct's
//      viscosityMatcher returns null for an unusable grade, so that rung
//      REFUSES TO RUN — no viscosity, no oil, ever.
//   2. even with a viscosity, oilProduct hunts the MAKE'S OWN per-quart
//      bottle and makes it pass that make's part-number format gate. That
//      needle is too narrow: the RDX, CX-30 and Palisade all knew their
//      grade and still found nothing.
//
// PRODUCT DECISION (operator, Aug 2026): "we can use OEM or OE oils, it's the
// same, it's just oil." This is a DELIBERATE, OIL-ONLY exception to the
// OEM-only rule that governs every other part — engine oil is a commodity
// fluid whose safety-critical fact is the GRADE, not the brand on the bottle.
// Nothing here loosens OEM-only for any other role.
//
// WHAT THIS IS: a small curated table, one row per SAE grade the fleet
// actually uses (11 grades cover every engine we hold; 0W-20 alone is 44%).
// A row is a real, widely-stocked OE-grade full synthetic named by GRADE, and
// its identifier is explicitly an OE marker — never a fabricated OEM SKU.
// Inventing OEM part numbers is the exact failure this file exists to end.
//
// PRECEDENCE: this NEVER outranks a genuine OEM bottle. oilProduct.ts runs
// first and its find (Mitsubishi LM2207, Nissan 999PK-000W20N) wins; this
// fills only the hole that would otherwise be a generic placeholder. The
// per-quart price is a market-typical default and is superseded the moment
// the price backfill observes a real price for the row.
// =============================================================================

/** One curated OE oil row. */
export interface OeOilRow {
  /** Canonical SAE grade, e.g. "0W-20". */
  viscosity: string;
  /** Invoice-facing name — states the grade, so the line is unambiguous to
   *  the customer and to the technician filling the sump. */
  name: string;
  /** Deterministic identifier, sharing the universal-consumable lane's
   *  `OTOPAIR-UNIV-` convention (seeds/seedUniversalConsumables.ts) so the
   *  DB has ONE naming scheme for make-agnostic lines — and so it can never
   *  be mistaken for, or matched against, a manufacturer SKU. */
  identifier: string;
  /** Market-typical per-quart price, used only until a real observed price
   *  lands. Deliberately conservative — under-quoting oil is worse than a
   *  slightly high placeholder that real pricing replaces. */
  pricePerQuartUsd: number;
}

/**
 * Canonicalize a viscosity string to "<n>W-<nn>".
 *
 * Real stored values this must survive (live fleet, Aug 2026):
 *   "0W-20", "0w20", "0 W - 20", and the malformed
 *   "5W-30 (VW 502 00; alt: 5W-40 or 0W-40)" — a spec note crammed into the
 *   grade column, which must canonicalize to its PRIMARY grade "5W-30" and
 *   never to one of the alternates mentioned later in the string.
 * Returns null when no grade can be read, which callers treat as "unknown
 * viscosity" — never as a licence to guess.
 */
export function normalizeViscosity(raw: string | null | undefined): string | null {
  const s = String(raw ?? "");
  // First grade token wins: the leading value is the requirement, anything
  // after it in these strings is an alternate or a spec citation.
  // Dash class covers hyphen-minus, non-breaking hyphen (U+2011), figure
  // dash, en/em dash and the maths minus — scraped spec text carries all of
  // them and a missed variant silently reads as "no viscosity".
  const m = /(\d{1,2})\s*[wW]\s*[-‐-―−]?\s*(\d{1,2})\b/.exec(s);
  if (!m) return null;
  const low = Number(m[1]);
  const high = Number(m[2]);
  // Sanity: SAE winter grades are 0/5/10/15/20/25; high grades 8-60.
  if (![0, 5, 10, 15, 20, 25].includes(low)) return null;
  if (high < 8 || high > 60) return null;
  return `${low}W-${high}`;
}

/**
 * The catalog. One row per grade observed across the fleet, ordered by how
 * common the grade is (0W-20 is 44% of engines).
 *
 * PRICES ARE EVIDENCE-BASED (Aug 9 2026). They are not estimates: each is the
 * MEDIAN of real per-quart prices we have already scraped for that grade,
 * across 119 price rows on 7 grades (devOnly/oilCoverage:observedOilPrices).
 * The first-pass estimates were wrong in both directions — 0W-30 was under by
 * a third ($10.50 vs an observed $14.06) and 0W-40 over by 14% — which is
 * exactly why they were replaced with measurement.
 *
 * Median, not mean, on purpose: the observed rows carry MULTI-QUART JUG
 * contamination (a "0W-20" row at $102.10, several at $36) that a mean would
 * swallow whole. Four grades have no observed rows yet and carry an anchored
 * estimate, labelled as such on the line.
 *
 * Re-derive after any material price refresh:
 *   npx convex run devOnly/oilCoverage:observedOilPrices '{}'
 */
export const OE_OIL_CATALOG: Readonly<Record<string, OeOilRow>> = {
  "0W-20": {
    viscosity: "0W-20",
    name: "Engine oil 0W-20 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-0W20",
    pricePerQuartUsd: 10.5, // observed median 10.53 (n=53)
  },
  "5W-30": {
    viscosity: "5W-30",
    name: "Engine oil 5W-30 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-5W30",
    pricePerQuartUsd: 9.75, // observed median 9.79 (n=24)
  },
  "5W-20": {
    viscosity: "5W-20",
    name: "Engine oil 5W-20 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-5W20",
    pricePerQuartUsd: 9.5, // observed median 9.49 (n=15)
  },
  "0W-30": {
    viscosity: "0W-30",
    name: "Engine oil 0W-30 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-0W30",
    pricePerQuartUsd: 14.0, // observed median 14.06 (n=6)
  },
  "0W-16": {
    viscosity: "0W-16",
    name: "Engine oil 0W-16 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-0W16",
    pricePerQuartUsd: 10.0, // observed median 10.00 (n=5)
  },
  "0W-40": {
    viscosity: "0W-40",
    name: "Engine oil 0W-40 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-0W40",
    pricePerQuartUsd: 11.0, // observed median 10.99 (n=9)
  },
  "5W-40": {
    viscosity: "5W-40",
    name: "Engine oil 5W-40 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-5W40",
    pricePerQuartUsd: 10.5, // observed median 10.40 (n=7)
  },
  "10W-30": {
    viscosity: "10W-30",
    name: "Engine oil 10W-30 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-10W30",
    pricePerQuartUsd: 9.5, // no observed rows — anchored to the cheapest evidenced grade (5W-20)
  },
  "15W-40": {
    viscosity: "15W-40",
    name: "Engine oil 15W-40 (OE-grade diesel full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-15W40",
    pricePerQuartUsd: 9.5, // no observed rows — bulk diesel oil, anchored to 5W-20
  },
  "0W-8": {
    viscosity: "0W-8",
    name: "Engine oil 0W-8 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-0W8",
    pricePerQuartUsd: 14.0, // no observed rows — anchored to the dearest evidenced grade (0W-30)
  },
  "5W-50": {
    viscosity: "5W-50",
    name: "Engine oil 5W-50 (OE-grade full synthetic)",
    identifier: "OTOPAIR-UNIV-ENGINE-OIL-5W50",
    pricePerQuartUsd: 13.0, // no observed rows — performance grade, estimate
  },
};

/** Catalog row for a (possibly messy) viscosity string, or null when the
 *  grade is unknown or uncatalogued. Never guesses a neighbouring grade — a
 *  5W-30 bottle must not fill a 0W-20 sump. */
export function lookupOeOil(viscosity: string | null | undefined): OeOilRow | null {
  const grade = normalizeViscosity(viscosity);
  if (!grade) return null;
  return OE_OIL_CATALOG[grade] ?? null;
}

/** True when this fitment identifier came from THIS catalog — lets the UI and
 *  the audits distinguish "real OEM bottle" from "OE stand-in" without a
 *  string-shape guess. */
export function isOeCatalogOil(identifier: string | null | undefined): boolean {
  const id = String(identifier ?? "").toUpperCase();
  return id.startsWith("OTOPAIR-UNIV-ENGINE-OIL-");
}
