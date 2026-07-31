/**
 * users.ts - User Account Management
 *
 * DESCRIPTION:
 * Manages user accounts for the platform.
 * Users are vehicle owners seeking maintenance services.
 * Authentication is handled via Clerk (third-party auth provider).
 *
 * TABLE: users
 *   - Stores user profiles and authentication info
 *   - Linked to Clerk for auth (clerkUserId)
 *   - Tracks onboarding completion
 *   - Stores vehicle knowledge level and preferences
 *
 * KEY RELATIONSHIPS:
 *   - Has-many: bookings (via user_id)
 *   - Has-many: payments (via user_id)
 *   - Has-many: vehicle_owners (via user_id)
 *   - Has-many: reviews (via user_id)
 *   - Has-many: ai_conversations (via user_id)
 *   - Has-many: onboarding_questions_answers (via user_id)
 *   - Has-many: analytics_events (via user_id)
 *
 * USE CASES:
 *   1. User authentication and sign-up
 *   2. Profile management
 *   3. Vehicle ownership tracking
 *   4. Booking history
 *   5. Review submissions
 *
 * OWNER: User Management Team
 */

import { action, mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { v } from "convex/values";

function hasEssentialOnboardingFields(
  user: Pick<
    Doc<"users">,
    "email" | "emailConfirmed" | "phone" | "phoneVerified" | "first_name" | "last_name"
  >,
) {
  return Boolean(
    user.email?.trim() &&
    user.emailConfirmed === true &&
    user.phone &&
    user.phoneVerified === true &&
    user.first_name?.trim() &&
    user.last_name?.trim(),
  );
}

function getEssentialOnboardingCompleted(user: Doc<"users">) {
  return user.essentialOnboardingCompleted === true || hasEssentialOnboardingFields(user);
}

/**
 * QUERY: list
 * Returns all users in the system.
 * Use with caution - consider access control in production.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("users").collect();
  },
});

/**
 * QUERY: getMe
 * Get current authenticated user (by Clerk identity).
 * Returns null if not authenticated.
 */
export const getMe = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) return null;

    // If the user has a storage ID, generate a temporary URL for it
    let profile_photo_url = user.profile_photo_url;
    if (user.profile_photo_storage_id) {
      const url = await ctx.storage.getUrl(user.profile_photo_storage_id);
      if (url) profile_photo_url = url;
    }

    return {
      ...user,
      profile_photo_url,
      essentialOnboardingCompleted: getEssentialOnboardingCompleted(user),
    };
  },
});

/**
 * QUERY: getById
 * Fetch a specific user by ID.
 *
 * ARGS:
 *   - id: User ID
 *
 * RETURNS:
 *   {
 *     _id: user id,
 *     clerkUserId: string,
 *     email: string,
 *     phone: string,
 *     first_name: string,
 *     last_name: string,
 *     profile_photo_url: string,
 *     onboardingCompleted: boolean,
 *     tellUsAboutCompleted: boolean,
 *     ... other fields
 *   }
 */
export const getById = query({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * MUTATION: getOrCreateMe
 * Get current authenticated user or create if doesn't exist.
 * Called on app startup and after login to initialize/sync user account.
 *
 * Pulls profile data from the Clerk identity token so the Convex
 * record stays in sync with Clerk (email, name, picture, verification).
 *
 * VALIDATION:
 *   - Must be authenticated via Clerk
 *   - Uses identity.subject (clerkUserId) for lookup
 *
 * THROWS:
 *   - "Not authenticated": If no auth identity found
 */
export const getOrCreateMe = mutation({
  // Optional first-touch context passed by the client on the first call after
  // signup. The Clerk identity token doesn't reliably carry the OAuth provider
  // (it depends on the JWT template), so the client — which can read
  // `user.externalAccounts[0].provider` and the entry surface — supplies both.
  args: {
    authProvider: v.optional(v.string()),
    acquisitionSource: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    console.log("clerkUserId", clerkUserId);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (existing) {
      // Sync key fields from Clerk on every login so Convex stays current
      const updates: Record<string, any> = {};
      if (identity.email && existing.email !== identity.email) {
        updates.email = identity.email;
      }
      if (identity.emailVerified !== undefined && existing.emailConfirmed !== identity.emailVerified) {
        updates.emailConfirmed = identity.emailVerified;
      }
      if (identity.givenName && !existing.first_name) {
        updates.first_name = identity.givenName;
      }
      if (identity.familyName && !existing.last_name) {
        updates.last_name = identity.familyName;
      }
      if (identity.pictureUrl && !existing.profile_photo_url && !existing.profile_photo_storage_id) {
        updates.profile_photo_url = identity.pictureUrl;
      }
      // Backfill attribution once, only when still empty (first touch wins) —
      // lets accounts created before this field existed pick it up on next login.
      if (args.authProvider && !existing.auth_provider) {
        updates.auth_provider = args.authProvider;
      }
      if (args.acquisitionSource && !existing.acquisition_source) {
        updates.acquisition_source = args.acquisitionSource;
      }
      const nextUser = { ...existing, ...updates };
      if (
        existing.essentialOnboardingCompleted !== true &&
        hasEssentialOnboardingFields(nextUser)
      ) {
        updates.essentialOnboardingCompleted = true;
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(existing._id, updates);
        return await ctx.db.get(existing._id);
      }
      return existing;
    }

    // New user — seed with everything Clerk provides + first-touch attribution
    const userId = await ctx.db.insert("users", {
      clerkUserId,
      email: identity.email || undefined,
      emailConfirmed: identity.emailVerified || undefined,
      first_name: identity.givenName || undefined,
      last_name: identity.familyName || undefined,
      profile_photo_url: identity.pictureUrl || undefined,
      auth_provider: args.authProvider || undefined,
      acquisition_source: args.acquisitionSource || undefined,
      onboardingCompleted: false,
      essentialOnboardingCompleted: false,
      createdAt: Date.now(),
    });

    return await ctx.db.get(userId);
  },
});

/**
 * MUTATION: requestAccountDeletion
 * Marks a user account as pending deletion.
 * Sets deletionRequestedAt to current time and isPendingDeletion to true.
 */
export const requestAccountDeletion = mutation({
  args: {
    response: v.optional(v.string()),
    skipped: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, {
      isPendingDeletion: true,
      deletionRequestedAt: Date.now(),
      deletionSurveyResponse: args.response,
      deletionSurveySkipped: args.skipped,
    });

    return user._id;
  },
});

/**
 * MUTATION: reactivateAccount
 * Cancels a pending account deletion.
 */
export const reactivateAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, {
      isPendingDeletion: false,
      deletionRequestedAt: undefined,
    });

    return user._id;
  },
});

/**
 * MUTATION: updateProfile
 * Update the current user's profile (used by onboarding persistence).
 * Only updates fields that are provided; must be authenticated.
 *
 * THROWS:
 *   - "Not authenticated": If no auth identity found
 *   - "User not found": If no Convex user record for this Clerk user
 */
export const updateProfile = mutation({
  args: {
    auth_provider: v.optional(v.string()),
    phone: v.optional(v.string()),
    phoneVerified: v.optional(v.boolean()),
    email: v.optional(v.string()),
    emailConfirmed: v.optional(v.boolean()),
    first_name: v.optional(v.string()),
    last_name: v.optional(v.string()),
    profile_photo_url: v.optional(v.union(v.string(), v.null())),
    profile_photo_storage_id: v.optional(v.union(v.string(), v.null())),
    tellUsAboutCompleted: v.optional(v.boolean()),
    language: v.optional(v.string()),
    units: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const updates: Record<string, unknown> = {};
    if (args.auth_provider !== undefined) updates.auth_provider = args.auth_provider;
    if (args.phone !== undefined) updates.phone = args.phone;
    if (args.phoneVerified !== undefined) updates.phoneVerified = args.phoneVerified;
    if (args.email !== undefined) updates.email = args.email;
    if (args.emailConfirmed !== undefined) updates.emailConfirmed = args.emailConfirmed;
    if (args.first_name !== undefined) updates.first_name = args.first_name;
    if (args.last_name !== undefined) updates.last_name = args.last_name;
    if (args.profile_photo_url !== undefined) {
      updates.profile_photo_url =
        args.profile_photo_url === null ? undefined : args.profile_photo_url;
    }
    if (args.profile_photo_storage_id !== undefined) {
      updates.profile_photo_storage_id =
        args.profile_photo_storage_id === null
          ? undefined
          : args.profile_photo_storage_id;
    }
    if (args.tellUsAboutCompleted !== undefined) updates.tellUsAboutCompleted = args.tellUsAboutCompleted;
    if (args.language !== undefined) updates.language = args.language;
    if (args.units !== undefined) updates.units = args.units;

    const nextUser = { ...user, ...updates };
    if (
      user.essentialOnboardingCompleted !== true &&
      hasEssentialOnboardingFields(nextUser)
    ) {
      updates.essentialOnboardingCompleted = true;
    }

    if (Object.keys(updates).length === 0) {
      return user;
    }

    updates.lastUpdated = Date.now();
    await ctx.db.patch(user._id, updates);
    return await ctx.db.get(user._id);
  },
});

/**
 * MUTATION: generateUploadUrl
 * Generates a short-lived URL for uploading files to Convex storage.
 */
export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

/**
 * MUTATION: completeEssentialOnboarding
 * Marks the required account-creation steps as complete without marking the
 * optional onboarding steps complete.
 */
export const completeEssentialOnboarding = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const updates: Record<string, unknown> = {};
    if (identity.email && user.email !== identity.email) {
      updates.email = identity.email;
    }
    if (identity.emailVerified !== undefined && user.emailConfirmed !== identity.emailVerified) {
      updates.emailConfirmed = identity.emailVerified;
    }

    const nextUser = { ...user, ...updates };
    if (!hasEssentialOnboardingFields(nextUser)) {
      throw new Error("Essential onboarding is incomplete");
    }

    await ctx.db.patch(user._id, {
      ...updates,
      essentialOnboardingCompleted: true,
      lastUpdated: Date.now(),
    });
    return await ctx.db.get(user._id);
  },
});

/**
 * MUTATION: registerExpoPushToken
 * Persists the Expo push token on the current user so the
 * `lib/push_dispatcher.dispatchPendingPush` cron can route approval
 * notifications. Idempotent — re-registering the same token only bumps
 * the `push_token_updated_at_ms`. Called from mobile after a successful
 * Notifications.requestPermissionsAsync + getExpoPushTokenAsync.
 */
export const registerExpoPushToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");
    const trimmed = args.token.trim();
    if (!trimmed) throw new Error("Empty push token");
    await ctx.db.patch(user._id, {
      push_token: trimmed,
      push_token_updated_at_ms: Date.now(),
    } as any);
    return { ok: true };
  },
});

/**
 * MUTATION: completeOnboarding
 * Set onboardingCompleted to true for the current user.
 * Called when the user finishes the onboarding flow (Daniel's onboarding integration).
 *
 * THROWS:
 *   - "Not authenticated": If no auth identity found
 *   - "User not found": If no Convex user record for this Clerk user
 */
export const completeOnboarding = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(user._id, {
      onboardingCompleted: true,
      essentialOnboardingCompleted: true,
      lastUpdated: Date.now(),
    });
    return await ctx.db.get(user._id);
  },
});

export const upsertFromClerk = mutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    first_name: v.optional(v.string()),
    last_name: v.optional(v.string()),
    profile_photo_url: v.optional(v.string()),
    role: v.optional(v.string()),
    // Clerk-derived signup method + verification/username (see the webhook).
    // auth_provider is first-touch (never overwritten once set).
    authProvider: v.optional(v.string()),
    emailConfirmed: v.optional(v.boolean()),
    phoneVerified: v.optional(v.boolean()),
    username: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    const now = Date.now();

    if (existing) {
      const nextUser = {
        ...existing,
        email: args.email,
        first_name: args.first_name,
        last_name: args.last_name,
        profile_photo_url: args.profile_photo_url ?? undefined,
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.role ? { role: args.role } : {}),
      };
      await ctx.db.patch(existing._id, {
        email: args.email,
        first_name: args.first_name,
        last_name: args.last_name,
        profile_photo_url: args.profile_photo_url ?? undefined,
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.role ? { role: args.role } : {}),
        // Signup method — first-touch: only set if we don't already have one.
        ...(args.authProvider && !existing.auth_provider
          ? { auth_provider: args.authProvider }
          : {}),
        // Verification flags + username refresh whenever Clerk sends them.
        ...(args.emailConfirmed !== undefined ? { emailConfirmed: args.emailConfirmed } : {}),
        ...(args.phoneVerified !== undefined ? { phoneVerified: args.phoneVerified } : {}),
        ...(args.username ? { username: args.username } : {}),
        ...(existing.essentialOnboardingCompleted !== true &&
        (existing.onboardingCompleted === true || hasEssentialOnboardingFields(nextUser))
          ? { essentialOnboardingCompleted: true }
          : {}),
        lastUpdated: now,
      });
      return existing._id;
    }

    // Stub claim — when a stub user was created for this person before they
    // had a Clerk identity, match it by email or normalized phone and migrate
    // it onto the real Clerk identity. Two stub sources, same shape:
    //   • "shop-created-" — shop walk-in booking (convex/bookings.ts)
    //   • "presignup-"    — marketing-site Oto pre-signup (convex/preSignups.ts)
    // All bookings + vehicle_owners stay linked because they reference the
    // Convex user _id, not the clerkUserId string.
    const normalizedIncomingPhone = normalizePhoneE164(args.phone);
    let claimable = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (claimable && !isClaimableStub(claimable.clerkUserId)) {
      claimable = null;
    }
    if (!claimable && normalizedIncomingPhone) {
      const all = await ctx.db.query("users").collect();
      claimable =
        all.find(
          (u) =>
            isClaimableStub(u.clerkUserId) &&
            u.phone === normalizedIncomingPhone,
        ) ?? null;
    }

    if (claimable) {
      await ctx.db.patch(claimable._id, {
        clerkUserId: args.clerkUserId,
        email: args.email,
        first_name: args.first_name ?? claimable.first_name,
        last_name: args.last_name ?? claimable.last_name,
        profile_photo_url: args.profile_photo_url ?? undefined,
        phone: normalizedIncomingPhone ?? claimable.phone,
        role: args.role ?? claimable.role ?? "user",
        ...(args.authProvider && !claimable.auth_provider
          ? { auth_provider: args.authProvider }
          : {}),
        ...(args.emailConfirmed !== undefined ? { emailConfirmed: args.emailConfirmed } : {}),
        ...(args.phoneVerified !== undefined ? { phoneVerified: args.phoneVerified } : {}),
        ...(args.username ? { username: args.username } : {}),
        onboardingCompleted: true,
        essentialOnboardingCompleted: true,
        lastUpdated: now,
        walkInClaimedAt: now,
      });
      return claimable._id;
    }

    return await ctx.db.insert("users", {
      clerkUserId: args.clerkUserId,
      email: args.email,
      phone: normalizedIncomingPhone,
      first_name: args.first_name,
      last_name: args.last_name,
      profile_photo_url: args.profile_photo_url ?? undefined,
      role: args.role ?? "user",
      ...(args.authProvider ? { auth_provider: args.authProvider } : {}),
      ...(args.emailConfirmed !== undefined ? { emailConfirmed: args.emailConfirmed } : {}),
      ...(args.phoneVerified !== undefined ? { phoneVerified: args.phoneVerified } : {}),
      ...(args.username ? { username: args.username } : {}),
      onboardingCompleted: false,
      essentialOnboardingCompleted: false,
      createdAt: now,
    });
  },
});

function normalizePhoneE164(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+")) return raw;
  return undefined;
}

// A stub user is one created before the person had a Clerk identity — either a
// shop walk-in ("shop-created-") or a marketing pre-signup ("presignup-").
// These are the only rows a Clerk signup is allowed to claim by email/phone.
function isClaimableStub(clerkUserId: string | undefined): boolean {
  const id = String(clerkUserId ?? "");
  return id.startsWith("shop-created-") || id.startsWith("presignup-");
}

export const deleteFromClerk = mutation({
  args: {
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    if (!user) return;

    await ctx.db.patch(user._id, {
      isPendingDeletion: true,
      deletionRequestedAt: Date.now(),
      lastUpdated: Date.now(),
    });

    const shopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("is_active"), true))
      .collect();
    for (const su of shopUsers) {
      await ctx.db.patch(su._id, { is_active: false, updated_at: Date.now() });
    }

    if (user.email) {
      const userEmail = user.email;
      const pendingInvites = await ctx.db
        .query("shop_invitations")
        .withIndex("by_email", (q) => q.eq("email", userEmail))
        .filter((q) => q.eq(q.field("status"), "pending"))
        .collect();
      for (const invitation of pendingInvites) {
        await ctx.db.patch(invitation._id, { status: "revoked" });
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

/**
 * ACTION: revokeMyActiveClerkSessions
 * Revokes every active Clerk session for the current user.
 *
 * This is intentionally separate from requestAccountDeletion because Convex
 * mutations cannot call external APIs. The client calls this immediately after
 * marking the account as pending deletion.
 */
export const revokeMyActiveClerkSessions = action({
  args: {
    excludeSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      throw new Error("CLERK_SECRET_KEY is not configured in Convex.");
    }

    const headers = {
      Authorization: `Bearer ${clerkSecretKey}`,
      "Content-Type": "application/json",
    };
    const clerkUserId = identity.subject;
    const limit = 500;
    let offset = 0;
    let totalCount = 0;
    const sessionIds: string[] = [];

    do {
      const params = new URLSearchParams({
        user_id: clerkUserId,
        status: "active",
        limit: String(limit),
        offset: String(offset),
      });
      const response = await fetch(`https://api.clerk.com/v1/sessions?${params.toString()}`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to list Clerk sessions: ${response.status} ${errorText}`);
      }

      const body = await response.json();
      const sessions = Array.isArray(body?.data) ? body.data : [];
      totalCount = Number(body?.total_count ?? body?.totalCount ?? sessions.length);
      sessionIds.push(
        ...sessions
          .map((session: any) => session?.id)
          .filter((id: unknown): id is string =>
            typeof id === "string" &&
            id.length > 0 &&
            id !== args.excludeSessionId,
          ),
      );

      offset += sessions.length;
    } while (offset < totalCount && offset > 0);

    const results = await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        const response = await fetch(`https://api.clerk.com/v1/sessions/${sessionId}/revoke`, {
          method: "POST",
          headers,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to revoke Clerk session ${sessionId}: ${response.status} ${errorText}`);
        }

        return sessionId;
      }),
    );

    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      console.error("Some Clerk sessions failed to revoke", failed);
      throw new Error(`Failed to revoke ${failed.length} Clerk session(s).`);
    }

    return {
      revoked: sessionIds.length,
    };
  },
});
