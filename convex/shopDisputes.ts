/**
 * shopDisputes.ts — read-only dispute surface for the shop portal.
 *
 * `payment_disputes` was built for exactly this ("this table is the audit
 * trail the shop UI hydrates from", schema.ts) and has had no read query since
 * it landed — its by_shop_id index was unused.
 *
 * READ-ONLY IS STRUCTURAL: this module exports no mutation. Evidence
 * submission stays in the shop's Stripe Express dashboard, which already has
 * that flow built (file uploads, per-reason evidence fields, Stripe's own
 * deadline handling). The UI deep-links there via the existing
 * POST /api/stripe/connect/login route.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireShopViewerForPayments } from "./lib/shopAuth";
import { capturedCentsOrNull } from "./lib/money";
import { disputeReasonLabel } from "./shopPayments";
import {
  resolveServiceNames,
  resolveVehicleDisplay,
} from "./lib/bookingEnrichment";

const MAX_DISPUTES = 100;

export type ShopDisputeSummary = {
  id: Id<"payment_disputes">;
  paymentId: Id<"payments">;
  bookingId: Id<"bookings"> | null;
  stripeDisputeId: string;
  amountCents: number;
  currency: string;
  reason: string | null;
  reasonLabel: string;
  status: string;
  evidenceDueByMs: number | null;
  /** Negative once the deadline has passed. Null when Stripe set no deadline. */
  hoursUntilEvidenceDue: number | null;
  /** Still worth the owner's attention: needs a response and the clock hasn't run out. */
  isActionable: boolean;
  isOpen: boolean;
  openedAtMs: number;
  closedAtMs: number | null;
  customerName: string;
  vehicleYmm: string | null;
  serviceSummary: string | null;
  capturedCents: number | null;
};

export type ShopDisputeDetail = ShopDisputeSummary & {
  payment: {
    id: Id<"payments">;
    status: string;
    cardBrand: string | null;
    cardLast4: string | null;
    createdAtMs: number | null;
    invoiceNumber: string | null;
  };
  booking: {
    id: Id<"bookings">;
    status: string;
    scheduledDate: string | null;
    completedAtMs: number | null;
  } | null;
  /** Explicit so the UI never grows an in-app evidence form by accident. */
  evidenceSubmission: { supported: false; channel: "stripe_express" };
};

function userDisplayName(user: any): string {
  if (!user) return "Unknown";
  const name = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  return name || user.email || "Unknown";
}

/** Stripe dispute statuses that still want the shop to do something. */
const NEEDS_RESPONSE = new Set(["needs_response", "warning_needs_response"]);

async function hydrate(
  ctx: any,
  dispute: any,
  now: number,
): Promise<ShopDisputeSummary> {
  const payment = await ctx.db.get(dispute.payment_id);
  const booking = dispute.booking_id ? await ctx.db.get(dispute.booking_id) : null;
  const customer = payment ? await ctx.db.get(payment.user_id) : null;

  const vehicleYmm: string | null = booking?.vin
    ? (await resolveVehicleDisplay(ctx, booking.vin)).ymm
    : null;

  let serviceSummary: string | null = null;
  if (booking?.service_ids?.length) {
    const names = await resolveServiceNames(ctx, booking.service_ids.slice(0, 4));
    if (names.length === 1) serviceSummary = names[0];
    else if (names.length > 1) {
      serviceSummary = `${names[0]} +${booking.service_ids.length - 1} more`;
    }
  }

  const isOpen = dispute.closed_at_ms == null;
  const dueMs = dispute.evidence_due_by_ms ?? null;
  const hoursUntil = dueMs != null ? (dueMs - now) / 3_600_000 : null;

  return {
    id: dispute._id,
    paymentId: dispute.payment_id,
    bookingId: dispute.booking_id ?? null,
    stripeDisputeId: dispute.stripe_dispute_id,
    amountCents: dispute.amount_cents,
    currency: (dispute.currency ?? "usd").toLowerCase(),
    reason: dispute.reason ?? null,
    reasonLabel: disputeReasonLabel(dispute.reason),
    status: dispute.status,
    evidenceDueByMs: dueMs,
    hoursUntilEvidenceDue: hoursUntil,
    isActionable:
      isOpen && NEEDS_RESPONSE.has(dispute.status) && (hoursUntil == null || hoursUntil > 0),
    isOpen,
    openedAtMs: dispute.opened_at_ms,
    closedAtMs: dispute.closed_at_ms ?? null,
    customerName: userDisplayName(customer),
    vehicleYmm,
    serviceSummary,
    capturedCents: payment ? capturedCentsOrNull(payment) : null,
  };
}

export const listDisputes = query({
  args: {
    status: v.optional(
      v.union(v.literal("open"), v.literal("closed"), v.literal("all")),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ShopDisputeSummary[]> => {
    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return [];

    const cap = Math.min(args.limit ?? 50, MAX_DISPUTES);
    // Dispute volumes are low enough that _creationTime-desc within the shop
    // is fine; there is no created_at range to bound on here.
    const rows = await ctx.db
      .query("payment_disputes")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", viewer.shopId))
      .order("desc")
      .take(cap);

    const filter = args.status ?? "all";
    const selected = rows.filter((d: any) => {
      if (filter === "open") return d.closed_at_ms == null;
      if (filter === "closed") return d.closed_at_ms != null;
      return true;
    });

    const now = Date.now();
    const out = await Promise.all(selected.map((d: any) => hydrate(ctx, d, now)));
    return out.sort((a, b) => {
      // Actionable first, then soonest deadline, then newest.
      if (a.isActionable !== b.isActionable) return a.isActionable ? -1 : 1;
      const ad = a.evidenceDueByMs ?? Infinity;
      const bd = b.evidenceDueByMs ?? Infinity;
      if (ad !== bd) return ad - bd;
      return b.openedAtMs - a.openedAtMs;
    });
  },
});

export const getDisputeDetail = query({
  args: { disputeId: v.id("payment_disputes") },
  handler: async (ctx, args): Promise<ShopDisputeDetail | null> => {
    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return null;

    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) return null;
    if (String(dispute.shop_id ?? "") !== String(viewer.shopId)) return null;

    const summary = await hydrate(ctx, dispute, Date.now());
    const payment = await ctx.db.get(dispute.payment_id);
    const booking = dispute.booking_id ? await ctx.db.get(dispute.booking_id) : null;

    return {
      ...summary,
      payment: {
        id: dispute.payment_id,
        status: payment?.status ?? "unknown",
        cardBrand: payment?.card_brand ?? null,
        cardLast4: payment?.card_last4 ?? null,
        createdAtMs: payment?.created_at ?? null,
        invoiceNumber: payment?.invoice_number ?? null,
      },
      booking: booking
        ? {
            id: booking._id,
            status: booking.status,
            scheduledDate: booking.scheduled_date ?? null,
            completedAtMs: booking.completed_at_ms ?? null,
          }
        : null,
      evidenceSubmission: { supported: false, channel: "stripe_express" },
    };
  },
});
