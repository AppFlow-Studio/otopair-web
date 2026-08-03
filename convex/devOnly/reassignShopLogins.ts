/**
 * One-off dev reassignment (2026-07-20): point the shop-portal test logins
 * (shopowner+clerk_test@gmail.com, lukeskywalker+clerk_test@gmail.com) at
 * the copied "Chelala Service Center" (see seedChelalaCopy.ts) instead of
 * the legacy "Test Shop".
 *
 * getMyShops lists shops via shop_users only, so patching those rows'
 * shop_id moves the dashboard entirely. The shop_owner member also becomes
 * shops.owner_user_id (requireShopOwner fallback + logo management). A
 * member linked to a mechanics row is re-linked to the same-named mechanic
 * in Chelala when one exists, else unlinked.
 *
 * Run: npx convex run devOnly/reassignShopLogins:run
 */
import { internalMutation } from "../_generated/server";

const SHOP_SLUG = "chelala-service-center";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const chelala = await ctx.db
      .query("shops")
      .withIndex("by_slug", (q) => q.eq("slug", SHOP_SLUG))
      .first();
    if (!chelala) throw new Error("Chelala shop not found — run seedChelalaCopy first.");

    const chelalaMechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", chelala._id))
      .collect();

    const memberships = await ctx.db.query("shop_users").collect();
    const moved: string[] = [];

    for (const su of memberships) {
      if (su.shop_id === chelala._id) continue;

      let mechanicId = undefined;
      if (su.mechanic_id) {
        const oldMech = await ctx.db.get(su.mechanic_id);
        const match =
          oldMech &&
          chelalaMechanics.find(
            (m) => m.first_name === oldMech.first_name && m.last_name === oldMech.last_name
          );
        mechanicId = match?._id;
      }

      await ctx.db.patch(su._id, { shop_id: chelala._id, mechanic_id: mechanicId });
      moved.push(`${su.user_id} (${su.role})`);

      if (su.role === "shop_owner") {
        await ctx.db.patch(chelala._id, { owner_user_id: su.user_id });
      }
    }

    return { shop: chelala._id, moved };
  },
});
