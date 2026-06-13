/**
 * vehicleEnrichment/olpLabor.ts — Open Labor Project (openlaborproject.com)
 * pure helpers. NO ctx/network — unit-tested in tests/olpLabor.test.ts.
 *
 * OLP is a Next.js (Pages Router) site. Every page has a JSON data route
 *   /_next/data/{buildId}/...json
 * and the portal route's pageProps.laborJobs carries a car's FULL labor list
 * as {name, slug, category, laborHours} — hours are DIRECT (no RepairPal
 * dollars→hours reversal, so no 1.47-ratio guardrail; we gate on a plain
 * hours range instead). The probe action lives in devOnly/olpProbe.ts.
 * Probe-only: nothing here writes to the DB or the pipeline.
 */

export const OLP_BASE = "https://openlaborproject.com";

export const olpSlugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** buildId from any OLP page's HTML (/_next/static/{id}/_ssgManifest.js). */
export function extractBuildId(html: string): string | null {
  const m = html.match(
    /\/_next\/static\/([A-Za-z0-9_-]+)\/_(?:ssgManifest|buildManifest)\.js/,
  );
  return m ? m[1] : null;
}

/**
 * JSON.parse that tolerates Firecrawl returning a JSON body wrapped in HTML.
 * Tries plain parse, then the substring between the first "{" and last "}"
 * with the two HTML entities that can appear in that wrapping decoded.
 */
export function parseJsonLoose(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(
        s.slice(a, b + 1).replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
      );
    } catch {}
  }
  return null;
}
