/**
 * Batch-2 prompt contract tests — fix for the fresh-enrichment pricing hole
 * found Jun 10 2026 (2018 Civic live test):
 *
 * Batch 2's pricing job was scoped to "OEM part numbers Batch 1 found". On a
 * FRESH car whose registry source is down, Batch 1 finds no part numbers, so
 * Batch 2 discovers all the parts itself (*_oem fields, with citations) but
 * never prices them — parts_breakdown comes back empty and the car ends up
 * fully discovered and fully unpriced (every quote line $0/price_unknown).
 * The contract must require pricing SELF-DISCOVERED parts too.
 */
import { describe, expect, it } from "vitest";
import {
  BATCH_2_SYSTEM,
  buildBatch2Prompt,
} from "../convex/vehicleEnrichment/prompts/batch2Prompt";

const VEHICLE = {
  year: 2018,
  make: "Honda",
  model: "Civic",
  trim: "LX",
  engineCode: "K20C2",
  displacement: "2.0",
} as any;

describe("BATCH_2_SYSTEM — pricing covers self-discovered parts", () => {
  it("requires a parts_breakdown entry for part numbers the model itself reports", () => {
    expect(BATCH_2_SYSTEM).toMatch(/part number[s]? you (yourself )?(report|discover|find)/i);
  });

  it("keeps the discount-trap hardening (never MSRP / was / struck / You Save)", () => {
    expect(BATCH_2_SYSTEM).toMatch(/NEVER the MSRP/i);
    expect(BATCH_2_SYSTEM).toMatch(/You Save/);
  });
});

describe("buildBatch2Prompt — fresh-car (no Batch-1 parts) case", () => {
  it("instructs pricing the discovered parts instead of dead-ending on an empty list", () => {
    const prompt = buildBatch2Prompt(VEHICLE, [], {});
    expect(prompt).toMatch(/price (every|each) (\*_oem )?part (number )?you (report|discover|find)/i);
  });

  it("still lists provided part numbers when Batch 1 found them", () => {
    const prompt = buildBatch2Prompt(VEHICLE, [], { oil_filter_oem: "15400-PLM-A02" });
    expect(prompt).toContain("15400-PLM-A02");
  });
});
