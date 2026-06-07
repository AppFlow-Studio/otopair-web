import { internalMutation } from "../_generated/server";

/**
 * One-off cleanup for a dev deployment whose `services` and
 * `service_categories` tables hold stale data from an earlier seed
 * convention (e.g. hyphenated slugs, non-canonical entries). Deletes
 * every row in both tables so the canonical `seedServices` mutation
 * can repopulate from scratch — its early-return guard checks the
 * services table and won't run while data exists.
 *
 * Does NOT touch tables that reference services (shop_services,
 * service_options, labor_times, etc.). Convex doesn't enforce FKs,
 * so those rows become orphaned — harmless for grid validation. If
 * full booking flow testing is needed, re-seed those join tables
 * after running `seedServices`.
 *
 * Run via: npx convex run seeds/wipeServices:wipeServices
 */
export const wipeServices = internalMutation({
  args: {},
  handler: async (ctx) => {
    const services = await ctx.db.query("services").collect();
    for (const s of services) await ctx.db.delete(s._id);
    const cats = await ctx.db.query("service_categories").collect();
    for (const c of cats) await ctx.db.delete(c._id);
    console.log(
      `Wiped ${services.length} services and ${cats.length} service_categories.`,
    );
    return {
      servicesDeleted: services.length,
      categoriesDeleted: cats.length,
    };
  },
});
