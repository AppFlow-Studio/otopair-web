/**
 * Round-6 (batch-7 Jul 2026): transmission/CVT fluid-family gate.
 *
 * The fitment verifier catches wrong OEM PART numbers, but the transmission
 * fluid SPEC lives in the trans_fluid_type field and reached quotes unchecked —
 * batch-7 shipped NS-2 where the T32 needs NS-3, Dexron-VI where the 10L80
 * needs Dexron-ULV, and wet-auto Mercon-LV in a dry DPS6 DCT. A wrong trans
 * fluid destroys the unit.
 *
 * These tests cover the PURE decision logic (decideTransFluidAction) and spec
 * equivalence — the positive-evidence bar that must hold before we overwrite a
 * stored fluid. The network call itself is not unit-tested (it web-searches).
 */
import { describe, expect, test } from "vitest";
import {
  decideTransFluidAction,
  fluidSpecEquivalent,
  type TransFluidVerdict,
} from "../convex/vehicleEnrichment/utils/transFluidVerifier";

function verdict(v: Partial<TransFluidVerdict>): TransFluidVerdict {
  return {
    verdict: "uncertain",
    transUnit: null,
    correctFluid: null,
    reason: "",
    ...v,
  };
}

describe("fluidSpecEquivalent", () => {
  test("ignores case, spacing, and punctuation", () => {
    expect(fluidSpecEquivalent("Dexron VI", "DEXRON-VI")).toBe(true);
    expect(fluidSpecEquivalent("dexron vi", "Dexron  VI")).toBe(true);
    expect(fluidSpecEquivalent("NS-3", "ns3")).toBe(true);
  });
  test("distinguishes genuine generation/family changes", () => {
    expect(fluidSpecEquivalent("Dexron VI", "Dexron ULV")).toBe(false);
    expect(fluidSpecEquivalent("NS-2", "NS-3")).toBe(false);
    expect(fluidSpecEquivalent("Mercon LV", "XT-11-QDC")).toBe(false);
  });
});

describe("decideTransFluidAction — batch-7 suspect-fluid cases FLAG (never overwrite)", () => {
  // Batch-8 changed round-6 from a corrector to a flagger: the verifier is not
  // trusted to overwrite a damaging-consequence value (it corrupted two correct
  // fluids in live validation). A positively-supported mismatch now FLAGS.
  test("Rogue T32: NS-2 with a named NS-3 expectation → flag", () => {
    const a = decideTransFluidAction(
      verdict({
        verdict: "mismatch",
        transUnit: "Jatco JF017E CVT (T32)",
        correctFluid: "Nissan CVT NS-3",
        reason: "T32 needs NS-3; NS-2 is the older Rogue Select JF011E.",
      }),
      "Nissan CVT NS-2",
    );
    expect(a.action).toBe("flag");
    if (a.action === "flag") {
      expect(a.claimedCorrect).toBe("Nissan CVT NS-3");
      expect(a.suspectUnit).toContain("JF017E");
    }
  });

  test("Tahoe 10L80: Dexron-VI vs a named Dexron-ULV expectation → flag", () => {
    const a = decideTransFluidAction(
      verdict({ verdict: "mismatch", transUnit: "GM 10L80", correctFluid: "DEXRON-ULV" }),
      "DEXRON VI",
    );
    expect(a.action).toBe("flag");
    if (a.action === "flag") expect(a.claimedCorrect).toBe("DEXRON-ULV");
  });

  test("Focus DPS6: wet Mercon-LV vs dry-DCT expectation → flag", () => {
    const a = decideTransFluidAction(
      verdict({
        verdict: "mismatch",
        transUnit: "Ford DPS6 dry dual-clutch",
        correctFluid: "Ford XT-11-QDC",
      }),
      "Mercon LV",
    );
    expect(a.action).toBe("flag");
  });
});

describe("decideTransFluidAction — the batch-8 regression cases must only FLAG, never overwrite", () => {
  // These are the two live cases where OVERWRITING corrupted a correct value.
  // Flag-only keeps the (correct) stored value; a human resolves the flag.
  test("Corolla: verifier claims T-IV vs correct WS → flag (value not changed)", () => {
    const a = decideTransFluidAction(
      verdict({
        verdict: "mismatch",
        transUnit: "Toyota U240E (4-speed automatic)", // verifier's WRONG unit ID
        correctFluid: "Toyota ATF Type T-IV (JWS 3309)", // verifier's WRONG fluid
      }),
      "Toyota ATF WS (World Standard)", // the CORRECT stored value
    );
    expect(a.action).toBe("flag"); // must NOT overwrite the correct WS
  });

  test("Wrangler: verifier claims ATF+4 off a bad manual decode → flag (value not changed)", () => {
    const a = decideTransFluidAction(
      verdict({
        verdict: "mismatch",
        transUnit: "Aisin AL6 6-speed manual transmission", // confabulated from bad decode
        correctFluid: "Mopar ATF+4",
      }),
      "ZF Lifeguard 8 / Mopar 8 & 9 Speed ATF (68218925AB)", // the CORRECT stored value
    );
    expect(a.action).toBe("flag"); // must NOT overwrite the correct ZF ATF
  });
});

describe("decideTransFluidAction — positive-evidence bar (never flag without it)", () => {
  test("match → keep", () => {
    expect(
      decideTransFluidAction(
        verdict({ verdict: "match", transUnit: "GM 10L80", correctFluid: "DEXRON-ULV" }),
        "DEXRON ULV",
      ).action,
    ).toBe("keep");
  });

  test("uncertain → keep even with a named alternative", () => {
    expect(
      decideTransFluidAction(
        verdict({ verdict: "uncertain", transUnit: "GM 10L80", correctFluid: "DEXRON-ULV" }),
        "DEXRON VI",
      ).action,
    ).toBe("keep");
  });

  test("mismatch WITHOUT a named unit → keep (no positive evidence)", () => {
    expect(
      decideTransFluidAction(
        verdict({ verdict: "mismatch", transUnit: null, correctFluid: "DEXRON-ULV" }),
        "DEXRON VI",
      ).action,
    ).toBe("keep");
  });

  test("mismatch WITHOUT a named correct fluid → keep", () => {
    expect(
      decideTransFluidAction(
        verdict({ verdict: "mismatch", transUnit: "GM 10L80", correctFluid: null }),
        "DEXRON VI",
      ).action,
    ).toBe("keep");
  });

  test("mismatch whose 'correct' fluid equals the stored one → keep (no-op guard)", () => {
    // Guards a hallucinated mismatch that names our own value back at us.
    expect(
      decideTransFluidAction(
        verdict({
          verdict: "mismatch",
          transUnit: "GM 10L80",
          correctFluid: "Dexron-VI",
        }),
        "DEXRON VI",
      ).action,
    ).toBe("keep");
  });

  test("flags even when stored fluid is blank but checker has positive evidence", () => {
    // Defensive: the wiring skips a null field, but if a whitespace value slips
    // through the decision still requires only the positive-evidence bar.
    const a = decideTransFluidAction(
      verdict({ verdict: "mismatch", transUnit: "ZF 8HP", correctFluid: "ZF LifeguardFluid 8" }),
      "  ",
    );
    expect(a.action).toBe("flag");
  });
});
