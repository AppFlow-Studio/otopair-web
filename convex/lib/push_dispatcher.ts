/**
 * push_dispatcher.ts — Drains pending push rows from `notification_outbox`
 * and hands them to the Expo Push API.
 *
 * Kicked immediately on enqueue (see convex/lib/notificationOutbox.ts) and, as
 * a backstop, run every minute via cron. Idempotent: rows are flipped to
 * `dispatching` before the HTTP call so a re-run won't double-send.
 *
 * Delivery pipeline for a push row:
 *   pending → dispatching → dispatched (Expo accepted, ticket id stored)
 *           → delivered (receipt confirms handoff to APNs/FCM) | failed
 *
 * Reliability:
 *   - Sends are BATCHED (≤100 messages per Expo request) and each HTTP call has
 *     a timeout, so one hung/slow connection can't stall the whole drain.
 *   - `resetStuckDispatching` (cron, every 5 min) flips rows stranded in
 *     `dispatching` (a network/timeout error mid-send) back to `pending` so the
 *     next tick retries. At-least-once: a resend after a lost response can
 *     double-deliver — acceptable for push.
 *   - `pollPushReceipts` (cron, every 2 min) reads Expo's delivery receipts and
 *     promotes `dispatched → delivered`, or `→ failed` (clearing the token on
 *     DeviceNotRegistered). Receipts that never arrive are given up on after
 *     RECEIPT_GIVEUP_MS and marked delivered-unconfirmed.
 *
 * Expo error codes:
 *   - DeviceNotRegistered → clear users.push_token (device uninstalled/
 *     reinstalled, OS revoked permission, etc.) so subsequent cycles fall
 *     back to SMS/email.
 *   - MessageTooBig / MessageRateExceeded / InvalidCredentials → mark
 *     `failed`. The user-facing approval banner also reactively renders from
 *     notification_outbox + booking state, so the customer still sees the
 *     prompt even when push fails.
 */

import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import { v } from "convex/values";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

const SEND_CHUNK = 100; // Expo accepts up to 100 messages per /push/send request
const RECEIPT_CHUNK = 1000; // Expo accepts up to 1000 ids per /getReceipts request
const FETCH_TIMEOUT_MS = 10_000;
const STUCK_DISPATCHING_MS = 3 * 60 * 1000; // reset rows stuck this long
const MAX_PUSH_ATTEMPTS = 5; // give up (mark failed) after this many send tries
const RECEIPT_MIN_AGE_MS = 60 * 1000; // give Expo time to produce a receipt
const RECEIPT_GIVEUP_MS = 30 * 60 * 1000; // stop polling; mark delivered-unconfirmed

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

type ReceiptCandidate = {
  outboxId: any;
  userId: any;
  ticketId: string;
  processedAt: number;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** fetch with an abort-based timeout (AbortController is universally available
 *  in the Convex action runtime; AbortSignal.timeout may not be). */
async function fetchWithTimeout(
  url: string,
  init: any,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
      // Not yet due — a future-dated scheduled_for_ms (e.g. the intentional
      // delay path) waits until its time; the instant-kick schedules a
      // runAfter(delay) for that moment. Backstop cron respects it too.
      const sched = (row as any).scheduled_for_ms;
      if (sched != null && sched > now) continue;
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

/** Batch-record the outcome of a send: `dispatched` (+ ticket id) or `failed`
 *  (+ error, merged into the existing payload so the in-app feed copy survives). */
export const _recordPushResults = internalMutation({
  args: {
    results: v.array(
      v.object({
        outboxId: v.id("notification_outbox"),
        status: v.string(),
        ticketId: v.optional(v.string()),
        error: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const r of args.results) {
      const patch: any = { status: r.status, processed_at: now, updated_at: now };
      if (r.ticketId) patch.push_ticket_id = r.ticketId;
      if (r.error) {
        const row: any = await ctx.db.get(r.outboxId);
        patch.payload = { ...(row?.payload ?? {}), error: r.error };
      }
      await ctx.db.patch(r.outboxId, patch);
    }
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

    for (const group of chunk(claimed, SEND_CHUNK)) {
      const messages = group.map((row) => ({
        to: row.pushToken,
        title: row.payload.title ?? "Otopair",
        body: row.payload.body ?? "",
        data: row.payload.data ?? {},
        sound: "default",
        priority: "high",
        channelId: "default",
      }));

      let tickets: any[] | null = null;
      try {
        const resp = await fetchWithTimeout(
          EXPO_PUSH_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(messages),
          },
          FETCH_TIMEOUT_MS,
        );
        const json: any = await resp.json().catch(() => ({}));
        tickets = Array.isArray(json?.data) ? json.data : null;
      } catch {
        tickets = null; // network / timeout
      }

      // Transient failure (network, timeout, or an unexpected/short response):
      // re-queue the whole chunk to `pending` NOW so the 1-min dispatch cron
      // retries within ≤60s. Previously these were left in `dispatching` for
      // resetStuckDispatching to recover — a 5-min cron with a 10-min stuck
      // threshold, which was the 10–15 min delivery tail. Bounded by
      // push_attempts so a permanently-failing row eventually gives up.
      if (!tickets || tickets.length !== group.length) {
        failed += group.length;
        await ctx.runMutation(internal.lib.push_dispatcher._requeuePushRows, {
          outboxIds: group.map((row) => row.outboxId),
        });
        continue;
      }

      const results: Array<{
        outboxId: any;
        status: string;
        ticketId?: string;
        error?: string;
      }> = [];
      const tokensToClear = new Map<string, any>();
      for (let i = 0; i < group.length; i++) {
        const row = group[i];
        const ticket = tickets[i];
        if (ticket?.status === "ok") {
          results.push({
            outboxId: row.outboxId,
            status: "dispatched",
            ticketId: ticket.id,
          });
          sent += 1;
        } else {
          const errorCode =
            ticket?.details?.error ?? ticket?.message ?? "unknown";
          if (errorCode === "DeviceNotRegistered" && row.userId) {
            tokensToClear.set(String(row.userId), row.userId);
          }
          results.push({
            outboxId: row.outboxId,
            status: "failed",
            error: String(errorCode).slice(0, 200),
          });
          failed += 1;
        }
      }

      await ctx.runMutation(internal.lib.push_dispatcher._recordPushResults, {
        results,
      });
      for (const [, userId] of tokensToClear) {
        await ctx.runMutation(internal.lib.push_dispatcher._clearUserPushToken, {
          userId,
        });
      }
    }

    return { sent, failed };
  },
});

/** Backstop for the push dispatcher's own network-error trap: a send that
 *  throws mid-flight leaves its rows in `dispatching` forever. Flip anything
 *  stuck there beyond STUCK_DISPATCHING_MS back to `pending` so the next tick
 *  retries. Channel-agnostic — covers push/sms/email uniformly. */
export const resetStuckDispatching = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ reset: number }> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_status", (q: any) => q.eq("status", "dispatching"))
      .collect();
    let reset = 0;
    for (const row of rows) {
      const updatedAt =
        (row as any).updated_at ?? (row as any).created_at ?? 0;
      if (now - updatedAt < STUCK_DISPATCHING_MS) continue;
      await ctx.db.patch(row._id, {
        status: "pending",
        updated_at: now,
      } as any);
      reset += 1;
    }
    return { reset };
  },
});

/** Re-queue a chunk that hit a transient send failure: bump push_attempts and
 *  flip back to `pending` so the next dispatch tick (≤1 min) retries. Once a
 *  row has burned MAX_PUSH_ATTEMPTS tries it's marked `failed` instead of
 *  looping forever — the in-app card still stands (feed reads the resolve axis,
 *  not delivery status), and SMS/email fallbacks (if separately enqueued) can
 *  still carry the message. */
export const _requeuePushRows = internalMutation({
  args: { outboxIds: v.array(v.id("notification_outbox")) },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    for (const id of args.outboxIds) {
      const row: any = await ctx.db.get(id);
      if (!row) continue;
      const attempts = (row.push_attempts ?? 0) + 1;
      if (attempts >= MAX_PUSH_ATTEMPTS) {
        await ctx.db.patch(id, {
          status: "failed",
          push_attempts: attempts,
          updated_at: now,
          payload: { ...(row.payload ?? {}), error: "max_send_attempts" },
        } as any);
      } else {
        await ctx.db.patch(id, {
          status: "pending",
          push_attempts: attempts,
          updated_at: now,
        } as any);
      }
    }
  },
});

/** Rows accepted by Expo (`dispatched` + a ticket id) that are old enough for a
 *  receipt to exist. Read-only — the poller updates them via
 *  `_recordReceiptResults` once it has the receipt. */
export const _claimReceiptCandidates = internalMutation({
  args: {},
  handler: async (ctx): Promise<ReceiptCandidate[]> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_status", (q: any) => q.eq("status", "dispatched"))
      .collect();
    const out: ReceiptCandidate[] = [];
    for (const row of rows) {
      const ticketId = (row as any).push_ticket_id as string | undefined;
      if (!ticketId) continue;
      const processedAt =
        (row as any).processed_at ?? (row as any).updated_at ?? 0;
      if (now - processedAt < RECEIPT_MIN_AGE_MS) continue;
      out.push({
        outboxId: row._id,
        userId: (row as any).user_id,
        ticketId,
        processedAt,
      });
      if (out.length >= RECEIPT_CHUNK) break;
    }
    return out;
  },
});

export const _recordReceiptResults = internalMutation({
  args: {
    results: v.array(
      v.object({
        outboxId: v.id("notification_outbox"),
        status: v.string(),
        error: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const r of args.results) {
      const patch: any = { status: r.status, updated_at: now };
      if (r.error) {
        const row: any = await ctx.db.get(r.outboxId);
        patch.payload = { ...(row?.payload ?? {}), error: r.error };
      }
      await ctx.db.patch(r.outboxId, patch);
    }
  },
});

export const pollPushReceipts = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ delivered: number; failed: number; pending: number }> => {
    const candidates: ReceiptCandidate[] = await ctx.runMutation(
      internal.lib.push_dispatcher._claimReceiptCandidates,
      {},
    );
    let delivered = 0;
    let failed = 0;
    let pending = 0;
    const now = Date.now();

    for (const group of chunk(candidates, RECEIPT_CHUNK)) {
      let receipts: Record<string, any> | null = null;
      try {
        const resp = await fetchWithTimeout(
          EXPO_RECEIPTS_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ ids: group.map((c) => c.ticketId) }),
          },
          FETCH_TIMEOUT_MS,
        );
        const json: any = await resp.json().catch(() => ({}));
        receipts =
          json && typeof json.data === "object" ? json.data : null;
      } catch {
        receipts = null; // transient — re-poll next tick
      }
      if (!receipts) {
        pending += group.length;
        continue;
      }

      const results: Array<{ outboxId: any; status: string; error?: string }> =
        [];
      const tokensToClear = new Map<string, any>();
      for (const c of group) {
        const receipt = receipts[c.ticketId];
        if (!receipt) {
          // No receipt yet. Give up after a while so we don't re-query forever;
          // treat as delivered-unconfirmed (Expo accepted the ticket).
          if (now - c.processedAt >= RECEIPT_GIVEUP_MS) {
            results.push({ outboxId: c.outboxId, status: "delivered" });
            delivered += 1;
          } else {
            pending += 1; // leave as `dispatched`, re-poll next tick
          }
          continue;
        }
        if (receipt.status === "ok") {
          results.push({ outboxId: c.outboxId, status: "delivered" });
          delivered += 1;
        } else {
          const errorCode =
            receipt.details?.error ?? receipt.message ?? "unknown";
          if (errorCode === "DeviceNotRegistered" && c.userId) {
            tokensToClear.set(String(c.userId), c.userId);
          }
          results.push({
            outboxId: c.outboxId,
            status: "failed",
            error: String(errorCode).slice(0, 200),
          });
          failed += 1;
        }
      }

      if (results.length) {
        await ctx.runMutation(
          internal.lib.push_dispatcher._recordReceiptResults,
          { results },
        );
      }
      for (const [, userId] of tokensToClear) {
        await ctx.runMutation(internal.lib.push_dispatcher._clearUserPushToken, {
          userId,
        });
      }
    }

    return { delivered, failed, pending };
  },
});
