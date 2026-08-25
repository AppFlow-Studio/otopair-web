/**
 * Per-axle (per-unit) labor scaling — the mechanism that makes a "both axles"
 * brake job bill ~2× the labor of a single axle, and generalizes to future
 * per-wheel / per-cylinder services.
 *
 * Covers the two pure pieces (the scaling declaration + the count resolver) and
 * that scaled hours compose correctly with the combined-labor dedup: a both-axle
 * pad+rotor job inflates to its true size, then the shared teardown is shaved
 * once per axle, and the total never drops below the largest single service.
 */
import { describe, expect, it } from "vitest";
import {
  getServiceLaborScaling,
  type LaborScalingKind,
} from "../convex/lib/serviceLaborReference";
import { resolveLaborUnitCount } from "../convex/lib/serviceUnits";
import {
  resolveCombinedLabor,
  type CombinedLaborServiceInput,
} from "../convex/lib/combinedLabor";

const engine = (fields: Record<string, unknown>) => fields as any;

describe("getServiceLaborScaling", () => {
  it("brakes scale per axle", () => {
    expect(getServiceLaborScaling("brake_pad_replacement")).toBe("per_axle");
    expect(getServiceLaborScaling("rotor_replacement")).toBe("per_axle");
  });

  it("normalizes dashed slugs", () => {
    expect(getServiceLaborScaling("brake-pad-replacement")).toBe("per_axle");
  });

  it("everything else is fixed (byte-identical to today)", () => {
    expect(getServiceLaborScaling("oil_change")).toBe("fixed");
    expect(getServiceLaborScaling("tire_rotation")).toBe("fixed");
    expect(getServiceLaborScaling("wheel_alignment")).toBe("fixed");
    expect(getServiceLaborScaling("unknown_service")).toBe("fixed");
  });
});

describe("resolveLaborUnitCount", () => {
  const call = (kind: LaborScalingKind, position: any, eng: any = null) =>
    resolveLaborUnitCount(kind, { engine: eng, bookingPosition: position });

  it("per_axle: both → 2, single/absent → 1", () => {
    expect(call("per_axle", "both")).toBe(2);
    expect(call("per_axle", "front")).toBe(1);
    expect(call("per_axle", "rear")).toBe(1);
    expect(call("per_axle", null)).toBe(1);
    expect(call("per_axle", undefined)).toBe(1);
  });

  it("per_wheel → 4 regardless of position", () => {
    expect(call("per_wheel", "both")).toBe(4);
    expect(call("per_wheel", null)).toBe(4);
  });

  it("per_cylinder → spark plugs, then cylinders, then 1", () => {
    expect(call("per_cylinder", null, engine({ spark_plug_quantity: 6, cylinders: 4 }))).toBe(6);
    expect(call("per_cylinder", null, engine({ cylinders: 8 }))).toBe(8);
    expect(call("per_cylinder", null, null)).toBe(1);
  });

  it("fixed → 1 always", () => {
    expect(call("fixed", "both")).toBe(1);
    expect(call("fixed", null)).toBe(1);
  });
});

// The scaling happens UPSTREAM of resolveCombinedLabor (the standaloneHours it
// receives are already the whole-job, axle-scaled numbers). These cases confirm
// the two features compose.
const svc = (
  slug: string,
  standaloneHours: number,
  extra: Partial<CombinedLaborServiceInput> = {},
): CombinedLaborServiceInput => ({
  serviceId: extra.serviceId ?? slug,
  slug,
  standaloneHours,
  position: extra.position ?? null,
  source: extra.source ?? "default",
});
const ON = { enabled: true } as const;

describe("per-axle scaling composes with combined labor", () => {
  it("both-axle pads(3.0)+rotors(6.0): shave shared teardown per axle, stay ≥ largest", () => {
    // Single-axle basis is 1.5 (pad) / 3.0 (rotor); both axles ⇒ 2× upstream.
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 3.0, { position: "both" }),
        svc("rotor_replacement", 6.0, { position: "both" }),
      ],
      ON,
    );
    // Rotor core (4.2h) + the shared teardown owned once per axle ≈ 6.03h,
    // never below the largest single service (6.0h). Naive would be 9.0h.
    expect(r.combinedHours).toBeGreaterThanOrEqual(6.0);
    expect(r.combinedHours).toBeCloseTo(6.03, 2);
    expect(r.savedHours).toBeCloseTo(2.97, 2);
    // Pad R&R is fully subsumed on both shared axles (core → 0).
    const pad = r.perServiceBreakdown.find((b) => b.slug === "brake_pad_replacement")!;
    expect(pad.chargedHours).toBeLessThan(pad.standaloneHours);
  });

  it("front-only pads(1.5)+rotors(3.0) unchanged from today (no scaling applied)", () => {
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 1.5, { position: "front" }),
        svc("rotor_replacement", 3.0, { position: "front" }),
      ],
      ON,
    );
    expect(r.combinedHours).toBeCloseTo(3.015, 2);
    expect(r.savedHours).toBeCloseTo(1.485, 2);
  });
});
