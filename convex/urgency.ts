/**
 * urgency.ts — Action Engine event logging (Yassin spec v1.1 §6 Change 4).
 *
 * Records tier-entry events to `urgency_tier_events` so post-launch
 * calibration of URGENCY_TIER_CUTOFFS (75/55/25) has ground truth. The
 * client (`hooks/useUrgencyRankedItems`) calls `recordTierEvent` when
 * an item enters a tier different from the last one it observed within
 * the session. No tier-change → no event.
 *
 * Notification scheduling is owned by the governance doc (still pending)
 * and does NOT live here. This file only records observations.
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const recordTierEvent = mutation({
  args: {
    vin: v.string(),
    item_id: v.string(),
    // Undefined when this is the first observation per session for the
    // item — the client doesn't have a prior tier to report.
    from_tier: v.optional(v.string()),
    to_tier: v.string(),
    urgency_score: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("urgency_tier_events", {
      vin: args.vin.toUpperCase().trim(),
      item_id: args.item_id,
      from_tier: args.from_tier,
      to_tier: args.to_tier,
      urgency_score: args.urgency_score,
      occurred_at: Date.now(),
    });
  },
});
