/**
 * P0 + P1(start) of variant identification: the fingerprint assembler + the
 * fuel-class authority classifier. Pure, fail-open, behavior-neutral scaffold.
 */
import { describe, expect, test } from "vitest";
import {
  classifyFuelClass,
  fuelClassHasNoSparkIgnition,
  assembleVariantFingerprint,
  type FingerprintInputs,
} from "../convex/vehicleEnrichment/variantFingerprint";

describe("classifyFuelClass — the spark-vs-no-spark authority", () => {
  test("diesel and BEV are the no-spark classes", () => {
    expect(classifyFuelClass("Diesel")).toBe("diesel");
    expect(classifyFuelClass("Diesel Fuel")).toBe("diesel");
    expect(classifyFuelClass("Electric")).toBe("bev");
    expect(classifyFuelClass("BEV")).toBe("bev");
    expect(fuelClassHasNoSparkIgnition("diesel")).toBe(true);
    expect(fuelClassHasNoSparkIgnition("bev")).toBe(true);
  });

  test("spark-ignition classes are NOT suppressed", () => {
    expect(classifyFuelClass("Gasoline")).toBe("gasoline");
    expect(fuelClassHasNoSparkIgnition("gasoline")).toBe(false);
    expect(fuelClassHasNoSparkIgnition("hybrid")).toBe(false);
    expect(fuelClassHasNoSparkIgnition("phev")).toBe(false);
  });

  test("hybrids and PHEVs classify without being suppressed", () => {
    expect(classifyFuelClass("Gasoline/Electric Hybrid")).toBe("hybrid");
    expect(classifyFuelClass("Plug-in Hybrid Electric")).toBe("phev");
    expect(classifyFuelClass("Flexible Fuel (FFV)")).toBe("flex");
  });

  test("CNG/hydrogen → other (not mistaken for gasoline-spark)", () => {
    expect(classifyFuelClass("Compressed Natural Gas (CNG)")).toBe("other");
    expect(classifyFuelClass("Fuel Cell")).toBe("other");
  });

  test("fails open to null on unknown/empty", () => {
    expect(classifyFuelClass(null)).toBe(null);
    expect(classifyFuelClass("")).toBe(null);
    expect(classifyFuelClass("???")).toBe(null);
    expect(fuelClassHasNoSparkIgnition(null)).toBe(false);
  });
});

function baseInputs(over: Partial<FingerprintInputs> = {}): FingerprintInputs {
  return {
    make: "Jeep", model: "Wrangler", model_year: 2021,
    engine_code: "ERC", engine_code_verified: false,
    raw_fuel_type: "Diesel", aspiration: "turbo",
    displacement_l: 3.0, cylinders: 6, engine_manufacturer: "VM Motori",
    transmission_family: "automatic", speeds: 8,
    drivetrain: "4WD", gvwr_lbs: 6000,
    ...over,
  };
}

describe("assembleVariantFingerprint — consolidation + fail-open", () => {
  test("the batch-8 Wrangler EcoDiesel: diesel fuel_class established", () => {
    const fp = assembleVariantFingerprint(baseInputs());
    expect(fp.fuel_class.value).toBe("diesel");
    expect(fp.transmission_family.value).toBe("automatic");
    expect(fp.drivetrain.value).toBe("4WD");
    expect(fp.duty_class.value).toBe("light"); // 6000 GVWR
    expect(fp.make).toBe("Jeep");
  });

  test("verified engine code raises confidence + source", () => {
    const plain = assembleVariantFingerprint(baseInputs({ engine_code_verified: false }));
    const verified = assembleVariantFingerprint(baseInputs({ engine_code_verified: true }));
    expect(plain.engine_code.source).toBe("nhtsa");
    expect(verified.engine_code.source).toBe("verified");
    expect(verified.engine_code.confidence).toBeGreaterThan(plain.engine_code.confidence);
  });

  test("null inputs fail open — facet value null, confidence 0, source none", () => {
    const fp = assembleVariantFingerprint(
      baseInputs({ engine_code: null, raw_fuel_type: null, drivetrain: null, gvwr_lbs: null }),
    );
    expect(fp.engine_code.value).toBe(null);
    expect(fp.engine_code.confidence).toBe(0);
    expect(fp.engine_code.source).toBe("none");
    expect(fp.fuel_class.value).toBe(null);
    expect(fp.drivetrain.value).toBe(null);
    expect(fp.duty_class.value).toBe(null);
  });

  test("badge-engineering seed: engine_manufacturer differing from make seeds build_source", () => {
    // 2020 Yaris = Toyota make, Mazda-built.
    const fp = assembleVariantFingerprint(
      baseInputs({ make: "Toyota", model: "Yaris", engine_manufacturer: "Mazda", raw_fuel_type: "Gasoline" }),
    );
    expect(fp.build_source_make.value).toBe("Mazda");
    expect(fp.build_source_make.source).toBe("seed_engine_mfr");
  });

  test("same-brand engine manufacturer does NOT seed a foreign build source", () => {
    const fp = assembleVariantFingerprint(
      baseInputs({ make: "Toyota", engine_manufacturer: "Toyota Motor Manufacturing", raw_fuel_type: "Gasoline" }),
    );
    expect(fp.build_source_make.value).toBe(null);
  });

  test("same-FAMILY brand engine manufacturer does NOT seed (Lexus on a Toyota)", () => {
    const fp = assembleVariantFingerprint(
      baseInputs({ make: "Toyota", engine_manufacturer: "Lexus", raw_fuel_type: "Gasoline" }),
    );
    expect(fp.build_source_make.value).toBe(null);
  });

  test("transmission_unit_code is fail-open null in P0 (filled by P3)", () => {
    const fp = assembleVariantFingerprint(baseInputs());
    expect(fp.transmission_unit_code.value).toBe(null);
  });

  test("overall_identity_confidence is the mean of established facets (0 when empty)", () => {
    const full = assembleVariantFingerprint(baseInputs());
    expect(full.overall_identity_confidence).toBeGreaterThan(0);
    const empty = assembleVariantFingerprint(
      baseInputs({
        engine_code: null, raw_fuel_type: null, aspiration: null, displacement_l: null,
        cylinders: null, engine_manufacturer: null, transmission_family: null,
        speeds: null, drivetrain: null, gvwr_lbs: null,
      }),
    );
    expect(empty.overall_identity_confidence).toBe(0);
  });
});
