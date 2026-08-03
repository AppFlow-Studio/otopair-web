/**
 * Unit tests for the Brembo disc-catalogue adapter's pure parsers
 * (convex/vehicleEnrichment/sourceAdapters/brembo.ts). No network — fixtures
 * are trimmed captures of live bremboparts.com pages (2026-07-30):
 *
 *   disc-09-9554-10.html  — front disc, clean values (TH 21mm / Min 19mm)
 *   disc-08-D418-11.html  — REAR Camry disc with two real quirks preserved:
 *                           decimal comma "10,5mm" and a bogus
 *                           "Thickness (TH) 112mm" that must be dropped
 *   application-list-camry.html — application results slice: 3 disc links
 *                           plus a pad link that must be ignored
 *
 * The rotor law under test: a minimum is only ever emitted under a verbatim
 * label that labelSupportsKind(label, "discard_min") accepts, and implausible
 * or inconsistent numbers yield NOTHING (missing beats wrong).
 */
import { describe, expect, test } from "vitest";
import frontDiscHtml from "./fixtures/sourceAdapters/brembo/disc-09-9554-10.html?raw";
import rearDiscHtml from "./fixtures/sourceAdapters/brembo/disc-08-D418-11.html?raw";
import applicationListHtml from "./fixtures/sourceAdapters/brembo/application-list-camry.html?raw";
import {
  dateRangeContainsYear,
  displacementMatches,
  extractDiscLinks,
  modelNameMatches,
  parseBremboDiscPage,
  reconcileDiscClaims,
} from "../convex/vehicleEnrichment/sourceAdapters/brembo";
import type { Claim } from "../convex/vehicleEnrichment/sourceAdapters/types";
import { labelSupportsKind } from "../convex/vehicleEnrichment/rotorThickness";

describe("parseBremboDiscPage — front disc fixture (09.9554.10)", () => {
  const claims = parseBremboDiscPage(frontDiscHtml);

  test("emits exactly min + nominal for the front axle", () => {
    expect(claims.map((c) => c.field_key).sort()).toEqual([
      "rotor_front_min_thickness_mm",
      "rotor_front_nominal_thickness_mm",
    ]);
  });

  test("min claim carries the page's verbatim discard label and value", () => {
    const min = claims.find(
      (c) => c.field_key === "rotor_front_min_thickness_mm",
    )!;
    expect(min.value).toBe("19");
    expect(min.value_raw).toBe("19mm");
    expect(min.observed_label).toBe("Min. thickness");
  });

  test("every emitted min label passes the pipeline's discard-label guard", () => {
    for (const c of claims.filter((c) => c.field_key.includes("_min_"))) {
      expect(labelSupportsKind(c.observed_label, "discard_min")).toBe(true);
    }
  });

  test("nominal comes from 'Thickness (TH)', never confused with the minimum", () => {
    const nominal = claims.find(
      (c) => c.field_key === "rotor_front_nominal_thickness_mm",
    )!;
    expect(nominal.value).toBe("21");
    expect(nominal.observed_label).toBe("Thickness (TH)");
    expect(labelSupportsKind(nominal.observed_label, "discard_min")).toBe(false);
  });

  test("provenance fields are complete", () => {
    for (const c of claims) {
      expect(c.source_family).toBe("aftermarket_catalog");
      expect(c.source_domain).toBe("bremboparts.com");
      expect(c.method).toBe("deterministic_parse");
      // source_url falls back to the page's own canonical link.
      expect(c.source_url).toBe(
        "https://www.bremboparts.com/europe/en/catalogue/disc/09-9554-10",
      );
      expect(typeof c.observed_at).toBe("number");
    }
  });

  test("explicit source_url and observed_at override the canonical fallback", () => {
    const out = parseBremboDiscPage(frontDiscHtml, {
      source_url: "https://www.bremboparts.com/x",
      observed_at: 123,
    });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.source_url).toBe("https://www.bremboparts.com/x");
      expect(c.observed_at).toBe(123);
    }
  });
});

describe("parseBremboDiscPage — rear disc fixture with real data quirks (08.D418.11)", () => {
  const claims = parseBremboDiscPage(rearDiscHtml);

  test("decimal comma '10,5mm' parses to 10.5 on the rear axle", () => {
    const min = claims.find(
      (c) => c.field_key === "rotor_rear_min_thickness_mm",
    )!;
    expect(min).toBeDefined();
    expect(min.value).toBe("10.5");
    expect(min.value_raw).toBe("10,5mm");
    expect(min.observed_label).toBe("Min. thickness");
  });

  test("the bogus 'Thickness (TH) 112mm' is dropped — no nominal claim", () => {
    expect(
      claims.find((c) => c.field_key === "rotor_rear_nominal_thickness_mm"),
    ).toBeUndefined();
  });

  test("nothing leaks onto the front axle", () => {
    expect(claims.every((c) => c.field_key.startsWith("rotor_rear_"))).toBe(
      true,
    );
  });
});

describe("parseBremboDiscPage — refusal paths (fail open)", () => {
  test("malformed / empty input returns []", () => {
    expect(parseBremboDiscPage("<html><div>garbage</div></html>")).toEqual([]);
    expect(parseBremboDiscPage("")).toEqual([]);
    expect(parseBremboDiscPage(null)).toEqual([]);
    expect(parseBremboDiscPage(undefined)).toEqual([]);
    expect(parseBremboDiscPage('{"json":"not html"}')).toEqual([]);
  });

  test("a page without an Axle field yields nothing — axle is never guessed", () => {
    const noAxle = frontDiscHtml.replace(
      /<div class="label">Axle<\/div>/,
      '<div class="label">Something</div>',
    );
    expect(parseBremboDiscPage(noAxle)).toEqual([]);
  });

  test("a nominal that does not exceed its own minimum discards BOTH", () => {
    // Swap the front page's nominal 21mm down to 19mm (== the minimum).
    const inconsistent = frontDiscHtml.replace(
      '<div class="detail">21<span class="unit">mm</span></div>',
      '<div class="detail">19<span class="unit">mm</span></div>',
    );
    expect(parseBremboDiscPage(inconsistent)).toEqual([]);
  });

  test("an out-of-band minimum is dropped", () => {
    // Front valid band is 8..40mm — 99mm must be refused.
    const outOfBand = frontDiscHtml.replace(
      '<div class="detail">19<span class="unit">mm</span></div>',
      '<div class="detail">99<span class="unit">mm</span></div>',
    );
    const claims = parseBremboDiscPage(outOfBand);
    expect(
      claims.find((c) => c.field_key === "rotor_front_min_thickness_mm"),
    ).toBeUndefined();
  });

  test("a value without an explicit mm unit is refused", () => {
    const unitless = frontDiscHtml.replace(
      '<div class="label">Min. thickness</div>\n                            <div class="detail">19<span class="unit">mm</span></div>',
      '<div class="label">Min. thickness</div>\n                            <div class="detail">19</div>',
    );
    const claims = parseBremboDiscPage(unitless);
    expect(
      claims.find((c) => c.field_key === "rotor_front_min_thickness_mm"),
    ).toBeUndefined();
  });
});

describe("extractDiscLinks", () => {
  test("finds the three disc links and ignores the pad link", () => {
    expect(extractDiscLinks(applicationListHtml)).toEqual([
      "/europe/en/catalogue/disc/09-D979-11",
      "/europe/en/catalogue/disc/08-D418-11",
      "/europe/en/catalogue/disc/08-D418-1X",
    ]);
  });

  test("malformed input returns []", () => {
    expect(extractDiscLinks("no links here")).toEqual([]);
    expect(extractDiscLinks("")).toEqual([]);
    expect(extractDiscLinks(null)).toEqual([]);
  });

  test("dedups repeated links, preserving order", () => {
    const html =
      '<a href="/europe/en/catalogue/disc/09-A100-11">x</a>' +
      '<a href="/europe/en/catalogue/disc/09-A100-11">x</a>' +
      '<a href="/europe/en/catalogue/disc/08-B200-11">y</a>';
    expect(extractDiscLinks(html)).toEqual([
      "/europe/en/catalogue/disc/09-A100-11",
      "/europe/en/catalogue/disc/08-B200-11",
    ]);
  });
});

describe("reconcileDiscClaims — cross-variant agreement", () => {
  const claim = (field_key: string, value: string, url = "u1"): Claim => ({
    field_key,
    value,
    source_family: "aftermarket_catalog",
    source_domain: "bremboparts.com",
    source_url: url,
    method: "deterministic_parse",
    observed_label: "Min. thickness",
    observed_at: 1,
  });

  test("agreeing variants collapse to one claim per field", () => {
    const out = reconcileDiscClaims([
      claim("rotor_front_min_thickness_mm", "25", "prime"),
      claim("rotor_front_min_thickness_mm", "25", "xtra"),
      claim("rotor_rear_min_thickness_mm", "10.5", "prime"),
    ]);
    expect(out.map((c) => [c.field_key, c.value]).sort()).toEqual([
      ["rotor_front_min_thickness_mm", "25"],
      ["rotor_rear_min_thickness_mm", "10.5"],
    ]);
  });

  test("conflicting variants emit NOTHING for that field (present-but-wrong forbidden)", () => {
    const out = reconcileDiscClaims([
      claim("rotor_front_min_thickness_mm", "25"),
      claim("rotor_front_min_thickness_mm", "28"),
      claim("rotor_rear_min_thickness_mm", "10.5"),
    ]);
    expect(out.map((c) => c.field_key)).toEqual([
      "rotor_rear_min_thickness_mm",
    ]);
  });

  test("empty input → empty output", () => {
    expect(reconcileDiscClaims([])).toEqual([]);
  });
});

describe("catalogue matching helpers (verified against live API shapes)", () => {
  test("modelNameMatches strips chassis-code parentheticals and prefixes", () => {
    expect(modelNameMatches("Camry", "CAMRY (_V7_, _VA7_, _VH7_)")).toBe(true);
    expect(modelNameMatches("F-150", "F-150 Crew Cab Pickup")).toBe(true);
    expect(modelNameMatches("F-150", "F-150")).toBe(true);
    expect(modelNameMatches("Camry", "COROLLA")).toBe(false);
    expect(modelNameMatches("Camry", "")).toBe(false);
    // Body-style siblings are deliberately admitted (agreement rule guards).
    expect(modelNameMatches("Camry", "CAMRY Estate (_V1_)")).toBe(true);
  });

  test("dateRangeContainsYear handles MM/YY tokens and open '>' ends", () => {
    expect(dateRangeContainsYear("06/17", ">", 2020)).toBe(true);
    expect(dateRangeContainsYear("06/17", ">", 2016)).toBe(false);
    expect(dateRangeContainsYear("08/86", "02/93", 2020)).toBe(false);
    expect(dateRangeContainsYear("08/96", "02/04", 2000)).toBe(true);
    expect(dateRangeContainsYear(null, null, 2020)).toBe(true);
  });

  test("displacementMatches compares the typeName's leading litres", () => {
    expect(displacementMatches("2.5 (ASV70_, ASV70R)", 2.5)).toBe(true);
    expect(displacementMatches("2.0 (ASV71)", 2.5)).toBe(false);
    expect(displacementMatches("5.0 Ti-VCT 4WD", 5.0)).toBe(true);
    // Unknown displacement or non-litre leads cannot be verified → kept.
    expect(displacementMatches("2.0 (ASV71)", null)).toBe(true);
    expect(displacementMatches("C 220 CDI", 2.2)).toBe(true);
  });
});
