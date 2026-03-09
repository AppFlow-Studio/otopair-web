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
    if (existing) {
      // If the invited user's account no longer exists or is pending deletion,
      // treat the old invitation as stale and revoke it so a fresh one can be sent.
      const existingUser = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .first();
      if (!existingUser || existingUser.isPendingDeletion) {
        await ctx.db.patch(existing._id, { status: "revoked" });
      } else {
        throw new Error("A pending invitation already exists for this email.");
      }
    }

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

export const getById = query({
  args: { invitationId: v.id("shop_invitations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.invitationId);
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
    // Auth is enforced at the API route level (/api/revoke-invite) when called from the server.
    // This mutation is no longer called directly from the client.
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
// Requires an invitation token — email alone is not sufficient to prevent unauthorized acceptance.
export const acceptIfInvited = mutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    invitationToken: v.optional(v.string()),
    mechanicId: v.optional(v.id("mechanics")),
  },
  handler: async (ctx, args) => {
    // Token is required — users must use the invite link to accept
    if (!args.invitationToken) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    if (!user) return null;

    const now = Date.now();

    const invitation = await ctx.db
      .query("shop_invitations")
      .withIndex("by_token", (q) => q.eq("token", args.invitationToken!))
      .filter((q) =>
        q.and(q.eq(q.field("status"), "pending"), q.gt(q.field("expires_at"), now))
      )
      .first();

    if (!invitation) return null;

    // Create or reactivate shop_users record
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
    } else if (!existingShopUser.is_active) {
      // Previously removed — reactivate with updated role
      await ctx.db.patch(existingShopUser._id, {
        is_active: true,
        role: invitation.role,
        mechanic_id: args.mechanicId ?? invitation.mechanic_id,
        accepted_at: now,
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
    } else if (!existingShopUser.is_active) {
      // Previously removed — reactivate with updated role
      await ctx.db.patch(existingShopUser._id, {
        is_active: true,
        role: invitation.role,
        mechanic_id: invitation.mechanic_id,
        accepted_at: now,
        updated_at: now,
      });
    }

    await ctx.db.patch(user._id, { role: invitation.role });
    await ctx.db.patch(invitation._id, { status: "accepted", accepted_at: now });

    return { shopId: invitation.shop_id, role: invitation.role };
  },
});

export const getMemberWithUser = query({
  args: { shopUserId: v.id("shop_users") },
  handler: async (ctx, args) => {
    const shopUser = await ctx.db.get(args.shopUserId);
    if (!shopUser) return null;
    const user = await ctx.db.get(shopUser.user_id);
    return user ? { ...shopUser, user } : null;
  },
});

export const removeMember = mutation({
  args: { shopUserId: v.id("shop_users") },
  handler: async (ctx, args) => {
    // Auth is enforced at the API route level (/api/remove-member) when called from the server.
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
