import { describe, expect, it } from "vitest";
import {
  MOD_LOCATIONS,
  modLocationLabel,
  legacyModificationsToEntries,
} from "../lib/vehicle-passport";

describe("modLocationLabel", () => {
  it("returns the label for a known location", () => {
    expect(modLocationLabel("wheels_tires")).toBe("Wheels & Tires");
    expect(modLocationLabel("engine")).toBe("Engine");
  });
  it("has 10 locations", () => {
    expect(MOD_LOCATIONS).toHaveLength(10);
  });
});

describe("legacyModificationsToEntries", () => {
  it("returns [] for none_observed and no notes", () => {
    expect(legacyModificationsToEntries({ status: "none_observed", notes: null })).toEqual([]);
  });
  it("returns [] for empty/undefined", () => {
    expect(legacyModificationsToEntries(undefined)).toEqual([]);
    expect(legacyModificationsToEntries({})).toEqual([]);
  });
  it("converts aftermarket_observed into one 'other' entry carrying the notes", () => {
    expect(
      legacyModificationsToEntries({ status: "aftermarket_observed", notes: "Lowered springs" })
    ).toEqual([{ location: "other", description: "Lowered springs" }]);
  });
  it("converts notes-only into one 'other' entry", () => {
    expect(legacyModificationsToEntries({ notes: "Cold air intake" })).toEqual([
      { location: "other", description: "Cold air intake" },
    ]);
  });
  it("passes through already-migrated entries unchanged", () => {
    const entries = [{ location: "suspension", description: "coilovers" }];
    expect(legacyModificationsToEntries({ entries })).toEqual(entries);
  });
  it("converts aftermarket_observed with null notes into an 'other' entry with null description", () => {
    expect(legacyModificationsToEntries({ status: "aftermarket_observed", notes: null })).toEqual([
      { location: "other", description: null },
    ]);
  });
  it("treats an empty entries array as already-migrated (returns [])", () => {
    expect(legacyModificationsToEntries({ entries: [] })).toEqual([]);
  });
});
