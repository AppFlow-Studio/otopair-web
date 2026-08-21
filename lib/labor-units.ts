// Labor-time UI unit helpers.
//
// The app stores/transports labor time in MINUTES (scheduling and the calendar
// math are minute/ms-based). Mechanics, however, quote and log labor in decimal
// HOURS (flat-rate practice, e.g. 0.5 = 30 min, 1.2 = 72 min). These helpers let
// input widgets present hours while converting to whole minutes at the boundary,
// leaving every downstream read/write byte-for-byte unchanged.

export const HOUR_STEP = 0.25; // quarter-hour keyboard step for hours inputs
export const MAX_LABOR_HOURS = 24;

/** Hours (decimal) → whole minutes. 0.5→30, 0.1→6, 1.7→102. */
export function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

/** Minutes → hours (decimal). */
export function minutesToHours(minutes: number): number {
  return minutes / 60;
}

/**
 * Format a stored minute value as an hours string for prefilling an hours input
 * or echoing it back next to the field. Trims trailing zeros and caps at 2
 * decimals: 30→"0.5", 90→"1.5", 42→"0.7", 25→"0.42", 0→"0".
 */
export function formatHoursValue(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0";
  const hours = minutes / 60;
  // 2 decimals is enough for whole-minute inputs; strip trailing zeros/dot.
  return hours.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Parse a free-text hours field. Returns null for blank / non-numeric /
 * out-of-range (< 0 or > MAX_LABOR_HOURS) so callers can treat "no value" and
 * "invalid" the same way they treat an empty estimate today.
 */
export function parseHoursInput(raw: string): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= MAX_LABOR_HOURS ? n : null;
}
