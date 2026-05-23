/**
 * platform_settings.ts — Singleton table for OtoPair app-level config.
 *
 * Today: platform fee rate + floor (used by the Stripe application_fee math
 * in payments_stripe.ts). Tomorrow: anything else that's admin-tunable at
 * runtime without a redeploy.
 *
 * Invariant: exactly one row. All accessors use `.first()` and
 * `_getOrCreate` seeds the row lazily with defaults from lib/platformFee.ts.
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  PLATFORM_FEE_FLOOR_DOLLARS,
  PLATFORM_FEE_RATE,
} from "../lib/platformFee";

/** Public read — UI/admin surfaces. Returns null if the row hasn't been
 *  seeded yet (use `_getOrCreate` from a write path to seed). */
export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("platform_settings").first();
  },
});

/** Internal seed-or-fetch used by server flows (e.g. Stripe PI creation).
 *  Idempotent — only inserts the singleton row on first call. */
export const _getOrCreate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("platform_settings").first();
    if (existing) return existing;

    const now = Date.now();
    const id = await ctx.db.insert("platform_settings", {
      platform_fee_rate: PLATFORM_FEE_RATE,
      platform_fee_floor_dollars: PLATFORM_FEE_FLOOR_DOLLARS,
      created_at: now,
      updated_at: now,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error("platform_settings seed failed");
    return row;
  },
});

/** Admin-only write — gated by callers (admin dashboard).
 *  Validates ranges so a bad input can't break the payment flow. */
export const update = mutation({
  args: {
    platform_fee_rate: v.optional(v.number()),
    platform_fee_floor_dollars: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    if (args.platform_fee_rate != null) {
      if (args.platform_fee_rate < 0 || args.platform_fee_rate > 1) {
        throw new Error("platform_fee_rate must be between 0 and 1");
      }
    }
    if (args.platform_fee_floor_dollars != null) {
      if (args.platform_fee_floor_dollars < 0) {
        throw new Error("platform_fee_floor_dollars must be >= 0");
      }
    }

    const existing = await ctx.db.query("platform_settings").first();
    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("platform_settings", {
        platform_fee_rate: args.platform_fee_rate ?? PLATFORM_FEE_RATE,
        platform_fee_floor_dollars:
          args.platform_fee_floor_dollars ?? PLATFORM_FEE_FLOOR_DOLLARS,
        created_at: now,
        updated_at: now,
      });
      return;
    }
    await ctx.db.patch(existing._id, {
      ...(args.platform_fee_rate != null && {
        platform_fee_rate: args.platform_fee_rate,
      }),
      ...(args.platform_fee_floor_dollars != null && {
        platform_fee_floor_dollars: args.platform_fee_floor_dollars,
      }),
      updated_at: now,
    });
  },
});
