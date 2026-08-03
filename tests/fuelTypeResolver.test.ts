/**
 * P1: authoritative fuel-class resolution with gas-vs-diesel disambiguation.
 * The engine is the tiebreaker — a Cummins/EcoDiesel/TDI engine is diesel no
 * matter what the fuel field says (batch-8 Wrangler; batch-5 F-650/RAM).
 */
import { describe, expect, test } from "vitest";
import {
  resolveFuelClass,
  engineIndicatesDiesel,
} from "../convex/vehicleEnrichment/fuelTypeResolver";

describe("engineIndicatesDiesel", () => {
  test("unambiguous diesel markers", () => {
    expect(engineIndicatesDiesel("ERC", "VM Motori", "3.0L V6 EcoDiesel")).toBe(true);
    expect(engineIndicatesDiesel(null, "Cummins", "6.7L I6")).toBe(true);
    expect(engineIndicatesDiesel(null, null, "2.0L TDI")).toBe(true);
    expect(engineIndicatesDiesel(null, null, "Power Stroke 6.7")).toBe(true);
    expect(engineIndicatesDiesel("ISB6.7", null, null)).toBe(true);
  });
  test("gas engines are not diesel", () => {
    expect(engineIndicatesDiesel("ERB", "Chrysler", "3.6L Pentastar V6")).toBe(false);
    expect(engineIndicatesDiesel("2ZR-FE", "Toyota", "1.8L I4")).toBe(false);
    expect(engineIndicatesDiesel(null, null, null)).toBe(false);
  });
  test("short acronyms need a word boundary (no false hits inside codes)", () => {
    // "isb" must be a token, not a substring of e.g. "prisboxer"
    expect(engineIndicatesDiesel("PRISBOXER", null, null)).toBe(false);
  });
});

describe("resolveFuelClass — the batch-8 / batch-5 diesel cases", () => {
  test("Wrangler EcoDiesel: decode + engine agree → diesel, high confidence", () => {
    const r = resolveFuelClass({
      nhtsa_fuel_type: "Diesel",
      vdb_fuel_type: "Diesel",
      engine_code: "ERC",
      engine_manufacturer: "VM Motori",
      engine_description: "3.0L V6 EcoDiesel",
    });
    expect(r.fuel_class).toBe("diesel");
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.conflict).toBe(false);
  });

  test("engine OVERRIDE: decode wrongly says gasoline but engine is a Cummins → diesel + conflict", () => {
    const r = resolveFuelClass({
      nhtsa_fuel_type: "Gasoline",
      engine_manufacturer: "Cummins",
      engine_description: "6.7L Turbo Diesel",
    });
    expect(r.fuel_class).toBe("diesel");
    expect(r.conflict).toBe(true);
    expect(r.source).toBe("engine_override");
  });

  test("diesel engine, no decode fuel → diesel from engine signal", () => {
    const r = resolveFuelClass({ nhtsa_fuel_type: null, engine_description: "3.0L EcoDiesel" });
    expect(r.fuel_class).toBe("diesel");
    expect(r.source).toBe("engine_signal");
  });
});

describe("resolveFuelClass — gas / EV / conflicts", () => {
  test("gas RAM 6.4 HEMI (not Cummins) stays gasoline", () => {
    const r = resolveFuelClass({
      nhtsa_fuel_type: "Gasoline",
      engine_manufacturer: "Chrysler",
      engine_description: "6.4L HEMI V8",
    });
    expect(r.fuel_class).toBe("gasoline");
    expect(r.conflict).toBe(false);
  });

  test("NHTSA + VDB agree on gasoline → high confidence", () => {
    const r = resolveFuelClass({ nhtsa_fuel_type: "Gasoline", vdb_fuel_type: "Gasoline" });
    expect(r.fuel_class).toBe("gasoline");
    expect(r.source).toBe("nhtsa+vdb_agree");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  test("electric with no diesel engine signal → bev", () => {
    const r = resolveFuelClass({ nhtsa_fuel_type: "Electric" });
    expect(r.fuel_class).toBe("bev");
  });

  test("NHTSA vs VDB conflict, no engine tiebreak → keep NHTSA, low conf, needs_adversarial", () => {
    const r = resolveFuelClass({ nhtsa_fuel_type: "Gasoline", vdb_fuel_type: "Diesel" });
    // VDB "Diesel" is a fuel string but no ENGINE marker, so no override; NHTSA kept.
    expect(r.fuel_class).toBe("gasoline");
    expect(r.conflict).toBe(true);
    expect(r.needs_adversarial).toBe(true);
    expect(r.confidence).toBeLessThan(0.7);
  });

  test("no signal at all → null, fail open, needs_adversarial", () => {
    const r = resolveFuelClass({ nhtsa_fuel_type: null });
    expect(r.fuel_class).toBe(null);
    expect(r.confidence).toBe(0);
    expect(r.needs_adversarial).toBe(true);
  });
});
