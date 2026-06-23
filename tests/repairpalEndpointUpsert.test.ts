import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";

describe("upsertRepairpalEndpointEstimate", () => {
  it("upserts one row per (config, service)", async () => {
    const t = makeT();

    const { configId, serviceId } = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "Toyota" });
      const modelId = await ctx.db.insert("models", {
        make_id: makeId,
        name: "Camry",
      });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2020_toyota_camry_le_2.5l_4cyl_gasoline",
        year: 2020,
        make_id: makeId,
        model_id: modelId,
      });
      const serviceId = await ctx.db.insert("services", {
        name: "Oil Change",
      });
      return { configId, serviceId };
    });

    const row = {
      vehicle_config_id: configId,
      service_id: serviceId,
      base_vehicle_id: 78290,
      labor_minutes: 30,
      labor_hours: 0.5,
      parts: [
        {
          role: "oil_filter",
          name: "Engine Oil Filter Element",
          price_low: 10,
          price_high: 14,
        },
      ],
      match_quality: "engine_sibling",
      matched_via: "750i xDrive",
      fetched_at: 1,
    };

    // First upsert — should INSERT
    await t.mutation(
      internal.vehicleEnrichment.repairpalEndpointMutations
        .upsertRepairpalEndpointEstimate,
      row,
    );

    // Second upsert — same (config, service), different labor_minutes — should PATCH
    await t.mutation(
      internal.vehicleEnrichment.repairpalEndpointMutations
        .upsertRepairpalEndpointEstimate,
      { ...row, labor_minutes: 36, fetched_at: 2 },
    );

    const rows = await t.run((ctx) =>
      ctx.db.query("repairpal_endpoint_estimates").collect(),
    );

    expect(rows.length).toBe(1);
    expect(rows[0].labor_minutes).toBe(36);
    expect(rows[0].match_quality).toBe("engine_sibling");
    expect(rows[0].matched_via).toBe("750i xDrive");
  });
});
