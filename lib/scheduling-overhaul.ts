export const DEFAULT_NO_SHOW_THRESHOLD_MINUTES = 30;
export const MIN_NO_SHOW_THRESHOLD_MINUTES = 15;
export const MAX_NO_SHOW_THRESHOLD_MINUTES = 60;
export const DEFAULT_OVERRUN_EXTENSION_PERCENT = 25;
export const DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES = 15;
export const OVERRUN_EXTENSION_OPTIONS_MINUTES = [15, 30, 45, 60] as const;

export type AssignmentPreference = "any" | "specific_mechanic";

export function normalizeAssignmentPreference(
  value: unknown,
): AssignmentPreference {
  return value === "specific_mechanic" ? "specific_mechanic" : "any";
}

export function normalizeNoShowThresholdMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_NO_SHOW_THRESHOLD_MINUTES;
  }
  return Math.min(
    MAX_NO_SHOW_THRESHOLD_MINUTES,
    Math.max(MIN_NO_SHOW_THRESHOLD_MINUTES, Math.round(value)),
  );
}

export function validateNoShowThresholdMinutes(value: number): void {
  if (
    !Number.isFinite(value) ||
    value < MIN_NO_SHOW_THRESHOLD_MINUTES ||
    value > MAX_NO_SHOW_THRESHOLD_MINUTES
  ) {
    throw new Error(
      `No-show threshold must be between ${MIN_NO_SHOW_THRESHOLD_MINUTES} and ${MAX_NO_SHOW_THRESHOLD_MINUTES} minutes.`,
    );
  }
}

export function getCustomerLateReminderOffsetsMs(thresholdMinutes: number): {
  pushOffsetMs: number;
  smsOffsetMs: number;
  thresholdOffsetMs: number;
} {
  const normalizedThreshold = normalizeNoShowThresholdMinutes(thresholdMinutes);
  return {
    pushOffsetMs:
      Math.min(normalizedThreshold / 3, 10) * 60 * 1000,
    smsOffsetMs:
      Math.min((normalizedThreshold * 2) / 3, 20) * 60 * 1000,
    thresholdOffsetMs: normalizedThreshold * 60 * 1000,
  };
}

export function roundUpToQuarterMinutes(minutes: number): number {
  return Math.max(15, Math.ceil(minutes / 15) * 15);
}

export function getDefaultOverrunExtensionMinutes(args: {
  estimatedMinutes?: number | null;
  percent?: number | null;
  floorMinutes?: number | null;
}): number {
  const estimatedMinutes =
    typeof args.estimatedMinutes === "number" && Number.isFinite(args.estimatedMinutes)
      ? Math.max(0, args.estimatedMinutes)
      : 60;
  const percent =
    typeof args.percent === "number" && Number.isFinite(args.percent)
      ? Math.max(0, args.percent)
      : DEFAULT_OVERRUN_EXTENSION_PERCENT;
  const floorMinutes =
    typeof args.floorMinutes === "number" && Number.isFinite(args.floorMinutes)
      ? Math.max(0, args.floorMinutes)
      : DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES;

  return roundUpToQuarterMinutes(
    Math.max((estimatedMinutes * percent) / 100, floorMinutes),
  );
}
