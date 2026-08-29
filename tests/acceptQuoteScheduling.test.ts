import { expect, test } from "vitest";

import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { identityFor, makeT } from "./helpers";

async function seedAcceptance(quoteType: "tire" | "rotor") {
  const t = makeT();
  const seed = await t.run(async (ctx) => {
    const now = Date.now();
    const customerClerkId = `${quoteType}_customer_${now}`;
    const otherClerkId = `${quoteType}_other_${now}`;
    const customerId = await ctx.db.insert("users", {
      clerkUserId: customerClerkId,
      email: `${quoteType}@test.local`,
      first_name: "Customer",
      role: "user",
    } as never);
    const otherId = await ctx.db.insert("users", {
      clerkUserId: otherClerkId,
      email: `other-${quoteType}@test.local`,
      first_name: "Other",
      role: "user",
    } as never);
    const shopId = await ctx.db.insert("shops", {
      name: "Quote Shop",
      is_active: true,
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
      slug: quoteType === "tire" ? "tire-replacement" : "rotor-replacement",
      default_labor_hours: 0.5,
      created_at: now,
    } as never);
    const bookingId = await ctx.db.insert("bookings", {
      user_id: customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: now,
      updated_at: now,
    } as never);
    const common = {
      booking_id: bookingId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      quantity: quoteType === "tire" ? 4 : 2,
      labor_cost: 150,
      total: quoteType === "tire" ? 590 : 410,
      availability: { date: "2026-06-01", time: "09:00" },
      estimated_duration_minutes: 30,
      created_at: now,
    };
    const responseId = quoteType === "tire"
      ? await ctx.db.insert("tire_quote_responses", {
          ...common,
          tire_brand: "Michelin",
          per_tire_price: 110,
        })
      : await ctx.db.insert("rotor_quote_responses", {
          ...common,
          rotor_brand: "Brembo",
          per_rotor_price: 130,
        });
    const sessionId = `${quoteType}-checkout-session`;
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
    });
    return {
      customerClerkId,
      otherClerkId,
      otherId,
      customerId,
      shopId,
      bookingId,
      responseId,
      holdId,
      sessionId,
    };
  });
  return { t, seed };
}

test("a bare session id cannot bypass another customer's checkout hold", async () => {
  const { t, seed } = await seedAcceptance("tire");
  await t.run(async (ctx) => {
    await ctx.db.patch(seed.holdId, { held_by: seed.otherId });
  });

  await expect(
    t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.bookings.acceptTireQuote,
      {
        booking_id: seed.bookingId,
        response_id: seed.responseId,
        scheduled_date: "2026-06-01",
        scheduled_time: "09:00",
        session_id: seed.sessionId,
      } as never,
    ),
  ).rejects.toThrow("held by another customer");
});

for (const quoteType of ["tire", "rotor"] as const) {
  test(`${quoteType} quote cannot be accepted after its hold expires`, async () => {
    const { t, seed } = await seedAcceptance(quoteType);
    await t.run((ctx) =>
      ctx.db.patch(seed.responseId, { expires_at: Date.now() - 1 }),
    );
    const customer = t.withIdentity(identityFor(seed.customerClerkId));
    const args = {
      booking_id: seed.bookingId,
      response_id: seed.responseId,
      scheduled_date: "2026-06-01",
      scheduled_time: "09:00",
      hold_id: seed.holdId,
      session_id: seed.sessionId,
    };

    await expect(
      quoteType === "tire"
        ? customer.mutation(api.bookings.acceptTireQuote, args as never)
        : customer.mutation(api.bookings.acceptRotorQuote, args as never),
    ).rejects.toThrow("expired");
  });

  test(`${quoteType} quote owner can acquire the quoted slot while another customer cannot`, async () => {
    const { t, seed } = await seedAcceptance(quoteType);
    await t.run(async (ctx) => ctx.db.delete(seed.holdId));
    const quote_context = {
      quote_type: quoteType,
      response_id: seed.responseId,
    };

    await expect(
      t.withIdentity(identityFor(seed.otherClerkId)).mutation(api.slotHolds.holdSlot, {
        shop_id: seed.shopId,
        date: "2026-06-01",
        start_time: "09:00",
        duration_minutes: 30,
        session_id: "other-session",
        quote_context,
      } as never),
    ).rejects.toThrow("No mechanic is available");

    const result = await t
      .withIdentity(identityFor(seed.customerClerkId))
      .mutation(api.slotHolds.holdSlot, {
        shop_id: seed.shopId,
        date: "2026-06-01",
        start_time: "09:00",
        duration_minutes: 30,
        session_id: "owner-session",
        quote_context,
      } as never);

    expect(result.holdId).not.toBeNull();
    const hold = (await t.run(async (ctx) =>
      result.holdId ? ctx.db.get(result.holdId) : null,
    )) as Doc<"slot_holds"> | null;
    expect(hold?.held_by).toBe(seed.customerId);
  });

  test(`${quoteType} quote acceptance consumes the checkout hold and uses response pricing`, async () => {
    const { t, seed } = await seedAcceptance(quoteType);
    const customer = t.withIdentity(identityFor(seed.customerClerkId));
    const args = {
      booking_id: seed.bookingId,
      response_id: seed.responseId,
      scheduled_date: "2026-06-01",
      scheduled_time: "09:00",
      hold_id: seed.holdId,
      session_id: seed.sessionId,
    };

    if (quoteType === "tire") {
      await customer.mutation(api.bookings.acceptTireQuote, args as never);
    } else {
      await customer.mutation(api.bookings.acceptRotorQuote, args as never);
    }

    const result = await t.run(async (ctx) => ({
      booking: await ctx.db.get(seed.bookingId),
      hold: await ctx.db.get(seed.holdId),
    }));
    expect(result.booking?.status).toBe("confirmed");
    expect(result.booking?.total_cost).toBe(quoteType === "tire" ? 590 : 410);
    expect(result.hold).toBeNull();
  });

  test(`${quoteType} quote acceptance rejects a different customer`, async () => {
    const { t, seed } = await seedAcceptance(quoteType);
    const other = t.withIdentity(identityFor(seed.otherClerkId));
    const args = {
      booking_id: seed.bookingId,
      response_id: seed.responseId,
      scheduled_date: "2026-06-01",
      scheduled_time: "09:00",
      hold_id: seed.holdId,
      session_id: seed.sessionId,
    };

    await expect(
      quoteType === "tire"
        ? other.mutation(api.bookings.acceptTireQuote, args as never)
        : other.mutation(api.bookings.acceptRotorQuote, args as never),
    ).rejects.toThrow("Booking not found");
  });
}
