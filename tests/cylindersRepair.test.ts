import { describe, expect, it } from "vitest";
import {
  cylindersSuspect,
  resolveCylindersRepair,
  sanitizeCylinders,
} from "../convex/vehicleEnrichment/cylindersRepair";

describe("sanitizeCylinders", () => {
  it("admits integers 2-16 and nothing else", () => {
    expect(sanitizeCylinders(6)).toBe(6);
    expect(sanitizeCylinders(3.5)).toBeUndefined(); // the mirror signature
    expect(sanitizeCylinders(0)).toBeUndefined();
    expect(sanitizeCylinders(17)).toBeUndefined();
    expect(sanitizeCylinders("8")).toBe(8);
    expect(sanitizeCylinders(null)).toBeUndefined();
  });
});

describe("resolveCylindersRepair — census classes from the Aug 2026 dry run", () => {
  it("Ford Cyclone V6: cyl=3.5 mirror, plugs=6 is the true count", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 3.5, displacement_l: 3.5, engine_code: "99B", configuration: "V", spark_plug_quantity: 6, fuel_type: "Gasoline" },
      null,
    );
    expect(plan).toMatchObject({ verdict: "repair", proposed: 6, clearPlugs: false });
  });

  it("M177 with plugs also mirrored (plugs=4): family table wins, plugs cleared", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 4, displacement_l: 4, engine_code: "M177", configuration: "V", spark_plug_quantity: 4, fuel_type: "Gasoline" },
      null,
    );
    expect(plan.verdict).toBe("repair");
    expect(plan.proposed).toBe(8);
    expect(plan.clearPlugs).toBe(true);
  });

  it("M177 with healthy plugs=8: plugs corroborate", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 4, displacement_l: 4, engine_code: "M177", configuration: "V", spark_plug_quantity: 8, fuel_type: "Gasoline" },
      null,
    );
    expect(plan).toMatchObject({ verdict: "repair", proposed: 8 });
  });

  it("EPA outranks everything", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 2.7, displacement_l: 2.7, engine_code: "EcoBoost", spark_plug_quantity: 6, fuel_type: "Gasoline" },
      6,
    );
    expect(plan).toMatchObject({ verdict: "repair", proposed: 6 });
    expect(plan.reason).toContain("epa");
  });

  it("6.7 Power Stroke diesel: no plugs, family table resolves the V8", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 6.7, displacement_l: 6.7, engine_code: "6.7l_6.7cyl Power Stroke", configuration: "V", fuel_type: "Diesel" },
      null,
    );
    expect(plan).toMatchObject({ verdict: "repair", proposed: 8 });
  });

  it("unknown descriptor cyl=0 with no corroboration clears", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 0, engine_code: "unknownl_unknowncyl" },
      null,
    );
    expect(plan.verdict).toBe("clear");
  });

  it("2l_2cyl with plugs=2 (both mirrored, no family): clears both", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 2, displacement_l: 2, engine_code: "2l_2cyl", configuration: "V", spark_plug_quantity: 2, fuel_type: "Gasoline" },
      null,
    );
    expect(plan.verdict).toBe("clear");
    expect(plan.clearPlugs).toBe(true);
  });

  it("plugs-vs-family disagreement goes to review, never auto-writes", () => {
    const plan = resolveCylindersRepair(
      { cylinders: 3.5, displacement_l: 3.5, engine_code: "99B", configuration: "V", spark_plug_quantity: 8, fuel_type: "Gasoline" },
      null,
    );
    expect(plan.verdict).toBe("review");
  });

  it("healthy engines and verified fields are untouched", () => {
    expect(
      resolveCylindersRepair(
        { cylinders: 6, displacement_l: 3, engine_code: "M276", configuration: "V", spark_plug_quantity: 6 },
        null,
      ).verdict,
    ).toBe("ok");
    expect(
      resolveCylindersRepair(
        { cylinders: 4, displacement_l: 4, engine_code: "M177", verified_fields: ["cylinders"] },
        null,
      ).verdict,
    ).toBe("ok");
  });

  it("a genuine 3.0L I6 (S58) integer-mirror is caught via the low-cyl rule", () => {
    const signals = cylindersSuspect({ cylinders: 3, displacement_l: 3, engine_code: "S58B30T0" });
    expect(signals).toContain("mirrors_displacement");
    const plan = resolveCylindersRepair(
      { cylinders: 3, displacement_l: 3, engine_code: "S58B30T0" },
      null,
    );
    expect(plan).toMatchObject({ verdict: "repair", proposed: 6 });
  });
});
