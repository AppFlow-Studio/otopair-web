/**
 * "Is this still the price the customer agreed to?" (#390, customer side).
 *
 * Tire Rotation was shown at $85; the shop changed it to $150 while the
 * customer sat on Review & Pay, and createBatch committed $150 silently — it
 * prices from live rows and never compared against what was displayed. New
 * builds send `expected_price`; a shop-priced line that moved (or switched
 * basis) now rejects with PRICE_CHANGED carrying before/after. No
 * `expected_price` (builds in the field) books exactly as before.
 *
 * Same contract on estimate approvals: approving whichever open estimate is
 * newest let a withdraw-and-resubmit approve a total the customer never saw.
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  approvalDecisionConflict,
  buildServerCheckoutLines,
  diffCheckoutPrice,
  laborToleranceCents,
  priceChangedMessage,
  type ExpectedCheckoutPrice,
  type ServerCheckoutLine,
} from "../convex/lib/checkoutPrice";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────
// Pure diff
// ─────────────────────────────────────────────────────────────────────────

const S1 = "svc_rotation";
const S2 = "svc_brakes";

function expected(lines: ExpectedCheckoutPrice["lines"]): ExpectedCheckoutPrice {
  return { version: 1, lines, total_low_cents: 9_600, total_high_cents: 9_600 };
}

function line(partial: Partial<ServerCheckoutLine> & { serviceId: string }): ServerCheckoutLine {
  return {
    shopPrice: null,
    billedLaborCents: 0,
    billedPartsCents: 0,
    engineLaborCents: null,
    engineLowCents: null,
    engineHighCents: null,
    ...partial,
  };
}

describe("diffCheckoutPrice", () => {
  test("shop price unchanged → no diff", () => {
    const changes = diffCheckoutPrice(
      expected([{ service_id: S1 as any, basis: "shop_price", low_cents: 8_500, high_cents: 8_500 }]),
      [line({ serviceId: S1, shopPrice: { lowCents: 8_500, highCents: 8_500 } })],
    );
    expect(changes).toEqual([]);
  });

  test("shop price moved by a cent → changed (exact compare)", () => {
    const changes = diffCheckoutPrice(
      expected([{ service_id: S1 as any, basis: "shop_price", low_cents: 8_500, high_cents: 8_500 }]),
      [line({ serviceId: S1, shopPrice: { lowCents: 8_501, highCents: 8_501 } })],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      reason: "shop_price_changed",
      before: { basis: "shop_price", lowCents: 8_500, highCents: 8_500 },
      after: { basis: "shop_price", lowCents: 8_501, highCents: 8_501 },
    });
  });

  test("shop range endpoints compared independently", () => {
    const changes = diffCheckoutPrice(
      expected([{ service_id: S1 as any, basis: "shop_price", low_cents: 10_000, high_cents: 15_000 }]),
      [line({ serviceId: S1, shopPrice: { lowCents: 10_000, highCents: 17_500 } })],
    );
    expect(changes.map((c) => c.reason)).toEqual(["shop_price_changed"]);
  });

  test("shop price shown, removed at commit → changed, after is the estimate", () => {
    const changes = diffCheckoutPrice(
      expected([{ service_id: S1 as any, basis: "shop_price", low_cents: 8_500, high_cents: 8_500 }]),
      [
        line({
          serviceId: S1,
          engineLaborCents: 6_000,
          engineLowCents: 9_000,
          engineHighCents: 12_000,
        }),
      ],
    );
    expect(changes[0]).toMatchObject({
      reason: "shop_price_removed",
      after: { basis: "estimate", lowCents: 9_000, highCents: 12_000, laborCents: 6_000 },
    });
  });

  test("estimate shown, now shop-priced → changed", () => {
    const changes = diffCheckoutPrice(
      expected([
        { service_id: S1 as any, basis: "estimate", low_cents: 7_000, high_cents: 9_000, labor_cents: 5_000 },
      ]),
      [line({ serviceId: S1, shopPrice: { lowCents: 15_000, highCents: 15_000 } })],
    );
    expect(changes[0]).toMatchObject({
      reason: "now_shop_priced",
      before: { basis: "estimate", lowCents: 7_000, highCents: 9_000, laborCents: 5_000 },
      after: { basis: "shop_price", lowCents: 15_000, highCents: 15_000 },
    });
  });

  test("estimate labor within max(8%, $1) → no diff; beyond → changed", () => {
    const shown = expected([
      { service_id: S1 as any, basis: "estimate", low_cents: 20_000, high_cents: 26_000, labor_cents: 20_000 },
    ]);
    // 8% of $200 = $16 → $215.99 is inside.
    expect(
      diffCheckoutPrice(shown, [
        line({ serviceId: S1, engineLaborCents: 21_599, billedLaborCents: 20_000 }),
      ]),
    ).toEqual([]);
    const changes = diffCheckoutPrice(shown, [
      line({ serviceId: S1, engineLaborCents: 24_000, billedLaborCents: 20_000 }),
    ]);
    expect(changes[0]).toMatchObject({
      reason: "labor_changed",
      before: { laborCents: 20_000 },
      after: { basis: "estimate", laborCents: 24_000, lowCents: 24_000, highCents: 30_000 },
    });
  });

  test("small labor line gets the $1 floor", () => {
    expect(laborToleranceCents(500)).toBe(100);
    expect(laborToleranceCents(50_000)).toBe(4_000);
    const shown = expected([
      { service_id: S1 as any, basis: "estimate", low_cents: 500, high_cents: 500, labor_cents: 500 },
    ]);
    expect(diffCheckoutPrice(shown, [line({ serviceId: S1, engineLaborCents: 590, billedLaborCents: 500 })])).toEqual([]);
  });

  test("estimate parts and totals are never hard-compared", () => {
    const shown: ExpectedCheckoutPrice = {
      version: 1,
      lines: [
        { service_id: S1 as any, basis: "estimate", low_cents: 1_000, high_cents: 2_000, labor_cents: 10_000 },
      ],
      total_low_cents: 1,
      total_high_cents: 2,
    };
    expect(
      diffCheckoutPrice(shown, [
        line({
          serviceId: S1,
          engineLaborCents: 10_000,
          billedLaborCents: 10_000,
          billedPartsCents: 99_999,
          engineLowCents: 90_000,
          engineHighCents: 120_000,
        }),
      ]),
    ).toEqual([]);
  });

  test("estimate without labor_cents is not checked", () => {
    const shown = expected([{ service_id: S1 as any, basis: "estimate", low_cents: 1, high_cents: 2 }]);
    expect(diffCheckoutPrice(shown, [line({ serviceId: S1, engineLaborCents: 90_000 })])).toEqual([]);
  });

  test("lines the booking doesn't carry are skipped", () => {
    const shown = expected([
      { service_id: S2 as any, basis: "shop_price", low_cents: 8_500, high_cents: 8_500 },
    ]);
    expect(diffCheckoutPrice(shown, [line({ serviceId: S1 })])).toEqual([]);
  });

  test("buildServerCheckoutLines projects fixed lines + engine quotes in order", () => {
    const lines = buildServerCheckoutLines({
      services: [
        { service_id: S1, labor_cost: 0, parts_cost: 0 },
        { service_id: S2, labor_cost: 120.5, parts_cost: 80 },
      ],
      fixedPriceLines: [{ service_id: S1, price_low_cents: 15_000, price_high_cents: 15_000 }],
      engineQuotes: [
        { ok: true, low: 150, high: 150, labor: { cost: 0 } },
        { ok: true, low: 190, high: 260, labor: { cost: 120.5 } },
      ],
    });
    expect(lines).toEqual([
      {
        serviceId: S1,
        shopPrice: { lowCents: 15_000, highCents: 15_000 },
        billedLaborCents: 0,
        billedPartsCents: 0,
        engineLaborCents: 0,
        engineLowCents: 15_000,
        engineHighCents: 15_000,
      },
      {
        serviceId: S2,
        shopPrice: null,
        billedLaborCents: 12_050,
        billedPartsCents: 8_000,
        engineLaborCents: 12_050,
        engineLowCents: 19_000,
        engineHighCents: 26_000,
      },
    ]);
  });

  test("copy: single fixed, range, several services", () => {
    const names = new Map([
      [S1, "Tire Rotation"],
      [S2, "Brake Pads"],
    ]);
    const nameOf = (id: string) => names.get(id);
    const fixed = diffCheckoutPrice(
      expected([{ service_id: S1 as any, basis: "shop_price", low_cents: 8_500, high_cents: 8_500 }]),
      [line({ serviceId: S1, shopPrice: { lowCents: 15_000, highCents: 15_000 } })],
    );
    expect(priceChangedMessage(fixed, nameOf)).toBe("Tire Rotation is now $150.00 (was $85.00).");

    const range = diffCheckoutPrice(
      expected([{ service_id: S1 as any, basis: "shop_price", low_cents: 8_500, high_cents: 8_500 }]),
      [line({ serviceId: S1, shopPrice: { lowCents: 12_000, highCents: 15_000 } })],
    );
    expect(priceChangedMessage(range, nameOf)).toBe(
      "Tire Rotation is now $120.00–$150.00 (was $85.00).",
    );

    const both = diffCheckoutPrice(
      expected([
        { service_id: S1 as any, basis: "shop_price", low_cents: 8_500, high_cents: 8_500 },
        { service_id: S2 as any, basis: "shop_price", low_cents: 20_000, high_cents: 20_000 },
      ]),
      [
        line({ serviceId: S1, shopPrice: { lowCents: 15_000, highCents: 15_000 } }),
        line({ serviceId: S2, shopPrice: { lowCents: 25_000, highCents: 25_000 } }),
      ],
    );
    expect(priceChangedMessage(both, nameOf)).toBe("Prices changed for Tire Rotation and Brake Pads.");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// createBatch
// ─────────────────────────────────────────────────────────────────────────

const VIN = "1HGCM82633A004352";

async function seedCheckout(t: ReturnType<typeof makeT>, priceCents: number | null) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const customerClerkId = `clerk_customer_${now}_${Math.random().toString(36).slice(2)}`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: `clerk_owner_${now}`,
      email: "owner@test.local",
      first_name: "Owner",
      role: "shop_owner",
      createdAt: now,
    });
    const customerId = await ctx.db.insert("users", {
      clerkUserId: customerClerkId,
      email: "customer@test.local",
      first_name: "Cust",
      role: "user",
      createdAt: now,
    });
    const shopId = await ctx.db.insert("shops", {
      name: "Brooklyn Auto",
      owner_user_id: ownerId,
      is_active: true,
      timezone: "America/New_York",
      labor_rate: 150,
    } as any);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let day = 0; day < 7; day++) {
      await ctx.db.insert("shops_hours", {
        shop_id: shopId,
        day_of_week: day,
        day_name: dayNames[day],
        open_time: "08:00",
        close_time: "20:00",
        is_closed: false,
      } as any);
    }
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Alice",
      last_name: "Mechanic",
      is_active: true,
    } as any);
    const serviceId = await ctx.db.insert("services", {
      name: "Tire Rotation",
      default_labor_hours: 0.5,
      created_at: now,
    } as any);
    await ctx.db.insert("shop_services", {
      shop_id: shopId,
      service_id: serviceId,
      is_offered: true,
    } as any);
    const makeId = await ctx.db.insert("makes", { name: "Honda" } as any);
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Accord" } as any);
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "honda|accord|2003|test",
      year: 2003,
      make_id: makeId,
      model_id: modelId,
      pricing_tier: "T1",
    } as any);
    await ctx.db.insert("vehicles", { vin: VIN, vehicle_config_id: configId, created_at: now });
    await ctx.db.insert("vehicle_owners", { vin: VIN, user_id: customerId, status: "active" });
    if (priceCents != null) {
      await ctx.db.insert("shop_service_fixed_prices", {
        shop_id: shopId,
        service_id: serviceId,
        tier: "T1",
        price_cents: priceCents,
        updated_at: now,
      });
    }
    return { customerId, customerClerkId, shopId, mechanicId, serviceId };
  });
}

function batchArgs(seed: Awaited<ReturnType<typeof seedCheckout>>, extra: Record<string, unknown> = {}) {
  return {
    user_id: seed.customerId,
    vin: VIN,
    shop_id: seed.shopId,
    mechanic_id: seed.mechanicId,
    scheduled_date: "2030-05-14",
    scheduled_time: "10:00",
    // What the phone sends for a shop-priced line: the engine's $0 labor.
    services: [{ service_id: seed.serviceId, labor_cost: 0, parts_cost: 0, labor_hours: 0.5 }],
    ...extra,
  } as any;
}

function shownShopPrice(seed: Awaited<ReturnType<typeof seedCheckout>>, cents: number) {
  return {
    version: 1 as const,
    lines: [
      { service_id: seed.serviceId, basis: "shop_price" as const, low_cents: cents, high_cents: cents },
    ],
    total_low_cents: cents,
    total_high_cents: cents,
  };
}

describe("createBatch re-checks the price the customer saw (#390)", () => {
  test("matching expected_price books", async () => {
    const t = makeT();
    const seed = await seedCheckout(t, 8_500);
    const ids = await t
      .withIdentity(identityFor(seed.customerClerkId))
      .mutation(api.bookings.createBatch, batchArgs(seed, { expected_price: shownShopPrice(seed, 8_500) }));
    expect(ids).toHaveLength(1);
  });

  test("shop price changed since Review & Pay → PRICE_CHANGED with before/after, nothing written", async () => {
    const t = makeT();
    const seed = await seedCheckout(t, 15_000);
    const p = t
      .withIdentity(identityFor(seed.customerClerkId))
      .mutation(api.bookings.createBatch, batchArgs(seed, { expected_price: shownShopPrice(seed, 8_500) }));
    await expect(p).rejects.toMatchObject({
      data: {
        code: "PRICE_CHANGED",
        message: "Tire Rotation is now $150.00 (was $85.00).",
        lines: [
          {
            serviceId: String(seed.serviceId),
            serviceName: "Tire Rotation",
            before: { basis: "shop_price", lowCents: 8_500, highCents: 8_500 },
            after: { basis: "shop_price", lowCents: 15_000, highCents: 15_000 },
          },
        ],
        previousTotalLowCents: 8_500,
        previousTotalHighCents: 8_500,
      },
    });
    const bookings = await t.run((ctx) => ctx.db.query("bookings").collect());
    expect(bookings).toHaveLength(0);
  });

  test("estimate shown, shop set a price since → PRICE_CHANGED", async () => {
    const t = makeT();
    const seed = await seedCheckout(t, 15_000);
    const p = t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.bookings.createBatch,
      batchArgs(seed, {
        expected_price: {
          version: 1,
          lines: [{ service_id: seed.serviceId, basis: "estimate", low_cents: 7_500, high_cents: 7_500 }],
          total_low_cents: 7_500,
          total_high_cents: 7_500,
        },
      }),
    );
    await expect(p).rejects.toMatchObject({
      data: { code: "PRICE_CHANGED", lines: [{ reason: "now_shop_priced" }] },
    });
  });

  test("no expected_price (builds in the field) → books at the live price, as before", async () => {
    const t = makeT();
    const seed = await seedCheckout(t, 15_000);
    const ids = await t
      .withIdentity(identityFor(seed.customerClerkId))
      .mutation(api.bookings.createBatch, batchArgs(seed));
    expect(ids).toHaveLength(1);
    const booking: any = await t.run((ctx) => ctx.db.get(ids[0] as any));
    expect(booking.fixed_price_lines?.[0]?.price_low_cents).toBe(15_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Estimate approvals
// ─────────────────────────────────────────────────────────────────────────

async function openApproval(
  t: ReturnType<typeof makeT>,
  bookingId: any,
  cents: number,
  cycle: "pre_job" | "mid_job" | "post_job" = "pre_job",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("booking_approvals", {
      booking_id: bookingId,
      cycle,
      mechanic_set_price_cents: cents,
      parts_snapshot: [],
      prior_ceiling_cents: 10_000,
      submitted_at_ms: Date.now(),
    }),
  );
}

describe("approving an estimate re-checks the one the customer saw (#390)", () => {
  test("stale approval id → PRICE_CHANGED, estimate left open", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const oldId = await openApproval(t, seed.bookingId, 20_000);
    await t.run((ctx) => ctx.db.patch(oldId, { decision: "withdrawn" }));
    const newId = await openApproval(t, seed.bookingId, 30_000);

    const p = t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.booking_approvals.applyApprovalDecision,
      {
        bookingId: seed.bookingId,
        decision: "approved",
        expected_approval_id: String(oldId),
        expected_total_cents: 20_000,
      },
    );
    await expect(p).rejects.toMatchObject({
      data: {
        code: "PRICE_CHANGED",
        message: "The shop updated this estimate — review the new total.",
        approvalId: String(newId),
        previousTotalCents: 20_000,
        newTotalCents: 30_000,
      },
    });
    const row: any = await t.run((ctx) => ctx.db.get(newId));
    expect(row.decision).toBeUndefined();
  });

  test("same row, amount edited → PRICE_CHANGED", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const id = await openApproval(t, seed.bookingId, 30_000);
    await expect(
      t.withIdentity(identityFor(seed.customerClerkId)).mutation(
        api.booking_approvals.applyApprovalDecision,
        {
          bookingId: seed.bookingId,
          decision: "approved",
          expected_approval_id: String(id),
          expected_total_cents: 25_000,
        },
      ),
    ).rejects.toMatchObject({ data: { code: "PRICE_CHANGED" } });
  });

  test("matching id + amount approves", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const id = await openApproval(t, seed.bookingId, 30_000, "post_job");
    await t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.booking_approvals.applyApprovalDecision,
      {
        bookingId: seed.bookingId,
        decision: "approved",
        expected_approval_id: String(id),
        expected_total_cents: 30_000,
      },
    );
    const row: any = await t.run((ctx) => ctx.db.get(id));
    expect(row.decision).toBe("approved");
  });

  test("cancelled booking → BOOKING_ALREADY_CANCELLED with customer copy", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "cancelled" });
    await t.run((ctx) => ctx.db.patch(seed.bookingId, { cancelled_by_role: "shop" } as any));
    await openApproval(t, seed.bookingId, 30_000);
    await expect(
      t.withIdentity(identityFor(seed.customerClerkId)).mutation(
        api.booking_approvals.applyApprovalDecision,
        { bookingId: seed.bookingId, decision: "approved" },
      ),
    ).rejects.toMatchObject({
      data: {
        code: "BOOKING_ALREADY_CANCELLED",
        message: "The shop cancelled this booking, so this estimate no longer applies.",
        actorRole: "shop",
      },
    });
  });

  test("nothing open → BOOKING_STATE_CHANGED 'already handled'", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await expect(
      t.withIdentity(identityFor(seed.customerClerkId)).mutation(
        api.booking_approvals.applyApprovalDecision,
        { bookingId: seed.bookingId, decision: "declined" },
      ),
    ).rejects.toMatchObject({
      data: { code: "BOOKING_STATE_CHANGED", message: "This estimate was already handled." },
    });
  });

  test("_recordApprovalApproved (approveAndAuthorizeHold) applies the same check", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await openApproval(t, seed.bookingId, 30_000);
    await expect(
      t.mutation(internal.booking_approvals._recordApprovalApproved, {
        bookingId: seed.bookingId,
        userId: seed.customerId,
        expectedTotalCents: 20_000,
      }),
    ).rejects.toMatchObject({ data: { code: "PRICE_CHANGED" } });
  });

  test("_recordApprovalApproved returns the approved amount, which approveAndAuthorizeHold holds", async () => {
    // The action sizes the new hold from this return value, not from a later
    // re-read of the booking: once the approval commits, nothing is open and
    // the shop can submit a higher estimate before the Stripe call.
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const id = await openApproval(t, seed.bookingId, 30_000);
    await t.run((ctx) =>
      ctx.db.patch(seed.bookingId, { mechanic_set_price_cents: 30_000 }),
    );
    const res = await t.mutation(internal.booking_approvals._recordApprovalApproved, {
      bookingId: seed.bookingId,
      userId: seed.customerId,
      expectedApprovalId: String(id),
      expectedTotalCents: 30_000,
    });
    expect(res.ceilingCents).toBe(30_000);
    // No race: the old max() over the re-read agrees with the return value.
    const reread = await t.run(async (ctx) => {
      const b = await ctx.db.get(seed.bookingId as Id<"bookings">);
      return Math.max(b?.mechanic_set_price_cents ?? 0, b?.running_approved_ceiling_cents ?? 0);
    });
    expect(reread).toBe(res.ceilingCents);
  });

  test("approvalDecisionConflict: old builds (nothing expected) proceed", () => {
    expect(
      approvalDecisionConflict({
        booking: { _id: "b1", status: "in_progress" },
        open: { _id: "a1", cycle: "mid_job", mechanic_set_price_cents: 5_000 },
        decision: "approved",
      }),
    ).toBeNull();
  });
});
