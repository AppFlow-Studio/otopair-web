/**
 * vehicleEnrichment/olpLabor.ts — Open Labor Project (openlaborproject.com)
 * pure helpers. NO ctx/network — unit-tested in tests/olpLabor.test.ts.
 *
 * OLP is a Next.js (Pages Router) site. Every page has a JSON data route
 *   /_next/data/{buildId}/...json
 * and the portal route's pageProps.laborJobs carries a car's FULL labor list
 * as {name, slug, category, laborHours} — hours are DIRECT (no Estimator
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
 * Estimator, so same candidate strategy as estimatorModelCandidates:
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

export type OlpLaborJob = {
  name: string;
  slug: string;
  category: string;
  laborHours: number;
};

/** Plausible wrench-time bounds; outside ⇒ page/format drift, don't trust. */
export const OLP_HOURS_MIN = 0.05;
export const OLP_HOURS_MAX = 60;

type JobMapEntry = {
  slugs: string[];
  nameRe?: RegExp;
  /** cylinder count → preferred OLP slug (e.g. 8 → "spark-plugs-v8"). When the
   *  resolver knows the engine's cylinders and the page carries this row, it
   *  wins over the generic first slug. */
  cylinderSlugs?: Record<number, string>;
};

/**
 * Our service slugs (the 13 keys of LABOR_SERVICE_CONFIG in
 * services/laborDeterminant.ts) → ordered OLP job-slug candidates, verified
 * against real OLP data (2018 Civic, 2026-06-12). First PRESENT candidate
 * supplies the comparison hours; all matches are reported. nameRe is a
 * fallback for cars whose job list uses a variant slug we haven't seen.
 */
export const OLP_JOB_MAP: Record<string, JobMapEntry> = {
  oil_change: {
    // Plain slug first: "oil-change" is the full oil+filter service (0.3–0.6h)
    // and is the scope match for our oil_change. "oil-change-synthetic" is a
    // drain-fill-only step (~0.3h) that undershoots; keep it as fallback.
    slugs: ["oil-change", "oil-change-synthetic", "oil-change-diesel"],
    nameRe: /^oil change/i,
  },
  spark_plugs: {
    slugs: ["spark-plugs", "spark-plugs-v6", "spark-plugs-v8"],
    cylinderSlugs: { 6: "spark-plugs-v6", 8: "spark-plugs-v8" },
    nameRe: /^spark plugs/i,
  },
  timing_belt: { slugs: ["timing-belt", "timing-belt-kit"], nameRe: /^timing belt\b/i },
  brake_pad_replacement: { slugs: ["brake-pads-front", "brake-pads-rear"] },
  rotor_replacement: {
    // Pair-only rows FIRST — our rotor_replacement is rotors-only, so the
    // pads+rotors combo rows are last-resort comparators (bundled scope).
    slugs: [
      "brake-rotors-front-pair", "brake-rotors-rear-pair",
      "brake-pads-rotors-front", "brake-pads-rotors-rear",
    ],
  },
  battery_replacement: { slugs: ["battery", "battery-replacement"] },
  wheel_alignment: { slugs: ["wheel-alignment"] },
  filter_replacement: { slugs: ["air-filter", "engine-air-filter"] },
  coolant_flush: { slugs: ["coolant-flush"] },
  power_steering_flush: {
    slugs: ["power-steering-fluid-flush", "power-steering-service"],
  },
  transmission_service: {
    // All three slugs carry equivalent hours on the vehicles we've sampled —
    // no reorder needed (any +35% gap is real data disagreement, not a slug
    // scope mismatch; multi-source reconciliation is Phase 3).
    slugs: [
      "transmission-service", "trans-filter-fluid",
      "automatic-transmission-fluid-filter-change",
    ],
  },
  differential_service: {
    // Routine diff service = the FLUID change (~0.7h). The broader
    // "differential-service" row (~1.2h, includes inspection) is the fallback.
    slugs: ["differential-fluid-change", "differential-service"],
  },
  brake_fluid_flush: { slugs: ["brake-fluid-flush"] },
};

export type ServiceMatch = {
  service: string;
  olp_hours: number | null; // first sane match, in candidate order
  olp_jobs: Array<{ name: string; slug: string; hours: number; sane: boolean }>;
};

export function matchJobs(
  jobs: OlpLaborJob[],
  map: Record<string, JobMapEntry> = OLP_JOB_MAP,
  hints?: { cylinders?: number | null },
): ServiceMatch[] {
  const bySlug = new Map(jobs.map((j) => [j.slug, j]));
  const cyl = hints?.cylinders ?? null;
  return Object.entries(map).map(([service, entry]) => {
    const found: OlpLaborJob[] = [];
    // Cylinder-specific variant first when known and present on the page.
    const cylSlug = cyl != null ? entry.cylinderSlugs?.[cyl] : undefined;
    if (cylSlug) {
      const j = bySlug.get(cylSlug);
      if (j) found.push(j);
    }
    for (const s of entry.slugs) {
      const j = bySlug.get(s);
      if (j && !found.includes(j)) found.push(j);
    }
    if (found.length === 0 && entry.nameRe) {
      const j = jobs.find((x) => entry.nameRe!.test(x.name));
      if (j) found.push(j);
    }
    const olp_jobs = found.map((j) => ({
      name: j.name,
      slug: j.slug,
      hours: j.laborHours,
      sane: j.laborHours >= OLP_HOURS_MIN && j.laborHours <= OLP_HOURS_MAX,
    }));
    const first = olp_jobs.find((j) => j.sane);
    return { service, olp_hours: first ? first.hours : null, olp_jobs };
  });
}
