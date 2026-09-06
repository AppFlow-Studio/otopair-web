import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";
import { deriveTierInspectionScope } from "../lib/inspection-template";

/**
 * A brake/rotor service added off-catalog ("Add to this job", pre- or mid-job)
 * lands in custom_services, NOT service_ids, so it carries no
 * selected_service_options to read an axle from. Before this fix the inspection
 * flagged the booking as brake work (from the service-name list) but
 * resolveBrakeScopeForBooking — which only read service_ids — returned an empty
 * axle scope, dead-ending the mechanic on "Brake service is missing its required
 * axle selection." The add now stamps an axle (default "both") on the line and
 * the resolver folds custom_services in, so the scope is real again.
 */
describe("off-catalog brake work carries an axle scope", () => {
  it("defaults a mid-job brake pad line to both axles — and clears the inspection dead-end", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "in_progress" });
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));

    // Baseline: the seeded booking has no brake work.
    const before = await owner.query(api.serviceParts.getBrakeScopeForBooking, {
      bookingId: seed.bookingId,
    });
    expect(before).toMatchObject({ hasBrakeWork: false });

    // Add a brake pad replacement the way "Add to this job" does — no axle
    // passed, mirroring a mechanic who tapped straight through.
    await owner.mutation(api.customJobs.addMidJobCustomService, {
      bookingId: seed.bookingId,
      name: "Brake Pad Replacement",
      systemTags: ["brakes"],
      workType: "replace",
    });

    const scope = await owner.query(api.serviceParts.getBrakeScopeForBooking, {
      bookingId: seed.bookingId,
    });
    // Smart default: brake work with no explicit pick scopes to both axles.
    expect(scope).toMatchObject({
      hasBrakeWork: true,
      front: true,
      rear: true,
    });

    // The whole point: that scope no longer trips the inspection's axle gate.
    const result = deriveTierInspectionScope({
      serviceNames: ["Brake Pad Replacement"],
      brakeScope: scope,
    });
    expect(result.bookingScopeError).toBeNull();
    expect(result.tier2Corners.sort()).toEqual(["FL", "FR", "RL", "RR"]);
  });

  it("honors an explicit axle pick (rear only) on the added line", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "in_progress" });
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));

    await owner.mutation(api.customJobs.addMidJobCustomService, {
      bookingId: seed.bookingId,
      name: "Rotor Replacement",
      systemTags: ["brakes"],
      workType: "replace",
      axle: "rear",
    });

    const scope = await owner.query(api.serviceParts.getBrakeScopeForBooking, {
      bookingId: seed.bookingId,
    });
    expect(scope).toMatchObject({
      hasBrakeWork: true,
      front: false,
      rear: true,
    });

    const result = deriveTierInspectionScope({
      serviceNames: ["Rotor Replacement"],
      brakeScope: scope,
    });
    expect(result.bookingScopeError).toBeNull();
    // Rear axle only → just the two rear corners are graded.
    expect(result.tier2Corners.sort()).toEqual(["RL", "RR"]);
  });

  it("stamps the axle on the custom_jobs row too", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "in_progress" });
    const owner = t.withIdentity(identityFor(seed.ownerClerkId));

    await owner.mutation(api.customJobs.addMidJobCustomService, {
      bookingId: seed.bookingId,
      name: "Brake Pad Replacement",
      systemTags: ["brakes"],
      workType: "replace",
      axle: "front",
    });

    const row = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("custom_jobs")
        .withIndex("by_booking", (q) => q.eq("booking_id", seed.bookingId))
        .collect();
      return rows[0];
    });
    expect(row?.axle).toBe("front");
  });
});
