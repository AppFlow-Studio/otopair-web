// =============================================================================
// vin_queue read layer — the first queries this table has ever had (the
// pipeline writes it via internal mutations; the Data portal Control Room
// reads it here). All gated + index-only; the table was 936 rows at build
// time and grows with scraping, so lists paginate and counts come from
// portal_stats (data.vin_queue_total / data.vin_queue_pending).
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

export const listByStatus = query({
  args: {
    token: v.string(),
    status: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { token, status, paginationOpts }) => {
    await requireDirector(ctx, token);
    return ctx.db
      .query("vin_queue")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const byVin = query({
  args: { token: v.string(), vin: v.string() },
  handler: async (ctx, { token, vin }) => {
    await requireDirector(ctx, token);
    return ctx.db
      .query("vin_queue")
      .withIndex("by_vin", (q) => q.eq("vin", vin.trim().toUpperCase()))
      .first();
  },
});

/** Age distribution of the pending backlog (Data Overview §5). Bounded:
 *  reads pending rows only (505 measured). */
export const pendingAgeHistogram = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const pending = await ctx.db
      .query("vin_queue")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const buckets = { "1d": 0, "7d": 0, "30d": 0, older: 0 };
    for (const row of pending) {
      const age = now - row._creationTime;
      if (age < DAY) buckets["1d"]++;
      else if (age < 7 * DAY) buckets["7d"]++;
      else if (age < 30 * DAY) buckets["30d"]++;
      else buckets.older++;
    }
    return { total: pending.length, buckets };
  },
});
