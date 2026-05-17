/**
 * notifications.ts — Customer-facing notification feed
 *
 * Reads from the existing `notification_outbox` table (defined in
 * `schema.ts`). Shop-side mutations like `proposeReschedule` already
 * enqueue rows with the customer's `user_id` populated (see
 * `enqueueNotificationOutbox` in `bookings.ts`). This module exposes
 * the customer view: list pending rows, count unread, mark read.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
}

export const getMyNotifications = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();

    const mine = rows
      .filter((row: any) => row.user_id === user._id)
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, 50);

    // Enrich each booking-bound row with the short handle, customer name,
    // vehicle label, and shop name so banners can render descriptive copy
    // without a second roundtrip per row.
    const enriched = await Promise.all(
      mine.map(async (row: any) => {
        let customerName: string | null = null;
        let vehicleLabel: string | null = null;
        let shopName: string | null = null;
        let scheduledDate: string | null = null;
        let scheduledTime: string | null = null;
        let shortHandle: string | null = null;
        if (row.booking_id) {
          const booking: any = await ctx.db.get(row.booking_id);
          if (booking) {
            scheduledDate = booking.scheduled_date ?? null;
            scheduledTime = booking.scheduled_time ?? null;
            const inv = (booking.invoice_number ?? "").trim();
            shortHandle = inv
              ? inv.startsWith("#")
                ? inv
                : `#${inv}`
              : `#${String(booking._id).slice(-6).toUpperCase()}`;
            if (booking.user_id) {
              const cust: any = await ctx.db.get(booking.user_id);
              const composed = [cust?.first_name, cust?.last_name]
                .filter(Boolean)
                .join(" ");
              customerName =
                cust?.name ||
                (composed.length > 0 ? composed : null) ||
                cust?.email ||
                null;
            }
            if (booking.vehicle_id) {
              const veh: any = await ctx.db.get(booking.vehicle_id);
              if (veh) {
                const meta = veh.metadata ?? {};
                const parts = [veh.year ?? meta.year, meta.make, meta.model].filter(
                  Boolean,
                );
                vehicleLabel =
                  parts.length > 0
                    ? parts.join(" ")
                    : veh.vin
                      ? `VIN …${String(veh.vin).slice(-6)}`
                      : null;
              }
            }
          }
        }
        if (row.shop_id) {
          const shop: any = await ctx.db.get(row.shop_id);
          shopName = shop?.name ?? null;
        }
        return {
          _id: row._id,
          category: row.category,
          payload: row.payload,
          booking_id: row.booking_id ?? null,
          shop_id: row.shop_id ?? null,
          created_at: row.created_at,
          status: row.status,
          customerName,
          vehicleLabel,
          shopName,
          shortHandle,
          scheduledDate,
          scheduledTime,
        };
      }),
    );
    return enriched;
  },
});

export const getMyUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return 0;

    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();

    return rows.filter((row: any) => row.user_id === user._id).length;
  },
});

export const markNotificationRead = mutation({
  args: { notificationId: v.id("notification_outbox") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");

    const row = await ctx.db.get(args.notificationId);
    if (!row) return;
    if ((row as any).user_id !== user._id) {
      throw new Error("Not your notification");
    }

    const now = Date.now();
    await ctx.db.patch(args.notificationId, {
      status: "resolved",
      processed_at: now,
      updated_at: now,
    } as any);
  },
});
