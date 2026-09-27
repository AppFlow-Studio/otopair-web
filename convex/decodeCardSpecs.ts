/**
 * decodeCardSpecs.ts — on-demand spec fill for the VIN-decode review card.
 *
 * The decode step (processVin) only surfaces what the VIN decoder (CarAPI) +
 * NHTSA carry. On the CarAPI path that is NO fuel economy and NO tire size, so
 * the "VEHICLE DETECTED" review card shows "—" for MPG + Tires. Those specs
 * live in enrichment sources that don't run until AFTER the user confirms the
 * vehicle. This public action front-runs the SAME two sources so the card can
 * show them before the user commits:
 *   - EPA fueleconomy.gov  → MPG (city/hwy/combined) + est. annual fuel cost
 *   - wheel-size.com API   → OEM tire fitment (size + pressure)
 *
 * Fail-open end to end: any miss returns null and the tile stays "—". Never
 * throws — safe to call speculatively from the review screen.
 */

import { v } from "convex/values";
import { action } from "./_generated/server";
import {
  fetchEpaMenuOptions,
  pickBestEpaVehicle,
  fetchEpaVehicleRecord,
  parseEpaOptionEngine,
  type EpaMenuOption,
} from "./vehicleEnrichment/epaFuelEconomy";
import { scrapeWheelSizeOptions } from "./vehicleEnrichment/utils/wheelSizeScraper";

export interface DecodeCardSpecs {
  mpgCity: number | null;
  mpgHighway: number | null;
  mpgCombined: number | null;
  fuelCostPerYearUsd: number | null;
  /** Upper end of an MPG range, set only when the VIN can't tell two
   *  near-identical EPA listings apart (a 2018 M3 is 17/24 as a DCT and
   *  17/25 as a manual). Null when the figure is exact. */
  mpgCityMax: number | null;
  mpgHighwayMax: number | null;
  mpgCombinedMax: number | null;
  /** Gearbox label(s) from EPA's listings for this engine — "7-spd DCT", or
   *  "6-spd Manual / 7-spd DCT" when the VIN doesn't pin one. The card uses
   *  it when the decode carries no transmission. */
  transmissionLabel: string | null;
  frontTireSize: string | null;
  rearTireSize: string | null;
  frontTirePressure: number | null;
  rearTirePressure: number | null;
}

/**
 * EPA files Mercedes-AMG under a REORDERED model name that the generic
 * candidate list never produces (it derives from our model "G-Class" + trim).
 * Verified against /vehicle/menu/model: "AMG G63", "AMG GLE63 S 4matic Plus",
 * "AMG CLE53 4matic Plus (coupe)", "AMG GT 63 4matic Plus" — the AMG GT line
 * keeps a space before the badge, and most names carry the full drive suffix.
 * The old single-name builder produced "AMG AMG63" for the AMG GT and a bare
 * "AMG CLE53" that EPA doesn't list, so both cards showed no MPG. Returns the
 * exact names to try, most specific first; [] when not applicable.
 */
function amgEpaModelNames(make: string, model: string, trim?: string): string[] {
  if (!/mercedes/i.test(make)) return [];
  const t = trim ?? "";
  const badgeMatch = t.match(/\b(?:[A-Z]{1,3})?(35|43|45|53|55|63|65)(\s*S)?\b/i);
  if (!badgeMatch) return [];
  const badge = badgeMatch[1];
  const sSuffix = badgeMatch[2] ? " S" : "";
  // "GLE-Class AMG" → "GLE", "AMG GT" → "GT".
  const base = model
    .replace(/^\s*AMG\s+/i, "")
    .replace(/-?class\b/i, "")
    .replace(/\bAMG\b/i, "")
    .trim()
    .split(/\s+/)[0];
  if (!base) return [];
  const name = /^gt$/i.test(base) ? `AMG GT ${badge}${sSuffix}` : `AMG ${base}${badge}${sSuffix}`;
  return [
    `${name} 4matic Plus`,
    `${name} 4matic Plus (coupe)`,
    `${name} 4matic Plus Coupe`,
    `${name} 4matic`,
    name,
  ];
}

/**
 * EPA option text → a gearbox label. The text is "<trans>, <cyl>, <displ>…":
 * "Auto (AM-S7)" is an automated manual (DCT), "Auto (S8)"/"Auto (A6)" a
 * torque-converter automatic, "Auto (AV-S7)"/"Auto (variable gear ratios)"
 * a CVT, "Man 6-spd" a manual. Null when unparseable.
 */
export function epaTransmissionLabel(optionText: string): string | null {
  const head = String(optionText ?? "").split(",")[0].trim();
  const man = head.match(/^man(?:ual)?\s*(\d+)[- ]?spd/i);
  if (man) return `${man[1]}-spd Manual`;
  if (!/^auto/i.test(head)) return null;
  // "Auto 9-spd" — EPA's other spelling, no parenthesised code.
  const plain = head.match(/^auto(?:matic)?\s*(\d+)[- ]?spd/i);
  if (plain) return `${plain[1]}-spd Automatic`;
  const code = head.match(/\(([^)]*)\)/)?.[1] ?? "";
  if (/^AV|variable/i.test(code)) return "CVT";
  const speeds = code.match(/(\d+)/)?.[1];
  if (/^AM/i.test(code)) return speeds ? `${speeds}-spd DCT` : "DCT";
  return speeds ? `${speeds}-spd Automatic` : "Automatic";
}

/** EPA listings whose engine matches the decode (same filter the picker uses). */
function engineMatchingOptions(
  options: EpaMenuOption[],
  displacementL?: number,
  cylinders?: number,
): EpaMenuOption[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    if (typeof o?.text !== "string" || seen.has(o.text)) return false;
    seen.add(o.text);
    const e = parseEpaOptionEngine(o.text);
    if (displacementL != null && (e.displacement_l == null || Math.abs(e.displacement_l - displacementL) > 0.05)) {
      return false;
    }
    if (cylinders != null && e.cylinders != null && e.cylinders !== cylinders) return false;
    return true;
  });
}

// Two listings closer than this (mpg) read as one figure with a small range.
// Wider than this and the powertrains are genuinely different — show "—".
const MPG_RANGE_TOLERANCE = 2;
const MAX_AMBIGUOUS_LISTINGS = 4;

async function fetchMpg(a: {
  year: number; make: string; model: string; trim?: string;
  displacementL?: number; cylinders?: number; transType?: string; drivetrain?: string;
}): Promise<Partial<DecodeCardSpecs>> {
  try {
    let options = await fetchEpaMenuOptions(
      a.year, a.make, a.model, a.drivetrain ?? null, a.trim ?? null,
    );
    if (!options?.length) {
      // AMG fallback — EPA's reordered "AMG G63"-style naming.
      for (const amg of amgEpaModelNames(a.make, a.model, a.trim)) {
        const alt = await fetchEpaMenuOptions(a.year, a.make, amg, null, null);
        if (alt?.length) {
          options = alt;
          break;
        }
      }
    }
    if (!options?.length) return {};
    const picked = pickBestEpaVehicle(options, {
      displacement_l: a.displacementL ?? null,
      cylinders: a.cylinders ?? null,
      transmission_type: a.transType ?? null,
    });
    if (picked) {
      const rec = await fetchEpaVehicleRecord(picked.value);
      if (!rec) return {};
      return {
        mpgCity: rec.mpg_city,
        mpgHighway: rec.mpg_highway,
        mpgCombined: rec.mpg_combined,
        fuelCostPerYearUsd: rec.fuel_cost_per_year_usd,
        transmissionLabel: epaTransmissionLabel(picked.text),
      };
    }

    // Ambiguous: several listings share the decoded engine and the VIN
    // doesn't say which gearbox (manual vs DCT is invisible in a VIN).
    // pickBestEpaVehicle refuses to guess — right for enrichment claims, but
    // on this display card near-identical listings can honestly show as a
    // range, and the gearbox choices as "A / B".
    const matching = engineMatchingOptions(options, a.displacementL, a.cylinders);
    if (matching.length < 2 || matching.length > MAX_AMBIGUOUS_LISTINGS) return {};
    const labels = [...new Set(matching.map((o) => epaTransmissionLabel(o.text)).filter(Boolean))];
    const transmissionLabel = labels.length ? (labels as string[]).join(" / ") : null;
    const recs = (await Promise.all(matching.map((o) => fetchEpaVehicleRecord(o.value))))
      .filter((r): r is NonNullable<typeof r> => !!r);
    if (recs.length !== matching.length) return { transmissionLabel };
    const span = (pick: (r: (typeof recs)[number]) => number | null) => {
      const vals = recs.map(pick).filter((n): n is number => typeof n === "number");
      if (vals.length !== recs.length) return null;
      return { min: Math.min(...vals), max: Math.max(...vals) };
    };
    const city = span((r) => r.mpg_city);
    const hwy = span((r) => r.mpg_highway);
    const comb = span((r) => r.mpg_combined);
    const cost = span((r) => r.fuel_cost_per_year_usd);
    const close = (x: { min: number; max: number } | null) =>
      !!x && x.max - x.min <= MPG_RANGE_TOLERANCE;
    if (!close(city) || !close(hwy)) return { transmissionLabel };
    const maxOrNull = (x: { min: number; max: number } | null) =>
      x && x.max !== x.min ? x.max : null;
    return {
      mpgCity: city!.min,
      mpgHighway: hwy!.min,
      mpgCombined: comb?.min ?? null,
      mpgCityMax: maxOrNull(city),
      mpgHighwayMax: maxOrNull(hwy),
      mpgCombinedMax: maxOrNull(comb),
      // The dearer listing — the estimate should not flatter the car.
      fuelCostPerYearUsd: cost?.max ?? null,
      transmissionLabel,
    };
  } catch {
    return {};
  }
}

async function fetchTires(a: {
  year: number; make: string; model: string; trim?: string; displacementL?: number;
}): Promise<Partial<DecodeCardSpecs>> {
  try {
    const res = await scrapeWheelSizeOptions(a.year, a.make, a.model, a.trim, a.displacementL ?? null);
    if (!res?.tireOptions?.length) return {};
    const oem = res.tireOptions.find((t) => t.is_oem_standard) ?? res.tireOptions[0];
    return {
      frontTireSize: oem.size_front ?? null,
      rearTireSize: oem.size_rear ?? null,
      frontTirePressure: oem.pressure_front_psi ?? null,
      rearTirePressure: oem.pressure_rear_psi ?? null,
    };
  } catch {
    return {};
  }
}

/**
 * Fetch MPG + tire specs for the decode review card. Both lookups run in
 * parallel and fail open independently — a dead source just leaves its fields
 * null. Newest model years (or AMG naming quirks) that neither source has yet
 * simply return nulls; the card renders "—".
 */
export const getDecodeCardSpecs = action({
  args: {
    year: v.number(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    displacementL: v.optional(v.number()),
    cylinders: v.optional(v.number()),
    transType: v.optional(v.string()),
    drivetrain: v.optional(v.string()),
  },
  handler: async (_ctx, a): Promise<DecodeCardSpecs> => {
    const [mpg, tires] = await Promise.all([fetchMpg(a), fetchTires(a)]);
    return {
      mpgCity: null, mpgHighway: null, mpgCombined: null, fuelCostPerYearUsd: null,
      mpgCityMax: null, mpgHighwayMax: null, mpgCombinedMax: null, transmissionLabel: null,
      frontTireSize: null, rearTireSize: null, frontTirePressure: null, rearTirePressure: null,
      ...mpg, ...tires,
    };
  },
});
