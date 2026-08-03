/**
 * soleFlaggedWinnerRoles (round 13) — the "demoted-wrong-winner" detector.
 *
 * The 7-layer selector already demotes refute_flagged candidates DECISIVELY
 * when an unflagged rival exists (partSelector "Fitment Refute Demotion") —
 * but a flagged SOLE candidate still quotes. Live case: the Crosstrek's
 * front pad 26296FL032, verifier-flagged "2022-2023 only", kept winning
 * because nothing competed. The detector finds exactly the groups where every
 * candidate is flagged, so the repair loop can research + verify a rival and
 * let the existing demotion perform the swap — nothing deleted, nothing
 * overwritten (round-6 lesson).
 */
import { describe, expect, it } from "vitest";
import {
  soleFlaggedWinnerRoles,
  type FitmentCandidateRow,
} from "../convex/vehicleEnrichment/utils/roleResource";

const row = (over: Partial<FitmentCandidateRow>): FitmentCandidateRow => ({
  serviceType: "brake_pad_replacement",
  subcategory: "front_brake_pad",
  serviceRole: "core",
  refuteFlagged: false,
  refuteReason: null,
  mechanicVerified: false,
  packageCode: null,
  oemNormalized: "26296FL032",
  ...over,
});

describe("soleFlaggedWinnerRoles", () => {
  it("detects the FL032 shape: a flagged sole candidate in a core role", () => {
    const out = soleFlaggedWinnerRoles([
      row({ refuteFlagged: true, refuteReason: "Fitment range is 2022-2023 only" }),
    ]);
    expect(out).toEqual([
      {
        roleKey: "front_brake_pad",
        serviceType: "brake_pad_replacement",
        flaggedOems: ["26296FL032"],
        reasons: ["Fitment range is 2022-2023 only"],
      },
    ]);
  });

  it("does NOT fire when an unflagged rival exists — the selector already swaps", () => {
    const out = soleFlaggedWinnerRoles([
      row({ refuteFlagged: true }),
      row({ oemNormalized: "26296FN06A", refuteFlagged: false }),
    ]);
    expect(out).toEqual([]);
  });

  it("never rivals a group containing a mechanic-verified candidate", () => {
    const out = soleFlaggedWinnerRoles([
      row({ refuteFlagged: true, mechanicVerified: true }),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores non-core roles and package-scoped fitments", () => {
    const out = soleFlaggedWinnerRoles([
      row({
        subcategory: "front_brake_hardware_kit",
        serviceRole: "as_needed",
        refuteFlagged: true,
      }),
      row({ refuteFlagged: true, packageCode: "m_performance" }),
    ]);
    expect(out).toEqual([]);
  });

  it("treats a null serviceRole as core when the reference says the roleKey is core", () => {
    const out = soleFlaggedWinnerRoles([
      row({ serviceRole: null, refuteFlagged: true }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("groups by (service, role): all-flagged multi-candidate groups list every incumbent", () => {
    const out = soleFlaggedWinnerRoles([
      row({ refuteFlagged: true, refuteReason: "wrong generation" }),
      row({ oemNormalized: "26296SC011", refuteFlagged: true, refuteReason: "2010-18 only" }),
      // A different, healthy role group must not appear.
      row({
        serviceType: "oil_change",
        subcategory: "oil_filter",
        oemNormalized: "15208AA21A",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].flaggedOems.sort()).toEqual(["26296FL032", "26296SC011"]);
    expect(out[0].reasons).toHaveLength(2);
  });
});
