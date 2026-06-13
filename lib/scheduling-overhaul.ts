export const DEFAULT_NO_SHOW_THRESHOLD_MINUTES = 30;
export const MIN_NO_SHOW_THRESHOLD_MINUTES = 15;
export const MAX_NO_SHOW_THRESHOLD_MINUTES = 60;
export const DEFAULT_OVERRUN_EXTENSION_PERCENT = 25;
export const DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES = 15;
export const OVERRUN_EXTENSION_OPTIONS_MINUTES = [15, 30, 45, 60] as const;
export const DEFAULT_OVERRUN_ESCALATION_MINUTES = 3;
export const DEFAULT_OVERRUN_AUTO_APPLY_MINUTES = 6;
export const MIN_OVERRUN_ESCALATION_MINUTES = 1;
export const MAX_OVERRUN_ESCALATION_MINUTES = 30;
export const MIN_OVERRUN_AUTO_APPLY_MINUTES = 1;
export const MAX_OVERRUN_AUTO_APPLY_MINUTES = 60;

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

export function normalizeOverrunEscalationMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_OVERRUN_ESCALATION_MINUTES;
  }
  return Math.min(
    MAX_OVERRUN_ESCALATION_MINUTES,
    Math.max(MIN_OVERRUN_ESCALATION_MINUTES, Math.round(value)),
  );
}

export function normalizeOverrunAutoApplyMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_OVERRUN_AUTO_APPLY_MINUTES;
  }
  return Math.min(
    MAX_OVERRUN_AUTO_APPLY_MINUTES,
    Math.max(MIN_OVERRUN_AUTO_APPLY_MINUTES, Math.round(value)),
  );
}

/**
 * Validates the overrun escalation/auto-apply pair before persisting.
 * Auto-apply must be >= escalation so front desk always gets a chance to
 * intervene before the system applies the default extension.
 */
export function validateOverrunTimingMinutes(
  escalationMinutes: number,
  autoApplyMinutes: number,
): void {
  if (
    !Number.isFinite(escalationMinutes) ||
    escalationMinutes < MIN_OVERRUN_ESCALATION_MINUTES ||
    escalationMinutes > MAX_OVERRUN_ESCALATION_MINUTES
  ) {
    throw new Error(
      `Front desk escalation must be between ${MIN_OVERRUN_ESCALATION_MINUTES} and ${MAX_OVERRUN_ESCALATION_MINUTES} minutes.`,
    );
  }
  if (
    !Number.isFinite(autoApplyMinutes) ||
    autoApplyMinutes < MIN_OVERRUN_AUTO_APPLY_MINUTES ||
    autoApplyMinutes > MAX_OVERRUN_AUTO_APPLY_MINUTES
  ) {
    throw new Error(
      `Auto-apply must be between ${MIN_OVERRUN_AUTO_APPLY_MINUTES} and ${MAX_OVERRUN_AUTO_APPLY_MINUTES} minutes.`,
    );
  }
  if (autoApplyMinutes < escalationMinutes) {
    throw new Error(
      "Auto-apply must be at or after the front desk escalation mark.",
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
