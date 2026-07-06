/**
 * markOnDemandIntervals — on-demand services (inspections, diagnostics,
 * alignment…) have no mileage schedule by nature; stamping status="on_demand"
 * makes them count as complete instead of permanently-missing (Jul 2026:
 * these were the Sierra's entire missing-intervals gap).
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { ON_DEMAND_SERVICE_SLUGS } from "../convex/vehicleEnrichment/types";

describe("v3mutations.markOnDemandIntervals", () => {
  test("stamps empty interval rows, inserts missing ones, never touches real data", async () => {
    const t = makeT();
    const ids = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "GMC" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Sierra 1500" });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2023_gmc_sierra_test",
        year: 2023,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "complete",
      });
      const alignment = await ctx.db.insert("services", {
        name: "Wheel Alignment", slug: "wheel_alignment",
      });
      const batteryTest = await ctx.db.insert("services", {
        name: "Battery Test", slug: "battery_test",
      });
      const oilChange = await ctx.db.insert("services", {
        name: "Oil Change", slug: "oil_change",
      });

      // Alignment has an EMPTY row (no miles/months/status) → gets stamped.
      const alignmentRow = await ctx.db.insert("service_intervals", {
        vehicle_config_id: configId, service_id: alignment, confidence: 0.5,
      });
      // Battery test has NO row → gets inserted.
      // Oil change has REAL interval data → untouched even if listed.
      const oilRow = await ctx.db.insert("service_intervals", {
        vehicle_config_id: configId, service_id: oilChange,
        interval_miles: 7500, status: "scheduled", confidence: 0.9,
      });
      return { configId, alignment, batteryTest, oilChange, alignmentRow, oilRow };
    });

    const res = await t.mutation(internal.vehicleEnrichment.v3mutations.markOnDemandIntervals, {
      vehicle_config_id: ids.configId,
      service_slugs: ["wheel_alignment", "battery_test", "oil_change", "nonexistent_service"],
    });
    expect(res.stamped).toBe(2);

    const rows = await t.run(async (ctx) => ctx.db.query("service_intervals").collect());
    const bySvc = new Map(rows.map((r: any) => [String(r.service_id), r]));
    expect(bySvc.get(String(ids.alignment))!.status).toBe("on_demand");
    expect(bySvc.get(String(ids.batteryTest))!.status).toBe("on_demand");
    const oil = bySvc.get(String(ids.oilChange))!;
    expect(oil.status).toBe("scheduled");
    expect(oil.interval_miles).toBe(7500);
  });

  test("ON_DEMAND_SERVICE_SLUGS covers the 8 known on-demand services", () => {
    expect([...ON_DEMAND_SERVICE_SLUGS].sort()).toEqual(
      [
        "battery_test",
        "check_engine_light",
        "diagnostic_scan",
        "emissions_test",
        "pre_purchase_inspection",
        "state_inspection",
        "tire_balance",
        "wheel_alignment",
      ].sort(),
    );
  });
});
