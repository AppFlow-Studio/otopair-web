/**
 * shopInvoices.test.ts — the merchant invoice.
 *
 * The property under test is provenance. The customer receipt (invoices.ts)
 * computes its platform fee as 7% of the total with no floor and then derives
 * "tax" as the remainder, which makes the tax line a plug that silently
 * absorbs any disagreement with Stripe. The merchant invoice must not do that:
 * money comes off the Charge, and any gap between the itemized lines and the
 * amount charged is reported as a gap.
 */

import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { internal } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

type T = ReturnType<typeof makeT>;

const PI_ID = "pi_inv_1";
const CHARGE_ID = "ch_inv_1";

async function seedInvoicePayment(
  t: T,
  tag: string,
  paymentOver: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_inv_owner_${tag}_${now}`;

    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: `${tag}-owner@test.local`,
      first_name: "Olivia",
      last_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });
    const customerId = await ctx.db.insert("users", {
      clerkUserId: `clerk_inv_cust_${tag}_${now}`,
      email: `${tag}-cust@test.local`,
      first_name: "Casey",
      last_name: "Customer",
      role: "customer",
      createdAt: now,
    });

    const shopId = await ctx.db.insert("shops", {
      name: "Cameron Auto Service",
      owner_user_id: ownerId,
      is_active: true,
      address: "1247 Hylan Blvd",
      city: "Staten Island",
      state: "NY",
      zip: "10305",
      phone: "(718) 555-0100",
    });
    await ctx.db.insert("shop_users", {
      user_id: ownerId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    });

    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Alice",
      last_name: "Wrench",
      is_active: true,
    });
    const serviceId = await ctx.db.insert("services", { name: "Brake pads" });

    const bookingId = await ctx.db.insert("bookings", {
      user_id: customerId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      vin: "1HGCM82633A004352",
      service_ids: [serviceId],
      scheduled_date: "2026-07-20",
      scheduled_time: "10:00",
      status: "completed",
      created_at: now,
      updated_at: now,
      // Itemized work: $80 parts + $100 labor = $180.
      quoted_breakdown: {
        parts_cents: 8_000,
        labor_cents: 10_000,
        tax_cents: 0,
        service_fee_cents: 0,
      },
      priced_parts_snapshot: [
        {
          service_id: serviceId,
          part_name: "Front brake pad set",
          brand: "Brembo",
          oem_number: "45022-T2A-A01",
          quantity: 1,
          unit_price_cents: 8_000,
          line_total_cents: 8_000,
        },
      ],
      estimated_labor_minutes: 90,
    } as any);

    const paymentId = await ctx.db.insert("payments", {
      booking_id: bookingId,
      user_id: customerId,
      shop_id: shopId,
      amount: 250, // the pre-job ESTIMATE — must never surface as money
      payment_method: "card",
      status: "completed",
      stripe_payment_intent_id: PI_ID,
      captured_amount_cents: 19_500, // $195 actually charged
      card_brand: "Visa",
      card_last4: "4242",
      invoice_number: "INV-2026-000123",
      created_at: now,
      updated_at: now,
      ...paymentOver,
    } as any);

    return { ownerClerkId, shopId, bookingId, paymentId };
  });
}

describe("merchant invoice", () => {
  test("itemizes the work and totals it separately from the amount charged", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "items");
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));

    const inv = await asOwner.query(api.shopInvoices.getShopInvoice, {
      paymentId: seed.paymentId,
    });

    expect(inv).not.toBeNull();
    expect(inv!.shop.name).toBe("Cameron Auto Service");
    expect(inv!.shop.address).toBe("1247 Hylan Blvd, Staten Island, NY, 10305");
    expect(inv!.customer.name).toBe("Casey Customer");
    expect(inv!.mechanicName).toBe("Alice Wrench");

    const kinds = inv!.lineItems.map((l) => l.kind);
    expect(kinds).toContain("part");
    expect(kinds).toContain("labor");
    // $80 parts + $100 labor
    expect(inv!.itemizedSubtotalCents).toBe(18_000);
    // $195 charged − $180 itemized = $15 unexplained by the line items.
    expect(inv!.reconciliationCents).toBe(1_500);
  });

  test("reports the gap instead of fabricating a tax line", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "recon");
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));

    const inv = await asOwner.query(api.shopInvoices.getShopInvoice, {
      paymentId: seed.paymentId,
    });
    // The customer receipt would have produced platformFee = 195 * 7% = 13.65
    // and then tax = 195 − 180 − 13.65 = 1.35, a number with no basis. The
    // merchant invoice leaves the fee unknown until Stripe says otherwise and
    // shows the whole 15.00 as a stated difference.
    expect(inv!.settlement.applicationFeeCents).toBeNull();
    expect(inv!.reconciliationCents).toBe(1_500);
    expect(inv!.settlement.source).toBe("convex");
  });

  test("never surfaces payments.amount as money", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "estimate");
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));

    const inv = await asOwner.query(api.shopInvoices.getShopInvoice, {
      paymentId: seed.paymentId,
    });
    // amount is 250 dollars = 25_000 cents. It must appear nowhere.
    expect(inv!.settlement.capturedCents).toBe(19_500);
    const allMoney = JSON.stringify(inv!.settlement) + JSON.stringify(inv!.lineItems);
    expect(allMoney).not.toContain("25000");
  });

  test("after a Stripe sync the fee and net come from the charge", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "synced");

    // What the webhook (or the sync action) writes off the Charge.
    await t.mutation(internal.shopInvoices._recordStripeSettlement, {
      paymentId: seed.paymentId,
      chargeId: CHARGE_ID,
      balanceTransactionId: "txn_1",
      applicationFeeCents: 1_365,
      processingFeeCents: 596,
      transferCents: 18_135, // what the connected account actually received
      capturedCents: 19_500,
      receiptUrl: "https://pay.stripe.com/receipts/abc",
      currency: "usd",
    });

    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));
    const inv = await asOwner.query(api.shopInvoices.getShopInvoice, {
      paymentId: seed.paymentId,
    });

    expect(inv!.settlement.source).toBe("stripe");
    expect(inv!.settlement.applicationFeeCents).toBe(1_365);
    expect(inv!.settlement.processingFeeCents).toBe(596);
    expect(inv!.settlement.chargeId).toBe(CHARGE_ID);
    expect(inv!.settlement.receiptUrl).toBe("https://pay.stripe.com/receipts/abc");
    expect(inv!.settlement.syncedAtMs).not.toBeNull();

    // Net is Stripe's transfer amount, not captured − fees. Stripe's
    // processing fee comes off the PLATFORM on a destination charge, so
    // subtracting it here would understate the shop's payout by $5.96.
    expect(inv!.settlement.netIsExact).toBe(true);
    expect(inv!.settlement.netToShopCents).toBe(18_135);
    expect(inv!.settlement.netToShopCents).not.toBe(19_500 - 1_365 - 596);
  });

  test("a refund reduces the net and is listed", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "refunded", {
      refunded_amount_cents: 4_000,
    });
    await t.mutation(internal.shopInvoices._recordStripeSettlement, {
      paymentId: seed.paymentId,
      chargeId: CHARGE_ID,
      applicationFeeCents: 1_365,
      transferCents: 18_135,
      capturedCents: 19_500,
      currency: "usd",
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("payment_refunds", {
        payment_id: seed.paymentId,
        booking_id: seed.bookingId,
        shop_id: seed.shopId,
        amount_cents: 4_000,
        status: "succeeded",
        reason: "service_issue",
        note: "Rear pads squeaked",
        requested_at_ms: now,
        settled_at_ms: now,
        idempotency_key: "k1",
        created_at: now,
        updated_at: now,
      });
    });

    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));
    const inv = await asOwner.query(api.shopInvoices.getShopInvoice, {
      paymentId: seed.paymentId,
    });

    expect(inv!.status).toBe("partially_refunded");
    expect(inv!.settlement.refundedCents).toBe(4_000);
    expect(inv!.settlement.netToShopCents).toBe(18_135 - 4_000);
    expect(inv!.refunds).toHaveLength(1);
    expect(inv!.refunds[0]!.note).toBe("Rear pads squeaked");
  });

  test("an uncaptured payment says so rather than showing zero", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "uncaptured", {
      captured_amount_cents: undefined,
      status: "pending",
    });
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));

    const inv = await asOwner.query(api.shopInvoices.getShopInvoice, {
      paymentId: seed.paymentId,
    });
    expect(inv!.status).toBe("uncaptured");
    expect(inv!.settlement.capturedCents).toBeNull();
    expect(inv!.settlement.netToShopCents).toBeNull();
    expect(inv!.reconciliationCents).toBeNull();
  });

  test("refuses a payment belonging to another shop", async () => {
    const t = makeT();
    const a = await seedInvoicePayment(t, "tenant-a");
    const b = await seedInvoicePayment(t, "tenant-b");

    const asOwnerA = t.withIdentity(identityFor(a.ownerClerkId));
    const leaked = await asOwnerA.query(api.shopInvoices.getShopInvoice, {
      paymentId: b.paymentId,
    });
    expect(leaked).toBeNull();
  });

  test("_settlementTarget rejects a non-owner", async () => {
    const t = makeT();
    const a = await seedInvoicePayment(t, "auth-a");
    const b = await seedInvoicePayment(t, "auth-b");

    await expect(
      t.query(internal.shopInvoices._settlementTarget, {
        paymentId: a.paymentId,
        clerkUserId: b.ownerClerkId,
      }),
    ).rejects.toThrow(/Not authorized/);
  });

  test("_settlementTarget falls back to the PaymentIntent when no charge id", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "pi-fallback");
    const res = await t.query(internal.shopInvoices._settlementTarget, {
      paymentId: seed.paymentId,
      clerkUserId: seed.ownerClerkId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.chargeId).toBeNull();
      expect(res.paymentIntentId).toBe(PI_ID);
    }
  });

  test("a cash payment is reported as unsyncable, not broken", async () => {
    const t = makeT();
    const seed = await seedInvoicePayment(t, "cash", {
      payment_method: "cash",
      stripe_payment_intent_id: undefined,
    });
    const res = await t.query(internal.shopInvoices._settlementTarget, {
      paymentId: seed.paymentId,
      clerkUserId: seed.ownerClerkId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cash payment/i);
  });
});
