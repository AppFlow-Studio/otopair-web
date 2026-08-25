/**
 * Combined labor operations — the honest multi-service deduction.
 *
 * Verifies the pure resolver that all three naive-sum sites delegate to:
 * shared wheels-off / caliper-off / coolant-drain are charged once, pad R&R is
 * subsumed by a same-axle rotor job, and none of it fires when the flag is off,
 * axles don't match, or both numbers are empirical.
 */
import { describe, expect, it } from "vitest";
import {
  resolveCombinedLabor,
  type CombinedLaborServiceInput,
} from "../convex/lib/combinedLabor";

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

describe("resolveCombinedLabor", () => {
  it("flag off ⇒ byte-identical naive sum", () => {
    const services = [
      svc("brake_pad_replacement", 1.5, { position: "front" }),
      svc("rotor_replacement", 3.0, { position: "front" }),
    ];
    const r = resolveCombinedLabor(services); // no opts → disabled
    expect(r.combinedHours).toBe(4.5);
    expect(r.savedHours).toBe(0);
    expect(r.notes).toEqual([]);
    // Same when explicitly enabled:false
    expect(resolveCombinedLabor(services, { enabled: false }).combinedHours).toBe(4.5);
  });

  it("single service is a no-op even when enabled", () => {
    const r = resolveCombinedLabor([svc("rotor_replacement", 3.0, { position: "front" })], ON);
    expect(r.combinedHours).toBe(3.0);
    expect(r.savedHours).toBe(0);
  });

  it("worked example: front pads + rotors + rotation + alignment", () => {
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 1.5, { position: "front" }),
        svc("rotor_replacement", 3.0, { position: "front" }),
        svc("tire_rotation", 0.4),
        svc("wheel_alignment", 1.0), // no spec → pure core, untouched
      ],
      ON,
    );
    // Naive would be 5.9h; honest combine lands ~4.25h.
    expect(r.combinedHours).toBeGreaterThan(4.2);
    expect(r.combinedHours).toBeLessThan(4.3);
    expect(r.savedHours).toBeCloseTo(1.655, 2);
    // Alignment is never deducted.
    const align = r.perServiceBreakdown.find((b) => b.slug === "wheel_alignment")!;
    expect(align.chargedHours).toBe(1.0);
    expect(r.firedFamilies).toContain("brake_pad_rotor");
    expect(r.firedFamilies).toContain("wheels_off");
  });

  it("pad + rotor same axle: pad collapses to ~its wheel-off (rotor contains the pad R&R)", () => {
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 1.5, { position: "front" }),
        svc("rotor_replacement", 3.0, { position: "front" }),
      ],
      ON,
    );
    // Rotor 3.0 + only the single shared wheel-off ≈ 3.0h, not 4.5h.
    expect(r.combinedHours).toBeCloseTo(3.015, 2);
    expect(r.savedHours).toBeCloseTo(1.485, 2);
    expect(r.combinedHours).toBeGreaterThanOrEqual(3.0); // never below the largest service
  });

  it("axle mismatch: front pads + rear rotors share NOTHING", () => {
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 1.5, { position: "front" }),
        svc("rotor_replacement", 3.0, { position: "rear" }),
      ],
      ON,
    );
    expect(r.combinedHours).toBe(4.5);
    expect(r.savedHours).toBe(0);
    expect(r.firedFamilies).toEqual([]);
  });

  it("wheels-off deducts once for 3 sharers, not 3×", () => {
    // rotation + balance + replacement all need front+rear wheels off.
    const naive = 0.4 + 0.75 + 1.25;
    const r = resolveCombinedLabor(
      [
        svc("tire_rotation", 0.4),
        svc("tire_balance", 0.75),
        svc("tire_replacement", 1.25),
      ],
      ON,
    );
    // Saving is bounded by the shared wheel-off (~0.8h across both axles for the
    // two non-owners), and rotation is fully subsumed by replacement.
    expect(r.savedHours).toBeGreaterThan(0);
    expect(r.combinedHours).toBeLessThan(naive);
    expect(r.combinedHours).toBeGreaterThanOrEqual(1.25); // ≥ largest service
    expect(r.firedFamilies).toContain("tire_rotation_subsumed");
  });

  it("tire rotation is dropped when tires are being replaced", () => {
    const r = resolveCombinedLabor(
      [svc("tire_rotation", 0.4), svc("tire_replacement", 1.25)],
      ON,
    );
    const rot = r.perServiceBreakdown.find((b) => b.slug === "tire_rotation")!;
    expect(rot.chargedHours).toBe(0);
    expect(r.firedFamilies).toContain("tire_rotation_subsumed");
  });

  it("timing belt + coolant flush: coolant drain billed once", () => {
    const r = resolveCombinedLabor(
      [svc("timing_belt", 5.0), svc("coolant_flush", 1.25)],
      ON,
    );
    // Exactly the shared 0.5h drain/refill is saved.
    expect(r.savedHours).toBeCloseTo(0.5, 2);
    expect(r.combinedHours).toBeCloseTo(5.75, 2);
    expect(r.firedFamilies).toEqual(["cooling_drain"]);
  });

  it("two empirical numbers are never double-deducted", () => {
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 1.5, { position: "front", source: "vehicle_specific_empirical" }),
        svc("rotor_replacement", 3.0, { position: "front", source: "empirical" }),
      ],
      ON,
    );
    expect(r.combinedHours).toBe(4.5);
    expect(r.savedHours).toBe(0);
  });

  it("director can disable a single family", () => {
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 1.5, { position: "front" }),
        svc("rotor_replacement", 3.0, { position: "front" }),
      ],
      { enabled: true, disabledFamilies: ["brake_pad_rotor"] },
    );
    // Only the shared wheels-off survives; caliper-off + pad-subsumption gone.
    expect(r.firedFamilies).toEqual(["wheels_off"]);
    expect(r.savedHours).toBeCloseTo(0.39, 2);
  });

  it("both axles vs single: only the shared axle is combined", () => {
    // Pads on both axles + rotors front only → front subsumed, rear pad intact.
    const r = resolveCombinedLabor(
      [
        svc("brake_pad_replacement", 1.5, { position: "both" }),
        svc("rotor_replacement", 3.0, { position: "front" }),
      ],
      ON,
    );
    const pad = r.perServiceBreakdown.find((b) => b.slug === "brake_pad_replacement")!;
    // Half the pad core (rear axle) must remain — not fully subsumed.
    expect(pad.chargedHours).toBeGreaterThan(0.3);
    expect(pad.deductedHours).toBeGreaterThan(0);
  });
});
