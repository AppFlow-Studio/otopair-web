import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    address: v.string(),
    city: v.string(),
    state: v.string(),
    zipCode: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    website: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    let user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();

    if (!user) {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {
        clerkUserId: identity.subject,
        email: identity.email ?? "",
        first_name: identity.givenName ?? undefined,
        last_name: identity.familyName ?? undefined,
        profile_photo_url: identity.pictureUrl ?? undefined,
        role: "shop_owner",
        onboardingCompleted: false,
        createdAt: now,
      });
      user = await ctx.db.get(userId);
    }

    if (!user) throw new Error("User not found");

    const existing = await ctx.db
      .query("shops")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (existing) throw new Error("This slug is already taken. Please choose another.");

    const now = Date.now();

    const shopId = await ctx.db.insert("shops", {
      name: args.name,
      slug: args.slug,
      description: args.description,
      address: args.address,
      city: args.city,
      state: args.state,
      zip: args.zipCode,
      phone: args.phone,
      email: args.email,
      website: args.website,
      is_active: true,
      owner_user_id: user._id,
    });

    await ctx.db.insert("shop_users", {
      shop_id: shopId,
      user_id: user._id,
      role: "shop_owner",
      is_active: true,
      invited_at: now,
      accepted_at: now,
      created_at: now,
      updated_at: now,
    });

    return shopId;
  },
});

export const getByOwner = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();

    if (!user) return [];

    return await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q) => q.eq("owner_user_id", user._id))
      .collect();
  },
});

export const getById = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.shopId);
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("shops")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

export const getMyShops = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();

    if (!user) return [];

    const shopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("is_active"), true))
      .collect();

    const shops = await Promise.all(
      shopUsers.map(async (su) => {
        const shop = await ctx.db.get(su.shop_id);
        return shop ? { ...shop, memberRole: su.role } : null;
      })
    );

    return shops.filter(Boolean);
  },
});
