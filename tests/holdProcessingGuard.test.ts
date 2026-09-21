import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

describe("hold-processing guard", () => {
  test("keeps an in-range pre-job estimate non-startable until its hold update finishes", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "vehicle_at_shop" });
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.bookingId, {
        disclosed_range_low_cents: 10_000,
        disclosed_range_high_cents: 10_000,
      });
    });

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.booking_approvals.submitPreJobEstimate, {
        bookingId: seed.bookingId,
        parts: [],
        laborHours: 0.5,
        laborRateCents: 10_000,
      });

    const booking = (await t.run((ctx) => ctx.db.get(seed.bookingId))) as unknown as {
      payment_approval_state?: string;
    } | null;
    expect(booking?.payment_approval_state).toBe("hold_processing");
  });
});
