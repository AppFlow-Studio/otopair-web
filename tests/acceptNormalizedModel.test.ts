/**
 * Decode-time LLM model-normalizer gate (round 3, Aug 2026).
 *
 * Live defect: VIN JA4J4UA85NZ067758 is a 2022 Mitsubishi Outlander. vPIC
 * decoded Model "Outlander" (Series2 "Wagon body style", Trim
 * "SE/Black Edition/SE/LE/SEL/GT") and VDB decoded Model "Outlander", trim
 * "SE" — neither source ever produced the word "Sport". The config was stored
 * as `2022_mitsubishi_outlander_sport_se_2_5l_4cyl` with model "Outlander
 * Sport", the RVR-based compact: a different vehicle, platform and engine.
 * The normalizer's model was applied unconditionally, unlike its trim, which
 * round 8 had already gated.
 */
import { describe, test, expect } from "vitest";
import { acceptNormalizedModel } from "../convex/vehicleEnrichment/identityResolution";

// The exact nameplate evidence for JA4J4UA85NZ067758, in the caller's order.
const OUTLANDER_EVIDENCE = [
  "Outlander", // merged model
  "SE", // merged trim (VDB)
  "", // trim2
  "", // series
  "Wagon body style", // series2
  "Outlander", // vdb model
  "SE", // vdb trim
];

describe("acceptNormalizedModel — the live Outlander defect", () => {
  test('rejects "Outlander Sport" over a decoded "Outlander"', () => {
    expect(acceptNormalizedModel("Outlander Sport", "Outlander", OUTLANDER_EVIDENCE)).toBe(false);
  });

  test("accepts the decoded nameplate unchanged", () => {
    expect(acceptNormalizedModel("Outlander", "Outlander", OUTLANDER_EVIDENCE)).toBe(true);
  });

  test("a real Outlander Sport — decoders say so — is accepted", () => {
    expect(
      acceptNormalizedModel("Outlander Sport", "Outlander Sport", [
        "Outlander Sport",
        "SE",
      ]),
    ).toBe(true);
  });

  test('body-class text cannot corroborate "Sport" — the near-miss that hid this', () => {
    // vPIC's body class for this VIN is "Sport Utility Vehicle [SUV]/...".
    // Its "sport" token would otherwise vouch for the invented nameplate on
    // essentially every SUV in the fleet.
    expect(
      acceptNormalizedModel("Outlander Sport", "Outlander", [
        ...OUTLANDER_EVIDENCE,
        "Sport Utility Vehicle [SUV]/Multipurpose Vehicle [MPV]",
      ]),
    ).toBe(false);
  });
});

describe("acceptNormalizedModel — restructuring stays allowed", () => {
  test("the normalizer's core job: model-in-trim-field is still fixed", () => {
    // NHTSA gives BMW Model="M550i", Trim="xdrive"; the normalizer's whole
    // purpose is model "5 Series" + trim "M550i". Not an extension → allowed.
    expect(acceptNormalizedModel("5 Series", "M550i", ["M550i", "xdrive"])).toBe(true);
  });

  test("structural nameplate words are canonicalization, not invention", () => {
    expect(acceptNormalizedModel("3 Series", "3", ["3", "330i"])).toBe(true);
    expect(acceptNormalizedModel("C-Class", "C", ["C", "C300"])).toBe(true);
  });

  test("an appended token the decode corroborates is accepted", () => {
    // NHTSA Model "Silverado" + Series "1500" → "Silverado 1500".
    expect(
      acceptNormalizedModel("Silverado 1500", "Silverado", ["Silverado", "1500", "LT"]),
    ).toBe(true);
  });

  test("casing and punctuation differences are not extensions", () => {
    expect(acceptNormalizedModel("CX-5", "CX5", ["CX5", "Touring"])).toBe(true);
    expect(acceptNormalizedModel("outlander", "Outlander", OUTLANDER_EVIDENCE)).toBe(true);
  });
});

describe("acceptNormalizedModel — other sibling-nameplate inventions", () => {
  test("body-variant and sub-nameplate additions are rejected without evidence", () => {
    expect(acceptNormalizedModel("Q5 Sportback", "Q5", ["Q5", "Premium Plus"])).toBe(false);
    expect(acceptNormalizedModel("Grand Cherokee L", "Grand Cherokee", ["Grand Cherokee", "Limited"])).toBe(false);
    expect(acceptNormalizedModel("Grand Highlander", "Highlander", ["Highlander", "XLE"])).toBe(false);
  });

  test("the same additions ARE accepted when a decoder produced them", () => {
    expect(
      acceptNormalizedModel("Grand Cherokee L", "Grand Cherokee", ["Grand Cherokee", "L", "Limited"]),
    ).toBe(true);
    expect(
      acceptNormalizedModel("Q5 Sportback", "Q5", ["Q5", "Sportback Premium Plus"]),
    ).toBe(true);
  });
});

describe("acceptNormalizedModel — fail-open edges", () => {
  test("no decoded model to extend → the normalizer is the only source", () => {
    expect(acceptNormalizedModel("Outlander Sport", "", ["SE"])).toBe(true);
    expect(acceptNormalizedModel("Outlander Sport", null, ["SE"])).toBe(true);
    expect(acceptNormalizedModel("Outlander Sport", undefined, [])).toBe(true);
  });

  test("empty normalized model is never accepted", () => {
    expect(acceptNormalizedModel("", "Outlander", OUTLANDER_EVIDENCE)).toBe(false);
    expect(acceptNormalizedModel("   ", "Outlander", OUTLANDER_EVIDENCE)).toBe(false);
    expect(acceptNormalizedModel(null, "Outlander", OUTLANDER_EVIDENCE)).toBe(false);
  });

  test("no evidence at all still blocks a bare invention over a decoded model", () => {
    // The decoded model IS evidence; extending it with an unseen token is an
    // invention whether or not other fields decoded.
    expect(acceptNormalizedModel("Outlander Sport", "Outlander", [])).toBe(false);
  });

  test("evidence entries may be null/undefined without throwing", () => {
    expect(
      acceptNormalizedModel("Outlander Sport", "Outlander", [null, undefined, ""]),
    ).toBe(false);
  });

  test("token-reordering is not an extension", () => {
    expect(acceptNormalizedModel("Series 3", "3 Series", ["3 Series"])).toBe(true);
  });
});
