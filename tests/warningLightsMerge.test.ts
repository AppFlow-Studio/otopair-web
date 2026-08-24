import { describe, expect, it } from "vitest";

import {
  applyInspectionLightPicker,
  applyPostjobLightClears,
  knownIssuesChanged,
  resolveKnownIssues,
} from "../convex/lib/warningLightsMerge";

describe("warning-light merge (shared by the deferred write + post-job projection)", () => {
  it("an unanswered picker changes nothing", () => {
    expect(applyInspectionLightPicker(["check_engine"], undefined)).toEqual([
      "check_engine",
    ]);
    expect(applyInspectionLightPicker(["check_engine"], [{ light: "" }])).toEqual([
      "check_engine",
    ]);
  });

  it("merges selected lights on top without dropping unrelated ones", () => {
    expect(
      applyInspectionLightPicker(["check_engine", "alignment"], [
        { light: "battery_charging" },
      ]),
    ).toEqual(["check_engine", "alignment", "battery_charging"]);
  });

  it('"None" alone clears every canonical light but preserves non-light codes', () => {
    const next = applyInspectionLightPicker(
      ["check_engine", "battery_charging", "alignment"],
      [{ light: "none" }],
    );
    expect(next).toEqual(["alignment"]);
  });

  it('"Other" folds to the unidentified-light bucket', () => {
    expect(
      applyInspectionLightPicker([], [{ light: "other", otherText: "weird symbol" }]),
    ).toEqual(["not_sure_which"]);
  });

  it("post-job clears remove a light regardless of stored vocabulary/alias", () => {
    // brake_warning is an alias that canonicalizes to abs.
    expect(applyPostjobLightClears(["brake_warning", "tpms"], ["abs"])).toEqual([
      "tpms",
    ]);
  });

  it("a light added AND cleared in the same visit nets out to nothing", () => {
    // The exact case this feature exists for: TPMS spotted on the pre-job
    // walk-around, tires topped up mid-visit, mechanic clears it at post-job.
    const next = resolveKnownIssues({
      knownIssues: [],
      pickerEntries: [{ light: "tpms" }],
      clearedLights: ["tpms"],
    });
    expect(next).toEqual([]);
  });

  it("clears apply on top of the picker, not before it", () => {
    // A pre-existing light the mechanic did NOT re-flag but DID clear.
    const next = resolveKnownIssues({
      knownIssues: ["check_engine"],
      pickerEntries: [{ light: "battery_charging" }],
      clearedLights: ["check_engine"],
    });
    expect(next).toEqual(["battery_charging"]);
  });

  it("knownIssuesChanged is order-insensitive", () => {
    expect(knownIssuesChanged(["a", "b"], ["b", "a"])).toBe(false);
    expect(knownIssuesChanged(["a"], ["a", "b"])).toBe(true);
    expect(knownIssuesChanged(["a", "b"], ["a"])).toBe(true);
  });
});
