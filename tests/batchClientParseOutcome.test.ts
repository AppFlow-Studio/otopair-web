/**
 * getBatchResults' parse-outcome classification.
 *
 * Regression anchor: 2020 Toyota Yaris canary (VIN 3MYDLBJV2LY704792, Jul 30
 * 2026). Batch 2 returned a body that produced no parsed object. The old code
 * hardcoded `error: null` on every SUCCEEDED request, so:
 *
 *   - v3pipeline's `if (r2?.error)` branch never fired,
 *   - the batch2 step trace recorded status "ok",
 *   - `services[]` was silently empty,
 *
 * and that one empty array starved labor (27/27 default_fallback), quotability
 * (`{pct: 1, services: []}` — a vacuous PASS) and role applicability
 * (`applicable_services_unknown`) at once. The config finalized "complete" at
 * fill 83 with no error recorded anywhere.
 *
 * The rule this file freezes: a request the API succeeded on whose body we
 * could not read is OUR failure and must be reported as one — while a
 * genuinely empty response stays a non-error, so trivial payloads are not
 * turned into false alarms.
 */
import { describe, it, expect } from "vitest";
import {
  classifyParseOutcome,
  EMPTY_PARSE_RAWTEXT_FLOOR,
} from "../convex/vehicleEnrichment/utils/batchClient";

describe("classifyParseOutcome", () => {
  it("a healthy parse is not an error", () => {
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 12,
        rawTextLength: 8000,
      }),
    ).toBeNull();
  });

  it("a thrown extraction is always an error, whatever the body length", () => {
    const err = classifyParseOutcome({
      parseThrew: true,
      parseErrorMessage: "Unexpected token < in JSON at position 0",
      parsedKeyCount: 0,
      rawTextLength: 4,
    });
    expect(err).toContain("json_extraction_failed");
    expect(err).toContain("Unexpected token");
  });

  it("THE CANARY CASE: substantial body, zero keys recovered → error", () => {
    const err = classifyParseOutcome({
      parseThrew: false,
      parsedKeyCount: 0,
      rawTextLength: 24_000,
    });
    expect(err).toContain("json_extraction_empty");
    expect(err).toContain("24000");
  });

  it("a genuinely empty response is NOT an error — no false alarms", () => {
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 0,
        rawTextLength: 40,
      }),
    ).toBeNull();
  });

  it("the floor is exclusive: exactly at the floor is still not an error", () => {
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 0,
        rawTextLength: EMPTY_PARSE_RAWTEXT_FLOOR,
      }),
    ).toBeNull();
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 0,
        rawTextLength: EMPTY_PARSE_RAWTEXT_FLOOR + 1,
      }),
    ).not.toBeNull();
  });

  it("a long body that DID parse to at least one key is fine", () => {
    // Partial extraction is not this function's problem — a payload that
    // yielded something is the caller's to validate. Flagging it here would
    // make every partially-answered batch look like a transport failure.
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 1,
        rawTextLength: 90_000,
      }),
    ).toBeNull();
  });

  it("error strings stay bounded — they are persisted on the run row", () => {
    const err = classifyParseOutcome({
      parseThrew: true,
      parseErrorMessage: "x".repeat(5000),
      parsedKeyCount: 0,
      rawTextLength: 10,
    });
    expect(err!.length).toBeLessThanOrEqual(300);
  });

  it("a missing throw message still produces a usable error", () => {
    const err = classifyParseOutcome({
      parseThrew: true,
      parsedKeyCount: 0,
      rawTextLength: 10,
    });
    expect(err).toContain("json_extraction_failed");
    expect(err).toContain("unknown");
  });
});
