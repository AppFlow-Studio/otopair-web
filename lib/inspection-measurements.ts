export const TIRE_POSITIONS = [
  "front_left",
  "front_right",
  "rear_left",
  "rear_right",
] as const;

export type TirePosition = (typeof TIRE_POSITIONS)[number];
export type TireCornerPosition = "FL" | "FR" | "RL" | "RR";
export type RotorUnit = "in" | "mm";

export function areTireReplacementPositionsValid(
  quantity: number,
  positions?: readonly TireCornerPosition[] | null,
): boolean {
  return (
    !!positions?.length &&
    positions.length === quantity &&
    new Set(positions).size === positions.length
  );
}

export function getBookedTireReplacementPositions(specs?: {
  quantity?: number | null;
  positions?: readonly TireCornerPosition[] | null;
} | null): TireCornerPosition[] {
  return specs?.positions ? [...specs.positions] : [];
}

export type TireTreadReading = {
  reported_min_32nds?: number | null;
  inner_32nds?: number | null;
  center_32nds?: number | null;
  outer_32nds?: number | null;
};

export type TireTreadMeasurements = Partial<
  Record<TirePosition, TireTreadReading>
>;

export type RotorThicknessReading = {
  entered_value: number;
  entered_unit: RotorUnit;
  normalized_um: number;
};

export type RotorThicknessMeasurements = Partial<
  Record<TirePosition, RotorThicknessReading>
>;

export type InspectionMeasurementsInput = {
  tire_tread?: TireTreadMeasurements | null;
  tire_replacement_positions?: TirePosition[];
  require_tire_tread?: boolean;
  brakes?: {
    rotor_thickness?: RotorThicknessMeasurements | null;
  } | null;
  brake_scope: {
    hasBrakeWork: boolean;
    front: boolean;
    rear: boolean;
  };
};

export type CustomerInspectionSnapshot = {
  tire_tread_32nds?: Partial<Record<TirePosition, number>>;
  rotor_thickness?: Partial<
    Record<
      TirePosition,
      Pick<RotorThicknessReading, "entered_value" | "entered_unit">
    >
  >;
};

export type InspectionValidationResult =
  | { valid: true }
  | { valid: false; error: string };

const POSITION_LABELS: Record<TirePosition, string> = {
  front_left: "Front left",
  front_right: "Front right",
  rear_left: "Rear left",
  rear_right: "Rear right",
};

export function isValidTreadDepth(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 32
  );
}

export function getTireTreadMinimum(
  reading: TireTreadReading | null | undefined,
): number | null {
  if (!reading) return null;
  const details = [
    reading.inner_32nds,
    reading.center_32nds,
    reading.outer_32nds,
  ];
  const hasAnyDetails = details.some((value) => value != null);
  if (hasAnyDetails) {
    if (!details.every(isValidTreadDepth)) return null;
    return Math.min(...(details as number[]));
  }
  return isValidTreadDepth(reading.reported_min_32nds)
    ? reading.reported_min_32nds
    : null;
}

export function rotorValueToMicrometers(
  value: number,
  unit: RotorUnit,
): number {
  return Math.round(unit === "in" ? value * 25_400 : value * 1_000);
}

export function convertRotorValue(
  value: number,
  from: RotorUnit,
  to: RotorUnit,
): number {
  if (from === to) return value;
  return from === "in" ? value * 25.4 : value / 25.4;
}

export function formatRotorValue(value: number, unit: RotorUnit): string {
  return value.toFixed(unit === "in" ? 3 : 2);
}

export function formatRotorReferenceMinimum(valueMm: number, unit: RotorUnit): string {
  return `${formatRotorValue(convertRotorValue(valueMm, "mm", unit), unit)} ${unit}`;
}

function validateTreadReading(
  position: TirePosition,
  reading: TireTreadReading | undefined,
): InspectionValidationResult {
  const label = POSITION_LABELS[position];
  if (!reading || reading.reported_min_32nds == null) {
    return { valid: false, error: `${label} tread depth is required.` };
  }
  if (!isValidTreadDepth(reading.reported_min_32nds)) {
    return {
      valid: false,
      error: `${label} tread depth must be a whole number from 0 to 32.`,
    };
  }

  const details = [
    reading.inner_32nds,
    reading.center_32nds,
    reading.outer_32nds,
  ];
  if (details.some((value) => value != null)) {
    if (!details.every(isValidTreadDepth)) {
      return {
        valid: false,
        error: `${label} inner, center, and outer tread readings must all be whole numbers from 0 to 32.`,
      };
    }
    const minimum = Math.min(...(details as number[]));
    if (reading.reported_min_32nds !== minimum) {
      return {
        valid: false,
        error: `${label} reported tread depth must match the shallowest detailed reading.`,
      };
    }
  }
  return { valid: true };
}

function validateRotorReading(
  position: TirePosition,
  reading: RotorThicknessReading | undefined,
): InspectionValidationResult {
  const label = POSITION_LABELS[position];
  if (!reading) {
    return {
      valid: false,
      error: `${label} rotor thickness is required for this brake job.`,
    };
  }
  if (
    !Number.isFinite(reading.entered_value) ||
    reading.entered_value <= 0 ||
    !Number.isInteger(reading.normalized_um) ||
    reading.normalized_um <= 0 ||
    rotorValueToMicrometers(reading.entered_value, reading.entered_unit) !==
      reading.normalized_um
  ) {
    return {
      valid: false,
      error: `${label} rotor thickness is invalid.`,
    };
  }
  return { valid: true };
}

export function validateInspectionMeasurements(
  input: InspectionMeasurementsInput,
): InspectionValidationResult {
  if (input.require_tire_tread !== false) {
    for (const position of TIRE_POSITIONS) {
      if (
        input.tire_replacement_positions?.includes(position) &&
        !input.tire_tread?.[position]
      ) {
        continue;
      }
      const result = validateTreadReading(
        position,
        input.tire_tread?.[position],
      );
      if (!result.valid) return result;
    }
  }

  if (!input.brake_scope.hasBrakeWork) return { valid: true };

  const requiredRotorPositions: TirePosition[] = [];
  if (input.brake_scope.front) {
    requiredRotorPositions.push("front_left", "front_right");
  }
  if (input.brake_scope.rear) {
    requiredRotorPositions.push("rear_left", "rear_right");
  }
  for (const position of requiredRotorPositions) {
    const result = validateRotorReading(
      position,
      input.brakes?.rotor_thickness?.[position],
    );
    if (!result.valid) return result;
  }
  return { valid: true };
}

export function validateInspectionMeasurementDraft(input: {
  tire_tread?: TireTreadMeasurements | null;
  brakes?: {
    rotor_thickness?: RotorThicknessMeasurements | null;
  } | null;
}): InspectionValidationResult {
  for (const position of TIRE_POSITIONS) {
    const reading = input.tire_tread?.[position];
    if (reading) {
      for (const value of [
        reading.reported_min_32nds,
        reading.inner_32nds,
        reading.center_32nds,
        reading.outer_32nds,
      ]) {
        if (value != null && !isValidTreadDepth(value)) {
          return {
            valid: false,
            error: `${POSITION_LABELS[position]} tread readings must be whole numbers from 0 to 32.`,
          };
        }
      }
    }
    const rotor = input.brakes?.rotor_thickness?.[position];
    if (rotor) {
      const result = validateRotorReading(position, rotor);
      if (!result.valid) return result;
    }
  }
  return { valid: true };
}

export function buildCustomerInspectionSnapshot(input: {
  tire_tread?: TireTreadMeasurements | null;
  brakes?: {
    rotor_thickness?: RotorThicknessMeasurements | null;
  } | null;
}): CustomerInspectionSnapshot | null {
  const tireTread: Partial<Record<TirePosition, number>> = {};
  const rotorThickness: CustomerInspectionSnapshot["rotor_thickness"] = {};

  for (const position of TIRE_POSITIONS) {
    const reported = input.tire_tread?.[position]?.reported_min_32nds;
    if (isValidTreadDepth(reported)) {
      tireTread[position] = reported;
    }
    const rotor = input.brakes?.rotor_thickness?.[position];
    if (rotor) {
      rotorThickness[position] = {
        entered_value: rotor.entered_value,
        entered_unit: rotor.entered_unit,
      };
    }
  }

  const snapshot: CustomerInspectionSnapshot = {};
  if (Object.keys(tireTread).length > 0) {
    snapshot.tire_tread_32nds = tireTread;
  }
  if (Object.keys(rotorThickness).length > 0) {
    snapshot.rotor_thickness = rotorThickness;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}
