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

export const SMS_BODY_TEMPLATES: Record<string, (payload: any) => string> = {
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

  /* ── Blocked jobs (Flag Issue spec, §5) ──────────────────────────────────
     One entry per driver-facing blocker kind. Without these the cron still
     sent a message — the generic "Otopair update for your booking" fallback —
     which is arguably worse than silence: it spends the customer's attention
     and tells them nothing.

     Each says what is actually true of that kind, because the right reaction
     differs. Waiting on a part needs no response. Being unreachable needs a
     call back. A safety hold needs them not to collect the car and drive it.

     `damage` has no entry on purpose: KIND_POLICY sets notifyDriver false, so
     no driver row is ever written for it. A shop tells a customer they damaged
     the car; the platform does not do it for them by SMS. */

  job_blocked_parts_delay_driver: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const car = payload?.vehicleLabel ?? "your vehicle";
    return `Otopair: ${shop} is waiting on a part for your ${car}, so your service is paused. They'll pick it straight back up when it arrives.`;
  },

  job_blocked_vehicle_condition_driver: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const car = payload?.vehicleLabel ?? "your vehicle";
    return `Otopair: ${shop} found something on your ${car} that has to be sorted before they can finish. They'll contact you with the details.`;
  },

  job_blocked_needs_specialist_driver: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const car = payload?.vehicleLabel ?? "your vehicle";
    return `Otopair: your service is paused — ${shop} needs a tool or specialist for your ${car} that they don't have on site. They'll follow up shortly.`;
  },

  job_blocked_customer_unreachable_driver: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const car = payload?.vehicleLabel ?? "your vehicle";
    // The only kind the driver can personally clear, so it's the only one that
    // asks for something.
    return `Otopair: ${shop} is trying to reach you about your ${car} and can't continue until they do. Please give them a call.`;
  },

  job_blocked_safety_hold_driver: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const car = payload?.vehicleLabel ?? "your vehicle";
    return `Otopair: ${shop} advises your ${car} shouldn't be driven right now. Please speak to them before collecting it.`;
  },

  appointment_reminder: (payload) => {
    const shop = payload?.shopName ?? "your shop";
    const when = payload?.scheduledDate && payload?.scheduledTime
      ? `${payload.scheduledDate} at ${payload.scheduledTime}`
      : "your upcoming appointment";
    return `Otopair reminder: your appointment at ${shop} is ${when}. Reply if you need to reschedule.`;
  },

  // Sent to the ASSIGNED MECHANIC when a customer requests their car back. The
  // car and who's asking are the whole point — a bare "a customer wants a car"
  // is useless in a busy bay.
  mechanic_pickup_request: (payload) => {
    const who = payload?.customerName ?? "A customer";
    const vehicle = payload?.vehicleLabel ?? "their vehicle";
    const shop = payload?.shopName ?? "the shop";
    return `Otopair: ${who} wants their car back — ${vehicle} at ${shop}. Head up front when you can.`;
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
