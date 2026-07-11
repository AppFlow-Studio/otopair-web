/**
 * Unit tests for the authoritative capacity resolver (capacityResolver.ts) and
 * the high-authority classifier. These cover the pure decision logic that turns
 * gathered observations into a trusted / best-effort / none verdict — the guard
 * against a wrong coolant capacity (16.9 qt) reaching a booking customer.
 */
import { describe, expect, test } from "vitest";
import {
  decideCapacity,
  buildCapacityQueries,
  type CapacityObservation,
} from "../convex/vehicleEnrichment/capacityResolver";
import { getCapacityBand } from "../convex/vehicleEnrichment/validation/sanityChecks";
import { isHighAuthorityDomain } from "../convex/vehicleEnrichment/validation/sourceAuthority";
import type { VehicleInput } from "../convex/vehicleEnrichment/types";

const V8_COOLANT = getCapacityBand("coolant_capacity_qts", 8);

function obs(p: Partial<CapacityObservation> & { value_qts: number; domain: string }): CapacityObservation {
  return {
    source_url: `https://${p.domain}/spec`,
    authoritative: false,
    engine_code_matches: true,
    ...p,
  };
}

describe("isHighAuthorityDomain", () => {
  test.each([
    "https://www.alldata.com/…",
    "alldata.com",
    "https://mitchell1.com/x",
    "https://gm-techlink.com/pdf",
    "https://carcarekiosk.com/video",
  ])("accepts authoritative %j", (u) => expect(isHighAuthorityDomain(u)).toBe(true));

  test.each([
    "https://www.silveradosierra.com/threads/x", // forum
    "https://gmpartsdirect.com/oem",              // parts catalog, not a spec authority
    null,
    undefined,
  ])("rejects non-authoritative %j", (u) => expect(isHighAuthorityDomain(u as any)).toBe(false));
});

describe("buildCapacityQueries", () => {
  const v: VehicleInput = {
    vehicleId: "x" as any, year: 2023, make: "GMC", model: "Sierra 1500",
    trim: "SLT", engineCode: "L84", displacement: "5.3",
  };
  test("pins the engine code and covers quarts + liters", () => {
    const qs = buildCapacityQueries(v, "coolant_capacity_qts");
    expect(qs.some((q) => q.includes("L84"))).toBe(true);
    expect(qs.some((q) => /liters/i.test(q))).toBe(true);
    expect(qs.some((q) => /alldata\.com/.test(q))).toBe(true);
  });
});

describe("decideCapacity", () => {
  test("single authoritative source → trusted", () => {
    const d = decideCapacity("coolant_capacity_qts",
      [obs({ value_qts: 13.8, domain: "alldata.com", authoritative: true })],
      V8_COOLANT, { strict: false });
    expect(d.tier).toBe("trusted");
    expect(d.value_qts).toBeCloseTo(13.8, 1);
    expect(d.authoritative).toBe(true);
  });

  test("two independent non-authoritative sources agree → trusted", () => {
    const d = decideCapacity("coolant_capacity_qts", [
      obs({ value_qts: 13.7, domain: "site-a.com" }),
      obs({ value_qts: 13.9, domain: "site-b.com" }),
    ], V8_COOLANT, { strict: false });
    expect(d.tier).toBe("trusted");
    expect(d.source_count).toBe(2);
    expect(d.value_qts).toBeGreaterThanOrEqual(13.7);
    expect(d.value_qts).toBeLessThanOrEqual(13.9);
  });

  test("single non-authoritative source → best_effort (flagged, low confidence)", () => {
    const d = decideCapacity("coolant_capacity_qts",
      [obs({ value_qts: 14.0, domain: "randomblog.com" })],
      V8_COOLANT, { strict: false });
    expect(d.tier).toBe("best_effort");
    expect(d.value_qts).toBe(14);
    expect(d.confidence).toBeLessThan(0.6);
  });

  test("single non-authoritative source in STRICT mode → none", () => {
    const d = decideCapacity("coolant_capacity_qts",
      [obs({ value_qts: 14.0, domain: "randomblog.com" })],
      V8_COOLANT, { strict: true });
    expect(d.tier).toBe("none");
    expect(d.value_qts).toBeNull();
  });

  test("no observations → none", () => {
    const d = decideCapacity("coolant_capacity_qts", [], V8_COOLANT, { strict: false });
    expect(d.tier).toBe("none");
    expect(d.value_qts).toBeNull();
  });

  test("lone AUTHORITATIVE but implausible (out-of-typical-band) value → best_effort, not trusted", () => {
    // The live 7.6-qt failure: gm-techlink is authoritative, but 7.6 is out of the
    // V8 typical band (10-16) — a single authoritative outlier must not be trusted.
    const d = decideCapacity("coolant_capacity_qts",
      [obs({ value_qts: 7.6, domain: "gm-techlink.com", authoritative: true })],
      V8_COOLANT, { strict: false });
    expect(d.tier).toBe("best_effort");
    expect(d.authoritative).toBe(false);
  });

  test("prefers a plausible within-band value over an authoritative out-of-band one", () => {
    const d = decideCapacity("coolant_capacity_qts", [
      obs({ value_qts: 7.6, domain: "gm-techlink.com", authoritative: true }), // implausible
      obs({ value_qts: 13.8, domain: "alldata.com", authoritative: true }),    // plausible
    ], V8_COOLANT, { strict: false });
    expect(d.tier).toBe("trusted");
    expect(d.value_qts).toBeCloseTo(13.8, 1);
  });

  test("atypical value CORROBORATED by 2+ domains → trusted (legit HD/diesel)", () => {
    const d = decideCapacity("coolant_capacity_qts", [
      obs({ value_qts: 20, domain: "alldata.com", authoritative: true }),
      obs({ value_qts: 20.2, domain: "carcarekiosk.com", authoritative: true }),
    ], V8_COOLANT, { strict: false });
    expect(d.tier).toBe("trusted");
    expect(d.value_qts).toBeGreaterThan(18);
  });

  test("prefers the authoritative cluster over a larger non-authoritative one", () => {
    const d = decideCapacity("coolant_capacity_qts", [
      obs({ value_qts: 16.9, domain: "blog1.com" }),
      obs({ value_qts: 16.9, domain: "blog2.com" }),   // 2 blogs say 16.9
      obs({ value_qts: 13.8, domain: "alldata.com", authoritative: true }), // OEM-grade says 13.8
    ], V8_COOLANT, { strict: false });
    expect(d.tier).toBe("trusted");
    expect(d.authoritative).toBe(true);
    expect(d.value_qts).toBeCloseTo(13.8, 1);
  });
});

// ── Corroboration mode (A4 9.5 qt incident) ─────────────────────────────
// The batch value is seeded as ONE observation; decideCapacity arbitrates.
describe("decideCapacity — seeded batch-value arbitration", () => {
  const I4_COOLANT = getCapacityBand("coolant_capacity_qts", 4);

  test("wrong in-band batch value (9.5, one mid-tier blog) is outranked by two agreeing web domains at 7.4", () => {
    const d = decideCapacity(
      "coolant_capacity_qts",
      [
        obs({ value_qts: 9.5, domain: "ricksfreeautorepairadvice.com", engine_code_matches: false }),
        obs({ value_qts: 7.4, domain: "carcarekiosk.com", authoritative: true }),
        obs({ value_qts: 7.4, domain: "fluidcapacity.com", authoritative: true }),
      ],
      I4_COOLANT,
      { strict: false },
    );
    expect(d.tier).toBe("trusted");
    expect(d.value_qts).toBe(7.4);
  });

  test("correct batch value + one agreeing independent domain → trusted at 2 domains", () => {
    const d = decideCapacity(
      "coolant_capacity_qts",
      [
        obs({ value_qts: 7.4, domain: "some-blog.com", engine_code_matches: false }),
        obs({ value_qts: 7.5, domain: "carcarekiosk.com" }), // within 0.5qt tolerance
      ],
      I4_COOLANT,
      { strict: false },
    );
    expect(d.tier).toBe("trusted");
    expect(d.source_count).toBe(2);
    // cluster median of [7.4, 7.5] — the two agree within tolerance
    expect(d.value_qts).toBe(7.5);
  });

  test("batch value alone with no web agreement stays best_effort (flagged unverified)", () => {
    const d = decideCapacity(
      "coolant_capacity_qts",
      [obs({ value_qts: 9.5, domain: "ricksfreeautorepairadvice.com", engine_code_matches: false })],
      I4_COOLANT,
      { strict: false },
    );
    expect(d.tier).toBe("best_effort");
    expect(d.confidence).toBe(0.5);
  });
});

// ── Stress-fleet findings (2026-07-11) ──────────────────────────────────
describe("getCapacityBand — diesel awareness (F-350 finding)", () => {
  test("HD diesel V8 coolant band admits 29-36 qt totals", () => {
    const band = getCapacityBand("coolant_capacity_qts", 8, { diesel: true });
    expect(band.rejectMax).toBeGreaterThanOrEqual(36.5);
    // the 2020 F-350 6.7L truth (31.7-35.1 qt) must be in-band
    expect(31.7).toBeGreaterThanOrEqual(band.rejectMin);
    expect(35.1).toBeLessThanOrEqual(band.rejectMax);
  });

  test("gasoline bands unchanged (no diesel ctx)", () => {
    const band = getCapacityBand("coolant_capacity_qts", 8);
    expect(band.rejectMax).toBe(24);
    const band4 = getCapacityBand("coolant_capacity_qts", 4, {});
    expect(band4.typicalMax).toBe(11);
  });

  test("diesel oil band admits 13 qt (F-350) without loosening gasoline", () => {
    const d = getCapacityBand("oil_capacity_qts", 8, { diesel: true });
    expect(13).toBeLessThanOrEqual(d.typicalMax);
    const g = getCapacityBand("oil_capacity_qts", 8);
    expect(g.rejectMax).toBe(20);
  });
});

describe("decideCapacity — domain-count outranks typicality (Silverado L84 finding)", () => {
  const V8 = getCapacityBand("coolant_capacity_qts", 8);

  test("two agreeing domains at 17.4/17.6 beat a lone in-typical 13.8", () => {
    const d = decideCapacity(
      "coolant_capacity_qts",
      [
        obs({ value_qts: 13.8, domain: "lone-blog.com" }), // typical (10-16) but single-domain
        obs({ value_qts: 17.4, domain: "alloemmanuals.com" }), // atypical (>16) but corroborated
        obs({ value_qts: 17.6, domain: "chevytalk.org" }),
      ],
      V8,
      { strict: false },
    );
    expect(d.tier).toBe("trusted");
    expect(d.value_qts).toBeGreaterThanOrEqual(17.4);
    expect(d.source_count).toBe(2);
  });

  test("7.6-qt regression: lone authoritative outlier still loses to a multi-domain typical cluster", () => {
    const d = decideCapacity(
      "coolant_capacity_qts",
      [
        obs({ value_qts: 7.6, domain: "gm-techlink.com", authoritative: true }),
        obs({ value_qts: 13.1, domain: "carcarekiosk.com" }),
        obs({ value_qts: 13.4, domain: "fluidcapacity.com" }),
      ],
      V8,
      { strict: false },
    );
    expect(d.value_qts).toBeGreaterThanOrEqual(13);
  });

  test("equal domain counts: typical cluster still preferred over lone atypical authority", () => {
    const d = decideCapacity(
      "coolant_capacity_qts",
      [
        obs({ value_qts: 7.6, domain: "gm-techlink.com", authoritative: true }),
        obs({ value_qts: 13.1, domain: "carcarekiosk.com" }),
      ],
      V8,
      { strict: false },
    );
    expect(d.value_qts).toBe(13.1);
  });
});
