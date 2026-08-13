/**
 * healthPoints.ts — Health Points (HP) per vehicle.
 *
 * The motivation layer described in Rewards Framework v3 §11. HP earn
 * events stack on the vehicle's `points` (clamped to [0, 50]). HP
 * decays at 2 points per 30-day window via a daily cron. The current
 * point count yields a buffer of `floor(points / 15)` (cap 3) that
 * the Vehicle Health score reads and adds on top of the raw score —
 * so a user with HP ≥ 15 always shows at least +1 over their true
 * score, never more than +3.
 *
 * HP does NOT affect tier status, earn rates, or credit amounts. It
 * is a separate axis from Ownership Credit.
 */

import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

const MAX_HP = 50;
const DECAY_PER_MONTH = 2;
const DECAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const HP_PER_BUFFER_POINT = 15;
const MAX_BUFFER = 3;

export function bufferFor(points: number): number {
  return Math.max(0, Math.min(MAX_BUFFER, Math.floor(points / HP_PER_BUFFER_POINT)));
}

/**
 * Internal helper for awarding HP. Callable from other Convex
 * mutations in the same transaction (e.g. `reviews.submit`,
 * `rewards.addCreditForCompletedBooking`).
 *
 * `oneTimeKey: "profile_complete"` makes the award idempotent for the
 * one-time +5 on full vehicle profile completion. Other events
 * (booking complete, review, upload) stack without dedupe — repeat
 * earns are intentional.
 */
export async function awardPointsImpl(
  ctx: MutationCtx,
  args: {
    vin: string;
    userId: Id<"users">;
    delta: number;
    oneTimeKey?: "profile_complete";
  },
): Promise<void> {
  const normalizedVin = args.vin.toUpperCase().trim();
  if (!normalizedVin) return;

  const existing = await ctx.db
    .query("vehicle_health_points")
    .withIndex("by_vin_user", (q) =>
      q.eq("vin", normalizedVin).eq("user_id", args.userId),
    )
    .unique();

  const now = Date.now();

  if (args.oneTimeKey === "profile_complete" && existing?.profile_complete_awarded) {
    return; // already paid
  }

  if (!existing) {
    await ctx.db.insert("vehicle_health_points", {
      vin: normalizedVin,
      user_id: args.userId,
      points: Math.max(0, Math.min(MAX_HP, args.delta)),
      profile_complete_awarded: args.oneTimeKey === "profile_complete",
      last_decay_at: now,
      updated_at: now,
    });
    return;
  }

  const nextPoints = Math.max(0, Math.min(MAX_HP, existing.points + args.delta));
  await ctx.db.patch(existing._id, {
    points: nextPoints,
    profile_complete_awarded:
      existing.profile_complete_awarded || args.oneTimeKey === "profile_complete",
    updated_at: now,
  });
}

/**
 * Public mutation wrapper — useful for tests / admin tooling.
 * Production earn paths should call `awardPointsImpl` directly so the
 * HP write lands in the same transaction as the triggering event.
 */
export const awardPoints = mutation({
  args: {
    vin: v.string(),
    userId: v.id("users"),
    delta: v.number(),
    oneTimeKey: v.optional(v.literal("profile_complete")),
  },
  handler: (ctx, args) => awardPointsImpl(ctx, args),
});

/**
 * Read the HP + derived buffer for one vehicle. Returns zero when no
 * row exists yet.
 */
export const getPoints = query({
  args: { vin: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("vehicle_health_points")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", args.vin.toUpperCase().trim()).eq("user_id", args.userId),
      )
      .unique();
    const points = row?.points ?? 0;
    return { points, buffer: bufferFor(points) };
  },
});

/**
 * Batch query for the cars page — returns one entry per owned vehicle
 * keyed by VIN so the UI can join without an N+1.
 */
export const getPointsForUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("vehicle_health_points")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
    return rows.map((r) => ({
      vin: r.vin,
      points: r.points,
      buffer: bufferFor(r.points),
    }));
  },
});

/**
 * Daily cron entry point. For each vehicle_health_points row, subtract
 * 2 * (number of full 30-day windows elapsed since `last_decay_at`).
 * Idempotent on re-run within the same window.
 */
export const applyDecay = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("vehicle_health_points").collect();
    const now = Date.now();
    for (const row of rows) {
      const last = row.last_decay_at ?? row.updated_at ?? now;
      const windowsElapsed = Math.floor((now - last) / DECAY_WINDOW_MS);
      if (windowsElapsed <= 0) continue;
      const next = Math.max(0, row.points - windowsElapsed * DECAY_PER_MONTH);
      await ctx.db.patch(row._id, {
        points: next,
        last_decay_at: last + windowsElapsed * DECAY_WINDOW_MS,
        updated_at: now,
      });
    }
  },
});
