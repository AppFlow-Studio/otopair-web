import { afterEach, expect, test, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { identityFor, makeT } from "./helpers";

const NOW = new Date("2026-09-01T12:00:00-04:00");
const QUOTED_DATE = "2026-09-07";

afterEach(() => {
  vi.useRealTimers();
});

async function seedQuoteShop() {
  const t = makeT();
  const seed = await t.run(async (ctx) => {
    const ownerClerkId = "quote_hold_owner";
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: "quote-hold-owner@test.local",
      first_name: "Owner",
      role: "shop_owner",
    } as never);
    const customerId = await ctx.db.insert("users", {
      clerkUserId: "quote_hold_customer",
      email: "quote-hold-customer@test.local",
      first_name: "Customer",
      role: "user",
    } as never);
    const shopId = await ctx.db.insert("shops", {
      name: "Quote Hold Shop",
      owner_user_id: ownerId,
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

    return { ownerClerkId, customerId, shopId, mechanicId };
  });
  return { t, seed };
}

async function insertQuoteBooking(
  t: ReturnType<typeof makeT>,
  customerId: Id<"users">,
) {
  return t.run((ctx) =>
    ctx.db.insert("bookings", {
      user_id: customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: NOW.getTime(),
      updated_at: NOW.getTime(),
    } as never),
  );
}

test("tire and rotor quote creation hold their offered slots for ten minutes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const { t, seed } = await seedQuoteShop();
  const tireBookingId = await insertQuoteBooking(t, seed.customerId);
  const rotorBookingId = await insertQuoteBooking(t, seed.customerId);

  const tireResponseId = await t.mutation(api.tire_quote_responses.create, {
    booking_id: tireBookingId,
    shop_id: seed.shopId,
    mechanic_id: seed.mechanicId,
    tire_brand: "Michelin",
    per_tire_price: 100,
    quantity: 4,
    labor_cost: 100,
    total: 500,
    availability: { date: QUOTED_DATE, time: "09:00" },
    estimated_duration_minutes: 30,
  });
  const rotorResponseId = await t.mutation(api.rotor_quote_responses.create, {
    booking_id: rotorBookingId,
    shop_id: seed.shopId,
    mechanic_id: seed.mechanicId,
    rotor_brand: "Brembo",
    per_rotor_price: 120,
    quantity: 2,
    labor_cost: 150,
    total: 390,
    availability: { date: QUOTED_DATE, time: "10:00" },
    estimated_duration_minutes: 30,
  });

  const responses = await t.run(async (ctx) => ({
    tire: await ctx.db.get(tireResponseId),
    rotor: await ctx.db.get(rotorResponseId),
  }));
  const expectedExpiry = NOW.getTime() + 10 * 60 * 1000;
  expect(responses.tire?.expires_at).toBe(expectedExpiry);
  expect(responses.rotor?.expires_at).toBe(expectedExpiry);
});

test("schedule returns active tire and rotor holds but omits inactive holds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const { t, seed } = await seedQuoteShop();

  await t.run(async (ctx) => {
    const activeTireBookingId = await ctx.db.insert("bookings", {
      user_id: seed.customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: NOW.getTime(),
      updated_at: NOW.getTime(),
    } as never);
    const activeRotorBookingId = await ctx.db.insert("bookings", {
      user_id: seed.customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: NOW.getTime(),
      updated_at: NOW.getTime(),
    } as never);
    const expiredBookingId = await ctx.db.insert("bookings", {
      user_id: seed.customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: NOW.getTime(),
      updated_at: NOW.getTime(),
    } as never);
    const supersededBookingId = await ctx.db.insert("bookings", {
      user_id: seed.customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: NOW.getTime(),
      updated_at: NOW.getTime(),
    } as never);

    await ctx.db.insert("tire_quote_responses", {
      booking_id: activeTireBookingId,
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      tire_brand: "Michelin",
      per_tire_price: 100,
      quantity: 4,
      labor_cost: 100,
      total: 500,
      availability: { date: QUOTED_DATE, time: "09:00" },
      estimated_duration_minutes: 30,
      created_at: NOW.getTime(),
      expires_at: NOW.getTime() + 60_000,
    });
    await ctx.db.insert("rotor_quote_responses", {
      booking_id: activeRotorBookingId,
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      rotor_brand: "Brembo",
      per_rotor_price: 120,
      quantity: 2,
      labor_cost: 150,
      total: 390,
      availability: { date: QUOTED_DATE, time: "10:00" },
      estimated_duration_minutes: 60,
      created_at: NOW.getTime(),
      expires_at: NOW.getTime() + 60_000,
    });
    await ctx.db.insert("tire_quote_responses", {
      booking_id: expiredBookingId,
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      tire_brand: "Expired",
      per_tire_price: 100,
      quantity: 4,
      labor_cost: 100,
      total: 500,
      availability: { date: QUOTED_DATE, time: "11:00" },
      created_at: NOW.getTime() - 11 * 60 * 1000,
    });
    await ctx.db.insert("rotor_quote_responses", {
      booking_id: supersededBookingId,
      shop_id: seed.shopId,
      mechanic_id: seed.mechanicId,
      rotor_brand: "Superseded",
      per_rotor_price: 120,
      quantity: 2,
      labor_cost: 150,
      total: 390,
      availability: { date: QUOTED_DATE, time: "12:00" },
      created_at: NOW.getTime(),
      expires_at: NOW.getTime() + 60_000,
      superseded_at: NOW.getTime(),
    });
  });

  const events = await t
    .withIdentity(identityFor(seed.ownerClerkId))
    .query(api.schedule.getBookingsForRange, {
      dateFrom: QUOTED_DATE,
      dateTo: QUOTED_DATE,
    });

  expect(events.map((event) => event.source).sort()).toEqual(["rotor_quote", "tire_quote"]);
  expect(events.map((event) => event.serviceNames[0]).sort()).toEqual([
    "Rotor Replacement",
    "Tire Replacement",
  ]);
  expect(events.every((event) => event.status === "tentative_quote")).toBe(true);
  expect(events.every((event) => event.expiresAt === NOW.getTime() + 60_000)).toBe(true);
});
