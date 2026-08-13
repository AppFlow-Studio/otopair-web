import { describe, expect, it } from "vitest";
import {
  htmlToText,
  makeSlug,
  parseExtraction,
  parseGenerationLinks,
  parseSectionLinks,
  pickGeneration,
  pickModel,
  pickSections,
  scoreSection,
  stripFamilySuffix,
} from "../convex/vehicleEnrichment/sourceAdapters/myCarUserManual";

const B = "https://www.mycarusermanual.com";
const href = (path: string) => `<a href="${B}${path}">x</a>`;

describe("makeSlug", () => {
  it("applies the verified aliases", () => {
    // Both un-aliased forms return 404 on the live site.
    expect(makeSlug("Mercedes-Benz")).toBe("mercedes");
    expect(makeSlug("Volkswagen")).toBe("vw");
  });

  it("falls through to a hyphenated lowercase make", () => {
    expect(makeSlug("BMW")).toBe("bmw");
    expect(makeSlug("Land Rover")).toBe("land-rover");
    expect(makeSlug("")).toBe("");
  });
});

describe("pickModel", () => {
  const mercedes = ["a-class", "c-class", "e-class", "glc-class"].map((slug) => ({
    slug,
    url: `${B}/mercedes/${slug}`,
  }));
  const mazda = ["cx-3", "cx-5", "cx-9", "mazda3"].map((slug) => ({ slug, url: `${B}/mazda/${slug}` }));

  it("matches exactly, ignoring separators and case", () => {
    const bmw = [{ slug: "3-series", url: `${B}/bmw/3-series` }];
    expect(pickModel(bmw, "3 Series")?.slug).toBe("3-series");
  });

  it("matches a family slug from a variant name", () => {
    // The site names the FAMILY; the config names the VARIANT.
    expect(pickModel(mercedes, "GLC 300")?.slug).toBe("glc-class");
    expect(pickModel(mercedes, "A 220")?.slug).toBe("a-class");
  });

  it("does NOT let a family slug swallow an unrelated model", () => {
    // "CX5" starts with "C" like "c-class", but the leftover "X5" has a
    // letter in it — that is a different model, not a trim. Getting this
    // wrong would file a C-Class's capacities against a CX-5.
    expect(pickModel(mercedes, "CX-5")).toBeNull();
    expect(pickModel(mazda, "CX-5")?.slug).toBe("cx-5");
  });

  it("tolerates extra words the site does not carry", () => {
    const toyota = [{ slug: "camry", url: `${B}/toyota/camry` }];
    expect(pickModel(toyota, "Camry Hybrid")?.slug).toBe("camry");
  });

  it("returns null rather than guessing", () => {
    expect(pickModel(mercedes, "Altima")).toBeNull();
    expect(pickModel([], "Camry")).toBeNull();
  });

  it("stripFamilySuffix handles the site's family words", () => {
    expect(stripFamilySuffix("glc-class")).toBe("glc");
    expect(stripFamilySuffix("3-series")).toBe("3");
    expect(stripFamilySuffix("camry")).toBe("camry");
  });
});

describe("parseGenerationLinks — both URL forms are real", () => {
  it("parses a year RANGE generation", () => {
    const html = href("/bmw/3-series/4-door/2019-2025");
    expect(parseGenerationLinks(html, "bmw", "3-series")).toEqual([
      { body: "4-door", start: 2019, end: 2025, url: `${B}/bmw/3-series/4-door/2019-2025` },
    ]);
  });

  it("parses a SINGLE-YEAR generation as a range of one", () => {
    // Verified live: Audi publishes the Q5 as /audi/q5/suv/2020. Requiring a
    // range returned zero generations and looked like a coverage gap.
    expect(parseGenerationLinks(href("/audi/q5/suv/2020"), "audi", "q5")).toEqual([
      { body: "suv", start: 2020, end: 2020, url: `${B}/audi/q5/suv/2020` },
    ]);
  });

  it("ignores links for other models and deeper section pages", () => {
    const html =
      href("/bmw/3-series/4-door/2019-2025") +
      href("/bmw/5-series/4-door/2019-2025") +
      href("/bmw/3-series/4-door/2022/controls");
    const gens = parseGenerationLinks(html, "bmw", "3-series");
    expect(gens).toHaveLength(1);
    expect(gens[0].url).toBe(`${B}/bmw/3-series/4-door/2019-2025`);
  });
});

describe("pickGeneration", () => {
  const gens = [
    { body: "4-door", start: 2013, end: 2019, url: "a" },
    { body: "4-door", start: 2019, end: 2025, url: "b" },
  ];

  it("selects the generation covering the year", () => {
    expect(pickGeneration(gens, 2022)?.url).toBe("b");
    expect(pickGeneration(gens, 2015)?.url).toBe("a");
  });

  it("prefers the narrower range at an overlapping boundary year", () => {
    expect(pickGeneration(gens, 2019)?.url).toBe("b");
  });

  it("returns null when no generation covers the year", () => {
    // Verified live: Corolla has 2000-2006/2007-2012/2013-2017/2023 and no
    // 2022. An honest gap beats resolving the wrong generation.
    expect(pickGeneration(gens, 2030)).toBeNull();
    expect(pickGeneration([], 2020)).toBeNull();
  });
});

describe("parseSectionLinks — year-scoped AND range-scoped", () => {
  it("parses year-scoped chapters (BMW shape)", () => {
    const links = parseSectionLinks(
      href("/bmw/3-series/4-door/2022/mobility--engine-oil"),
      "bmw",
      "3-series",
      "4-door",
    );
    expect(links).toEqual([
      {
        yearKey: "2022",
        year: 2022,
        slug: "mobility--engine-oil",
        url: `${B}/bmw/3-series/4-door/2022/mobility--engine-oil`,
      },
    ]);
  });

  it("parses range-scoped chapters (Honda shape)", () => {
    const links = parseSectionLinks(
      href("/honda/cr-v/suv/2016-2021/information--specifications"),
      "honda",
      "cr-v",
      "suv",
    );
    expect(links[0]).toMatchObject({ yearKey: "2016-2021", year: 2016, slug: "information--specifications" });
  });
});

describe("scoreSection / pickSections", () => {
  it("ranks spec-bearing chapters above narrative ones", () => {
    expect(scoreSection("technical-data--operating-fluids")).toBeGreaterThan(
      scoreSection("controls--climate-control"),
    );
    expect(scoreSection("mobility--engine-oil")).toBeGreaterThan(scoreSection("driving-tips"));
    expect(scoreSection("controls--adjusting")).toBe(0);
  });

  it("keeps only scored chapters, best first, within the limit", () => {
    const links = [
      "information--specifications",
      "controls--adjusting",
      "maintenance--engine-oil",
      "driving",
    ].map((slug) => ({ yearKey: "2016-2021", year: 2016, slug, url: `${B}/x/${slug}` }));
    const picked = pickSections(links, 2019, 2);
    expect(picked).toHaveLength(2);
    expect(picked.map((p) => p.slug)).not.toContain("controls--adjusting");
  });

  it("groups by the published key rather than assuming a form", () => {
    // A generation page publishes chapters under ONE key; take the closest.
    const links = [
      { yearKey: "2018", year: 2018, slug: "specifications", url: "a" },
      { yearKey: "2022", year: 2022, slug: "specifications", url: "b" },
    ];
    expect(pickSections(links, 2022)[0].url).toBe("b");
  });

  it("returns nothing when no chapter looks spec-bearing", () => {
    const links = [{ yearKey: "2020", year: 2020, slug: "controls--displays", url: "a" }];
    expect(pickSections(links, 2020)).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("strips markup and boilerplate, decodes entities", () => {
    const out = htmlToText(
      "<script>junk()</script><p>Engine oil capacity&nbsp;4.8&nbsp;US qts</p><div>DOT&#32;4</div>",
    );
    expect(out).toContain("Engine oil capacity 4.8 US qts");
    expect(out).not.toContain("junk()");
  });

  it("caps output and never throws", () => {
    expect(htmlToText("<p>" + "x".repeat(50_000) + "</p>", 100).length).toBeLessThanOrEqual(100);
    expect(() => htmlToText("")).not.toThrow();
  });
});

describe("parseExtraction — fails closed", () => {
  it("keeps well-formed, quotable, known fields and normalizes the value", () => {
    const rows = parseExtraction({
      specs: [
        { field_key: "oil_capacity_qts", value: "4.80", unit_as_printed: "US qts", quoted_text: "4.8 US qts" },
        { field_key: "oil_viscosity", value: "0w-20", unit_as_printed: null, quoted_text: "SAE 0W-20" },
      ],
    });
    expect(rows.map((r) => [r.field_key, r.value])).toEqual([
      ["oil_capacity_qts", "4.8"],
      ["oil_viscosity", "0W-20"],
    ]);
    expect(rows[0].value_raw).toBe("4.80 US qts");
  });

  it("drops unquotable, unknown, unnormalizable and duplicate rows", () => {
    const rows = parseExtraction({
      specs: [
        { field_key: "oil_capacity_qts", value: 4.8, quoted_text: "" },
        { field_key: "drain_plug_torque_ft_lbs", value: 30, quoted_text: "30 ft-lb" },
        { field_key: "tire_pressure_front_psi", value: "n/a", quoted_text: "see placard" },
        { field_key: "oil_viscosity", value: "0W-20", quoted_text: "SAE 0W-20" },
        { field_key: "oil_viscosity", value: "5W-30", quoted_text: "or 5W-30" },
      ],
    });
    expect(rows.map((r) => r.field_key)).toEqual(["oil_viscosity"]);
    expect(rows[0].value).toBe("0W-20");
  });

  it("never throws on malformed payloads", () => {
    for (const bad of [null, undefined, {}, { specs: "no" }, { specs: [null, 5, "x"] }]) {
      expect(() => parseExtraction(bad)).not.toThrow();
      expect(parseExtraction(bad)).toEqual([]);
    }
  });
});
