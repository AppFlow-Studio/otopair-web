/**
 * Round-7 (batch-8): reconcile a wrong automatic-vs-manual transmission decode
 * against the transmission fluid. A 3-pedal manual never takes ATF, so the
 * fluid is an authoritative tie-breaker on a bad vPIC "manual" decode (the 2021
 * Wrangler EcoDiesel ZF-8HP that vPIC called a "6-speed manual").
 */
import { describe, expect, test } from "vitest";
import {
  classifyFluidTransmission,
  reconcileTransmissionType,
} from "../convex/vehicleEnrichment/transmissionTypeReconcile";

describe("classifyFluidTransmission", () => {
  test("automatic / CVT / DCT fluids classify as automatic", () => {
    expect(classifyFluidTransmission("Mopar ZF 8&9 Speed ATF")).toBe("automatic");
    expect(classifyFluidTransmission("DEXRON VI")).toBe("automatic");
    expect(classifyFluidTransmission("Mopar ATF+4")).toBe("automatic");
    expect(classifyFluidTransmission("Toyota ATF WS (World Standard)")).toBe("automatic");
    expect(classifyFluidTransmission("Nissan CVT NS-3")).toBe("automatic");
    expect(classifyFluidTransmission("Ford XT-11-QDC dry DCT")).toBe("automatic");
    expect(classifyFluidTransmission("ZF Lifeguard 8")).toBe("automatic");
  });
  test("manual gear oils classify as manual", () => {
    expect(classifyFluidTransmission("Mopar MTF")).toBe("manual");
    expect(classifyFluidTransmission("75W-90 GL-4")).toBe("manual");
    expect(classifyFluidTransmission("Manual Transmission Fluid")).toBe("manual");
    expect(classifyFluidTransmission("SAE 75W-85 gear oil")).toBe("manual");
  });
  test("empty / ambiguous → null", () => {
    expect(classifyFluidTransmission(null)).toBe(null);
    expect(classifyFluidTransmission("")).toBe(null);
    expect(classifyFluidTransmission("lifetime fill")).toBe(null);
  });
});

describe("reconcileTransmissionType — the batch-8 Wrangler case corrects manual→automatic", () => {
  test("decoded manual + ZF ATF → corrected to automatic", () => {
    const r = reconcileTransmissionType(
      "manual",
      "ZF Lifeguard 8 / Mopar 8 & 9 Speed ATF (68218925AB)",
    );
    expect(r.corrected).toBe(true);
    expect(r.type).toBe("automatic");
    expect(r.flagReason).toContain("reconciled");
  });
  test("decoded manual + CVT fluid → corrected to CVT (sub-family from fluid)", () => {
    const r = reconcileTransmissionType("6-speed manual", "Nissan CVT NS-3");
    expect(r.corrected).toBe(true);
    expect(r.type).toBe("CVT");
  });
  test("decoded manual + dry-DCT fluid → corrected to DCT", () => {
    const r = reconcileTransmissionType("manual", "Ford XT-11-QDC dual-clutch");
    expect(r.corrected).toBe(true);
    expect(r.type).toBe("DCT");
  });
});

describe("reconcileTransmissionType — safe directions", () => {
  test("decoded automatic + manual-reading fluid → FLAG only, no correction", () => {
    const r = reconcileTransmissionType("automatic", "75W-90 GL-5 gear oil");
    expect(r.corrected).toBe(false);
    expect(r.flagReason).toContain("suspect");
    expect(r.type).toBeUndefined();
  });
  test("agreement (manual + MTF) → no change", () => {
    const r = reconcileTransmissionType("manual", "Mopar MTF 75W-90 GL-4");
    expect(r.corrected).toBe(false);
    expect(r.flagReason).toBeUndefined();
  });
  test("agreement (automatic + ATF) → no change", () => {
    const r = reconcileTransmissionType("automatic", "DEXRON VI");
    expect(r.corrected).toBe(false);
    expect(r.flagReason).toBeUndefined();
  });
  test("no recognizable fluid token → no change (never overwrite on no evidence)", () => {
    const r = reconcileTransmissionType("manual", "lifetime fill");
    expect(r.corrected).toBe(false);
  });
  test("missing inputs → no change", () => {
    expect(reconcileTransmissionType(null, "DEXRON VI").corrected).toBe(false);
    expect(reconcileTransmissionType("manual", null).corrected).toBe(false);
  });
});
