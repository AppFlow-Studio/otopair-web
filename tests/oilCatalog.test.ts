import { describe, it, expect } from "vitest";
import {
  normalizeViscosity,
  lookupOeOil,
  isOeCatalogOil,
  OE_OIL_CATALOG,
} from "../convex/vehicleEnrichment/oilCatalog";

describe("normalizeViscosity", () => {
  it("canonicalizes the punctuation variants that appear in stored specs", () => {
    expect(normalizeViscosity("0W-20")).toBe("0W-20");
    expect(normalizeViscosity("0w20")).toBe("0W-20");
    expect(normalizeViscosity("0 W - 20")).toBe("0W-20");
    expect(normalizeViscosity("SAE 5W‑30")).toBe("5W-30");
  });

  it("takes the PRIMARY grade from the malformed live value, not an alternate", () => {
    // Real row on third-bird-914: a spec citation crammed into the grade
    // column. The requirement is the leading grade; 5W-40/0W-40 are
    // alternates mentioned afterwards and must not win.
    expect(normalizeViscosity("5W-30 (VW 502 00; alt: 5W-40 or 0W-40)")).toBe("5W-30");
  });

  it("reads single-digit high grades (0W-8 hybrids)", () => {
    expect(normalizeViscosity("0W-8")).toBe("0W-8");
  });

  it("returns null rather than guessing", () => {
    expect(normalizeViscosity(null)).toBeNull();
    expect(normalizeViscosity("")).toBeNull();
    expect(normalizeViscosity("full synthetic")).toBeNull();
    expect(normalizeViscosity("dexos1 Gen3")).toBeNull();
    // Not an SAE winter grade / out-of-band high grade.
    expect(normalizeViscosity("7W-20")).toBeNull();
    expect(normalizeViscosity("0W-99")).toBeNull();
  });
});

describe("lookupOeOil", () => {
  it("covers every grade the live fleet actually uses", () => {
    // Observed distribution across engines on third-bird-914 (Aug 2026).
    for (const grade of ["0W-20", "5W-30", "5W-20", "0W-30", "0W-16", "0W-40", "5W-40", "10W-30", "15W-40", "0W-8"]) {
      expect(lookupOeOil(grade), grade).not.toBeNull();
    }
  });

  it("resolves through the messy stored value", () => {
    expect(lookupOeOil("5W-30 (VW 502 00; alt: 5W-40 or 0W-40)")?.viscosity).toBe("5W-30");
  });

  it("NEVER substitutes a neighbouring grade — wrong oil is worse than no oil", () => {
    expect(lookupOeOil("0W-25")).toBeNull();
    expect(lookupOeOil(null)).toBeNull();
    expect(lookupOeOil("unknown")).toBeNull();
  });

  it("names the grade on the invoice line and never fakes an OEM SKU", () => {
    for (const [grade, row] of Object.entries(OE_OIL_CATALOG)) {
      expect(row.viscosity, grade).toBe(grade);
      expect(row.name, grade).toContain(grade);
      expect(row.identifier, grade).toMatch(/^OTOPAIR-UNIV-ENGINE-OIL-/);
      expect(row.pricePerQuartUsd, grade).toBeGreaterThan(0);
    }
  });
});

describe("isOeCatalogOil", () => {
  it("separates an OE stand-in from a genuine OEM bottle", () => {
    expect(isOeCatalogOil("OTOPAIR-UNIV-ENGINE-OIL-0W20")).toBe(true);
    // The GENERIC universal row is not a graded catalog row.
    expect(isOeCatalogOil("OTOPAIR-UNIV-ENGINE-OIL")).toBe(false);
    // Real OEM oil SKUs observed live — these must never read as catalog rows.
    expect(isOeCatalogOil("LM2207")).toBe(false);          // Mitsubishi genuine
    expect(isOeCatalogOil("999PK-000W20N")).toBe(false);   // Nissan genuine
    expect(isOeCatalogOil("19432351")).toBe(false);        // GM dexos1
    expect(isOeCatalogOil(null)).toBe(false);
  });
});
