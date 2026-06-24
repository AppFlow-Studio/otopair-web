/**
 * partsBand.ts — PURE aggregation of real per-config parts prices into a quote
 * band. No Convex imports (unit-tested: tests/partsBand.test.ts).
 *
 * Policy (handoff 2026-06-23, user's chosen design): per role, POOL the gathered
 * SKU prices WITH the RepairPal endpoint averaged per-unit POINT as peers (the
 * endpoint is appended to the role's price pool). When a role has no SKU prices
 * the endpoint point stands alone (the safety net). If a role has neither, the
 * whole service is unreliable and the caller uses the Camry × tier-multiplier
 * fallback (never mix real + fallback within a service).
 *
 * The band returned is the PER-CONFIG TOTAL (Σ over roles of pooled-per-unit
 * [min,max] × the config's resolved quantity), so the caller must NOT re-apply
 * unit-scaling.
 *
 * PLANNED (not done) — blend SKU + endpoint into one AVERAGED price:
 * The intent was to average our gathered SKU prices (often aftermarket) with the
 * RepairPal endpoint price (OEM/dealer-flavored) into a single representative
 * number — i.e. pool them and quote the blended mean/median. This is deliberately
 * NOT enabled yet because the shadow-diff (2026-06-23,
 * docs/superpowers/reviews/2026-06-23-parts-real-primary-shadow-diff.md) found the
 * endpoint's price RANGE is sometimes far too large to average cleanly: RepairPal
 * occasionally returns a wrong-variant value (e.g. a RAV4 12V battery came back at
 * $1507 — the hybrid traction pack — vs the real ~$130 dealer SKU). Today this
 * helper takes raw [min,max], so such an outlier blows the band wide. Revisit by
 * switching to a robust blended average + an outlier/large-gap guard before the
 * PARTS_SOURCE_REAL_PRIMARY flag is flipped on.
 */

export type PartsRoleInput = {
  /** part role (oem_parts.subcategory / roleKey) — for labeling. */
  role: string;
  /** config's resolved quantity for this role (resolveRoleQuantity). */
  quantity: number;
  /** gathered per-SKU per-unit prices (excl. the endpoint source), pre-vetted. */
  skuPrices: number[];
  /** RepairPal endpoint averaged PER-UNIT point (avg ÷ endpoint.quantity), if any. */
  endpointUnitPrice?: number | null;
};

export type PartsBandResult = {
  reliable: boolean;
  low: number;
  high: number;
  source: "real_parts" | "fallback";
  reliableRoles: number;
  totalRoles: number;
};

/** opts.minSkuSources: SKU-reliability threshold (default 1; raise for binding-quote safety). */
export function aggregatePartsBand(
  roles: PartsRoleInput[],
  opts?: { minSkuSources?: number },
): PartsBandResult {
  const minSku = opts?.minSkuSources ?? 1;
  const totalRoles = roles.length;
  let reliableRoles = 0;
  let low = 0;
  let high = 0;

  for (const r of roles) {
    const qty = r.quantity > 0 ? r.quantity : 1;
    const skus = (r.skuPrices ?? []).filter((n) => typeof n === "number" && n > 0);
    const hasEndpoint = typeof r.endpointUnitPrice === "number" && r.endpointUnitPrice > 0;

    // Reliable when SKU clears the threshold OR the endpoint point exists.
    if (skus.length < minSku && !hasEndpoint) continue; // no real evidence → forces fallback

    // Pool SKU points WITH the endpoint point (peers). When only the endpoint
    // exists, it is the whole pool (the safety net).
    const pooled = hasEndpoint ? [...skus, r.endpointUnitPrice as number] : skus;
    reliableRoles++;
    low += Math.min(...pooled) * qty;
    high += Math.max(...pooled) * qty;
  }

  const reliable = totalRoles > 0 && reliableRoles === totalRoles;
  return reliable
    ? { reliable: true, low, high, source: "real_parts", reliableRoles, totalRoles }
    : { reliable: false, low: 0, high: 0, source: "fallback", reliableRoles, totalRoles };
}
