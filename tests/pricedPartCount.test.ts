/**
 * getPricedPartCount poison exclusion (Jun-9 review, medium): every "priced
 * parts" coverage metric counted poison rows (online_discount / you_save /
 * unverified) as priced — fill_rate was inflated and backfills skipped
 * exactly the parts that were actually broken.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { ESTIMATOR_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";

describe("getPricedPartCount", () => {
  test("counts only parts with at least one non-poison price row", async () => {
    const t = makeT();
    const { configId } = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "Testmake" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Testmodel" });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2020_testmake_testmodel_base_x1",
        year: 2020,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "complete",
      });
      const mkPart = async (oem: string) =>
        ctx.db.insert("oem_parts", { oem_part_number: oem, name: `part ${oem}` });

      // A: poison-only — must NOT count.
      const a = await mkPart("A-1");
      await ctx.db.insert("part_fitments", { part_id: a, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: a, price: 17.48, price_type: "online_discount" });

      // B: poison + a real sale row — counts.
      const b = await mkPart("B-1");
      await ctx.db.insert("part_fitments", { part_id: b, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: b, price: 12.0, price_type: "online_discount" });
      await ctx.db.insert("part_prices", { part_id: b, price: 34.97, price_type: "sale" });

      // C: legacy untyped row — trusted by the aggregator, counts.
      const c = await mkPart("C-1");
      await ctx.db.insert("part_fitments", { part_id: c, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: c, price: 9.99 });

      // D: no price rows — doesn't count.
      const d = await mkPart("D-1");
      await ctx.db.insert("part_fitments", { part_id: d, vehicle_config_id: configId });

      // E: estimator_endpoint fallback only — NOT a real SKU price, must NOT count
      // (else the pipeline would skip fetching a real price for it).
      const e = await mkPart("E-1");
      await ctx.db.insert("part_fitments", { part_id: e, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: e, price: 10.33, price_type: ESTIMATOR_ENDPOINT_PRICE_TYPE, source_domain: "estimator_endpoint" });

      return { configId };
    });

    const priced = await t.query(
      internal.vehicleEnrichment.v3queries.getPricedPartCount,
      { vehicleConfigId: configId },
    );
    expect(priced).toBe(2); // B (sale) + C (legacy untyped); A poison-only, D unpriced, E endpoint-only
  });
});
