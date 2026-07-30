/**
 * WIX Filters adapter — pure-parser tests against live-captured fixtures
 * (m.wixfilters.com JSON, captured 2026-07-30; no network in tests).
 *
 * Fixtures are VERBATIM server responses:
 *   camry-parts-2020.json   /search/SearchPartsByVehicle3?vehicleYear=2020&
 *                           section=1&make=76&model=884&engine=53724
 *   f150-parts-2019.json    …?vehicleYear=2019&section=1&make=28&model=36053&engine=91121
 *   engines-camry-2020.json /search/MakeEngines2?vehicleYear=2020&section=1&make=76&model=884
 *   engines-f150-2019.json  /search/MakeEngines2?vehicleYear=2019&section=1&make=28&model=36053
 *   interchange-90915.json  /Search/InterchangeSearch?partNumber=90915  (117 rows)
 *   interchange-87139.json  /Search/InterchangeSearch?partNumber=87139  (92 rows)
 *   interchange-17801-trimmed.json  …?partNumber=17801 trimmed to the two
 *                           WA10859 hits + the first 60 rows of noise (the
 *                           full 349-row response is 79KB).
 *
 * The laws under test: WIX numbers are never field values (only the OE
 * numbers they replace are), prefix anchoring drops legacy concatenations,
 * child equality + Manufacturer filtering keep foreign rows out, engine
 * disagreement drops a field, malformed input fails open to [].
 */
import { describe, expect, test } from "vitest";
import {
  agreedPartsByField,
  filterTypeFieldKey,
  matchEngines,
  matchOption,
  parseCascadeOptions,
  parseInterchangeClaims,
  parseVehicleParts,
  wixFiltersAdapter,
  WIX_FILTER_FIELDS,
} from "../convex/vehicleEnrichment/sourceAdapters/wixFilters";
import { V4_FIELD_KEYS } from "../convex/vehicleEnrichment/types";
import camryParts from "./fixtures/sourceAdapters/wixFilters/camry-parts-2020.json";
import f150Parts from "./fixtures/sourceAdapters/wixFilters/f150-parts-2019.json";
import enginesCamry from "./fixtures/sourceAdapters/wixFilters/engines-camry-2020.json";
import enginesF150 from "./fixtures/sourceAdapters/wixFilters/engines-f150-2019.json";
import inter90915 from "./fixtures/sourceAdapters/wixFilters/interchange-90915.json";
import inter87139 from "./fixtures/sourceAdapters/wixFilters/interchange-87139.json";
import inter17801 from "./fixtures/sourceAdapters/wixFilters/interchange-17801-trimmed.json";

const j = (v: unknown) => JSON.stringify(v);

describe("adapter shape", () => {
  test("exports the SourceAdapter contract with real field keys", () => {
    expect(wixFiltersAdapter.name).toBe("wix_filters");
    expect(wixFiltersAdapter.family).toBe("aftermarket_catalog");
    for (const f of wixFiltersAdapter.fields) {
      expect(V4_FIELD_KEYS).toContain(f);
    }
    expect([...wixFiltersAdapter.fields].sort()).toEqual(
      [...WIX_FILTER_FIELDS].sort(),
    );
  });
});

describe("parseCascadeOptions / matchOption", () => {
  test("parses the real engines payload", () => {
    const opts = parseCascadeOptions(j(enginesCamry));
    expect(opts).toHaveLength(4); // "All Engines" + 3 real engines
    expect(opts[0]).toEqual({ id: 0, description: "All Engines" });
  });

  test("exact match beats containment; containment must be unique", () => {
    const options = [
      { id: 1, description: "CAMRY" },
      { id: 2, description: "CAMRY SOLARA" },
      { id: 3, description: "PICKUP F150 ALL" },
    ];
    expect(matchOption(options, "Camry")?.id).toBe(1);
    expect(matchOption(options, "F-150")?.id).toBe(3);
    // "CAM" is contained by two options → ambiguous → null.
    expect(matchOption(options, "CAM")).toBeNull();
    expect(matchOption(options, "COROLLA")).toBeNull();
  });

  test("malformed cascade JSON fails open to []", () => {
    expect(parseCascadeOptions("<!DOCTYPE html><h1>maintenance</h1>")).toEqual([]);
    expect(parseCascadeOptions('{"ID":1}')).toEqual([]);
    expect(parseCascadeOptions("")).toEqual([]);
  });
});

describe("matchEngines", () => {
  const camry = parseCascadeOptions(j(enginesCamry));
  const f150 = parseCascadeOptions(j(enginesF150));

  test("displacement pins the F-150 5.0L uniquely", () => {
    const hits = matchEngines(f150, {
      engine_code: null,
      displacement_l: 5.0,
      cylinders: 8,
    });
    expect(hits.map((h) => h.id)).toEqual([91121]);
  });

  test("2.5L Camry without engine_code is 2-way ambiguous (gas vs hybrid)", () => {
    const hits = matchEngines(camry, {
      engine_code: null,
      displacement_l: 2.5,
      cylinders: 4,
    });
    expect(hits.map((h) => h.id).sort()).toEqual([53724, 67922]);
  });

  test("engine_code narrows to the hybrid row that carries it verbatim", () => {
    const hits = matchEngines(camry, {
      engine_code: "A25A-FXS",
      displacement_l: 2.5,
      cylinders: 4,
    });
    expect(hits.map((h) => h.id)).toEqual([67922]);
  });

  test('"All Engines" (ID 0) is never a candidate', () => {
    const hits = matchEngines(camry, {
      engine_code: null,
      displacement_l: null,
      cylinders: null,
    });
    expect(hits.some((h) => h.id === 0)).toBe(false);
    expect(hits).toHaveLength(3);
  });
});

describe("parseVehicleParts", () => {
  test("Camry: oil/air/cabin extracted, NS fuel placeholder dropped", () => {
    const parts = parseVehicleParts(j(camryParts));
    const by = (k: string) =>
      parts.filter((p) => p.fieldKey === k).map((p) => p.partNumber).sort();
    expect(by("oil_filter_oem")).toEqual(["51394", "51394XP"]);
    expect(by("air_filter_oem")).toEqual(["WA10859"]);
    // FilterType arrives as " C Air" (leading space) — both cabin rows land.
    expect(by("cabin_filter_oem")).toEqual(["WP10320", "WP10322"]);
    expect(parts.some((p) => p.partNumber === "NS")).toBe(false);
  });

  test("F-150: oil 57502/57502XP, air 49883/49883FR, cabin WP10266/WP10653/WP10266XP", () => {
    const parts = parseVehicleParts(j(f150Parts));
    const by = (k: string) =>
      parts.filter((p) => p.fieldKey === k).map((p) => p.partNumber).sort();
    expect(by("oil_filter_oem")).toEqual(["57502", "57502XP"]);
    expect(by("air_filter_oem")).toEqual(["49883", "49883FR"]);
    expect(by("cabin_filter_oem")).toEqual(["WP10266", "WP10266XP", "WP10653"]);
  });

  test("malformed input fails open to []", () => {
    expect(parseVehicleParts("<html>block page</html>")).toEqual([]);
    expect(parseVehicleParts('[{"PartNumber": 42}]')).toEqual([]);
    expect(parseVehicleParts("null")).toEqual([]);
  });
});

describe("filterTypeFieldKey", () => {
  test("maps the three filter types (including WIX's ' C Air' spacing)", () => {
    expect(filterTypeFieldKey("Oil")).toBe("oil_filter_oem");
    expect(filterTypeFieldKey("Air")).toBe("air_filter_oem");
    expect(filterTypeFieldKey(" C Air")).toBe("cabin_filter_oem");
    expect(filterTypeFieldKey("Fuel")).toBeNull();
    expect(filterTypeFieldKey("Trans")).toBeNull();
  });
});

describe("agreedPartsByField", () => {
  const oil51394 = { fieldKey: "oil_filter_oem" as const, partNumber: "51394" };
  const airA = { fieldKey: "air_filter_oem" as const, partNumber: "WA10859" };
  const airB = { fieldKey: "air_filter_oem" as const, partNumber: "WA10390" };

  test("keeps a field only when every engine candidate agrees on the set", () => {
    const agreed = agreedPartsByField([
      [oil51394, airA],
      [oil51394, airB],
    ]);
    expect(agreed.get("oil_filter_oem")).toEqual(["51394"]);
    expect(agreed.has("air_filter_oem")).toBe(false);
  });

  test("single engine passes everything through", () => {
    const agreed = agreedPartsByField([[oil51394, airA]]);
    expect(agreed.get("air_filter_oem")).toEqual(["WA10859"]);
  });
});

describe("parseInterchangeClaims — the OE cross-reference law", () => {
  const camryOilOpts = {
    fieldKey: "oil_filter_oem" as const,
    wixPartNumbers: ["51394", "51394XP"],
    oePrefixes: ["90915"],
    manufacturers: ["TOYOTA", "LEXUS", "SCION"],
    sourceUrl: "https://m.wixfilters.com/Search/InterchangeSearch?partNumber=90915",
    observedAt: 1_753_000_000_000,
  };

  test("Camry oil: Toyota OE numbers whose WIX child is 51394/51394XP", () => {
    const claims = parseInterchangeClaims(j(inter90915), camryOilOpts);
    const values = claims.map((c) => c.value);
    // Live-verified members of the cross set.
    expect(values).toContain("9091503001");
    expect(values).toContain("90915YZZF2");
    expect(values).toContain("90915YZZJ1");
    // Legacy concatenations CONTAIN 90915 but do not START with it — anchored out.
    expect(values).not.toContain("0060290915005");
    expect(values).not.toContain("60290915005");
    // Every claim is a real V4 field key with full provenance; the WIX part
    // number appears ONLY in observed_label, never as the value.
    for (const c of claims) {
      expect(c.field_key).toBe("oil_filter_oem");
      expect(c.value.startsWith("90915")).toBe(true);
      expect(c.value).not.toBe("51394");
      expect(c.source_family).toBe("aftermarket_catalog");
      expect(c.source_domain).toBe("m.wixfilters.com");
      expect(c.method).toBe("deterministic_parse");
      expect(c.observed_label).toMatch(/^WIX 51394(XP)? OE cross-reference \(TOYOTA\)$/);
      expect(c.observed_at).toBe(1_753_000_000_000);
    }
    // Dedup: 51394 and 51394XP replace the same OE numbers → one claim each.
    expect(new Set(values).size).toBe(values.length);
    // Deterministic ordering.
    expect(values).toEqual([...values].sort());
  });

  test("Camry cabin: verbatim raw is preserved (incl. trailing-space row trimmed)", () => {
    const claims = parseInterchangeClaims(j(inter87139), {
      fieldKey: "cabin_filter_oem",
      wixPartNumbers: ["WP10320", "WP10322"],
      oePrefixes: ["87139"],
      manufacturers: ["TOYOTA", "LEXUS", "SCION"],
      observedAt: 1,
    });
    const byValue = new Map(claims.map((c) => [c.value, c]));
    expect(byValue.has("871390K070")).toBe(true);
    // Fixture row is "87139-0K070 " (trailing space) — value_raw is trimmed verbatim.
    expect(byValue.get("871390K070")?.value_raw).toBe("87139-0K070");
    expect(byValue.has("8713928020")).toBe(true);
    for (const c of claims) expect(c.field_key).toBe("cabin_filter_oem");
  });

  test("Camry air: 17801-F0050 and 17801-25020 cross to WA10859", () => {
    const claims = parseInterchangeClaims(j(inter17801), {
      fieldKey: "air_filter_oem",
      wixPartNumbers: ["WA10859"],
      oePrefixes: ["17801"],
      manufacturers: ["TOYOTA", "LEXUS", "SCION"],
      observedAt: 1,
    });
    expect(claims.map((c) => c.value).sort()).toEqual(["1780125020", "17801F0050"]);
  });

  test("child equality guard: a foreign WIX part yields nothing", () => {
    const claims = parseInterchangeClaims(j(inter90915), {
      ...camryOilOpts,
      wixPartNumbers: ["24419"], // a cabin part — no 90915 row crosses to it
    });
    expect(claims).toEqual([]);
  });

  test("manufacturer guard: non-OE brands in the response never leak", () => {
    const claims = parseInterchangeClaims(j(inter90915), camryOilOpts);
    // The 90915 response also carries VW GROUP / KOMATSU rows.
    expect(claims.every((c) => /\(TOYOTA\)$/.test(c.observed_label ?? ""))).toBe(true);
  });

  test("inactive rows are dropped", () => {
    const rows = [
      {
        PartID: "1",
        PartNumber: "90915-TEST1",
        ChildPartNumber: "51394",
        Manufacturer: "TOYOTA",
        Status: "I",
      },
      {
        PartID: "2",
        PartNumber: "90915-TEST2",
        ChildPartNumber: "51394",
        Manufacturer: "TOYOTA",
        Status: "A",
      },
    ];
    const claims = parseInterchangeClaims(j(rows), camryOilOpts);
    expect(claims.map((c) => c.value)).toEqual(["90915TEST2"]);
  });

  test("malformed input fails open to []", () => {
    expect(parseInterchangeClaims("<html>503</html>", camryOilOpts)).toEqual([]);
    expect(parseInterchangeClaims("", camryOilOpts)).toEqual([]);
    expect(parseInterchangeClaims('{"rows": []}', camryOilOpts)).toEqual([]);
    expect(
      parseInterchangeClaims(j(inter90915).slice(0, 500), camryOilOpts),
    ).toEqual([]);
    // Rows with missing/mistyped fields are skipped, not thrown on.
    expect(
      parseInterchangeClaims(
        '[{"PartNumber": 90915}, {"Manufacturer":"TOYOTA"}, null, "x"]',
        camryOilOpts,
      ),
    ).toEqual([]);
  });
});
