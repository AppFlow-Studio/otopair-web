/**
 * convex/knownIssueEvents.ts — read side for the provenance log written by
 * convex/lib/knownIssueEvents.ts. See that file for what this tracks and
 * why it exists alongside (not instead of) `vehicle_owners.knownIssues`.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";

/** Full history for one vehicle owner, newest first. */
export const listForVehicleOwner = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("known_issue_events")
      .withIndex("by_vehicle_owner_id", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId),
      )
      .order("desc")
      .collect();
  },
});
