// =============================================================================
// Ops · Bookings board / list / detail — read-only for P0 (no status mutations
// yet; status flows from the shop portal / app). Every query is token-gated via
// requireDirector and reads through indexed windows only:
//   - board:  bookings.by_status .take(50) per measured status column
//   - list:   bookings.by_created_at (or by_status) paginated
//   - detail: single booking + by_booking_id joins (payments, status history)
// Wraps the data shape of director.ts bookingDetail without touching that file.
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** MEASURED status set on this deployment (NOT confirmed/in_progress). */
export const BOOKING_STATUSES = [
  "pending",
  "pending_quote",
  "quotes_ready",
  "vehicle_at_shop",
  "completed",
  "cancelled",
  "no_show",
] as const;

// ---------------------------------------------------------------------------
// Shared row shape (board cards + list rows)
// ---------------------------------------------------------------------------
async function bookingRow(ctx: QueryCtx, b: Doc<"bookings">) {
  const [user, shop] = await Promise.all([
    ctx.db.get(b.user_id),
    b.shop_id ? ctx.db.get(b.shop_id) : null,
  ]);
  const serviceNames = await Promise.all(
    b.service_ids.map(async (sid) => {
      const s = await ctx.db.get(sid);
      return s?.name ?? "—";
    }),
  );
  return {
    id: b._id,
    userId: b.user_id,
    user: user
      ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown"
      : "Unknown",
    shopId: b.shop_id ?? null,
    shop: shop?.name ?? "—",
    vin: b.vin,
    services: serviceNames,
    scheduledDate: b.scheduled_date ?? null,
    scheduledTime: b.scheduled_time ?? null,
    createdAt: b.created_at ?? b._creationTime,
    status: b.status,
    liveStage: b.live_stage ?? null,
    total: b.total_cost ?? null,
  };
}

/** Board view: one column per measured status; each column is a
 *  by_status window of the 50 most recent bookings + header count
 *  (capped — `more` is true when the window filled up). */
export const board = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const columns = await Promise.all(
      BOOKING_STATUSES.map(async (status) => {
        const rows = await ctx.db
          .query("bookings")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(50);
        const cards = await Promise.all(rows.map((b) => bookingRow(ctx, b)));
        return { status, count: cards.length, more: cards.length === 50, cards };
      }),
    );
    return columns;
  },
});

/** List view: recent bookings via by_created_at desc, or a single-status
 *  window via by_status when a filter is set. Paginated. */
export const list = query({
  args: {
    token: v.string(),
    status: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { token, status, paginationOpts }) => {
    await requireDirector(ctx, token);
    const page = status
      ? await ctx.db
          .query("bookings")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("bookings")
          .withIndex("by_created_at")
          .order("desc")
          .paginate(paginationOpts);
    return {
      ...page,
      page: await Promise.all(page.page.map((b) => bookingRow(ctx, b))),
    };
  },
});

/** Booking detail — wraps the director.ts bookingDetail shape (own gated
 *  query; that file is shared and must not change): booking fields + shop +
 *  user + mechanic + ALL payments for the booking (payments.by_booking_id) +
 *  status-history timeline + time slot + review. */
export const detail = query({
  args: { token: v.string(), id: v.id("bookings") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const booking = await ctx.db.get(id);
    if (!booking) return null;

    const [user, shop, mechanic, timeSlot] = await Promise.all([
      ctx.db.get(booking.user_id),
      booking.shop_id ? ctx.db.get(booking.shop_id) : null,
      booking.mechanic_id ? ctx.db.get(booking.mechanic_id) : null,
      booking.time_slot_id ? ctx.db.get(booking.time_slot_id) : null,
    ]);

    const services = await Promise.all(
      booking.service_ids.map(async (sid) => {
        const s = await ctx.db.get(sid);
        return { id: sid, name: s?.name ?? "—", slug: s?.slug ?? null };
      }),
    );

    // Vehicle year/make/model so support recognizes the car, not just the VIN.
    let vehicleYmm: string | null = null;
    if (booking.vin) {
      const veh = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
        .first();
      if (veh) {
        let make = "";
        let model = "";
        if (veh.trim_id) {
          const trim = await ctx.db.get(veh.trim_id);
          if (trim) {
            const m = await ctx.db.get(trim.model_id);
            if (m) {
              model = m.name ?? "";
              const mk = await ctx.db.get(m.make_id);
              if (mk) make = mk.name ?? "";
            }
          }
        }
        vehicleYmm = [veh.year, make, model].filter(Boolean).join(" ") || veh.vin;
      }
    }

    const [statusHistory, payments, review] = await Promise.all([
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .order("asc")
        .collect(),
      ctx.db
        .query("payments")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .collect(),
      ctx.db
        .query("reviews")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", id))
        .first(),
    ]);

    return {
      id: booking._id,
      status: booking.status,
      liveStage: booking.live_stage ?? null,
      createdAt: booking.created_at ?? booking._creationTime,
      scheduledDate: booking.scheduled_date ?? null,
      scheduledTime: booking.scheduled_time ?? null,
      invoiceNumber: booking.invoice_number ?? null,
      vin: booking.vin,
      vehicleYmm,
      customerNotes: booking.customer_notes ?? null,
      refundReason: booking.refund_reason ?? null,

      // Money (dollars; optional on the doc)
      laborCost: booking.labor_cost ?? null,
      partsCost: booking.parts_cost ?? null,
      totalCost: booking.total_cost ?? null,
      estimatedLaborMinutes: booking.estimated_labor_minutes ?? null,

      user: user
        ? {
            id: booking.user_id,
            name:
              `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() ||
              user.email ||
              "Unknown",
            email: user.email ?? null,
            phone: user.phone ?? null,
          }
        : { id: booking.user_id, name: "Unknown", email: null, phone: null },
      shop: shop
        ? {
            id: booking.shop_id,
            name: shop.name,
            address: shop.address ?? null,
            phone: shop.phone ?? null,
            email: shop.email ?? null,
          }
        : null,
      mechanic: mechanic
        ? {
            id: booking.mechanic_id,
            name: `${mechanic.first_name} ${mechanic.last_name}`.trim(),
            title: mechanic.title ?? null,
          }
        : null,
      timeSlot: timeSlot
        ? {
            date: timeSlot.date,
            startTime: timeSlot.start_time,
            endTime: timeSlot.end_time,
          }
        : null,

      services,

      statusHistory: statusHistory.map((h) => ({
        status: h.new_status,
        changedAt: h.changed_at,
        changedBy: h.changed_by,
        reason: h.reason ?? null,
      })),

      payments: payments.map((p) => ({
        id: p._id,
        amount: p.amount, // dollars
        capturedAmountCents: p.captured_amount_cents ?? null,
        holdAmountCents: p.hold_amount_cents ?? null,
        status: p.status,
        paymentMethod: p.payment_method ?? null,
        stripePaymentIntentId: p.stripe_payment_intent_id ?? null,
        createdAt: p.created_at ?? p._creationTime,
      })),

      review: review ? { rating: review.rating, comment: review.comment ?? null } : null,
    };
  },
});
