/**
 * Rotor minimum resolution tiers.
 *
 * The load-bearing behaviours: a human's reading is never overwritten,
 * derivation is OFF unless explicitly enabled, and a nominal-only page reports
 * an honest gap rather than inventing a minimum that looks sourced.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  DERIVE_ALLOWANCE_MM,
  resolveRotorMinimums,
  rotorErrorTag,
  rotorGapReason,
  rotorMinGaps,
} from "../convex/vehicleEnrichment/utils/rotorSpecResource";

afterEach(() => {
  delete process.env.ENRICHMENT_ROTOR_MIN_DERIVE;
});

const SPEC_PAGE = [
  "Front Disc Brake Rotor 43512-0R010",
  "Disc Thickness: 26.0 mm",
  "Minimum Thickness: 24.0 mm",
].join("\n");

const NOMINAL_ONLY_PAGE = "Front Disc Brake Rotor 330x22mm";

const front = (rs: ReturnType<typeof resolveRotorMinimums>) =>
  rs.find((r) => r.axle === "front")!;
const rear = (rs: ReturnType<typeof resolveRotorMinimums>) =>
  rs.find((r) => r.axle === "rear")!;

describe("resolveRotorMinimums", () => {
  it("sources a labelled minimum out of cached markdown", () => {
    const r = front(resolveRotorMinimums({ markdown: SPEC_PAGE, existing: {} }));
    expect(r.outcome).toBe("sourced_markdown");
    expect(r.minMm).toBe(24);
    expect(r.nominalMm).toBe(26);
    expect(r.quality).toBe("oem_spec");
    expect(r.observedLabel).toBe("Minimum Thickness");
    expect(r.changed).toBe(true);
  });

  it("a nominal-only page yields a gap, NOT a minimum", () => {
    const r = front(
      resolveRotorMinimums({ markdown: NOMINAL_ONLY_PAGE, existing: {} }),
    );
    expect(r.outcome).toBe("nominal_only");
    expect(r.minMm).toBeNull();
    expect(r.nominalMm).toBe(22);
    expect(r.quality).toBeNull();
  });

  it("finds nothing in a page with no thickness data", () => {
    const r = front(
      resolveRotorMinimums({ markdown: "Front Rotor 43512-0R010", existing: {} }),
    );
    expect(r.outcome).toBe("never_found");
    expect(r.minMm).toBeNull();
  });

  it("keeps an existing sourced value rather than re-deriving", () => {
    const r = front(
      resolveRotorMinimums({
        markdown: SPEC_PAGE,
        existing: { front: { minMm: 23.5, quality: "oem_spec" } },
      }),
    );
    expect(r.outcome).toBe("already_present");
    expect(r.minMm).toBe(23.5);
    expect(r.changed).toBe(false);
  });

  it("NEVER overwrites a mechanic's or a director's reading", () => {
    for (const quality of ["mechanic_read", "director_verified"]) {
      const r = front(
        resolveRotorMinimums({
          markdown: SPEC_PAGE,
          existing: { front: { minMm: 25, quality } },
        }),
      );
      expect(r.outcome, quality).toBe("already_present");
      expect(r.minMm, quality).toBe(25);
      expect(r.quality, quality).toBe(quality);
    }
  });

  it("treats a drum axle as not-applicable, never a gap", () => {
    const r = rear(
      resolveRotorMinimums({
        markdown: SPEC_PAGE,
        existing: {},
        naRoleKeys: ["rear_rotor"],
      }),
    );
    expect(r.outcome).toBe("not_applicable");
    expect(rotorGapReason(r.outcome)).toBe("rotor_min_not_applicable");
    expect(rotorMinGaps([r])).toEqual([]);
  });

  it("treats an axle with no rotor fitment as not-applicable", () => {
    const r = rear(
      resolveRotorMinimums({
        markdown: SPEC_PAGE,
        existing: {},
        axlesWithFitment: ["front"],
      }),
    );
    expect(r.outcome).toBe("not_applicable");
  });
});

describe("derivation is opt-in", () => {
  it("does NOT derive by default", () => {
    const r = front(
      resolveRotorMinimums({ markdown: NOMINAL_ONLY_PAGE, existing: {} }),
    );
    expect(r.outcome).toBe("nominal_only");
    expect(r.minMm).toBeNull();
  });

  it("derives, and labels the result an estimate, when explicitly enabled", () => {
    process.env.ENRICHMENT_ROTOR_MIN_DERIVE = "on";
    const r = front(
      resolveRotorMinimums({ markdown: NOMINAL_ONLY_PAGE, existing: {} }),
    );
    expect(r.outcome).toBe("derived_from_nominal");
    expect(r.minMm).toBe(22 - DERIVE_ALLOWANCE_MM);
    // The quality string is what caps classify() at "warn" downstream.
    expect(r.quality).toBe("derived_from_nominal");
    expect(r.observedLabel).toBeNull();
    expect(rotorErrorTag(r)).toContain("rotor_min:estimated:front");
  });

  it("still prefers a real sourced minimum over deriving one", () => {
    process.env.ENRICHMENT_ROTOR_MIN_DERIVE = "on";
    const r = front(resolveRotorMinimums({ markdown: SPEC_PAGE, existing: {} }));
    expect(r.outcome).toBe("sourced_markdown");
    expect(r.quality).toBe("oem_spec");
  });
});

describe("gap + error reporting", () => {
  it("maps outcomes to field_gaps reasons", () => {
    expect(rotorGapReason("nominal_only")).toBe("rotor_min_nominal_only");
    expect(rotorGapReason("never_found")).toBe("rotor_min_never_found");
    expect(rotorGapReason("sourced_markdown")).toBeNull();
    expect(rotorGapReason("already_present")).toBeNull();
  });

  it("buckets errors under a single rotor_min prefix", () => {
    const rs = resolveRotorMinimums({ markdown: NOMINAL_ONLY_PAGE, existing: {} });
    const tags = rs.map(rotorErrorTag).filter(Boolean) as string[];
    expect(tags.every((t) => t.startsWith("rotor_min:"))).toBe(true);
    expect(tags).toContain("rotor_min:nominal_only:front:22");
  });

  it("reports both axles as gaps when nothing is on file", () => {
    const rs = resolveRotorMinimums({ markdown: "", existing: {} });
    expect(rotorMinGaps(rs)).toEqual(["front", "rear"]);
  });
});
