/**
 * lib/priceBands.ts — per-subcategory absolute price sanity bands (USD, per
 * unit as billed: per quart for fluids, per plug, per pad SET, per rotor).
 *
 * Purpose: catch ABSURD prices, not price variance. MAD outlier rejection in
 * part_prices.summarizePriceRows is inert below 3 sources, so with 1-2 scraped
 * rows a single bad extraction (a $400 "cabin filter" that was really a
 * bundle, a pack price stored as a unit price) would drive the quote
 * unchallenged. These bounds are deliberately GENEROUS — a legitimate premium
 * part must never be rejected; only physically implausible numbers are.
 *
 * A violation never blocks a write outright — the row is stored as
 * UNVERIFIED_PRICE_TYPE (excluded from customer-facing math via the poison
 * list, kept for audit) — so a band that ages badly loses us nothing.
 */

export const PRICE_BANDS: Record<string, readonly [number, number]> = {
  air_filter: [4, 150],
  atf_fluid: [6, 90],
  battery: [60, 900],
  brake_fluid: [4, 60],
  cabin_filter: [3, 120],
  coolant: [8, 90],
  drain_plug_gasket: [0.25, 25],
  engine_oil: [4, 40],
  friction_modifier: [4, 60],
  front_brake_hardware_kit: [5, 150],
  front_brake_pad: [25, 700],
  front_brake_wear_sensor: [5, 120],
  // Rotor max accommodates carbon-ceramic OEM rotors (thousands each); the CCB
  // quote path has its own carve-out, but part_prices rows still exist.
  front_rotor: [20, 3000],
  gear_oil: [8, 80],
  ignition_coil: [15, 300],
  intake_manifold_gasket: [5, 200],
  oil_filter: [2, 80],
  oil_filter_housing_oring: [0.5, 40],
  ps_fluid: [5, 60],
  rear_brake_hardware_kit: [5, 150],
  rear_brake_pad: [25, 700],
  rear_brake_wear_sensor: [5, 120],
  rear_rotor: [20, 3000],
  serpentine_belt: [10, 150],
  spark_plug: [3, 70],
  timing_belt: [15, 300],
  timing_kit: [50, 900],
  trans_filter: [10, 200],
  trans_pan_gasket: [5, 150],
  water_pump: [30, 800],
  wiper_blade_front_set: [8, 120],
  wiper_blade_rear: [4, 60],
};

export function priceBandFor(
  subcategory: string | null | undefined,
): readonly [number, number] | null {
  if (!subcategory) return null;
  return PRICE_BANDS[subcategory] ?? null;
}

/** True when the price is inside its subcategory band, or no band exists. */
export function isWithinPriceBand(
  subcategory: string | null | undefined,
  price: number,
): boolean {
  const band = priceBandFor(subcategory);
  if (!band) return true;
  return price >= band[0] && price <= band[1];
}
