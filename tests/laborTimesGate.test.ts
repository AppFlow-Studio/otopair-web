/**
 * Booking-time labor resolver quality gate (Jun-9 review: "the two labor
 * resolvers disagree — laborTimes.ts ungated vs quoteEngine").
 *
 * Contract under test: getLaborHoursForServices applies the SAME
 * isHighQualityVdb gate as the quote engine to book_hours rows — a clone or
 * training-data guess must not surface as "vehicle_specific_book" in the
 * booking UI while the quote engine refuses to quote it. Empirical hours
 * remain trusted (the aggregator gates them upstream at
 * LABOR_EMPIRICAL_MIN_SAMPLES and clears below).
 */
import { describe, test, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

async function seedWorld(
  t: ReturnType<typeof makeT>,
  laborRow: Record<string, unknown> | null,
  opts: { round_labor_times_to_15min?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkUserId: `clerk_${now}`,
      email: "labor@test.local",
      role: "user",
      createdAt: now,
    });
    const makeId = await ctx.db.insert("makes", { name: "Testmake" });
    const modelId = await ctx.db.insert("models", {
      make_id: makeId,
      name: "Testmodel",
    });
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "2020_testmake_testmodel_base_x1",
      year: 2020,
      make_id: makeId,
      model_id: modelId,
      enrichment_status: "complete",
    });
    const vin = "WBA7U2C08LGM27817";
    await ctx.db.insert("vehicles", { vin, vehicle_config_id: configId });
    const ownerId = await ctx.db.insert("vehicle_owners", {
      vin,
      user_id: userId,
      status: "active",
    });
    const serviceId = await ctx.db.insert("services", {
      name: "Spark plugs",
      slug: "spark_plugs",
      default_labor_hours: 1.0,
      created_at: now,
    } as any);
    if (laborRow) {
      await ctx.db.insert("labor_times", {
        vehicle_config_id: configId,
        service_id: serviceId,
        ...laborRow,
      } as any);
    }
    if (opts.round_labor_times_to_15min !== undefined) {
      await ctx.db.insert("director_settings", {
        key: "global",
        round_labor_times_to_15min: opts.round_labor_times_to_15min,
        updated_at: now,
      } as any);
    }
    return { ownerId, serviceId, configId };
  });
}

describe("getLaborHoursForServices quality gate", () => {
  test("a disqualified book row (training_data guess) falls to the service default", async () => {
    const t = makeT();
    const { ownerId, serviceId } = await seedWorld(t, {
      book_hours: 3.2,
      source: "training_data",
      confidence: 0.75,
    });

    const out = await t.query(api.laborTimes.getLaborHoursForServices, {
      vehicleOwnerId: ownerId,
      serviceIds: [serviceId],
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("default");
    expect(out[0].hours).toBe(1.0);
  });

  test("a high-quality aggregated row quotes as vehicle-specific book hours", async () => {
    const t = makeT();
    const { ownerId, serviceId } = await seedWorld(
      t,
      {
        book_hours: 2.1,
        source: "aggregated",
        data_quality: "aggregated",
        confidence: 0.9,
      },
      { round_labor_times_to_15min: false },
    );

    const out = await t.query(api.laborTimes.getLaborHoursForServices, {
      vehicleOwnerId: ownerId,
      serviceIds: [serviceId],
    });
    expect(out[0].source).toBe("vehicle_specific_book");
    expect(out[0].hours).toBe(2.1);
  });

  test("upstream-gated empirical hours stay preferred over book hours", async () => {
    const t = makeT();
    const { ownerId, serviceId } = await seedWorld(t, {
      book_hours: 2.1,
      empirical_hours: 2.5,
      empirical_sample_size: 4,
      source: "aggregated",
      data_quality: "aggregated",
      confidence: 0.9,
    });

    const out = await t.query(api.laborTimes.getLaborHoursForServices, {
      vehicleOwnerId: ownerId,
      serviceIds: [serviceId],
    });
    expect(out[0].source).toBe("vehicle_specific_empirical");
    expect(out[0].hours).toBe(2.5);
  });
});
