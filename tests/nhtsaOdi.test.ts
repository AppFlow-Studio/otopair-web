/**
 * nhtsaOdi pure helpers — NHTSA ODI recalls/complaints parsing + rollup
 * (Phase 0.1). Fixtures mirror the live api.nhtsa.gov response shapes
 * verified Jul 2026 against 2020 Toyota Camry:
 *   recalls:    { Count, Message, results: [{ NHTSACampaignNumber, Component,
 *                 Summary, Consequence, Remedy, ReportReceivedDate, ... }] }
 *   complaints: { count, message, results: [{ odiNumber, crash, fire,
 *                 components, summary, products, ... }] }
 * Pipeline law: fail open — empty/malformed responses parse to empty, never throw.
 */
import { describe, it, expect } from "vitest";
import {
  parseRecallResponse,
  parseComplaintResponse,
  summarizeComplaintsByComponent,
  normalizeComponentName,
  splitComplaintComponents,
} from "../convex/vehicleEnrichment/nhtsaOdi";

// ─── Fixtures ────────────────────────────────────────────────────────────

const recallsFixture = {
  Count: 3,
  Message: "Results returned successfully",
  results: [
    {
      Manufacturer: "Toyota Motor Engineering & Manufacturing",
      NHTSACampaignNumber: "20V682000",
      parkIt: false,
      parkOutSide: false,
      overTheAirUpdate: false,
      ReportReceivedDate: "04/11/2020",
      Component: "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP",
      Summary:
        "Toyota Motor Engineering & Manufacturing (Toyota) is recalling certain 2018-2020 Camry vehicles. The low-pressure fuel pump inside the fuel tank may fail.",
      Consequence:
        "If the fuel pump fails, the engine can stall while driving, increasing the risk of a crash.",
      Remedy:
        "Toyota will notify owners, and dealers will replace the fuel pump assembly with an improved one, free of charge.",
      Notes: "Owners may also contact the NHTSA Vehicle Safety Hotline.",
      ModelYear: "2020",
      Make: "TOYOTA",
      Model: "CAMRY",
    },
    {
      Manufacturer: "Toyota Motor Engineering & Manufacturing",
      NHTSACampaignNumber: "21V056000",
      ReportReceivedDate: "01/28/2021",
      Component: "SERVICE BRAKES, HYDRAULIC",
      Summary: "Certain vehicles may experience a loss of brake vacuum assist.",
      // Consequence/Remedy deliberately absent — both are optional downstream.
      ModelYear: "2020",
      Make: "TOYOTA",
      Model: "CAMRY",
    },
    // Duplicate campaign — must not produce a second record.
    {
      NHTSACampaignNumber: "20V682000",
      Component: "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP",
      Summary: "Duplicate row of the fuel pump recall.",
    },
    // No campaign number — unusable, skipped.
    { Component: "AIR BAGS", Summary: "Orphan row without a campaign number." },
    // Non-object garbage in the array — skipped.
    null,
    "garbage",
  ],
};

const complaintsFixture = {
  count: 5,
  message: "Results returned successfully",
  results: [
    {
      odiNumber: 11752925,
      manufacturer: "Toyota Motor Corporation",
      crash: false,
      fire: false,
      numberOfInjuries: 0,
      numberOfDeaths: 0,
      dateOfIncident: "03/01/2025",
      dateComplaintFiled: "07/26/2026",
      vin: "4t1k61ak8lu",
      components: "UNKNOWN OR OTHER",
      summary: "The Panoramic Moonroof suddenly is stuck in the vented position.",
      products: [
        {
          type: "Vehicle",
          productYear: "2020",
          productMake: "TOYOTA",
          productModel: "CAMRY",
          manufacturer: "Toyota Motor Corporation",
        },
      ],
    },
    {
      odiNumber: 11500001,
      crash: true,
      fire: false,
      // Multi-component: comma WITHOUT space separates components; the
      // comma-space inside "FUEL SYSTEM, GASOLINE" is part of the name.
      components: "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP,ELECTRICAL SYSTEM",
      summary: "Engine stalled at highway speed; vehicle struck the median.",
      miles: 45210,
    },
    {
      odiNumber: 11500002,
      crash: false,
      fire: true,
      components: "FUEL SYSTEM, GASOLINE",
      summary: "Fuel smell followed by an engine-bay fire.",
      miles: 112000,
    },
    {
      odiNumber: 11500003,
      crash: false,
      fire: false,
      components: "FUEL SYSTEM, GASOLINE:STORAGE:TANK ASSEMBLY",
      summary: "Fuel gauge misreads after a cold start.",
      miles: 12000,
    },
    {
      odiNumber: 11500004,
      crash: "Yes", // legacy flat-file style flag — still counted
      fire: false,
      components: "ELECTRICAL SYSTEM",
      summary: "Total electrical shutdown while driving.",
      // no miles → unknown band
    },
    // Non-object garbage — skipped entirely (not counted in complaint_total).
    null,
  ],
};

// ─── normalizeComponentName ──────────────────────────────────────────────

describe("normalizeComponentName", () => {
  it("keeps only the top-level component group (before the first colon)", () => {
    expect(normalizeComponentName("FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP")).toBe(
      "FUEL SYSTEM, GASOLINE",
    );
    expect(normalizeComponentName("SERVICE BRAKES, HYDRAULIC:FOUNDATION COMPONENTS")).toBe(
      "SERVICE BRAKES, HYDRAULIC",
    );
  });

  it("uppercases, collapses whitespace, and trims stray commas", () => {
    expect(normalizeComponentName("  electrical   system  ")).toBe("ELECTRICAL SYSTEM");
    expect(normalizeComponentName("Air Bags, ")).toBe("AIR BAGS");
  });

  it("fails open to UNKNOWN on empty/absent input", () => {
    expect(normalizeComponentName("")).toBe("UNKNOWN");
    expect(normalizeComponentName("   ")).toBe("UNKNOWN");
    expect(normalizeComponentName(null)).toBe("UNKNOWN");
    expect(normalizeComponentName(undefined)).toBe("UNKNOWN");
    expect(normalizeComponentName(":DELIVERY")).toBe("UNKNOWN");
  });
});

// ─── splitComplaintComponents ────────────────────────────────────────────

describe("splitComplaintComponents", () => {
  it("splits on comma-without-space but preserves comma-space inside names", () => {
    expect(
      splitComplaintComponents("FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP,ELECTRICAL SYSTEM"),
    ).toEqual(["FUEL SYSTEM, GASOLINE", "ELECTRICAL SYSTEM"]);
  });

  it("dedupes components that normalize to the same group", () => {
    expect(
      splitComplaintComponents("FUEL SYSTEM, GASOLINE:DELIVERY,FUEL SYSTEM, GASOLINE:STORAGE"),
    ).toEqual(["FUEL SYSTEM, GASOLINE"]);
  });

  it("fails open to UNKNOWN", () => {
    expect(splitComplaintComponents("")).toEqual(["UNKNOWN"]);
    expect(splitComplaintComponents(undefined)).toEqual(["UNKNOWN"]);
  });
});

// ─── parseRecallResponse ─────────────────────────────────────────────────

describe("parseRecallResponse", () => {
  it("parses the live response shape, skipping unusable and duplicate rows", () => {
    const recalls = parseRecallResponse(recallsFixture);
    expect(recalls).toHaveLength(2);

    expect(recalls[0]).toEqual({
      nhtsa_campaign_number: "20V682000",
      component: "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP",
      summary:
        "Toyota Motor Engineering & Manufacturing (Toyota) is recalling certain 2018-2020 Camry vehicles. The low-pressure fuel pump inside the fuel tank may fail.",
      consequence:
        "If the fuel pump fails, the engine can stall while driving, increasing the risk of a crash.",
      remedy:
        "Toyota will notify owners, and dealers will replace the fuel pump assembly with an improved one, free of charge.",
      report_received_date: "04/11/2020",
    });

    // Missing optional fields come through as null, missing Component as UNKNOWN.
    expect(recalls[1].nhtsa_campaign_number).toBe("21V056000");
    expect(recalls[1].consequence).toBeNull();
    expect(recalls[1].remedy).toBeNull();
  });

  it("defaults a missing Component to UNKNOWN and missing Summary to empty string", () => {
    const recalls = parseRecallResponse({
      results: [{ NHTSACampaignNumber: "22V000111" }],
    });
    expect(recalls).toEqual([
      {
        nhtsa_campaign_number: "22V000111",
        component: "UNKNOWN",
        summary: "",
        consequence: null,
        remedy: null,
        report_received_date: null,
      },
    ]);
  });

  it("fails open to [] on empty and malformed responses", () => {
    expect(parseRecallResponse({ Count: 0, Message: "ok", results: [] })).toEqual([]);
    expect(parseRecallResponse(null)).toEqual([]);
    expect(parseRecallResponse(undefined)).toEqual([]);
    expect(parseRecallResponse("not json-shaped")).toEqual([]);
    expect(parseRecallResponse({})).toEqual([]);
    expect(parseRecallResponse({ results: "nope" })).toEqual([]);
    expect(parseRecallResponse({ results: [null, 42, "x"] })).toEqual([]);
  });
});

// ─── parseComplaintResponse ──────────────────────────────────────────────

describe("parseComplaintResponse", () => {
  it("returns the results array from the live shape", () => {
    expect(parseComplaintResponse(complaintsFixture)).toHaveLength(6);
  });

  it("fails open to [] on malformed responses", () => {
    expect(parseComplaintResponse(null)).toEqual([]);
    expect(parseComplaintResponse({})).toEqual([]);
    expect(parseComplaintResponse({ results: 7 })).toEqual([]);
  });
});

// ─── summarizeComplaintsByComponent ──────────────────────────────────────

describe("summarizeComplaintsByComponent", () => {
  it("rolls up by normalized component with crash/fire and odometer bands", () => {
    const summary = summarizeComplaintsByComponent(complaintsFixture.results);

    // 5 object entries (null skipped) — complaint_total counts complaints,
    // not component hits.
    expect(summary.complaint_total).toBe(5);

    // FUEL SYSTEM, GASOLINE: complaints #2 (crash, 45210 mi), #3 (fire,
    // 112000 mi), #4 (12000 mi) → count 3.
    const fuel = summary.complaints_by_component.find(
      (c) => c.component === "FUEL SYSTEM, GASOLINE",
    );
    expect(fuel).toBeDefined();
    expect(fuel!.count).toBe(3);
    expect(fuel!.crash_count).toBe(1);
    expect(fuel!.fire_count).toBe(1);
    expect(fuel!.odometer_band_counts).toEqual({
      "0-30k": 1,
      "30k-60k": 1,
      "100k+": 1,
    });

    // ELECTRICAL SYSTEM: complaint #2 (crash=true boolean) and #5 (crash="Yes"
    // legacy flag) → both crashes counted.
    const electrical = summary.complaints_by_component.find(
      (c) => c.component === "ELECTRICAL SYSTEM",
    );
    expect(electrical!.count).toBe(2);
    expect(electrical!.crash_count).toBe(2);
    expect(electrical!.fire_count).toBe(0);
    expect(electrical!.odometer_band_counts).toEqual({ "30k-60k": 1, unknown: 1 });

    // UNKNOWN OR OTHER: complaint #1 only.
    const unknown = summary.complaints_by_component.find(
      (c) => c.component === "UNKNOWN OR OTHER",
    );
    expect(unknown!.count).toBe(1);
    expect(unknown!.odometer_band_counts).toEqual({ unknown: 1 });

    // Deterministic ordering: count desc, then name asc — and top_component
    // is the head of that ordering.
    expect(summary.complaints_by_component.map((c) => c.component)).toEqual([
      "FUEL SYSTEM, GASOLINE",
      "ELECTRICAL SYSTEM",
      "UNKNOWN OR OTHER",
    ]);
    expect(summary.top_component).toBe("FUEL SYSTEM, GASOLINE");
  });

  it("breaks count ties alphabetically for a stable top_component", () => {
    const summary = summarizeComplaintsByComponent([
      { crash: false, fire: false, components: "ENGINE" },
      { crash: false, fire: false, components: "AIR BAGS" },
    ]);
    expect(summary.complaints_by_component.map((c) => c.component)).toEqual([
      "AIR BAGS",
      "ENGINE",
    ]);
    expect(summary.top_component).toBe("AIR BAGS");
  });

  it("buckets complaints with missing components under UNKNOWN", () => {
    const summary = summarizeComplaintsByComponent([
      { crash: false, fire: true, summary: "no components field" },
    ]);
    expect(summary.complaint_total).toBe(1);
    expect(summary.complaints_by_component).toEqual([
      {
        component: "UNKNOWN",
        count: 1,
        crash_count: 0,
        fire_count: 1,
        odometer_band_counts: { unknown: 1 },
      },
    ]);
  });

  it("fails open to an empty summary on empty/malformed input", () => {
    for (const input of [[], [null, "junk", 42], "garbage" as unknown as unknown[]]) {
      const summary = summarizeComplaintsByComponent(input as unknown[]);
      expect(summary.complaint_total).toBe(0);
      expect(summary.complaints_by_component).toEqual([]);
      expect(summary.top_component).toBeNull();
    }
  });
});
