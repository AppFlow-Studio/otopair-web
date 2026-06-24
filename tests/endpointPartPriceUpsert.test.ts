import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";

describe("upsertEndpointPartPrice", () => {
  it("inserts then updates one repairpal_endpoint row per part", async () => {
    const t = makeT();
    const partId = await t.run((ctx) =>
      ctx.db.insert("oem_parts", { oem_part_number: "P1", name: "Spark Plug", subcategory: "spark_plug" } as any),
    );
    await t.mutation(internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice, {
      part_id: partId, price: 9, source_url: "https://repairpal.com/x", refreshed_at: 1,
    });
    await t.mutation(internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice, {
      part_id: partId, price: 11, source_url: "https://repairpal.com/x", refreshed_at: 2,
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("part_prices").withIndex("by_part_source", (q) =>
        q.eq("part_id", partId).eq("source_domain", "repairpal_endpoint")).collect());
    expect(rows.length).toBe(1);
    expect(rows[0].price).toBe(11);
    expect(rows[0].price_type).toBe(REPAIRPAL_ENDPOINT_PRICE_TYPE);
    expect(rows[0].created_at).toBe(1); // insert-only: preserved from the first upsert
    expect(rows[0].refreshed_at).toBe(2); // updated by the patch
  });
});

describe("endpoint→fitment join (endpointPartPriceBackfill)", () => {
  it("matches an endpoint part to the config fitment by subcategory and writes avg/quantity", async () => {
    const t = makeT();
    const { configId, partId } = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "Toyota" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Camry" });
      const partId = await ctx.db.insert("oem_parts", { oem_part_number: "SP1", name: "Spark Plug", subcategory: "spark_plug" } as any);
      const configId = await ctx.db.insert("vehicle_configs", { config_key: "2021_toyota_camry", year: 2021, make_id: makeId, model_id: modelId } as any);
      const serviceId = await ctx.db.insert("services", { name: "Spark Plugs", slug: "spark_plugs" } as any);
      await ctx.db.insert("part_fitments", { part_id: partId, vehicle_config_id: configId, service_type: "spark_plugs", quantity_needed: 6 } as any);
      await ctx.db.insert("repairpal_endpoint_estimates", {
        vehicle_config_id: configId, service_id: serviceId, base_vehicle_id: 1, fetched_at: 1,
        parts: [{ role: "spark_plug", name: "Spark Plug", quantity: 6, price_low: 52.44, price_high: 71.56 }],
      } as any);
      return { configId, partId };
    });
    await t.action(internal.devOnly.endpointPartPriceBackfill.backfill, { configIds: [configId] });
    const rows = await t.run((ctx) =>
      ctx.db.query("part_prices").withIndex("by_part_source", (q) =>
        q.eq("part_id", partId).eq("source_domain", "repairpal_endpoint")).collect());
    expect(rows.length).toBe(1);
    // avg = (52.44+71.56)/2 = 62; per-unit = 62/6 ≈ 10.3333
    expect(rows[0].price).toBeCloseTo(62 / 6, 3);
  });

  it("skips an endpoint part whose role does not map to a subcategory (no row written)", async () => {
    const t = makeT();
    const { configId } = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "Toyota" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Camry" });
      const configId = await ctx.db.insert("vehicle_configs", { config_key: "2021_toyota_camry_skip", year: 2021, make_id: makeId, model_id: modelId } as any);
      const serviceId = await ctx.db.insert("services", { name: "Spark Plugs", slug: "spark_plugs" } as any);
      await ctx.db.insert("repairpal_endpoint_estimates", {
        vehicle_config_id: configId, service_id: serviceId, base_vehicle_id: 1, fetched_at: 1,
        parts: [{ role: "mystery_widget", name: "Mystery Widget", quantity: 2, price_low: 10, price_high: 20 }],
      } as any);
      return { configId };
    });
    const res: any = await t.action(internal.devOnly.endpointPartPriceBackfill.backfill, { configIds: [configId] });
    expect(res).toMatchObject({ written: 0 });
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const rows = await t.run((ctx) => ctx.db.query("part_prices").collect());
    expect(rows.length).toBe(0);
  });
});
