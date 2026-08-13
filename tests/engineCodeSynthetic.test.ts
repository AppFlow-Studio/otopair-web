/**
 * Synthetic/marketing engine-code classification + capacity-query de-pinning.
 *
 * Live finding (Jul 2026, 2012 Audi A4 B8): engines.engine_code was stored as
 * "TFSI" — a marketing name that matches every turbo Audi engine — because the
 * VDB code was never screened. Every engine-pinned downstream query ("... TFSI
 * coolant capacity") then steered toward brand-wide capacity tables instead of
 * the CAEB-specific figure.
 */
import { describe, it, expect } from "vitest";
import { isSyntheticEngineCode } from "../convex/vehicleEnrichment/utils/engineLookup";
import { buildCapacityQueries } from "../convex/vehicleEnrichment/capacityResolver";

describe("isSyntheticEngineCode", () => {
  it("flags marketing names", () => {
    for (const code of ["TFSI", "tsi", "TDI", "VTEC", "EcoBoost", "HEMI", "Skyactiv-G"]) {
      expect(isSyntheticEngineCode(code), code).toBe(true);
    }
  });

  it("flags synthetic displacement keys and unknowns", () => {
    expect(isSyntheticEngineCode("2.0l_4cyl")).toBe(true);
    expect(isSyntheticEngineCode("3.5l_6cyl")).toBe(true);
    // decimal cylinders (the cylinders-holding-displacement bug) slip the
    // \d+cyl pattern — the underscore rule must still catch them
    expect(isSyntheticEngineCode("3.6l_3.6cyl")).toBe(true);
    expect(isSyntheticEngineCode("unknown_unknowncyl")).toBe(true);
    expect(isSyntheticEngineCode("")).toBe(true);
  });

  // Live finding (fresh-VIN test, Aug 2026, 2021 Mazda CX-5 2.5): NHTSA's
  // EngineModel "PY Cylinder Decativation" (sic — NHTSA's own typo) leads
  // with a plausible code fragment, so the marketing-term prefix check
  // missed it. It was stored verbatim and keyed a config as
  // ..._py_cylinder_decativation. Real code: PY-VPS (Skyactiv-G 2.5).
  it("flags descriptor phrases that lead with a plausible code fragment", () => {
    for (const code of [
      "PY Cylinder Decativation", // verbatim NHTSA string, typo included
      "PY Cylinder Deactivation", // same string if NHTSA ever fixes the typo
      "GDI THETA III",            // Sonata case — must stay caught
      "EcoBoost 2.3L",
      "2GR-FKS 3.5L V6",          // real code drowned in descriptor words
    ]) {
      expect(isSyntheticEngineCode(code), code).toBe(true);
    }
  });

  it("flags single-token descriptor words and over-length strings", () => {
    for (const code of ["Turbo", "DOHC", "Decativation", "Cylinder", "NA", "V6"]) {
      expect(isSyntheticEngineCode(code), code).toBe(true);
    }
    // longer than any real OEM designation
    expect(isSyntheticEngineCode("SKYACTIVG25DYNAMIC")).toBe(true);
  });

  it("accepts real OEM codes", () => {
    for (const code of [
      "CAEB", "L84", "B48B20M1", "2GR-FE", "K24Z7", "EJ257", "A25A-FKS",
      "PY-VPS",       // the real Mazda code the CX-5 descriptor stood in for
      "G4KN",         // Sonata Smartstream — resolver output must stay accepted
      "G6DN",         // Telluride 3.8 Lambda II
      "PR25DD",       // year-pinned Altima precedent
      "M256E30DEHLG", // 12-char Mercedes designation — under the 14 ceiling
      "OM651DE22LA",
    ]) {
      expect(isSyntheticEngineCode(code), code).toBe(false);
    }
  });
});

describe("buildCapacityQueries — synthetic code de-pinning", () => {
  const vehicle = (engineCode: string | null) =>
    ({
      year: 2012,
      make: "Audi",
      model: "A4",
      engineCode,
      displacement: 2,
    }) as any;

  it("pins queries on a real engine code", () => {
    const qs = buildCapacityQueries(vehicle("CAEB"), "coolant_capacity_qts");
    expect(qs.some((q) => q.includes("CAEB"))).toBe(true);
  });

  it("never embeds a marketing code; falls back to displacement", () => {
    const qs = buildCapacityQueries(vehicle("TFSI"), "coolant_capacity_qts");
    expect(qs.every((q) => !q.includes("TFSI"))).toBe(true);
    expect(qs.some((q) => q.includes("2L"))).toBe(true);
    // no double spaces from the dropped code
    expect(qs.every((q) => !q.includes("  "))).toBe(true);
  });
});
