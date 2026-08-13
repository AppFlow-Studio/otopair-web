/**
 * preferences.ts - User Settings & Preferences
 *
 * DESCRIPTION:
 * Manages user-specific application preferences and settings.
 *
 * TABLE: user_settings_preferences
 *   - Stores notification toggles, theme settings, etc.
 *   - Linked to users table via user_id
 *
 * USE CASES:
 *   1. Fetching user notification preferences
 *   2. Updating notification toggles
 *
 * OWNER: Daniel Chelala
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

function normalizeUnits(units: string): "mi" | "km" {
  if (units === "mi" || units === "km") return units;
  throw new Error("Invalid units preference. Expected 'mi' or 'km'.");
}

/**
 * QUERY: getMyPreferences
 * Get the settings preferences for the current authenticated user.
 * Returns default values if no record exists yet.
 */
export const getMyPreferences = query({
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

    const prefs = await ctx.db
      .query("user_settings_preferences")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();

    return prefs;
  },
});

/**
 * MUTATION: updateNotificationPreferences
 * Upsert notification preferences for the current user.
 */
export const updateNotificationPreferences = mutation({
  args: {
    offers: v.boolean(),
    rewards: v.boolean(),
    pass: v.boolean(),
    bookings: v.boolean(),
    other: v.boolean(),
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

    const existing = await ctx.db
      .query("user_settings_preferences")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();

    const notification_preferences = {
      offers: args.offers,
      rewards: args.rewards,
      pass: args.pass,
      bookings: args.bookings,
      other: args.other,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        notification_preferences,
        last_updated: Date.now(),
      });
      return await ctx.db.get(existing._id);
    } else {
      const prefsId = await ctx.db.insert("user_settings_preferences", {
        user_id: user._id,
        notification_preferences,
        last_updated: Date.now(),
      });
      return await ctx.db.get(prefsId);
    }
  },
});

/**
 * MUTATION: updateGeneralPreferences
 * Upsert general preferences (language, units) for the current user.
 */
export const updateGeneralPreferences = mutation({
  args: {
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

    const existing = await ctx.db
      .query("user_settings_preferences")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .unique();

    const updates: Record<string, any> = {
      last_updated: Date.now(),
    };
    if (args.language !== undefined) updates.language = args.language;
    if (args.units !== undefined) updates.units = normalizeUnits(args.units);

    if (existing) {
      await ctx.db.patch(existing._id, updates);
      return await ctx.db.get(existing._id);
    } else {
      // Create with default notification preferences if they don't exist
      const prefsId = await ctx.db.insert("user_settings_preferences", {
        user_id: user._id,
        notification_preferences: {
          offers: true,
          rewards: true,
          pass: true,
          bookings: true,
          other: true,
        },
        last_updated: Date.now(),
        ...updates,
      });
      return await ctx.db.get(prefsId);
    }
  },
});
