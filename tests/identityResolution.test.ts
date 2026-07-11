/**
 * identityResolution — fill identity gaps from trim tokens + VDB decode so
 * applyApplicabilityRules stops failing open (2001 BMW 740iA post-mortem:
 * null drivetrain/transmission/body meant no rule fired on a RWD sedan).
 */
import { describe, it, expect } from "vitest";
import {
  deriveIdentityFromTrim,
  mergeIdentity,
} from "../convex/vehicleEnrichment/identityResolution";

describe("deriveIdentityFromTrim", () => {
  it("derives sedan + automatic from the 740iA trim string, drivetrain stays null", () => {
    const d = deriveIdentityFromTrim("iA 4dr Sedan Automatic");
    expect(d.body_class).toBe("sedan");
    expect(d.transmission_type).toBe("automatic");
    expect(d.drivetrain).toBeNull(); // no explicit token — never guess RWD
  });

  it("derives explicit drivetrain tokens including brand AWD marks", () => {
    expect(deriveIdentityFromTrim("330i xDrive Sedan").drivetrain).toBe("AWD");
    expect(deriveIdentityFromTrim("A4 Quattro Premium").drivetrain).toBe("AWD");
    expect(deriveIdentityFromTrim("E350 4MATIC Wagon").drivetrain).toBe("AWD");
    expect(deriveIdentityFromTrim("Tacoma TRD 4x4").drivetrain).toBe("4WD");
  });

  it("does NOT derive body class from trim-level marketing words", () => {
    // "Touring" is a Honda trim level, not a wagon claim.
    expect(deriveIdentityFromTrim("Accord Touring").body_class).toBeNull();
    expect(deriveIdentityFromTrim("Civic Sport").body_class).toBeNull();
  });

  it("does NOT derive drivetrain from ambiguous sDrive", () => {
    // sDrive is RWD on a Z4 but FWD on an X1 — must stay null.
    expect(deriveIdentityFromTrim("X1 sDrive28i").drivetrain).toBeNull();
  });

  it("handles CVT and manual tokens", () => {
    expect(deriveIdentityFromTrim("2.5 S CVT Sedan").transmission_type).toBe("CVT");
    expect(deriveIdentityFromTrim("GTI 6-Speed Manual Hatchback").transmission_type).toBe("manual");
  });

  it("returns all nulls for empty input", () => {
    const d = deriveIdentityFromTrim(null);
    expect(d).toEqual({ body_class: null, transmission_type: null, drivetrain: null });
  });
});

describe("mergeIdentity", () => {
  const trimDerived = deriveIdentityFromTrim("iA 4dr Sedan Automatic");

  it("fills nulls from trim when base and VDB are empty (740iA case)", () => {
    const merged = mergeIdentity(null, null, trimDerived);
    expect(merged.body_class).toBe("sedan");
    expect(merged.transmission_type).toBe("automatic");
    expect(merged.drivetrain).toBeNull();
  });

  it("prefers DB decode over VDB over trim", () => {
    const base = mergeIdentity(null, null, {
      body_class: null,
      transmission_type: null,
      drivetrain: null,
    });
    base.drivetrain = "AWD"; // DB decode says AWD
    const merged = mergeIdentity(
      base,
      { drivetrain: "Rear Wheel Drive", bodyType: "Coupe", transType: null },
      trimDerived,
    );
    expect(merged.drivetrain).toBe("AWD"); // DB wins
    expect(merged.body_class).toBe("Coupe"); // VDB beats trim ("sedan")
    expect(merged.transmission_type).toBe("automatic"); // trim fills the rest
  });

  it("normalizes VDB drivetrain strings to rule codes", () => {
    const merged = mergeIdentity(
      null,
      { drivetrain: "Rear Wheel Drive" },
      { body_class: null, transmission_type: null, drivetrain: null },
    );
    expect(merged.drivetrain).toBe("RWD");
  });

  it("leaves unrecognized VDB drivetrain null rather than passing garbage", () => {
    const merged = mergeIdentity(
      null,
      { drivetrain: "Direct Drive" },
      { body_class: null, transmission_type: null, drivetrain: null },
    );
    expect(merged.drivetrain).toBeNull();
  });

  it("preserves base fields it doesn't touch", () => {
    const base = mergeIdentity(null, null, {
      body_class: null,
      transmission_type: null,
      drivetrain: null,
    });
    base.cylinders = 8;
    const merged = mergeIdentity(base, null, trimDerived);
    expect(merged.cylinders).toBe(8);
  });
});
