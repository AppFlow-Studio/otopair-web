/**
 * zeroPricePartsPage — selection for the nightly zero-price backfill.
 * A part with NO part_prices rows is invisible to the stale-refresh scan
 * (it paginates part_prices), so this query walks oem_parts instead.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

describe("priceRefresh.zeroPricePartsPage", () => {
  test("selects zero-price parts with fitments; excludes priced, fitment-less, and superseded parts", async () => {
    const t = makeT();
    const { configId } = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "GMC" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Sierra 1500" });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2023_gmc_sierra_test",
        year: 2023,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "complete",
      });

      // A: zero prices + fitment → SELECTED (with resolved make name)
      const a = await ctx.db.insert("oem_parts", {
        oem_part_number: "19432331", name: "Engine Oil", make_id: makeId, subcategory: "engine_oil",
      });
      await ctx.db.insert("part_fitments", { part_id: a, vehicle_config_id: configId });

      // B: has a price row → excluded
      const b = await ctx.db.insert("oem_parts", { oem_part_number: "B-1", name: "Priced part" });
      await ctx.db.insert("part_fitments", { part_id: b, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: b, price: 10, price_type: "sale" });

      // C: zero prices but no fitment → excluded
      await ctx.db.insert("oem_parts", { oem_part_number: "C-1", name: "Orphan part" });

      // D: superseded → excluded
      const d = await ctx.db.insert("oem_parts", {
        oem_part_number: "D-1", name: "Old part", is_current: false,
      });
      await ctx.db.insert("part_fitments", { part_id: d, vehicle_config_id: configId });

      return { configId };
    });

    const page = await t.query(internal.vehicleEnrichment.priceRefresh.zeroPricePartsPage, {});
    const oems = page.parts.map((p: any) => p.oem_part_number);
    expect(oems).toEqual(["19432331"]);
    expect(page.parts[0].make_name).toBe("GMC");
    expect(page.parts[0].name).toBe("Engine Oil");
    expect(page.parts[0].subcategory).toBe("engine_oil");
    void configId;
  });
});

describe("priceRefresh.zeroPricePartsForConfig", () => {
  test("returns only the config's zero-price current parts", async () => {
    const t = makeT();
    const { configId } = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "GMC" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Sierra 1500" });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2023_gmc_sierra_test",
        year: 2023,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "complete",
      });
      const otherConfig = await ctx.db.insert("vehicle_configs", {
        config_key: "2020_other_config",
        year: 2020,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "complete",
      });

      // In-config zero-price → selected.
      const a = await ctx.db.insert("oem_parts", { oem_part_number: "84320501", name: "Front Brake Pads", make_id: makeId });
      await ctx.db.insert("part_fitments", { part_id: a, vehicle_config_id: configId });
      // In-config priced → excluded.
      const b = await ctx.db.insert("oem_parts", { oem_part_number: "B-1", name: "Priced" });
      await ctx.db.insert("part_fitments", { part_id: b, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: b, price: 10, price_type: "sale" });
      // Zero-price but on ANOTHER config → excluded.
      const c = await ctx.db.insert("oem_parts", { oem_part_number: "C-1", name: "Other config part" });
      await ctx.db.insert("part_fitments", { part_id: c, vehicle_config_id: otherConfig });

      return { configId };
    });

    const parts = await t.query(internal.vehicleEnrichment.priceRefresh.zeroPricePartsForConfig, {
      vehicle_config_id: configId,
    });
    expect(parts.map((p: any) => p.oem_part_number)).toEqual(["84320501"]);
    expect(parts[0].make_name).toBe("GMC");
  });
});
