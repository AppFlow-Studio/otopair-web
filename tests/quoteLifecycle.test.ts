import { afterEach, expect, test, vi } from "vitest";

import { api } from "../convex/_generated/api";
import { identityFor, makeT } from "./helpers";

const NOW = new Date("2026-08-29T15:30:00-04:00");

afterEach(() => vi.useRealTimers());

async function seedLifecycle(quoteType: "tire" | "rotor") {
  const t = makeT();
  const seed = await t.run(async (ctx) => {
    const ownerClerkId = `${quoteType}-owner`;
    const customerClerkId = `${quoteType}-customer`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: `${ownerClerkId}@test.local`,
      first_name: "Owner",
      role: "shop_owner",
    } as never);
    const customerId = await ctx.db.insert("users", {
      clerkUserId: customerClerkId,
      email: `${customerClerkId}@test.local`,
      first_name: "Customer",
      role: "user",
    } as never);
    const shopId = await ctx.db.insert("shops", {
      name: "Lifecycle Shop",
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
      close_time: "23:00",
      is_closed: false,
    });
    const bookingId = await ctx.db.insert("bookings", {
      user_id: customerId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "quotes_ready",
      created_at: NOW.getTime(),
      updated_at: NOW.getTime(),
      ...(quoteType === "tire"
        ? {
            tire_specs: {
              size: "225/45R17",
              type: "all_season",
              tier: "good",
              quantity: 4,
              positions: ["FL", "FR", "RL", "RR"],
            },
          }
        : {
            rotor_specs: {
              brake_system_type: "standard",
              axle: "front",
              include_pads: false,
            },
          }),
    } as never);
    const common = {
      booking_id: bookingId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      quantity: quoteType === "tire" ? 4 : 2,
      labor_cost: 100,
      total: quoteType === "tire" ? 500 : 340,
      availability: { date: "2026-08-31", time: "20:00" },
      estimated_duration_minutes: 60,
      created_at: NOW.getTime(),
      expires_at: NOW.getTime() + 10 * 60_000,
      revision: 1,
    };
    const responseId = quoteType === "tire"
      ? await ctx.db.insert("tire_quote_responses", {
          ...common,
          tire_brand: "Michelin",
          per_tire_price: 100,
        })
      : await ctx.db.insert("rotor_quote_responses", {
          ...common,
          rotor_brand: "Brembo",
          per_rotor_price: 120,
        });
    return {
      ownerClerkId,
      customerClerkId,
      customerId,
      shopId,
      mechanicId,
      bookingId,
      responseId,
    };
  });
  return { t, seed };
}

for (const quoteType of ["tire", "rotor"] as const) {
  test(`${quoteType} quote reads as expired after ten minutes`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { t, seed } = await seedLifecycle(quoteType);
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const customer = t.withIdentity(identityFor(seed.customerClerkId));
    const quoteApi = quoteType === "tire"
      ? api.tire_quote_responses
      : api.rotor_quote_responses;

    vi.setSystemTime(NOW.getTime() + 10 * 60_000 + 1);

    const customerRows = await customer.query(quoteApi.listForBookingWithShops, {
      booking_id: seed.bookingId,
    } as never);
    expect(customerRows[0].quote_availability).toEqual({
      available: false,
      reason: "expired",
    });

    const requests = await owner.query(
      quoteType === "tire"
        ? api.bookings.listOpenTireQuoteRequestsForShop
        : api.bookings.listOpenRotorQuoteRequestsForShop,
      { shopId: seed.shopId },
    );
    expect(requests[0].quote_status).toBe("expired");
  });

  test(`${quoteType} quote can be cancelled and validates as cancelled`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { t, seed } = await seedLifecycle(quoteType);
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const customer = t.withIdentity(identityFor(seed.customerClerkId));
    const quoteApi = quoteType === "tire"
      ? api.tire_quote_responses
      : api.rotor_quote_responses;

    await owner.mutation(quoteApi.cancel, { response_id: seed.responseId } as never);
    const availability = await customer.query(quoteApi.validateForCheckout, {
      booking_id: seed.bookingId,
      response_id: seed.responseId,
      expected_revision: 1,
    } as never);

    expect(availability).toEqual({ available: false, reason: "cancelled" });

    const requests = await owner.query(
      quoteType === "tire"
        ? api.bookings.listOpenTireQuoteRequestsForShop
        : api.bookings.listOpenRotorQuoteRequestsForShop,
      { shopId: seed.shopId },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].quote_status).toBe("cancelled");
    expect(requests[0].quote_response?._id).toBe(seed.responseId);

    const customerRows = await customer.query(quoteApi.listForBookingWithShops, {
      booking_id: seed.bookingId,
    } as never);
    expect(customerRows).toHaveLength(1);
    expect(customerRows[0].quote_availability).toEqual({
      available: false,
      reason: "cancelled",
    });
  });

  test(`${quoteType} requote increments the internal revision and resets ten-minute expiry`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { t, seed } = await seedLifecycle(quoteType);
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const quoteApi = quoteType === "tire"
      ? api.tire_quote_responses
      : api.rotor_quote_responses;

    await owner.mutation(quoteApi.requote, {
      response_id: seed.responseId,
      mechanic_id: seed.mechanicId,
      labor_cost: 125,
      total: quoteType === "tire" ? 565 : 405,
      availability: { date: "2026-08-31", time: "21:00" },
      estimated_duration_minutes: 60,
      ...(quoteType === "tire"
        ? {
            tire_brand: "Continental",
            per_tire_price: 110,
            quantity: 4,
          }
        : {
            rotor_brand: "Bosch",
            per_rotor_price: 140,
            quantity: 2,
          }),
    } as never);

    const response = await t.run((ctx) => ctx.db.get(seed.responseId));
    expect(response?.revision).toBe(2);
    expect(response?.modified_at).toBe(NOW.getTime());
    expect(response?.expires_at).toBe(NOW.getTime() + 10 * 60_000);
    expect(response?.labor_cost).toBe(125);
  });

  test(`${quoteType} cancel and requote are locked while Review & Pay holds the quote`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { t, seed } = await seedLifecycle(quoteType);
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));
    const quoteApi = quoteType === "tire"
      ? api.tire_quote_responses
      : api.rotor_quote_responses;

    await t.run((ctx) =>
      ctx.db.insert("slot_holds", {
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        date: "2026-08-31",
        start_time: "20:00",
        end_time: "21:00",
        duration_minutes: 60,
        held_by: seed.customerId,
        session_id: `${quoteType}-review-pay`,
        expires_at: NOW.getTime() + 15 * 60_000,
        status: "active",
        created_at: NOW.getTime(),
        quote_type: quoteType,
        quote_revision: 1,
        ...(quoteType === "tire"
          ? { tire_quote_response_id: seed.responseId }
          : { rotor_quote_response_id: seed.responseId }),
      } as never),
    );

    const detail = await owner.query(quoteApi.getShopDetail, {
      response_id: seed.responseId,
    } as never);
    expect(detail?.checkout_held).toBe(true);
    expect(detail?.quote_status).toBe("pending");

    await expect(
      owner.mutation(quoteApi.cancel, { response_id: seed.responseId } as never),
    ).rejects.toMatchObject({ data: { code: "QUOTE_HELD" } });
    await expect(
      owner.mutation(quoteApi.requote, {
        response_id: seed.responseId,
        mechanic_id: seed.mechanicId,
        labor_cost: 125,
        total: 565,
        availability: { date: "2026-08-31", time: "21:00" },
        estimated_duration_minutes: 60,
        ...(quoteType === "tire"
          ? { tire_brand: "Continental", per_tire_price: 110, quantity: 4 }
          : { rotor_brand: "Bosch", per_rotor_price: 140, quantity: 2 }),
      } as never),
    ).rejects.toMatchObject({ data: { code: "QUOTE_HELD" } });
  });
}
