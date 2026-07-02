/**
 * buildShopPriceLabel
 *
 * Single source of truth for the per-shop price string in the
 * booking-flow Choose-Mechanic screen — used by both the floating
 * MapShopCard and each ShopPage carousel card so they never disagree.
 *
 * Mirrors the legacy ShopCard / Review & Pay math: `deriveDisclosedRange`
 * over labor + variable parts (±band) + tax + platform fee, with
 * per-(shop, service, tier) fixed-price overrides collapsing their line
 * to a flat amount (no band, labor not double-billed).
 *
 * When every priced line is fixed (or fixed + state fees only) the band
 * collapses — `low === high` — and the price renders as a single `$N`
 * with no "~" and no range. `isFixed` is then true so callers can swap
 * the "Estimated price" eyebrow for "Fixed price".
 */

import { deriveDisclosedRange } from "@/lib/disclosedRange";
import type { Service } from "@/stores/types/store.types";

export type ShopPriceLabel = {
  /** `$120` (fixed) · `~$90` (single estimate) · `~$70 – $86` (range) ·
   *  null when there's nothing to price. */
  text: string | null;
  /** True only when the price is guaranteed (band collapsed AND at least
   *  one fixed-price line). Drives the "Fixed price" vs "Estimated" copy. */
  isFixed: boolean;
};

export function buildShopPriceLabel(args: {
  shop: { labor_rate?: number; state?: string; zip?: string };
  selectedServices: Service[];
  /** Resolved per-service labor hours (empirical → book → default). */
  laborHoursMap: Map<string, number>;
  /** serviceId → flat price (dollars) for this shop + vehicle tier. */
  fixedPriceMap: Map<string, number>;
}): ShopPriceLabel {
  const { shop, selectedServices, laborHoursMap, fixedPriceMap } = args;
  if (selectedServices.length === 0) return { text: null, isFixed: false };

  const laborRate = shop.labor_rate ?? 0;
  const hasAnyFixed = selectedServices.some((s) => fixedPriceMap.has(s.id));
  const hoursFor = (s: Service) =>
    laborHoursMap.get(s.id) ?? s.default_labor_hours ?? 0;

  // Fixed lines drop out of the variable parts band; everything else
  // contributes its catalog parts estimate to the ±band.
  const variablePartsCost = selectedServices.reduce(
    (sum, s) =>
      fixedPriceMap.has(s.id) ? sum : sum + (s.default_parts_estimate ?? 0),
    0,
  );
  const fixedPriceLines = selectedServices
    .filter((s) => fixedPriceMap.has(s.id))
    .map((s) => ({
      serviceId: s.id,
      laborCost: laborRate * hoursFor(s),
      partsFixed: fixedPriceMap.get(s.id) ?? 0,
    }));
  const laborCost = selectedServices.reduce(
    (sum, s) => sum + laborRate * hoursFor(s),
    0,
  );

  const range = deriveDisclosedRange({
    laborCost,
    partsCost: variablePartsCost,
    state: shop.state ?? null,
    zip: shop.zip ?? null,
    fixedPriceLines,
  });
  const low = Math.round(range.lowDollars);
  const high = Math.round(range.highDollars);

  if (low <= 0) return { text: null, isFixed: false };
  if (low === high) {
    return { text: hasAnyFixed ? `$${low}` : `~$${low}`, isFixed: hasAnyFixed };
  }
  return { text: `~$${low} – $${high}`, isFixed: false };
}
