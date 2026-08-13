/**
 * partIndex pure helpers — the part-number existence oracle's grammars, sitemap
 * parsing and existence policy.
 *
 * The five part numbers used throughout are VERIFIED Toyota Camry numbers: all
 * five were located in the live toyotapartsdeal.com corpus (829,693 <loc>
 * entries across the 17 `sitemap_partsinfo*.xml.gz` children, scanned Jul 30
 * 2026) and the fixture urls are the real ones that carried them.
 *
 * Pipeline law under test: a url the grammar does not recognise returns null
 * rather than a guessed number, and `decideExistenceVerdict` may only return
 * "absent" — the verdict that discards a part — from a completed, fresh index
 * for that exact make. Every other index state is "no_index", i.e. silence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gunzipToText,
  decodeSitemapBody,
  partNumberFromPartsdealUrl,
  partNumberFromRevPartsUrl,
  partsdealUrlFromPartNumber,
  revPartsUrlFromPartNumber,
  partNumberFromUrl,
  extractSitemapLocs,
  selectChildSitemaps,
  collectPartNumbersFromSitemap,
  decideExistenceVerdict,
  normalizeMakeKey,
  sourceRootFor,
  DEFAULT_INDEX_MAX_AGE_MS,
} from "../convex/vehicleEnrichment/partIndex";
import { normalizeOemNumber } from "../convex/vehicleEnrichment/priceParser";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", "partIndex", name), "utf8");
const fixtureBytes = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, "fixtures", "partIndex", name)));

/** The five numbers the research set resolved against the live index. */
const VERIFIED_CAMRY_NUMBERS = [
  "04152-YZZA1", // oil filter element
  "17801-0P051", // air filter element sub-assy
  "04465-33471", // front pad kit
  "90919-01298", // spark plug
  "43512-33150", // front rotor
];

// ─── gzip ──────────────────────────────────────────────────────────────────
// The default Convex runtime has no DecompressionStream (probed live, Jul 30
// 2026), so partIndex ships its own inflate. These are the tests that let it
// be trusted with an 11MB catalog.

describe("gunzipToText", () => {
  const expected = fixture("partsdeal-partsinfo-slice.xml");

  it("inflates a Huffman-coded member byte-for-byte", () => {
    expect(gunzipToText(fixtureBytes("partsdeal-partsinfo-slice.xml.gz"))).toBe(expected);
  });

  it("inflates stored (uncompressed) blocks", () => {
    expect(gunzipToText(fixtureBytes("partsdeal-partsinfo-slice.stored.xml.gz"))).toBe(expected);
  });

  it("feeds the grammar exactly what the plain-text path feeds it", () => {
    const fromGz = collectPartNumbersFromSitemap(
      gunzipToText(fixtureBytes("partsdeal-partsinfo-slice.xml.gz")),
      "partsdeal",
    );
    const fromText = collectPartNumbersFromSitemap(expected, "partsdeal");
    expect(fromGz).toEqual(fromText);
  });

  it("throws on a corrupted body rather than returning a truncated catalog", () => {
    // A silently-short inflate is the worst possible failure here: every part
    // in the lost tail would read as "absent".
    const bytes = fixtureBytes("partsdeal-partsinfo-slice.xml.gz");
    const flipped = bytes.slice();
    flipped[flipped.length - 20] ^= 0xff;
    expect(() => gunzipToText(flipped)).toThrow();

    expect(() => gunzipToText(bytes.slice(0, bytes.length - 4))).toThrow();
    expect(() => gunzipToText(new Uint8Array([0x1f, 0x8b, 0x08]))).toThrow(/no members/);
  });

  it("rejects a body that is not gzip at all", () => {
    expect(() => gunzipToText(new TextEncoder().encode("<!DOCTYPE html>...".repeat(3)))).toThrow(
      /magic|no members/,
    );
  });
});

describe("decodeSitemapBody", () => {
  it("sniffs the 1f 8b magic instead of trusting content-type", () => {
    const gz = fixtureBytes("partsdeal-partsinfo-slice.xml.gz");
    expect(decodeSitemapBody(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength))).toBe(
      fixture("partsdeal-partsinfo-slice.xml"),
    );
  });

  it("passes plain XML through untouched", () => {
    const xml = "<urlset><url><loc>https://x/a</loc></url></urlset>";
    expect(decodeSitemapBody(new TextEncoder().encode(xml).buffer as ArrayBuffer)).toBe(xml);
  });
});

// ─── PartsDeal grammar ─────────────────────────────────────────────────────

describe("partNumberFromPartsdealUrl", () => {
  it("extracts the number from real captured product urls (dashes kept, lowercased)", () => {
    expect(
      partNumberFromPartsdealUrl(
        "https://www.toyotapartsdeal.com/oem/toyota~pad~kit~disc~brake~04465-33471.html",
      ),
    ).toEqual({ raw: "04465-33471", normalized: "0446533471" });

    expect(
      partNumberFromPartsdealUrl(
        "https://www.toyotapartsdeal.com/oem/toyota~replaceable~element~04152-yzza1.html",
      ),
    ).toEqual({ raw: "04152-yzza1", normalized: "04152YZZA1" });
  });

  it("handles a three-group number and slugs whose own words end in digits", () => {
    expect(
      partNumberFromPartsdealUrl(
        "https://www.toyotapartsdeal.com/oem/toyota~shield~front~seat~cushion~lower~lh~71874-0c010-b0.html",
      ),
    ).toEqual({ raw: "71874-0c010-b0", normalized: "718740C010B0" });

    // "no~1" is part of the NAME; the number is still the last tilde token.
    expect(
      partNumberFromPartsdealUrl(
        "https://www.toyotapartsdeal.com/oem/toyota~stripe~side~rh~no~1~75985-89137.html",
      )?.normalized,
    ).toBe("7598589137");
  });

  it("accepts sibling partsdeal hosts for other makes", () => {
    expect(
      partNumberFromPartsdealUrl(
        "https://www.bmwpartsdeal.com/oem/bmw~oil~filter~11-42-7-953-129.html",
      ),
    ).toEqual({ raw: "11-42-7-953-129", normalized: "11427953129" });
  });

  it.each([
    ["not a url at all", "toyota~pad~kit~04465-33471.html"],
    ["a different site with the same path shape", "https://www.example.com/oem/toyota~pad~04465-33471.html"],
    ["a lookalike host that only ends in a suffix", "https://partsdeal.com.evil.example/oem/x~04465-33471.html"],
    ["a non-product path", "https://www.toyotapartsdeal.com/catalog/toyota~camry~2020.html"],
    ["a product path with no .html", "https://www.toyotapartsdeal.com/oem/toyota~pad~kit~04465-33471"],
    ["a slug whose last token is a word", "https://www.toyotapartsdeal.com/oem/toyota~camry.html"],
    ["a slug whose last token is too short to be a number", "https://www.toyotapartsdeal.com/oem/toyota~rav4.html"],
    ["a slug whose last token has too few digits", "https://www.toyotapartsdeal.com/oem/toyota~grille~assy~1.html"],
    ["an empty slug", "https://www.toyotapartsdeal.com/oem/.html"],
  ])("returns null for %s", (_label, url) => {
    expect(partNumberFromPartsdealUrl(url)).toBeNull();
  });
});

// ─── RevolutionParts grammar ───────────────────────────────────────────────

describe("partNumberFromRevPartsUrl", () => {
  it("extracts the dash-stripped number from product urls", () => {
    expect(
      partNumberFromRevPartsUrl(
        "https://toyota.oempartsonline.com/oem-parts/toyota-pad-kit-disc-brake-0446533471",
      ),
    ).toEqual({ raw: "0446533471", normalized: "0446533471" });

    expect(
      partNumberFromRevPartsUrl(
        "https://toyota.oempartsonline.com/oem-parts/toyota-replaceable-element-04152yzza1",
      ),
    ).toEqual({ raw: "04152yzza1", normalized: "04152YZZA1" });
  });

  it("is host-agnostic — the platform runs on thousands of dealer domains", () => {
    expect(
      partNumberFromRevPartsUrl(
        "https://parts.camelbacktoyota.com/oem-parts/toyota-plug-spark-9091901298",
      )?.normalized,
    ).toBe("9091901298");
  });

  it("tolerates a trailing slash", () => {
    expect(
      partNumberFromRevPartsUrl(
        "https://toyota.oempartsonline.com/oem-parts/toyota-disc-fr-4351233150/",
      )?.normalized,
    ).toBe("4351233150");
  });

  it.each([
    ["a non-product path", "https://toyota.oempartsonline.com/vehicles/toyota-camry"],
    ["a slug ending in a model year", "https://toyota.oempartsonline.com/oem-parts/toyota-camry-2020"],
    ["a slug ending in a word", "https://toyota.oempartsonline.com/oem-parts/toyota-brake-pads"],
    ["a partsdeal url (wrong grammar)", "https://www.toyotapartsdeal.com/oem/toyota~pad~kit~04465-33471.html"],
    ["garbage", "not-a-url"],
    ["an empty slug", "https://toyota.oempartsonline.com/oem-parts/"],
  ])("returns null for %s", (_label, url) => {
    expect(partNumberFromRevPartsUrl(url)).toBeNull();
  });
});

// ─── Round trips ───────────────────────────────────────────────────────────

describe("grammar round trips", () => {
  it.each(VERIFIED_CAMRY_NUMBERS)("partsdeal round-trips %s", (pn) => {
    const url = partsdealUrlFromPartNumber(pn, { nameSlug: "Pad Kit Disc Brake" });
    expect(url).not.toBeNull();
    const back = partNumberFromPartsdealUrl(url!);
    expect(back).not.toBeNull();
    // PartsDeal keeps dashes, so the RAW form survives intact (lowercased).
    expect(back!.raw).toBe(pn.toLowerCase());
    expect(back!.normalized).toBe(normalizeOemNumber(pn));
  });

  it.each(VERIFIED_CAMRY_NUMBERS)("revparts round-trips %s", (pn) => {
    const url = revPartsUrlFromPartNumber(pn, { make: "Toyota", nameSlug: "Pad Kit Disc Brake" });
    expect(url).not.toBeNull();
    const back = partNumberFromRevPartsUrl(url!);
    expect(back).not.toBeNull();
    // RevolutionParts destroys the dashes, so only the normalized form returns.
    expect(back!.normalized).toBe(normalizeOemNumber(pn));
  });

  it("builds urls with no name slug at all", () => {
    expect(partsdealUrlFromPartNumber("04465-33471")).toBe(
      "https://www.toyotapartsdeal.com/oem/04465-33471.html",
    );
    expect(revPartsUrlFromPartNumber("04465-33471")).toBe(
      "https://toyota.oempartsonline.com/oem-parts/0446533471",
    );
  });

  it("refuses to construct a url for something that is not a part number", () => {
    for (const bad of ["", "camry", "rav4", "1", "  ", "04465/33471"]) {
      expect(partsdealUrlFromPartNumber(bad)).toBeNull();
      expect(revPartsUrlFromPartNumber(bad)).toBeNull();
    }
  });
});

describe("partNumberFromUrl dispatch", () => {
  it("routes to the source's grammar", () => {
    const pdUrl = "https://www.toyotapartsdeal.com/oem/toyota~plug~spark~90919-01298.html";
    const rpUrl = "https://toyota.oempartsonline.com/oem-parts/toyota-plug-spark-9091901298";
    expect(partNumberFromUrl("partsdeal", pdUrl)?.normalized).toBe("9091901298");
    expect(partNumberFromUrl("revparts", rpUrl)?.normalized).toBe("9091901298");
    // Cross-applied grammars must not "helpfully" fall back.
    expect(partNumberFromUrl("partsdeal", rpUrl)).toBeNull();
    expect(partNumberFromUrl("revparts", pdUrl)).toBeNull();
  });

  it("returns null for an unregistered source rather than guessing", () => {
    expect(
      partNumberFromUrl("some-new-vendor", "https://www.toyotapartsdeal.com/oem/toyota~x~90919-01298.html"),
    ).toBeNull();
  });
});

// ─── Sitemap parsing ───────────────────────────────────────────────────────

describe("extractSitemapLocs / selectChildSitemaps", () => {
  it("reads locs that the server pretty-printed onto their own line", () => {
    const locs = extractSitemapLocs(fixture("partsdeal-sitemap-index.xml"));
    expect(locs).toHaveLength(8);
    expect(locs[0]).toBe(
      "https://www.toyotapartsdeal.com/sitemap/sitemap_accessory_featured1.xml.gz",
    );
  });

  it("keeps only the product children for the source", () => {
    const children = selectChildSitemaps(
      fixture("partsdeal-sitemap-index.xml"),
      /sitemap_partsinfo\d+\.xml(\.gz)?$/i,
    );
    expect(children).toEqual([
      "https://www.toyotapartsdeal.com/sitemap/sitemap_partsinfo1.xml.gz",
      "https://www.toyotapartsdeal.com/sitemap/sitemap_partsinfo2.xml.gz",
      "https://www.toyotapartsdeal.com/sitemap/sitemap_partsinfo17.xml.gz",
    ]);
  });

  it("does not confuse the RevolutionParts child pattern with partsdeal children", () => {
    expect(
      selectChildSitemaps(fixture("partsdeal-sitemap-index.xml"), /products_\d+\.xml(\.gz)?$/i),
    ).toEqual([]);
  });

  it("returns [] for a body that is not a sitemap (e.g. a block page)", () => {
    expect(extractSitemapLocs("<!DOCTYPE html><html><body>Attention Required!</body></html>")).toEqual(
      [],
    );
  });
});

describe("collectPartNumbersFromSitemap", () => {
  it("dedupes on the normalized number and reports what it refused", () => {
    const collected = collectPartNumbersFromSitemap(
      fixture("partsdeal-partsinfo-slice.xml"),
      "partsdeal",
    );
    expect(collected.urlCount).toBe(11);
    // 10 product urls, but two of them are the same spark plug under different
    // slugs, and the 11th url is a catalog page with no number.
    expect(collected.parts).toHaveLength(9);
    expect(collected.unparsed).toBe(1);

    const normalized = collected.parts.map((p) => p.normalized);
    for (const pn of VERIFIED_CAMRY_NUMBERS) {
      expect(normalized).toContain(normalizeOemNumber(pn));
    }
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it("keeps the FIRST url/raw form seen for a duplicated number", () => {
    const collected = collectPartNumbersFromSitemap(
      fixture("partsdeal-partsinfo-slice.xml"),
      "partsdeal",
    );
    const plug = collected.parts.find((p) => p.normalized === "9091901298");
    expect(plug?.url).toBe("https://www.toyotapartsdeal.com/oem/toyota~plug~spark~90919-01298.html");
    expect(plug?.raw).toBe("90919-01298");
  });

  it("parses the RevolutionParts grammar to the SAME normalized keys", () => {
    const pd = collectPartNumbersFromSitemap(
      fixture("partsdeal-partsinfo-slice.xml"),
      "partsdeal",
    );
    const rp = collectPartNumbersFromSitemap(
      fixture("revparts-products-slice.xml"),
      "revparts",
    );
    expect(rp.urlCount).toBe(8);
    // 6 product urls (one a duplicate spark plug) → 5 distinct; the model-year
    // slug and the vehicle landing page are refused.
    expect(rp.parts).toHaveLength(5);
    expect(rp.unparsed).toBe(2);

    // The whole index depends on the two grammars agreeing on the join key.
    const rpKeys = new Set(rp.parts.map((p) => p.normalized));
    const pdKeys = new Set(pd.parts.map((p) => p.normalized));
    for (const key of rpKeys) expect(pdKeys.has(key)).toBe(true);
  });

  it("indexes nothing for a source with no grammar", () => {
    const collected = collectPartNumbersFromSitemap(
      fixture("partsdeal-partsinfo-slice.xml"),
      "unregistered",
    );
    expect(collected.parts).toEqual([]);
    expect(collected.unparsed).toBe(11);
  });
});

// ─── The existence policy ──────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

describe("decideExistenceVerdict", () => {
  const cases: Array<{
    label: string;
    indexStatus: string | null | undefined;
    foundInIndex: boolean;
    indexAgeMs: number | null | undefined;
    expected: "found" | "absent" | "no_index";
  }> = [
    // The only two states in which the oracle is allowed to speak.
    { label: "fresh ok + found", indexStatus: "ok", foundInIndex: true, indexAgeMs: 2 * DAY, expected: "found" },
    { label: "fresh ok + missing", indexStatus: "ok", foundInIndex: false, indexAgeMs: 2 * DAY, expected: "absent" },
    { label: "ok completed seconds ago + missing", indexStatus: "ok", foundInIndex: false, indexAgeMs: 5_000, expected: "absent" },
    { label: "ok exactly at the freshness boundary + missing", indexStatus: "ok", foundInIndex: false, indexAgeMs: DEFAULT_INDEX_MAX_AGE_MS, expected: "absent" },

    // Everything below is silence — the caller learns nothing.
    { label: "stale ok + missing", indexStatus: "ok", foundInIndex: false, indexAgeMs: 31 * DAY, expected: "no_index" },
    { label: "stale ok + found", indexStatus: "ok", foundInIndex: true, indexAgeMs: 31 * DAY, expected: "no_index" },
    { label: "one ms past the boundary", indexStatus: "ok", foundInIndex: false, indexAgeMs: DEFAULT_INDEX_MAX_AGE_MS + 1, expected: "no_index" },
    { label: "running + missing", indexStatus: "running", foundInIndex: false, indexAgeMs: 0, expected: "no_index" },
    { label: "running + found", indexStatus: "running", foundInIndex: true, indexAgeMs: 0, expected: "no_index" },
    { label: "failed + missing", indexStatus: "failed", foundInIndex: false, indexAgeMs: 1 * DAY, expected: "no_index" },
    { label: "failed + found (partial crawl)", indexStatus: "failed", foundInIndex: true, indexAgeMs: 1 * DAY, expected: "no_index" },
    { label: "make never indexed (null status)", indexStatus: null, foundInIndex: false, indexAgeMs: null, expected: "no_index" },
    { label: "make never indexed (undefined status)", indexStatus: undefined, foundInIndex: false, indexAgeMs: undefined, expected: "no_index" },
    { label: "ok but no completed_at", indexStatus: "ok", foundInIndex: false, indexAgeMs: null, expected: "no_index" },
    { label: "ok with an unreadable age", indexStatus: "ok", foundInIndex: false, indexAgeMs: NaN, expected: "no_index" },
    { label: "ok with completed_at in the future (clock skew)", indexStatus: "ok", foundInIndex: false, indexAgeMs: -1000, expected: "no_index" },
    { label: "an unrecognised status string", indexStatus: "OK", foundInIndex: false, indexAgeMs: 0, expected: "no_index" },
  ];

  it.each(cases)("$label → $expected", ({ indexStatus, foundInIndex, indexAgeMs, expected }) => {
    expect(decideExistenceVerdict({ indexStatus, foundInIndex, indexAgeMs })).toBe(expected);
  });

  it("honours a caller-supplied freshness window", () => {
    const args = { indexStatus: "ok", foundInIndex: false, indexAgeMs: 2 * DAY };
    expect(decideExistenceVerdict({ ...args, maxAgeMs: 7 * DAY })).toBe("absent");
    expect(decideExistenceVerdict({ ...args, maxAgeMs: 1 * DAY })).toBe("no_index");
  });

  it("never returns absent without a completed fresh index, for any status", () => {
    for (const status of [null, undefined, "", "running", "failed", "pending", "ok "]) {
      expect(
        decideExistenceVerdict({ indexStatus: status, foundInIndex: false, indexAgeMs: 0 }),
      ).toBe("no_index");
    }
  });
});

// ─── Registry ──────────────────────────────────────────────────────────────

describe("source registry", () => {
  it("canonicalizes the make key the same way the writes do", () => {
    expect(normalizeMakeKey("  Toyota ")).toBe("toyota");
    expect(normalizeMakeKey("TOYOTA")).toBe("toyota");
  });

  it("resolves registered roots and parses child names from the index, never builds them", () => {
    const pd = sourceRootFor("partsdeal", "Toyota");
    expect(pd?.root).toBe("https://www.toyotapartsdeal.com/sitemap.xml");
    const rp = sourceRootFor("revparts", "toyota");
    expect(rp?.root).toBe("https://toyota.oempartsonline.com/sitemap.xml");
    // RevolutionParts children are 4-digit zero-padded; the pattern matches the
    // real names and a non-padded guess would simply never be produced.
    expect(rp!.childPattern.test("https://x/products_0001.xml.gz")).toBe(true);
  });

  it("returns null for an unregistered make or source instead of guessing a host", () => {
    expect(sourceRootFor("partsdeal", "sterling")).toBeNull();
    expect(sourceRootFor("revparts", "yugo")).toBeNull();
    expect(sourceRootFor("junkyard", "toyota")).toBeNull();
  });
});
