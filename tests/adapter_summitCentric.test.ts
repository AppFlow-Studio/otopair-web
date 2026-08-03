/**
 * Unit tests for the Centric-via-Summit rotor-spec adapter's pure parsers.
 *
 * Fixtures were captured 2026-07-30 through a real browser (Summit serves an
 * Imperva "Pardon Our Interruption" interstitial to plain fetch — HTTP 200,
 * ~6 KB of challenge script — so lookup() reports needs_headless and these
 * parsers are what the headless tier will run on).
 *
 * Ground truth for ceb-120-45034 (Centric Premium, NA Miata front):
 *   Nominal Thickness (mm): 18.00 / Discard Thickness (mm): 16.00.
 */
import { describe, expect, test } from "vitest";
// @ts-ignore vite ?raw imports are resolved by vitest's transform
import partPage from "./fixtures/sourceAdapters/summitCentric/part-ceb-120-45034.html?raw";
// @ts-ignore vite ?raw imports are resolved by vitest's transform
import searchPage from "./fixtures/sourceAdapters/summitCentric/search-2015-mx5-front.html?raw";
// @ts-ignore vite ?raw imports are resolved by vitest's transform
import interstitial from "./fixtures/sourceAdapters/summitCentric/imperva-interstitial.html?raw";
import {
  isBotChallenge,
  parseSummitFitmentListing,
  parseSummitRotorSpecClaims,
  summitCentricAdapter,
  summitSearchUrl,
  summitSlug,
} from "../convex/vehicleEnrichment/sourceAdapters/summitCentric";
import { labelSupportsKind } from "../convex/vehicleEnrichment/rotorThickness";

const PART_URL = "https://www.summitracing.com/parts/ceb-120-45034";

describe("parseSummitRotorSpecClaims (part page fixture)", () => {
  test("front: emits discard min + nominal with verbatim labels", () => {
    const claims = parseSummitRotorSpecClaims(partPage, {
      position: "front",
      sourceUrl: PART_URL,
      observedAt: 1_753_800_000_000,
    });
    expect(claims).toHaveLength(2);

    const min = claims.find(
      (c) => c.field_key === "rotor_front_min_thickness_mm",
    );
    expect(min).toBeDefined();
    expect(min!.value).toBe("16");
    expect(min!.value_raw).toBe("16.00");
    expect(min!.observed_label).toBe("Discard Thickness (mm):");
    // The pipeline-wide structural guard must accept this label as-is.
    expect(labelSupportsKind(min!.observed_label, "discard_min")).toBe(true);
    expect(min!.source_family).toBe("aftermarket_catalog");
    expect(min!.source_domain).toBe("summitracing.com");
    expect(min!.source_url).toBe(PART_URL);
    expect(min!.method).toBe("deterministic_parse");
    expect(min!.observed_at).toBe(1_753_800_000_000);

    const nom = claims.find(
      (c) => c.field_key === "rotor_front_nominal_thickness_mm",
    );
    expect(nom).toBeDefined();
    expect(nom!.value).toBe("18");
    expect(nom!.value_raw).toBe("18.00");
    expect(nom!.observed_label).toBe("Nominal Thickness (mm):");
  });

  test("rear: same page parsed under rear context keys the rear fields", () => {
    const claims = parseSummitRotorSpecClaims(partPage, {
      position: "rear",
      sourceUrl: PART_URL,
    });
    expect(claims.map((c) => c.field_key).sort()).toEqual([
      "rotor_rear_min_thickness_mm",
      "rotor_rear_nominal_thickness_mm",
    ]);
  });

  test("a machine-to label is never emitted as a minimum", () => {
    const mutated = partPage.replace(
      "Discard Thickness",
      "Minimum Machining Thickness",
    );
    const claims = parseSummitRotorSpecClaims(mutated, {
      position: "front",
      sourceUrl: PART_URL,
    });
    // machine_to has no field; only the nominal survives.
    expect(claims.map((c) => c.field_key)).toEqual([
      "rotor_front_nominal_thickness_mm",
    ]);
  });

  test("discard >= nominal is nonsense: both numbers are refused", () => {
    const mutated = partPage.replace("16.00", "19.00");
    expect(
      parseSummitRotorSpecClaims(mutated, {
        position: "front",
        sourceUrl: PART_URL,
      }),
    ).toEqual([]);
  });

  test("a minimum outside the axle's physical band is dropped", () => {
    const mutated = partPage.replace("16.00", "2.00"); // < front validLow 8
    const claims = parseSummitRotorSpecClaims(mutated, {
      position: "front",
      sourceUrl: PART_URL,
    });
    expect(claims.map((c) => c.field_key)).toEqual([
      "rotor_front_nominal_thickness_mm",
    ]);
  });

  test("non-rotor part page (Part Type != Brake Rotors) yields nothing", () => {
    const mutated = partPage.split("Brake Rotors").join("Brake Pads");
    expect(
      parseSummitRotorSpecClaims(mutated, {
        position: "front",
        sourceUrl: PART_URL,
      }),
    ).toEqual([]);
  });

  test("malformed input fails open to []", () => {
    for (const bad of [
      "",
      null,
      undefined,
      "<html><body>💥 not a part page</body></html>",
      "Discard Thickness (mm): 16.00", // right words, wrong structure
      partPage.slice(0, 300), // truncated mid-head
    ]) {
      expect(
        parseSummitRotorSpecClaims(bad as string, {
          position: "front",
          sourceUrl: PART_URL,
        }),
      ).toEqual([]);
    }
  });

  test("the Imperva interstitial yields nothing", () => {
    expect(isBotChallenge(interstitial)).toBe(true);
    expect(isBotChallenge(partPage)).toBe(false);
    expect(
      parseSummitRotorSpecClaims(interstitial, {
        position: "front",
        sourceUrl: PART_URL,
      }),
    ).toEqual([]);
  });
});

describe("parseSummitFitmentListing (search fixture)", () => {
  test("verifies the H1 vehicle and extracts the ceb- SKUs, deduped", () => {
    const out = parseSummitFitmentListing(searchPage, {
      year: 2015,
      make: "Mazda",
    });
    expect(out.verified).toBe(true);
    expect(out.skus).toEqual(["ceb-120-45075"]);
  });

  test("segment-drop guard: H1 without the requested year/make yields []", () => {
    // Summit silently strips zero-match facet segments; the served page is
    // then some other vehicle's listing and must be refused wholesale.
    const wrongYear = parseSummitFitmentListing(searchPage, {
      year: 2020,
      make: "Mazda",
    });
    expect(wrongYear).toEqual({ verified: false, skus: [] });

    const wrongMake = parseSummitFitmentListing(searchPage, {
      year: 2015,
      make: "Toyota",
    });
    expect(wrongMake).toEqual({ verified: false, skus: [] });
  });

  test("malformed input fails open", () => {
    for (const bad of ["", null, undefined, "<div>no h1 here</div>"]) {
      expect(
        parseSummitFitmentListing(bad as string, { year: 2015, make: "Mazda" }),
      ).toEqual({ verified: false, skus: [] });
    }
    expect(
      parseSummitFitmentListing(interstitial, { year: 2015, make: "Mazda" }),
    ).toEqual({ verified: false, skus: [] });
  });
});

describe("URL construction", () => {
  test("slugs match Summit's path style", () => {
    expect(summitSlug("MX-5 Miata")).toBe("mx-5-miata");
    expect(summitSlug("F-150")).toBe("f-150");
    expect(summitSlug("Camry")).toBe("camry");
  });

  test("search URL keeps year BEFORE make (order is load-bearing)", () => {
    expect(
      summitSearchUrl(
        { year: 2019, make: "Ford", model: "F-150" },
        "front",
      ),
    ).toBe(
      "https://www.summitracing.com/search/part-type/brake-rotors" +
        "/year/2019/make/ford/model/f-150/brand/centric-parts" +
        "/rotor-position/front",
    );
  });
});

describe("adapter contract", () => {
  test("exports the SourceAdapter shape with real V4 field keys", () => {
    expect(summitCentricAdapter.name).toBe("summit_centric_rotor_specs");
    expect(summitCentricAdapter.family).toBe("aftermarket_catalog");
    expect([...summitCentricAdapter.fields].sort()).toEqual([
      "rotor_front_min_thickness_mm",
      "rotor_front_nominal_thickness_mm",
      "rotor_rear_min_thickness_mm",
      "rotor_rear_nominal_thickness_mm",
    ]);
    expect(typeof summitCentricAdapter.lookup).toBe("function");
  });
});
