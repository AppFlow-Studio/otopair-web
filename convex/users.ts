import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const upsertFromClerk = mutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    first_name: v.optional(v.string()),
    last_name: v.optional(v.string()),
    profile_photo_url: v.optional(v.string()),
    role: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        first_name: args.first_name,
        last_name: args.last_name,
        profile_photo_url: args.profile_photo_url ?? undefined,
        ...(args.role ? { role: args.role } : {}),
        lastUpdated: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkUserId: args.clerkUserId,
      email: args.email,
      first_name: args.first_name,
      last_name: args.last_name,
      profile_photo_url: args.profile_photo_url ?? undefined,
      role: args.role ?? "user",
      onboardingCompleted: false,
      createdAt: now,
    });
  },
});

export const deleteFromClerk = mutation({
  args: {
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    if (user) {
      await ctx.db.patch(user._id, {
        isPendingDeletion: true,
        deletionRequestedAt: Date.now(),
        lastUpdated: Date.now(),
      });

      // Deactivate all shop memberships so re-inviting is possible
      const shopUsers = await ctx.db
        .query("shop_users")
        .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
        .filter((q) => q.eq(q.field("is_active"), true))
        .collect();
      for (const su of shopUsers) {
        await ctx.db.patch(su._id, { is_active: false, updated_at: Date.now() });
      }

      // Revoke any pending invitations for this email so re-inviting is possible
      const pendingInvites = await ctx.db
        .query("shop_invitations")
        .withIndex("by_email", (q) => q.eq("email", user.email))
        .filter((q) => q.eq(q.field("status"), "pending"))
        .collect();
      for (const inv of pendingInvites) {
        await ctx.db.patch(inv._id, { status: "revoked" });
      }
    }
  },
});

export const submitDeletionRequest = mutation({
  args: {
    reason: v.string(),
    feedback: v.string(),
    improvement: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("is_active"), true))
      .first();
    if (!shopUser) throw new Error("No active shop membership found");

    await ctx.db.patch(shopUser._id, {
      isPendingDeletion: true,
      deletionRequestedAt: Date.now(),
      deletionSurveyReason: args.reason,
      deletionSurveyResponse: args.feedback,
      deletionSurveyImprovement: args.improvement,
      updated_at: Date.now(),
    });
  },
});

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
  },
});

export const getByClerkUserId = query({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
  },
});

export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

// Resets a user's role to "user" by clerkUserId (called when an invitation is revoked).
export const resetRoleToUser = mutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    if (user) {
      await ctx.db.patch(user._id, { role: "user", lastUpdated: Date.now() });
    }
  },
});

// Returns true if the user with this email has an active shop membership.
export const hasActiveShopMembership = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (!user) return false;

    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("is_active"), true))
      .first();

    return !!shopUser;
  },
});
