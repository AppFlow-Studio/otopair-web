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

// MAKE/MODEL slugs ONLY. OLP engine slugs contain literal dots ("1.5l-i4-turbo")
// which this would mangle to "1-5l..." — engine slugs must always be taken from
// the API's vehicles[].engineSlug, never constructed.
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

/**
 * Ordered model-slug candidates, most specific first. OLP keys models by
 * trim-qualified nameplate (civic, civic-si, civic-type-r) — same shape as
 * RepairPal, so same candidate strategy as repairpalModelCandidates:
 *   ("5 Series", "M550i xDrive") → 5-series-m550i-xdrive, m550i-xdrive,
 *                                  m550i, 5-series
 */
export function olpModelCandidates(model: string, trim: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = olpSlugify(s);
    if (v && !out.includes(v)) out.push(v);
  };
  if (trim) {
    add(`${model} ${trim}`);
    add(trim);
    add(trim.replace(/xdrive/i, "").trim());
  }
  add(model);
  return out;
}

export type OlpVehicleRow = {
  vehicleId?: string;
  yearRange?: string;
  displayYear: string;
  engine: string;
  engineSlug: string;
  fuelType?: string | null;
  timingType?: string | null;
  forcedInduction?: string | null;
  jobCount?: number;
};

export type EngineHints = {
  displacementL: number | null; // 1.5
  cylinders: number | null; // 4
  turbo: boolean | null; // any forced induction
};

/**
 * Pick the best year+engine row from a model-browse vehicles[] list.
 * Year is a hard filter (rows are per single displayYear). Engines are
 * scored: displacement match +4, cylinder count +2, forced-induction
 * agreement +1 — displacement dominates because it is the most reliable
 * field on both sides. Equal scores tie-break by array position (first
 * row wins) — only reachable when displacement is missing from our DB.
 */
export function pickOlpVehicle(
  vehicles: OlpVehicleRow[],
  year: number,
  hints: EngineHints,
): OlpVehicleRow | null {
  const rows = vehicles.filter((r) => r.displayYear === String(year));
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  let best: OlpVehicleRow | null = null;
  let bestScore = -1;
  for (const r of rows) {
    const slug = r.engineSlug.toLowerCase();
    let score = 0;
    if (hints.displacementL != null) {
      // OLP slugs always carry one decimal: "2.0l-i4", "1.5l-i4-turbo"
      if (slug.startsWith(`${hints.displacementL.toFixed(1)}l`)) score += 4;
    }
    if (hints.cylinders != null) {
      const m = slug.match(/[ivwhf](\d{1,2})\b/); // i4, v6, h6, w12
      if (m && Number(m[1]) === hints.cylinders) score += 2;
    }
    if (hints.turbo != null) {
      const rowTurbo =
        /turbo|supercharg/.test(slug) || (r.forcedInduction ?? "") === "turbo";
      if (rowTurbo === hints.turbo) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}
