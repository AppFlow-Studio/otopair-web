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
} from "./vehicleEnrichment/epaFuelEconomy";
import { scrapeWheelSizeOptions } from "./vehicleEnrichment/utils/wheelSizeScraper";

export interface DecodeCardSpecs {
  mpgCity: number | null;
  mpgHighway: number | null;
  mpgCombined: number | null;
  fuelCostPerYearUsd: number | null;
  frontTireSize: string | null;
  rearTireSize: string | null;
  frontTirePressure: number | null;
  rearTirePressure: number | null;
}

/**
 * EPA files Mercedes-AMG under a REORDERED model name ("AMG G63", "AMG GLE63")
 * that the generic candidate list never produces (it derives from our model
 * "G-Class" + trim, never "AMG G63"). Build that name from the base model +
 * AMG badge so AMG vehicles resolve. Returns null when not applicable.
 */
function amgEpaModelName(make: string, model: string, trim?: string): string | null {
  if (!/mercedes/i.test(make)) return null;
  const badge = (trim ?? "").match(/\b(35|43|45|53|55|63|65)\b/)?.[1];
  if (!badge) return null;
  const base = model.replace(/-?class\b/i, "").trim().split(/\s+/)[0]; // "GLE-Class" → "GLE"
  if (!base) return null;
  return `AMG ${base}${badge}`;
}

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
      const amg = amgEpaModelName(a.make, a.model, a.trim);
      if (amg) {
        const alt = await fetchEpaMenuOptions(a.year, a.make, amg, a.drivetrain ?? null, null);
        if (alt?.length) options = alt;
      }
    }
    if (!options?.length) return {};
    const picked = pickBestEpaVehicle(options, {
      displacement_l: a.displacementL ?? null,
      cylinders: a.cylinders ?? null,
      transmission_type: a.transType ?? null,
    });
    if (!picked) return {};
    const rec = await fetchEpaVehicleRecord(picked.value);
    if (!rec) return {};
    return {
      mpgCity: rec.mpg_city,
      mpgHighway: rec.mpg_highway,
      mpgCombined: rec.mpg_combined,
      fuelCostPerYearUsd: rec.fuel_cost_per_year_usd,
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
      frontTireSize: null, rearTireSize: null, frontTirePressure: null, rearTirePressure: null,
      ...mpg, ...tires,
    };
  },
});
