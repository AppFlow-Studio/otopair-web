/**
 * The nominal-vs-minimum guard, at the validation layer.
 *
 * A rotor minimum is believed ONLY when the extraction quoted a label that
 * actually reads as a minimum. OEM storefronts publish diameter x NOMINAL
 * ("330x22mm"), so an unguarded extraction fills the minimum column with
 * nominals — and a nominal graded as a minimum condemns healthy rotors and has
 * us recommending brake jobs that aren't needed.
 */
import { describe, expect, test } from "vitest";
import { runSanityChecks } from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(value: any, extra: Partial<FieldResult> = {}): FieldResult {
  return {
    value,
    source_url: "https://subaru.oempartsonline.com/oem-parts/x",
    source_type: "scraped",
    confidence: 0.9,
    flagged: false,
    flag_reason: null,
    ...extra,
  };
}

function meta(value: string | null): FieldResult {
  return {
    value,
    source_url: null,
    source_type: null,
    confidence: null,
    flagged: false,
    flag_reason: null,
  };
}

function rotorFields(opts: {
  axle?: "front" | "rear";
  min?: number | null;
  nominal?: number | null;
  kind?: string | null;
  label?: string | null;
}): Record<string, FieldResult> {
  const axle = opts.axle ?? "front";
  return {
    [`rotor_${axle}_min_thickness_mm`]: field(opts.min ?? null),
    [`rotor_${axle}_nominal_thickness_mm`]: field(opts.nominal ?? null),
    [`rotor_${axle}_min_kind`]: meta(opts.kind ?? "discard_min"),
    [`rotor_${axle}_min_observed_label`]: meta(
      opts.label === undefined ? "Minimum Thickness" : opts.label,
    ),
  };
}

const reasons = (flags: { reason: string }[]) => flags.map((f) => f.reason).join(" | ");

describe("rotor minimum — label cross-check", () => {
  test("a properly labelled minimum survives", () => {
    const fields = rotorFields({ min: 24, nominal: 26 });
    const flags = runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBe(24);
    expect(flags.some((f) => f.field === "rotor_front_min_thickness_mm")).toBe(false);
  });

  test("REJECTS a minimum backed only by a bare 'Thickness' label", () => {
    const fields = rotorFields({ min: 26, nominal: null, label: "Thickness" });
    const flags = runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
    expect(reasons(flags)).toContain("rotor_min_label_mismatch");
  });

  test("REJECTS a minimum backed by a machining label", () => {
    const fields = rotorFields({ min: 24.5, label: "Machining Limit" });
    runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
  });

  test("REJECTS an unlabelled minimum — unauditable is indistinguishable from a nominal", () => {
    const fields = rotorFields({ min: 24, label: null });
    const flags = runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
    expect(reasons(flags)).toContain("rotor_min_unlabelled");
  });

  test("REJECTS a value whose claimed kind is not a discard minimum", () => {
    const fields = rotorFields({ min: 26, kind: "nominal", label: "Thickness" });
    const flags = runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
    expect(reasons(flags)).toContain("rotor_min_wrong_kind:nominal");
  });
});

describe("rotor minimum — physical invariants", () => {
  test("REJECTS a minimum at or above the nominal — the labels were swapped", () => {
    const fields = rotorFields({ min: 26, nominal: 26 });
    const flags = runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
    expect(reasons(flags)).toContain("rotor_min_gte_nominal");

    const fields2 = rotorFields({ min: 27, nominal: 26 });
    runSanityChecks(fields2, 4);
    expect(fields2.rotor_front_min_thickness_mm.value).toBeNull();
  });

  test("REJECTS a diameter read as a thickness", () => {
    const fields = rotorFields({ min: 330 });
    const flags = runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
    expect(reasons(flags)).toContain("outside valid range");
  });

  test("REJECTS inches read as mm", () => {
    const fields = rotorFields({ min: 0.945 });
    runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
  });

  test("FLAGS an implausible gap from nominal but keeps the value", () => {
    const fields = rotorFields({ min: 18, nominal: 26 });
    const flags = runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBe(18);
    expect(fields.rotor_front_min_thickness_mm.flagged).toBe(true);
    expect(reasons(flags)).toContain("rotor_min_delta_implausible");
  });

  test("a normal 2mm wear allowance is clean", () => {
    const fields = rotorFields({ min: 24, nominal: 26 });
    const flags = runSanityChecks(fields, 4);
    expect(flags.filter((f) => f.field.startsWith("rotor_"))).toEqual([]);
  });
});

describe("rotor minimum — front/rear pair", () => {
  test("FLAGS front-below-rear without destroying either value", () => {
    const fields = {
      ...rotorFields({ axle: "front", min: 10, nominal: 12 }),
      ...rotorFields({ axle: "rear", min: 18, nominal: 20 }),
    };
    const flags = runSanityChecks(fields, 4);
    // Both survive — a pair violation doesn't say which side is wrong.
    expect(fields.rotor_front_min_thickness_mm.value).toBe(10);
    expect(fields.rotor_rear_min_thickness_mm.value).toBe(18);
    expect(reasons(flags)).toContain("rotor_min_front_below_rear");
    expect(
      flags.find((f) => f.reason.includes("rotor_min_front_below_rear"))?.severity,
    ).toBe("flag");
  });

  test("the normal front-thicker-than-rear case is clean", () => {
    const fields = {
      ...rotorFields({ axle: "front", min: 24, nominal: 26 }),
      ...rotorFields({ axle: "rear", min: 9, nominal: 10.5 }),
    };
    const flags = runSanityChecks(fields, 4);
    expect(
      flags.some((f) => f.reason.includes("rotor_min_front_below_rear")),
    ).toBe(false);
  });
});

describe("rotor nominal", () => {
  test("a nominal is never promoted into the minimum column", () => {
    const fields = rotorFields({ min: null, nominal: 22 });
    runSanityChecks(fields, 4);
    expect(fields.rotor_front_min_thickness_mm.value).toBeNull();
    expect(fields.rotor_front_nominal_thickness_mm.value).toBe(22);
  });

  test("REJECTS a diameter that landed in the nominal column", () => {
    const fields = rotorFields({ min: null, nominal: 330 });
    runSanityChecks(fields, 4);
    expect(fields.rotor_front_nominal_thickness_mm.value).toBeNull();
  });
});
