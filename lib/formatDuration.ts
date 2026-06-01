/**
 * formatDurationForCar
 *
 * Formats a labor-hours number (e.g. 0.4, 1.5, 5) into a short duration label
 * always expressed in minutes — e.g. "24 mins", "90 mins", "300 mins".
 *
 * Returns null when there's nothing meaningful to display so callers can omit
 * the line entirely.
 */
export function formatDurationForCar(hours: number | undefined | null): string | null {
  if (hours == null || hours <= 0) return null;
  const mins = Math.round(hours * 60);
  if (mins <= 0) return null;
  return `${mins} mins`;
}
