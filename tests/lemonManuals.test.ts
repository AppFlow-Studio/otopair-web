/**
 * Pure-helper guards for the LEMON Manuals spec ingester.
 *
 * Every HTML snippet below is hand-authored to mirror the markup verified live
 * on lemon-manuals.la (2021 Honda CR-V, 2020 Toyota Camry, 2019 Ford F-150) —
 * structure only, no manual content, so nothing copyrighted lands in the repo.
 *
 * Three of these lock regressions that shipped and were caught in review:
 *   1. drivetrain siblings ("CR-V EX, AWD" vs "…, FWD") tied and the
 *      lexicographic tiebreak handed every FWD car the AWD manual;
 *   2. the leaf allowlist was Honda-only vocabulary and selected NOTHING of
 *      value on Ford, whose sections are "General Specifications"/"Capacities";
 *   3. hrefs were decoded before being split, so folder names containing an
 *      encoded slash ("Brake Shoes &/Or Pads") produced a wrong path tail.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  alnumKey,
  lemonMakeFolder,
  buildLemonYearUrl,
  parseChildFolders,
  normalizeDrivetrain,
  scoreLemonTrim,
  pickLemonTrim,
  hrefSegments,
  hrefTail,
  selectRelevantLeaves,
  extractLeafHrefs,
  htmlLeafToMarkdown,
  encodeLemonSegment,
  resolveLeafUrl,
  parseLemonEquivalence,
  nameCoversTrim,
  equivalentVariantForTrim,
  isEquivalenceExcludedPath,
  LEMON_EQUIVALENCE_DEFAULT_EXCLUDED,
  resolveLemonVehicle,
  fetchLemonManualMarkdown,
} from "../convex/vehicleEnrichment/lemonManuals";

describe("alnumKey / lemonMakeFolder", () => {
  it("strips punctuation and case", () => {
    expect(alnumKey("Mercedes-Benz")).toBe("mercedesbenz");
    expect(alnumKey(null)).toBe("");
  });

  it("maps the make folders that differ from our make strings", () => {
    expect(lemonMakeFolder("Ram")).toBe("Dodge and Ram");
    expect(lemonMakeFolder("Dodge")).toBe("Dodge and Ram");
    expect(lemonMakeFolder("Nissan")).toBe("Nissan-Datsun");
    expect(lemonMakeFolder("Mercedes-Benz")).toBe("Mercedes Benz");
  });

  it("passes unknown makes through untouched", () => {
    expect(lemonMakeFolder("Honda")).toBe("Honda");
    expect(lemonMakeFolder("  Subaru ")).toBe("Subaru");
  });

  it("encodes the year URL", () => {
    expect(buildLemonYearUrl("lemon-manuals.la", "Dodge and Ram", 2020)).toBe(
      "https://lemon-manuals.la/Dodge%20and%20Ram/2020/",
    );
  });
});

describe("parseChildFolders", () => {
  // The make dir links years RELATIVELY; the year dir links trims ABSOLUTELY
  // and multi-segment. Both forms must resolve, ancestors must not.
  const yearDirUrl = "https://lemon-manuals.la/Honda/2021/";
  const yearDirHtml = `
    <link rel="stylesheet" href="/style.css">
    <a href="/">Home</a><a href="/Honda/">Honda</a><a href="/Honda/2021/">2021</a>
    <a href="/Honda/2021/CR-V%20EX%2C%20AWD/">CR-V EX, AWD</a>
    <a href="/Honda/2021/CR-V%20EX%2C%20FWD/">CR-V EX, FWD</a>
    <a href="/Honda/2021/CR-V%20EX%2C%20AWD/">dup</a>
    <a href="/about.html">About</a>`;

  it("resolves absolute multi-segment hrefs and drops ancestors/dupes/files", () => {
    expect(parseChildFolders(yearDirHtml, yearDirUrl)).toEqual(["CR-V EX, AWD", "CR-V EX, FWD"]);
  });

  it("resolves relative hrefs too", () => {
    const html = `<a href="2020/">2020</a><a href="2021/">2021</a><a href="../">up</a>`;
    expect(parseChildFolders(html, "https://lemon-manuals.la/Honda/")).toEqual(["2020", "2021"]);
  });

  it("ignores other hosts and unparseable input", () => {
    const html = `<a href="https://example.com/Honda/2021/Evil/">x</a>`;
    expect(parseChildFolders(html, yearDirUrl)).toEqual([]);
    expect(parseChildFolders("<a href='x'>", "not a url")).toEqual([]);
  });
});

describe("normalizeDrivetrain", () => {
  it("reduces the prose NHTSA actually returns", () => {
    expect(normalizeDrivetrain("4WD/4-Wheel Drive/4x4")).toBe("4wd");
    expect(normalizeDrivetrain("FWD/Front-Wheel Drive")).toBe("fwd");
    expect(normalizeDrivetrain("All-Wheel Drive")).toBe("awd");
    expect(normalizeDrivetrain("RWD")).toBe("rwd");
  });

  it("returns null for absent or unusable values", () => {
    expect(normalizeDrivetrain(null)).toBeNull();
    expect(normalizeDrivetrain("unknown")).toBeNull();
    expect(normalizeDrivetrain("")).toBeNull();
  });
});

describe("scoreLemonTrim / pickLemonTrim", () => {
  const CRV_2021 = [
    "CR-V EX, AWD",
    "CR-V EX, FWD",
    "CR-V EX-L, AWD",
    "CR-V EX-L, FWD",
    "CR-V LX, AWD",
    "CR-V LX, FWD",
  ];

  it("REGRESSION: an FWD car gets the FWD manual, not the AWD one", () => {
    // Both folders match model+trim identically. Before the drivetrain penalty
    // the lexicographic tiebreak always chose "…, AWD" — handing an FWD car a
    // rear-differential capacity it does not have.
    expect(pickLemonTrim({ model: "CR-V", trim: "EX", drivetrain: "FWD/Front-Wheel Drive" }, CRV_2021)).toBe(
      "CR-V EX, FWD",
    );
    expect(pickLemonTrim({ model: "CR-V", trim: "EX", drivetrain: "AWD" }, CRV_2021)).toBe("CR-V EX, AWD");
  });

  it("REGRESSION: trim LE does not match XLE (whole-word tokens, not substrings)", () => {
    const camry = ["Camry XLE, FWD", "Camry LE, FWD"];
    expect(pickLemonTrim({ model: "Camry", trim: "LE", drivetrain: "FWD" }, camry)).toBe("Camry LE, FWD");
    expect(pickLemonTrim({ model: "Camry", trim: "XLE", drivetrain: "FWD" }, camry)).toBe("Camry XLE, FWD");
  });

  it("REVIEW: AWD and 4WD are cross-labelled, not contradictions", () => {
    // Toyota lists its AWD sedans as "…, 4WD"; NHTSA decodes them as
    // "AWD/All-Wheel Drive". The contradiction penalty must not fire between
    // the two all-wheel labels — it previously demoted the CORRECT folder and
    // left the pick to the lexicographic tiebreak.
    const camry = ["Camry LE, 4WD", "Camry LE, FWD"];
    expect(pickLemonTrim({ model: "Camry", trim: "LE", drivetrain: "AWD/All-Wheel Drive" }, camry)).toBe(
      "Camry LE, 4WD",
    );
    // And the reverse labelling: a 4x4 vehicle against an "AWD" folder.
    expect(pickLemonTrim({ model: "CR-V", trim: "EX", drivetrain: "4WD/4-Wheel Drive/4x4" }, ["CR-V EX, AWD", "CR-V EX, FWD"])).toBe(
      "CR-V EX, AWD",
    );
    // FWD vs the all-wheel pair is still a real contradiction.
    expect(pickLemonTrim({ model: "Camry", trim: "LE", drivetrain: "FWD/Front-Wheel Drive" }, camry)).toBe(
      "Camry LE, FWD",
    );
  });

  it("still resolves when the only folder contradicts the drivetrain", () => {
    // The penalty must DEMOTE, never disqualify: a wrong-drivetrain manual
    // still beats no manual when it is the only one published.
    expect(pickLemonTrim({ model: "CR-V", trim: "EX", drivetrain: "FWD" }, ["CR-V EX, AWD"])).toBe(
      "CR-V EX, AWD",
    );
    expect(scoreLemonTrim({ model: "CR-V", trim: "EX", drivetrain: "FWD" }, "CR-V EX, AWD")).toBeGreaterThanOrEqual(0);
  });

  it("rewards displacement echoes and requires the model", () => {
    const accord = ["Accord Sport, 1.5L Eng", "Accord Sport, 2.0L Eng"];
    expect(pickLemonTrim({ model: "Accord", trim: "Sport", displacement_l: 2.0 }, accord)).toBe(
      "Accord Sport, 2.0L Eng",
    );
    expect(scoreLemonTrim({ model: "CR-V" }, "Pilot LX, AWD")).toBe(-1);
    expect(pickLemonTrim({ model: "CR-V" }, ["Pilot LX, AWD"])).toBeNull();
  });

  it("is deterministic with no drivetrain signal (shortest, then lexicographic)", () => {
    expect(pickLemonTrim({ model: "CR-V", trim: "EX" }, CRV_2021)).toBe(
      pickLemonTrim({ model: "CR-V", trim: "EX" }, [...CRV_2021].reverse()),
    );
  });

  // Real folder names from the live /BMW/2023/ index (Aug 6 2026).
  const BMW_2023 = [
    "330e xDrive",
    "330i",
    "330i xDrive",
    "430i 2D Convertible",
    "430i 2D Coupe",
    "430i Gran Coupe",
    "430i Gran Coupe xDrive",
    "430i xDrive 2D Convertible",
    "430i xDrive 2D Coupe",
  ];

  it("REGRESSION: BMW designation folders resolve although the model ('4 Series') appears in none", () => {
    // The live miss: model "4 Series" → alnum "4series" is in no folder, so the
    // model gate disqualified the whole directory and the 2023 430i xDrive
    // enriched without LEMON while "430i xDrive 2D Coupe" sat on the index.
    expect(
      pickLemonTrim({ model: "4 Series", trim: "430i xDrive", drivetrain: "AWD" }, BMW_2023),
    ).toBe("430i xDrive 2D Coupe");
  });

  it("brand drivetrain words count: xDrive beats the RWD sibling for an AWD car", () => {
    // Without the xdrive→awd alias both coupes tie and the shorter (RWD)
    // folder wins the tiebreak.
    expect(
      pickLemonTrim({ model: "4 Series", trim: "430i xDrive", drivetrain: "AWD" }, [
        "430i 2D Coupe",
        "430i xDrive 2D Coupe",
      ]),
    ).toBe("430i xDrive 2D Coupe");
  });

  it("the designation anchor is exact per token: 330i never adopts 330e", () => {
    expect(pickLemonTrim({ model: "3 Series", trim: "330i xDrive", drivetrain: "AWD" }, BMW_2023)).toBe(
      "330i xDrive",
    );
    expect(pickLemonTrim({ model: "3 Series", trim: "330e xDrive", drivetrain: "AWD" }, BMW_2023)).toBe(
      "330e xDrive",
    );
  });

  it("digit-less trims stay model-gated: a Civic EX cannot adopt Pilot EX-L's manual", () => {
    // The fallback must be scheme detection for designation-named directories,
    // never a general loosening of the model gate.
    expect(pickLemonTrim({ model: "Civic", trim: "EX", drivetrain: "FWD" }, ["Pilot EX-L, AWD"])).toBeNull();
  });
});

describe("hrefSegments / hrefTail", () => {
  it("REGRESSION: an encoded slash inside a folder name stays one segment", () => {
    // "Brake Shoes &/Or Pads" and "A/C Compressor Drive Belt" are real folder
    // names. Decoding before splitting turned each into two segments.
    expect(hrefTail("Brakes/Brake%20Shoes%20%26%2FOr%20Pads/Remove%20%26%20Replace/")).toBe(
      "Brake Shoes &/Or Pads / Remove & Replace",
    );
    expect(hrefTail("HVAC/A%2FC%20Compressor%20Drive%20Belt/Remove%20%26%20Replace/")).toBe(
      "A/C Compressor Drive Belt / Remove & Replace",
    );
  });

  it("decodes ordinary segments and refuses a too-short path", () => {
    expect(hrefSegments("Engine%20Performance/Spark%20Plugs/")).toEqual(["Engine Performance", "Spark Plugs"]);
    expect(hrefTail("OnlyOne/")).toBeNull();
  });
});

describe("selectRelevantLeaves", () => {
  const href = (p: string) => p.split("/").map(encodeURIComponent).join("/") + "/";

  it("ranks Honda's spec sections first", () => {
    const hrefs = [
      href("Body & Frame/Door/Adjustments"),
      href("Engine Mechanical/Cooling System/Standards and Service Limits"),
      href("Transmission/Fluid"),
    ];
    const picked = selectRelevantLeaves(hrefs);
    expect(picked[0].label).toBe("service_limits");
    expect(picked.map((l) => l.label)).toContain("fluid");
  });

  it("REGRESSION: Ford's vocabulary is selected (it scored zero before)", () => {
    // Ford publishes no "Standards and Service Limits" / "Service
    // Specifications" leaves at all — verified live on a 2019 F-150.
    const hrefs = [
      href("Drivelines & Axles/Rear Drive Axle/Specifications/Capacities"),
      href("General Information/General Specifications"),
      href("General Information/Torque Specifications"),
      href("General Information/Lubricants, Fluids, Sealers and Adhesives"),
      href("Accessories & Equipment/Radio/Description"),
    ];
    const labels = selectRelevantLeaves(hrefs).map((l) => l.label);
    expect(labels).toEqual(
      expect.arrayContaining(["capacity", "lubricants", "general_specifications", "torque_specifications"]),
    );
    expect(labels).not.toContain(undefined);
    expect(selectRelevantLeaves(hrefs)).toHaveLength(4);
  });

  it("REGRESSION: a capacitor is not a capacity", () => {
    const hrefs = [href("Electrical/Wiring Diagrams/Ignition Transformer Capacitor (5.0L)")];
    expect(selectRelevantLeaves(hrefs)).toEqual([]);
  });

  it("takes both Ford's plural and Toyota's singular capacity titles", () => {
    const ford = href("Drivelines & Axles/Rear Drive Axle/Specifications/Capacities");
    const toyota = href("Engine Mechanical/Lubrication/A25A-FKS Engine Oil Standard Capacity");
    expect(selectRelevantLeaves([ford, toyota]).map((l) => l.label)).toEqual(["capacity", "capacity"]);
  });

  it("takes both makes' lubricant pages with one pattern", () => {
    const hrefs = [
      href("General Information/Lubricants, Fluids, Sealers and Adhesives"),
      href("Maintenance/Fluids And Lubricants"),
    ];
    expect(selectRelevantLeaves(hrefs).map((l) => l.label)).toEqual(["lubricants", "lubricants"]);
  });

  it("breaks equal-weight ties by subsystem, not alphabetically", () => {
    // Toyota publishes 470 "Service Specifications" leaves; without the bonus
    // the cap took whichever dozen sorted first.
    const hrefs = [
      href("Accessories & Equipment/Antenna/Service Specifications"),
      href("Engine Mechanical/Cooling System/Service Specifications"),
    ];
    expect(selectRelevantLeaves(hrefs, 1)[0].href).toBe(hrefs[1]);
  });

  it("REVIEW: denies non-US-market maintenance pages, keeps the US ones", () => {
    // Honda files an Ecuador/"General Countries" schedule and fluids page in
    // the same tree as the US-market (KA/KC) pages. Wrong-market intervals must
    // never reach batch1a.
    const hrefs = [
      href(
        "General Information/OEM General Information/General Information/Service Information/Maintenance Schedule for Normal and Severe Conditions - General Countries (Ecuador) (2019 2020 2021)",
      ),
      href("Maintenance/Procedures/Maintenance (Except Hybrid)/General Information For Maintenance/Lubricants and Fluids (Ecuador)"),
      href("Maintenance/Procedures/Maintenance (Except Hybrid)/Maintenance/Maintenance Main Items (KA)"),
      href("Maintenance/Procedures/Maintenance (Except Hybrid)/Maintenance/Maintenance Sub Items (KA)"),
      href("Maintenance/Procedures/Maintenance (Except Hybrid)/General Information For Maintenance/Lubricants and Fluids (KA/KC)"),
    ];
    const picked = selectRelevantLeaves(hrefs);
    expect(picked.map((l) => l.label).filter((l) => l === "maintenance_items")).toHaveLength(2);
    expect(picked.some((l) => l.label === "maintenance_schedule")).toBe(false);
    for (const l of picked) expect(decodeURIComponent(l.href)).not.toMatch(/ecuador|general countries/i);
  });

  it("REVIEW: denies Chrysler-style wrong-market schedules, keeps North America", () => {
    // Live 2020 Ram 1500 harvest pulled Middle East + Latin America schedules
    // beside the North America ones.
    const hrefs = [
      href("General Information/OEM General Information/Maintenance Schedules/Maintenance Schedule - Middle East/Notes"),
      href("General Information/OEM General Information/Maintenance Schedules/Maintenance Schedules - LATIN AMERICA"),
      href("General Information/OEM General Information/Maintenance Schedules/Maintenance Schedules - North AMERICA - Gas"),
    ];
    const picked = selectRelevantLeaves(hrefs);
    expect(picked).toHaveLength(1);
    expect(decodeURIComponent(picked[0].href)).toContain("North AMERICA");
  });

  it("REVIEW: maintenance pages outrank even a subsystem-bonused spec leaf", () => {
    const maint = href("Maintenance/Procedures/Maintenance/Maintenance/Maintenance Main Items");
    // service_limits (100) + fluid-subsystem bonus (12) = 112 — the old 110
    // maintenance weight lost this comparison.
    const bonused = href("Engine Mechanical/Cooling System/Standards and Service Limits");
    expect(selectRelevantLeaves([bonused, maint], 1)[0].href).toBe(maint);
  });

  it("REVIEW: BMW Technical Data is harvested; collision body pages are denied", () => {
    const hrefs = [
      // The junk that took 9 of 12 slots on a live 2020 330i run:
      href("Body & Frame/Exterior Body Panels/Collision - Body Dimensions And Torque Specifications (G20)/Torque Specifications/41 51 Front Doors"),
      href("Body & Frame/Exterior Body Panels/Collision - Body Dimensions And Torque Specifications (G20)/Body Dimensions/BODY GAP DIMENSIONS REH-HIN-P-4100-F39 - V.1"),
      // The real payload:
      href("Accessories & Equipment/Exterior Lights/Technical Data (G20)/11 00 ENGINE (330i, 330i xDrive)"),
      href("Accessories & Equipment/Exterior Lights/Technical Data (G20)/17 00 COOLING, TEST (330i, 330i xDrive)"),
    ];
    const picked = selectRelevantLeaves(hrefs);
    expect(picked.map((l) => l.label)).toEqual(["technical_data", "technical_data"]);
    for (const l of picked) expect(decodeURIComponent(l.href)).not.toMatch(/collision/i);
  });

  it("dedupes a page that appears under two parents and honours the cap", () => {
    const dupA = href("Engine Mechanical/Cooling System/Standards and Service Limits");
    const dupB = href("Quick Lookups/Cooling System/Standards and Service Limits");
    expect(selectRelevantLeaves([dupA, dupB])).toHaveLength(1);
    expect(selectRelevantLeaves([dupA, href("Brakes/Fluid")], 1)).toHaveLength(1);
    expect(selectRelevantLeaves([dupA], 0)).toEqual([]);
  });
});

describe("encodeLemonSegment / resolveLeafUrl", () => {
  it("percent-encodes parens so LEMON's 308 redirect is never drawn", () => {
    expect(encodeLemonSegment("Repair and Diagnosis (Single Page)")).toBe(
      "Repair%20and%20Diagnosis%20%28Single%20Page%29",
    );
  });

  it("resolveLeafUrl normalises literal parens from any base", () => {
    const base = "https://lemon-manuals.la/Honda/2021/CR-V/Repair and Diagnosis (Single Page)/";
    const url = resolveLeafUrl(base, "Engine/Specs%20%282020-21%29/");
    expect(url).not.toBeNull();
    expect(url).not.toContain("(");
    expect(url).toContain("%28Single%20Page%29");
    expect(url).toContain("%282020-21%29"); // already-encoded parens untouched
    expect(resolveLeafUrl("not a url at all", "%")).toBeNull();
  });
});

describe("extractLeafHrefs", () => {
  it("keeps relative content links only", () => {
    const html = `
      <a href="/style.css">css</a><a href="/Honda/">up</a><a href="https://x.test/">ext</a>
      <a href="#top">anchor</a>
      <a href="Engine/Specs/">one</a><a href="Engine/Specs/">dup</a><a href="Brakes/Specs/">two</a>`;
    expect(extractLeafHrefs(html)).toEqual(["Engine/Specs/", "Brakes/Specs/"]);
  });
});

describe("htmlLeafToMarkdown", () => {
  it("flattens the main content's table to pipe rows", () => {
    const html =
      `<html><body><div class="nav">skip me</div><div class="main">` +
      `<h2>Cooling System</h2>` +
      `<table><tr><th>Item</th><th>Value</th></tr>` +
      `<tr><td>Coolant capacity</td><td>6.3 L</td></tr></table>` +
      `<ul><li>Note one</li></ul>` +
      `</div><div class="theme-colors footer">footer junk</div></body></html>`;
    const md = htmlLeafToMarkdown(html);
    expect(md).toContain("## Cooling System");
    expect(md).toContain("Item | Value");
    expect(md).toContain("Coolant capacity | 6.3 L");
    expect(md).toContain("- Note one");
    expect(md).not.toContain("skip me");
    expect(md).not.toContain("footer junk");
  });

  it("decodes entities and never throws on junk", () => {
    expect(htmlLeafToMarkdown('<div class="main">Remove &amp; Replace</div>')).toBe("Remove & Replace");
    expect(htmlLeafToMarkdown("")).toBe("");
  });
});

// ─── Variant equivalence ─────────────────────────────────────────────────────

/**
 * The real header markup from the live 2019 GMC Sierra 1500 SLT Crew Cab
 * landing page (lemon-manuals.la, Aug 2026), structure verbatim: the
 * folder-links <ul> sits BEFORE the sentence, quotes are &quot; entities, and
 * <li> items are unclosed (`<li>A<li>B`). Site-generated chrome only — no
 * manual content.
 */
const SIERRA_VARIANTS = [
  "Sierra 1500 Elevation, 5.3L Eng VIN D, 4WD",
  "Sierra 1500 SLE, 4D Pickup Crew Cab, 5.3L Eng VIN D, 4WD",
  "Sierra 1500 SLE, 4D Pickup Extra Cab, 5.3L Eng VIN D, 4WD",
  "Sierra 1500 SLT, 4D Pickup Extra Cab, 5.3L Eng VIN D, 4WD",
];

const SIERRA_LANDING =
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Free Service Manual ~ LEMON Manuals</title></head><body>` +
  `<div class="theme-colors header"><div class="branding"><b>LEMON Manuals</b></div></div>` +
  `<div class="other-warning other-announcement">July 1: <a href='/static/cnd.pdf'>So it begins</a>.</div>` +
  `<div class="main"><h1>GMC: 2019: Sierra 1500 SLT, 4D Pickup Crew Cab, 5.3L Eng VIN D, 4WD</h1>This is a LEMON manual, retrieved in 2025.\n` +
  `<ul>\n` +
  `<li><img class='folder-icon' src='/icons/wrench.svg'><a href='Repair%20and%20Diagnosis/'>Repair and Diagnosis</a>\n` +
  `<li><img class='folder-icon' src='/icons/tools-and-equipment.svg'><a href='Repair%20and%20Diagnosis%20%28Single%20Page%29/'>Repair and Diagnosis, all links on one page</a> (may load slowly, but easier to search)\n` +
  `<li><img class='folder-icon' src='/icons/labor-times.svg'><a href='Labor%20Times/'>Labor Times</a>\n` +
  `</ul>\n` +
  `This manual is identical to the manual for the following model variants, except for possibly the &quot;Labor Times&quot;, &quot;Fluids&quot;, and &quot;Tire Fitment&quot; pages:\n` +
  `<ul>\n<li>${SIERRA_VARIANTS[0]}<li>${SIERRA_VARIANTS[1]}<li>${SIERRA_VARIANTS[2]}<li>${SIERRA_VARIANTS[3]}\n</ul>` +
  `</div><div class="theme-colors footer"><i>scientia non olet</i> · <a href="/about.html">About LEMON Manuals</a></div><script src="/script.js"></script></body></html>`;

/** The same landing page with no equivalence header (unique-manual trims). */
const LANDING_NO_HEADER = SIERRA_LANDING.replace(
  /This manual is identical[\s\S]*?<\/ul>/,
  "",
);

describe("parseLemonEquivalence", () => {
  it("parses the real Sierra header: 4 variants in order + the excluded trio", () => {
    const eq = parseLemonEquivalence(SIERRA_LANDING);
    expect(eq).not.toBeNull();
    expect(eq!.variants).toEqual(SIERRA_VARIANTS);
    expect(eq!.excluded_pages).toEqual(["Labor Times", "Fluids", "Tire Fitment"]);
  });

  it("anchors AFTER the sentence: the folder-links <ul> never leaks into variants", () => {
    const eq = parseLemonEquivalence(SIERRA_LANDING)!;
    for (const v of eq.variants) {
      expect(v).not.toMatch(/repair and diagnosis|labor times/i);
    }
  });

  it("ADDITIVE: returns null when the header is absent", () => {
    expect(parseLemonEquivalence(LANDING_NO_HEADER)).toBeNull();
    expect(parseLemonEquivalence("")).toBeNull();
    expect(parseLemonEquivalence("<div class='main'>plain page</div>")).toBeNull();
  });

  it("returns null when the sentence has no usable list", () => {
    const sentence = `This manual is identical to the manual for the following model variants, except for possibly the &quot;Labor Times&quot; pages:`;
    expect(parseLemonEquivalence(`<div>${sentence}</div>`)).toBeNull(); // no <ul> at all
    expect(parseLemonEquivalence(`<div>${sentence}\n<ul>\n</ul></div>`)).toBeNull(); // empty list
    expect(parseLemonEquivalence(`<div>${sentence}\n<ul>\n<li>A`)).toBeNull(); // unterminated
  });

  it("decodes entities in variant names and dedupes", () => {
    const html =
      `x This manual is identical to the manual for the following model variants, except for possibly the &quot;Labor Times&quot; pages:\n` +
      `<ul>\n<li>Sprinter 2500 Cargo &amp; Crew, RWD<li>Sprinter 2500 Cargo &amp; Crew, RWD<li>Gas&#47;Ethanol Variant\n</ul>`;
    const eq = parseLemonEquivalence(html)!;
    expect(eq.variants).toEqual(["Sprinter 2500 Cargo & Crew, RWD", "Gas/Ethanol Variant"]);
    expect(eq.excluded_pages).toEqual(["Labor Times"]);
  });

  it("falls back to the known trio when the except clause parses no names", () => {
    const html =
      `This manual is identical to the manual for the following model variants, except for possibly some pages:\n` +
      `<ul>\n<li>CR-V EX-L, AWD\n</ul>`;
    expect(parseLemonEquivalence(html)!.excluded_pages).toEqual([...LEMON_EQUIVALENCE_DEFAULT_EXCLUDED]);
  });

  it("claims full identity ([] excluded) only when there is no except clause", () => {
    const html =
      `This manual is identical to the manual for the following model variants:\n` +
      `<ul>\n<li>CR-V EX-L, AWD\n</ul>`;
    expect(parseLemonEquivalence(html)!.excluded_pages).toEqual([]);
  });
});

describe("nameCoversTrim / equivalentVariantForTrim", () => {
  it("requires every trim token as a whole word", () => {
    const folder = "Sierra 1500 SLT, 4D Pickup Crew Cab, 5.3L Eng VIN D, 4WD";
    expect(nameCoversTrim({ trim: "SLT" }, folder)).toBe(true);
    expect(nameCoversTrim({ trim: "SLE" }, folder)).toBe(false);
    expect(nameCoversTrim({ trim: "430i xDrive" }, "430i xDrive 2D Coupe")).toBe(true);
    expect(nameCoversTrim({ trim: "430i xDrive" }, "430i 2D Coupe")).toBe(false);
    // Whole words, not substrings — the Camry LE vs XLE rule holds here too.
    expect(nameCoversTrim({ trim: "LE" }, "Camry XLE, FWD")).toBe(false);
    expect(nameCoversTrim({ trim: "EX-L" }, "CR-V EX-L, AWD")).toBe(true);
  });

  it("a vehicle with no trim covers nothing", () => {
    expect(nameCoversTrim({ trim: null }, "CR-V EX, AWD")).toBe(false);
    expect(nameCoversTrim({}, "CR-V EX, AWD")).toBe(false);
  });

  it("finds the first variant naming the config's trim", () => {
    expect(equivalentVariantForTrim({ trim: "SLE" }, SIERRA_VARIANTS)).toBe(
      "Sierra 1500 SLE, 4D Pickup Crew Cab, 5.3L Eng VIN D, 4WD",
    );
    expect(equivalentVariantForTrim({ trim: "Elevation" }, SIERRA_VARIANTS)).toBe(
      "Sierra 1500 Elevation, 5.3L Eng VIN D, 4WD",
    );
    expect(equivalentVariantForTrim({ trim: "Denali" }, SIERRA_VARIANTS)).toBeNull();
    expect(equivalentVariantForTrim({ trim: "SLE" }, [])).toBeNull();
  });
});

describe("isEquivalenceExcludedPath", () => {
  const EXCLUDED = ["Labor Times", "Fluids", "Tire Fitment"];

  it("excludes by whole path segment, decoded or raw", () => {
    expect(isEquivalenceExcludedPath("Labor Times/Engine/Oil Change", EXCLUDED)).toBe(true);
    expect(isEquivalenceExcludedPath("Labor%20Times/Engine/Oil%20Change/", EXCLUDED)).toBe(true);
    expect(isEquivalenceExcludedPath("Fluids/Engine Oil", EXCLUDED)).toBe(true);
    expect(isEquivalenceExcludedPath("Tire Fitment/Front", EXCLUDED)).toBe(true);
    expect(
      isEquivalenceExcludedPath("https://lemon-manuals.la/GMC/2019/Sierra/Labor%20Times/x/", EXCLUDED),
    ).toBe(true);
  });

  it("a family name inside a LONGER segment is NOT the family", () => {
    // "Fluids And Lubricants" is a leaf inside Repair and Diagnosis — a tree
    // the header asserts identical — so its claims stay attributable.
    expect(
      isEquivalenceExcludedPath("Maintenance/Fluids And Lubricants", EXCLUDED),
    ).toBe(false);
    expect(
      isEquivalenceExcludedPath("Engine Mechanical/Cooling System/Standards and Service Limits", EXCLUDED),
    ).toBe(false);
  });

  it("tolerates singular/plural drift and empty inputs", () => {
    expect(isEquivalenceExcludedPath("Labor Time/Engine", EXCLUDED)).toBe(true);
    expect(isEquivalenceExcludedPath("Fluid/Engine Oil", EXCLUDED)).toBe(true);
    expect(isEquivalenceExcludedPath("Labor Times/Engine", [])).toBe(false);
    expect(isEquivalenceExcludedPath("", EXCLUDED)).toBe(false);
  });
});

describe("resolveLemonVehicle equivalence (mocked fetch)", () => {
  const YEAR_URL = buildLemonYearUrl("lemon-manuals.la", "GMC", 2019);
  const SLT_4WD = "Sierra 1500 SLT, 4D Pickup Crew Cab, 5.3L Eng VIN D, 4WD";
  const LANDING_URL = YEAR_URL + `${encodeLemonSegment(SLT_4WD)}/`;
  const YEAR_HTML =
    `<a href="/GMC/2019/${encodeLemonSegment(SLT_4WD)}/">a</a>` +
    `<a href="/GMC/2019/${encodeLemonSegment("Sierra 1500 SLT, 4D Pickup Crew Cab, 5.3L Eng VIN D, RWD")}/">b</a>`;

  const stubRoutes = (routes: Record<string, string>): string[] => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      const body = routes[u];
      return {
        ok: body !== undefined,
        status: body !== undefined ? 200 : 404,
        text: async () => body ?? "",
      };
    });
    return calls;
  };

  afterEach(() => vi.unstubAllGlobals());

  const SLE_ARGS = { make: "GMC", model: "Sierra 1500", year: 2019, trim: "SLE", drivetrain: "4WD" };

  it("upgrades a best-effort pick to 'equivalent' when the header names the config's trim", async () => {
    // Config trim "SLE" is absent from the folder list; the scoring gate picks
    // the SLT 4WD sibling best-effort. Its landing page asserts the manual is
    // identical for the SLE variants — the mirror itself makes the pick exact.
    stubRoutes({ [YEAR_URL]: YEAR_HTML, [LANDING_URL]: SIERRA_LANDING });
    const res = await resolveLemonVehicle(SLE_ARGS, { equivalence: true });
    expect(res).not.toBeNull();
    expect(res!.trim).toBe(SLT_4WD);
    expect(res!.trim_match).toBe("equivalent");
    expect(res!.matched_variant).toBe("Sierra 1500 SLE, 4D Pickup Crew Cab, 5.3L Eng VIN D, 4WD");
    expect(res!.equivalence?.variants).toEqual(SIERRA_VARIANTS);
    expect(res!.equivalence?.excluded_pages).toEqual(["Labor Times", "Fluids", "Tire Fitment"]);
  });

  it("classifies a folder that names the trim as 'exact' (equivalence still carried)", async () => {
    stubRoutes({ [YEAR_URL]: YEAR_HTML, [LANDING_URL]: SIERRA_LANDING });
    const res = await resolveLemonVehicle({ ...SLE_ARGS, trim: "SLT" }, { equivalence: true });
    expect(res!.trim_match).toBe("exact");
    expect(res!.matched_variant).toBeNull();
    expect(res!.equivalence?.variants).toHaveLength(4);
  });

  it("ADDITIVE: stays best_effort with null equivalence when the header is absent", async () => {
    stubRoutes({ [YEAR_URL]: YEAR_HTML, [LANDING_URL]: LANDING_NO_HEADER });
    const res = await resolveLemonVehicle(SLE_ARGS, { equivalence: true });
    expect(res!.trim_match).toBe("best_effort");
    expect(res!.equivalence).toBeNull();
    expect(res!.matched_variant).toBeNull();
  });

  it("fails open when the landing page is unreachable", async () => {
    stubRoutes({ [YEAR_URL]: YEAR_HTML }); // landing 404s
    const res = await resolveLemonVehicle(SLE_ARGS, { equivalence: true });
    expect(res).not.toBeNull();
    expect(res!.trim).toBe(SLT_4WD);
    expect(res!.trim_match).toBe("best_effort");
    expect(res!.equivalence).toBeNull();
  });

  it("ADDITIVE: without opts (the labor path) no landing fetch happens and no fields appear", async () => {
    const calls = stubRoutes({ [YEAR_URL]: YEAR_HTML, [LANDING_URL]: SIERRA_LANDING });
    const res = await resolveLemonVehicle(SLE_ARGS);
    expect(res).not.toBeNull();
    expect(res!.trim).toBe(SLT_4WD);
    expect(calls).toEqual([YEAR_URL]); // year dir only — behavior identical to before
    expect("trim_match" in res!).toBe(false);
    expect("equivalence" in res!).toBe(false);
  });

  it("threads the equivalence onto the scrape result end-to-end", async () => {
    const INDEX_URL = LANDING_URL + `${encodeLemonSegment("Repair and Diagnosis (Single Page)")}/`;
    const LEAF_URL = resolveLeafUrl(INDEX_URL, "Maintenance/Capacities/")!;
    stubRoutes({
      [YEAR_URL]: YEAR_HTML,
      [LANDING_URL]: SIERRA_LANDING,
      [INDEX_URL]: `<div class="main"><ul><li><a href="Maintenance/Capacities/">Capacities</a></ul></div>`,
      [LEAF_URL]:
        `<div class="main"><table><tr><th>Item</th><th>Spec</th></tr>` +
        `<tr><td>Engine oil capacity</td><td>6.0 qt</td></tr></table></div>`,
    });
    const preview = await fetchLemonManualMarkdown(SLE_ARGS);
    expect(preview.ok).toBe(true);
    expect(preview.trim_match).toBe("equivalent");
    expect(preview.matched_variant).toBe("Sierra 1500 SLE, 4D Pickup Crew Cab, 5.3L Eng VIN D, 4WD");
    expect(preview.equivalent_variants).toEqual(SIERRA_VARIANTS);
    expect(preview.equivalence_excluded_pages).toEqual(["Labor Times", "Fluids", "Tire Fitment"]);
    expect(preview.markdown).toContain("6.0 qt");
  });
});
