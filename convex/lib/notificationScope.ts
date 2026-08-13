import type { Id } from "../_generated/dataModel";

const MECHANIC_ROLES = new Set(["shop_mechanic", "mechanic"]);

export type NotificationScope =
  | { kind: "shop_wide"; shopId: Id<"shops"> }
  | {
      kind: "mechanic";
      shopId: Id<"shops">;
      mechanicId: Id<"mechanics">;
    };

/**
 * Resolves the current authenticated user's notification scope.
 *
 * - shop owners / managers / admins / front-desk → shop-wide (see every alert)
 * - shop_mechanic / mechanic with a linked mechanics row → mechanic-scoped
 * - mechanic role but no shop_users.mechanic_id link → falls back to shop-wide
 *
 * Returns null when the user has no authorized shop membership.
 */
export async function getCurrentNotificationScope(
  ctx: any,
): Promise<NotificationScope | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
  if (!user) return null;

  const activeMembership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  if (activeMembership) {
    const role = activeMembership.role as string;
    const shopId = activeMembership.shop_id as Id<"shops">;
    const mechanicId = activeMembership.mechanic_id as
      | Id<"mechanics">
      | undefined;
    if (MECHANIC_ROLES.has(role) && mechanicId) {
      return { kind: "mechanic", shopId, mechanicId };
    }
    return { kind: "shop_wide", shopId };
  }

  // Fall back to owned shop (owner role, no shop_users row).
  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
    .first();
  if (ownedShop) {
    return { kind: "shop_wide", shopId: ownedShop._id as Id<"shops"> };
  }

  return null;
}

/**
 * Returns true if a booking (identified by its assigned mechanic_id) is
 * visible under the given scope. Shop-wide always passes; mechanic-scoped
 * passes when the mechanic matches or the booking is unassigned.
 */
export function bookingVisibleUnderScope(
  scope: NotificationScope,
  bookingMechanicId: Id<"mechanics"> | null | undefined,
): boolean {
  if (scope.kind === "shop_wide") return true;
  if (bookingMechanicId == null) return true;
  return String(bookingMechanicId) === String(scope.mechanicId);
}
