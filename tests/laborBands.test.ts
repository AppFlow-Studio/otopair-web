// tests/laborBands.test.ts
import { describe, it, expect } from "vitest";
import {
  GUARDRAIL_BAND_HOURS,
  AGREEMENT_BAND_MIN_HOURS,
  AGREEMENT_BAND_PCT,
  STRONG_LABOR_SOURCES,
  withinGuardrail,
  withinAgreementBand,
} from "../convex/lib/laborBands";

describe("laborBands", () => {
  it("exposes the agreed constants (15 min guardrail, max(15min,10%) agreement)", () => {
    expect(GUARDRAIL_BAND_HOURS).toBe(0.25);
    expect(AGREEMENT_BAND_MIN_HOURS).toBe(0.25);
    expect(AGREEMENT_BAND_PCT).toBe(0.1);
  });

  it("withinGuardrail is a flat 15-minute (0.25h) band", () => {
    expect(withinGuardrail(1.0, 1.24)).toBe(true); // 14.4 min
    expect(withinGuardrail(1.0, 1.26)).toBe(false); // 15.6 min
  });

  it("withinAgreementBand floors at 15 min but widens to 10% on long jobs", () => {
    // short job: 10% of 1.0h = 6min < 15min floor → 15min band applies
    expect(withinAgreementBand(1.0, 1.2)).toBe(true); // 12 min ≤ 15
    expect(withinAgreementBand(1.0, 1.3)).toBe(false); // 18 min > 15
    // long job: band widens to 10% of the larger value
    expect(withinAgreementBand(4.5, 4.9)).toBe(true); // 24 min ≤ ~29 min band
    expect(withinAgreementBand(4.5, 5.1)).toBe(false); // 36 min > ~31 min band
  });

  it("classifies the strong web/portal sources, not VDB/LLM/legacy", () => {
    expect(STRONG_LABOR_SOURCES.has("olp_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("web_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("oem_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("repairpal_labor")).toBe(false); // corroborator, not strong
    expect(STRONG_LABOR_SOURCES.has("vdb_repair_estimates")).toBe(false);
    expect(STRONG_LABOR_SOURCES.has("repairpal_motor")).toBe(false);
  });
});
