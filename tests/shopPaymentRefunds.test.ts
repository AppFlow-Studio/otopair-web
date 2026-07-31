/**
 * shopPaymentRefunds.test.ts
 *
 * Covers the money-critical paths of the shop-owner refund surface. These are
 * the checks that stop a wrong number reaching a customer's card, so they test
 * the guards directly (via the internal mutations) rather than through the
 * action, which would need a live Stripe.
 *
 * The headline regression is `_reconcileChargeRefund` with a partial amount:
 * before this work, any charge.refunded marked the payment fully refunded and
 * froze it in a terminal FSM state.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";
import {
  capturedCentsOrNull,
  assertIntegerCents,
  displayStatusFor,
  netToShopCents,
} from "../convex/lib/money";

type T = ReturnType<typeof makeT>;

const PI_ID = "pi_test_refund_1";
const CHARGE_ID = "ch_test_refund_1";

/** Shop + owner + mechanic-role user + customer + booking + captured payment. */
async function seedCapturedPayment(
  t: T,
  opts: {
    tag: string;
    capturedCents?: number | null;
    status?: string;
    paymentMethod?: string;
    withPi?: boolean;
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_refund_owner_${opts.tag}_${now}`;
    const mechClerkId = `clerk_refund_mech_${opts.tag}_${now}`;

    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: `${opts.tag}-owner@test.local`,
      first_name: "Olivia",
      last_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });
    const mechUserId = await ctx.db.insert("users", {
      clerkUserId: mechClerkId,
      email: `${opts.tag}-mech@test.local`,
      first_name: "Manny",
      last_name: "Mechanic",
      role: "shop_mechanic",
      createdAt: now,
    });
    const customerId = await ctx.db.insert("users", {
      clerkUserId: `clerk_refund_cust_${opts.tag}_${now}`,
      email: `${opts.tag}-cust@test.local`,
      first_name: "Casey",
      last_name: "Customer",
      role: "customer",
      createdAt: now,
    });

    const shopId = await ctx.db.insert("shops", {
      name: `Refund Shop ${opts.tag}`,
      owner_user_id: ownerId,
      is_active: true,
    });
    await ctx.db.insert("shop_users", {
      user_id: ownerId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    });
    // A mechanic membership — must NOT be able to move money.
    await ctx.db.insert("shop_users", {
      user_id: mechUserId,
      shop_id: shopId,
      role: "shop_mechanic",
      is_active: true,
    });

    const serviceId = await ctx.db.insert("services", { name: "Brake pads" });

    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Alice",
      last_name: "Wrench",
      is_active: true,
    });

    // vin is required on bookings (v.string()).
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
      total_cost: 180,
      labor_cost: 100,
      parts_cost: 80,
    } as any);

    const captured =
      opts.capturedCents === undefined ? 18_000 : opts.capturedCents;

    const paymentId = await ctx.db.insert("payments", {
      booking_id: bookingId,
      user_id: customerId,
      shop_id: shopId,
      // Deliberately DIFFERENT from captured: `amount` is the pre-job estimate
      // and nothing may fall back to it.
      amount: 250,
      payment_method: opts.paymentMethod ?? "card",
      status: opts.status ?? "completed",
      ...(opts.withPi === false ? {} : { stripe_payment_intent_id: PI_ID }),
      ...(captured == null ? {} : { captured_amount_cents: captured }),
      created_at: now,
      updated_at: now,
    });

    return {
      ownerClerkId,
      mechClerkId,
      ownerId,
      customerId,
      shopId,
      bookingId,
      paymentId,
    };
  });
}

describe("convex/lib/money", () => {
  test("capturedCentsOrNull never falls back to payments.amount", () => {
    // amount is the pre-job estimate. Falling back to it would report the quote
    // as revenue, which is exactly the delta the approval flow exists to create.
    expect(capturedCentsOrNull({ amount: 250 })).toBeNull();
    expect(capturedCentsOrNull({ amount: 250, captured_amount_cents: 18_000 })).toBe(
      18_000,
    );
    expect(capturedCentsOrNull({})).toBeNull();
  });

  test("assertIntegerCents rejects a dollars value passed as cents", () => {
    expect(() => assertIntegerCents(45.5, "Refund amount")).toThrow(/whole number/);
    expect(() => assertIntegerCents(4500, "Refund amount")).not.toThrow();
  });

  test("displayStatus derives partially_refunded without a new stored status", () => {
    expect(displayStatusFor({ status: "completed" })).toBe("captured");
    expect(
      displayStatusFor({ status: "completed", refunded_amount_cents: 4_000 }),
    ).toBe("partially_refunded");
    expect(displayStatusFor({ status: "refunded" })).toBe("refunded");
    expect(displayStatusFor({ status: "disputed" })).toBe("disputed");
  });

  test("netToShopCents credits back the prorated application fee", () => {
    // $180 captured, $12.60 fee, $40 refunded with $2.80 of fee returned.
    expect(
      netToShopCents({
        capturedCents: 18_000,
        platformFeeCents: 1_260,
        refundedCents: 4_000,
        applicationFeeRefundedCents: 280,
      }),
    ).toBe(18_000 - 1_260 - (4_000 - 280));
  });
});

describe("_reserveRefund gates", () => {
  test("clamps to the remaining refundable amount", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "clamp",
    });

    await expect(
      t.mutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: ownerClerkId,
        paymentId,
        amountCents: 20_000, // more than the 18_000 captured
        requestId: "req-over",
      }),
    ).rejects.toThrow(/at most \$180\.00/);
  });

  test("rejects a non-integer amount (dollars mistaken for cents)", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "float",
    });

    await expect(
      t.mutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: ownerClerkId,
        paymentId,
        amountCents: 45.5,
        requestId: "req-float",
      }),
    ).rejects.toThrow(/whole number of cents/);
  });

  test("a second refund cannot exceed the ceiling left by the first", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "ceiling",
    });

    const first = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      amountCents: 15_000,
      requestId: "req-1",
    });
    expect(first.outcome).toBe("reserved");

    // The ceiling comes from the payment_refunds rows, not from the
    // denormalized total — which _settleRefund has not written yet.
    await expect(
      t.mutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: ownerClerkId,
        paymentId,
        amountCents: 5_000,
        requestId: "req-2",
      }),
    ).rejects.toThrow(/at most \$30\.00/);
  });

  test("the same requestId returns the existing row instead of a second refund", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "idem",
    });

    const first = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      amountCents: 5_000,
      requestId: "same-request",
    });
    const second = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      amountCents: 5_000,
      requestId: "same-request",
    });

    expect(first.outcome).toBe("reserved");
    expect(second.outcome).toBe("already_settled");

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("payment_refunds")
        .withIndex("by_payment_id", (q) => q.eq("payment_id", paymentId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("a mechanic cannot refund", async () => {
    const t = makeT();
    const { mechClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "role",
    });

    await expect(
      t.mutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: mechClerkId,
        paymentId,
        requestId: "req-mech",
      }),
    ).rejects.toThrow(/Not authorized/);
  });

  test("rejects a cash payment", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "cash",
      paymentMethod: "cash",
      withPi: false,
    });

    await expect(
      t.mutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: ownerClerkId,
        paymentId,
        requestId: "req-cash",
      }),
    ).rejects.toThrow(/cash payment/i);
  });

  test("rejects a payment with an open dispute", async () => {
    const t = makeT();
    const seed = await seedCapturedPayment(t, { tag: "dispute" });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("payment_disputes", {
        payment_id: seed.paymentId,
        booking_id: seed.bookingId,
        shop_id: seed.shopId,
        stripe_dispute_id: "dp_open_1",
        amount_cents: 18_000,
        status: "needs_response",
        opened_at_ms: now,
        created_at: now,
        updated_at: now,
      });
    });

    await expect(
      t.mutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: seed.ownerClerkId,
        paymentId: seed.paymentId,
        requestId: "req-disputed",
      }),
    ).rejects.toThrow(/open dispute/i);
  });

  test("asks for capture reconciliation instead of guessing from amount", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "uncaptured",
      capturedCents: null,
    });

    const res = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      requestId: "req-uncaptured",
    });
    // Crucially NOT a reservation for round(250 * 100).
    expect(res.outcome).toBe("needs_capture_reconcile");
  });

  test("an uncapped refund takes exactly the remaining amount", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "rest",
    });

    await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      amountCents: 6_000,
      requestId: "req-a",
    });
    const rest = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      requestId: "req-b",
    });
    expect(rest.outcome).toBe("reserved");
    if (rest.outcome === "reserved") expect(rest.amountCents).toBe(12_000);
  });
});

describe("_settleRefund", () => {
  test("a partial refund leaves status completed and records the total", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "settle-partial",
    });

    const prep = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      amountCents: 4_000,
      requestId: "req-settle-partial",
    });
    if (prep.outcome !== "reserved") throw new Error("expected a reservation");

    await t.mutation(internal.shopPaymentRefunds._settleRefund, {
      refundRowId: prep.refundRowId,
      stripeRefundId: "re_partial_1",
      stripeStatus: "succeeded",
      stripeChargeId: CHARGE_ID,
    });

    const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
    expect(payment!.refunded_amount_cents).toBe(4_000);
    // The whole point: a partial does NOT move the row to the terminal state.
    expect(payment!.status).toBe("completed");
    expect(displayStatusFor(payment!)).toBe("partially_refunded");
  });

  test("refunding the remainder flips the row to refunded", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "settle-full",
    });

    for (const [amount, req, refundId] of [
      [4_000, "req-f1", "re_f1"],
      [14_000, "req-f2", "re_f2"],
    ] as const) {
      const prep = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: ownerClerkId,
        paymentId,
        amountCents: amount,
        requestId: req,
      });
      if (prep.outcome !== "reserved") throw new Error("expected a reservation");
      await t.mutation(internal.shopPaymentRefunds._settleRefund, {
        refundRowId: prep.refundRowId,
        stripeRefundId: refundId,
        stripeStatus: "succeeded",
      });
    }

    const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
    expect(payment!.refunded_amount_cents).toBe(18_000);
    expect(payment!.status).toBe("refunded");
  });

  test("recomputes rather than increments, so a replay cannot double-count", async () => {
    const t = makeT();
    const { ownerClerkId, paymentId } = await seedCapturedPayment(t, {
      tag: "replay",
    });

    const prep = await t.mutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: ownerClerkId,
      paymentId,
      amountCents: 5_000,
      requestId: "req-replay",
    });
    if (prep.outcome !== "reserved") throw new Error("expected a reservation");

    await t.mutation(internal.shopPaymentRefunds._settleRefund, {
      refundRowId: prep.refundRowId,
      stripeRefundId: "re_replay",
      stripeStatus: "succeeded",
    });
    await t.mutation(internal.shopPaymentRefunds._settleRefund, {
      refundRowId: prep.refundRowId,
      stripeRefundId: "re_replay",
      stripeStatus: "succeeded",
    });

    const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
    expect(payment!.refunded_amount_cents).toBe(5_000);
  });
});

describe("_reconcileChargeRefund", () => {
  /**
   * THE regression test. Before this change, any charge.refunded marked the
   * payment fully refunded — a $50 partial on a $180 job flipped the row to the
   * terminal "refunded" state, froze the FSM, and emailed the customer a
   * receipt saying the whole job had been refunded.
   */
  test("a partial charge.refunded leaves the payment completed", async () => {
    const t = makeT();
    const { paymentId } = await seedCapturedPayment(t, { tag: "wh-partial" });

    await t.mutation(internal.shopPaymentRefunds._reconcileChargeRefund, {
      stripeEventId: "evt_partial_1",
      eventType: "charge.refunded",
      stripePaymentIntentId: PI_ID,
      stripeChargeId: CHARGE_ID,
      amountRefundedCents: 5_000,
      amountCapturedCents: 18_000,
      fullyRefunded: false,
      refunds: [
        {
          id: "re_wh_1",
          amountCents: 5_000,
          status: "succeeded",
          reason: "requested_by_customer",
          createdMs: Date.now(),
        },
      ],
    });

    const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
    expect(payment!.status).toBe("completed");
    expect(payment!.refunded_amount_cents).toBe(5_000);
    expect(payment!.stripe_charge_id).toBe(CHARGE_ID);
  });

  test("a full charge.refunded does flip the payment to refunded", async () => {
    const t = makeT();
    const { paymentId } = await seedCapturedPayment(t, { tag: "wh-full" });

    await t.mutation(internal.shopPaymentRefunds._reconcileChargeRefund, {
      stripeEventId: "evt_full_1",
      eventType: "charge.refunded",
      stripePaymentIntentId: PI_ID,
      stripeChargeId: CHARGE_ID,
      amountRefundedCents: 18_000,
      amountCapturedCents: 18_000,
      fullyRefunded: true,
      refunds: [
        {
          id: "re_wh_full",
          amountCents: 18_000,
          status: "succeeded",
          reason: null,
          createdMs: Date.now(),
        },
      ],
    });

    const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
    expect(payment!.status).toBe("refunded");
    expect(payment!.refunded_amount_cents).toBe(18_000);
  });

  test("back-fills a refund issued from the Stripe dashboard", async () => {
    const t = makeT();
    const { paymentId } = await seedCapturedPayment(t, { tag: "wh-dash" });

    await t.mutation(internal.shopPaymentRefunds._reconcileChargeRefund, {
      stripeEventId: "evt_dash_1",
      eventType: "charge.refunded",
      stripePaymentIntentId: PI_ID,
      stripeChargeId: CHARGE_ID,
      amountRefundedCents: 2_500,
      amountCapturedCents: 18_000,
      fullyRefunded: false,
      refunds: [
        {
          id: "re_dash",
          amountCents: 2_500,
          status: "succeeded",
          reason: null,
          createdMs: Date.now(),
        },
      ],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("payment_refunds")
        .withIndex("by_payment_id", (q) => q.eq("payment_id", paymentId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("stripe_dashboard");
    expect(rows[0]!.requested_by_user_id).toBeUndefined();
  });

  test("charge.refund.updated downgrades a rejected refund and frees the ceiling", async () => {
    const t = makeT();
    const { paymentId } = await seedCapturedPayment(t, { tag: "wh-fail" });

    await t.mutation(internal.shopPaymentRefunds._reconcileChargeRefund, {
      stripeEventId: "evt_fail_a",
      eventType: "charge.refunded",
      stripePaymentIntentId: PI_ID,
      stripeChargeId: CHARGE_ID,
      amountRefundedCents: 6_000,
      amountCapturedCents: 18_000,
      fullyRefunded: false,
      refunds: [
        { id: "re_fail", amountCents: 6_000, status: "succeeded", reason: null, createdMs: 1 },
      ],
    });

    // The bank rejects it. Without a charge.refund.updated handler the total
    // would stay overstated forever.
    await t.mutation(internal.shopPaymentRefunds._reconcileChargeRefund, {
      stripeEventId: "evt_fail_b",
      eventType: "charge.refund.updated",
      stripePaymentIntentId: PI_ID,
      stripeChargeId: CHARGE_ID,
      amountRefundedCents: 0,
      amountCapturedCents: 18_000,
      fullyRefunded: false,
      refunds: [
        { id: "re_fail", amountCents: 6_000, status: "failed", reason: null, createdMs: 1 },
      ],
    });

    const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
    expect(payment!.refunded_amount_cents).toBe(0);
    expect(payment!.status).toBe("completed");
  });

  test("a replayed webhook event is a no-op", async () => {
    const t = makeT();
    const { paymentId } = await seedCapturedPayment(t, { tag: "wh-dupe" });

    const args = {
      stripeEventId: "evt_dupe_1",
      eventType: "charge.refunded",
      stripePaymentIntentId: PI_ID,
      stripeChargeId: CHARGE_ID,
      amountRefundedCents: 3_000,
      amountCapturedCents: 18_000,
      fullyRefunded: false,
      refunds: [
        { id: "re_dupe", amountCents: 3_000, status: "succeeded", reason: null, createdMs: 1 },
      ],
    };

    await t.mutation(internal.shopPaymentRefunds._reconcileChargeRefund, args);
    const second = await t.mutation(
      internal.shopPaymentRefunds._reconcileChargeRefund,
      args,
    );

    expect(second.status).toBe("duplicate");
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("payment_refunds")
        .withIndex("by_payment_id", (q) => q.eq("payment_id", paymentId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("shop payment reads", () => {
  test("listTransactions is scoped to the caller's own shop", async () => {
    const t = makeT();
    const a = await seedCapturedPayment(t, { tag: "scope-a" });
    await seedCapturedPayment(t, { tag: "scope-b" });

    const { api } = await import("../convex/_generated/api");
    const asOwnerA = t.withIdentity(identityFor(a.ownerClerkId));
    const res = await asOwnerA.query(api.shopPayments.listTransactions, {
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(res.page).toHaveLength(1);
    expect(String(res.page[0]!.id)).toBe(String(a.paymentId));
    // The estimate is exposed, but under a name that cannot be mistaken for
    // revenue, and captured is the real number.
    expect(res.page[0]!.estimateCents).toBe(25_000);
    expect(res.page[0]!.capturedCents).toBe(18_000);
  });

  test("insights skip uncaptured rows instead of falling back to the estimate", async () => {
    const t = makeT();
    const seed = await seedCapturedPayment(t, {
      tag: "insights",
      capturedCents: null,
    });

    const { api } = await import("../convex/_generated/api");
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));
    const insights = await asOwner.query(api.shopPayments.getPaymentInsights, {
      startMs: Date.now() - 7 * 86_400_000,
      endMs: Date.now() + 86_400_000,
    });

    expect(insights).not.toBeNull();
    expect(insights!.totals.capturedCents).toBe(0);
    expect(insights!.coverage.uncapturedRowsSkipped).toBe(1);
  });
});
