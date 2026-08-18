/**
 * shopInvoices.ts — the merchant-facing itemized invoice.
 *
 * WHY THIS EXISTS SEPARATELY FROM invoices.ts
 *
 * invoices.ts builds the CUSTOMER's receipt, and its money is computed, not
 * observed. Two consequences make it unusable as a merchant document:
 *
 *   1. It charges the platform fee at 7% of the TOTAL with no floor
 *      (PLATFORM_FEE_BPS), while finalizeAndChargeForBooking actually hands
 *      Stripe max(subtotal × 7%, $4.99) as application_fee_amount. On a small
 *      ticket those are different numbers.
 *   2. It then derives tax as `total − subtotal − platformFee` — the remainder
 *      after the other two. That is a plug, not a tax, and it silently absorbs
 *      any disagreement between our arithmetic and Stripe's.
 *
 * So this module splits the document in two, by provenance:
 *
 *   LINE ITEMS come from Convex, because Stripe has no idea what a brake pad
 *   is. They describe the work.
 *
 *   MONEY comes from Stripe — the Charge, its balance transaction, its
 *   application fee and its transfer. It describes what actually moved.
 *
 * Where those two disagree the invoice reports the difference as an explicit
 * reconciliation line instead of hiding it in a fabricated tax figure.
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import Stripe from "stripe";
import { capturedCentsOrNull } from "./lib/money";
import { requireShopOwnerBySubject, requireShopViewerForPayments } from "./lib/shopAuth";
import { resolveServiceNames, resolveVehicleDisplay } from "./lib/bookingEnrichment";

const STRIPE_API_VERSION = Stripe.API_VERSION;
let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("Missing STRIPE_SECRET_KEY.");
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  }
  return stripeClient;
}

/* ------------------------------------------------------------------ */
/*  Settlement capture                                                 */
/* ------------------------------------------------------------------ */

/**
 * Writes what Stripe actually moved onto the payments row.
 *
 * Called from the payment_intent.succeeded webhook (which already retrieves
 * the charge for card brand/last4, so the expansions below cost nothing extra)
 * and from the on-demand sync action.
 */
export const _recordStripeSettlement = internalMutation({
  args: {
    paymentId: v.optional(v.id("payments")),
    stripePaymentIntentId: v.optional(v.string()),
    chargeId: v.string(),
    balanceTransactionId: v.optional(v.string()),
    applicationFeeCents: v.optional(v.number()),
    processingFeeCents: v.optional(v.number()),
    transferCents: v.optional(v.number()),
    capturedCents: v.optional(v.number()),
    receiptUrl: v.optional(v.string()),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    let payment = args.paymentId ? await ctx.db.get(args.paymentId) : null;
    if (!payment && args.stripePaymentIntentId) {
      payment = await ctx.db
        .query("payments")
        .withIndex("by_stripe_payment_intent_id", (q) =>
          q.eq("stripe_payment_intent_id", args.stripePaymentIntentId),
        )
        .unique();
    }
    if (!payment) return { status: "no_payment" };

    await ctx.db.patch(payment._id, {
      stripe_charge_id: args.chargeId,
      ...(args.balanceTransactionId
        ? { stripe_balance_transaction_id: args.balanceTransactionId }
        : {}),
      ...(args.applicationFeeCents != null
        ? { stripe_application_fee_cents: args.applicationFeeCents }
        : {}),
      ...(args.processingFeeCents != null
        ? { stripe_processing_fee_cents: args.processingFeeCents }
        : {}),
      ...(args.transferCents != null
        ? { stripe_transfer_cents: args.transferCents }
        : {}),
      // Stripe is authoritative over our own capture bookkeeping.
      ...(args.capturedCents != null
        ? { captured_amount_cents: args.capturedCents }
        : {}),
      ...(args.receiptUrl ? { stripe_receipt_url: args.receiptUrl } : {}),
      ...(args.currency ? { stripe_settlement_currency: args.currency } : {}),
      stripe_settlement_synced_at_ms: Date.now(),
      updated_at: Date.now(),
    });

    return { status: "recorded" };
  },
});

/**
 * Pulls settlement for one payment on demand.
 *
 * Needed because rows charged before this existed have no settlement, and
 * because a merchant looking at an invoice should be able to force a refresh
 * rather than wonder whether the numbers are stale.
 */
export const syncStripeSettlement = action({
  args: { paymentId: v.id("payments") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const ref = await ctx.runQuery(internal.shopInvoices._settlementTarget, {
      paymentId: args.paymentId,
      clerkUserId: identity.subject,
    });
    if (!ref.ok) return { ok: false, reason: ref.reason };

    const stripe = getStripe();

    // Rows charged before settlement capture existed have a PaymentIntent but
    // no charge id — resolve it here rather than leaving them permanently
    // unsyncable.
    let chargeId = ref.chargeId;
    if (!chargeId && ref.paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(ref.paymentIntentId);
      chargeId =
        typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge?.id ?? null);
    }
    if (!chargeId) {
      return { ok: false, reason: "Stripe has no charge for this payment yet." };
    }

    const charge = await stripe.charges.retrieve(chargeId, {
      expand: ["balance_transaction", "transfer"],
    });

    const bt =
      charge.balance_transaction && typeof charge.balance_transaction !== "string"
        ? charge.balance_transaction
        : null;
    const transfer =
      charge.transfer && typeof charge.transfer !== "string" ? charge.transfer : null;

    await ctx.runMutation(internal.shopInvoices._recordStripeSettlement, {
      paymentId: args.paymentId,
      chargeId: charge.id,
      balanceTransactionId: bt?.id,
      applicationFeeCents: charge.application_fee_amount ?? undefined,
      processingFeeCents: bt?.fee ?? undefined,
      transferCents: transfer?.amount ?? undefined,
      capturedCents: charge.amount_captured ?? undefined,
      receiptUrl: charge.receipt_url ?? undefined,
      currency: charge.currency ?? undefined,
    });

    return { ok: true };
  },
});

/**
 * Authorization plus whatever Stripe handle we already hold.
 *
 * Returns the charge id when we have one, otherwise the PaymentIntent so the
 * action can resolve the charge itself — a row charged before settlement
 * capture existed has a PI but no charge id.
 */
export const _settlementTarget = internalQuery({
  args: { paymentId: v.id("payments"), clerkUserId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; chargeId: string | null; paymentIntentId: string | null }
    | { ok: false; reason: string }
  > => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment) return { ok: false, reason: "Payment not found." };
    // Throws for anyone who isn't an owner of this payment's shop.
    await requireShopOwnerBySubject(ctx, args.clerkUserId, payment.shop_id);

    const piId =
      payment.reauth_payment_intent_id ?? payment.stripe_payment_intent_id ?? null;

    if (!payment.stripe_charge_id && !piId) {
      return {
        ok: false,
        reason:
          payment.payment_method === "cash"
            ? "This was a cash payment — there's nothing in Stripe to sync."
            : "This payment never reached Stripe.",
      };
    }
    return {
      ok: true,
      chargeId: payment.stripe_charge_id ?? null,
      paymentIntentId: piId,
    };
  },
});

/* ------------------------------------------------------------------ */
/*  The merchant invoice                                               */
/* ------------------------------------------------------------------ */

export type InvoiceLineItem = {
  kind: "part" | "labor" | "service";
  name: string;
  detail: string | null;
  qty: number | null;
  unitCents: number | null;
  lineCents: number;
};

/** Where a money figure came from. Rendered on the invoice, because a merchant
 *  reconciling against a bank statement needs to know which numbers are
 *  Stripe's and which are ours. */
export type MoneySource = "stripe" | "convex" | "unavailable";

export type ShopInvoice = {
  paymentId: Id<"payments">;
  bookingId: Id<"bookings">;
  invoiceNumber: string | null;
  issuedAtMs: number | null;
  status: "paid" | "partially_refunded" | "refunded" | "uncaptured" | "other";

  shop: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    logoUrl: string | null;
  };
  customer: { name: string; email: string | null; phone: string | null };
  vehicle: { ymm: string | null; vin: string | null };
  mechanicName: string | null;
  services: string[];
  scheduledDate: string | null;
  completedAtMs: number | null;

  /** The work, from Convex. Stripe has no idea what a brake pad is. */
  lineItems: InvoiceLineItem[];
  itemizedSubtotalCents: number;

  /** The money, from Stripe. */
  settlement: {
    source: MoneySource;
    syncedAtMs: number | null;
    currency: string;
    capturedCents: number | null;
    applicationFeeCents: number | null;
    processingFeeCents: number | null;
    transferToShopCents: number | null;
    refundedCents: number;
    /** What the shop actually keeps. Prefers Stripe's transfer amount over any
     *  arithmetic of ours; falls back to captured − fee when unsynced. */
    netToShopCents: number | null;
    netIsExact: boolean;
    cardBrand: string | null;
    cardLast4: string | null;
    method: string;
    chargeId: string | null;
    receiptUrl: string | null;
  };

  /**
   * itemized − captured. Non-zero means the line items don't add up to what
   * was charged (tax, a mid-job adjustment, a mechanic override). Surfaced as
   * its own line rather than folded into a fabricated tax figure the way the
   * customer receipt does.
   */
  reconciliationCents: number | null;

  refunds: {
    amountCents: number;
    reason: string | null;
    note: string | null;
    settledAtMs: number | null;
  }[];
};

export const getShopInvoice = query({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args): Promise<ShopInvoice | null> => {
    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return null;

    const payment = await ctx.db.get(args.paymentId);
    if (!payment) return null;
    if (String(payment.shop_id) !== String(viewer.shopId)) return null;

    const shop = viewer.shop;
    const booking = await ctx.db.get(payment.booking_id);
    const customer = await ctx.db.get(payment.user_id);
    const mechanic = booking?.mechanic_id
      ? await ctx.db.get(booking.mechanic_id)
      : null;

    const services = booking?.service_ids
      ? await resolveServiceNames(ctx, booking.service_ids, booking.custom_services)
      : [];
    const vehicle = booking?.vin
      ? await resolveVehicleDisplay(ctx, booking.vin)
      : null;

    const jobActual = booking
      ? await ctx.db
          .query("job_actuals")
          .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
          .first()
      : null;

    // Authoritative agreed breakdown — the frozen parts/labor on the last agreed
    // booking_approvals row (same row getReceipt bills from). When the mechanic
    // re-quoted (Adjust quote / Add unforeseen scope), the original estimate in
    // priced_parts_snapshot + quoted_breakdown is stale; the approval row holds
    // the customer-approved parts and labor.
    const finalApproval = booking
      ? ((
          await ctx.db
            .query("booking_approvals")
            .withIndex("by_booking_and_cycle", (q: any) =>
              q.eq("booking_id", booking._id),
            )
            .collect()
        )
          .filter(
            (a: any) =>
              a.parts_subtotal_cents != null &&
              a.labor_cents != null &&
              a.tax_cents != null &&
              a.service_fee_cents != null &&
              a.decision !== "declined" &&
              a.decision !== "withdrawn",
          )
          .sort((a: any, b: any) => {
            const rank: Record<string, number> = { pre_job: 1, mid_job: 2, post_job: 3 };
            const byCycle = (rank[a.cycle] ?? 0) - (rank[b.cycle] ?? 0);
            if (byCycle !== 0) return byCycle;
            return (
              (a.submitted_at_ms ?? a._creationTime) -
              (b.submitted_at_ms ?? b._creationTime)
            );
          })
          .at(-1) ?? null)
      : null;

    /* ---- line items: the work ---- */
    const lineItems: InvoiceLineItem[] = [];
    // Prefer the approved re-quote's parts (mechanic's confirmed prices, with
    // Not-used / customer-supplied rows dropped) over the original estimate.
    // `cost` on the approval snapshot is per-unit dollars.
    const approvedParts: any[] | null = Array.isArray(
      (finalApproval as any)?.parts_snapshot,
    )
      ? ((finalApproval as any).parts_snapshot as any[])
      : null;
    if (approvedParts) {
      for (const p of approvedParts) {
        if (p?.not_used === true || p?.supplied_by === "customer") continue;
        const qty = Math.max(0, Number(p.quantity ?? 1));
        const unit = Math.round((Number(p.cost) || 0) * 100);
        const notes = [p.brand, p.oem_number].filter(Boolean);
        lineItems.push({
          kind: "part",
          name: p.part_name ?? "Part",
          detail: notes.join(" · ") || null,
          qty,
          unitCents: unit,
          lineCents: unit * qty,
        });
      }
    } else {
      const snapshot: any[] = Array.isArray(booking?.priced_parts_snapshot)
        ? booking!.priced_parts_snapshot
        : [];
      for (const p of snapshot) {
        const qty = Number(p.quantity ?? 1);
        const unit = Number(p.unit_price_cents ?? 0);
        const line = Number(p.line_total_cents ?? unit * qty);
        // A $0 part line on an invoice needs an explanation. price_unknown means
        // the winner had no trustworthy price at quote time and the line bills 0
        // pending post-job confirmation; integrity_flag means the frozen row
        // failed the make guard. Both are things a merchant would otherwise have
        // to ask about.
        const notes = [
          p.brand,
          p.oem_number,
          p.price_unknown ? "priced at completion" : null,
          p.price_stale ? "price estimate" : null,
          p.integrity_flag ? `flagged: ${p.integrity_flag}` : null,
        ].filter(Boolean);
        lineItems.push({
          kind: "part",
          name: p.part_name ?? "Part",
          detail: notes.join(" · ") || null,
          qty,
          unitCents: unit,
          lineCents: line,
        });
      }
    }

    const laborCents =
      (finalApproval as any)?.labor_cents ??
      booking?.quoted_breakdown?.labor_cents ??
      null;
    const laborMinutes =
      jobActual?.actual_labor_minutes ?? booking?.estimated_labor_minutes ?? null;
    if (laborCents != null) {
      lineItems.push({
        kind: "labor",
        name: "Labor",
        detail:
          laborMinutes != null
            ? `${Math.floor(laborMinutes / 60)}h ${laborMinutes % 60}m`
            : null,
        qty: null,
        unitCents: null,
        lineCents: laborCents,
      });
    }
    // Nothing itemized — fall back to naming the services so the invoice isn't
    // a blank page with a total at the bottom.
    if (lineItems.length === 0 && services.length > 0) {
      const captured = capturedCentsOrNull(payment);
      for (const s of services) {
        lineItems.push({
          kind: "service",
          name: s,
          detail: services.length > 1 ? "Itemized pricing not recorded" : null,
          qty: null,
          unitCents: null,
          lineCents: services.length === 1 ? (captured ?? 0) : 0,
        });
      }
    }
    const itemizedSubtotalCents = lineItems.reduce((s, l) => s + l.lineCents, 0);

    /* ---- settlement: the money ---- */
    const refundRows = await ctx.db
      .query("payment_refunds")
      .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
      .take(50);
    const refundedCents = payment.refunded_amount_cents ?? 0;

    const synced = payment.stripe_settlement_synced_at_ms ?? null;
    const captured = capturedCentsOrNull(payment);
    const appFee = payment.stripe_application_fee_cents ?? null;
    const transfer = payment.stripe_transfer_cents ?? null;

    // Stripe's transfer amount IS what the shop got — no arithmetic needed.
    // Without it, fall back to captured − application fee and say the number
    // is derived rather than observed.
    const netExact = transfer != null;
    const netToShopCents = netExact
      ? transfer - refundedCents
      : captured != null && appFee != null
        ? captured - appFee - refundedCents
        : null;

    const source: MoneySource =
      synced != null ? "stripe" : captured != null ? "convex" : "unavailable";

    const status: ShopInvoice["status"] =
      captured == null
        ? "uncaptured"
        : payment.status === "refunded" || (captured > 0 && refundedCents >= captured)
          ? "refunded"
          : refundedCents > 0
            ? "partially_refunded"
            : payment.status === "completed"
              ? "paid"
              : "other";

    return {
      paymentId: payment._id,
      bookingId: payment.booking_id,
      invoiceNumber: payment.invoice_number ?? null,
      issuedAtMs: payment.created_at ?? null,
      status,

      shop: {
        name: shop.name ?? "Your shop",
        address:
          [shop.address, shop.city, shop.state, shop.zip]
            .filter(Boolean)
            .join(", ") || null,
        phone: shop.phone ?? null,
        email: shop.email ?? null,
        website: shop.website ?? null,
        logoUrl: shop.logo_storage_id
          ? await ctx.storage.getUrl(shop.logo_storage_id)
          : null,
      },
      customer: {
        name:
          `${(customer as any)?.first_name ?? ""} ${(customer as any)?.last_name ?? ""}`.trim() ||
          (customer as any)?.email ||
          "Customer",
        email: (customer as any)?.email ?? null,
        phone: (customer as any)?.phone ?? null,
      },
      vehicle: { ymm: vehicle?.ymm ?? null, vin: booking?.vin ?? null },
      mechanicName: mechanic
        ? `${(mechanic as any).first_name ?? ""} ${(mechanic as any).last_name ?? ""}`.trim() ||
          null
        : null,
      services,
      scheduledDate: booking?.scheduled_date ?? null,
      completedAtMs: booking?.completed_at_ms ?? null,

      lineItems,
      itemizedSubtotalCents,

      settlement: {
        source,
        syncedAtMs: synced,
        currency: (payment.stripe_settlement_currency ?? "usd").toUpperCase(),
        capturedCents: captured,
        applicationFeeCents: appFee,
        processingFeeCents: payment.stripe_processing_fee_cents ?? null,
        transferToShopCents: transfer,
        refundedCents,
        netToShopCents,
        netIsExact: netExact,
        cardBrand: payment.card_brand ?? null,
        cardLast4: payment.card_last4 ?? null,
        method: payment.payment_method ?? "card",
        chargeId: payment.stripe_charge_id ?? null,
        receiptUrl: payment.stripe_receipt_url ?? null,
      },

      reconciliationCents:
        captured != null && itemizedSubtotalCents > 0
          ? captured - itemizedSubtotalCents
          : null,

      refunds: refundRows
        .filter((r: any) => r.status === "succeeded" || r.status === "pending")
        .map((r: any) => ({
          amountCents: r.amount_cents,
          reason: r.reason ?? null,
          note: r.note ?? null,
          settledAtMs: r.settled_at_ms ?? r.requested_at_ms ?? null,
        }))
        .sort((a, b) => (a.settledAtMs ?? 0) - (b.settledAtMs ?? 0)),
    };
  },
});
