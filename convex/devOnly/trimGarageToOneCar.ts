/**
 * devOnly/trimGarageToOneCar.ts — reduce a test account's garage to a single
 * vehicle for iOS/Android parity captures, without destroying anything.
 *
 * SOFT remove, deliberately. `vehicles.ts` already ships removeOwner /
 * removeOwnerById, but both hard-delete the ownership row AND cascade-delete
 * its maintenance_records. That is irreversible, and this deployment is shared
 * with otopair-web — a fixture tweak must not be able to destroy another
 * team's test data.
 *
 * The schema already models the reversible path: `vehicle_owners.status` plus
 * `removed_at`. Every read filters on `status === "active"` (see vehicles.ts
 * by_user_status index reads), so flipping status is enough to hide a car
 * everywhere in the app, and `addOwner` already restores with
 * `{ status: "active", removed_at: undefined }`.
 *
 * Idempotent: re-running skips rows that are already non-active.
 */
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/** Status written to hidden rows. Anything other than "active" hides them. */
const REMOVED_STATUS = "removed";

export const run = internalMutation({
  args: {
    userId: v.id("users"),
    /** The ONE vehicle to keep. Every other active ownership is hidden. */
    keepVin: v.string(),
    /** Preview only — report what would change and write nothing. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const keepVin = args.keepVin.toUpperCase().trim();

    const owned = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q: any) =>
        q.eq("user_id", args.userId).eq("status", "active"),
      )
      .collect();

    if (!owned.some((o) => o.vin.toUpperCase().trim() === keepVin)) {
      throw new Error(
        `trimGarageToOneCar: keepVin ${keepVin} is not an active ownership for this user. ` +
          `Active VINs: ${owned.map((o) => o.vin).join(", ") || "(none)"}`,
      );
    }

    const now = Date.now();
    const hidden: string[] = [];

    for (const o of owned) {
      if (o.vin.toUpperCase().trim() === keepVin) continue;
      hidden.push(o.vin);
      if (!args.dryRun) {
        await ctx.db.patch(o._id, {
          status: REMOVED_STATUS,
          removed_at: now,
          // A hidden car must not stay flagged primary, or the garage can end
          // up with a primary the UI never lists.
          is_primary: false,
        });
      }
    }

    // The keeper becomes primary if it wasn't already, so the garage is never
    // left with zero primaries.
    const keeper = owned.find((o) => o.vin.toUpperCase().trim() === keepVin)!;
    let promoted = false;
    if (!keeper.is_primary) {
      promoted = true;
      if (!args.dryRun) await ctx.db.patch(keeper._id, { is_primary: true });
    }

    return {
      dryRun: !!args.dryRun,
      kept: keeper.vin,
      keptPromotedToPrimary: promoted,
      hidden,
      activeRemaining: args.dryRun ? owned.length : owned.length - hidden.length,
    };
  },
});

/**
 * Undo: re-activate every soft-removed ownership for this user.
 * Nothing was deleted, so this restores the garage exactly.
 */
export const restore = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("vehicle_owners")
      .filter((q: any) => q.eq(q.field("user_id"), args.userId))
      .collect();

    const restored: string[] = [];
    for (const o of all) {
      if (o.status === REMOVED_STATUS) {
        restored.push(o.vin);
        await ctx.db.patch(o._id, { status: "active", removed_at: undefined });
      }
    }
    return { restored, count: restored.length };
  },
});
