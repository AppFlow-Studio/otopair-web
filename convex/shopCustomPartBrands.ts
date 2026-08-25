/**
 * shopCustomPartBrands.ts — a shop's remembered custom part brands.
 *
 * The walk-in parts Brand picker is seeded from the vehicle `makes` catalog, but
 * shops routinely source parts under supplier brands (Bosch, Denso, …) or one-off
 * brands that will never be a vehicle make. Rather than pollute the global makes
 * catalog (guarded by getOrCreateMake), those land here — shop-scoped
 * "autocomplete with a memory", the same shape and spirit as shop_custom_services.
 *
 * A brand is remembered ONLY when a mechanic explicitly taps "Add … as custom" in
 * the picker (never on a bare Enter or keystroke), so the list stays intentional.
 * Nothing here is driver-facing, searchable, or bookable.
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

/** Trimmed + lowercased identity key so per-shop upserts are idempotent. */
function brandKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser?.is_active) return shopUser;

  const owned = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (owned) return { user_id: userId, shop_id: shopId, role: "owner" };

  throw new Error("Not authorized for this shop");
}

/**
 * The shop's remembered custom brands, best-first (most-used, then most-recent) —
 * a mechanic reaching for this list is usually reaching for what they used last.
 */
export const listForShop = query({
  args: { shopId: v.id("shops"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("shop_custom_part_brands")
      .withIndex("by_shop", (q) => q.eq("shop_id", args.shopId))
      .collect();

    rows.sort((a, b) => {
      if (b.use_count !== a.use_count) return b.use_count - a.use_count;
      return b.last_used_at - a.last_used_at;
    });

    return rows.slice(0, args.limit ?? 50).map((r) => ({
      _id: r._id,
      name: r.name,
      use_count: r.use_count,
      last_used_at: r.last_used_at,
    }));
  },
});

/**
 * Remember a custom brand for this shop (idempotent per normalized name). Called
 * when a mechanic explicitly taps "Add [brand] as custom" in the parts picker.
 * Returns the stored display name so the caller can select exactly what persisted.
 */
export const add = mutation({
  args: { shopId: v.id("shops"), name: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireShopStaff(ctx, user._id, args.shopId);

    const name = args.name.trim();
    if (!name) throw new Error("Brand name is required");
    const key = brandKey(name);
    const now = Date.now();

    const existing = await ctx.db
      .query("shop_custom_part_brands")
      .withIndex("by_shop_and_key", (q) =>
        q.eq("shop_id", args.shopId).eq("name_key", key),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        use_count: existing.use_count + 1,
        last_used_at: now,
      });
      return { id: existing._id, name: existing.name };
    }

    const id = await ctx.db.insert("shop_custom_part_brands", {
      shop_id: args.shopId,
      name,
      name_key: key,
      use_count: 1,
      last_used_at: now,
      created_at: now,
    });
    return { id, name };
  },
});
