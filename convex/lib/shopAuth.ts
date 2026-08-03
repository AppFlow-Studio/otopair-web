/**
 * shopAuth.ts — shop-owner authorization for the /payouts money surface.
 *
 * Two gates exist in the repo already and neither fits this use:
 *
 *   shops.ts:requireShopOwner   reads identity off ctx. Correct for queries and
 *                               mutations, useless from an action, which must
 *                               resolve identity itself and pass the subject
 *                               down (the pattern payments_stripe.ts uses).
 *   shopCustomers.ts:getPrimaryAuthorizedShop
 *                               resolves the caller's shop but accepts ANY
 *                               active membership role — a mechanic passes.
 *                               Fine for the customer directory; not for money.
 *
 * Convention followed from shopCustomers.ts: queries return null on failure so
 * the UI renders an empty state; mutations and actions throw.
 */

import type { Id } from "../_generated/dataModel";

/** Mirrors shops.ts:19 and mechanics.ts:36. */
const OWNER_ROLES = new Set(["owner", "shop_owner", "admin"]);

export type ShopOwnerContext = {
  user: any;
  shop: any;
  shopId: Id<"shops">;
  role: string;
};

async function userByClerkId(ctx: any, clerkUserId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", clerkUserId))
    .unique();
}

async function ownerRoleForShop(
  ctx: any,
  userId: Id<"users">,
  shopId: Id<"shops">,
): Promise<string | null> {
  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  if (membership && OWNER_ROLES.has(membership.role)) return membership.role;

  // Fallback: the shop's registered owner, even without a shop_users row.
  const shop = await ctx.db.get(shopId);
  if (shop && String(shop.owner_user_id ?? "") === String(userId)) {
    return "owner";
  }
  return null;
}

/**
 * Owner/manager gate on an explicit shopId, keyed by an already-resolved Clerk
 * subject. This is the variant an action can use: resolve identity in the
 * action, then hand the subject to the mutation that does the real work.
 *
 * THROWS. Use from mutations and actions only.
 */
export async function requireShopOwnerBySubject(
  ctx: any,
  clerkUserId: string,
  shopId: Id<"shops">,
): Promise<ShopOwnerContext> {
  const user = await userByClerkId(ctx, clerkUserId);
  if (!user) throw new Error("User not found");

  const role = await ownerRoleForShop(ctx, user._id, shopId);
  if (!role) throw new Error("Not authorized for this shop");

  const shop = await ctx.db.get(shopId);
  if (!shop) throw new Error("Shop not found");

  return { user, shop, shopId, role };
}

/**
 * Resolves "which shop's payments am I allowed to read" for the calling user.
 *
 * Owner/manager only. /payouts is already owner-gated in middleware.ts and the
 * sidebar, but a Convex query is reachable directly, so the rule is enforced
 * here too rather than assumed.
 *
 * RETURNS NULL rather than throwing — queries render an empty state.
 */
export async function requireShopViewerForPayments(
  ctx: any,
): Promise<ShopOwnerContext | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const user = await userByClerkId(ctx, identity.subject);
  if (!user) return null;

  const activeMembership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  if (activeMembership) {
    if (!OWNER_ROLES.has(activeMembership.role)) return null;
    const shop = await ctx.db.get(activeMembership.shop_id);
    if (!shop) return null;
    return {
      user,
      shop,
      shopId: activeMembership.shop_id,
      role: activeMembership.role,
    };
  }

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
    .first();
  if (!ownedShop) return null;

  return { user, shop: ownedShop, shopId: ownedShop._id, role: "owner" };
}
