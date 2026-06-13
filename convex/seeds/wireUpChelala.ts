import { internalMutation } from "../_generated/server";

/**
 * One-off: wire Chelala Service Center to offer every service in
 * the (just-reseeded) services table. Drops any pre-existing
 * shop_services rows for Chelala first — they're orphans pointing
 * at the deleted hyphenated service IDs.
 *
 * Scope: only Chelala, only on Ahmad's dev. The other 37 shops
 * still have orphaned shop_services until a broader reseed.
 *
 * Run via: npx convex run seeds/wireUpChelala:wireUpChelala
 */
export const wireUpChelala = internalMutation({
  args: {},
  handler: async (ctx) => {
    const chelala = await ctx.db
      .query("shops")
      .filter((q) => q.eq(q.field("name"), "Chelala Service Center"))
      .first();
    if (!chelala) {
      throw new Error("Chelala Service Center not found in shops table");
    }

    const existing = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", chelala._id))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);

    const services = await ctx.db.query("services").collect();
    for (const svc of services) {
      await ctx.db.insert("shop_services", {
        shop_id: chelala._id,
        service_id: svc._id,
        is_offered: true,
      });
    }

    console.log(
      `Wired Chelala (${chelala._id}): cleared ${existing.length} stale rows, inserted ${services.length} fresh.`,
    );
    return {
      shopId: chelala._id,
      removed: existing.length,
      inserted: services.length,
    };
  },
});
