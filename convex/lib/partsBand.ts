/**
 * partsBand.ts — PURE aggregation of real per-config parts prices into a quote
 * band. No Convex imports (unit-tested: tests/partsBand.test.ts).
 *
 * Policy (design 2026-06-22-parts-real-primary-endpoint): real per-config data
 * is PRIMARY; Camry × tier-multiplier is STRICTLY fallback.
 *
 * Gathered SKU prices and RepairPal's range are PEERS — both contribute to a
 * role's band, and neither validates/gates the other. SKU prices are already
 * vetted upstream by the parts pipeline's own verification, so RepairPal does
 * NOT police them; and when RepairPal has no data for a make (e.g. Subaru), SKU
 * prices stand on their own. A role is reliable when it has a RepairPal range OR
 * ≥ minSkuSources gathered SKU prices. A service is "real-quotable" only when
 * EVERY part role is reliable; otherwise the whole service falls back to the
 * multiplier (never mix real + fallback within one service's parts).
 */

export type PartsRoleInput = {
  /** part role (oem_parts.subcategory, + position for brakes) — for labeling. */
  role: string;
  /** gathered per-SKU point prices for this role (across source_domains), pre-vetted. */
  skuPrices: number[];
  /** RepairPal trusted range for the role's part type, if matched. */
  repairpalRange?: { low: number; high: number } | null;
};

export type PartsBandResult = {
  reliable: boolean;
  low: number;
  high: number;
  source: "real_parts" | "fallback";
  reliableRoles: number;
  totalRoles: number;
};

/** opts.minSkuSources: SKU-only reliability threshold (default 1; raise for binding-quote safety). */
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
    const skus = r.skuPrices ?? [];
    const hasRp = !!r.repairpalRange;
    if (!hasRp && skus.length < minSku) continue; // no real evidence → forces fallback

    reliableRoles++;
    // Peers: pool SKU points with the RepairPal range edges; span the evidence.
    const lows = hasRp ? [...skus, r.repairpalRange!.low] : skus;
    const highs = hasRp ? [...skus, r.repairpalRange!.high] : skus;
    low += Math.min(...lows);
    high += Math.max(...highs);
  }

  const reliable = totalRoles > 0 && reliableRoles === totalRoles;
  return reliable
    ? { reliable: true, low, high, source: "real_parts", reliableRoles, totalRoles }
    : { reliable: false, low: 0, high: 0, source: "fallback", reliableRoles, totalRoles };
}
