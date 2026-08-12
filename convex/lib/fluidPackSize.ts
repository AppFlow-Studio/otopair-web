/**
 * lib/fluidPackSize.ts — container size for FLUID listings, so a jug price is
 * never billed as a per-unit price (Aug 2026).
 *
 * THE BUG THIS EXISTS FOR: fluids are billed per quart × capacity
 * (resolveRoleQuantity's fluid branch). A listing for a 5-quart JUG stores its
 * jug price in the same column a 1-quart bottle would, so a $36 jug on a
 * 6-quart car quotes 6 × $36 = $216 of oil. Observed live on
 * third-bird-914: "0W-20" rows at $36.00 against a per-quart median of $10.53.
 *
 * The absolute price bands (lib/priceBands.ts) are the existing backstop, but
 * they cannot catch this: engine_oil's band is [4, 40] and a 5-quart jug at
 * $36 sits comfortably inside it. Only the CONTAINER SIZE distinguishes a
 * dear per-quart bottle from a cheap jug, and that size is stated in the
 * listing title — which we already store as oem_parts.scraped_name.
 *
 * The fix is NORMALIZATION, not rejection: plenty of legitimate OEM fluids are
 * only sold by the jug (GM's dexos1 comes in 5-quart), and deleting those
 * would trade an over-quote for a missing part. Divide by the pack size and
 * the row becomes usable evidence.
 */

/** Roles billed per single unit (quart) whose listings routinely come in
 *  multi-unit containers. */
export const PACKAGED_FLUID_SUBCATEGORIES: ReadonlySet<string> = new Set([
  "engine_oil",
  "coolant",
  "atf_fluid",
  "gear_oil",
  "brake_fluid",
  "ps_fluid",
]);

/** US liquid quarts per unit of each container word. A US gallon is exactly
 *  4 quarts; a litre is 1.0567 quarts. */
const QUARTS_PER_LITRE = 1.0567;
const QUARTS_PER_GALLON = 4;

/**
 * Container size, in QUARTS, stated by a listing title — or null when the
 * title says nothing about size.
 *
 * Deliberately conservative. It must never read a VISCOSITY as a pack size
 * ("0W-20", "5W-30" carry bare digits) nor a part number, so every match is
 * anchored on an explicit unit word. Returns null rather than guessing: an
 * unknown size leaves the price untouched, which is the safe direction.
 */
export function detectPackQuarts(title: string | null | undefined): number | null {
  const t = String(title ?? "").toLowerCase();
  if (!t) return null;

  // Scrape junk is not evidence. Some stored titles are raw markdown blobs
  // ("- [![5W30 Top Tec 4600 Engine Oil (5 Liters) - Liqui Moly](https://…
  // .jpg?1737984165)"), and a row whose TITLE was captured that badly has an
  // equally untrustworthy PRICE — dividing one by the other manufactures a
  // confident wrong number (that live row would have become $2.38/qt). Refuse
  // to read a size from such a title; the per-unit ceiling still judges the
  // price on its own.
  if (/!\[|\]\(http|https?:\/\//.test(t)) return null;

  // Strip viscosity grades FIRST so their digits can never be read as a
  // quantity ("5W-30 5 Quart" must find 5 quarts, not 30 of something).
  const cleaned = t.replace(/\b\d{1,2}\s*w\s*[-‐-―−]?\s*\d{1,2}\b/g, " ");

  // "5 quart", "5qt", "5-Quart", "5 qts"
  const qt = /(\d+(?:\.\d+)?)\s*-?\s*(?:quarts?|qts?)\b/.exec(cleaned);
  if (qt) {
    const n = Number(qt[1]);
    if (Number.isFinite(n) && n > 0 && n <= 55) return n;
  }

  // "5 liter", "5L", "1 litre" — the European bottle unit.
  //
  // GUARDED, because a litre figure in a parts title is far more often an
  // ENGINE DISPLACEMENT than a container: the live row "Engine Oil (5.7L
  // Engine)" was read as a 5.7-quart jug and its $8.04 per-quart price was
  // "normalized" down to $1.34. Two independent guards:
  //   - a displacement word following the match (engine, V8, turbo, ...);
  //   - a fractional value, since containers come in whole 1/4/5/20 units
  //     while displacements are overwhelmingly x.y — a decimal is only
  //     accepted when the unit is spelled out ("1.5 litre bottle").
  const ltRe = /(\d+(?:\.\d+)?)\s*-?\s*(liters?|litres?|l)\b(.{0,14})/g;
  for (const m of cleaned.matchAll(ltRe)) {
    const n = Number(m[1]);
    const spelledOut = /liter|litre/.test(m[2]);
    const trailing = m[3] ?? "";
    if (/^\s*[)\]]?\s*(engine|motor|v\d|i\d|l\d|cyl|turbo|tdi|tfsi|tsi|diesel|gas)/.test(trailing)) {
      continue; // displacement, not a container
    }
    if (!Number.isInteger(n) && !spelledOut) continue; // "5.7L" — displacement
    if (Number.isFinite(n) && n > 0 && n <= 55) {
      return Math.round(n * QUARTS_PER_LITRE * 100) / 100;
    }
  }

  // "1 gallon", "gallon", "gal"
  const gal = /(?:(\d+(?:\.\d+)?)\s*-?\s*)?\b(?:gallons?|gal)\b/.exec(cleaned);
  if (gal) {
    const n = gal[1] ? Number(gal[1]) : 1;
    if (Number.isFinite(n) && n > 0 && n <= 15) return n * QUARTS_PER_GALLON;
  }

  // "case of 6", "6 pack", "pack of 12" — cases of 1-quart bottles.
  const pack = /(?:case\s+of\s+(\d+)|pack\s+of\s+(\d+)|(\d+)\s*-?\s*pack)\b/.exec(cleaned);
  if (pack) {
    const n = Number(pack[1] ?? pack[2] ?? pack[3]);
    if (Number.isFinite(n) && n > 1 && n <= 24) return n;
  }

  return null;
}

/**
 * Per-unit price ceilings, TIGHTER than lib/priceBands.ts.
 *
 * The bands exist to reject the absurd and are deliberately generous; these
 * exist to flag "this reads like a container price". A row above the ceiling
 * with a known pack size gets normalized; above the ceiling with NO known
 * size it is not trustworthy as a per-unit figure.
 *
 * Anchored on observed medians (devOnly/oilCoverage:observedOilPrices — oil's
 * median is $10.53/qt across 119 rows), set ~2.5x above so a genuinely
 * expensive single bottle still passes.
 */
export const FLUID_UNIT_CEILING_USD: Readonly<Record<string, number>> = {
  engine_oil: 25,
  coolant: 35,
  atf_fluid: 40,
  gear_oil: 40,
  brake_fluid: 30,
  ps_fluid: 30,
};

export type FluidPriceVerdict = {
  /** Price to store, per single unit. */
  price: number;
  /** Container size used to divide, when one was found. */
  packQuarts: number | null;
  /** normalized: divided by a detected pack size.
   *  suspect_unpriceable: reads like a container price but no size is stated.
   *  ok: left exactly as supplied. */
  action: "ok" | "normalized" | "suspect_unpriceable";
};

/**
 * Judge one fluid price row against its listing title.
 *
 * Non-fluid subcategories and prices under the ceiling pass through
 * untouched, so this is safe to call on every price write.
 */
export function normalizeFluidPrice(input: {
  subcategory: string | null | undefined;
  price: number;
  title: string | null | undefined;
}): FluidPriceVerdict {
  const sub = String(input.subcategory ?? "");
  const price = Number(input.price);
  if (!PACKAGED_FLUID_SUBCATEGORIES.has(sub) || !Number.isFinite(price) || price <= 0) {
    return { price, packQuarts: null, action: "ok" };
  }

  const packQuarts = detectPackQuarts(input.title);
  // A stated multi-unit container is authoritative regardless of price: a
  // CHEAP jug ($22 for 5 qt) is exactly as wrong per-quart as a dear one.
  if (packQuarts != null && packQuarts >= 2) {
    return {
      price: Math.round((price / packQuarts) * 100) / 100,
      packQuarts,
      action: "normalized",
    };
  }

  const ceiling = FLUID_UNIT_CEILING_USD[sub];
  if (ceiling != null && price > ceiling) {
    return { price, packQuarts, action: "suspect_unpriceable" };
  }
  return { price, packQuarts, action: "ok" };
}
