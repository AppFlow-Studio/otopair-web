/**
 * laborFallback.ts — the Pricing-v2 tier fallback (Camry hours × labor
 * multiplier), factored out of quoteEngine so the labor aggregator (mutation
 * ctx) and the quote engine (query ctx) compute the SAME guardrail value.
 *
 * Read-only; takes a loose `ctx` (anything with db.query/get) so it works in
 * both query and mutation contexts.
 */

// Anchor — the 2020 Camry LE FWD vehicle_config (seeded by seedCamryBaseline).
export const CAMRY_FWD_CONFIG_KEY = "2020_toyota_camry_le_fwd_a25a-fks";

export async function getCamryFwdConfig(ctx: any): Promise<any | null> {
  return await ctx.db
    .query("vehicle_configs")
    .withIndex("by_config_key", (q: any) => q.eq("config_key", CAMRY_FWD_CONFIG_KEY))
    .first();
}

/**
 * Camry book_hours(service) × pricing_labor_multipliers[category][tier].
 * Returns null when the service has no labor category, no multiplier row for
 * the tier, no Camry seed, or no Camry hours for this service.
 */
export async function computeLaborTierFloorHours(
  ctx: any,
  { serviceId, vehicleTier }: { serviceId: any; vehicleTier: string },
): Promise<number | null> {
  const service = await ctx.db.get(serviceId);
  if (!service?.labor_multiplier_category_id) return null;
  const laborMultRow = await ctx.db
    .query("pricing_labor_multipliers")
    .withIndex("by_category_tier", (q: any) =>
      q.eq("labor_category_id", service.labor_multiplier_category_id).eq("tier", vehicleTier),
    )
    .first();
  if (!laborMultRow) return null;
  const camry = await getCamryFwdConfig(ctx);
  if (!camry) return null;
  const camryHours = await ctx.db
    .query("labor_times")
    .withIndex("by_vehicle_config_and_service", (q: any) =>
      q.eq("vehicle_config_id", camry._id).eq("service_id", serviceId),
    )
    .first();
  if (!camryHours?.book_hours) return null;
  return camryHours.book_hours * laborMultRow.multiplier;
}
