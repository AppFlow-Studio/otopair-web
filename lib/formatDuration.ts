/**
 * formatDurationForCar
 *
 * Formats a labor-hours number into a short, human-readable duration:
 *   0.28 → "17 mins"
 *   1    → "1 hr"
 *   1.5  → "1 hr 30 mins"
 *   2    → "2 hrs"
 *   2.25 → "2 hrs 15 mins"
 *
 * Returns null when there's nothing meaningful to display so callers can omit
 * the line entirely.
 */
export function formatDurationForCar(hours: number | undefined | null): string | null {
  if (hours == null || hours <= 0) return null;
  const totalMins = Math.round(hours * 60);
  if (totalMins <= 0) return null;

  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;

  const hLabel = h === 1 ? "1 hr" : `${h} hrs`;
  const mLabel = m === 1 ? "1 min" : `${m} mins`;

  if (h === 0) return mLabel;
  if (m === 0) return hLabel;
  return `${hLabel} ${mLabel}`;
}
