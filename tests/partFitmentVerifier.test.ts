import { describe, expect, it } from "vitest";
import { extractVerdictArray } from "../convex/vehicleEnrichment/utils/partFitmentVerifier";

describe("extractVerdictArray — last valid JSON array wins", () => {
  const VERDICTS = [
    { idx: 1, verdict: "confirmed", reason: "exact fitment row" },
    { idx: 2, verdict: "refuted", reason: "fits 2021-2024 Edge only" },
  ];

  it("parses a bare array", () => {
    expect(extractVerdictArray(JSON.stringify(VERDICTS))).toEqual(VERDICTS);
  });

  it("survives reasoning that echoes a [listed as: …] fragment before the JSON", () => {
    // The live Aug 26 shape: a greedy first-[ grab starts at the echoed
    // bracket and JSON.parse dies — this config aborted the fleet sweep at
    // the same cursor five times.
    const text =
      `Checking part 2 — the line says [listed as: "Disc Brake Rotor"] which matches.\n` +
      `Final answer:\n${JSON.stringify(VERDICTS)}`;
    expect(extractVerdictArray(text)).toEqual(VERDICTS);
  });

  it("survives trailing prose after the array", () => {
    const text = `${JSON.stringify(VERDICTS)}\nLet me know if [anything] else is needed.`;
    expect(extractVerdictArray(text)).toEqual(VERDICTS);
  });

  it("survives brackets on both sides", () => {
    const text = `[searching...] done [listed as: "Pad Set"]\n${JSON.stringify(VERDICTS)}\n[end]`;
    expect(extractVerdictArray(text)).toEqual(VERDICTS);
  });

  it("returns null when no array exists", () => {
    expect(extractVerdictArray("no json here")).toBeNull();
    expect(extractVerdictArray("")).toBeNull();
    expect(extractVerdictArray('{"an":"object"}')).toBeNull();
  });
});
