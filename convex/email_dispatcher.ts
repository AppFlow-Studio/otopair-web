/**
 * email_dispatcher.ts — Drains pending `channel: "email"` rows from
 * `notification_outbox` and delegates the actual Resend call to a
 * Node-only action (`lib.email_provider.sendWalkinUpdate`).
 *
 * Runs every minute via cron. Idempotent: rows are flipped to
 * `dispatching` before send so a re-run won't double-send.
 */

import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";

export const claimPendingEmailRows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("notification_outbox")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();

    const now = Date.now();
    const claimed: Array<{
      outboxId: any;
      bookingId: any;
      shopId: any;
      userId: any;
      category: string;
      payload: any;
    }> = [];

    for (const row of pending) {
      if ((row as any).channel !== "email") continue;
      await ctx.db.patch(row._id, {
        status: "dispatching",
        updated_at: now,
      } as any);
      claimed.push({
        outboxId: row._id,
        bookingId: (row as any).booking_id,
        shopId: (row as any).shop_id,
        userId: (row as any).user_id,
        category: (row as any).category,
        payload: (row as any).payload,
      });
    }

    return claimed;
  },
});

export const recordEmailResult = internalMutation({
  args: {
    outboxId: v.id("notification_outbox"),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.outboxId, {
      status: args.status === "sent" ? "resolved" : "failed",
      processed_at: now,
      updated_at: now,
    } as any);
  },
});

export const getUserEmail = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    return { email: (user as any).email ?? null };
  },
});

export const dispatchPendingEmails = internalAction({
  args: {},
  handler: async (ctx) => {
    const claimed: any[] = await ctx.runMutation(
      internal.email_dispatcher.claimPendingEmailRows,
      {},
    );

    for (const row of claimed) {
      let toEmail = "";
      if (row.userId) {
        const user: any = await ctx.runQuery(
          (internal as any).email_dispatcher.getUserEmail,
          { userId: row.userId },
        );
        toEmail = user?.email ?? "";
      }
      if (!toEmail) {
        await ctx.runMutation(internal.email_dispatcher.recordEmailResult, {
          outboxId: row.outboxId,
          status: "failed",
          error: "no email on user",
        });
        continue;
      }

      const result: any = await ctx.runAction(
        (internal as any).lib.email_provider.sendWalkinUpdate,
        {
          to: toEmail,
          category: row.category,
          payload: row.payload ?? {},
        },
      );

      await ctx.runMutation(internal.email_dispatcher.recordEmailResult, {
        outboxId: row.outboxId,
        status: result.status,
        error: result.error ?? undefined,
      });
    }

    return { dispatched: claimed.length };
  },
});
