/**
 * P5: prompt anchoring (renderVariantConstraints) + the determinism gate
 * (coreSignature / compareSignatures).
 */
import { describe, expect, test } from "vitest";
import {
  assembleVariantFingerprint,
  renderVariantConstraints,
  type FingerprintInputs,
} from "../convex/vehicleEnrichment/variantFingerprint";
import {
  coreSignature,
  compareSignatures,
} from "../convex/vehicleEnrichment/determinismGate";

function fp(over: Partial<FingerprintInputs> = {}) {
  return assembleVariantFingerprint({
    make: "Jeep", model: "Wrangler", model_year: 2021,
    engine_code: "ERC", raw_fuel_type: "Diesel", aspiration: "turbo",
    displacement_l: 3.0, cylinders: 6, engine_manufacturer: "VM Motori",
    transmission_family: "automatic", speeds: 8, drivetrain: "4WD", gvwr_lbs: 6000,
    resolved_fuel: { fuel_class: "diesel", confidence: 0.95, source: "nhtsa+engine_agree" },
    ...over,
  });
}

describe("renderVariantConstraints", () => {
  test("diesel emits the NO-spark-plugs constraint", () => {
    const out = renderVariantConstraints(fp());
    expect(out).toContain("DIESEL");
    expect(out).toContain("NO spark plugs");
    expect(out).toContain("ignition_coil_oem");
    expect(out).toContain("engine code ERC");
  });

  test("badge-engineered emits a build-source constraint (Yaris → Mazda)", () => {
    const out = renderVariantConstraints(
      fp({
        make: "Toyota", model: "Yaris", engine_manufacturer: "Mazda",
        raw_fuel_type: "Gasoline",
        resolved_fuel: { fuel_class: "gasoline", confidence: 0.9, source: "nhtsa" },
        resolved_build_source: { build_source_make: "mazda", confidence: 0.95, source: "badge_map" },
      }),
    );
    expect(out).toContain("Built by Mazda");
    expect(out).toContain("NOT Toyota");
  });

  test("a plain gas car with no badge emits no fuel/badge lines (fail open)", () => {
    const out = renderVariantConstraints(
      fp({
        make: "Honda", model: "Civic", engine_manufacturer: "Honda", raw_fuel_type: "Gasoline",
        resolved_fuel: { fuel_class: "gasoline", confidence: 0.9, source: "nhtsa" },
        resolved_build_source: { build_source_make: null, confidence: 0, source: "none" },
      }),
    );
    expect(out).not.toContain("DIESEL");
    expect(out).not.toContain("Built by");
    // still constrains the engine identity
    expect(out).toContain("Engine:");
  });

  test("low-confidence fuel does NOT emit the diesel constraint (fail safe)", () => {
    const out = renderVariantConstraints(
      fp({ resolved_fuel: { fuel_class: "diesel", confidence: 0.5, source: "weak" } }),
    );
    expect(out).not.toContain("NO spark plugs");
  });
});

describe("coreSignature + compareSignatures — the determinism gate", () => {
  const runA = {
    engine: { code: "ERC", fuel: "Diesel", oil_viscosity: "5W-40", coolant_type: "OAT", spark_plug_quantity: null },
    transmission: { type: "Automatic", fluid: "Mopar ZF 8&9 ATF" },
    drivetrain: "4WD",
    parts: [{ role: "oil_filter", oem: "68507598AA" }, { role: "atf_fluid", oem: "68218057AC" }],
  };

  test("identical runs → deterministic", () => {
    const r = compareSignatures([coreSignature(runA), coreSignature(runA)]);
    expect(r.deterministic).toBe(true);
    expect(r.varied).toHaveLength(0);
  });

  test("the batch-8 fluid flip (ZF-ATF → ATF+4) is caught as a variance", () => {
    const runB = { ...runA, transmission: { type: "Manual", fluid: "Mopar ATF+4" } };
    const r = compareSignatures([coreSignature(runA), coreSignature(runB)]);
    expect(r.deterministic).toBe(false);
    const fields = r.varied.map((v) => v.field);
    expect(fields).toContain("trans:fluid");
    expect(fields).toContain("trans:type");
  });

  test("normalization ignores case/punctuation (Dexron VI == DEXRON-VI)", () => {
    const a = coreSignature({ transmission: { fluid: "Dexron VI" } });
    const b = coreSignature({ transmission: { fluid: "DEXRON-VI" } });
    expect(compareSignatures([a, b]).deterministic).toBe(true);
  });

  test("a consistently-null field is a stable gap, not a variance", () => {
    const r = compareSignatures([coreSignature(runA), coreSignature(runA)]);
    expect(r.varied.find((v) => v.field === "part:cabin_filter")).toBeUndefined();
  });

  test("single run → trivially deterministic", () => {
    expect(compareSignatures([coreSignature(runA)]).deterministic).toBe(true);
  });
});
