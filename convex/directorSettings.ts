/**
 * convex/directorSettings.ts — Director-controlled global feature flags.
 *
 * Singleton row keyed `"global"` on the `director_settings` table. Reads
 * always return a fully-populated object (filling defaults for any flag that
 * hasn't been set yet) so call sites don't have to null-guard. Writes upsert.
 *
 * Currently exposes:
 *   - round_labor_times_to_15min (default true): when true, labor minute
 *     resolution rounds UP to the nearest 15-min slot at the source.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const SETTINGS_KEY = "global";

const DEFAULTS = {
  round_labor_times_to_15min: true,
};

export const getGlobal = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("director_settings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .first();
    return {
      round_labor_times_to_15min:
        row?.round_labor_times_to_15min ?? DEFAULTS.round_labor_times_to_15min,
      updated_at: row?.updated_at ?? null,
    };
  },
});

export const setRoundLaborTo15 = mutation({
  args: {
    value: v.boolean(),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { value, actorName, actorId }) => {
    const existing = await ctx.db
      .query("director_settings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        round_labor_times_to_15min: value,
        updated_at: now,
        updated_by_user_id: actorId,
      });
    } else {
      await ctx.db.insert("director_settings", {
        key: SETTINGS_KEY,
        round_labor_times_to_15min: value,
        updated_at: now,
        updated_by_user_id: actorId,
      });
    }
    await ctx.db.insert("audit_log", {
      entity_type: "director_settings",
      entity_id: SETTINGS_KEY,
      action: "field_edit",
      actor: actorName ?? "Director",
      actor_id: actorId,
      detail: `round_labor_times_to_15min set to ${value}`,
      created_at: now,
    });
  },
});
