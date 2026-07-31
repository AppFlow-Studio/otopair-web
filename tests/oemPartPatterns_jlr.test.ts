/**
 * Batch-9: the Land Rover OEM part pattern was /^LR\d{6}$/ and rejected 13 of a
 * 2012 Range Rover's REAL parts (JLR uses many more formats than "LR######").
 * Widened to the full Jaguar Land Rover family; Jaguar (previously no pattern)
 * now shares it.
 */
import { describe, expect, test } from "vitest";
import { sanitizePartNumber } from "../convex/vehicleEnrichment/contentSanitization";

// Real JLR OEM numbers (from the batch-9 Range Rover GT sheet + JLR catalogs).
const LR_REAL = [
  "LR011279",   // oil filter
  "LR011593",   // air filter
  "LR011593K",  // air filter kit (suffix)
  "LR032080",   // spark plug (NGK ILKAR7C10)
  "LR051626",   // front brake pad
  "LR020362",   // front brake pad (SC)
  "LR134882",   // rear brake pad
  "TYK500050",  // ZF LifeGuard 6 ATF (3-letter + 6-digit)
  "IYK500010",  // transfer case fluid
  "YLE500110",  // old-style 3-letter + 6-digit
  "STC3843",    // old Rover 3-letter + 4-digit
  "ERR6299",    // old Rover
  "ANR1234",    // old Rover
];

const JAG_REAL = [
  "JDE37128",   // Jaguar oil filter
  "JDE26444",   // Jaguar ZF ATF
  "C2Z30906",   // Jaguar letter-digit-letter
  "C2C8355",
  "T2H7856",
];

describe("Jaguar Land Rover part patterns (widened, batch-9)", () => {
  test("every real Land Rover number survives sanitization", () => {
    for (const p of LR_REAL) {
      expect(sanitizePartNumber(p, "Land Rover"), `LR ${p}`).toBe(p);
    }
  });

  test("every real Jaguar number survives (Jaguar previously had no pattern)", () => {
    for (const p of JAG_REAL) {
      expect(sanitizePartNumber(p, "Jaguar"), `JAG ${p}`).toBe(p);
    }
    // Jaguar shares the family pattern, so LR-format numbers pass too.
    expect(sanitizePartNumber("LR011279", "Jaguar")).toBe("LR011279");
  });

  test("the 4 numbers that DID pass in batch-9 still pass (no regression)", () => {
    for (const p of ["LR011279", "LR161843", "LR032080", "LR051626"]) {
      expect(sanitizePartNumber(p, "Land Rover")).toBe(p);
    }
  });

  test("still rejects an obviously-foreign number on a Land Rover", () => {
    // A dashed Toyota 5-5 number must not read as a JLR part.
    expect(sanitizePartNumber("90915-YZZF2", "Land Rover")).toBe(null);
  });

  test("Scion now validates Toyota-format numbers", () => {
    expect(sanitizePartNumber("90915-YZZF1", "Scion")).toBe("90915-YZZF1");
  });
});
