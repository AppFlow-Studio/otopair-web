import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

// Bug #436: the reschedule decision mutations had no login check, so anyone
// could approve or decline a reschedule on someone else's booking (or withdraw
// a shop's proposal). The quote-request creators trusted a client-supplied
// user_id the same way.

async function seedProposal() {
  const t = makeT();
  const seed = await seedConfirmedBooking(t, {
    scheduledDate: "2026-05-19",
    scheduledTime: "14:00",
    seedWideOpenHours: true,
  });
  const strangerClerkId = `clerk_stranger_${Math.random().toString(36).slice(2)}`;
  const strangerId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      clerkUserId: strangerClerkId,
      email: "stranger@test.local",
      first_name: "Stranger",
      role: "user",
      createdAt: Date.now(),
    }),
  );
  await t.withIdentity(identityFor(seed.ownerClerkId)).mutation(api.bookings.proposeReschedule, {
    bookingId: seed.bookingId,
    newScheduledDate: "2026-05-20",
    newScheduledTime: "10:00",
  });
  return { t, seed, strangerClerkId, strangerId };
}

async function statusOf(t: ReturnType<typeof makeT>, bookingId: any) {
  return await t.run(async (ctx) => (await ctx.db.get(bookingId))?.status);
}

describe("reschedule decisions require the right caller", () => {
  test("a signed-out caller cannot approve", async () => {
    const { t, seed } = await seedProposal();
    await expect(
      t.mutation(api.bookings.customerApproveReschedule, { bookingId: seed.bookingId }),
    ).rejects.toThrow();
    expect(await statusOf(t, seed.bookingId)).toBe("pending_customer_acceptance");
  });

  test("another customer cannot approve or decline", async () => {
    const { t, seed, strangerClerkId } = await seedProposal();
    const asStranger = t.withIdentity(identityFor(strangerClerkId));
    await expect(
      asStranger.mutation(api.bookings.customerApproveReschedule, { bookingId: seed.bookingId }),
    ).rejects.toThrow("Not your booking.");
    await expect(
      asStranger.mutation(api.bookings.customerDeclineReschedule, { bookingId: seed.bookingId }),
    ).rejects.toThrow("Not your booking.");
    expect(await statusOf(t, seed.bookingId)).toBe("pending_customer_acceptance");
  });

  test("the booking's customer can decline", async () => {
    const { t, seed } = await seedProposal();
    await t.withIdentity(identityFor(seed.customerClerkId)).mutation(
      api.bookings.customerDeclineReschedule,
      { bookingId: seed.bookingId },
    );
    expect(await statusOf(t, seed.bookingId)).toBe("confirmed");
  });

  test("only the shop's staff can withdraw the proposal", async () => {
    const { t, seed, strangerClerkId } = await seedProposal();
    await expect(
      t.withIdentity(identityFor(strangerClerkId)).mutation(
        api.bookings.shopCancelReschedule,
        { bookingId: seed.bookingId },
      ),
    ).rejects.toThrow("Not authorized for this shop");
    await expect(
      t.withIdentity(identityFor(seed.customerClerkId)).mutation(
        api.bookings.shopCancelReschedule,
        { bookingId: seed.bookingId },
      ),
    ).rejects.toThrow("Not authorized for this shop");
    expect(await statusOf(t, seed.bookingId)).toBe("pending_customer_acceptance");

    await t.withIdentity(identityFor(seed.ownerClerkId)).mutation(
      api.bookings.shopCancelReschedule,
      { bookingId: seed.bookingId },
    );
    expect(await statusOf(t, seed.bookingId)).toBe("confirmed");
  });
});

describe("quote requests are created for the caller only", () => {
  const tireSpecs = {
    size: "225/45R17",
    type: "all_season",
    tier: "standard",
    quantity: 2,
    positions: ["FL" as const, "FR" as const],
  };
  const rotorSpecs = {
    brake_system_type: "standard" as const,
    axle: "front" as const,
    include_pads: true,
  };

  test("cannot file a quote request under another user's id", async () => {
    const { t, seed, strangerClerkId } = await seedProposal();
    const asStranger = t.withIdentity(identityFor(strangerClerkId));
    await expect(
      asStranger.mutation(api.bookings.createTireQuoteRequest, {
        user_id: seed.customerId,
        vin: "1HGCM82633A004352",
        tire_specs: tireSpecs,
      }),
    ).rejects.toThrow("another user");
    await expect(
      asStranger.mutation(api.bookings.createRotorQuoteRequest, {
        user_id: seed.customerId,
        vin: "1HGCM82633A004352",
        rotor_specs: rotorSpecs,
      }),
    ).rejects.toThrow("another user");
  });

  test("can file one for yourself", async () => {
    const { t, strangerClerkId, strangerId } = await seedProposal();
    const bookingId = await t.withIdentity(identityFor(strangerClerkId)).mutation(
      api.bookings.createTireQuoteRequest,
      { user_id: strangerId, vin: "1HGCM82633A004352", tire_specs: tireSpecs },
    );
    expect(await statusOf(t, bookingId)).toBe("pending_quote");
  });
});
