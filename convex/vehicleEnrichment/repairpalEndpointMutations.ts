import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

const PART = v.object({
  role: v.optional(v.string()),
  name: v.string(),
  quantity: v.optional(v.number()),
  price_low: v.optional(v.number()),
  price_high: v.optional(v.number()),
  position: v.optional(v.string()),
});

export const upsertRepairpalEndpointEstimate = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    base_vehicle_id: v.number(),
    variant_label: v.optional(v.string()),
    labor_minutes: v.optional(v.number()),
    labor_hours: v.optional(v.number()),
    labor_low: v.optional(v.number()),
    labor_high: v.optional(v.number()),
    total_independent_low: v.optional(v.number()),
    total_independent_high: v.optional(v.number()),
    total_dealer_low: v.optional(v.number()),
    total_dealer_high: v.optional(v.number()),
    parts: v.optional(v.array(PART)),
    zip: v.optional(v.string()),
    match_quality: v.optional(v.string()),
    matched_via: v.optional(v.string()),
    fetched_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("repairpal_endpoint_estimates")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_id", args.service_id),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      return existing._id;
    }
    return await ctx.db.insert("repairpal_endpoint_estimates", args);
  },
});
