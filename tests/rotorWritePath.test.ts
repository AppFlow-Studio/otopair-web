/**
 * Round-14 rotor wiring (audit G1–G8): the write-path guarantees.
 *
 *   1. validateRotorResolution — the physics gate shared by the pipeline
 *      finalize persist and the director backfill (both previously wrote
 *      parser output with zero validation).
 *   2. computeAxlesWithFitment — the shared fitted-axle helper (the two call
 *      sites previously disagreed; the finalize assumed both axles fitted).
 *   3. oem_spec_flagged containment — a sanity-flagged sourced minimum grades
 *      like an estimate, never as a clean OEM spec.
 *   4. resolveRotorMinimums with markdown + axlesWithFitment — the wiring the
 *      in-pipeline call was missing (G1/G3).
 */
import { describe, expect, test } from "vitest";
import {
  validateRotorResolution,
  ROTOR_MIN_BANDS,
} from "../convex/vehicleEnrichment/validation/sanityChecks";
import {
  computeAxlesWithFitment,
  resolveRotorMinimums,
} from "../convex/vehicleEnrichment/utils/rotorSpecResource";
import { isEstimatedRotorRef } from "../lib/inspection-template";

describe("validateRotorResolution", () => {
  test("clean sourced pair passes with no rejects or flags", () => {
    const v = validateRotorResolution({
      front: { minMm: 28, nominalMm: 30 },
      rear: { minMm: 10, nominalMm: 12 },
    });
    expect(v.rejects).toEqual({});
    expect(v.flags).toEqual({});
  });

  test("rejects a diameter read as a thickness (330)", () => {
    const v = validateRotorResolution({ front: { minMm: 330, nominalMm: null } });
    expect(v.rejects.front).toContain("rotor_min_out_of_range");
  });

  test("rejects inches read as mm (0.94)", () => {
    const v = validateRotorResolution({ front: { minMm: 0.94 } });
    expect(v.rejects.front).toContain("rotor_min_out_of_range");
  });

  test("rejects min >= nominal (labels were swapped)", () => {
    const v = validateRotorResolution({ front: { minMm: 30, nominalMm: 28 } });
    expect(v.rejects.front).toContain("rotor_min_gte_nominal");
  });

  test("flags an implausible delta but allows the write", () => {
    // 30 nominal − 22 min = 8mm allowance: far past the real 1.0-3.0mm range.
    const v = validateRotorResolution({ front: { minMm: 22, nominalMm: 30 } });
    expect(v.rejects.front).toBeUndefined();
    expect(v.flags.front).toContain("rotor_min_delta_implausible");
  });

  test("flags front thinner than rear, never rejects (can't tell which side is wrong)", () => {
    // Both values sit inside their typical bands so the pair violation is the
    // only signal — an atypical-band flag would win first-flag precedence.
    const v = validateRotorResolution({
      front: { minMm: 16 },
      rear: { minMm: 18 },
    });
    expect(v.rejects.front).toBeUndefined();
    expect(v.rejects.rear).toBeUndefined();
    expect(v.flags.front).toContain("rotor_min_front_below_rear");
  });

  test("null minimums are not validated (absence is handled elsewhere)", () => {
    const v = validateRotorResolution({ front: {}, rear: { minMm: null } });
    expect(v.rejects).toEqual({});
    expect(v.flags).toEqual({});
  });

  test("band constants match the SANITY_RULES entries they mirror", () => {
    expect(ROTOR_MIN_BANDS.front).toMatchObject({ rejectMin: 8, rejectMax: 40 });
    expect(ROTOR_MIN_BANDS.rear).toMatchObject({ rejectMin: 4, rejectMax: 32 });
  });
});

describe("computeAxlesWithFitment", () => {
  test("maps front_rotor / rear_rotor subcategories to axles", () => {
    expect(
      computeAxlesWithFitment([
        { subcategory: "front_rotor" },
        { subcategory: "oil_filter" },
      ]),
    ).toEqual(["front"]);
    expect(
      computeAxlesWithFitment([
        { subcategory: "front_rotor" },
        { subcategory: "rear_rotor" },
      ]),
    ).toEqual(["front", "rear"]);
  });

  test("no rotor fitments → empty (caller falls back to assume-both)", () => {
    expect(computeAxlesWithFitment([{ subcategory: "cabin_filter" }, {}])).toEqual([]);
  });
});

describe("oem_spec_flagged containment", () => {
  test("grades as an estimate — warn-capped, never a clean spec", () => {
    expect(isEstimatedRotorRef("oem_spec_flagged")).toBe(true);
    expect(isEstimatedRotorRef("derived_from_nominal")).toBe(true);
    expect(isEstimatedRotorRef("oem_spec")).toBe(false);
    expect(isEstimatedRotorRef("mechanic_read")).toBe(false);
  });
});

describe("resolveRotorMinimums wiring (G1/G3)", () => {
  const MARKDOWN_WITH_MIN = [
    "Front Brake Rotor",
    "Nominal Thickness: 30 mm",
    "Minimum Thickness: 28 mm",
  ].join("\n");

  test("markdown supplies a labeled discard minimum when nothing is stored", () => {
    const [front] = resolveRotorMinimums({
      markdown: MARKDOWN_WITH_MIN,
      existing: {},
    });
    expect(front.outcome).toBe("sourced_markdown");
    expect(front.minMm).toBe(28);
    expect(front.quality).toBe("oem_spec");
    expect(front.changed).toBe(true);
  });

  test("axle absent from axlesWithFitment resolves not_applicable — no spurious gap", () => {
    const res = resolveRotorMinimums({
      markdown: MARKDOWN_WITH_MIN,
      existing: {},
      axlesWithFitment: ["front"],
    });
    const rear = res.find((r) => r.axle === "rear")!;
    expect(rear.outcome).toBe("not_applicable");
    expect(rear.changed).toBe(false);
  });

  test("human-quality value always stands, even with markdown present", () => {
    const [front] = resolveRotorMinimums({
      markdown: MARKDOWN_WITH_MIN,
      existing: { front: { minMm: 26, quality: "mechanic_read" } },
    });
    expect(front.outcome).toBe("already_present");
    expect(front.minMm).toBe(26);
    expect(front.changed).toBe(false);
  });
});
