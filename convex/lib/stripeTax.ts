/**
 * stripeTax.ts — Stripe Tax integration scaffolding.
 *
 * Charge-time tax math lives in `lib/tax.ts` (state-base + ZIP-3 metro
 * overrides + per-state service taxability rules). Stripe Tax adds two
 * things on top:
 *
 *   1. **Jurisdiction-accurate calculation** down to the city/special
 *      district level — better than our ZIP-3 metro table.
 *
 *   2. **Filing-of-record**: Stripe records each captured booking as a
 *      tax transaction in their dashboard, used for automated state
 *      sales-tax filings and audit trail.
 *
 * We do NOT change what the customer is charged. The local table sets
 * the price the user agrees to; Stripe Tax just records the captured
 * amount for filing. This avoids the "you saw $X but we charged $Y"
 * surprise that comes from letting Stripe Tax change the charge amount.
 *
 * ──────────────────────────────────────────────────────────────────────
 * SETUP REQUIRED before flipping STRIPE_TAX_ENABLED=true:
 *
 *   1. Stripe Dashboard → Tax → Registrations:
 *      Add a registration for every US state OtoPair has a tax nexus in.
 *      You only owe sales tax in states where you have a registration.
 *
 *   2. Stripe Dashboard → Tax → Settings:
 *      - Set the default Origin address to your business HQ.
 *      - Default tax behavior: "inclusive" (since our local table is the
 *        source of truth for what we charge).
 *
 *   3. Stripe Dashboard → Tax → Product tax codes (optional):
 *      Assign tax codes to your booking line items so Stripe knows what
 *      kind of service it's filing. Suggested: `txcd_20060035` for
 *      "Auto repair services — labor" and `txcd_99999999` for parts.
 *
 *   4. Set STRIPE_TAX_ENABLED=true in the Convex dashboard env.
 *
 * Until those four are done, this module no-ops cleanly.
 * ──────────────────────────────────────────────────────────────────────
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getStripe } from "../../lib/stripe";

const AUTO_REPAIR_LABOR_TAX_CODE = "txcd_20060035";
const PARTS_TAX_CODE = "txcd_99999999";
const STRIPE_TAX_REFERENCE_PREFIX = "otopair_booking_";

export function isStripeTaxEnabled(): boolean {
  return process.env.STRIPE_TAX_ENABLED === "true";
}

/**
 * Records a captured booking as a tax transaction in Stripe for filing.
 * Idempotent — Stripe rejects duplicate calculations on the same
 * reference, so retries are safe.
 *
 * Called from the `payment_intent.succeeded` webhook path. No-ops when
 * STRIPE_TAX_ENABLED isn't set, so this is safe to leave in place.
 */
export const recordTaxTransactionForBooking = (internalAction as any)({
  args: { bookingId: v.id("bookings"), paymentId: v.id("payments") },
  handler: async (
    ctx: any,
    args: { bookingId: any; paymentId: any },
  ): Promise<{
    ok: boolean;
    reason?: string;
    calculationId?: string;
    transactionId?: string;
  }> => {
    if (!isStripeTaxEnabled()) {
      return { ok: false, reason: "STRIPE_TAX_ENABLED is not set" };
    }

    const booking: any = await ctx.runQuery(
      (internal as any).payments_stripe._getBookingForPayment,
      { bookingId: args.bookingId },
    );
    if (!booking?.booking) {
      return { ok: false, reason: "booking not found" };
    }
    const { booking: b, shop } = booking;
    if (!shop?.state) {
      return { ok: false, reason: "shop has no state — cannot file tax" };
    }

    const labor = Math.round((b.labor_cost ?? 0) * 100);
    const parts = Math.round((b.parts_cost ?? 0) * 100);
    if (labor + parts <= 0) {
      return { ok: false, reason: "zero subtotal" };
    }

    const stripe = getStripe();
    const reference = `${STRIPE_TAX_REFERENCE_PREFIX}${args.bookingId}`;

    // ── Stripe Tax: calculation (preview) ──────────────────────────────
    // The shop's address is the "tax nexus" for in-shop service work.
    // We provide both customer + line item addresses pointing at the
    // shop so Stripe files against the correct jurisdiction.
    const calculation = await stripe.tax.calculations.create(
      {
        currency: "usd",
        line_items: [
          {
            amount: labor,
            reference: `${reference}_labor`,
            tax_code: AUTO_REPAIR_LABOR_TAX_CODE,
            tax_behavior: "inclusive",
          },
          {
            amount: parts,
            reference: `${reference}_parts`,
            tax_code: PARTS_TAX_CODE,
            tax_behavior: "inclusive",
          },
        ],
        customer_details: {
          address: {
            line1: shop.address ?? "",
            city: shop.city ?? "",
            state: shop.state,
            postal_code: shop.zip ?? "",
            country: "US",
          },
          address_source: "shipping",
        },
      },
      { idempotencyKey: `${reference}_calc` },
    );

    if (!calculation.id) {
      return { ok: false, reason: "calculation has no id" };
    }

    // ── Stripe Tax: transaction (commit for filing) ────────────────────
    const txn = await stripe.tax.transactions.createFromCalculation(
      {
        calculation: calculation.id,
        reference,
      },
      { idempotencyKey: `${reference}_txn` },
    );

    return {
      ok: true,
      calculationId: calculation.id,
      transactionId: txn.id ?? undefined,
    };
  },
});
