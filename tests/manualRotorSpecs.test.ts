/**
 * Manuals as a rotor-minimum source (Aug 2026).
 *
 * Three seams are covered here, and the middle one is the reason the other two
 * are safe to have:
 *
 *   1. the PAGE SCORER finds a brake specification table and refuses pages that
 *      merely say "thickness";
 *   2. `rotorClaimSurvives` lets the deterministic parser — not the model —
 *      decide what an extracted number MEANS;
 *   3. the resolver grades a manufacturer's figure `oem_spec` and a third-party
 *      catalogue's figure `oem_spec_flagged`.
 *
 * The failure this guards against is specific and dangerous: a nominal filed as
 * a discard minimum condemns every healthy rotor on the vehicle, and a
 * machining limit filed as one passes worn ones.
 */
import { describe, it, expect } from "vitest";
import {
  billedPageCount,
  BRAKE_PICK_OPTIONS,
  mergePageRanges,
  pageCountOf,
  pickPageRanges,
  scoreManualPages,
  specsPageRanges,
  PAGE_INDEX_VERSION,
} from "../convex/vehicleEnrichment/manualPageIndex";
import {
  parseSpecPayload,
  rotorClaimSurvives,
  ROTOR_QUOTE_TOLERANCE_MM,
  SPEC_FIELDS,
} from "../convex/vehicleEnrichment/manualSpecs";
import { resolveRotorMinimums } from "../convex/vehicleEnrichment/utils/rotorSpecResource";
import {
  parseRotorThickness,
  pickRotorThickness,
} from "../convex/vehicleEnrichment/rotorThickness";

const fieldFor = (key: string) => SPEC_FIELDS.find((f) => f.key === key)!;

// ─── Fixtures ────────────────────────────────────────────────────
// Structurally faithful to a brake specification table: subject, labelled
// limits, decimal millimetre values.
const BRAKE_SPEC_PAGE =
  "Brake System Specifications Front Brake Disc Standard thickness 28.0 mm " +
  "Minimum thickness 26.0 mm Minimum machining thickness 26.6 mm " +
  "Disc runout limit 0.05 mm Rear Brake Disc Standard thickness 12.0 mm " +
  "Minimum thickness 10.5 mm Brake pad lining minimum thickness 1.0 mm";

// Says "thickness" repeatedly and is about glass. The subject gate is the only
// thing standing between this and a billed page.
const GLASS_PAGE =
  "Windshield Glass Replacement The laminated glass thickness is 4.76 mm and the " +
  "tempered side glass thickness is 3.15 mm. Nominal thickness tolerances apply " +
  "to all glazing. Original thickness must be matched when replacing.";

const CAPACITIES_PAGE =
  "Technical Data Capacities and Specifications Engine oil with filter 5.7 qt (5.4 L) " +
  "Cooling system 9.5 qt (9.0 L) Recommended fluids and lubricants viscosity SAE 0W-20 " +
  "dexos1 Fuel tank 15.8 qt capacity";

const NAV_PAGE =
  "Contents Brake Disc . . . . 412 Minimum thickness . . . . 413 Brake pad . . . . 414 " +
  "Rotor . . . . 415 Caliper . . . . 416 Service limit . . . . 417 Wear limit . . . . 418 " +
  "Discard . . . . 419 Runout . . . . 420 Lining . . . . 421 Thickness . . . . 422 " +
  "Disc brake . . . . 423 Brake disc . . . . 424";

describe("scoreManualPages — brakes", () => {
  it("scores a brake specification table well above the pick floor", () => {
    const [s] = scoreManualPages([BRAKE_SPEC_PAGE]);
    expect(s.brakes).toBeGreaterThan(BRAKE_PICK_OPTIONS.minAbs!);
  });

  it("scores ZERO on a page with no brake subject, however many thickness labels", () => {
    const [s] = scoreManualPages([GLASS_PAGE]);
    expect(s.brakes).toBe(0);
  });

  it("scores zero on a capacities page — the two categories do not overlap", () => {
    const [s] = scoreManualPages([CAPACITIES_PAGE]);
    expect(s.brakes).toBe(0);
    expect(s.spec).toBeGreaterThan(0);
  });

  it("scores ZERO on brake PROSE — subject density must not carry a page", () => {
    // Live fire: 2021 GMC Acadia owner's manual p287. Says "brake" ~20 times
    // across wear warnings and fluid checks, carries no thickness label and no
    // measurement, and the parser extracts nothing from it. The first version
    // of this scorer selected it and would have billed for it.
    const ACADIA_P287 =
      "286 Vehicle Care Warning The brake wear warning sound means that soon the " +
      "brakes will not work well. When the brake wear warning sound is heard, have " +
      "the vehicle serviced. Continuing to drive with worn-out brake linings could " +
      "result in costly brake repairs. Some driving conditions can cause a brake " +
      "squeal when the brakes are first applied. Brake pads should be replaced as " +
      "complete axle sets. Brake Pedal Travel See your dealer if the brake pedal does " +
      "not return to normal height. Replacing Brake System Parts Always replace brake " +
      "system parts with new, approved replacement parts. Brake Fluid The brake master " +
      "cylinder reservoir is filled with GM approved DOT 3 brake fluid.";
    const [s] = scoreManualPages([ACADIA_P287]);
    expect(s.brakes).toBe(0);
  });

  it("excludes navigation pages that cite every brake term and contain no data", () => {
    const [s] = scoreManualPages([NAV_PAGE]);
    expect(s.isNav).toBe(true);
    expect(s.brakes).toBe(0);
  });

  it("picks the brake page and leaves the rest of the document unbilled", () => {
    const pages = [CAPACITIES_PAGE, GLASS_PAGE, BRAKE_SPEC_PAGE, NAV_PAGE, GLASS_PAGE];
    const ranges = pickPageRanges(scoreManualPages(pages), "brakes", BRAKE_PICK_OPTIONS);
    expect(ranges).toEqual([{ start: 3, end: 3 }]);
    expect(pageCountOf(ranges)).toBe(1);
  });

  it("returns nothing when the document has no brake pages at all", () => {
    const ranges = pickPageRanges(
      scoreManualPages([CAPACITIES_PAGE, GLASS_PAGE]),
      "brakes",
      BRAKE_PICK_OPTIONS,
    );
    expect(ranges).toEqual([]);
  });
});

describe("parseRotorThickness — physical bounds on labelled values", () => {
  it("refuses a tyre spec the catch-all `nominal` label would otherwise claim", () => {
    // Live fire: 2021 GMC Acadia owner's manual p317. "nominal rim diameters"
    // classifies as `nominal`, and 12 in = 304.8 mm. Unbounded, that reading
    // wins pickRotorThickness's largest-nominal tie-break and becomes the
    // vehicle's nominal thickness.
    const readings = parseRotorThickness(
      "for use on tires with nominal rim diameters of 10 to 12 in",
    );
    expect(readings).toEqual([]);
  });

  it("refuses an implausibly thin labelled value", () => {
    expect(parseRotorThickness("Minimum thickness 0.5 mm")).toEqual([]);
  });

  it("still reads a real labelled minimum", () => {
    const r = parseRotorThickness("Minimum thickness 26.0 mm");
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("discard_min");
    expect(r[0].valueMm).toBe(26);
  });

  it("a bogus out-of-band nominal can no longer beat the real one", () => {
    const pick = pickRotorThickness(
      parseRotorThickness(
        "tires with nominal rim diameters of 10 to 12 in | Standard thickness 28.0 mm",
      ),
    );
    expect(pick.nominalMm).toBe(28);
  });
});

describe("mergePageRanges / specsPageRanges", () => {
  it("unions and sorts disjoint lists", () => {
    expect(mergePageRanges([{ start: 5, end: 6 }], [{ start: 1, end: 2 }])).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
  });

  it("coalesces overlapping ranges so a shared page is billed once", () => {
    const merged = mergePageRanges([{ start: 1, end: 5 }], [{ start: 4, end: 8 }]);
    expect(merged).toEqual([{ start: 1, end: 8 }]);
    expect(pageCountOf(merged)).toBe(8);
  });

  it("coalesces adjacency (10-12 and 13-14 are one range)", () => {
    expect(mergePageRanges([{ start: 10, end: 12 }], [{ start: 13, end: 14 }])).toEqual([
      { start: 10, end: 14 },
    ]);
  });

  it("tolerates a v1 index with no brakes key", () => {
    const idx = {
      version: PAGE_INDEX_VERSION,
      total_pages: 400,
      intervals: [],
      specs: [{ start: 358, end: 360 }],
      computed_at: 0,
    };
    expect(specsPageRanges(idx)).toEqual([{ start: 358, end: 360 }]);
  });

  it("sends specs AND brakes on the specs pass", () => {
    const idx = {
      version: PAGE_INDEX_VERSION,
      total_pages: 400,
      intervals: [],
      specs: [{ start: 358, end: 360 }],
      brakes: [{ start: 412, end: 413 }],
      computed_at: 0,
    };
    expect(specsPageRanges(idx)).toEqual([
      { start: 358, end: 360 },
      { start: 412, end: 413 },
    ]);
  });
});

describe("rotorClaimSurvives — the parser is the arbiter", () => {
  const minFront = fieldFor("rotor_front_min_thickness_mm");
  const nominalFront = fieldFor("rotor_front_nominal_thickness_mm");
  const minRear = fieldFor("rotor_rear_min_thickness_mm");

  it("accepts a minimum quoted under a discard-supporting label", () => {
    expect(rotorClaimSurvives(minFront, 26, "Minimum thickness 26.0 mm")).toEqual({ ok: true });
  });

  it("REFUSES a nominal filed as a minimum", () => {
    const v = rotorClaimSurvives(minFront, 28, "Standard thickness 28.0 mm");
    expect(v.ok).toBe(false);
    // The rejection names what the parser actually saw, so the drop is
    // diagnosable from the log without reopening the PDF.
    expect((v as any).reason).toContain("rotor_quote_does_not_support_discard_min");
    expect((v as any).reason).toContain("nominal");
  });

  it("REFUSES a machining limit filed as a minimum", () => {
    const v = rotorClaimSurvives(minFront, 26.6, "Minimum machining thickness 26.6 mm");
    expect(v.ok).toBe(false);
    expect((v as any).reason).toContain("machine_to");
  });

  it("refuses a value the quote does not contain at all", () => {
    const v = rotorClaimSurvives(minFront, 24, "Minimum thickness 26.0 mm");
    expect(v.ok).toBe(false);
  });

  it("refuses a bare number with no label", () => {
    const v = rotorClaimSurvives(minFront, 26, "26.0 mm");
    expect(v.ok).toBe(false);
    expect((v as any).reason).toBe("rotor_quote_unparseable");
  });

  it("accepts an inch-printed spec within the conversion tolerance", () => {
    // 0.945 in = 24.003 mm — a model reporting 24.0 agrees with its own quote.
    const v = rotorClaimSurvives(minFront, 24.0, "Discard thickness 0.945 in");
    expect(v.ok).toBe(true);
    expect(Math.abs(24.003 - 24.0)).toBeLessThanOrEqual(ROTOR_QUOTE_TOLERANCE_MM);
  });

  it("refuses a minimum outside the rear axle's band", () => {
    // The REJECT band is deliberately wide (rear 4-32 mm) — the narrower 6-24
    // figure is the FLAG band, and flagging is the persist layer's job, not
    // this one's. Same convention as brembo.ts and summitCentric.ts: reject on
    // `valid`, leave `typical` to validateRotorResolution. So this has to be a
    // genuinely impossible rear figure, not merely an unusual one.
    const v = rotorClaimSurvives(minRear, 35, "Minimum thickness 35.0 mm");
    expect(v.ok).toBe(false);
    expect((v as any).reason).toContain("rotor_min_out_of_rear_band");
  });

  it("accepts an unusual-but-possible rear minimum (heavy-duty rotors exist)", () => {
    expect(rotorClaimSurvives(minRear, 26, "Minimum thickness 26.0 mm")).toEqual({ ok: true });
  });

  it("refuses a physically impossible thickness", () => {
    const v = rotorClaimSurvives(minFront, 300, "Minimum thickness 300 mm");
    expect(v.ok).toBe(false);
  });

  it("accepts a nominal quoted under a nominal label", () => {
    expect(rotorClaimSurvives(nominalFront, 28, "Standard thickness 28.0 mm")).toEqual({
      ok: true,
    });
  });

  it("is inert on non-rotor fields", () => {
    expect(rotorClaimSurvives(fieldFor("oil_capacity_qts"), 5.7, "no label here")).toEqual({
      ok: true,
    });
  });
});

describe("parseSpecPayload — rotor fields end to end", () => {
  const payloadWith = (specs: any[]) => ({
    document_matches_vehicle: true,
    document_vehicle_text: "2021 GMC Acadia",
    specs,
    notes: null,
  });

  it("files a correctly-quoted discard minimum", () => {
    const out = parseSpecPayload(
      payloadWith([
        {
          field_key: "rotor_front_min_thickness_mm",
          value: 26,
          unit_as_printed: "mm",
          engine_qualifier: null,
          quoted_text: "Front Brake Disc Minimum thickness 26.0 mm",
          page_number: 412,
        },
      ]),
      null,
    );
    expect(out.specs).toHaveLength(1);
    expect(out.specs[0].value).toBe("26");
  });

  it("drops a nominal the model mislabelled as a minimum, and says why", () => {
    const out = parseSpecPayload(
      payloadWith([
        {
          field_key: "rotor_front_min_thickness_mm",
          value: 28,
          unit_as_printed: "mm",
          engine_qualifier: null,
          quoted_text: "Front Brake Disc Standard thickness 28.0 mm",
          page_number: 412,
        },
      ]),
      null,
    );
    expect(out.specs).toHaveLength(0);
    expect(out.dropped[0].field_key).toBe("rotor_front_min_thickness_mm");
    expect(out.dropped[0].reason).toContain("does_not_support");
  });

  it("does not require an engine qualifier — rotors split by brake package", () => {
    // engine is null here, which would fail every engineSensitive field.
    const out = parseSpecPayload(
      payloadWith([
        {
          field_key: "rotor_rear_min_thickness_mm",
          value: 10.5,
          unit_as_printed: "mm",
          engine_qualifier: "3.6L V6",
          quoted_text: "Rear Brake Disc Minimum thickness 10.5 mm",
          page_number: 413,
        },
      ]),
      null,
    );
    expect(out.specs).toHaveLength(1);
  });

  it("still drops a rotor value with no quote at all", () => {
    const out = parseSpecPayload(
      payloadWith([
        {
          field_key: "rotor_front_min_thickness_mm",
          value: 26,
          unit_as_printed: "mm",
          engine_qualifier: null,
          quoted_text: "",
          page_number: 412,
        },
      ]),
      null,
    );
    expect(out.specs).toHaveLength(0);
    expect(out.dropped[0].reason).toBe("no_quote");
  });
});

describe("resolveRotorMinimums — provenance decides the grade", () => {
  const front = (rs: ReturnType<typeof resolveRotorMinimums>) =>
    rs.find((r) => r.axle === "front")!;

  it("grades a manual-sourced minimum oem_spec and does not flag it", () => {
    const r = front(
      resolveRotorMinimums({
        markdown: null,
        existing: {},
        catalogClaims: {
          front: { minMm: 26, nominalMm: 28, provenance: "manual" },
        },
      }),
    );
    expect(r.outcome).toBe("sourced_manual");
    expect(r.quality).toBe("oem_spec");
    expect(r.minMm).toBe(26);
  });

  it("still grades an aftermarket catalogue minimum oem_spec_flagged", () => {
    const r = front(
      resolveRotorMinimums({
        markdown: null,
        existing: {},
        catalogClaims: {
          front: { minMm: 25, nominalMm: 28, provenance: "catalog" },
        },
      }),
    );
    expect(r.outcome).toBe("sourced_catalog");
    expect(r.quality).toBe("oem_spec_flagged");
  });

  it("defaults to catalog when provenance is absent — existing callers unchanged", () => {
    const r = front(
      resolveRotorMinimums({
        markdown: null,
        existing: {},
        catalogClaims: { front: { minMm: 25, nominalMm: 28 } },
      }),
    );
    expect(r.outcome).toBe("sourced_catalog");
    expect(r.quality).toBe("oem_spec_flagged");
  });

  it("an OEM page's own discard text still outranks a manual claim", () => {
    const r = front(
      resolveRotorMinimums({
        markdown: "Front Brake Rotor Minimum Thickness: 24.0 mm",
        existing: {},
        catalogClaims: {
          front: { minMm: 26, nominalMm: 28, provenance: "manual" },
        },
      }),
    );
    expect(r.outcome).toBe("sourced_markdown");
    expect(r.minMm).toBe(24);
  });

  it("a human's reading still beats a manual claim", () => {
    const r = front(
      resolveRotorMinimums({
        markdown: null,
        existing: { front: { minMm: 25.5, quality: "mechanic_read" } },
        catalogClaims: {
          front: { minMm: 26, nominalMm: 28, provenance: "manual" },
        },
      }),
    );
    expect(r.outcome).toBe("already_present");
    expect(r.minMm).toBe(25.5);
  });

  it("refuses an incoherent manual claim whose minimum meets its nominal", () => {
    const r = front(
      resolveRotorMinimums({
        markdown: null,
        existing: {},
        catalogClaims: {
          front: { minMm: 28, nominalMm: 28, provenance: "manual" },
        },
      }),
    );
    expect(r.outcome).not.toBe("sourced_manual");
    expect(r.minMm).toBeNull();
  });
});

describe("billedPageCount — an empty narrowing bills the whole document", () => {
  it("reports the narrowed count when the index actually narrowed", () => {
    expect(billedPageCount([{ start: 1, end: 3 }], 400)).toBe(3);
  });

  it("reports the WHOLE document when the range list is empty", () => {
    // toReductoPageRange([]) is null, which sends everything — so 0 here would
    // let a 400-page manual clear the budget gate and then bill for 400 pages.
    expect(billedPageCount([], 400)).toBe(400);
  });

  it("passes through an unknown page count rather than inventing a zero", () => {
    expect(billedPageCount([], null)).toBeNull();
  });
});
