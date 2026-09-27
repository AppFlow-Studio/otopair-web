/**
 * Regression (item 7): an added off-catalog line that resolves to a catalog
 * service ALREADY BOOKED on the same booking must not read-fill that service's
 * OEM parts.
 *
 * The bug: "Cabin Air Filter" is booked (its parts live on the booked line,
 * service_id-stamped in priced_parts_snapshot). A separately-added off-catalog
 * line whose name resolves to the same catalog service got seeded/read-filled
 * with the SAME parts (via oemPartsForServiceOnVehicle). The identical part then
 * existed twice, and the post-job parts step's OEM-only dedup bound the booked
 * service's part to the ADDED job instead — "parts bind to the added job, not
 * the cabin-air-filter job." The fix skips the catalog part-fill when the
 * resolved service is already in booking.service_ids.
 *
 * Observed through listForBooking's read-time part fill (the guard mirror of the
 * add-time seed in addCustomServiceForBooking).
 */
import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { api } from "../convex/_generated/api";
import { recordCustomJobsForBooking } from "../convex/customJobs";

const SLUG = "cabin-air-filter";

/**
 * Seed the enrichment oemPartsForServiceOnVehicle needs to return a part: a make,
 * a vehicle_config on that make, a "Cabin Air Filter" service (slug drives the
 * part_fitments lookup), one make-correct oem_part, and its base fitment. Returns
 * the ids plus a shop/customer so bookings can be created.
 */
async function seedWorld(t: ReturnType<typeof makeT>, vin: string, tag: string) {
  return t.run(async (ctx: any) => {
    const now = Date.now();
    const makeId = await ctx.db.insert("makes", { name: "Honda" } as any);
    const modelId = await ctx.db.insert("models", {
      make_id: makeId,
      name: "Civic",
    } as any);
    const vehicleConfigId = await ctx.db.insert("vehicle_configs", {
      config_key: `2022_honda_civic_${tag}_${now}`,
      year: 2022,
      make_id: makeId,
      model_id: modelId,
    } as any);
    const serviceId = await ctx.db.insert("services", {
      name: "Cabin Air Filter",
      slug: SLUG,
      default_labor_hours: 0.5,
      created_at: now,
    } as any);
    const partId = await ctx.db.insert("oem_parts", {
      oem_part_number: "80292-OEM-A",
      name: "Cabin air filter",
      subcategory: "cabin_air_filter",
      category: "filter",
      make_id: makeId,
      data_quality: "oem",
    } as any);
    await ctx.db.insert("part_fitments", {
      part_id: partId,
      vehicle_config_id: vehicleConfigId,
      service_type: SLUG,
      confidence: 0.9,
      mechanic_verified: false,
      data_quality: "oem",
      created_at: now,
    } as any);
    // The canonical vehicle row (VIN → config) that oemPartsForServiceOnVehicle
    // and resolveVehicleConfigId both read.
    await ctx.db.insert("vehicles", {
      vin,
      vehicle_config_id: vehicleConfigId,
    } as any);

    const userId = await ctx.db.insert("users", {
      clerkUserId: `c_aspg_${tag}`,
      email: `aspg_${tag}@test.local`,
      role: "customer",
      createdAt: now,
    } as any);
    const shopId = await ctx.db.insert("shops", { name: "Test Shop" } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Mo",
      last_name: "R",
    } as any);
    return { makeId, vehicleConfigId, serviceId, partId, userId, shopId, mechanicId };
  });
}

async function makeBooking(
  t: ReturnType<typeof makeT>,
  world: any,
  vin: string,
  serviceIds: any[],
) {
  return t.run(async (ctx: any) =>
    ctx.db.insert("bookings", {
      vin,
      user_id: world.userId,
      shop_id: world.shopId,
      mechanic_id: world.mechanicId,
      service_ids: serviceIds,
      status: "in_progress",
    } as any),
  );
}

async function addCabinFilterLine(
  t: ReturnType<typeof makeT>,
  world: any,
  bookingId: any,
  vin: string,
) {
  // Off-catalog line, NO stored parts, so listForBooking's read-fill is the thing
  // exercised. Name resolves to the "Cabin Air Filter" catalog service.
  await t.run(async (ctx: any) =>
    recordCustomJobsForBooking(ctx, {
      booking: { _id: bookingId, shop_id: world.shopId, vin },
      mechanicId: world.mechanicId,
      customJobs: [
        {
          name: "Cabin air filter",
          system_tags: ["climate"],
          work_type: "replace",
        },
      ],
      source: "mid_job",
      now: Date.now(),
    }),
  );
}

describe("added-service parts guard (already-booked catalog service)", () => {
  it("does NOT read-fill parts when the added line resolves to a BOOKED service", async () => {
    const t = makeT();
    const vin = "CABINVINBOOKED";
    const world = await seedWorld(t, vin, "booked");
    // Cabin Air Filter IS booked on this booking.
    const bookingId = await makeBooking(t, world, vin, [world.serviceId]);
    await addCabinFilterLine(t, world, bookingId, vin);

    const lines = await t.query(api.customJobs.listForBooking, { bookingId });
    const line = lines.find((l: any) => l.name === "Cabin air filter");
    expect(line).toBeTruthy();
    // Guard: the parts already belong to the booked line — this added line stays
    // parts-less so the same part can't be re-bound to it.
    expect(line.parts).toEqual([]);
  });

  it("DOES read-fill parts when the same service is NOT booked (control)", async () => {
    const t = makeT();
    const vin = "CABINVINFREE";
    const world = await seedWorld(t, vin, "free");
    // Cabin Air Filter is NOT booked — the added line is the only place it lives.
    const bookingId = await makeBooking(t, world, vin, []);
    await addCabinFilterLine(t, world, bookingId, vin);

    const lines = await t.query(api.customJobs.listForBooking, { bookingId });
    const line = lines.find((l: any) => l.name === "Cabin air filter");
    expect(line).toBeTruthy();
    expect(line.parts.length).toBeGreaterThan(0);
    expect(line.parts[0].oem_number).toBe("80292-OEM-A");
  });
});
