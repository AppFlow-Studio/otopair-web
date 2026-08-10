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
