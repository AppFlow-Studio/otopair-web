/**
 * Batch-9: reject a VDB performance-halo mis-decode NHTSA contradicts. A 2003
 * Impreza Outback (2.5 NA) was decoded as an "Impreza WRX" (2.0T) because the
 * fuzzy YMMT match treated "Impreza WRX" ⊇ "Impreza" as agreement.
 */
import { describe, expect, test } from "vitest";
import { reconcilePerformanceVariant } from "../convex/vehicleEnrichment/variantDecodeReconcile";

describe("reconcilePerformanceVariant", () => {
  test("the batch-9 Subaru: VDB 'Impreza WRX' vs NHTSA 'Impreza' + series 'Outback' → demote", () => {
    const r = reconcilePerformanceVariant("Impreza WRX", "Impreza", "Outback 2.5");
    expect(r.demote).toBe(true);
    expect(r.token).toBe("wrx");
    expect(r.reason).toContain("WRX");
  });

  test("the real Subaru shape: 'Outback' is in NHTSA's MODEL, not series/trim → demote", () => {
    // NHTSA returns model='Impreza Outback', empty series/trim.
    const r = reconcilePerformanceVariant("Impreza WRX", "Impreza Outback", "");
    expect(r.demote).toBe(true);
  });

  test("NHTSA corroborates the variant (series names WRX) → keep VDB", () => {
    expect(reconcilePerformanceVariant("Impreza WRX", "Impreza", "WRX Premium").demote).toBe(false);
    // NHTSA model itself carries it
    expect(reconcilePerformanceVariant("Impreza WRX STI", "Impreza WRX STI", "").demote).toBe(false);
  });

  test("NHTSA is SILENT on the variant (bare model, no series/trim) → keep VDB (a real WRX must survive)", () => {
    expect(reconcilePerformanceVariant("Impreza WRX", "Impreza", "").demote).toBe(false);
    expect(reconcilePerformanceVariant("Impreza WRX", "Impreza", null).demote).toBe(false);
  });

  test("no performance token in VDB model → never demote", () => {
    expect(reconcilePerformanceVariant("Impreza Outback", "Impreza", "Outback").demote).toBe(false);
    expect(reconcilePerformanceVariant("Camry SE", "Camry", "LE").demote).toBe(false);
    expect(reconcilePerformanceVariant("Corolla", "Corolla", "L").demote).toBe(false);
  });

  test("generalizes: Golf GTI mis-decoded on a base Golf with NHTSA naming a trim", () => {
    expect(reconcilePerformanceVariant("Golf GTI", "Golf", "SEL").demote).toBe(true);
    // but a real GTI where NHTSA says GTI is kept
    expect(reconcilePerformanceVariant("Golf GTI", "Golf GTI", "Autobahn").demote).toBe(false);
  });

  test("a pure displacement number in NHTSA does NOT trigger a demote (protects real WRX)", () => {
    // NHTSA gives 'Impreza' + displacement '2.0' for a real WRX it under-decoded.
    expect(reconcilePerformanceVariant("Impreza WRX", "Impreza", "2.0").demote).toBe(false);
  });

  test("compact-form matching: 'Type R' hits even without the space", () => {
    expect(reconcilePerformanceVariant("Civic TypeR", "Civic", "LX").demote).toBe(true);
  });

  test("missing inputs → no demote", () => {
    expect(reconcilePerformanceVariant(null, "Impreza", "Outback").demote).toBe(false);
    expect(reconcilePerformanceVariant("Impreza WRX", null, "Outback").demote).toBe(false);
  });
});
