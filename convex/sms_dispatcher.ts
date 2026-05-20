/**
 * sms_dispatcher.ts — Drains pending SMS rows from `notification_outbox`
 * and hands them to the provider stub at `lib/sms-provider.ts`.
 *
 * Runs every minute via cron. Idempotent: rows are flipped to `dispatched`
 * before the action fires so a re-run won't double-send.
 */

import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";

const SMS_BODY_TEMPLATES: Record<string, (payload: any) => string> = {
  customer_late_sms_reminder: (payload) =>
    `Brooklyn Auto: still coming for your ${payload?.scheduledTime ?? ""} appointment? Reply or tap the Otopair app.`,

  walkin_booking_confirmed: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const when = payload?.scheduledDate && payload?.scheduledTime
      ? `${payload.scheduledDate} at ${payload.scheduledTime}`
      : "your scheduled time";
    return `Otopair: you're booked at ${shop} for ${when}. We'll text you when work starts.`;
  },

  walkin_vehicle_at_shop: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    return `Otopair: ${shop} has your vehicle. We'll update you when service begins.`;
  },

  walkin_prejob_complete: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const svc = payload?.primaryService ?? "service";
    return `Otopair: inspection done at ${shop} — starting your ${svc} now.`;
  },

  walkin_completed_claim: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const total = payload?.totalCost != null
      ? `Total $${Number(payload.totalCost).toFixed(2)}.`
      : "";
    const claim = payload?.claimUrl
      ? ` Claim your account & full history: ${payload.claimUrl}`
      : "";
    return `Otopair: service complete at ${shop}. ${total}${claim}`.trim();
  },
};

export const claimPendingSmsRows = internalMutation({
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
      if ((row as any).channel !== "sms") continue;
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

export const recordSmsResult = internalMutation({
  args: {
    outboxId: v.id("notification_outbox"),
    bookingId: v.optional(v.id("bookings")),
    shopId: v.optional(v.id("shops")),
    toPhone: v.string(),
    body: v.string(),
    status: v.string(),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("sms_delivery_log", {
      outbox_id: args.outboxId,
      booking_id: args.bookingId,
      shop_id: args.shopId,
      to_phone: args.toPhone,
      body: args.body,
      status: args.status,
      provider_message_id: args.providerMessageId,
      attempted_at_ms: now,
      error: args.error,
    });
    await ctx.db.patch(args.outboxId, {
      status: args.status === "stubbed" || args.status === "sent" ? "resolved" : "failed",
      processed_at: now,
      updated_at: now,
    } as any);
  },
});

export const dispatchPendingSms = internalAction({
  args: {},
  handler: async (ctx) => {
    const claimed: any[] = await ctx.runMutation(
      internal.sms_dispatcher.claimPendingSmsRows,
      {},
    );

    for (const row of claimed) {
      let toPhone = "";
      if (row.userId) {
        const user: any = await ctx.runQuery(
          (internal as any).sms_dispatcher.getUserPhone,
          { userId: row.userId },
        );
        toPhone = user?.phone ?? "";
      }
      if (!toPhone) {
        await ctx.runMutation(internal.sms_dispatcher.recordSmsResult, {
          outboxId: row.outboxId,
          bookingId: row.bookingId ?? undefined,
          shopId: row.shopId ?? undefined,
          toPhone: "",
          body: "",
          status: "failed",
          error: "no phone on user",
        });
        continue;
      }

      const template = SMS_BODY_TEMPLATES[row.category];
      const body = template
        ? template(row.payload)
        : `Otopair update for your booking.`;

      const result: any = await ctx.runAction(
        (internal as any).lib.sms_provider.sendSms,
        {
          to: toPhone,
          body,
          bookingId: row.bookingId ?? undefined,
          shopId: row.shopId ?? undefined,
          outboxId: row.outboxId,
        },
      );

      await ctx.runMutation(internal.sms_dispatcher.recordSmsResult, {
        outboxId: row.outboxId,
        bookingId: row.bookingId ?? undefined,
        shopId: row.shopId ?? undefined,
        toPhone,
        body,
        status: result.status,
        providerMessageId: result.providerMessageId ?? undefined,
        error: result.error ?? undefined,
      });
    }

    return { dispatched: claimed.length };
  },
});

export const getUserPhone = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    return { phone: (user as any).phone ?? null };
  },
});
