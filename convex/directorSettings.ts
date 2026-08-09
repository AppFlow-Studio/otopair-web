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
  // Unanswered booking-request expiry (see convex/bookings.ts). Units are
  // human-friendly (hours / minutes); the sweep converts to ms.
  unconfirmed_expiry_enabled: true,
  unconfirmed_response_window_hours: 48,
  unconfirmed_post_time_grace_minutes: 120,
  unconfirmed_reminder1_before_hours: 24,
  unconfirmed_reminder2_before_hours: 8,
  unconfirmed_silent_if_past_deadline_hours: 24,
  // StubHub-style checkout slot holds (see convex/slotHolds.ts).
  slot_hold_enabled: true,
  slot_hold_ttl_minutes: 15,
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
      unconfirmed_expiry_enabled:
        row?.unconfirmed_expiry_enabled ?? DEFAULTS.unconfirmed_expiry_enabled,
      unconfirmed_response_window_hours:
        row?.unconfirmed_response_window_hours ??
        DEFAULTS.unconfirmed_response_window_hours,
      unconfirmed_post_time_grace_minutes:
        row?.unconfirmed_post_time_grace_minutes ??
        DEFAULTS.unconfirmed_post_time_grace_minutes,
      unconfirmed_reminder1_before_hours:
        row?.unconfirmed_reminder1_before_hours ??
        DEFAULTS.unconfirmed_reminder1_before_hours,
      unconfirmed_reminder2_before_hours:
        row?.unconfirmed_reminder2_before_hours ??
        DEFAULTS.unconfirmed_reminder2_before_hours,
      unconfirmed_silent_if_past_deadline_hours:
        row?.unconfirmed_silent_if_past_deadline_hours ??
        DEFAULTS.unconfirmed_silent_if_past_deadline_hours,
      slot_hold_enabled:
        row?.slot_hold_enabled ?? DEFAULTS.slot_hold_enabled,
      slot_hold_ttl_minutes:
        row?.slot_hold_ttl_minutes ?? DEFAULTS.slot_hold_ttl_minutes,
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

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

// Update the unanswered-booking-request expiry knobs. Only provided fields are
// changed; each is validated/clamped to a sane range.
export const setBookingExpiryConfig = mutation({
  args: {
    enabled: v.optional(v.boolean()),
    responseWindowHours: v.optional(v.number()),
    postTimeGraceMinutes: v.optional(v.number()),
    reminder1BeforeHours: v.optional(v.number()),
    reminder2BeforeHours: v.optional(v.number()),
    silentIfPastDeadlineHours: v.optional(v.number()),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, number | boolean> = {};
    if (typeof args.enabled === "boolean") patch.unconfirmed_expiry_enabled = args.enabled;
    const rw = clampNumber(args.responseWindowHours, 1, 720);
    if (rw !== undefined) patch.unconfirmed_response_window_hours = rw;
    const grace = clampNumber(args.postTimeGraceMinutes, 0, 1440);
    if (grace !== undefined) patch.unconfirmed_post_time_grace_minutes = grace;
    const r1 = clampNumber(args.reminder1BeforeHours, 0, 336);
    if (r1 !== undefined) patch.unconfirmed_reminder1_before_hours = r1;
    const r2 = clampNumber(args.reminder2BeforeHours, 0, 336);
    if (r2 !== undefined) patch.unconfirmed_reminder2_before_hours = r2;
    const silent = clampNumber(args.silentIfPastDeadlineHours, 0, 720);
    if (silent !== undefined) patch.unconfirmed_silent_if_past_deadline_hours = silent;

    const now = Date.now();
    const existing = await ctx.db
      .query("director_settings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...patch,
        updated_at: now,
        updated_by_user_id: args.actorId,
      });
    } else {
      await ctx.db.insert("director_settings", {
        key: SETTINGS_KEY,
        round_labor_times_to_15min: DEFAULTS.round_labor_times_to_15min,
        ...patch,
        updated_at: now,
        updated_by_user_id: args.actorId,
      });
    }

    await ctx.db.insert("audit_log", {
      entity_type: "director_settings",
      entity_id: SETTINGS_KEY,
      action: "field_edit",
      actor: args.actorName ?? "Director",
      actor_id: args.actorId,
      detail: `unconfirmed-request expiry updated: ${JSON.stringify(patch)}`,
      created_at: now,
    });
    return { ok: true };
  },
});

// Update the StubHub-style slot-hold controls (see convex/slotHolds.ts). Only
// provided fields change; ttl is clamped to a sane 1–60 minute range.
export const setSlotHoldConfig = mutation({
  args: {
    enabled: v.optional(v.boolean()),
    ttlMinutes: v.optional(v.number()),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, number | boolean> = {};
    if (typeof args.enabled === "boolean") patch.slot_hold_enabled = args.enabled;
    const ttl = clampNumber(args.ttlMinutes, 1, 60);
    if (ttl !== undefined) patch.slot_hold_ttl_minutes = ttl;

    const now = Date.now();
    const existing = await ctx.db
      .query("director_settings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...patch,
        updated_at: now,
        updated_by_user_id: args.actorId,
      });
    } else {
      await ctx.db.insert("director_settings", {
        key: SETTINGS_KEY,
        round_labor_times_to_15min: DEFAULTS.round_labor_times_to_15min,
        ...patch,
        updated_at: now,
        updated_by_user_id: args.actorId,
      });
    }

    await ctx.db.insert("audit_log", {
      entity_type: "director_settings",
      entity_id: SETTINGS_KEY,
      action: "field_edit",
      actor: args.actorName ?? "Director",
      actor_id: args.actorId,
      detail: `slot-hold config updated: ${JSON.stringify(patch)}`,
      created_at: now,
    });
    return { ok: true };
  },
});
