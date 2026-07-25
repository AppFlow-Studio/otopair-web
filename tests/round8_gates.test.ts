/**
 * Round-8 gates (batch-10 audit): engine/position-scoped fitment verification
 * surface, speeds-vs-unit reconcile, EPS suppression, trim-normalizer guard,
 * fluid-family interval floors, coolant band widen, flex-fuel flag.
 */
import { describe, expect, test } from "vitest";
import {
  VERIFY_PRIORITY_ROLE_KEYS,
  VERIFY_MAX_PARTS,
  positionForRoleKey,
} from "../convex/vehicleEnrichment/utils/partFitmentVerifier";
import { speedsFromTransUnit } from "../convex/vehicleEnrichment/transmissionTypeReconcile";
import {
  isKnownEpsPlatform,
  applyEpsSuppression,
} from "../convex/vehicleEnrichment/applicabilityRules";
import { acceptNormalizedTrim } from "../convex/vehicleEnrichment/identityResolution";
import {
  coolantIntervalFloor,
  MONTHS_PLAUSIBILITY,
} from "../convex/vehicleEnrichment/adversarialVerification";
import { runSanityChecks } from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(
  value: FieldResult["value"],
  source_url: string | null = "https://example.com/page",
  source_type: FieldResult["source_type"] = "web_search",
  confidence = 0.9,
): FieldResult {
  return { value, source_url, source_type, confidence, flagged: false, flag_reason: null };
}

describe("fitment verifier surface (batch-10 same-platform parts)", () => {
  test("the four batch-10 miss roles are now priority", () => {
    for (const role of ["serpentine_belt", "thermostat", "intake_manifold_gasket", "ignition_coil"]) {
      expect(VERIFY_PRIORITY_ROLE_KEYS.has(role)).toBe(true);
    }
  });
  test("cap fits the whole priority set with headroom", () => {
    expect(VERIFY_MAX_PARTS).toBeGreaterThanOrEqual(VERIFY_PRIORITY_ROLE_KEYS.size + 4);
  });
  test("positionForRoleKey reads axle position from role keys", () => {
    expect(positionForRoleKey("rear_rotor")).toBe("rear");
    expect(positionForRoleKey("front_brake_pad")).toBe("front");
    expect(positionForRoleKey("brake_wear_sensor_rear")).toBe("rear");
    expect(positionForRoleKey("oil_filter")).toBeNull();
    expect(positionForRoleKey("serpentine_belt")).toBeNull();
  });
});

describe("speedsFromTransUnit (batch-10 Cobalt '5-speed automatic')", () => {
  test("leading-count unit designations", () => {
    expect(speedsFromTransUnit("4T45")).toBe(4);
    expect(speedsFromTransUnit("GM 4T45")).toBe(4);
    expect(speedsFromTransUnit("6T70")).toBe(6);
    expect(speedsFromTransUnit("ZF 6HP26")).toBe(6);
    expect(speedsFromTransUnit("4R75E")).toBe(4);
    expect(speedsFromTransUnit("8HP75")).toBe(8);
    expect(speedsFromTransUnit("10R80")).toBe(10);
    expect(speedsFromTransUnit("5R55S")).toBe(5);
  });
  test("no gear count encoded → null (never a guess)", () => {
    expect(speedsFromTransUnit("Jatco JF017E CVT")).toBeNull(); // CVT
    expect(speedsFromTransUnit("JF506E")).toBeNull(); // digits not leading
    expect(speedsFromTransUnit("CD4E")).toBeNull();
    expect(speedsFromTransUnit("Powerglide")).toBeNull();
    expect(speedsFromTransUnit(null)).toBeNull();
    expect(speedsFromTransUnit("")).toBeNull();
    expect(speedsFromTransUnit("3.6L V6")).toBeNull(); // displacement is not a gear count
  });
});

describe("EPS suppression (batch-10 Cobalt hydraulic-PS phantom)", () => {
  test("known EPS platforms match; others don't", () => {
    expect(isKnownEpsPlatform("Chevrolet", "Cobalt", 2009)).toBe(true);
    expect(isKnownEpsPlatform("chevrolet", "cobalt", 2005)).toBe(true);
    expect(isKnownEpsPlatform("Chevrolet", "Cobalt", 2012)).toBe(false); // out of range
    expect(isKnownEpsPlatform("Acura", "MDX", 2014)).toBe(true);
    expect(isKnownEpsPlatform("Acura", "MDX", 2013)).toBe(false); // 2G MDX was hydraulic
    expect(isKnownEpsPlatform("Ford", "F-150", 2006)).toBe(false);
    expect(isKnownEpsPlatform(null, "Cobalt", 2009)).toBe(false);
  });
  test("suppression overwrites a wrong 'hydraulic' extraction and nulls fluid fields", () => {
    const fields: Record<string, FieldResult> = {
      power_steering_type: field("hydraulic"),
      ps_fluid_capacity_oz: field(32),
      ps_fluid_oem: field("12345678"),
      ps_fluid_miles: field(60000),
    };
    expect(applyEpsSuppression(fields, "Chevrolet", "Cobalt", 2009)).toBe(true);
    expect(fields.power_steering_type.value).toBe("electric");
    expect(fields.ps_fluid_capacity_oz.value).toBeNull();
    expect(fields.ps_fluid_oem.value).toBeNull();
    expect(fields.ps_fluid_miles.value).toBeNull();
    expect(fields.ps_fluid_capacity_oz.flag_reason).toBe("not_applicable");
  });
  test("unknown platform: untouched, returns false", () => {
    const fields: Record<string, FieldResult> = { power_steering_type: field("hydraulic") };
    expect(applyEpsSuppression(fields, "Ford", "F-150", 2006)).toBe(false);
    expect(fields.power_steering_type.value).toBe("hydraulic");
  });
});

describe("acceptNormalizedTrim (batch-10 FX4-vs-Lariat, 745i-vs-745Li)", () => {
  test("invented trims with no decode-token overlap are rejected", () => {
    expect(acceptNormalizedTrim("FX4 SuperCrew", ["Lariat", "Styleside", "F-Series", null])).toBe(false);
    expect(acceptNormalizedTrim("745i", ["745Li", null, null, null])).toBe(false);
  });
  test("cleanups that share tokens with the decode are accepted", () => {
    expect(acceptNormalizedTrim("Lariat", ["Lariat"])).toBe(true);
    expect(acceptNormalizedTrim("Touring L", ["TOURING L"])).toBe(true);
    expect(acceptNormalizedTrim("SEL Premium", ["sel premium 4motion"])).toBe(true);
    expect(acceptNormalizedTrim("745Li", ["745Li"])).toBe(true);
  });
  test("no decode evidence → normalizer is the only source, accept", () => {
    expect(acceptNormalizedTrim("EX-L", [null, undefined, ""])).toBe(true);
  });
  test("empty normalized trim is never accepted", () => {
    expect(acceptNormalizedTrim("", ["Lariat"])).toBe(false);
    expect(acceptNormalizedTrim(null, ["Lariat"])).toBe(false);
  });
});

describe("fluid-family interval floors (batch-10 DEX-COOL 30k, BMW brake fluid 12mo)", () => {
  test("long-life chemistries get a floor; unknown/conventional don't", () => {
    expect(coolantIntervalFloor("DEX-COOL (OAT)")).toEqual({ minMiles: 50000, minMonths: 36 });
    expect(coolantIntervalFloor("Honda/Acura Long Life Type 2 (Blue)")).not.toBeNull();
    expect(coolantIntervalFloor("BMW Genuine Coolant / Antifreeze (Blue G11)")).not.toBeNull();
    expect(coolantIntervalFloor("conventional green IAT")).toBeNull();
    expect(coolantIntervalFloor(null)).toBeNull();
  });
  test("brake-fluid months floor catches the 12-month import", () => {
    const band = MONTHS_PLAUSIBILITY["interval_months_brake_fluid_flush"];
    expect(band).toBeDefined();
    expect(12).toBeLessThan(band.min);
    expect(36).toBeGreaterThanOrEqual(band.min); // SRX 36mo stays unflagged
    expect(120).toBeLessThanOrEqual(band.max); // GM 10-year schedule stays unflagged
  });
});

describe("coolant sanity band (batch-10 F-150 20.9 qt double-flag)", () => {
  test("light-duty V8 at 20.9 qt: flat 4-22 rule silent, value survives (one informational band flag max)", () => {
    const fields = { coolant_capacity_qts: field(20.9) };
    const flags = runSanityChecks(fields, 8, { gvwrLbs: 7700 });
    const coolantFlags = flags.filter((f) => f.field === "coolant_capacity_qts");
    // Was 2 flags pre-round-8 (flat 4-20 + V8 band); the flat ceiling is now 22
    // so only the informational V8-band flag remains, and the value persists.
    expect(coolantFlags.length).toBeLessThanOrEqual(1);
    expect(coolantFlags.some((f) => f.reason.includes("4-22"))).toBe(false);
    expect(fields.coolant_capacity_qts.value).toBe(20.9);
  });
  test("a liters-as-quarts misread still flags/rejects", () => {
    const fields = { coolant_capacity_qts: field(30) };
    const flags = runSanityChecks(fields, 8, { gvwrLbs: 7700 });
    expect(flags.some((f) => f.field === "coolant_capacity_qts")).toBe(true);
  });
});

describe("flex-fuel claim flag (batch-10 SRX E85 false positive)", () => {
  test("decode-only E85 claim is flagged and confidence-capped", () => {
    const fields = {
      fuel_type: field("Gasoline / Ethanol (E85)", null, "nhtsa", 0.9),
    };
    const flags = runSanityChecks(fields, 6, {});
    expect(flags.some((f) => f.field === "fuel_type" && f.reason.includes("flex_fuel_claim_uncorroborated"))).toBe(true);
    expect(fields.fuel_type.flagged).toBe(true);
    expect(fields.fuel_type.confidence).toBeLessThanOrEqual(0.6);
  });
  test("web-corroborated E85 claim is left alone", () => {
    const fields = {
      fuel_type: field("Flex Fuel (E85)", "https://www.fueleconomy.gov/some-page", "web_search", 0.9),
    };
    const flags = runSanityChecks(fields, 6, {});
    expect(flags.some((f) => f.field === "fuel_type")).toBe(false);
    expect(fields.fuel_type.flagged).toBe(false);
  });
  test("plain gasoline never trips it", () => {
    const fields = { fuel_type: field("Gasoline", null, "nhtsa") };
    const flags = runSanityChecks(fields, 6, {});
    expect(flags.some((f) => f.field === "fuel_type")).toBe(false);
  });
});
