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
  isPayloadEmpty,
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

/**
 * Aug 6-7 2026 second canary (2022 Telluride / 2016 C300): batch-2 SUCCEEDED,
 * parsed cleanly to `{"fields": [], "services": []}` after 14 real web
 * searches — keys exist, so parsedKeyCount saw a healthy body and the
 * empty-services starvation sailed through every guard again. The rule added
 * for it: keys with zero rows after substantial work is ALSO our failure.
 */
describe("classifyParseOutcome — empty payload (keys but zero rows)", () => {
  it("THE TELLURIDE CASE: parsed keys, all-empty values, big searched body → error", () => {
    const err = classifyParseOutcome({
      parseThrew: false,
      parsedKeyCount: 2,
      rawTextLength: 190_000,
      payloadEmpty: true,
      stopReason: "end_turn",
    });
    expect(err).toContain("json_extraction_empty_payload");
  });

  it("a small honest all-empty body stays a non-error", () => {
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 2,
        rawTextLength: EMPTY_PARSE_RAWTEXT_FLOOR - 50,
        payloadEmpty: true,
      }),
    ).toBeNull();
  });

  it("a populated payload is never flagged, whatever the body size", () => {
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 2,
        rawTextLength: 190_000,
        payloadEmpty: false,
      }),
    ).toBeNull();
  });

  it("carries the stop_reason when the turn ended abnormally", () => {
    const err = classifyParseOutcome({
      parseThrew: false,
      parsedKeyCount: 2,
      rawTextLength: 50_000,
      payloadEmpty: true,
      stopReason: "max_tokens",
    });
    expect(err).toContain("stop_reason=max_tokens");
  });
});

describe("isPayloadEmpty", () => {
  it("all-empty arrays → true (the batch-2 failure shape)", () => {
    expect(isPayloadEmpty({ fields: [], services: [] })).toBe(true);
  });

  it("empty object → false (that is the parsedKeyCount=0 case)", () => {
    expect(isPayloadEmpty({})).toBe(false);
  });

  it("any populated section → false", () => {
    expect(isPayloadEmpty({ fields: [], services: [{ service_name: "Oil Change" }] })).toBe(false);
    expect(isPayloadEmpty({ gap_fields: { oil_viscosity: { value: "5W-30" } }, services: [] })).toBe(false);
  });

  it("null and empty-object values count as empty", () => {
    expect(isPayloadEmpty({ fields: null, services: [], extra: {} })).toBe(true);
  });

  it("scalar values count as content", () => {
    expect(isPayloadEmpty({ note: "n/a" })).toBe(false);
  });
});

describe("classifyParseOutcome — text-block shape suffix (fresh-5 round 2)", () => {
  // The Aug 8 fresh-make audit needed raw Batches-API pulls to see WHY the
  // payload was empty (the 200K-capped run trace cuts the tail off). The
  // verdict now carries the text-block signature so the two shapes read
  // directly off errors[]:
  //   generation gave up ..... textBlocks=1-2, maxTextLen ≤ ~30 (end_turn)
  //   extraction discarded ... maxTextLen in the thousands (bc3e487 shape)
  it("empty payload carries the block signature (CX-30 shape)", () => {
    const err = classifyParseOutcome({
      parseThrew: false,
      parsedKeyCount: 2,
      rawTextLength: 190_000,
      payloadEmpty: true,
      stopReason: "end_turn",
      textBlockCount: 2,
      maxTextBlockLength: 29,
      outputTokens: 994,
    });
    expect(err).toContain("json_extraction_empty_payload");
    expect(err).toContain("textBlocks=2");
    expect(err).toContain("maxTextLen=29");
    expect(err).toContain("outTokens=994");
    // end_turn is the normal stop — no stop_reason noise
    expect(err).not.toContain("stop_reason=");
  });

  it("zero-keys verdict carries the signature too", () => {
    const err = classifyParseOutcome({
      parseThrew: false,
      parsedKeyCount: 0,
      rawTextLength: 24_000,
      textBlockCount: 0,
      maxTextBlockLength: 0,
      outputTokens: 512,
    });
    expect(err).toContain("json_extraction_empty");
    expect(err).toContain("textBlocks=0");
  });

  it("omitting the block stats keeps the legacy verdict byte-stable", () => {
    const err = classifyParseOutcome({
      parseThrew: false,
      parsedKeyCount: 2,
      rawTextLength: 50_000,
      payloadEmpty: true,
    });
    expect(err).toBe("json_extraction_empty_payload: parsed object has keys but zero rows");
  });

  it("a healthy parse stays null regardless of block stats", () => {
    expect(
      classifyParseOutcome({
        parseThrew: false,
        parsedKeyCount: 12,
        rawTextLength: 8000,
        textBlockCount: 1,
        maxTextBlockLength: 21_297,
        outputTokens: 8442,
      }),
    ).toBeNull();
  });
});
