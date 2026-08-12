import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

// =============================================================================
// Owner-claim invites (Steps 2–4 of the invite-based shop onboarding).
//
// A director approves a pending application: we create the shop (status
// "invited"), and store the SHA-256 HASH of a 32-byte hex token (minted in the
// Node route so the raw token never enters Convex). The owner clicks the
// emailed /invite?token=… link, previews the claim, authenticates, and
// acceptOwnerInvite atomically binds them to the shop.
// =============================================================================

const SHOP_OWNER_ROLE = "shop_owner";

/**
 * STEP 2 — Admin approves an application. Gated by the director session token
 * (shops.write). The raw token is generated + hashed in the Node route; this
 * mutation only ever sees the hash.
 */
export const approveApplication = mutation({
  args: {
    token: v.string(), // director session token
    applicationId: v.id("shop_applications"),
    tokenHash: v.string(), // SHA-256 hex of the raw invite token
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "shops.write");

    const application = await ctx.db.get(args.applicationId);
    if (!application) throw new Error("Application not found.");
    if (application.status !== "pending_review") {
      throw new Error(
        `Application is ${application.status}, not pending_review — cannot approve.`,
      );
    }

    const now = Date.now();

    // Create the shop in the "invited" state (unclaimed: no owner, no slug yet).
    const shopId = await ctx.db.insert("shops", {
      name: application.shop_legal_name,
      email: application.business_email,
      phone: application.phone,
      address: application.street_address,
      is_active: false,
      is_verified: false,
      onboarding_complete: false,
      status: "invited",
    });

    await ctx.db.insert("shop_invites", {
      shop_id: shopId,
      application_id: args.applicationId,
      email: application.business_email,
      role: SHOP_OWNER_ROLE,
      token_hash: args.tokenHash,
      status: "pending",
      expires_at: args.expiresAt,
      invited_by_name: actor.name,
      created_at: now,
    });

    await ctx.db.patch(args.applicationId, {
      status: "invited",
      invited_shop_id: shopId,
      invited_at: now,
      reviewed_at: now,
      reviewed_by_name: actor.name,
      updated_at: now,
    });

    await logAudit(ctx, actor, {
      entity_type: "shop_application",
      entity_id: String(args.applicationId),
      action: "approved",
      detail: `Approved "${application.shop_legal_name}" → shop ${shopId} invited (${application.business_email}).`,
    });

    return {
      shopId,
      shopName: application.shop_legal_name,
      ownerName: application.owner_full_name,
      email: application.business_email,
    };
  },
});

/**
 * STEP 3 — Public token verification for the /invite preview card. Takes the
 * SHA-256 hash (the raw token is hashed in the Node route). Returns only what
 * the preview needs; never returns the token.
 */
export const verifyByHash = query({
  args: { token_hash: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("shop_invites")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", args.token_hash))
      .first();
    if (!invite) return { valid: false as const, reason: "invalid" as const };
    if (invite.status !== "pending") {
      return { valid: false as const, reason: "used" as const };
    }
    if (invite.expires_at < Date.now()) {
      return { valid: false as const, reason: "expired" as const };
    }
    const shop = await ctx.db.get(invite.shop_id);
    if (!shop) return { valid: false as const, reason: "invalid" as const };
    return {
      valid: true as const,
      shopName: shop.name,
      role: invite.role,
      email: invite.email,
    };
  },
});

/**
 * STEP 4 — Authenticated owner claims the shop. Runs under the caller's Clerk
 * identity (invoked from /api/invites/accept with a Convex token). Atomically
 * binds the owner to the shop, consumes the invite, and activates everything.
 */
export const acceptOwnerInvite = mutation({
  args: { token_hash: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("You must be signed in to claim a shop.");

    // Resolve (or create) the app user for this Clerk identity — covers the
    // signup→claim race before the Clerk webhook has synced the user row.
    let user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    const now = Date.now();
    if (!user) {
      const userId = await ctx.db.insert("users", {
        clerkUserId: identity.subject,
        email: identity.email ?? undefined,
        first_name: (identity.givenName as string | undefined) ?? undefined,
        last_name: (identity.familyName as string | undefined) ?? undefined,
        role: SHOP_OWNER_ROLE,
        onboardingCompleted: false,
        createdAt: now,
        lastUpdated: now,
      });
      user = await ctx.db.get(userId);
    }
    if (!user) throw new Error("Could not resolve your account. Please try again.");

    const invite = await ctx.db
      .query("shop_invites")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", args.token_hash))
      .first();
    if (!invite) throw new Error("This invite link is invalid.");
    if (invite.status !== "pending") {
      throw new Error("This invite has already been used or revoked.");
    }
    if (invite.expires_at < now) {
      await ctx.db.patch(invite._id, { status: "expired" });
      throw new Error("This invite link has expired.");
    }

    const shop = await ctx.db.get(invite.shop_id);
    if (!shop) throw new Error("The shop for this invite no longer exists.");

    // Idempotent: same owner re-accepting is a no-op success; a different owner
    // is rejected.
    if (shop.owner_user_id) {
      if (String(shop.owner_user_id) === String(user._id)) {
        return { shopId: shop._id, alreadyOwner: true as const };
      }
      throw new Error("This shop has already been claimed.");
    }

    // Atomic bind (single mutation = one transaction).
    await ctx.db.patch(shop._id, {
      owner_user_id: user._id,
      status: "active",
      is_active: true,
    });
    await ctx.db.insert("shop_users", {
      shop_id: shop._id,
      user_id: user._id,
      role: SHOP_OWNER_ROLE,
      is_active: true,
      invited_at: invite.created_at,
      accepted_at: now,
      created_at: now,
      updated_at: now,
    });
    await ctx.db.patch(invite._id, {
      status: "accepted",
      accepted_at: now,
      accepted_by_user_id: user._id,
    });
    if (invite.application_id) {
      await ctx.db.patch(invite.application_id, {
        status: "active",
        updated_at: now,
      });
    }
    if (user.role !== SHOP_OWNER_ROLE) {
      await ctx.db.patch(user._id, { role: SHOP_OWNER_ROLE, lastUpdated: now });
    }

    return { shopId: shop._id, alreadyOwner: false as const };
  },
});
