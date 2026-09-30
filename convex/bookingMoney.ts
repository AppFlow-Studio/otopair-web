/**
 * bookingMoney.ts — loads the canonical money statement for a booking.
 *
 * The statement itself is built by the pure `buildBookingMoney`
 * (convex/lib/bookingMoney.ts — read its header for the invariants). This file
 * only does the reads, plus the two auth-scoped queries surfaces call directly.
 * Server readers (getJobDetail, getReceipt, the invoice/PDF, the card-hold
 * breakdown, the Timeline, capture) call `loadBookingMoney` so every one of
 * them renders the same numbers.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  buildBookingMoney,
  quoteResponsePartLines,
  type BookingMoney,
  type MoneyInputs,
} from "./lib/bookingMoney";

const QUOTE_STAGE_STATUSES = new Set(["pending_quote", "quotes_ready"]);

/** The accepted tire/rotor quote on a booking, when it is a quote booking. */
async function loadAcceptedQuote(
  ctx: any,
  booking: any,
  baseServices: MoneyInputs["baseServices"],
): Promise<MoneyInputs["quote"]> {
  if (!booking.tire_specs && !booking.rotor_specs) return null;
  if (QUOTE_STAGE_STATUSES.has(String(booking.status))) return null;
  for (const kind of ["tire", "rotor"] as const) {
    const table = kind === "tire" ? "tire_quote_responses" : "rotor_quote_responses";
    const rows = await ctx.db
      .query(table)
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .collect();
    // acceptTire/RotorQuote supersedes every sibling and leaves the accepted
    // response live, on the booking's (now chosen) shop.
    const accepted = rows.find(
      (r: any) =>
        r.superseded_at == null &&
        r.cancelled_at == null &&
        String(r.shop_id) === String(booking.shop_id),
    );
    if (!accepted) continue;
    const serviceId = booking.service_ids?.[0] ?? null;
    return {
      kind,
      laborCents: Math.round((accepted.labor_cost ?? 0) * 100),
      totalCents: Math.round((accepted.total ?? 0) * 100),
      durationMinutes: accepted.estimated_duration_minutes ?? null,
      serviceName:
        baseServices[0]?.name ??
        (kind === "tire" ? "Tire installation" : "Rotor installation"),
      partLines: quoteResponsePartLines({ kind, response: accepted, booking, serviceId }),
    };
  }
  return null;
}

/**
 * Build the money statement for a booking (doc or id). Null when the booking
 * doesn't exist. `estimateRateCents` sets the labor rate an estimate-basis
 * statement uses for minutes (the tier-aware rate, when the caller knows it).
 */
export async function loadBookingMoney(
  ctx: any,
  bookingOrId: any,
  opts: { estimateRateCents?: number | null } = {},
): Promise<BookingMoney | null> {
  const booking =
    typeof bookingOrId === "string" ? await ctx.db.get(bookingOrId) : bookingOrId;
  if (!booking) return null;
  const [approvals, customJobs, payments, shop] = await Promise.all([
    ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) => q.eq("booking_id", booking._id))
      .collect(),
    ctx.db
      .query("custom_jobs")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", booking._id))
      .collect(),
    ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
      .collect(),
    booking.shop_id ? ctx.db.get(booking.shop_id) : Promise.resolve(null),
  ]);
  const baseServices: MoneyInputs["baseServices"] = [];
  for (const sid of booking.service_ids ?? []) {
    const svc: any = await ctx.db.get(sid);
    if (!svc) continue;
    baseServices.push({
      serviceId: String(sid),
      name: svc.name ?? "Service",
      catalogHours:
        typeof svc.default_labor_hours === "number" ? svc.default_labor_hours : null,
    });
  }
  const quote = await loadAcceptedQuote(ctx, booking, baseServices);
  const flatRate =
    typeof (shop as any)?.labor_rate === "number"
      ? Math.round((shop as any).labor_rate * 100)
      : null;
  return buildBookingMoney({
    booking,
    approvals,
    customJobs,
    payments,
    shop,
    baseServices,
    quote,
    estimateRateCents: opts.estimateRateCents ?? flatRate,
  });
}

async function currentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
}

/** Shop side: members of the booking's shop and the shop owner (who often has
 *  no shop_users row) — the same viewers as getEffectiveQuoteForBooking. */
export const getForShop = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await currentUserOrNull(ctx);
    if (!user) return null;
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking?.shop_id) return null;
    const memberships = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();
    let allowed = memberships.some(
      (m: any) => m.is_active !== false && String(m.shop_id) === String(booking.shop_id),
    );
    if (!allowed) {
      const shop: any = await ctx.db.get(booking.shop_id as Id<"shops">);
      allowed = shop != null && String(shop.owner_user_id) === String(user._id);
    }
    if (!allowed) return null;
    return await loadBookingMoney(ctx, booking);
  },
});

/** Customer side: the booking's owner only. */
export const getForCustomer = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await currentUserOrNull(ctx);
    if (!user) return null;
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking || String(booking.user_id) !== String(user._id)) return null;
    return await loadBookingMoney(ctx, booking);
  },
});
