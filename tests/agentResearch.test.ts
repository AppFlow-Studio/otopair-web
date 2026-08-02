// =============================================================================
// Firecrawl /agent research tier
// =============================================================================
//
// The agent is the only source in this pipeline that CHOOSES ITS OWN SOURCES,
// so the claim boundary matters more here than anywhere else. The live probe
// (2026-08-02) answered a 2019 F-150 rotor-minimum question from
// r1concepts.com — an aftermarket rotor RETAILER — and returned the identical
// generic label "MIN TH" for both axles. Plausible, unknown authority.
//
// These tests pin the boundary: what becomes a claim, what is dropped before
// it can ever reach the reconciler, and that absence stays absence.
//
//   npx vitest run tests/agentResearch.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  buildRotorPrompt,
  buildRolePrompt,
  rotorSchema,
  roleSchema,
  rotorClaimsFrom,
  roleClaimFrom,
  isAgentEnabled,
  agentMaxCredits,
  agentTaskBudget,
} from "../convex/vehicleEnrichment/agentResearch";

const F150 = { year: 2019, make: "Ford", model: "F-150", trim: "XL", displacement: "5.0" };

describe("kill switch and budgets", () => {
  it("is OFF unless explicitly enabled — costs nothing by default", () => {
    expect(isAgentEnabled({})).toBe(false);
    expect(isAgentEnabled({ ENRICHMENT_AGENT: "off" })).toBe(false);
    expect(isAgentEnabled({ ENRICHMENT_AGENT: "1" })).toBe(false);
    expect(isAgentEnabled({ ENRICHMENT_AGENT: "on" })).toBe(true);
  });

  it("defaults maxCredits well under the API's 2500, and honours an override", () => {
    // Measured: 300 fails ("Agent reached max credits"), 1500 completes.
    expect(agentMaxCredits({})).toBe(1500);
    expect(agentMaxCredits({ ENRICHMENT_AGENT_MAX_CREDITS: "800" })).toBe(800);
    // Garbage must not silently become the API's loose default.
    expect(agentMaxCredits({ ENRICHMENT_AGENT_MAX_CREDITS: "abc" })).toBe(1500);
    expect(agentMaxCredits({ ENRICHMENT_AGENT_MAX_CREDITS: "-5" })).toBe(1500);
  });

  it("caps tasks per run so a loop cannot drain the plan", () => {
    expect(agentTaskBudget({})).toBe(3);
    expect(agentTaskBudget({ ENRICHMENT_AGENT_MAX_TASKS: "0" })).toBe(0);
  });
});

describe("prompts encode the rules the pipeline enforces downstream", () => {
  const p = buildRotorPrompt(F150);

  it("names the vehicle it is asking about", () => {
    expect(p).toContain("2019 Ford F-150 XL 5.0L");
  });

  it("distinguishes all three rotor numbers, which are never interchangeable", () => {
    expect(p).toMatch(/discard minimum/i);
    expect(p).toMatch(/NOT the new\/nominal/i);
    expect(p).toMatch(/NOT the machine-to/i);
    expect(p).toMatch(/DIAMETER/);
  });

  it("demands a verbatim label and forbids deriving a minimum", () => {
    expect(p).toMatch(/verbatim/i);
    expect(p).toMatch(/Never derive/i);
  });

  it("tells it that omitting an axle is a CORRECT answer", () => {
    expect(p).toMatch(/omit that axle/i);
    expect(p).toMatch(/omission is a correct answer/i);
  });

  it("passes rejected numbers into the role prompt so they are not re-found", () => {
    const rp = buildRolePrompt(F150, "front_brake_pad", ["ABC123", "DEF456"]);
    expect(rp).toContain("ABC123");
    expect(rp).toMatch(/do NOT return/i);
    expect(rp).toMatch(/gap is a correct answer/i);
  });
});

describe("schemas require provenance", () => {
  it("makes source_url REQUIRED — the docs do not promise it", () => {
    expect(rotorSchema().properties.axles.items.required).toContain("source_url");
    expect(roleSchema().required).toContain("source_url");
  });

  it("requires the verbatim label on every rotor row", () => {
    expect(rotorSchema().properties.axles.items.required).toContain("observed_label");
  });
});

describe("rotorClaimsFrom — the claim boundary", () => {
  const ok = {
    axles: [
      { axle: "front", min_mm: 32, observed_label: "MIN TH", source_url: "https://x/y" },
      { axle: "rear", min_mm: 20, observed_label: "Minimum Thickness", source_url: "https://x/z" },
    ],
  };

  it("converts well-formed rows into claims on the right field keys", () => {
    const c = rotorClaimsFrom(ok, 1000);
    expect(c.map((x) => x.field_key)).toEqual([
      "rotor_front_min_thickness_mm",
      "rotor_rear_min_thickness_mm",
    ]);
    expect(c[0].value).toBe("32");
    expect(c[0].observed_label).toBe("MIN TH");
    expect(c[0].source_url).toBe("https://x/y");
  });

  it("marks them agent_research, never llm_extraction", () => {
    // The audit must be able to tell "a model read a page we chose" from
    // "a model chose where to look".
    expect(rotorClaimsFrom(ok, 1)[0].method).toBe("agent_research");
  });

  it("DROPS a minimum with no verbatim label — unlabelled is unusable", () => {
    expect(rotorClaimsFrom(
      { axles: [{ axle: "front", min_mm: 32, observed_label: "  ", source_url: "https://x" }] }, 1,
    )).toHaveLength(0);
  });

  it("DROPS a minimum with no source_url — a claim without provenance is unauditable", () => {
    expect(rotorClaimsFrom(
      { axles: [{ axle: "front", min_mm: 32, observed_label: "MIN TH" }] }, 1,
    )).toHaveLength(0);
  });

  it("DROPS physically impossible thicknesses (a diameter misread as a thickness)", () => {
    const c = rotorClaimsFrom({
      axles: [
        { axle: "front", min_mm: 350, observed_label: "MIN TH", source_url: "https://x" },
        { axle: "rear", min_mm: 0.5, observed_label: "MIN TH", source_url: "https://x" },
      ],
    }, 1);
    expect(c).toHaveLength(0);
  });

  it("ignores an unknown axle rather than inventing one", () => {
    expect(rotorClaimsFrom(
      { axles: [{ axle: "middle", min_mm: 30, observed_label: "MIN", source_url: "https://x" }] }, 1,
    )).toHaveLength(0);
  });

  it("returns nothing for empty/garbage bodies instead of throwing", () => {
    expect(rotorClaimsFrom(null, 1)).toEqual([]);
    expect(rotorClaimsFrom({}, 1)).toEqual([]);
    expect(rotorClaimsFrom({ axles: [null, 7, {}] } as any, 1)).toEqual([]);
  });
});

describe("roleClaimFrom — the claim boundary", () => {
  const blocked = new Set(["ABC123"]);

  it("builds a claim carrying the observed title as evidence", () => {
    const c = roleClaimFrom(
      { oem_part_number: "FL-500S", observed_title: "Motorcraft Oil Filter", source_url: "https://x" },
      "oil_filter_oem", blocked, 5,
    );
    expect(c?.value).toBe("FL-500S");
    expect(c?.observed_label).toBe("Motorcraft Oil Filter");
    expect(c?.method).toBe("agent_research");
  });

  it("REFUSES a number already rejected for this vehicle", () => {
    // A blocklisted number that dominates the open web is exactly what a
    // research agent re-finds, so the prompt asking nicely is not enough.
    expect(roleClaimFrom(
      { oem_part_number: "abc-123", observed_title: "t", source_url: "https://x" },
      "oil_filter_oem", blocked, 5,
    )).toBeNull();
  });

  it("refuses a part with no number or no provenance", () => {
    expect(roleClaimFrom({ observed_title: "t", source_url: "https://x" }, "k", blocked, 1)).toBeNull();
    expect(roleClaimFrom({ oem_part_number: "X1" }, "k", blocked, 1)).toBeNull();
    expect(roleClaimFrom(null, "k", blocked, 1)).toBeNull();
  });
});
