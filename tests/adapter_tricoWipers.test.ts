// =============================================================================
// adapter_tricoWipers.test.ts — pure-parser tests against live-captured
// fixtures (tricoproducts.com /landing-result pages, captured 2026-07-30,
// trimmed to the products-grid with all rear + set-note blocks kept).
//
// Fixtures:
//   camry-2020-landing.html  find=toyota-2020-camry-510812027 — sedan, no rear
//                            wiper; four twin-set notes agreeing "26'' and 20''".
//   rav4-2020-landing.html   find=toyota-2020-rav4-510812031 — five set notes
//                            "26'' and 16''", two Position: Rear blocks
//                            (12-A Exact-Fit + 55-121 beam, both 12''), plus a
//                            "Position: Front and Rear" kit (18-2616-12K) that
//                            must NOT be treated as a rear block.
//   toyota-years-options.html  verbatim /amfinder/index/options/ response for
//                            dropdown_id=36&parent_id=510797450 (Toyota years).
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  decodeRearPartInches,
  parseFinderOptions,
  parseLandingResult,
  tricoWipersAdapter,
  TRICO_WIPER_FIELDS,
} from "../convex/vehicleEnrichment/sourceAdapters/tricoWipers";
import { V4_FIELD_KEYS } from "../convex/vehicleEnrichment/types";
import camryHtml from "./fixtures/sourceAdapters/tricoWipers/camry-2020-landing.html?raw";
import rav4Html from "./fixtures/sourceAdapters/tricoWipers/rav4-2020-landing.html?raw";
import toyotaYearsHtml from "./fixtures/sourceAdapters/tricoWipers/toyota-years-options.html?raw";

const OBSERVED_AT = 1_753_900_000_000;
const CAMRY_URL =
  "https://www.tricoproducts.com/landing-result?find=toyota-2020-camry-510812027&landing_page_url=trico_lookup";

function claimsByKey(html: string) {
  const claims = parseLandingResult(html, {
    source_url: CAMRY_URL,
    observed_at: OBSERVED_AT,
  });
  return new Map(claims.map((c) => [c.field_key, c]));
}

describe("decodeRearPartInches", () => {
  it("decodes the Exact-Fit rear letter series (leading digits = inches)", () => {
    expect(decodeRearPartInches("12-A")).toBe(12);
    expect(decodeRearPartInches("11-G")).toBe(11);
    expect(decodeRearPartInches("13-N")).toBe(13);
    expect(decodeRearPartInches("14-B")).toBe(14);
  });

  it("decodes the 55- rear beam series (55-NNx → NN)", () => {
    expect(decodeRearPartInches("55-110")).toBe(11);
    expect(decodeRearPartInches("55-121")).toBe(12);
    expect(decodeRearPartInches("55-131")).toBe(13);
  });

  it("decodes blade-line SKUs listed in rear position (-NN0 suffix → NN)", () => {
    expect(decodeRearPartInches("91-150")).toBe(15);
    expect(decodeRearPartInches("10-150")).toBe(15);
    expect(decodeRearPartInches("24-140DTSC")).toBe(14);
  });

  it("returns null for SKUs with no (or implausible) length signal", () => {
    expect(decodeRearPartInches("18-2616-12K")).toBeNull(); // front+rear kit
    expect(decodeRearPartInches("18-2616")).toBeNull(); // twin set
    expect(decodeRearPartInches("47-700")).toBeNull(); // rear ARM ("70 in")
    expect(decodeRearPartInches("11-604")).toBeNull(); // refill
    expect(decodeRearPartInches("14-1HB")).toBeNull(); // insert
    expect(decodeRearPartInches("")).toBeNull();
    expect(decodeRearPartInches("garbage")).toBeNull();
  });
});

describe("parseLandingResult — 2020 Toyota Camry (no rear wiper)", () => {
  const byKey = claimsByKey(camryHtml);

  it("emits front 26 from the unanimous twin-set notes, and nothing else", () => {
    expect([...byKey.keys()]).toEqual(["front_wiper_size"]);
    const front = byKey.get("front_wiper_size")!;
    expect(front.value).toBe("26"); // driver side, normalized whole-inch string
    expect(front.value_raw).toBe("26''");
    expect(front.observed_label).toContain("this is a 26'' and 20''");
  });

  it("emits no rear claim for a sedan — the null belongs to body-class rules", () => {
    expect(byKey.has("rear_wiper_size")).toBe(false);
  });

  it("stamps claim provenance correctly", () => {
    for (const claim of byKey.values()) {
      expect(claim.source_family).toBe("aftermarket_catalog");
      expect(claim.source_domain).toBe("tricoproducts.com");
      expect(claim.source_url).toBe(CAMRY_URL);
      expect(claim.method).toBe("deterministic_parse");
      expect(claim.observed_at).toBe(OBSERVED_AT);
    }
  });
});

describe("parseLandingResult — 2020 Toyota RAV4 (12'' rear)", () => {
  const byKey = claimsByKey(rav4Html);

  it("emits front 26 (driver) from the '26'' and 16''' set notes", () => {
    const front = byKey.get("front_wiper_size");
    expect(front).toBeDefined();
    expect(front!.value).toBe("26");
  });

  it("emits rear 12 from the agreeing Exact-Fit and 55-series decodes", () => {
    const rear = byKey.get("rear_wiper_size");
    expect(rear).toBeDefined();
    expect(rear!.value).toBe("12");
    expect(rear!.value_raw).toContain("12-A");
    expect(rear!.value_raw).toContain("55-121");
    expect(rear!.observed_label).toBe("Position: Rear");
  });

  it("does not let the Front-and-Rear kit part masquerade as a rear blade", () => {
    const rear = byKey.get("rear_wiper_size")!;
    expect(rear.value_raw).not.toContain("18-2616-12K");
  });

  it("emits exactly one claim per field", () => {
    const claims = parseLandingResult(rav4Html);
    const keys = claims.map((c) => c.field_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(["front_wiper_size", "rear_wiper_size"]);
  });
});

describe("parseLandingResult — ambiguity suppresses claims (the law)", () => {
  it("conflicting driver sizes across set notes → no front claim", () => {
    const html = `
      <p>Position: Front</p><p><i>Note: this is a 26'' and 20''  9 x 3 Hook Beam Wiper Blade Set</i></p><p>Part #: <b>91-2620</b></p>
      <p>Position: Front</p><p><i>Note: this is a 24'' and 20''  9 x 3 Hook Beam Wiper Blade Set</i></p><p>Part #: <b>91-2420</b></p>`;
    expect(parseLandingResult(html)).toEqual([]);
  });

  it("conflicting rear decodes (1998 Civic multi-body shape) → no rear claim", () => {
    const html = `
      <p>Position: Rear</p><p><i>Note: OE Design</i></p><p>Part #: <b>13-N</b></p>
      <p>Position: Rear</p><p><i>Note: Upgrade Option</i></p><p>Part #: <b>91-150</b></p>`;
    expect(parseLandingResult(html)).toEqual([]);
  });

  it("undecodable rear SKUs are ignored, not vetoes", () => {
    const html = `
      <p>Position: Rear</p><p>Part #: <b>12-A</b></p>
      <p>Position: Rear</p><p>Part #: <b>47-700</b></p>`;
    const claims = parseLandingResult(html);
    expect(claims).toHaveLength(1);
    expect(claims[0].field_key).toBe("rear_wiper_size");
    expect(claims[0].value).toBe("12");
  });

  it("implausible set-note sizes are ignored", () => {
    const html = `<p><i>Note: this is a 62'' and 20'' Wiper Blade Set</i></p>`;
    expect(parseLandingResult(html)).toEqual([]);
  });
});

describe("parseLandingResult — malformed input fails open", () => {
  it("returns [] on empty / junk / non-fitment HTML", () => {
    expect(parseLandingResult("")).toEqual([]);
    expect(parseLandingResult("<html>Access Denied</html>")).toEqual([]);
    expect(parseLandingResult("this is a story about wipers")).toEqual([]);
    expect(parseLandingResult('{"json": "not html"}')).toEqual([]);
    // Type-hostile input (runtime junk survives the string signature).
    expect(parseLandingResult(null as unknown as string)).toEqual([]);
    expect(parseLandingResult(42 as unknown as string)).toEqual([]);
  });

  it("a rear block with a mangled part number yields nothing", () => {
    const html = `<p>Position: Rear</p><p>Part #: <b></b></p>`;
    expect(parseLandingResult(html)).toEqual([]);
  });
});

describe("parseFinderOptions", () => {
  it("parses the verbatim Toyota years options response", () => {
    const years = parseFinderOptions(toyotaYearsHtml);
    expect(years.length).toBeGreaterThan(5);
    expect(years).toContainEqual({ id: "511152939", label: "2026" });
    expect(years).toContainEqual({ id: "510811735", label: "2020" });
    // The "Select Year" placeholder (value="0") must not leak through.
    expect(years.some((y) => y.id === "0")).toBe(false);
  });

  it("ignores short non-catalog option values (page furniture)", () => {
    const html = `<option value="3609">TRICO Titan</option>
      <option value="510797450">Toyota</option>`;
    expect(parseFinderOptions(html)).toEqual([
      { id: "510797450", label: "Toyota" },
    ]);
  });

  it("fails open on malformed input", () => {
    expect(parseFinderOptions("")).toEqual([]);
    expect(parseFinderOptions("no options here")).toEqual([]);
    expect(parseFinderOptions(null as unknown as string)).toEqual([]);
  });
});

describe("adapter contract", () => {
  it("declares the aftermarket_catalog family and real V4 field keys", () => {
    expect(tricoWipersAdapter.name).toBe("trico_wipers");
    expect(tricoWipersAdapter.family).toBe("aftermarket_catalog");
    expect(tricoWipersAdapter.fields).toEqual([
      "front_wiper_size",
      "rear_wiper_size",
    ]);
    for (const field of TRICO_WIPER_FIELDS) {
      expect(V4_FIELD_KEYS).toContain(field);
    }
  });
});
