/**
 * findVehicleOwnerByVinTail — dev-only lookup for the behavioral eval runner.
 * The golden eval cases target the M550i by VIN tail (N96146); the headless
 * runner needs the owning user's email to drive oto/simulate:simulateOtoMessage.
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const find = internalQuery({
  args: { vinTail: v.string() },
  handler: async (ctx, args) => {
    const vehicles = await ctx.db.query("vehicles").collect();
    const matches = vehicles.filter((veh) => (veh.vin ?? "").endsWith(args.vinTail));
    const out: { vin: string; owners: { email: string | null; userId: string }[] }[] = [];
    for (const veh of matches) {
      const owners = await ctx.db
        .query("vehicle_owners")
        .filter((q) => q.eq(q.field("vin"), veh.vin))
        .collect();
      const rows: { email: string | null; userId: string }[] = [];
      for (const o of owners) {
        const u = await ctx.db.get(o.user_id);
        rows.push({ email: (u as any)?.email ?? null, userId: String(o.user_id) });
      }
      out.push({ vin: veh.vin ?? "", owners: rows });
    }
    return out;
  },
});
