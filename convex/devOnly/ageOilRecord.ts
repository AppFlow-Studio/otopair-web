/**
 * ageOilRecord.ts — DEV ONLY, not part of any product surface.
 *
 * Backdates a vehicle's oil maintenance_record so `computeMaintenanceStatus`
 * classifies it as due_soon / overdue. Exists because every seeded vehicle in
 * the dev deployment sits at `on_time` or `unknown`, which means
 * `enrichUrgentItem` returns early and the urgent-copy branch — the one Wave 0.1
 * changed — is unreachable from the app.
 *
 * Reversible: `age` returns the previous values, and `restore` puts them back.
 *
 * Usage:
 *   npx convex run devOnly/ageOilRecord:age '{"vin":"...","monthsAgo":14}'
 *   npx convex run devOnly/ageOilRecord:restore '{"vin":"...","lastServiceDate":123,"confirmedHealthyAt":null}'
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

async function findOilRecord(ctx: any, vin: string) {
  const owner = await ctx.db
    .query("vehicle_owners")
    .filter((q: any) => q.eq(q.field("vin"), vin))
    .first();
  if (!owner) throw new Error(`no vehicle_owners row for vin ${vin}`);

  const records = await ctx.db
    .query("maintenance_records")
    .filter((q: any) => q.eq(q.field("vehicleOwnerId"), owner._id))
    .collect();
  const oil = records.find((r: any) => r.type === "oil");
  if (!oil) throw new Error(`no oil maintenance_record for vin ${vin}`);
  return oil;
}

export const age = internalMutation({
  args: { vin: v.string(), monthsAgo: v.number() },
  handler: async (ctx, args) => {
    const oil = await findOilRecord(ctx, args.vin);
    const before = {
      lastServiceDate: oil.lastServiceDate ?? null,
      confirmedHealthyAt: oil.confirmedHealthyAt ?? null,
    };

    // confirmedHealthyAt pins an item to on_time for 90 days (CONFIRMED_HEALTHY_TTL_MS),
    // so it has to be cleared or the backdate has no effect on status.
    await ctx.db.patch(oil._id, {
      lastServiceDate: Date.now() - args.monthsAgo * MS_PER_MONTH,
      confirmedHealthyAt: undefined,
      updatedAt: Date.now(),
    });

    return { recordId: oil._id, before };
  },
});

export const restore = internalMutation({
  args: {
    vin: v.string(),
    lastServiceDate: v.optional(v.union(v.string(), v.number())),
    confirmedHealthyAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const oil = await findOilRecord(ctx, args.vin);
    await ctx.db.patch(oil._id, {
      lastServiceDate: args.lastServiceDate,
      confirmedHealthyAt: args.confirmedHealthyAt,
      updatedAt: Date.now(),
    });
    return { recordId: oil._id, restored: true };
  },
});
