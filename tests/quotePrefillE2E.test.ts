/**
 * END-TO-END: a quote-originated booking, driven through the REAL shipped
 * functions — no logic is reimplemented here. Each test:
 *   1. seeds a quote-stage booking + the shop's tire/rotor quote response,
 *   2. accepts it with the actual `bookings.acceptTireQuote` /
 *      `bookings.acceptRotorQuote` mutation (→ a confirmed booking),
 *   3. reads the parts step with the actual `job_actuals.getPrefillData` query,
 *   4. and (second block) adds mid-job scope and has the customer confirm it via
 *      the actual `customJobs`/`booking_approvals` mutations.
 *
 * The prefilled values are logged so the run output is the evidence: the parts
 * step is filled from the quote submission (brand / per-unit price / qty), not
 * left empty.
 */
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

const VIN = "1HGCM82633A004352";
type QuoteType = "tire" | "rotor";

type SeedOpts = {
  // Both slug spellings occur in the wild — acceptTireQuote/acceptRotorQuote try
  // "…-replacement" then "…_replacement". The real dev booking used underscore.
  tireSlug?: "tire-replacement" | "tire_replacement";
  tirePositions?: Array<"FL" | "FR" | "RL" | "RR">;
  tireQuantity?: number;
};

async function seedQuoteBooking(quoteType: QuoteType, opts: SeedOpts = {}) {
  const t = makeT();
  const seed = await t.run(async (ctx) => {
    const now = Date.now();
    const customerClerkId = `${quoteType}_cust_${now}`;
    const ownerClerkId = `${quoteType}_owner_${now}`;
    const customerId = await ctx.db.insert("users", {
      clerkUserId: customerClerkId,
      email: `c-${quoteType}@t.local`,
      first_name: "Cust",
      role: "user",
    } as never);
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: `o-${quoteType}@t.local`,
      first_name: "Own",
      role: "shop_owner",
    } as never);
    const shopId = await ctx.db.insert("shops", {
      name: "Quote Shop",
      is_active: true,
      owner_user_id: ownerId,
    } as never);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Dean",
      last_name: "Martin",
      is_active: true,
    });
    await ctx.db.insert("shops_hours", {
      shop_id: shopId,
      day_of_week: 1,
      day_name: "Mon",
      open_time: "08:00",
      close_time: "17:00",
      is_closed: false,
    });
    await ctx.db.insert("services", {
      name: quoteType === "tire" ? "Tire Replacement" : "Rotor Replacement",
      slug:
        quoteType === "tire"
          ? opts.tireSlug ?? "tire-replacement"
          : "rotor-replacement",
      default_labor_hours: 0.5,
      created_at: now,
    } as never);
    // getPrefillData needs a vehicle + engine for the VIN.
    const engineId = await ctx.db.insert("engines", {} as never);
    await ctx.db.insert("vehicles", {
      vin: VIN,
      engine_id: engineId,
      year: 2019,
    } as never);
    const bookingId = await ctx.db.insert("bookings", {
      user_id: customerId,
      vin: VIN,
      service_ids: [],
      status: "quotes_ready",
      created_at: now,
      updated_at: now,
      ...(quoteType === "tire"
        ? {
            tire_specs: {
              size: "225/65R17",
              type: "all_season",
              tier: "premium",
              quantity: opts.tireQuantity ?? 4,
              ...(opts.tirePositions
                ? { positions: opts.tirePositions }
                : {}),
            },
          }
        : {
            rotor_specs: {
              brake_system_type: "standard",
              axle: "both",
              include_pads: true,
            },
          }),
    } as never);
    const common = {
      booking_id: bookingId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      quantity: quoteType === "tire" ? opts.tireQuantity ?? 4 : 2,
      labor_cost: 150,
      total: quoteType === "tire" ? 590 : 410,
      availability: { date: "2026-06-01", time: "09:00" },
      estimated_duration_minutes: 30,
      created_at: now,
    };
    const responseId =
      quoteType === "tire"
        ? await ctx.db.insert("tire_quote_responses", {
            ...common,
            tire_brand: "Michelin",
            tire_model: "Defender",
            per_tire_price: 110,
          } as never)
        : await ctx.db.insert("rotor_quote_responses", {
            ...common,
            rotor_brand: "Brembo",
            rotor_model: "UV Coated",
            per_rotor_price: 130,
            pad_brand: "Akebono",
            pad_type: "ceramic",
            pad_price: 60,
            pad_quantity: 2,
          } as never);
    const sessionId = `${quoteType}-sess`;
    const holdId = await ctx.db.insert("slot_holds", {
      shop_id: shopId,
      mechanic_id: mechanicId,
      date: "2026-06-01",
      start_time: "09:00",
      end_time: "09:30",
      duration_minutes: 30,
      held_by: customerId,
      session_id: sessionId,
      expires_at: now + 15 * 60 * 1000,
      status: "active",
      created_at: now,
      quote_type: quoteType,
      quote_revision: 1,
      ...(quoteType === "tire"
        ? { tire_quote_response_id: responseId }
        : { rotor_quote_response_id: responseId }),
    } as never);
    return {
      customerClerkId,
      ownerClerkId,
      customerId,
      ownerId,
      shopId,
      mechanicId,
      bookingId,
      responseId,
      holdId,
      sessionId,
    };
  });
  return { t, seed };
}

async function acceptQuote(
  t: ReturnType<typeof makeT>,
  seed: Awaited<ReturnType<typeof seedQuoteBooking>>["seed"],
  quoteType: QuoteType,
) {
  const customer = t.withIdentity(identityFor(seed.customerClerkId));
  const args = {
    booking_id: seed.bookingId,
    response_id: seed.responseId,
    scheduled_date: "2026-06-01",
    scheduled_time: "09:00",
    hold_id: seed.holdId,
    session_id: seed.sessionId,
    quote_revision: 1,
  };
  if (quoteType === "tire") {
    await customer.mutation(api.bookings.acceptTireQuote, args as never);
  } else {
    await customer.mutation(api.bookings.acceptRotorQuote, args as never);
  }
}

describe("quote-originated booking prefills its parts step from the accepted quote", () => {
  test("TIRE: accepted quote auto-fills the parts step (brand / model / per-tire price / qty, split across axles)", async () => {
    const { t, seed } = await seedQuoteBooking("tire");
    await acceptQuote(t, seed, "tire");

    // Sanity: the accept produced a real confirmed booking with the tire service.
    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("confirmed");
    expect((booking?.service_ids ?? []).length).toBe(1);

    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const prefill: any = await owner.query(api.job_actuals.getPrefillData, {
      bookingId: seed.bookingId,
    });
    const tireLines = (prefill?.suggestedParts ?? []).filter(
      (p: any) => p.is_tire && p.from_quote,
    );
    console.log(
      "[E2E tire prefill] parts auto-filled from the accepted quote:\n" +
        JSON.stringify(tireLines, null, 2),
    );

    // Front + rear both pre-filled — not the empty "Add front/rear tires" state.
    expect(tireLines.length).toBe(2);
    expect(tireLines.map((l: any) => l.tire_position).sort()).toEqual([
      "front",
      "rear",
    ]);
    for (const l of tireLines) {
      expect(l.tire_brand).toBe("Michelin");
      expect(l.tire_model).toBe("Defender");
      expect(l.cost).toBe(110); // per-tire price straight from the quote
      expect(l.tire_size).toBe("225/65R17");
    }
    // The four quoted tires are represented across the two axles.
    expect(
      tireLines.reduce((s: number, l: any) => s + (l.quantity ?? 0), 0),
    ).toBe(4);
  });

  test("TIRE: underscore slug + rear-only positions seeds two REAR tires (the real dev booking's shape)", async () => {
    // Reproduces booking kn773wkz… on third-bird-914: service slug
    // "tire_replacement" (underscore) and tire_specs.positions [RL, RR]. The
    // hyphen-only gate + even-split would have wrongly emitted 1 front + 1 rear
    // (or nothing at all). This pins the real fix.
    const { t, seed } = await seedQuoteBooking("tire", {
      tireSlug: "tire_replacement",
      tirePositions: ["RL", "RR"],
      tireQuantity: 2,
    });
    await acceptQuote(t, seed, "tire");
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const prefill: any = await owner.query(api.job_actuals.getPrefillData, {
      bookingId: seed.bookingId,
    });
    const tireLines = (prefill?.suggestedParts ?? []).filter(
      (p: any) => p.is_tire && p.from_quote,
    );
    console.log(
      "[E2E tire underscore+rear-only] " + JSON.stringify(tireLines, null, 2),
    );
    // A single REAR line for both tires — not split across axles.
    expect(tireLines.length).toBe(1);
    expect(tireLines[0].tire_position).toBe("rear");
    expect(tireLines[0].quantity).toBe(2);
    expect(tireLines[0].cost).toBe(110);
  });

  test("ROTOR: accepted quote auto-fills rotor + pad parts (brand / price / qty)", async () => {
    const { t, seed } = await seedQuoteBooking("rotor");
    await acceptQuote(t, seed, "rotor");

    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("confirmed");

    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const prefill: any = await owner.query(api.job_actuals.getPrefillData, {
      bookingId: seed.bookingId,
    });
    const quoteLines = (prefill?.suggestedParts ?? []).filter(
      (p: any) => p.from_quote,
    );
    console.log(
      "[E2E rotor prefill] parts auto-filled from the accepted quote:\n" +
        JSON.stringify(quoteLines, null, 2),
    );

    const rotor = quoteLines.find((p: any) => /rotor/i.test(p.part_name));
    const pad = quoteLines.find((p: any) => /pad/i.test(p.part_name));
    expect(rotor).toBeTruthy();
    expect(rotor.part_name).toContain("Brembo");
    expect(rotor.cost).toBe(130); // per-rotor price from the quote
    expect(rotor.quantity).toBe(2);
    // Pads were quoted alongside the rotors — they come through too.
    expect(pad).toBeTruthy();
    expect(pad.part_name).toContain("Akebono");
    expect(pad.cost).toBe(60);
    expect(pad.quantity).toBe(2);
  });
});

describe("added scope on a quote-originated booking (accept → add → customer confirm)", () => {
  for (const quoteType of ["tire", "rotor"] as const) {
    test(`${quoteType}: customer confirms mid-job added scope on the quote booking`, async () => {
      const { t, seed } = await seedQuoteBooking(quoteType);
      await acceptQuote(t, seed, quoteType);

      // Put the confirmed quote booking into the running state the mid-job flow
      // requires (same shape as the shipped start path).
      await t.run(async (ctx) => {
        const now = Date.now();
        await ctx.db.patch(seed.bookingId, {
          status: "in_progress",
          disclosed_range_low_cents: 5_000,
          disclosed_range_high_cents: 10_000,
        } as never);
        await ctx.db.insert("job_actuals", {
          booking_id: seed.bookingId,
          mechanic_id: seed.mechanicId,
          started_at: now,
          created_at: now,
          updated_at: now,
        } as never);
      });

      const owner = t.withIdentity(identityFor(seed.ownerClerkId));
      const customer = t.withIdentity(identityFor(seed.customerClerkId));

      // 1) mechanic adds off-catalog work — the REAL add mutation.
      await owner.mutation(api.customJobs.addMidJobCustomService, {
        bookingId: seed.bookingId,
        name: "Serpentine Belt",
        systemTags: ["engine"],
        workType: "replace",
      } as never);

      const staged: any = await t.run(async (ctx) =>
        (await ctx.db.get(seed.bookingId))?.custom_services,
      );
      // Staged, hidden from the customer until they approve.
      expect(
        (staged ?? []).some((c: any) => c.pending_confirmation === true),
      ).toBe(true);

      // 2) mechanic sends the mid-job change; 4h @ $150 is out of the disclosed
      //    range, so it lands PENDING rather than auto-approving.
      await owner.mutation(api.booking_approvals.submitMidJobChange, {
        bookingId: seed.bookingId,
        parts: [],
        laborHours: 4,
        laborRateCents: 15_000,
      } as never);

      // 3) the customer confirms it — the REAL decision mutation.
      await customer.mutation(api.booking_approvals.applyApprovalDecision, {
        bookingId: seed.bookingId,
        decision: "approved",
      } as never);

      const after: any = await t.run(async (ctx) =>
        (await ctx.db.get(seed.bookingId))?.custom_services,
      );
      console.log(
        `[E2E ${quoteType} added-scope] custom_services after customer confirm:\n` +
          JSON.stringify(after, null, 2),
      );
      const line = (after ?? []).find((c: any) => c.name === "Serpentine Belt");
      expect(line).toBeTruthy();
      // Confirmed → the pending flag is cleared and it surfaces as booked work.
      expect(line.pending_confirmation).toBeUndefined();
    });
  }
});

describe("quote accept records the pre-authorized deposit (like every other booking flow)", () => {
  for (const quoteType of ["tire", "rotor"] as const) {
    test(`${quoteType}: accepting with a pre-authorized deposit creates the payments row + disclosed band`, async () => {
      const { t, seed } = await seedQuoteBooking(quoteType);
      const customer = t.withIdentity(identityFor(seed.customerClerkId));
      const args = {
        booking_id: seed.bookingId,
        response_id: seed.responseId,
        scheduled_date: "2026-06-01",
        scheduled_time: "09:00",
        hold_id: seed.holdId,
        session_id: seed.sessionId,
        quote_revision: 1,
        // The $20 deposit the mobile pre-authorized (preauthorizePaymentForBooking),
        // handed to accept exactly like bookings.create receives it.
        preauthorized_payment: {
          stripe_payment_intent_id: "pi_test_deposit_hold",
          idempotency_key: `booking_preauth:${quoteType}-e2e`,
          hold_amount_cents: 2000,
          payment_origin: "apple_pay" as const,
        },
      };
      if (quoteType === "tire") {
        await customer.mutation(api.bookings.acceptTireQuote, args as never);
      } else {
        await customer.mutation(api.bookings.acceptRotorQuote, args as never);
      }

      const { booking, payment } = await t.run(async (ctx) => {
        const b: any = await ctx.db.get(seed.bookingId);
        const p: any = await ctx.db
          .query("payments")
          .withIndex("by_booking_id", (q: any) =>
            q.eq("booking_id", seed.bookingId),
          )
          .unique();
        return { booking: b, payment: p };
      });
      console.log(
        `[E2E ${quoteType} deposit] booking pas=${booking?.payment_approval_state} band=${booking?.disclosed_range_high_cents}; payment row:\n` +
          JSON.stringify(payment, null, 2),
      );

      expect(booking?.status).toBe("confirmed");
      // Now shaped like a normal pre-job-approval booking.
      expect(booking?.payment_approval_state).toBe("none");
      expect(booking?.disclosed_range_high_cents).toBeGreaterThan(0);
      // The payments row exists FROM ACCEPT — the reauth actions will find it.
      expect(payment).toBeTruthy();
      expect(payment?.stripe_payment_intent_id).toBe("pi_test_deposit_hold");
      expect(payment?.hold_amount_cents).toBe(2000);
      expect(payment?.payment_origin).toBe("apple_pay");
      expect(payment?.status).toBe("processing");
    });

    test(`${quoteType}: accept still confirms with NO deposit (hold falls to first reauth)`, async () => {
      const { t, seed } = await seedQuoteBooking(quoteType);
      const customer = t.withIdentity(identityFor(seed.customerClerkId));
      await acceptQuote(t, seed, quoteType); // no preauthorized_payment

      const { booking, payment } = await t.run(async (ctx) => {
        const b: any = await ctx.db.get(seed.bookingId);
        const p: any = await ctx.db
          .query("payments")
          .withIndex("by_booking_id", (q: any) =>
            q.eq("booking_id", seed.bookingId),
          )
          .unique();
        return { booking: b, payment: p };
      });
      // Confirms cleanly; no row yet — the first-hold path in the reauth actions
      // (approveAndAuthorizeHold / resumeReauthFromMobile) covers that case.
      expect(booking?.status).toBe("confirmed");
      expect(payment).toBeNull();
    });
  }
});

describe("a pre-job-added line approved mid-job reads as CONFIRMED, not draft", () => {
  test("listForBooking clears pending_confirmation even though the line isn't linked to the mid-job approval", async () => {
    // Reproduces the real booking kn773wkz…: a Brake Pad Replacement added
    // PRE-job (source pre_job) then confirmed by a mid-job approval. It never
    // gets introduced_by_approval_id (stampMidJobCustomJobs only stamps mid_job
    // lines), so it's absent from the scope change's addedServiceNames — which
    // is why the work order mislabeled it DRAFT. pending_confirmation is the real
    // signal, and it's cleared on approval.
    const { t, seed } = await seedQuoteBooking("tire");
    await acceptQuote(t, seed, "tire");
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const customer = t.withIdentity(identityFor(seed.customerClerkId));

    // 1) Add the line PRE-job (booking is confirmed, not yet in progress).
    await owner.mutation(api.customJobs.addPreJobCustomService, {
      bookingId: seed.bookingId,
      name: "Brake Pad Replacement",
      systemTags: ["brakes"],
      workType: "replace",
      axle: "rear",
    } as never);

    const staged: any[] = await owner.query(api.customJobs.listForBooking, {
      bookingId: seed.bookingId,
    });
    const stagedLine = staged.find((c) => c.name === "Brake Pad Replacement");
    expect(stagedLine?.pending_confirmation).toBe(true); // draft until approved

    // 2) Start the job and approve the scope via a MID-JOB cycle.
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(seed.bookingId, {
        status: "in_progress",
        disclosed_range_low_cents: 5_000,
        disclosed_range_high_cents: 10_000,
      } as never);
      await ctx.db.insert("job_actuals", {
        booking_id: seed.bookingId,
        mechanic_id: seed.mechanicId,
        started_at: now,
        created_at: now,
        updated_at: now,
      } as never);
    });
    await owner.mutation(api.booking_approvals.submitMidJobChange, {
      bookingId: seed.bookingId,
      parts: [],
      laborHours: 4,
      laborRateCents: 15_000,
    } as never);
    await customer.mutation(api.booking_approvals.applyApprovalDecision, {
      bookingId: seed.bookingId,
      decision: "approved",
    } as never);

    // 3) The line is confirmed — pending_confirmation cleared — even though it
    //    was never linked to the mid-job approval.
    const after: any[] = await owner.query(api.customJobs.listForBooking, {
      bookingId: seed.bookingId,
    });
    const line = after.find((c) => c.name === "Brake Pad Replacement");
    const cjRow: any = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("custom_jobs")
        .withIndex("by_booking", (q: any) => q.eq("booking_id", seed.bookingId))
        .collect();
      return rows.find((r: any) => r.name === "Brake Pad Replacement");
    });
    console.log(
      `[E2E draft fix] pending_confirmation=${line?.pending_confirmation} source=${cjRow?.source} introduced_by_approval_id=${cjRow?.introduced_by_approval_id ?? null}`,
    );
    expect(line?.pending_confirmation).toBe(false); // → work order: CONFIRMED
    // The linkage gap that caused the bug: pre_job source, no approval link.
    expect(cjRow?.source).toBe("pre_job");
    expect(cjRow?.introduced_by_approval_id ?? null).toBeNull();
  });
});
