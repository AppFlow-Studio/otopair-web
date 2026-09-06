/**
 * A customer requesting their car back (requestCancellationAtShop) used to
 * reach only the front desk. The assigned mechanic — who physically has the
 * car mid-job — got nothing. This pins the added leg: an SMS row to the
 * mechanic's own user, carrying the car + who's asking, without dropping the
 * existing front-desk notification.
 */
import { describe, it, expect } from "vitest";
import { makeT, identityFor } from "./helpers";
import { api } from "../convex/_generated/api";

const CUSTOMER = "clerk_pickup_customer";

async function seedPickup(t: ReturnType<typeof makeT>) {
  return t.run(async (ctx: any) => {
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: "clerk_pickup_owner",
      email: "owner@test.local",
      role: "shop_owner",
      createdAt: Date.now(),
    });
    const customerId = await ctx.db.insert("users", {
      clerkUserId: CUSTOMER,
      email: "customer@test.local",
      role: "user",
      createdAt: Date.now(),
    });
    const mechUserId = await ctx.db.insert("users", {
      clerkUserId: "clerk_pickup_mech",
      email: "mech@test.local",
      role: "shop_mechanic",
      phone: "+15551234567",
      createdAt: Date.now(),
    });
    const shopId = await ctx.db.insert("shops", {
      name: "Downtown Auto",
      owner_user_id: ownerId,
    } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Marcus",
      last_name: "T",
    } as any);
    await ctx.db.insert("shop_users", {
      user_id: mechUserId,
      shop_id: shopId,
      role: "shop_mechanic",
      mechanic_id: mechanicId,
      is_active: true,
    } as any);
    await ctx.db.insert("vehicles", {
      vin: "VINPICKUP01",
      metadata: { make: "Acura", model: "TL" },
      year: 2011,
    } as any);
    const bookingId = await ctx.db.insert("bookings", {
      vin: "VINPICKUP01",
      user_id: customerId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      service_ids: [],
      status: "vehicle_at_shop",
    } as any);
    return { ownerId, customerId, mechUserId, shopId, mechanicId, bookingId };
  });
}

describe("requestCancellationAtShop alerts the mechanic", () => {
  it("enqueues an SMS to the assigned mechanic's user with the car", async () => {
    const t = makeT();
    const base = await seedPickup(t);

    await t
      .withIdentity(identityFor(CUSTOMER))
      .mutation(api.bookings.requestCancellationAtShop, {
        bookingId: base.bookingId,
      });

    const outbox: any[] = await t.run(async (ctx: any) =>
      ctx.db.query("notification_outbox").collect(),
    );

    const sms = outbox.find(
      (r) => r.channel === "sms" && r.category === "mechanic_pickup_request",
    );
    expect(sms).toBeTruthy();
    // Targets the mechanic's USER (SMS resolves users.phone), not the mechanics row.
    expect(String(sms.user_id)).toBe(String(base.mechUserId));
    expect(sms.payload.vehicleLabel).toBe("2011 Acura TL");

    // The front-desk notification is still sent — the mechanic leg is additive.
    expect(
      outbox.some(
        (r) =>
          r.channel === "front_desk" &&
          r.category === "customer_cancel_pickup_request",
      ),
    ).toBe(true);
  });

  it("skips the mechanic SMS when no mechanic is assigned", async () => {
    const t = makeT();
    const base = await seedPickup(t);
    await t.run(async (ctx: any) =>
      ctx.db.patch(base.bookingId, { mechanic_id: undefined }),
    );

    await t
      .withIdentity(identityFor(CUSTOMER))
      .mutation(api.bookings.requestCancellationAtShop, {
        bookingId: base.bookingId,
      });

    const outbox: any[] = await t.run(async (ctx: any) =>
      ctx.db.query("notification_outbox").collect(),
    );
    expect(outbox.some((r) => r.channel === "sms")).toBe(false);
    // Front desk still hears about it.
    expect(outbox.some((r) => r.channel === "front_desk")).toBe(true);
  });
});
