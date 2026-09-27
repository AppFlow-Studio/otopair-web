/**
 * The pre-job estimate dialog pre-fills each service's labor from
 * `getJobDetail().bookingServiceLines[].est_labor_minutes`. For a single-service
 * booking that must be the labor the CUSTOMER WAS QUOTED (stamped on the booking),
 * not a fresh recompute off the catalog default.
 *
 * Bug: a GLE Diagnostic Scan was booked at 1 hr ($165.85), but the dialog showed
 * 0.5 hr because the per-service fallback used the service's catalog
 * `default_labor_hours` (0.5) instead of the booked 60 min — under-pricing the
 * diagnostic when scope was added.
 */
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

describe("pre-job labor pre-fill", () => {
  test("single-service line pre-fills the booked labor, not the catalog default", async () => {
    const t = makeT();
    // Booked at 1 hr; catalog default is 0.5 hr (the diagnostic mismatch).
    const seed = await seedConfirmedBooking(t, { estimatedLaborMinutes: 60 });
    await t.run(async (ctx) => {
      const b: any = await ctx.db.get(seed.bookingId);
      await ctx.db.patch(b.service_ids[0], { default_labor_hours: 0.5 } as any);
    });

    const detail: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getJobDetail, { bookingId: seed.bookingId });

    const line = (detail?.bookingServiceLines ?? [])[0];
    // Booked 1 hr (60 min), NOT the 30 min the 0.5 catalog default would give.
    expect(line?.est_labor_minutes).toBe(60);
  });
});
