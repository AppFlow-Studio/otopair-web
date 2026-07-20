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

describe("trusted-row filter (740iA: unverified rows hid parts from backfill)", () => {
  test("a part with ONLY poison-type rows is selected as unpriced", async () => {
    const t = makeT();
    const { configId } = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "BMW" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "740i" });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2001_bmw_740i_test",
        year: 2001,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "partial",
      });

      // Only an "unverified" row → still unpriced for quoting purposes.
      const a = await ctx.db.insert("oem_parts", {
        oem_part_number: "34116761244", name: "Front Rotor", make_id: makeId, subcategory: "front_rotor",
      });
      await ctx.db.insert("part_fitments", { part_id: a, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: a, price: 90, price_type: "unverified" });

      // A trusted "sale" row alongside a poison row → excluded.
      const b = await ctx.db.insert("oem_parts", { oem_part_number: "B-2", name: "Healed part" });
      await ctx.db.insert("part_fitments", { part_id: b, vehicle_config_id: configId });
      await ctx.db.insert("part_prices", { part_id: b, price: 90, price_type: "unverified" });
      await ctx.db.insert("part_prices", { part_id: b, price: 85, price_type: "sale" });

      return { configId };
    });

    const parts = await t.query(internal.vehicleEnrichment.priceRefresh.zeroPricePartsForConfig, {
      vehicle_config_id: configId,
    });
    expect(parts.map((p: any) => p.oem_part_number)).toEqual(["34116761244"]);

    const page = await t.query(internal.vehicleEnrichment.priceRefresh.zeroPricePartsPage, {});
    expect(page.parts.map((p: any) => p.oem_part_number)).toEqual(["34116761244"]);
  });
});

describe("healPriceGaps — post-backfill gap reconciliation", () => {
  test("rewrites healed part_price gaps, keeps still-unpriced and non-price gaps", async () => {
    const { healPriceGaps } = await import("../convex/vehicleEnrichment/v3mutations");
    const gaps = [
      { field: "battery_oem", reason: "llm_null" },
      { field: "part_price:front_rotor", reason: "price_unverified_sources" },
      { field: "part_price:serpentine_belt", reason: "price_deferred_timeout" },
      { field: "part_price:cabin_filter", reason: "price_healed" },
    ];
    const out = healPriceGaps(gaps, ["front_rotor", "34116761244"]);
    const byField = new Map(out.map((g) => [g.field, g.reason]));
    expect(byField.get("battery_oem")).toBe("llm_null"); // untouched
    expect(byField.get("part_price:front_rotor")).toBe("price_unverified_sources"); // still unpriced
    expect(byField.get("part_price:serpentine_belt")).toBe("price_healed"); // priced now
    expect(byField.get("part_price:cabin_filter")).toBe("price_healed"); // idempotent
    expect(out).toHaveLength(4); // audit trail: never deletes entries
  });
});
