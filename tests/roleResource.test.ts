import { describe, expect, it } from "vitest";
import {
  TRIM_SENSITIVE_ROLE_KEYS,
  isPositiveAbsenceReason,
  trimQueryToken,
} from "../convex/vehicleEnrichment/utils/roleResource";

describe("trimQueryToken — trims usable in a site-scoped SERP", () => {
  it("passes real trim badges through", () => {
    expect(trimQueryToken("Sport")).toBe("Sport");
    expect(trimQueryToken("Sport SE")).toBe("Sport SE");
    expect(trimQueryToken("GT")).toBe("GT");
    expect(trimQueryToken("Limited")).toBe("Limited");
    expect(trimQueryToken("SLE")).toBe("SLE");
  });

  it("rejects decoder-derived body-spec sentences", () => {
    // The 2011 Acura TL's stored trim — a query with this in it finds nothing.
    expect(trimQueryToken("3.5 4dr Front-wheel Drive Sedan Automatic")).toBeNull();
    expect(trimQueryToken("EX-L 4dr Sedan CVT")).toBeNull();
    expect(trimQueryToken("SR5 Double Cab")).toBeNull();
  });

  it("rejects grade-less fillers that select nothing", () => {
    expect(trimQueryToken("Base")).toBeNull();
    expect(trimQueryToken("Standard")).toBeNull();
    expect(trimQueryToken("")).toBeNull();
    expect(trimQueryToken(null)).toBeNull();
    expect(trimQueryToken(undefined)).toBeNull();
  });

  it("caps length so long marketing names don't bloat the query", () => {
    expect(trimQueryToken("Ultimate Calligraphy")).toBeNull();
  });
});

describe("TRIM_SENSITIVE_ROLE_KEYS", () => {
  it("covers exactly the brake roles trims differentiate", () => {
    expect([...TRIM_SENSITIVE_ROLE_KEYS].sort()).toEqual([
      "front_brake_pad",
      "front_rotor",
      "rear_brake_pad",
      "rear_rotor",
    ]);
  });
});

describe("isPositiveAbsenceReason — N/A persistence gate", () => {
  it("accepts positive absence findings", () => {
    expect(isPositiveAbsenceReason("rear drum brakes — no rear rotor")).toBe(true);
    expect(isPositiveAbsenceReason("electric power steering, no PS fluid")).toBe(true);
    expect(isPositiveAbsenceReason("timing chain — no scheduled replacement")).toBe(true);
    expect(isPositiveAbsenceReason("this trim is not equipped with a serpentine belt")).toBe(true);
  });
  it("rejects budget/confirmation failures dressed as N/A", () => {
    // Verbatim class from the live Aug 21 failure on the Accord Sport.
    expect(
      isPositiveAbsenceReason(
        "No Sport-trim-specific front rotor OEM part number could be confirmed within search budget.",
      ),
    ).toBe(false);
    expect(isPositiveAbsenceReason("could not find a listing for this exact vehicle")).toBe(false);
    expect(isPositiveAbsenceReason("unable to verify fitment")).toBe(false);
  });
  it("rejects empty and vague reasons", () => {
    expect(isPositiveAbsenceReason("")).toBe(false);
    expect(isPositiveAbsenceReason(null)).toBe(false);
    expect(isPositiveAbsenceReason("probably not needed")).toBe(false);
  });
});
