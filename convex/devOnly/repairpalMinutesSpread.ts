/**
 * devOnly/repairpalMinutesSpread.ts — THROWAWAY diagnostic probe (design spike, NOT a feature).
 *
 * For a curated set of vehicles × services, resolves RepairPal numeric IDs via the
 * public estimator-flow JSON endpoints, fetches the estimate payload, and returns a
 * FAITHFUL, LOSSLESS capture of every labor field (minutes, unrounded $, parts,
 * footnotes, totals, ranged_estimate, calculation_context) plus derived trust signals
 * (implied $/hr, variant spread, rate-consistency CV). Read-only — writes nothing.
 *
 * Feeds the decision: promote RepairPal from a $0.4 dollar-guesstimate corroborator to
 * a real, exact labor-time source? See
 * docs/superpowers/specs/2026-06-15-repairpal-minutes-spread-spike-design.md
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";

// ───────────────────────── constants ─────────────────────────

const REPAIRPAL_API_BASE = "https://repairpal.com/next-api/estimator-flow";
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

/** Static service-slug → RepairPal global serviceId map (resolved 2026-06-15 from the
 *  repair-services catalog). rotor_replacement has NO standalone RepairPal service —
 *  the nearest is the composite "Brake Pad and Rotor Replacement" (4453439), whose
 *  minutes cover pads+rotors and are NOT comparable to standalone rotor labor. */
export const REPAIRPAL_SERVICE_IDS: Record<string, number | null> = {
  oil_change: 107,
  spark_plugs: 128,
  timing_belt: 144,
  brake_pad_replacement: 30,
  battery_replacement: 590,
  wheel_alignment: 169,
  rotor_replacement: null,
};
export const COMPOSITE_PAD_ROTOR_SERVICE_ID = 4453439;

/** High-spread flag threshold: a (vehicle×service) pair is "high spread" when its
 *  distinct minutes vary and max/min ≥ this ratio — i.e. picking the wrong variant hurts. */
const HIGH_SPREAD_RATIO = 1.25;

const DEFAULT_PROBE_SERVICES = [
  "oil_change",
  "spark_plugs",
  "timing_belt",
  "brake_pad_replacement",
  "rotor_replacement",
  "battery_replacement",
  "wheel_alignment",
];

const DEFAULT_PROBE_VEHICLES = [
  { year: 2015, make: "Honda", model: "Civic" },
  { year: 2017, make: "Toyota", model: "Camry" },
  { year: 2018, make: "Ford", model: "F-150" },
  { year: 2018, make: "Porsche", model: "911" },
  { year: 2019, make: "BMW", model: "3 Series" },
  { year: 2018, make: "Subaru", model: "Outback" },
  { year: 2020, make: "Tesla", model: "Model 3" }, // deliberate coverage-gap probe
];

// ───────────────────────── types ─────────────────────────

export type MoneyBand = {
  low: number; high: number;
  independent: { low: number; high: number };
  dealer: { low: number; high: number };
};

export type RepairpalVariant = {
  key: string;
  position: string | null;
  labor: { low: number; high: number; minutes: number; notes: string[] };
  hours: number;
  implied_rate_low: number;
  implied_rate_high: number;
  total: MoneyBand;
  parts: Array<{
    part: string; position: string;
    total_price: { low: number; high: number };
    quantity: number;
  }>;
  footnotes: string[];
};

// ───────────────────────── pure helpers ─────────────────────────

/** Lowercase, replace any run of non-alphanumerics with a single space, trim. */
export function normalizeName(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** Find a make by normalized-name equality → its numeric id, or null. */
export function matchMake(makes: any[], make: string): number | null {
  const want = normalizeName(make);
  for (const m of makes) {
    if (normalizeName(String(m?.name ?? "")) === want) return Number(m.id);
  }
  return null;
}

/** Find a base-vehicle by normalized modelName equality → its id record, or null. */
export function matchBaseVehicle(
  list: any[],
  model: string,
): { base_vehicle_id: number; slug: string; model_name: string; model_id: number } | null {
  const want = normalizeName(model);
  for (const bv of list) {
    if (normalizeName(String(bv?.modelName ?? "")) === want) {
      return {
        base_vehicle_id: Number(bv.id),
        slug: String(bv.slug ?? ""),
        model_name: String(bv.modelName ?? ""),
        model_id: Number(bv.modelId ?? 0),
      };
    }
  }
  return null;
}
