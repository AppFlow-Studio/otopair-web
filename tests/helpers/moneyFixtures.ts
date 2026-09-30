/**
 * The Sep 22 Jeep Cherokee from the bug tracker (#331/#334/#335/#350), seeded
 * with its real numbers: booked at $163.61, pre-job estimate $111.76
 * (auto-approved), a Diagnostic Scan added mid-job and approved at $198.21.
 */
import type { makeT } from "../helpers";

export const JEEP_PARTS = [
  { part_name: "Engine Oil", oem_number: "5166241PC", cost: 10.72, quantity: 5 },
  { part_name: "Oil Filter", oem_number: "04892339BE", cost: 9.36, quantity: 1 },
  { part_name: "Drain-plug crush washer", oem_number: "X", cost: 4.0, quantity: 1 },
  { part_name: "test part", oem_number: "", cost: 0.01, quantity: 1 },
];

export async function seedJeepSep22(
  t: ReturnType<typeof makeT>,
  opts: {
    /** What Stripe captured; null = not captured yet. */
    capturedCents?: number | null;
    status?: string;
  } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const clerkUserId = `c_jeep_${now}_${Math.random().toString(36).slice(2)}`;
    const userId = await ctx.db.insert("users", {
      clerkUserId,
      email: "oyelade@test.local",
      first_name: "Damilola",
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
      mechanic_id: mechanicId,
      vin: "1C4PJMDN2ND542287",
      service_ids: [oil],
      scheduled_date: "2026-09-22",
      scheduled_time: "12:40",
      status: opts.status ?? "completed",
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
      created_at: now - 10000,
      updated_at: now,
    } as any);
    const diagJobId = await ctx.db.insert("custom_jobs", {
      booking_id: bookingId,
      shop_id: shopId,
      vehicle_vin: "1C4PJMDN2ND542287",
      name: "Diagnostic Scan",
      normalized_name: "diagnostic scan",
      match_key: "diagnostic scan",
      source: "mid_job",
      status: "planned",
      created_at: now - 4000,
    } as any);
    await ctx.db.insert("booking_approvals", {
      booking_id: bookingId,
      cycle: "pre_job",
      mechanic_set_price_cents: 11176,
      parts_subtotal_cents: 6697,
      labor_cents: 3000,
      tax_cents: 800,
      service_fee_cents: 679,
      parts_snapshot: JEEP_PARTS,
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
        ...JEEP_PARTS,
        {
          part_name: "test part 2",
          oem_number: "",
          cost: 0.01,
          quantity: 1,
          custom_service_name: "Diagnostic Scan",
        },
      ],
      labor_hours: 0.7,
      labor_rate_cents: 15000,
      labor_allocations: [
        { line_key: `svc:${oil}`, hours: 0.4 },
        { line_key: `job:${diagJobId}`, hours: 0.2 },
      ],
      prior_ceiling_cents: 11176,
      submitted_at_ms: now - 2000,
      decision: "approved",
      decided_at_ms: now - 1000,
    } as any);
    await ctx.db.insert("job_actuals", {
      booking_id: bookingId,
      mechanic_id: mechanicId,
      parts_used: [
        ...JEEP_PARTS,
        { part_name: "test part 2", oem_number: "", cost: 0.01, quantity: 1 },
      ],
      created_at: now,
      updated_at: now,
    } as any);
    const captured = opts.capturedCents ?? null;
    const paymentId = await ctx.db.insert("payments", {
      booking_id: bookingId,
      user_id: userId,
      shop_id: shopId,
      amount: 163.61,
      status: captured != null ? "completed" : "processing",
      hold_amount_cents: 2000,
      incremented_total_cents: 19821,
      ...(captured != null
        ? { captured_amount_cents: captured, captured_at_ms: now }
        : {}),
      card_brand: "visa",
      card_last4: "4242",
      stripe_payment_intent_id: "pi_jeep",
      created_at: now - 9000,
    } as any);
    return { bookingId, userId, clerkUserId, shopId, oil, diagJobId, paymentId };
  });
}
