import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    invitedByClerkUserId: v.string(),
    shopId: v.id("shops"),
    email: v.string(),
    role: v.string(),
    // Token generated in the API route so it can be embedded in Clerk's invitation metadata
    token: v.string(),
    mechanicId: v.optional(v.id("mechanics")),
    clerkInvitationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const inviter = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.invitedByClerkUserId))
      .unique();
    if (!inviter) throw new Error("Inviter not found");

    const existing = await ctx.db
      .query("shop_invitations")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .filter((q) =>
        q.and(q.eq(q.field("shop_id"), args.shopId), q.eq(q.field("status"), "pending"))
      )
      .first();
    if (existing) throw new Error("A pending invitation already exists for this email.");

    const now = Date.now();
    return await ctx.db.insert("shop_invitations", {
      shop_id: args.shopId,
      invited_by: inviter._id,
      email: args.email,
      role: args.role,
      mechanic_id: args.mechanicId,
      clerk_invitation_id: args.clerkInvitationId,
      status: "pending",
      token: args.token,
      expires_at: now + 7 * 24 * 60 * 60 * 1000,
      created_at: now,
    });
  },
});

export const getByShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("shop_invitations")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .order("desc")
      .collect();
  },
});

export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("shop_invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
  },
});

export const revoke = mutation({
  args: { invitationId: v.id("shop_invitations") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    await ctx.db.patch(args.invitationId, { status: "revoked" });
  },
});

export const getTeamMembers = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const shopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .filter((q) => q.eq(q.field("is_active"), true))
      .collect();

    const members = await Promise.all(
      shopUsers.map(async (su) => {
        const user = await ctx.db.get(su.user_id);
        return user ? { ...su, user } : null;
      })
    );

    return members.filter((m) => m !== null);
  },
});

// Called from user.created webhook to auto-join a shop when invitation metadata is present.
// Also handles existing Clerk users invited to a new shop.
export const acceptIfInvited = mutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    // Passed when otopair_role is in Clerk public_metadata (from invitation)
    invitationToken: v.optional(v.string()),
    mechanicId: v.optional(v.id("mechanics")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    if (!user) return null;

    const now = Date.now();

    // Prefer token lookup (more reliable), fall back to email
    let invitation = null;
    if (args.invitationToken) {
      invitation = await ctx.db
        .query("shop_invitations")
        .withIndex("by_token", (q) => q.eq("token", args.invitationToken!))
        .filter((q) =>
          q.and(q.eq(q.field("status"), "pending"), q.gt(q.field("expires_at"), now))
        )
        .first();
    }
    if (!invitation) {
      invitation = await ctx.db
        .query("shop_invitations")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .filter((q) =>
          q.and(q.eq(q.field("status"), "pending"), q.gt(q.field("expires_at"), now))
        )
        .first();
    }

    if (!invitation) return null;

    // Idempotency: only create shop_users if it doesn't already exist
    const existingShopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q) =>
        q.eq("user_id", user._id).eq("shop_id", invitation!.shop_id)
      )
      .first();

    if (!existingShopUser) {
      await ctx.db.insert("shop_users", {
        shop_id: invitation.shop_id,
        user_id: user._id,
        role: invitation.role,
        mechanic_id: args.mechanicId ?? invitation.mechanic_id,
        is_active: true,
        invited_at: invitation.created_at,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    // Update Convex user role to match the invitation
    await ctx.db.patch(user._id, { role: invitation.role });

    // Mark invitation as accepted (idempotent)
    if (invitation.status === "pending") {
      await ctx.db.patch(invitation._id, {
        status: "accepted",
        accepted_at: now,
      });
    }

    return invitation.shop_id;
  },
});

// Called directly from the /accept-invite page when the user is already logged in
// (existing Clerk accounts don't go through user.created, so the webhook won't fire).
export const acceptAsCurrentUser = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const now = Date.now();

    // Look up invitation first so we know the correct role before creating user
    const invitation = await ctx.db
      .query("shop_invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!invitation) throw new Error("Invitation not found.");
    if (invitation.status === "revoked") throw new Error("This invitation has been revoked.");
    if (invitation.status === "accepted") return { shopId: invitation.shop_id, role: invitation.role };
    if (invitation.status === "expired" || Date.now() > invitation.expires_at)
      throw new Error("This invitation has expired.");

    let user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();

    // Existing Clerk user with no Convex record yet — create it on the fly.
    if (!user) {
      const userId = await ctx.db.insert("users", {
        clerkUserId: identity.subject,
        email: identity.email ?? "",
        first_name: identity.givenName ?? undefined,
        last_name: identity.familyName ?? undefined,
        profile_photo_url: identity.pictureUrl ?? undefined,
        role: invitation.role,
        onboardingCompleted: false,
        createdAt: now,
      });
      user = await ctx.db.get(userId);
    }

    if (!user) throw new Error("User not found");

    const existingShopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q) =>
        q.eq("user_id", user._id).eq("shop_id", invitation.shop_id)
      )
      .first();

    if (!existingShopUser) {
      await ctx.db.insert("shop_users", {
        shop_id: invitation.shop_id,
        user_id: user._id,
        role: invitation.role,
        mechanic_id: invitation.mechanic_id,
        is_active: true,
        invited_at: invitation.created_at,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    await ctx.db.patch(user._id, { role: invitation.role });
    await ctx.db.patch(invitation._id, { status: "accepted", accepted_at: now });

    return { shopId: invitation.shop_id, role: invitation.role };
  },
});

export const removeMember = mutation({
  args: { shopUserId: v.id("shop_users") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await ctx.db.patch(args.shopUserId, { is_active: false, updated_at: Date.now() });
  },
});

export const updateMemberRole = mutation({
  args: { shopUserId: v.id("shop_users"), role: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await ctx.db.patch(args.shopUserId, { role: args.role, updated_at: Date.now() });
  },
});

// Called from invitation.accepted webhook event as a fallback/supplement to user.created.
// Looks up the user by email since the invitation.accepted event doesn't include clerkUserId.
export const acceptByClerkInvitationId = mutation({
  args: {
    clerkInvitationId: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("shop_invitations")
      .withIndex("by_clerk_invitation_id", (q) =>
        q.eq("clerk_invitation_id", args.clerkInvitationId)
      )
      .first();

    if (!invitation || invitation.status !== "pending") return null;

    const now = Date.now();
    // Look up user by email using the by_email index
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (!user) return null;

    const existingShopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q) =>
        q.eq("user_id", user._id).eq("shop_id", invitation.shop_id)
      )
      .first();

    if (!existingShopUser) {
      await ctx.db.insert("shop_users", {
        shop_id: invitation.shop_id,
        user_id: user._id,
        role: invitation.role,
        mechanic_id: invitation.mechanic_id,
        is_active: true,
        invited_at: invitation.created_at,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    await ctx.db.patch(user._id, { role: invitation.role });

    if (invitation.status === "pending") {
      await ctx.db.patch(invitation._id, {
        status: "accepted",
        accepted_at: now,
      });
    }

    return invitation.shop_id;
  },
});
