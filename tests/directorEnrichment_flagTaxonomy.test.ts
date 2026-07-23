/**
 * tallyFlags — the pure parser behind the Enrichment Console's Flags & Quality
 * tab. Buckets enrichment_runs.errors[] by prefix token, pulls per-make counts
 * out of part_pattern_suspect:<make>:<n>, and splits sanity_flags by severity
 * and field. No Convex runtime — just the parse logic.
 */
import { describe, it, expect } from "vitest";
import { tallyFlags } from "../convex/directorEnrichment";

describe("tallyFlags", () => {
  it("buckets errors[] by the token before the first colon", () => {
    const t = tallyFlags([
      { errors: ["batch2_timeout", "quotability:0.62", "sanity:trans_fluid:mismatch"] },
      { errors: ["quotability:0.71", "late_collected"] },
      { errors: ["oem:brake_pad:rejected"] },
    ]);
    const map = Object.fromEntries(t.errorBuckets.map((b) => [b.key, b.count]));
    expect(map["quotability"]).toBe(2);
    expect(map["batch2_timeout"]).toBe(1);
    expect(map["late_collected"]).toBe(1);
    expect(map["sanity"]).toBe(1);
    expect(map["oem"]).toBe(1);
  });

  it("extracts per-make counts from part_pattern_suspect:<make>:<n>", () => {
    const t = tallyFlags([
      { errors: ["part_pattern_suspect:Land Rover:3"] },
      { errors: ["part_pattern_suspect:Land Rover:1", "part_pattern_suspect:BMW:2"] },
    ]);
    const makes = Object.fromEntries(t.partPatternByMake.map((m) => [m.make, m.count]));
    expect(makes["Land Rover"]).toBe(2);
    expect(makes["BMW"]).toBe(1);
    // rolls up under the part_pattern_suspect error bucket too
    expect(t.errorBuckets.find((b) => b.key === "part_pattern_suspect")?.count).toBe(3);
  });

  it("splits sanity_flags by severity and tallies by field", () => {
    const t = tallyFlags([
      {
        sanity_flags: [
          { field: "brake_fluid_type", severity: "reject" },
          { field: "ps_fluid_type", severity: "flag" },
        ],
      },
      { sanity_flags: [{ field: "brake_fluid_type", severity: "flag" }] },
    ]);
    expect(t.sanityBySeverity).toEqual({ reject: 1, flag: 2 });
    const fields = Object.fromEntries(t.sanityByField.map((f) => [f.field, f.count]));
    expect(fields["brake_fluid_type"]).toBe(2);
    expect(fields["ps_fluid_type"]).toBe(1);
  });

  it("counts runs carrying any flag, tolerates null/empty arrays", () => {
    const t = tallyFlags([
      { errors: ["batch2_timeout"] },
      { errors: [], sanity_flags: [] },
      { errors: null, sanity_flags: null },
      { sanity_flags: [{ field: "x", severity: "flag" }] },
    ]);
    expect(t.runsWithAnyFlag).toBe(2);
  });

  it("orders buckets by count descending", () => {
    const t = tallyFlags([
      { errors: ["a:1"] },
      { errors: ["b:1", "b:2"] },
      { errors: ["b:3", "c:1", "c:2"] },
      { errors: ["c:3"] },
    ]);
    expect(t.errorBuckets.map((b) => b.key)).toEqual(["b", "c", "a"]);
  });
});
