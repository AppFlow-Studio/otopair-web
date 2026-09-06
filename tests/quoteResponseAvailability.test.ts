import { expect, test } from "vitest";

import { api } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

async function seedQuoteAvailability() {
  const t = makeT();
  const seed = await t.run(async (ctx) => {
    const now = Date.now();
    const customerClerkId = `quote_customer_${now}`;
    const otherClerkId = `quote_other_${now}`;
    const customerId = await ctx.db.insert("users", {
      clerkUserId: customerClerkId,
      email: "quote-customer@test.local",
      first_name: "Customer",
      role: "user",
    } as never);
    await ctx.db.insert("users", {
      clerkUserId: otherClerkId,
      email: "other@test.local",
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
    const bookingId = await ctx.db.insert("bookings", {
      user_id: customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: now,
      updated_at: now,
    } as never);
    const tireResponseId = await ctx.db.insert("tire_quote_responses", {
      booking_id: bookingId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      tire_brand: "Michelin",
      per_tire_price: 100,
      quantity: 4,
      labor_cost: 100,
      total: 500,
      availability: { date: "2026-06-01", time: "09:00" },
      estimated_duration_minutes: 30,
      created_at: now,
    });
    const rotorResponseId = await ctx.db.insert("rotor_quote_responses", {
      booking_id: bookingId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      rotor_brand: "Brembo",
      per_rotor_price: 120,
      quantity: 2,
      labor_cost: 150,
      total: 390,
      availability: { date: "2026-06-01", time: "10:00" },
      estimated_duration_minutes: 30,
      created_at: now,
    });
    return {
      customerClerkId,
      otherClerkId,
      customerId,
      shopId,
      mechanicId,
      bookingId,
      tireResponseId,
      rotorResponseId,
    };
  });
  return { t, seed };
}

test("quote owner sees an available earliest slot for tire and rotor responses", async () => {
  const { t, seed } = await seedQuoteAvailability();
  const customer = t.withIdentity(identityFor(seed.customerClerkId));

  const tire = await customer.query(api.tire_quote_responses.listForBookingWithShops, {
    booking_id: seed.bookingId,
  });
  const rotor = await customer.query(api.rotor_quote_responses.listForBookingWithShops, {
    booking_id: seed.bookingId,
  });

  expect(tire[0]?.earliest_slot_available).toBe(true);
  expect(rotor[0]?.earliest_slot_available).toBe(true);
});

test("a confirmed booking makes the quoted earliest slot unavailable", async () => {
  const { t, seed } = await seedQuoteAvailability();
  await t.run(async (ctx) => {
    await ctx.db.insert("bookings", {
      user_id: seed.customerId,
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      vin: "1HGCM82633A111111",
      service_ids: [],
      scheduled_date: "2026-06-01",
      scheduled_time: "09:00",
      estimated_labor_minutes: 30,
      status: "confirmed",
      created_at: Date.now(),
      updated_at: Date.now(),
    } as never);
  });

  const tire = await t
    .withIdentity(identityFor(seed.customerClerkId))
    .query(api.tire_quote_responses.listForBookingWithShops, {
      booking_id: seed.bookingId,
    });

  expect(tire[0]?.earliest_slot_available).toBe(false);
});

test("another customer cannot list a booking owner's quote responses", async () => {
  const { t, seed } = await seedQuoteAvailability();

  await expect(
    t
      .withIdentity(identityFor(seed.otherClerkId))
      .query(api.tire_quote_responses.listForBookingWithShops, {
        booking_id: seed.bookingId,
      }),
  ).rejects.toThrow("Booking not found");
});
