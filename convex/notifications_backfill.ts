/**
 * notifications_backfill.ts — one-shot backfill for the notification lifecycle
 * split (adds read_at / resolved_at / resolved_reason to notification_outbox).
 *
 * Why it matters: the customer AND shop-staff feeds are moving OFF the
 * overloaded `status` field onto a dedicated resolve axis. The new feed
 * predicate shows rows where `resolved_at == null`. Pre-existing rows have no
 * resolved_at, so without this backfill every historical delivered / resolved /
 * failed row would suddenly flood the feed on first load.
 *
 * Rule: a row whose `status` is TERMINAL (dispatched | resolved | failed |
 * no_push_token) was, under the old model, no longer an open feed item —
 * a delivered push, a staff-resolved alert, a dead delivery. Stamp it resolved
 * so the new feed starts clean. Rows still "pending" (customer undispatched +
 * staff live queue) and transient "dispatching" rows are LEFT open — they flow
 * through the normal path. Unknown statuses are left open too (safe default:
 * never archive something we don't recognise).
 *
 * Stamp source: processed_at ?? updated_at ?? created_at ?? _creationTime.
 * Never Date.now() — that would collapse all history onto today and corrupt any
 * time-ordered read of the archive.
 *
 * Self-draining: stampResolved schedules its own next page, so ONE kick drains
 * the whole table. MEASURE FIRST:
 *
 *   npx convex run notifications_backfill:countUnstamped
 *   npx convex run notifications_backfill:stampResolved
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

const PAGE = 500;

// Delivery/lifecycle states that mean "no longer an open feed item" under the
// pre-split model (feeds showed only status=="pending"). Everything else
// (pending, dispatching, unknown) stays open. `superseded` closes a cancelled
// delivery (e.g. a customer-late SMS the customer pre-empted by acknowledging).
const TERMINAL_STATUSES = new Set([
  "dispatched",
  "resolved",
  "superseded",
  "failed",
  "no_push_token",
]);

function needsStamp(row: any): boolean {
  return row.resolved_at == null && TERMINAL_STATUSES.has(row.status);
}

/**
 * Non-mutating measurement. Walk one page at a time (pass the returned
 * continueCursor back) to size the backfill before running it.
 */
export const countUnstamped = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("notification_outbox")
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE });

    let toStamp = 0;
    for (const row of page) {
      if (needsStamp(row)) toStamp += 1;
    }
    return { scanned: page.length, toStamp, isDone, continueCursor };
  },
});

/**
 * Stamp resolved_at on terminal rows, one page per transaction, then schedule
 * the next page until the table is drained. Idempotent — rows already carrying
 * resolved_at are skipped, so re-running is safe.
 */
export const stampResolved = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("notification_outbox")
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE });

    let patched = 0;
    for (const row of page) {
      if (!needsStamp(row)) continue;
      const r = row as any;
      const stamp =
        r.processed_at ?? r.updated_at ?? r.created_at ?? r._creationTime;
      await ctx.db.patch(row._id, {
        resolved_at: stamp,
        resolved_reason: "backfill",
      } as any);
      patched += 1;
    }

    if (!isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications_backfill.stampResolved,
        { cursor: continueCursor },
      );
    }

    return { patched, scanned: page.length, isDone };
  },
});
