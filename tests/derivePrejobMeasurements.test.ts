/**
 * derivePrejobFromInspection -> validateInspectionMeasurements
 *
 * Regression anchor (P0, live): the MPI replaced the legacy pre-job-survey
 * dialog without porting its measurement mapping, so `derivePrejobFromInspection`
 * emitted neither `tire_tread` nor `brakes.rotor_thickness`. `validatePrejobReport`
 * calls `validateInspectionMeasurements` on EVERY submit, and its tread loop runs
 * BEFORE the hasBrakeWork early-return — so every "Start job" failed with
 * "Front left tread depth is required.", brake job or not. Drafts skip validation,
 * which masked it.
 */
import { describe, it, expect } from "vitest";
import {
  createInspectionState,
  derivePrejobFromInspection,
  type InspectionState,
} from "../lib/inspection-template";
import {
  rotorValueToMicrometers,
  validateInspectionMeasurements,
} from "../lib/inspection-measurements";

const CORNERS = ["FL", "FR", "RL", "RR"] as const;

function stateWithCorners(
  values: Partial<Record<(typeof CORNERS)[number], { tread?: string; pad?: string; rotor?: string }>>,
): InspectionState {
  const state = createInspectionState();
  for (const corner of CORNERS) {
    const zone = state.zones[corner];
    if (!zone) continue;
    const v = values[corner];
    zone.done = true;
    if (v?.tread != null) zone.measures.tread = v.tread;
    if (v?.pad != null) {
      zone.measures.pad_inner = v.pad;
      zone.measures.pad_outer = v.pad;
    }
    if (v?.rotor != null) zone.measures.rotor = v.rotor;
  }
  return state;
}

function fullyMeasured(): InspectionState {
  return stateWithCorners({
    FL: { tread: "8", pad: "9", rotor: "26.5" },
    FR: { tread: "7", pad: "8.5", rotor: "26.4" },
    RL: { tread: "9", pad: "7", rotor: "11.2" },
    RR: { tread: "9", pad: "7.5", rotor: "11.1" },
  });
}

const OPTS = { mileage: 51_200 };

const SCOPE_BOTH = { hasBrakeWork: true, front: true, rear: true };
const SCOPE_NONE = { hasBrakeWork: false, front: false, rear: false };
const SCOPE_FRONT = { hasBrakeWork: true, front: true, rear: false };

describe("derivePrejobFromInspection measurement blocks", () => {
  it("a fully measured inspection passes server validation for a brake job", () => {
    const prejob = derivePrejobFromInspection(fullyMeasured(), OPTS);
    expect(
      validateInspectionMeasurements({
        tire_tread: prejob.tire_tread,
        brakes: prejob.brakes,
        brake_scope: SCOPE_BOTH,
      }),
    ).toEqual({ valid: true });
  });

  it("passes for a non-brake booking too — the tread loop runs unconditionally", () => {
    const prejob = derivePrejobFromInspection(fullyMeasured(), OPTS);
    expect(
      validateInspectionMeasurements({
        tire_tread: prejob.tire_tread,
        brakes: prejob.brakes,
        brake_scope: SCOPE_NONE,
      }),
    ).toEqual({ valid: true });
  });

  it("emits tread for all four corners", () => {
    const prejob = derivePrejobFromInspection(fullyMeasured(), OPTS);
    expect(prejob.tire_tread).toEqual({
      front_left: { reported_min_32nds: 8 },
      front_right: { reported_min_32nds: 7 },
      rear_left: { reported_min_32nds: 9 },
      rear_right: { reported_min_32nds: 9 },
    });
  });

  it("normalized_um matches rotorValueToMicrometers exactly — validateRotorReading re-derives and compares", () => {
    const prejob = derivePrejobFromInspection(fullyMeasured(), OPTS);
    const fl = prejob.brakes?.rotor_thickness?.front_left;
    expect(fl).toEqual({
      entered_value: 26.5,
      entered_unit: "mm",
      normalized_um: rotorValueToMicrometers(26.5, "mm"),
    });
    expect(fl?.normalized_um).toBe(26_500);
  });

  it("rejects fractional tread because inspection readings use whole 32nds", () => {
    const state = stateWithCorners({
      FL: { tread: "7.5", pad: "9", rotor: "26.5" },
      FR: { tread: "7.4", pad: "9", rotor: "26.5" },
      RL: { tread: "9", pad: "7", rotor: "11.2" },
      RR: { tread: "9", pad: "7", rotor: "11.2" },
    });
    const prejob = derivePrejobFromInspection(state, OPTS);
    expect(
      validateInspectionMeasurements({
        tire_tread: prejob.tire_tread,
        brakes: prejob.brakes,
        brake_scope: SCOPE_NONE,
      }),
    ).toEqual({
      valid: false,
      error: "Front left tread depth must be a whole number from 0 to 32.",
    });
  });

  it("still reports a genuinely missing tread reading", () => {
    const state = fullyMeasured();
    state.zones.FL!.measures.tread = "";
    const prejob = derivePrejobFromInspection(state, OPTS);
    expect(
      validateInspectionMeasurements({
        tire_tread: prejob.tire_tread,
        brakes: prejob.brakes,
        brake_scope: SCOPE_NONE,
      }),
    ).toEqual({ valid: false, error: "Front left tread depth is required." });
  });

  it("only the scoped axle's rotors are required", () => {
    const state = fullyMeasured();
    state.zones.RL!.measures.rotor = "";
    state.zones.RR!.measures.rotor = "";
    const prejob = derivePrejobFromInspection(state, OPTS);

    expect(
      validateInspectionMeasurements({
        tire_tread: prejob.tire_tread,
        brakes: prejob.brakes,
        brake_scope: SCOPE_FRONT,
      }),
    ).toEqual({ valid: true });

    expect(
      validateInspectionMeasurements({
        tire_tread: prejob.tire_tread,
        brakes: prejob.brakes,
        brake_scope: SCOPE_BOTH,
      }),
    ).toEqual({
      valid: false,
      error: "Rear left rotor thickness is required for this brake job.",
    });
  });

  it("keeps the rotor block when rotors are measured but pads are not", () => {
    const state = stateWithCorners({
      FL: { tread: "8", rotor: "26.5" },
      FR: { tread: "8", rotor: "26.5" },
      RL: { tread: "8", rotor: "11.2" },
      RR: { tread: "8", rotor: "11.2" },
    });
    const prejob = derivePrejobFromInspection(state, OPTS);
    expect(prejob.brakes?.rotor_thickness?.front_left?.entered_value).toBe(26.5);
  });

  it("an untouched inspection emits null blocks rather than empty objects", () => {
    const prejob = derivePrejobFromInspection(createInspectionState(), OPTS);
    expect(prejob.tire_tread).toBeNull();
    expect(prejob.brakes).toBeNull();
  });
});
