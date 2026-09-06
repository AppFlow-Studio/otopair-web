import { describe, it, expect } from "vitest";
import {
  deriveSparkPlugQuantity,
  isTwinPlugAmbiguous,
  plugsPerCylinder,
  resolveSparkPlugQuantity,
} from "../convex/lib/sparkPlugs";

describe("deriveSparkPlugQuantity", () => {
  it("is one per cylinder for the ordinary engine", () => {
    expect(deriveSparkPlugQuantity({ cylinders: 4, make: "Toyota" })?.quantity).toBe(4);
    expect(deriveSparkPlugQuantity({ cylinders: 6, make: "Toyota" })?.quantity).toBe(6);
    // The Tacoma's 2GR-FKS — the case that was being billed as 4 plugs.
    const t = deriveSparkPlugQuantity({
      cylinders: 6,
      make: "Toyota",
      engineCode: "2GR-FKS",
      displacementL: 3.5,
    });
    expect(t).toMatchObject({ quantity: 6, basis: "per_cylinder" });
  });

  it("doubles for a Mopar twin-plug V8 — a 5.7 HEMI takes sixteen", () => {
    for (const disp of [4.7, 5.7, 6.1, 6.2, 6.4]) {
      const r = deriveSparkPlugQuantity({ cylinders: 8, make: "Ram", displacementL: disp });
      expect(r, `${disp}L`).toMatchObject({ quantity: 16, basis: "twin_spark" });
    }
    // Same engines across the Stellantis badges.
    for (const make of ["Dodge", "Jeep", "Chrysler", "RAM"]) {
      expect(
        deriveSparkPlugQuantity({ cylinders: 8, make, displacementL: 5.7 })?.quantity,
      ).toBe(16);
    }
  });

  it("does NOT double a non-Mopar V8 of the same displacement", () => {
    // The Chevrolet LT1 6.2 is single-plug. Doubling it would bill eight plugs
    // nobody needs — the twin-plug rule has to be make-gated, not size-gated.
    expect(
      deriveSparkPlugQuantity({ cylinders: 8, make: "Chevrolet", displacementL: 6.2 }),
    ).toMatchObject({ quantity: 8, basis: "per_cylinder" });
    // Ford's 5.0 Coyote is not in the twin-plug displacement list at all.
    expect(
      deriveSparkPlugQuantity({ cylinders: 8, make: "Ford", displacementL: 5.0 })?.quantity,
    ).toBe(8);
  });

  it("doubles Mercedes M112/M113 on the engine code alone", () => {
    expect(
      deriveSparkPlugQuantity({ cylinders: 8, make: "Mercedes-Benz", engineCode: "M113E50" }),
    ).toMatchObject({ quantity: 16, basis: "twin_spark" });
    expect(
      deriveSparkPlugQuantity({ cylinders: 6, make: "Mercedes-Benz", engineCode: "M112E32" })
        ?.quantity,
    ).toBe(12);
    // Their single-plug replacements must not inherit the rule.
    expect(
      deriveSparkPlugQuantity({ cylinders: 6, make: "Mercedes-Benz", engineCode: "M276DE30" })
        ?.quantity,
    ).toBe(6);
  });

  it("returns null when the cylinder count is unknown — never a default", () => {
    // The 2022 Maverick: vPIC returns no EngineCylinders field at all for that
    // VIN, so the row carries the 0 sentinel. A 0 must not become a quantity.
    expect(deriveSparkPlugQuantity({ cylinders: 0, make: "Ford" })).toBeNull();
    expect(deriveSparkPlugQuantity({ cylinders: null, make: "Ford" })).toBeNull();
    expect(deriveSparkPlugQuantity({ cylinders: undefined })).toBeNull();
    expect(deriveSparkPlugQuantity({ cylinders: 2.5 as number })).toBeNull();
    expect(deriveSparkPlugQuantity({ cylinders: 20 })).toBeNull();
  });

  it("refuses to answer when make is missing and the V8 could go either way", () => {
    // 6.2 V8 with no make: Hellcat (16) or LT1 (8). Guessing is a doubled or
    // halved invoice, so this must be null rather than a coin flip.
    expect(isTwinPlugAmbiguous({ cylinders: 8, displacementL: 6.2 })).toBe(true);
    expect(deriveSparkPlugQuantity({ cylinders: 8, displacementL: 6.2 })).toBeNull();

    // A decisive engine code resolves it even with no make.
    expect(isTwinPlugAmbiguous({ cylinders: 8, displacementL: 5.5, engineCode: "M113E55" })).toBe(
      false,
    );
    // Not a twin-plug displacement → unambiguous, derive normally.
    expect(isTwinPlugAmbiguous({ cylinders: 8, displacementL: 5.0 })).toBe(false);
    expect(deriveSparkPlugQuantity({ cylinders: 8, displacementL: 5.0 })?.quantity).toBe(8);
    // Only V8s are ambiguous; a make-less four-cylinder is fine.
    expect(isTwinPlugAmbiguous({ cylinders: 4, displacementL: 2.5 })).toBe(false);
  });

  it("carries a basis and an explanation so a wrong count is auditable", () => {
    const r = deriveSparkPlugQuantity({ cylinders: 8, make: "Jeep", displacementL: 5.7 });
    expect(r?.why).toMatch(/8 cylinder\(s\) × 2/);
    expect(plugsPerCylinder({ cylinders: 4, make: "Honda" })).toMatchObject({ n: 1 });
  });
});

describe("resolveSparkPlugQuantity", () => {
  it("prefers a stored value over the derivation", () => {
    // The manual (or a human) outranks arithmetic — a stored 16 on a V8 must
    // survive even where the derivation would have said 8.
    expect(
      resolveSparkPlugQuantity({
        spark_plug_quantity: 16,
        cylinders: 8,
        make: "Chevrolet",
        displacementL: 6.2,
      }),
    ).toEqual({ quantity: 16, basis: "stored" });
  });

  it("derives when nothing is stored", () => {
    expect(
      resolveSparkPlugQuantity({ spark_plug_quantity: null, cylinders: 6, make: "Toyota" }),
    ).toEqual({ quantity: 6, basis: "per_cylinder" });
  });

  it("reports unknown rather than substituting a number", () => {
    // This is the contract that replaces `?? 4`. The caller must see null and
    // decide, instead of being handed a plausible-looking four.
    expect(
      resolveSparkPlugQuantity({ spark_plug_quantity: null, cylinders: 0, make: "Ford" }),
    ).toEqual({ quantity: null, basis: "unknown" });
  });

  it("ignores a stored zero or negative", () => {
    expect(
      resolveSparkPlugQuantity({ spark_plug_quantity: 0, cylinders: 4, make: "Kia" }),
    ).toEqual({ quantity: 4, basis: "per_cylinder" });
  });
});
