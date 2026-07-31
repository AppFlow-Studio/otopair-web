/**
 * payments_backfill_created_at.ts — one-shot repair for payments rows that
 * carry no `created_at`.
 *
 * Why it matters: the shop payments page ranges on
 * payments.by_shop_and_created_at, and `created_at` is optional. In Convex,
 * `undefined` sorts before every number, so an undated row is EXCLUDED by any
 * .gte() bound — it silently vanishes from every date-filtered total. The page
 * reports those rows rather than hiding them, but the real fix is for the case
 * to stop existing.
 *
 * Every writer traced sets created_at (_reservePaymentRow, _recordPaymentIntent,
 * payments.create, payments_backfill_helpers, bookings.ts, the seed sites), so
 * the count is expected to be zero on a healthy deployment. MEASURE FIRST:
 *
 *   npx convex run payments_backfill_created_at:countMissing
 *   npx convex run payments_backfill_created_at:stampMissing '{"limit":500}'
 *
 * The stamp uses _creationTime, never Date.now(). Date.now() would pile every
 * legacy row onto today and corrupt the daily revenue series — worse than the
 * problem it was fixing.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const DEFAULT_SCAN = 1000;

export const countMissing = internalQuery({
  args: { scanLimit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; missing: number; truncated: boolean }> => {
    const cap = Math.min(args.scanLimit ?? DEFAULT_SCAN, 5000);
    // by_created_at ascending puts undated rows first (undefined < every
    // number), so the missing ones are all at the front.
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_created_at")
      .order("asc")
      .take(cap);

    let missing = 0;
    for (const r of rows) {
      if (r.created_at != null) break;
      missing += 1;
    }
    return { scanned: rows.length, missing, truncated: rows.length === cap };
  },
});

export const stampMissing = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ patched: number; done: boolean }> => {
    const limit = Math.min(args.limit ?? 200, 1000);
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_created_at")
      .order("asc")
      .take(limit);

    let patched = 0;
    for (const r of rows) {
      if (r.created_at != null) break;
      await ctx.db.patch(r._id, { created_at: r._creationTime });
      patched += 1;
    }
    // Done when we stopped before filling the page — no undated rows left.
    return { patched, done: patched < limit };
  },
});
