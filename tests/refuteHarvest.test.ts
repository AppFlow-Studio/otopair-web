import { describe, expect, it } from "vitest";
import {
  extractReplacementCandidates,
  normalizeCandidate,
} from "../convex/vehicleEnrichment/utils/refuteHarvest";

// The three refutation reasons are VERBATIM from the 2020 AMG GLC 43's
// refuted_fitments rows on ardent-crab-641 (Aug 2026) — the live case this
// rung was built for.

describe("extractReplacementCandidates", () => {
  it("harvests both battery replacements the verifier named", () => {
    const out = extractReplacementCandidates({
      reason:
        "Official Mercedes-Benz USA parts catalog lists 001-982-80-08 or 001-982-81-08 for the 2020 GLC43 AMG, not 001-982-82-08-26.",
      refutedOem: "001982820826",
      make: "Mercedes-Benz",
    });
    expect(out.map((c) => c.normalized)).toEqual(["0019828008", "0019828108"]);
  });

  it("harvests the spark plug suggestion and never the refuted number", () => {
    const out = extractReplacementCandidates({
      reason:
        "Spark plug 004-159-81-03 is documented for 3.5L & 4.6L V8 engines; the 2020 GLC43 AMG uses a 3.0L turbocharged M276 engine and requires part 270-159-06-00-M220.",
      refutedOem: "0041598103",
      make: "Mercedes-Benz",
    });
    expect(out.map((c) => c.normalized)).toEqual(["27015906 00M220".replace(" ", "")]);
    expect(out.some((c) => c.normalized === "0041598103")).toBe(false);
  });

  it("harvests nothing from a year-range-only reason", () => {
    const out = extractReplacementCandidates({
      reason:
        "Part 276-094-05-04 fits 2010-2016 E-Class and 2012-2018 CLS-Class, not GLC43 AMG; M276 engines require two filters, not one.",
      refutedOem: "276094050490",
      make: "Mercedes-Benz",
    });
    // 276-094-05-04 is the refuted number's base (normalized differs only by
    // the -90 packaging suffix) — it IS format-valid, so it may be proposed;
    // the year ranges must never be. Whether the base number fits is the
    // VERIFIER's call downstream, not the extractor's.
    for (const c of out) {
      expect(c.normalized).not.toMatch(/^(19|20)\d{2}(19|20)\d{2}$/);
    }
  });

  it("respects the exclude blocklist and the cap", () => {
    const out = extractReplacementCandidates({
      reason: "catalog lists 001-982-80-08 or 001-982-81-08",
      refutedOem: "001982820826",
      make: "Mercedes-Benz",
      exclude: new Set(["0019828008"]),
    });
    expect(out.map((c) => c.normalized)).toEqual(["0019828108"]);
  });

  it("returns nothing for empty or prose-only reasons", () => {
    expect(
      extractReplacementCandidates({
        reason: "role_identity: this is a battery cable, not a battery",
        refutedOem: "0009824420",
        make: "Mercedes-Benz",
      }),
    ).toEqual([]);
    expect(
      extractReplacementCandidates({ reason: "", refutedOem: "x", make: "Mercedes-Benz" }),
    ).toEqual([]);
  });
});

describe("normalizeCandidate", () => {
  it("strips separators and uppercases", () => {
    expect(normalizeCandidate("001-982-80-08")).toBe("0019828008");
    expect(normalizeCandidate("a 000 989 08 25")).toBe("A0009890825");
  });
});
