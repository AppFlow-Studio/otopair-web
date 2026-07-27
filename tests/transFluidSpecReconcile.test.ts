/**
 * transFluidSpecReconcile unit tests — the round-9 deterministic CVT
 * spec↔part gate must fire on the batch-11 Rogue contradiction and must NOT
 * fire on legitimate configurations (Toyota hybrid eCVT + ATF WS, geared
 * automatics, already-CVT specs).
 */
import { describe, it, expect } from "vitest";

import { reconcileTransFluidSpecWithPart } from "../convex/vehicleEnrichment/transFluidSpecReconcile";

describe("reconcileTransFluidSpecWithPart", () => {
  it("corrects the batch-11 Rogue shape: CVT + Matic S spec + NS-3 part", () => {
    const r = reconcileTransFluidSpecWithPart({
      transTypeText: "Continuously Variable Transmission (CVT)",
      spec: "Nissan Matic S",
      partText: "999MP-CSHNS3",
    });
    expect(r.action).toBe("correct");
    if (r.action === "correct") {
      expect(r.correctedSpec).toBe("Nissan CVT Fluid NS-3");
    }
  });

  it("flags (not corrects) a CVT + stepped spec with no CVT-family part", () => {
    const r = reconcileTransFluidSpecWithPart({
      transTypeText: "CVT",
      spec: "DEXRON-VI",
      partText: null,
    });
    expect(r.action).toBe("flag");
  });

  it("keeps a Toyota hybrid eCVT with ATF WS (WS is not a stepped token)", () => {
    const r = reconcileTransFluidSpecWithPart({
      transTypeText: "eCVT (hybrid transaxle)",
      spec: "Toyota ATF WS (World Standard)",
      partText: "00289-ATFWS",
    });
    expect(r.action).toBe("keep");
  });

  it("keeps a geared automatic with a stepped spec (type is not CVT)", () => {
    const r = reconcileTransFluidSpecWithPart({
      transTypeText: "Automatic",
      spec: "Nissan Matic S",
      partText: "999MP-MTS00P",
    });
    expect(r.action).toBe("keep");
  });

  it("keeps a CVT whose spec is already CVT-family", () => {
    const r = reconcileTransFluidSpecWithPart({
      transTypeText: "CVT",
      spec: "Nissan CVT Fluid NS-3",
      partText: "999MP-CSHNS3",
    });
    expect(r.action).toBe("keep");
  });

  it('does not read "automatic" as the Matic token', () => {
    const r = reconcileTransFluidSpecWithPart({
      transTypeText: "CVT",
      spec: "Fully automatic CVT fluid",
      partText: "K0425Y0710",
    });
    expect(r.action).toBe("keep");
  });
});
