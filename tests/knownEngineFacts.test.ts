/**
 * Curated known-engine-facts override (Jun 10): the LLM misclassified the
 * EA211 as "chain" TWICE in one day (Jetta S, then the R-line's re-enrich
 * clobbered its unstamped value the same way). verified_fields protects an
 * existing engine row, but a FUTURE car of the same family creates a fresh
 * row and gets misclassified again — physical facts about an engine family
 * don't need an LLM vote.
 */
import { describe, test, expect } from "vitest";
import { applyKnownEngineFacts } from "../convex/vehicleEnrichment/applicabilityRules";

describe("applyKnownEngineFacts", () => {
  test("EA211: timing_system forced to belt over an LLM 'chain' extraction", () => {
    const fields: any = {
      timing_system: { value: "chain", source_type: "training_data", confidence: 0.8 },
    };
    applyKnownEngineFacts(fields, "EA211");
    expect(fields.timing_system.value).toBe("belt");
    expect(fields.timing_system.source_type).toBe("director_verified");
  });

  test("family prefix matches (EA211 variants), unknown engines untouched", () => {
    const fields: any = {
      timing_system: { value: "chain", source_type: "training_data", confidence: 0.8 },
    };
    applyKnownEngineFacts(fields, "EA211 1.5 TSI");
    expect(fields.timing_system.value).toBe("belt");

    const fields2: any = {
      timing_system: { value: "chain", source_type: "training_data", confidence: 0.8 },
    };
    applyKnownEngineFacts(fields2, "N63B44O2");
    expect(fields2.timing_system.value).toBe("chain"); // N63 IS chain — no change

    const fields3: any = {
      timing_system: { value: "chain", source_type: "training_data", confidence: 0.8 },
    };
    applyKnownEngineFacts(fields3, "SOMETHING_UNKNOWN");
    expect(fields3.timing_system.value).toBe("chain"); // untouched
  });

  test("missing field gets created from the known fact", () => {
    const fields: any = {};
    applyKnownEngineFacts(fields, "J30A4");
    expect(fields.timing_system.value).toBe("belt"); // Honda J-series V6 is belt
  });
});
