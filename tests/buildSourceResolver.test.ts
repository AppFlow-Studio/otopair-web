/**
 * P2: build-source / badge-engineering resolution + NHTSA corporate-string
 * normalization. On a badge-engineered car parts/fluids follow the BUILDER, not
 * the badge (Yaris→Mazda). Fixes the P0 seed's false-positives on corporate
 * parent strings ("FCA" on a Jeep) and its blindness to independent engine
 * suppliers (Cummins is not a badge).
 */
import { describe, expect, test } from "vitest";
import {
  normalizeManufacturer,
  resolveBuildSource,
} from "../convex/vehicleEnrichment/buildSourceResolver";

describe("normalizeManufacturer", () => {
  test("corporate-parent strings normalize to a family-anchor marque", () => {
    expect(normalizeManufacturer("FCA US LLC")).toBe("chrysler");
    expect(normalizeManufacturer("FCA")).toBe("chrysler");
    expect(normalizeManufacturer("General Motors LLC")).toBe("chevrolet");
    expect(normalizeManufacturer("Toyota Motor Manufacturing")).toBe("toyota");
    expect(normalizeManufacturer("Mazda Motor Corporation")).toBe("mazda");
    expect(normalizeManufacturer("Bayerische Motoren Werke AG")).toBe("bmw");
    expect(normalizeManufacturer("Fuji Heavy Industries")).toBe("subaru");
  });

  test("independent engine/component suppliers → null (not a badge)", () => {
    expect(normalizeManufacturer("Cummins Inc")).toBe(null);
    expect(normalizeManufacturer("Detroit Diesel")).toBe(null);
    expect(normalizeManufacturer("ZF Friedrichshafen")).toBe(null);
    expect(normalizeManufacturer("Aisin Seiki")).toBe(null);
  });

  test("VM Motori (FCA-owned) → chrysler, so it is NOT a foreign badge on a Jeep", () => {
    expect(normalizeManufacturer("VM Motori")).toBe("chrysler");
  });

  test("unrecognized / empty → null (fail open)", () => {
    expect(normalizeManufacturer(null)).toBe(null);
    expect(normalizeManufacturer("")).toBe(null);
    expect(normalizeManufacturer("Acme Widgets")).toBe(null);
  });
});

describe("resolveBuildSource", () => {
  test("the batch-8 Wrangler: FCA engine on a Jeep is NOT a badge (family match)", () => {
    const r = resolveBuildSource({
      make: "Jeep", model: "Wrangler", model_year: 2021, engine_manufacturer: "FCA",
    });
    expect(r.build_source_make).toBe(null);
    expect(r.is_badge_engineered).toBe(false);
  });

  test("the batch-8 Yaris via engine_mfr: Mazda-built Toyota → mazda", () => {
    const r = resolveBuildSource({
      make: "Toyota", model: "Yaris", model_year: 2020, engine_manufacturer: "Mazda",
    });
    expect(r.build_source_make).toBe("mazda");
    expect(r.is_badge_engineered).toBe(true);
  });

  test("the Yaris via BADGE_MAP even when engine_mfr is unhelpful (decoded as Toyota)", () => {
    const r = resolveBuildSource({
      make: "Toyota", model: "Yaris", model_year: 2020, engine_manufacturer: "Toyota",
    });
    expect(r.build_source_make).toBe("mazda");
    expect(r.source).toBe("badge_map");
  });

  test("year-gated: a 2010 Toyota-built Yaris is NOT the Mazda2 rebadge", () => {
    const r = resolveBuildSource({
      make: "Toyota", model: "Yaris", model_year: 2010, engine_manufacturer: "Toyota",
    });
    expect(r.build_source_make).toBe(null);
  });

  test("badge map: GR Supra → bmw; Pontiac Vibe → toyota", () => {
    expect(
      resolveBuildSource({ make: "Toyota", model: "Supra", model_year: 2021, engine_manufacturer: "BMW" }).build_source_make,
    ).toBe("bmw");
    expect(
      resolveBuildSource({ make: "Pontiac", model: "Vibe", model_year: 2009, engine_manufacturer: "Toyota" }).build_source_make,
    ).toBe("toyota");
  });

  test("Cummins in a RAM is NOT a badge (independent engine supplier → null)", () => {
    const r = resolveBuildSource({
      make: "Ram", model: "2500", model_year: 2022, engine_manufacturer: "Cummins Inc",
    });
    expect(r.build_source_make).toBe(null);
  });

  test("same-marque (normal car) → null", () => {
    const r = resolveBuildSource({
      make: "Honda", model: "Civic", model_year: 2022, engine_manufacturer: "Honda Motor Co",
    });
    expect(r.build_source_make).toBe(null);
  });
});
