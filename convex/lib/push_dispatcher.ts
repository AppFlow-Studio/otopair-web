/**
 * push_dispatcher.ts — Drains pending push rows from `notification_outbox`
 * and hands them to the Expo Push API.
 *
 * Runs every minute via cron. Idempotent: rows are flipped to `dispatching`
 * before the HTTP call so a re-run won't double-send.
 *
 * Handles Expo error codes:
 *   - DeviceNotRegistered → clear users.push_token (device uninstalled/
 *     reinstalled, OS revoked permission, etc.) so subsequent cycles fall
 *     back to SMS/email.
 *   - MessageTooBig / MessageRateExceeded / InvalidCredentials → mark
 *     `failed` so it won't be retried. The user-facing approval banner
 *     also reactively renders from notification_outbox + booking state, so
 *     the customer still sees the prompt even when push fails.
 *   - Network / 5xx → leave as `dispatching`; the next cron tick will
 *     retry (rows older than X minutes get reset by a maintenance pass —
 *     todo, not in this PR).
 */

import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { v } from "convex/values";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

type PushPayload = {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
};

type ClaimedRow = {
  outboxId: any;
  userId: any;
  bookingId: any;
  category: string;
  payload: PushPayload;
  pushToken: string;
};

export const _claimPendingPushRows = internalMutation({
  args: {},
  handler: async (ctx): Promise<ClaimedRow[]> => {
    const pending = await ctx.db
      .query("notification_outbox")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();

    const claimed: ClaimedRow[] = [];
    const now = Date.now();
    for (const row of pending) {
      if ((row as any).channel !== "push") continue;
      const userId = (row as any).user_id;
      if (!userId) continue;
      const user: any = await ctx.db.get(userId);
      const token = user?.push_token as string | undefined;
      if (!token) {
        // No push token: mark superseded so SMS/email fallbacks (if
        // enqueued separately) can still fire. Cheap signal that the
        // dispatcher saw this row.
        await ctx.db.patch(row._id, {
          status: "no_push_token",
          updated_at: now,
        } as any);
        continue;
      }
      await ctx.db.patch(row._id, {
        status: "dispatching",
        updated_at: now,
      } as any);
      claimed.push({
        outboxId: row._id,
        userId,
        bookingId: (row as any).booking_id,
        category: (row as any).category,
        payload: (row as any).payload ?? {},
        pushToken: token,
      });
    }
    return claimed;
  },
});

export const _markPushDispatched = internalMutation({
  args: {
    outboxId: v.id("notification_outbox"),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.outboxId, {
      status: args.status,
      processed_at: now,
      updated_at: now,
      ...(args.error ? { payload: { error: args.error } as any } : {}),
    } as any);
  },
});

/** Clears the user's push_token when Expo reports DeviceNotRegistered. */
export const _clearUserPushToken = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      push_token: undefined,
      push_token_updated_at_ms: Date.now(),
    } as any);
  },
});

export const dispatchPendingPush = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number; failed: number }> => {
    const claimed: ClaimedRow[] = await ctx.runMutation(
      internal.lib.push_dispatcher._claimPendingPushRows,
      {},
    );
    let sent = 0;
    let failed = 0;
    for (const row of claimed) {
      try {
        const resp = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            to: row.pushToken,
            title: row.payload.title ?? "Otopair",
            body: row.payload.body ?? "",
            data: row.payload.data ?? {},
            sound: "default",
            priority: "high",
            channelId: "default",
          }),
        });
        const json: any = await resp.json().catch(() => ({}));
        const ticket = Array.isArray(json?.data) ? json.data[0] : json?.data;
        if (ticket?.status === "ok") {
          await ctx.runMutation(
            internal.lib.push_dispatcher._markPushDispatched,
            { outboxId: row.outboxId, status: "dispatched" },
          );
          sent += 1;
        } else {
          const errorCode = ticket?.details?.error ?? ticket?.message ?? "unknown";
          if (errorCode === "DeviceNotRegistered") {
            await ctx.runMutation(
              internal.lib.push_dispatcher._clearUserPushToken,
              { userId: row.userId },
            );
          }
          await ctx.runMutation(
            internal.lib.push_dispatcher._markPushDispatched,
            {
              outboxId: row.outboxId,
              status: "failed",
              error: String(errorCode).slice(0, 200),
            },
          );
          failed += 1;
        }
      } catch (err: any) {
        // Network / transient — leave as dispatching so a future tick can
        // retry. (A maintenance pass should reset rows stuck in dispatching
        // for > N minutes.)
        failed += 1;
      }
    }
    return { sent, failed };
  },
});
