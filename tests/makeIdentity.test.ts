import { describe, expect, it } from "vitest";
import {
  partFitsConfigMakeNamed,
  passesI1ReadGuardNamed,
  sameMakeName,
} from "../convex/lib/makeIdentity";

// The live case (Aug 2026): two makes rows for one make — the C43's battery
// part stamped under "Mercedes-Benz" while the config carried "MERCEDES-BENZ",
// so a fitted, priced, quotability-counted part read as "no part on file".
const PART_MAKE = "id_mercedes_lower" as any;
const CONFIG_MAKE = "id_mercedes_upper" as any;

describe("sameMakeName", () => {
  it("treats case/hyphen/space variants as one make", () => {
    expect(sameMakeName("MERCEDES-BENZ", "Mercedes-Benz")).toBe(true);
    expect(sameMakeName("Land Rover", "LAND-ROVER")).toBe(true);
  });
  it("never equates different makes — family stays out of scope", () => {
    expect(sameMakeName("Audi", "Volkswagen")).toBe(false);
    expect(sameMakeName("Mercedes-Benz", null)).toBe(false);
  });
});

describe("partFitsConfigMakeNamed", () => {
  it("bridges duplicate rows of the same make", () => {
    expect(
      partFitsConfigMakeNamed(PART_MAKE, CONFIG_MAKE, "Mercedes-Benz", "MERCEDES-BENZ"),
    ).toBe(true);
  });
  it("still rejects a genuine cross-make part even with names", () => {
    expect(partFitsConfigMakeNamed(PART_MAKE, CONFIG_MAKE, "Ford", "Mercedes-Benz")).toBe(false);
  });
  it("keeps strict id behavior when names are missing", () => {
    expect(partFitsConfigMakeNamed(PART_MAKE, CONFIG_MAKE, null, "Mercedes-Benz")).toBe(false);
    expect(partFitsConfigMakeNamed(CONFIG_MAKE, CONFIG_MAKE, null, null)).toBe(true);
  });
});

describe("passesI1ReadGuardNamed", () => {
  const base = {
    partMakeId: PART_MAKE,
    configMakeId: CONFIG_MAKE,
    configMakeName: "MERCEDES-BENZ",
  };
  it("passes the C43 battery shape: same make, different rows, clean number", () => {
    expect(
      passesI1ReadGuardNamed({
        ...base,
        oemPartNumber: "001-982-80-08",
        partMakeName: "Mercedes-Benz",
      }),
    ).toBe(true);
  });
  it("the escape is not looser than the main path — foreign-format number still dies", () => {
    expect(
      passesI1ReadGuardNamed({
        ...base,
        // Motorcraft signature on a Mercedes config: signature backstop holds.
        oemPartNumber: "BXT-94RH7-730",
        partMakeName: "Mercedes-Benz",
      }),
    ).toBe(false);
  });
  it("cross-make with names stays rejected; mechanic verification still overrides", () => {
    expect(
      passesI1ReadGuardNamed({
        ...base,
        oemPartNumber: "001-982-80-08",
        partMakeName: "Ford",
      }),
    ).toBe(false);
    expect(
      passesI1ReadGuardNamed({
        ...base,
        oemPartNumber: "001-982-80-08",
        partMakeName: "Ford",
        mechanicVerified: true,
      }),
    ).toBe(true);
  });
});

// ─── Corporate-family read escape (operator decision, Aug 11 2026) ──────────
//
// The strict same-make read guard was hiding parts we had already found,
// verified and priced, because shared corporate storefronts stamp them with a
// sibling brand. Live counts on third-bird-914: Enclave 4/13 fitments,
// Pacifica 7/26, QX60 4/16 (engine oil among them), Nautilus 3/5, RDX 2/15.
describe("corporate-family read escape", () => {
  const ids = { part: "id_part" as any, config: "id_config" as any };

  const guard = (partMakeName: string, configMakeName: string, oemPartNumber: string) =>
    passesI1ReadGuardNamed({
      partMakeId: ids.part,
      configMakeId: ids.config,
      partMakeName,
      configMakeName,
      oemPartNumber,
    });

  it("shows the sibling-stamped parts that were hidden from booking", () => {
    // GM: one storefront serves Chevrolet/GMC/Cadillac/Buick (the Enclave).
    expect(guard("Chevrolet", "Buick", "88864542")).toBe(true);
    expect(guard("GMC", "Cadillac", "19432351")).toBe(true);
    // Mopar: the Pacifica's coolant/filters stamped Dodge or Jeep.
    expect(guard("Dodge", "Chrysler", "68163848AB")).toBe(true);
    expect(guard("Jeep", "Ram", "68218890AB")).toBe(true);
    // Nissan/Infiniti: the QX60's own engine oil.
    expect(guard("Nissan", "Infiniti", "999PK-000W20N")).toBe(true);
    // Honda/Acura: the RDX's cabin filter + oil filter.
    expect(guard("Honda", "Acura", "80292-SDA-407")).toBe(true);
    // Ford/Lincoln: the Nautilus.
    expect(guard("Ford", "Lincoln", "FL-820-S")).toBe(true);
    // VAG: an MQB part genuinely fits both.
    expect(guard("Audi", "Volkswagen", "5Q0129620I")).toBe(true);
  });

  it("STILL blocks a genuinely foreign part — the property that must not regress", () => {
    // The live contamination case: Motorcraft battery scraped onto an Alfa.
    expect(guard("Ford", "Alfa Romeo", "BXT-94RH7-730")).toBe(false);
    // Different families, plausible-looking numbers.
    expect(guard("Audi", "Alfa Romeo", "8R0698151L")).toBe(false);
    expect(guard("Toyota", "Honda", "90915-YZZF2")).toBe(false);
    expect(guard("BMW", "Mercedes-Benz", "11428593186")).toBe(false);
  });

  it("keeps the foreign-SIGNATURE backstop inside a family", () => {
    // Same family by name, but the number carries another marque's
    // signature — the escape re-runs the full guard, so it still drops.
    // A Toyota 5-5 number on a Ford-family config, stamped Lincoln.
    expect(guard("Lincoln", "Ford", "90915-YZZF2")).toBe(false);
  });

  it("is reversible with PARTS_I1_FAMILY_READ=off", () => {
    const prev = process.env.PARTS_I1_FAMILY_READ;
    process.env.PARTS_I1_FAMILY_READ = "off";
    try {
      expect(guard("Chevrolet", "Buick", "88864542")).toBe(false);
      // Same-make duplicate-row bridging is unaffected by the switch.
      expect(guard("Buick", "BUICK", "88864542")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PARTS_I1_FAMILY_READ;
      else process.env.PARTS_I1_FAMILY_READ = prev;
    }
  });
});
