import { describe, expect, it } from "vitest";

import {
  buildCustomerInspectionSnapshot,
  convertRotorValue,
  formatRotorValue,
  getTireTreadMinimum,
  rotorValueToMicrometers,
  validateInspectionMeasurementDraft,
  validateInspectionMeasurements,
  type InspectionMeasurementsInput,
} from "../lib/inspection-measurements";

function completeTread(): InspectionMeasurementsInput["tire_tread"] {
  return {
    front_left: { reported_min_32nds: 8 },
    front_right: { reported_min_32nds: 7 },
    rear_left: { reported_min_32nds: 6 },
    rear_right: { reported_min_32nds: 5 },
  };
}

describe("tire tread measurements", () => {
  it("uses the shallowest inner, center, and outer reading", () => {
    expect(
      getTireTreadMinimum({
        reported_min_32nds: 9,
        inner_32nds: 7,
        center_32nds: 8,
        outer_32nds: 6,
      }),
    ).toBe(6);
  });

  it("returns null for partial detailed readings", () => {
    expect(
      getTireTreadMinimum({
        reported_min_32nds: 7,
        inner_32nds: 7,
        center_32nds: 8,
      }),
    ).toBeNull();
  });

  it("requires whole-number readings from zero through 32", () => {
    const result = validateInspectionMeasurements({
      tire_tread: {
        ...completeTread(),
        front_left: { reported_min_32nds: 6.5 },
      },
      brakes: null,
      brake_scope: { hasBrakeWork: false, front: false, rear: false },
    });

    expect(result).toEqual({
      valid: false,
      error: "Front left tread depth must be a whole number from 0 to 32.",
    });
  });

  it("requires all four tire minimums for final submission", () => {
    const result = validateInspectionMeasurements({
      tire_tread: {
        front_left: { reported_min_32nds: 8 },
        front_right: { reported_min_32nds: 7 },
        rear_left: { reported_min_32nds: 6 },
      },
      brakes: null,
      brake_scope: { hasBrakeWork: false, front: false, rear: false },
    });

    expect(result).toEqual({
      valid: false,
      error: "Rear right tread depth is required.",
    });
  });

  it("allows incomplete detailed readings in a draft", () => {
    expect(
      validateInspectionMeasurementDraft({
        tire_tread: {
          front_left: {
            reported_min_32nds: 7,
            inner_32nds: 7,
            center_32nds: 8,
          },
        },
        brakes: null,
      }),
    ).toEqual({ valid: true });
  });
});

describe("rotor measurements", () => {
  it("normalizes inches to integer micrometers", () => {
    expect(rotorValueToMicrometers(1.027, "in")).toBe(26086);
  });

  it("normalizes millimeters to integer micrometers", () => {
    expect(rotorValueToMicrometers(26.09, "mm")).toBe(26090);
  });

  it("converts values when the selected unit changes", () => {
    expect(convertRotorValue(1.027, "in", "mm")).toBeCloseTo(26.0858, 4);
    expect(convertRotorValue(26.09, "mm", "in")).toBeCloseTo(1.027165, 6);
  });

  it("formats inches to three decimals and millimeters to two", () => {
    expect(formatRotorValue(1.027, "in")).toBe("1.027");
    expect(formatRotorValue(26.09, "mm")).toBe("26.09");
  });

  it("requires both rotor readings on a front-only brake booking", () => {
    const result = validateInspectionMeasurements({
      tire_tread: completeTread(),
      brakes: {
        rotor_thickness: {
          front_left: {
            entered_value: 1.027,
            entered_unit: "in",
            normalized_um: 26086,
          },
        },
      },
      brake_scope: { hasBrakeWork: true, front: true, rear: false },
    });

    expect(result).toEqual({
      valid: false,
      error: "Front right rotor thickness is required for this brake job.",
    });
  });

  it("does not require rotor readings for non-brake work", () => {
    expect(
      validateInspectionMeasurements({
        tire_tread: completeTread(),
        brakes: null,
        brake_scope: { hasBrakeWork: false, front: false, rear: false },
      }),
    ).toEqual({ valid: true });
  });

  it("requires rear rotors but not front rotors for rear-only work", () => {
    const rearLeft = {
      entered_value: 0.45,
      entered_unit: "in" as const,
      normalized_um: 11430,
    };
    expect(
      validateInspectionMeasurements({
        tire_tread: completeTread(),
        brakes: { rotor_thickness: { rear_left: rearLeft } },
        brake_scope: { hasBrakeWork: true, front: false, rear: true },
      }),
    ).toEqual({
      valid: false,
      error: "Rear right rotor thickness is required for this brake job.",
    });
  });

  it("requires both axles when both are in scope", () => {
    const reading = {
      entered_value: 1,
      entered_unit: "in" as const,
      normalized_um: 25400,
    };
    expect(
      validateInspectionMeasurements({
        tire_tread: completeTread(),
        brakes: {
          rotor_thickness: {
            front_left: reading,
            front_right: reading,
            rear_left: reading,
          },
        },
        brake_scope: { hasBrakeWork: true, front: true, rear: true },
      }),
    ).toEqual({
      valid: false,
      error: "Rear right rotor thickness is required for this brake job.",
    });
  });
});

describe("customer inspection snapshot", () => {
  it("keeps reported tire minimums and entered rotor values only", () => {
    expect(
      buildCustomerInspectionSnapshot({
        tire_tread: {
          front_left: {
            reported_min_32nds: 6,
            inner_32nds: 6,
            center_32nds: 7,
            outer_32nds: 8,
          },
          front_right: { reported_min_32nds: 7 },
          rear_left: { reported_min_32nds: 8 },
          rear_right: { reported_min_32nds: 9 },
        },
        brakes: {
          rotor_thickness: {
            front_left: {
              entered_value: 1.027,
              entered_unit: "in",
              normalized_um: 26086,
            },
          },
        },
      }),
    ).toEqual({
      tire_tread_32nds: {
        front_left: 6,
        front_right: 7,
        rear_left: 8,
        rear_right: 9,
      },
      rotor_thickness: {
        front_left: { entered_value: 1.027, entered_unit: "in" },
      },
    });
  });
});
