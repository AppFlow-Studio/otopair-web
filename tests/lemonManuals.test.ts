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
import { describe, it, expect } from "vitest";
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
