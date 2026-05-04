// Shared tire brand list, tier classifications, and utilities used by all scrapers.
// Multi-word brands listed before single-word so startsWith() matches greedily.

// ─── Speed rating ──────────────────────────────────────────────────

export const SPEED_RATING_RANK: Record<string, number> = {
  N: 1, P: 2, Q: 3, R: 4, S: 5, T: 6, H: 7, V: 8, W: 9, Y: 10, Z: 11,
};

export function meetsSpeedRating(actual: string | undefined, required: string | undefined): boolean {
  if (!required) return true;
  if (!actual) return true;
  return (SPEED_RATING_RANK[actual.toUpperCase()] ?? 0) >= (SPEED_RATING_RANK[required.toUpperCase()] ?? 0);
}

/** Normalizes a tire model name for cross-site matching. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function mapTireType(text: string): string | undefined {
  const s = text.toLowerCase();
  if (s.includes("all-terrain") || s.includes("all terrain")) return "All-Terrain";
  if (s.includes("all weather") || s.includes("all-weather"))  return "All-Weather";
  if (s.includes("all season")  || s.includes("all-season"))   return "All-Season";
  if (s.includes("winter") || s.includes("snow"))              return "Winter";
  if (s.includes("uhp summer") || s.includes("summer"))        return "Summer";
  if (s.includes("uhp") || s.includes("performance"))          return "Performance";
  if (s.includes("touring") || s.includes("highway"))          return "Touring";
  if (s.includes("racing"))                                     return "Performance";
  return undefined;
}
