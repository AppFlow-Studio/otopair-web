/**
 * RockAuto keyed by vehicle.
 *
 * Fixtures mirror the real pages walked live Aug 2026 (2021 GMC Acadia). The
 * two behaviours worth guarding are the ones that would silently produce WRONG
 * PARTS rather than no parts: engine selection, where picking the wrong one
 * walks another powertrain's subtree, and position association, where RockAuto
 * puts front and rear rotors on ONE page under text qualifiers.
 */
import { describe, it, expect } from "vitest";
import {
  buildCatalogPath,
  classifyPositionText,
  encodeSegment,
  isMakeAttestedNumber,
  MIN_BRAND_CORROBORATION,
  parseCatalogNodes,
  parsePositionedListings,
  pickEngineNode,
  pickNodeByPatterns,
  positionOfRoleKey,
  rankInterchangeCandidates,
  ROCKAUTO_ROLE_LOCATION,
} from "../convex/vehicleEnrichment/sourceAdapters/rockautoCatalog";

describe("URL construction", () => {
  it("uses + for spaces and keeps & literal", () => {
    // encodeURIComponent would emit %26 here and the site 404s.
    expect(encodeSegment("Brake & Wheel Hub")).toBe("brake+&+wheel+hub");
  });

  it("builds the comma path", () => {
    expect(buildCatalogPath(["GMC", 2021, "Acadia"])).toBe("/en/catalog/gmc,2021,acadia");
  });

  it("passes numeric ids through unencoded", () => {
    expect(buildCatalogPath(["gmc", 2021, "acadia", "3.6L V6", 3446618])).toBe(
      "/en/catalog/gmc,2021,acadia,3.6l+v6,3446618",
    );
  });
});

describe("parseCatalogNodes", () => {
  const MODEL_PATH = "/en/catalog/gmc,2021,acadia";
  // Engine nodes append TWO segments: {engine},{carcode}. A depth check of
  // parent+1 returned zero engines live while every other level worked.
  const MODEL_HTML = `
    <a href="/en/catalog/gmc">GMC</a>
    <a href="/en/catalog/gmc,2021">2021</a>
    <a href="/en/catalog/gmc,2021,acadia">Acadia</a>
    <a href="/es/catalog/gmc,2021,acadia">es</a>
    <a href="/en/catalog/gmc,2021,acadia,2.0l+l4+turbocharged,3446619">2.0L L4 Turbo</a>
    <a href="/en/catalog/gmc,2021,acadia,2.5l+l4,3446620">2.5L L4</a>
    <a href="/en/catalog/gmc,2021,acadia,3.6l+v6,3446618">3.6L V6</a>
    <a href="/en/catalog/gmc,2021,canyon,3.6l+v6,9999999">other model</a>`;

  it("finds engine nodes that append a name AND a carcode", () => {
    const nodes = parseCatalogNodes(MODEL_HTML, MODEL_PATH);
    expect(nodes.map((n) => n.id)).toEqual([3446619, 3446620, 3446618]);
    expect(nodes.map((n) => n.segment)).toEqual([
      "2.0l l4 turbocharged",
      "2.5l l4",
      "3.6l v6",
    ]);
  });

  it("excludes breadcrumbs, language variants and sibling branches", () => {
    const paths = parseCatalogNodes(MODEL_HTML, MODEL_PATH).map((n) => n.path);
    expect(paths.some((p) => p.includes("canyon"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/es/"))).toBe(false);
    expect(paths).not.toContain(MODEL_PATH);
  });

  it("finds single-segment children (categories)", () => {
    const parent = "/en/catalog/gmc,2021,acadia,3.6l+v6,3446618";
    const nodes = parseCatalogNodes(
      `<a href="${parent},brake+&amp;+wheel+hub">Brake</a><a href="${parent},engine">Engine</a>`,
      parent,
    );
    expect(nodes.map((n) => n.segment)).toEqual(["brake & wheel hub", "engine"]);
    expect(nodes[0].id).toBeNull();
  });

  it("returns [] on empty input rather than throwing", () => {
    expect(parseCatalogNodes(null, MODEL_PATH)).toEqual([]);
  });
});

describe("pickEngineNode", () => {
  const nodes = parseCatalogNodes(
    `<a href="/en/catalog/gmc,2021,acadia,2.0l+l4+turbocharged,3446619">a</a>
     <a href="/en/catalog/gmc,2021,acadia,2.5l+l4,3446620">b</a>
     <a href="/en/catalog/gmc,2021,acadia,3.6l+v6,3446618">c</a>`,
    "/en/catalog/gmc,2021,acadia",
  );

  it("matches on displacement", () => {
    expect(pickEngineNode(nodes, { displacementL: 3.6 })?.id).toBe(3446618);
    expect(pickEngineNode(nodes, { displacementL: 2.5 })?.id).toBe(3446620);
  });

  it("returns null when no engine matches — never a nearest guess", () => {
    // Walking the wrong engine harvests another powertrain's parts, which is
    // the GLC63-for-GLC43 failure in a different catalogue.
    expect(pickEngineNode(nodes, { displacementL: 5.3 })).toBeNull();
  });

  it("returns null without a usable displacement", () => {
    expect(pickEngineNode(nodes, { displacementL: null })).toBeNull();
    expect(pickEngineNode(nodes, { displacementL: 0 })).toBeNull();
  });

  it("refuses to choose between same-displacement variants it cannot separate", () => {
    const ambiguous = parseCatalogNodes(
      `<a href="/en/catalog/x,2021,y,2.0l+l4,1">a</a>
       <a href="/en/catalog/x,2021,y,2.0l+l4+turbocharged,2">b</a>`,
      "/en/catalog/x,2021,y",
    );
    expect(pickEngineNode(ambiguous, { displacementL: 2.0 })).toBeNull();
  });
});

describe("position handling", () => {
  it("classifies the qualifier shapes the live page uses", () => {
    expect(classifyPositionText("Front")).toBe("front");
    expect(classifyPositionText("Rear Left")).toBe("rear");
    expect(classifyPositionText("Front; Cast Iron")).toBe("front");
    expect(classifyPositionText("Rear; FRONT & REAR Disc Brakes w/ ABS(J61)")).toBe("rear");
    expect(classifyPositionText("Cast Iron")).toBeNull();
    expect(classifyPositionText(null)).toBeNull();
  });

  it("maps role keys to a side", () => {
    expect(positionOfRoleKey("front_rotor")).toBe("front");
    expect(positionOfRoleKey("rear_brake_pad")).toBe("rear");
    expect(positionOfRoleKey("oil_filter")).toBeNull();
  });

  const listing = (mfr: string, pn: string, pk: string) =>
    `<span class="listing-final-manufacturer ">${mfr}</span>` +
    `<span class="listing-final-partnumber x">${pn}</span>` +
    `<a href="/en/moreinfo.php?pk=${pk}&cc=0&pt=1896">Info</a>`;

  const PAGE =
    `<div>Front</div>${listing("DURAGO", "BR901702", "1")}${listing("RAYBESTOS", "582060R2", "2")}` +
    `<div>Rear</div>${listing("FVP", "BR90170201", "3")}`;

  it("tags each listing with the group ABOVE it", () => {
    const rows = parsePositionedListings(PAGE);
    expect(rows.map((r) => [r.partNumber, r.position])).toEqual([
      ["BR901702", "front"],
      ["582060R2", "front"],
      ["BR90170201", "rear"],
    ]);
  });

  it("leaves a listing with no marker above it unpositioned", () => {
    // Must read as "unusable for a position-bearing role", never "either side".
    const rows = parsePositionedListings(listing("ACME", "X1", "9"));
    expect(rows[0].position).toBeNull();
  });

  it("absolutises the moreinfo URL", () => {
    expect(parsePositionedListings(PAGE)[0].moreInfoUrl).toMatch(
      /^https:\/\/www\.rockauto\.com\/en\/moreinfo\.php\?pk=1/,
    );
  });

  it("returns [] rather than mismatched pairs on unknown markup", () => {
    expect(parsePositionedListings("<div>Front</div><p>no listings here</p>")).toEqual([]);
  });
});

describe("rankInterchangeCandidates", () => {
  // Shape observed live for the Acadia front rotor: three brands agreeing on a
  // cluster, RAYBESTOS contributing singletons.
  const SETS = [
    { brand: "DURAGO", numbers: ["13516728", "13588515", "26478135", "13546862"] },
    { brand: "DYNAMIC FRICTION", numbers: ["13516728", "13588515", "26478135"] },
    { brand: "FVP", numbers: ["13516728", "13588515", "26478135", "13546862"] },
    { brand: "RAYBESTOS", numbers: ["13507408", "13592624"] },
  ];

  it("ranks by DISTINCT BRAND count, most-corroborated first", () => {
    const ranked = rankInterchangeCandidates(SETS);
    expect(ranked[0].brandCount).toBe(3);
    expect(ranked.find((c) => c.oem === "13516728")!.brands).toEqual([
      "DURAGO", "DYNAMIC FRICTION", "FVP",
    ]);
  });

  it("demotes single-brand numbers below the corroboration floor", () => {
    const ranked = rankInterchangeCandidates(SETS);
    const survivors = ranked.filter((c) => c.brandCount >= MIN_BRAND_CORROBORATION);
    expect(survivors.map((c) => c.oem)).not.toContain("13507408");
    expect(survivors.map((c) => c.oem)).not.toContain("13592624");
  });

  it("counts one brand once however many SKUs it lists the number under", () => {
    // Same reason the ledger counts families rather than domains.
    const ranked = rankInterchangeCandidates([
      { brand: "DURAGO", numbers: ["13516728"] },
      { brand: "DURAGO", numbers: ["13516728"] },
      { brand: "durago", numbers: ["13516728"] },
    ]);
    expect(ranked[0].brandCount).toBe(1);
  });

  it("drops junk that survives tag-stripping", () => {
    const ranked = rankInterchangeCandidates([
      { brand: "X", numbers: ["ABC", "12", "", "ONLYLETTERS"] },
    ]);
    expect(ranked).toEqual([]);
  });

  it("is deterministic on ties", () => {
    const a = rankInterchangeCandidates(SETS).map((c) => c.oem);
    const b = rankInterchangeCandidates([...SETS].reverse()).map((c) => c.oem);
    expect(a).toEqual(b);
  });

  it("handles an empty input", () => {
    expect(rankInterchangeCandidates([])).toEqual([]);
  });
});

describe("role → catalogue location", () => {
  it("separates rotor from the near-miss part types on the same page", () => {
    const parent = "/en/catalog/gmc,2021,acadia,3.6l+v6,3446618,brake+&+wheel+hub";
    const nodes = parseCatalogNodes(
      `<a href="${parent},brake+pad,1684">Brake Pad</a>
       <a href="${parent},brake+pad+retaining+clip+/+spring,12737">clip</a>
       <a href="${parent},rotor,1896">Rotor</a>
       <a href="${parent},rotor+&amp;+brake+pad+kit,13824">kit</a>`,
      parent,
    );
    expect(pickNodeByPatterns(nodes, ROCKAUTO_ROLE_LOCATION.front_rotor.partType)?.id).toBe(1896);
    expect(pickNodeByPatterns(nodes, ROCKAUTO_ROLE_LOCATION.front_brake_pad.partType)?.id).toBe(1684);
  });

  it("returns null when nothing matches", () => {
    expect(pickNodeByPatterns([], ROCKAUTO_ROLE_LOCATION.front_rotor.partType)).toBeNull();
  });
});

describe("isMakeAttestedNumber — the gate corroboration cannot provide", () => {
  // Vocabularies captured live Aug 2026 from oem_parts (prefixLen 3).
  const KIA = ["173", "188", "215", "252", "263", "273", "281", "314", "371", "517"];
  const SUBARU = ["111", "130", "140", "147", "152", "165", "211", "212", "224", "237"];

  it("rejects a Subaru number for a Kia, which SHAPE cannot do", () => {
    // sanitizePartNumber("15208AA030","Kia") returns it unchanged — both makes
    // number 5+5, so the format gate is blind to this.
    expect(isMakeAttestedNumber("15208AA030", KIA)).toBe(false);
  });

  it("accepts that same number for Subaru", () => {
    expect(isMakeAttestedNumber("15208AA030", SUBARU)).toBe(true);
  });

  it("accepts a genuine Kia number from a family only NEARLY on file", () => {
    // 26300-35504 is not itself on file; 26320/26345 are. A 5-char prefix
    // would reject the true number as readily as the contaminant, which is
    // why the gate is 3.
    expect(isMakeAttestedNumber("2630035504", KIA)).toBe(true);
  });

  it("tolerates punctuation and case", () => {
    expect(isMakeAttestedNumber("26300-35504", KIA)).toBe(true);
    expect(isMakeAttestedNumber("15208-aa030", SUBARU)).toBe(true);
  });

  it("FAILS CLOSED on an empty vocabulary — cannot judge is not permission", () => {
    expect(isMakeAttestedNumber("2630035504", [])).toBe(false);
  });

  it("rejects a number too short to key", () => {
    expect(isMakeAttestedNumber("26", KIA)).toBe(false);
  });
});
