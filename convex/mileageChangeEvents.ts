// Reads for the mileage-change audit (mileage_change_events). Director-token
// gated — same posture as convex/audit_log.ts, since these rows carry actor
// names and per-vehicle history. The write helper lives in
// convex/lib/mileageChangeEvents.ts (logMileageChange).

import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireDirector } from "./directorGate";

export const listForVin = query({
  args: { vin: v.string(), token: v.string() },
  handler: async (ctx, { vin, token }) => {
    await requireDirector(ctx, token);
    return ctx.db
      .query("mileage_change_events")
      .withIndex("by_vin", (q) => q.eq("vin", vin))
      .order("desc")
      .collect();
  },
});
