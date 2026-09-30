/**
 * What completion captures (#334).
 *
 * The Sep 22 Jeep was approved at $198.21 mid-job; the shop Timeline logged
 * "Payment collected — $111.77". finalize recomputed the total from
 * job_actuals plus the approval it found first on `by_booking_and_cycle` —
 * which, sorted by the cycle STRING, is always the pre-job row — and captured
 * min(recomputed, agreed). These pin the capture to the agreed statement.
 */
import { describe, expect, it } from "vitest";
import { internal } from "../convex/_generated/api";
import { agreedCaptureFor, buildBookingMoney } from "../convex/lib/bookingMoney";
import { makeT } from "./helpers";

const PARTS = [
  { part_name: "Engine Oil", oem_number: "5166241PC", cost: 10.72, quantity: 5 },
  { part_name: "Oil Filter", oem_number: "04892339BE", cost: 9.36, quantity: 1 },
  { part_name: "Drain-plug crush washer", oem_number: "X", cost: 4.0, quantity: 1 },
  { part_name: "test part", oem_number: "", cost: 0.01, quantity: 1 },
];

async function seedJeep(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkUserId: `c_${now}`,
      email: "c@test.local",
      role: "user",
      createdAt: now,
    } as any);
    const shopId = await ctx.db.insert("shops", {
      name: "Damis shop",
      owner_user_id: userId,
      is_active: true,
      state: "TX",
      zip: "77002",
      labor_rate: 150,
    } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Damilola",
      last_name: "Oyelade",
      is_active: true,
    } as any);
    const oil = await ctx.db.insert("services", {
      name: "Oil Change",
      default_labor_hours: 0.5,
      created_at: now,
    } as any);
    const bookingId = await ctx.db.insert("bookings", {
      user_id: userId,
      shop_id: shopId,
      vin: "1C4PJMDN2ND542287",
      service_ids: [oil],
      scheduled_date: "2026-09-22",
      scheduled_time: "12:40",
      status: "completed",
      custom_services: [{ name: "Diagnostic Scan", duration_minutes: 12 }],
      labor_cost: 105,
      parts_cost: 66.98,
      total_cost: 198.21,
      quoted_set_price_cents: 16361,
      disclosed_range_low_cents: 15000,
      disclosed_range_high_cents: 17000,
      mechanic_set_price_cents: 19821,
      running_approved_ceiling_cents: 19821,
      payment_approval_state: "in_range",
      created_at: now,
      updated_at: now,
    } as any);
    await ctx.db.insert("booking_approvals", {
      booking_id: bookingId,
      cycle: "pre_job",
      mechanic_set_price_cents: 11176,
      parts_subtotal_cents: 6697,
      labor_cents: 3000,
      tax_cents: 800,
      service_fee_cents: 679,
      parts_snapshot: PARTS,
      labor_hours: 0.2,
      labor_rate_cents: 15000,
      prior_ceiling_cents: 17000,
      submitted_at_ms: now - 5000,
      decision: "auto_approved_within_range",
      decided_at_ms: now - 5000,
    } as any);
    await ctx.db.insert("booking_approvals", {
      booking_id: bookingId,
      cycle: "mid_job",
      mechanic_set_price_cents: 19821,
      parts_subtotal_cents: 6698,
      labor_cents: 10500,
      tax_cents: 1419,
      service_fee_cents: 1204,
      parts_snapshot: [
        ...PARTS,
        { part_name: "test part 2", oem_number: "", cost: 0.01, quantity: 1 },
      ],
      labor_hours: 0.7,
      labor_rate_cents: 15000,
      prior_ceiling_cents: 11176,
      submitted_at_ms: now - 2000,
      decision: "approved",
      decided_at_ms: now - 1000,
    } as any);
    // What the mechanic confirmed at completion: the same 5 parts.
    await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mechanicId,
      parts_used: [
        ...PARTS,
        { part_name: "test part 2", oem_number: "", cost: 0.01, quantity: 1 },
      ],
      created_at: now,
      updated_at: now,
    } as any);
    await ctx.db.insert("payments", {
      booking_id: bookingId,
      user_id: userId,
      shop_id: shopId,
      amount: 163.61,
      status: "processing",
      hold_amount_cents: 2000,
      incremented_total_cents: 19821,
      stripe_payment_intent_id: "pi_jeep",
      created_at: now,
    } as any);
    return { bookingId };
  });
}

describe("finalize captures the agreed total (#334)", () => {
  it("labor comes from the mid-job approval, and the capture is $198.21", async () => {
    const t = makeT();
    const { bookingId } = await seedJeep(t);
    const computed: any = await t.query(
      internal.payments_stripe._computeFinalTotalForBooking,
      { bookingId },
    );
    // The recompute now picks the newest agreed row (mid-job labor $105)...
    expect(computed.laborCents).toBe(10500);
    // ...but capture no longer depends on it: the agreed statement decides.
    const agreed = agreedCaptureFor(computed.money);
    expect(agreed).toEqual({ captureCents: 19821, feeCents: 1204, source: "approval" });
  });

  it("stamps Stripe actions on the latest submitted cycle, not the pre-job row", async () => {
    const t = makeT();
    const { bookingId } = await seedJeep(t);
    await t.mutation(internal.payments_stripe._stampApprovalStripeAction, {
      bookingId,
      stripeAction: "capture_final",
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("booking_approvals")
        .withIndex("by_booking_and_cycle", (q: any) => q.eq("booking_id", bookingId))
        .collect(),
    );
    const byCycle = Object.fromEntries(rows.map((r: any) => [r.cycle, r.stripe_action]));
    expect(byCycle.mid_job).toBe("capture_final");
    expect(byCycle.pre_job).toBeUndefined();
  });
});

describe("agreedCaptureFor", () => {
  const base = {
    booking: {},
    approvals: [],
    customJobs: [],
    payments: [],
    shop: { state: "TX", zip: "77002" },
    baseServices: [],
    quote: null,
  };

  it("a range booking with no chosen price keeps the ceiling fallback", () => {
    const money = buildBookingMoney({
      ...base,
      booking: {
        service_ids: ["brake"],
        has_shop_price_range: true,
        fixed_price_lines: [{ service_id: "brake", price_low_cents: 20000, price_high_cents: 30000 }],
        quoted_breakdown: { parts_cents: 25000, labor_cents: 0, tax_cents: 2063, service_fee_cents: 1750 },
        quoted_set_price_cents: 28813,
        disclosed_range_low_cents: 23300,
        disclosed_range_high_cents: 34300,
      },
      baseServices: [{ serviceId: "brake", name: "Brake Service", catalogHours: 1 }],
    });
    expect(agreedCaptureFor(money)).toBeNull();
  });

  it("a fully fixed-price booking with no estimate captures its set price, not the actuals", () => {
    const money = buildBookingMoney({
      ...base,
      booking: {
        service_ids: ["rot"],
        is_fixed_price: true,
        fixed_price_lines: [{ service_id: "rot", price_low_cents: 15000, price_high_cents: 15000 }],
        quoted_breakdown: { parts_cents: 15000, labor_cents: 0, tax_cents: 1238, service_fee_cents: 1050 },
        quoted_set_price_cents: 17288,
        disclosed_range_low_cents: 17288,
        disclosed_range_high_cents: 17288,
      },
      baseServices: [{ serviceId: "rot", name: "Tire Rotation", catalogHours: 0.5 }],
    });
    expect(agreedCaptureFor(money)).toEqual({
      captureCents: 17288,
      feeCents: 1050,
      source: "estimate",
    });
  });

  it("nothing agreed and nothing priced → null", () => {
    expect(agreedCaptureFor(buildBookingMoney(base as any))).toBeNull();
    expect(agreedCaptureFor(null)).toBeNull();
  });
});
