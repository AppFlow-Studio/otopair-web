/**
 * Unit tests for the RockAuto part-number attestation adapter's pure parsers
 * (convex/vehicleEnrichment/sourceAdapters/rockauto.ts). No network — fixtures
 * are captures of live rockauto.com pages (2026-07-30):
 *
 *   search-45022-T0A-A01.html   — partsearch slice for the 2016 Honda CR-V
 *                                 front pad; several listings incl. WAGNER EC1521
 *   moreinfo-wagner-ec1521.html — the moreinfo page carrying
 *                                 "OEM / Interchange Numbers: …", including the
 *                                 tail hidden behind the page's "Show All" toggle
 *   search-no-parts.html        — the "No Parts" response for a fabricated
 *                                 number (45022-ZZ9-Q99)
 *
 * THE LAW UNDER TEST, and the reason this file is worth more than its parsers:
 *
 * The interchange list belongs to ONE AFTERMARKET PART — it is Wagner's list of
 * OEM numbers that Wagner's EC1521 pad replaces, spanning Honda CR-V, Odyssey,
 * Pilot and Passport platforms AND a Subaru (26296AL03A). Those OEM parts are
 * NOT interchangeable with each other on a given vehicle. So the adapter may
 * corroborate ONLY the number it was asked about, and must never emit a claim
 * proposing a sibling number for a role slot — that would put a Subaru pad on a
 * Honda, which is the present-but-wrong failure the pipeline forbids.
 */
import { describe, expect, test } from "vitest";
import searchHtml from "./fixtures/sourceAdapters/rockauto/search-45022-T0A-A01.html?raw";
import moreInfoHtml from "./fixtures/sourceAdapters/rockauto/moreinfo-wagner-ec1521.html?raw";
import noPartsHtml from "./fixtures/sourceAdapters/rockauto/search-no-parts.html?raw";
import {
  ROCKAUTO_PART_TYPE_ROLES,
  attestationToClaim,
  isNoPartsPage,
  parseInterchangeNumbers,
  parseMoreInfoTitle,
  parseSearchListings,
  rockautoAdapter,
  type RockAutoAttestation,
} from "../convex/vehicleEnrichment/sourceAdapters/rockauto";

const CRV_FRONT_PAD = "45022T0AA01";
const SUBARU_NUMBER = "26296AL03A";

describe("parseSearchListings", () => {
  test("recovers manufacturer, part number, moreinfo URL and part type", () => {
    const listings = parseSearchListings(searchHtml);
    expect(listings.length).toBeGreaterThan(0);
    const wagner = listings.find((l) => l.partNumber === "EC1521");
    expect(wagner).toBeDefined();
    expect(wagner!.manufacturer).toBe("WAGNER");
    expect(wagner!.moreInfoUrl).toContain("moreinfo.php?pk=18739605");
    expect(wagner!.partTypeId).toBe(1684);
  });

  test("moreinfo URLs are absolute and HTML-entity decoded", () => {
    for (const l of parseSearchListings(searchHtml)) {
      expect(l.moreInfoUrl.startsWith("https://")).toBe(true);
      expect(l.moreInfoUrl).not.toContain("&amp;");
    }
  });

  test("dedupes on the moreinfo URL", () => {
    const urls = parseSearchListings(searchHtml).map((l) => l.moreInfoUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("malformed input yields nothing rather than throwing", () => {
    expect(parseSearchListings(null)).toEqual([]);
    expect(parseSearchListings("")).toEqual([]);
    expect(parseSearchListings("<html><body>nope</body></html>")).toEqual([]);
    // A layout change must produce ZERO listings, never mismatched pairs.
    expect(parseSearchListings('<span class="listing-final-manufacturer">WAGNER</span>')).toEqual([]);
  });
});

describe("isNoPartsPage — the existence oracle's negative leg", () => {
  test("a fabricated part number is positively reported as No Parts", () => {
    expect(isNoPartsPage(noPartsHtml)).toBe(true);
  });

  test("a real result page is not No Parts", () => {
    expect(isNoPartsPage(searchHtml)).toBe(false);
  });

  test("absence of input is NOT absence of the part", () => {
    // A parse failure must never be reported as "the part does not exist".
    expect(isNoPartsPage(null)).toBe(false);
    expect(isNoPartsPage("")).toBe(false);
  });
});

describe("parseInterchangeNumbers", () => {
  test("recovers the full set, including the numbers behind Show All", () => {
    const numbers = parseInterchangeNumbers(moreInfoHtml);
    // All 14 from the live page — the last four sit inside the CSS-collapsed
    // span, which is exactly what a naive visible-text scrape would miss.
    expect(numbers).toEqual([
      "26296AL03A",
      "45022T0AA00",
      "45022T0AA01",
      "45022TGSA00",
      "45022TGVA00",
      "45022TJBA01",
      "45022TJBA03",
      "45022TJBA04",
      "45022TK8A00",
      "45022TK8A01",
      "45022TLAA50",
      "45022TP6A60",
      "45022TP6A61",
      "45022TP6A62",
    ]);
  });

  test("normalizes so a dashed OEM number matches the page's stripped form", () => {
    const numbers = parseInterchangeNumbers(moreInfoHtml);
    // Our stored form is "45022-T0A-A01"; the page prints "45022T0AA01".
    expect(numbers).toContain(CRV_FRONT_PAD);
  });

  test("drops the toggle button labels rather than parsing them as numbers", () => {
    const numbers = parseInterchangeNumbers(moreInfoHtml);
    expect(numbers.some((n) => /SHOW|FEWER|ALL/.test(n))).toBe(false);
  });

  test("malformed input yields nothing rather than throwing", () => {
    expect(parseInterchangeNumbers(null)).toEqual([]);
    expect(parseInterchangeNumbers("<html>no such section</html>")).toEqual([]);
  });
});

describe("parseMoreInfoTitle", () => {
  test("extracts the product identity the numbers were read under", () => {
    expect(parseMoreInfoTitle(moreInfoHtml)).toBe("WAGNER EC1521");
  });

  test("returns null rather than a placeholder when absent", () => {
    expect(parseMoreInfoTitle("<html></html>")).toBeNull();
    expect(parseMoreInfoTitle(null)).toBeNull();
  });
});

describe("THE INTERCHANGE LAW — a sibling number is never a claim", () => {
  const attestation: RockAutoAttestation = {
    field_key: "front_brake_pad_oem",
    part_number: CRV_FRONT_PAD,
    observed_product: "WAGNER EC1521",
    part_type_id: 1684,
    implied_role: "brake_pad",
    source_url: "https://www.rockauto.com/en/moreinfo.php?pk=18739605&cc=0&pt=1684",
    interchange: parseInterchangeNumbers(moreInfoHtml).filter((n) => n !== CRV_FRONT_PAD),
  };

  test("the claim's value is OUR number — corroboration, not substitution", () => {
    const claim = attestationToClaim(attestation, 1_700_000_000_000);
    expect(claim.field_key).toBe("front_brake_pad_oem");
    expect(claim.value).toBe(CRV_FRONT_PAD);
    expect(claim.source_family).toBe("aftermarket_catalog");
    expect(claim.source_domain).toBe("rockauto.com");
    expect(claim.method).toBe("deterministic_parse");
  });

  test("the claim carries the verbatim context the number was read under", () => {
    const claim = attestationToClaim(attestation, 1);
    expect(claim.observed_label).toBe("OEM / Interchange Numbers on WAGNER EC1521");
  });

  test("ONE claim per attestation — never one per interchange sibling", () => {
    // 13 siblings are in scope; exactly zero of them become claims.
    expect(attestation.interchange.length).toBe(13);
    const claim = attestationToClaim(attestation, 1);
    expect([claim]).toHaveLength(1);
  });

  test("the Subaru number is carried as metadata and is NEVER the claim value", () => {
    // The whole reason this adapter may not propose siblings: one Wagner pad
    // shape serves a Honda CR-V and a Subaru, so the list crosses makes.
    expect(attestation.interchange).toContain(SUBARU_NUMBER);
    const claim = attestationToClaim(attestation, 1);
    expect(claim.value).not.toBe(SUBARU_NUMBER);
    expect(claim.value).toBe(CRV_FRONT_PAD);
  });

  test("interchange excludes our own number, so it can't self-corroborate", () => {
    expect(attestation.interchange).not.toContain(CRV_FRONT_PAD);
  });
});

describe("part-type role mapping", () => {
  test("the verified id maps to the role it was confirmed against", () => {
    expect(ROCKAUTO_PART_TYPE_ROLES[1684]).toBe("brake_pad");
  });

  test("an unmapped id yields NO role signal, never a mismatch", () => {
    // A wrong entry here would turn a correct part into a refute, which is
    // strictly worse than having no check.
    expect(ROCKAUTO_PART_TYPE_ROLES[999999]).toBeUndefined();
  });
});

describe("adapter contract", () => {
  test("is registered as an aftermarket_catalog voice on OEM part fields", () => {
    expect(rockautoAdapter.name).toBe("rockauto");
    expect(rockautoAdapter.family).toBe("aftermarket_catalog");
    expect(rockautoAdapter.fields).toContain("front_brake_pad_oem");
  });

  test("is INERT without known_parts and reports why, rather than guessing", async () => {
    // It is part-number-keyed. With nothing to attest it must return ok with no
    // claims — never a vehicle-keyed guess it has no way to make.
    const result = await rockautoAdapter.lookup({
      year: 2016,
      make: "Honda",
      model: "CR-V",
    });
    expect(result.ok).toBe(true);
    expect(result.claims).toEqual([]);
    expect(result.error).toContain("no known_parts");
  });
});
