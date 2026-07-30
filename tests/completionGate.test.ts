/**
 * completionGate — terminal enrichment_status requires BOTH fill and
 * quotability legs. Regression anchor: 2001 BMW 740iA finalized at fill 72% /
 * quotability 0.42 with 18 price gaps and was marked "complete".
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  computeEnrichmentStatus,
  explainGateDecision,
} from "../convex/vehicleEnrichment/completionGate";

afterEach(() => {
  delete process.env.ENRICHMENT_COMPLETE_FILL_MIN;
  delete process.env.ENRICHMENT_COMPLETE_QUOTABILITY_MIN;
  delete process.env.ENRICHMENT_AXLE_GATE;
  delete process.env.ENRICHMENT_CORE_ROLE_GATE;
  delete process.env.ENRICHMENT_INTERVAL_PROVENANCE_GATE;
  delete process.env.ENRICHMENT_INTERVAL_PROVENANCE_MAX;
});

describe("computeEnrichmentStatus", () => {
  it("BMW 740iA post-mortem: fill 72 + quotability 0.42 → partial", () => {
    expect(
      computeEnrichmentStatus({ fillRate: 72, quotabilityPct: 0.42, hasPriceGaps: true }),
    ).toBe("partial");
  });

  it("both legs passing → complete", () => {
    expect(
      computeEnrichmentStatus({ fillRate: 80, quotabilityPct: 0.85, hasPriceGaps: false }),
    ).toBe("complete");
  });

  it("high quotability cannot rescue low fill", () => {
    expect(
      computeEnrichmentStatus({ fillRate: 50, quotabilityPct: 1.0 }),
    ).toBe("partial");
  });

  it("boundary values pass (>= semantics on both legs)", () => {
    expect(
      computeEnrichmentStatus({ fillRate: 70, quotabilityPct: 0.8 }),
    ).toBe("complete");
    expect(
      computeEnrichmentStatus({ fillRate: 69.9, quotabilityPct: 0.8 }),
    ).toBe("partial");
    expect(
      computeEnrichmentStatus({ fillRate: 70, quotabilityPct: 0.79 }),
    ).toBe("partial");
  });

  it("undefined quotability fails the leg only when price gaps exist", () => {
    expect(
      computeEnrichmentStatus({ fillRate: 90, quotabilityPct: undefined, hasPriceGaps: true }),
    ).toBe("partial");
    expect(
      computeEnrichmentStatus({ fillRate: 90, quotabilityPct: null, hasPriceGaps: false }),
    ).toBe("complete");
    // hasPriceGaps omitted behaves as "no known price gaps"
    expect(
      computeEnrichmentStatus({ fillRate: 90, quotabilityPct: undefined }),
    ).toBe("complete");
  });

  it("thresholds are env-tunable", () => {
    process.env.ENRICHMENT_COMPLETE_QUOTABILITY_MIN = "0.4";
    expect(
      computeEnrichmentStatus({ fillRate: 72, quotabilityPct: 0.42 }),
    ).toBe("complete");
    process.env.ENRICHMENT_COMPLETE_FILL_MIN = "80";
    expect(
      computeEnrichmentStatus({ fillRate: 72, quotabilityPct: 0.42 }),
    ).toBe("partial");
  });

  it("garbage env values fall back to defaults", () => {
    process.env.ENRICHMENT_COMPLETE_FILL_MIN = "not-a-number";
    expect(
      computeEnrichmentStatus({ fillRate: 70, quotabilityPct: 0.8 }),
    ).toBe("complete");
  });
});

describe("round-12 role gates — staged enforcement", () => {
  // The Crosstrek shape: healthy fill + quotability ≥ 0.8, but the front
  // brake axle is empty. The legacy gate said "complete".
  const crosstrek = {
    fillRate: 88,
    quotabilityPct: 0.82,
    axlePairGaps: [
      "brake_pad_replacement:front_brake_pad",
      "rotor_replacement:front_rotor",
    ],
    missingCoreRoles: [
      "brake_pad_replacement:front_brake_pad",
      "rotor_replacement:front_rotor",
      "rotor_replacement:front_brake_pad",
    ],
  };

  it("default stage is log — status semantics unchanged (dark launch)", () => {
    expect(computeEnrichmentStatus(crosstrek)).toBe("complete");
  });

  it("ENRICHMENT_AXLE_GATE=enforce fails a half-covered axle to partial", () => {
    process.env.ENRICHMENT_AXLE_GATE = "enforce";
    expect(computeEnrichmentStatus(crosstrek)).toBe("partial");
    expect(
      computeEnrichmentStatus({ ...crosstrek, axlePairGaps: [] }),
    ).toBe("complete"); // core-role gate still at log
  });

  it("ENRICHMENT_CORE_ROLE_GATE=enforce fails any missing binding core role", () => {
    process.env.ENRICHMENT_CORE_ROLE_GATE = "enforce";
    expect(computeEnrichmentStatus(crosstrek)).toBe("partial");
    expect(
      computeEnrichmentStatus({
        fillRate: 88,
        quotabilityPct: 0.82,
        missingCoreRoles: ["battery_replacement:battery"],
      }),
    ).toBe("partial");
    expect(
      computeEnrichmentStatus({ ...crosstrek, missingCoreRoles: [], axlePairGaps: [] }),
    ).toBe("complete");
  });

  it("stage off ignores gaps entirely; garbage stage values behave as log", () => {
    process.env.ENRICHMENT_AXLE_GATE = "off";
    process.env.ENRICHMENT_CORE_ROLE_GATE = "off";
    expect(computeEnrichmentStatus(crosstrek)).toBe("complete");
    process.env.ENRICHMENT_AXLE_GATE = "banana";
    expect(computeEnrichmentStatus(crosstrek)).toBe("complete"); // log, not enforce
  });

  it("undefined gap arrays never trip enforcement (paths that don't compute them)", () => {
    process.env.ENRICHMENT_AXLE_GATE = "enforce";
    process.env.ENRICHMENT_CORE_ROLE_GATE = "enforce";
    expect(
      computeEnrichmentStatus({ fillRate: 90, quotabilityPct: 0.9 }),
    ).toBe("complete");
  });
});

describe("explainGateDecision", () => {
  it("names the failing leg", () => {
    const s = explainGateDecision({ fillRate: 72, quotabilityPct: 0.42 });
    expect(s).toContain("fill=72% (min 70) PASS");
    expect(s).toContain("quotability=0.42 (min 0.8) FAIL");
  });

  it("shows role-gate legs with stage and named roles (log stage = LOG-ONLY)", () => {
    const s = explainGateDecision({
      fillRate: 88,
      quotabilityPct: 0.82,
      axlePairGaps: ["brake_pad_replacement:front_brake_pad"],
      missingCoreRoles: ["brake_pad_replacement:front_brake_pad"],
    });
    expect(s).toContain("axle_gaps=1 [brake_pad_replacement:front_brake_pad] (stage log) LOG-ONLY");
    expect(s).toContain("core_roles_missing=1");
  });

  it("enforce stage marks a populated leg FAIL; off stage omits the leg", () => {
    process.env.ENRICHMENT_AXLE_GATE = "enforce";
    process.env.ENRICHMENT_CORE_ROLE_GATE = "off";
    const s = explainGateDecision({
      fillRate: 88,
      quotabilityPct: 0.82,
      axlePairGaps: ["rotor_replacement:front_rotor"],
      missingCoreRoles: ["rotor_replacement:front_rotor"],
    });
    expect(s).toContain("axle_gaps=1 [rotor_replacement:front_rotor] (stage enforce) FAIL");
    expect(s).not.toContain("core_roles_missing");
  });
});

// ─── Round 13: interval-provenance floor ───────────────────────────────────
//
// The 2020 Yaris canary carried 11 of 27 intervals resting on nothing better
// than the industry default table, and nothing surfaced it: the fill metric
// counts a fallback row as filled. This leg makes the proportion visible.
//
// It ships in log mode ON PURPOSE. Enforcing it at finalize would fail
// essentially every fresh config by construction — the only high-provenance
// interval source is the manual extraction, which is a scheduled follow-up
// arriving minutes later, and bookings.ts books parts services only on status
// exactly "complete".
describe("interval-provenance floor", () => {
  const base = { fillRate: 90, quotabilityPct: 0.9, hasPriceGaps: false };
  const gaps = ["oil_change:interval", "coolant_flush:months"];

  it("does NOT change status by default — the canary shape stays complete", () => {
    expect(
      computeEnrichmentStatus({ ...base, intervalProvenanceGaps: gaps }),
    ).toBe("complete");
  });

  it("still does not change status when explicitly staged to log", () => {
    process.env.ENRICHMENT_INTERVAL_PROVENANCE_GATE = "log";
    expect(
      computeEnrichmentStatus({ ...base, intervalProvenanceGaps: gaps }),
    ).toBe("complete");
  });

  it("fails the run only on an explicit enforce", () => {
    process.env.ENRICHMENT_INTERVAL_PROVENANCE_GATE = "enforce";
    expect(
      computeEnrichmentStatus({ ...base, intervalProvenanceGaps: gaps }),
    ).toBe("partial");
  });

  it("enforce respects the tolerance knob", () => {
    process.env.ENRICHMENT_INTERVAL_PROVENANCE_GATE = "enforce";
    process.env.ENRICHMENT_INTERVAL_PROVENANCE_MAX = "5";
    expect(
      computeEnrichmentStatus({ ...base, intervalProvenanceGaps: gaps }),
    ).toBe("complete");
  });

  it("an undefined leg never trips enforcement (paths that don't compute it)", () => {
    process.env.ENRICHMENT_INTERVAL_PROVENANCE_GATE = "enforce";
    expect(computeEnrichmentStatus(base)).toBe("complete");
  });

  it("explains the leg with a count, the named gaps and the stage", () => {
    const s = explainGateDecision({ ...base, intervalProvenanceGaps: gaps });
    expect(s).toContain("interval_provenance_gaps=2");
    expect(s).toContain("oil_change:interval");
    expect(s).toContain("(stage log) LOG-ONLY");
  });

  it("a clean config reports the leg as PASS, not as absent", () => {
    const s = explainGateDecision({ ...base, intervalProvenanceGaps: [] });
    expect(s).toContain("interval_provenance_gaps=0");
    expect(s).toContain("PASS");
  });

  it("off stage omits the leg entirely", () => {
    process.env.ENRICHMENT_INTERVAL_PROVENANCE_GATE = "off";
    const s = explainGateDecision({ ...base, intervalProvenanceGaps: gaps });
    expect(s).not.toContain("interval_provenance_gaps");
  });
});
