const DEFAULT_NO_SHOW_THRESHOLD_MINUTES = 30;
const MIN_NO_SHOW_THRESHOLD_MINUTES = 15;
const MAX_NO_SHOW_THRESHOLD_MINUTES = 60;
const DEFAULT_OVERRUN_EXTENSION_PERCENT = 25;
const DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES = 15;

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function getCustomerLateReminderOffsets(thresholdMinutes: number) {
  const threshold = clampNumber(
    thresholdMinutes || DEFAULT_NO_SHOW_THRESHOLD_MINUTES,
    MIN_NO_SHOW_THRESHOLD_MINUTES,
    MAX_NO_SHOW_THRESHOLD_MINUTES
  );

  return {
    pushMinutes: Math.min(Math.floor(threshold / 3), 10),
    smsMinutes: Math.min(Math.floor((threshold * 2) / 3), 20),
    thresholdMinutes: threshold,
  };
}

export function getDefaultOverrunExtensionMinutes(
  estimatedMinutes: number,
  {
    percent = DEFAULT_OVERRUN_EXTENSION_PERCENT,
    floorMinutes = DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES,
  }: {
    percent?: number;
    floorMinutes?: number;
  } = {}
) {
  const duration = Math.max(1, Math.floor(estimatedMinutes || 0));
  const percentExtension = Math.ceil((duration * Math.max(1, percent)) / 100);
  return Math.max(percentExtension, Math.max(1, Math.floor(floorMinutes)));
}
