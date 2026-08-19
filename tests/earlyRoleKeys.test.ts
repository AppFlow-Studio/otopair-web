/**
 * The widened early-harvest role set (Aug 2026).
 *
 * EARLY_ROLE_KEYS lets the in-run, catalog-first harvest fill roles BEFORE
 * Batch 2 has said which services this vehicle can be sold. That is only safe
 * while every member is powertrain-independent, and only useful while every
 * member is reachable through an assumed service — so both properties are
 * asserted here rather than left to the comment that states them.
 */
import { describe, it, expect } from "vitest";
import {
  EARLY_ROLE_KEYS,
  EARLY_SERVICE_SLUGS,
  earlyHarvestScope,
} from "../convex/vehicleEnrichment/quotability";
import { classifyFuelClass } from "../convex/vehicleEnrichment/variantFingerprint";
import { SERVICE_PARTS_REFERENCE } from "../convex/lib/servicePartsReference";

describe("EARLY_ROLE_KEYS is powertrain-independent", () => {
  // The rule this encodes: a first run has not classified the powertrain yet,
  // so assuming a role an EV does not have would be guessing applicability.
  it("excludes every role a powertrain can remove", () => {
    for (const role of ["air_filter", "oil_filter", "engine_oil", "spark_plug"]) {
      expect(EARLY_ROLE_KEYS as readonly string[]).not.toContain(role);
    }
  });

  it("includes the roles present on any road vehicle", () => {
    for (const role of ["front_brake_pad", "rear_rotor", "battery", "cabin_filter"]) {
      expect(EARLY_ROLE_KEYS as readonly string[]).toContain(role);
    }
  });

  it("every assumed service exists in the reference", () => {
    for (const slug of EARLY_SERVICE_SLUGS) {
      expect(SERVICE_PARTS_REFERENCE[slug], `missing service ${slug}`).toBeDefined();
    }
  });

  it("every early role is a real core role of an assumed service", () => {
    // Guards the seam that makes the widening safe: assuming a SERVICE only
    // helps if the role is actually reachable through one of them.
    const reachable = new Set(
      EARLY_SERVICE_SLUGS.flatMap((slug) =>
        (SERVICE_PARTS_REFERENCE[slug]?.roles ?? [])
          .filter((r: any) => r.serviceRole === "core")
          .map((r: any) => r.roleKey),
      ),
    );
    for (const role of EARLY_ROLE_KEYS) {
      expect(reachable.has(role), `${role} is not a core role of any assumed service`).toBe(true);
    }
  });
});


describe("earlyHarvestScope — the powertrain decides how wide the in-run harvest goes", () => {
  const scopeFor = (vpicFuel: string | null) =>
    earlyHarvestScope(classifyFuelClass(vpicFuel));

  it("gives a gasoline car every core role, plugs included", () => {
    const s = scopeFor("Gasoline");
    for (const r of ["oil_filter", "engine_oil", "air_filter", "coolant", "spark_plug"]) {
      expect(s.roleKeys).toContain(r);
    }
    expect(s.serviceSlugs).toContain("oil_change");
    expect(s.serviceSlugs).toContain("spark_plugs");
  });

  it("gives a diesel the combustion roles but NOT spark plugs", () => {
    // The split fuelTypeResolver.ts exists for: a diesel takes glow plugs,
    // which are a different part in a different role.
    const s = scopeFor("Diesel");
    expect(s.roleKeys).toContain("oil_filter");
    expect(s.roleKeys).not.toContain("spark_plug");
    expect(s.serviceSlugs).not.toContain("spark_plugs");
  });

  it("treats a HYBRID as combustion — it carries a full engine", () => {
    // These are the exact vPIC strings in the fleet (17 rows). A naive
    // includes("Electric") would strip oil and plugs from a car that needs both.
    for (const f of ["Electric / Gasoline", "Gasoline / Electric", "Hybrid"]) {
      const s = scopeFor(f);
      expect(s.roleKeys, `${f} should keep oil_filter`).toContain("oil_filter");
      expect(s.roleKeys, `${f} should keep spark_plug`).toContain("spark_plug");
    }
  });

  it("holds a BEV to the powertrain-independent set", () => {
    const s = scopeFor("Electric");
    expect(s.roleKeys).toEqual([...EARLY_ROLE_KEYS]);
    for (const r of ["oil_filter", "engine_oil", "air_filter", "spark_plug"]) {
      expect(s.roleKeys).not.toContain(r);
    }
    expect(s.serviceSlugs).toEqual([...EARLY_SERVICE_SLUGS]);
  });

  it("treats flex fuel as combustion", () => {
    expect(scopeFor("Flexible Fuel Vehicle (FFV)").roleKeys).toContain("spark_plug");
    expect(scopeFor("Gasoline / Ethanol (E85)").roleKeys).toContain("spark_plug");
  });

  it("falls back to the narrow set on an unreadable fuel type", () => {
    // A decode miss must cost COVERAGE, never correctness.
    for (const f of [null, "", "Hydrogen Fuel Cell", "Compressed Natural Gas (CNG)"]) {
      expect(scopeFor(f as any).roleKeys).toEqual([...EARLY_ROLE_KEYS]);
    }
  });

  it("is case-insensitive — the fleet holds a lowercase 'gasoline' row", () => {
    expect(scopeFor("gasoline").roleKeys).toContain("spark_plug");
  });

  it("always includes the powertrain-independent set, whatever the class", () => {
    for (const f of ["Gasoline", "Diesel", "Electric", "Hybrid", null]) {
      const s = scopeFor(f as any);
      for (const r of EARLY_ROLE_KEYS) expect(s.roleKeys).toContain(r);
    }
  });

  it("reports a basis string for the run log", () => {
    expect(scopeFor("Gasoline").basis).toContain("combustion");
    expect(scopeFor("Electric").basis).toContain("bev");
  });
});
