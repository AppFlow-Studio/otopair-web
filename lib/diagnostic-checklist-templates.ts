export type DiagnosticSystem =
  | "brakes"
  | "tires_wheels"
  | "engine"
  | "battery_electrical"
  | "not_sure";

export type DiagnosticChecklistItemStatus = "pending" | "checked" | "skipped";

export interface DiagnosticChecklistItem {
  label: string;
  status: DiagnosticChecklistItemStatus;
  mechanic_note?: string;
}

const TEMPLATES: Record<DiagnosticSystem, string[]> = {
  brakes: [
    "Pad thickness front",
    "Pad thickness rear",
    "Rotor condition",
    "Caliper movement",
    "Brake fluid level & color",
    "Pedal feel & travel",
  ],
  tires_wheels: [
    "Tread depth check",
    "Wheel balance",
    "Alignment scan",
    "Bearing inspection",
    "TPMS read",
    "Suspension visual",
  ],
  engine: [
    "OBD-II scan",
    "Idle smoothness",
    "Coolant level & condition",
    "Oil level & condition",
    "Belt & hose visual",
    "Engine mount inspection",
  ],
  battery_electrical: [
    "Battery voltage at rest",
    "Cranking voltage",
    "Alternator output",
    "Ground & terminal condition",
    "Parasitic draw test",
    "Lighting & accessory check",
  ],
  not_sure: [
    "Customer ride-along / symptom replication",
    "Exterior walk-around",
    "Under-hood visual",
    "Underbody visual",
    "OBD-II scan",
    "Test drive observations",
  ],
};

export function templateForSystem(system: DiagnosticSystem): DiagnosticChecklistItem[] {
  return TEMPLATES[system].map((label) => ({ label, status: "pending" }));
}
