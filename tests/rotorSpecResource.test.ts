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

// ─── Round 13: aftermarket disc catalogue via the claim ledger ──────────────
//
// Brembo's "Min. thickness" is a real, label-verified discard spec — but for
// Brembo's disc, which can differ from the OEM rotor's stamped minimum. It must
// fill the gap without ever reading as a clean OEM spec.
describe("catalogue-sourced minimums (claim ledger)", () => {
  it("fills an empty axle and grades it as an estimate, never a clean spec", () => {
    const rs = resolveRotorMinimums({
      markdown: "",
      existing: {},
      catalogClaims: {
        front: {
          minMm: 25,
          nominalMm: 28,
          observedLabel: "Min. thickness",
          sourceUrl: "https://www.bremboparts.com/europe/en/catalogue/disc/09-9554-10",
        },
      },
    });
    const r = front(rs);
    expect(r.outcome).toBe("sourced_catalog");
    expect(r.minMm).toBe(25);
    expect(r.nominalMm).toBe(28);
    // oem_spec_flagged is warn-capped in classify() and can never auto-sell a
    // rotor job — that cap is the whole reason this tier is admissible.
    expect(r.quality).toBe("oem_spec_flagged");
    expect(r.changed).toBe(true);
  });

  it("never outranks the OEM page's own discard text", () => {
    const rs = resolveRotorMinimums({
      markdown: SPEC_PAGE,
      existing: {},
      catalogClaims: { front: { minMm: 25, nominalMm: 28 } },
    });
    const r = front(rs);
    expect(r.outcome).toBe("sourced_markdown");
    expect(r.minMm).toBe(24);
    expect(r.quality).toBe("oem_spec");
  });

  it("never overwrites a value already on file", () => {
    const rs = resolveRotorMinimums({
      markdown: "",
      existing: { front: { minMm: 26, quality: "oem_spec" } },
      catalogClaims: { front: { minMm: 25 } },
    });
    const r = front(rs);
    expect(r.outcome).toBe("already_present");
    expect(r.minMm).toBe(26);
  });

  it("never overwrites a human's reading", () => {
    const rs = resolveRotorMinimums({
      markdown: "",
      existing: { front: { minMm: 26.5, quality: "mechanic_read" } },
      catalogClaims: { front: { minMm: 25 } },
    });
    expect(front(rs).minMm).toBe(26.5);
    expect(front(rs).quality).toBe("mechanic_read");
  });

  it("refuses an incoherent minimum that meets or exceeds its own nominal", () => {
    const rs = resolveRotorMinimums({
      markdown: "",
      existing: {},
      catalogClaims: { front: { minMm: 28, nominalMm: 28 } },
    });
    // Storing this would condemn every healthy rotor on the car.
    expect(front(rs).minMm).toBeNull();
    expect(front(rs).outcome).not.toBe("sourced_catalog");
  });

  it("is inert for an axle with no claim, and for a drum axle", () => {
    const rs = resolveRotorMinimums({
      markdown: "",
      existing: {},
      naRoleKeys: ["rear_rotor"],
      catalogClaims: { front: { minMm: 25, nominalMm: 28 } },
    });
    expect(front(rs).outcome).toBe("sourced_catalog");
    expect(rs.find((r) => r.axle === "rear")!.outcome).toBe("not_applicable");
    // A drum axle is not a gap.
    expect(rotorMinGaps(rs)).toEqual([]);
  });

  it("stays inside the rotor_min error bucket and is not reported as a gap", () => {
    const rs = resolveRotorMinimums({
      markdown: "",
      existing: {},
      catalogClaims: {
        front: { minMm: 25, nominalMm: 28 },
        rear: { minMm: 8, nominalMm: 10 },
      },
    });
    const tags = rs.map(rotorErrorTag).filter(Boolean) as string[];
    expect(tags.every((t) => t.startsWith("rotor_min:"))).toBe(true);
    expect(tags).toContain("rotor_min:catalog:front:25");
    expect(rotorGapReason("sourced_catalog")).toBeNull();
    expect(rotorMinGaps(rs)).toEqual([]);
  });
});
