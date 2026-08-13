import {
  TIRE_POSITIONS,
  formatRotorValue,
  type CustomerInspectionSnapshot,
  type TirePosition,
} from "./inspection-measurements";

export type { CustomerInspectionSnapshot };

export type InspectionFindingSection = {
  title: string;
  values: { label: string; value: string }[];
};

const POSITION_LABELS: Record<TirePosition, string> = {
  front_left: "Front left",
  front_right: "Front right",
  rear_left: "Rear left",
  rear_right: "Rear right",
};

export function buildInspectionFindingRows(
  snapshot: CustomerInspectionSnapshot | null | undefined,
): InspectionFindingSection[] {
  if (!snapshot) return [];

  const sections: InspectionFindingSection[] = [];
  const tireValues = TIRE_POSITIONS.flatMap((position) => {
    const value = snapshot.tire_tread_32nds?.[position];
    return typeof value === "number"
      ? [{ label: POSITION_LABELS[position], value: `${value}/32"` }]
      : [];
  });
  if (tireValues.length > 0) {
    sections.push({ title: "Tire tread", values: tireValues });
  }

  const rotorValues = TIRE_POSITIONS.flatMap((position) => {
    const reading = snapshot.rotor_thickness?.[position];
    return reading
      ? [
          {
            label: POSITION_LABELS[position],
            value: `${formatRotorValue(
              reading.entered_value,
              reading.entered_unit,
            )} ${reading.entered_unit}`,
          },
        ]
      : [];
  });
  if (rotorValues.length > 0) {
    sections.push({ title: "Rotor thickness", values: rotorValues });
  }

  return sections;
}
