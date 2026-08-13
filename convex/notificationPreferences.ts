/**
 * notificationPreferences.ts — per-user delivery preferences for the
 * in-app notification system.
 *
 * Stored on `user_settings_preferences.notification_preferences` as a free
 * shape (v.any()) so the client owns the schema. The current shape is a flat
 * map keyed by category:
 *
 *   { [categoryKey: string]: { inApp: boolean; email: boolean } }
 *
 * The set of valid categoryKeys is role-dependent and defined on the client
 * (see app/(portal)/notifications/notification-config.ts). We return the raw
 * stored object plus the caller's role/scope so the page can merge it with the
 * role-appropriate defaults.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { getCurrentNotificationScope } from "./lib/notificationScope";

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
}

// The exact shop_users.role string (for display + capability copy). Falls back
// to "owner" for a shop owned without a shop_users membership row.
async function resolveRole(ctx: any, userId: Id<"users">): Promise<string> {
  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();
  if (membership) return membership.role as string;

  const owned = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .first();
  return owned ? "owner" : "unknown";
}

export const getMyNotificationPreferences = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const [scope, role, row] = await Promise.all([
      getCurrentNotificationScope(ctx),
      resolveRole(ctx, user._id),
      ctx.db
        .query("user_settings_preferences")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
        .first(),
    ]);

    return {
      role,
      // "mechanic" → scoped view/actions; "shop_wide" → owner/manager/front-desk.
      scopeKind: scope?.kind ?? null,
      preferences:
        (row?.notification_preferences ?? null) as Record<
          string,
          { inApp?: boolean; email?: boolean }
        > | null,
      updatedAt: row?.last_updated ?? null,
    };
  },
});

export const updateMyNotificationPreferences = mutation({
  // `preferences` is the full { categories: {...} } object; we overwrite so a
  // toggle flipped off actually persists off (not a deep-merge that keeps it).
  args: { preferences: v.any() },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) {
      throw new Error("Your session has expired. Please sign in again.");
    }

    const existing = await ctx.db
      .query("user_settings_preferences")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        notification_preferences: args.preferences,
        last_updated: now,
      });
    } else {
      await ctx.db.insert("user_settings_preferences", {
        user_id: user._id,
        notification_preferences: args.preferences,
        last_updated: now,
      });
    }
    return { ok: true };
  },
});
