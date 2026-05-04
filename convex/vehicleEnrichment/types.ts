/**
 * vehicleEnrichment/types.ts — v4 Type Definitions
 *
 * Core types for the vehicle enrichment pipeline.
 * Every field carries full provenance (source URL, confidence, flags).
 */

import type { Id } from "../_generated/dataModel";

// ─── Per-Field Result ────────────────────────────────────────────

export interface FieldResult {
  value: string | number | boolean | null;
  source_url: string | null;
  source_type: "web_search" | "scraped" | "training_data" | "sibling_engine" | "gap_fill" | "nhtsa" | null;
  confidence: number | null; // 0.0–1.0
  flagged: boolean;
  flag_reason: string | null;
}

// ─── NHTSA vPIC Identity ─────────────────────────────────────────

/** Vehicle identity resolved from NHTSA vPIC API — deterministic, free, no auth. */
export interface VehicleIdentity {
  drivetrain: string | null;         // DriveType: "AWD", "RWD", "FWD", "4WD"
  turbo: boolean | null;             // Turbo: "Yes"/"No" → boolean
  transmission_type: string | null;  // TransmissionStyle: "Automatic", "Manual", "CVT"
  fuel_injection_type: string | null; // FuelInjectionType
  timing_system: string | null;      // ValveTrainDesign: "Overhead Cam (OHC)" etc.
  cylinders: number | null;          // EngineCylinders
  displacement_l: number | null;     // DisplacementL
  fuel_type: string | null;          // FuelTypePrimary
  body_class: string | null;         // BodyClass
  engine_config: string | null;      // EngineConfiguration: "V", "Inline", "Flat"
  make: string | null;
  model: string | null;
  model_year: number | null;
  plant_city: string | null;
  plant_country: string | null;
}

// ─── Interval Result ─────────────────────────────────────────────

export interface IntervalResult {
  miles: FieldResult;
  months: FieldResult;
  status: "scheduled" | "inspect_only" | "conditional_severe" | "not_applicable";
  display_string: string | null;
}

// ─── Service Pricing ─────────────────────────────────────────────

export interface ServicePricingResult {
  service_name: string;
  is_applicable: boolean;
  labor_hours: FieldResult;
  parts_cost_low: FieldResult;
  parts_cost_high: FieldResult;
  total_cost_low: number | null;
  total_cost_high: number | null;
  confidence: number;
  tech_notes: string | null;
}

// ─── Vehicle Input ───────────────────────────────────────────────

export interface VehicleInput {
  vehicleId: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  engineCode: string;
  displacement: string;
  cylinders?: number;
  fuelType?: string;
}

// ─── Call Results ────────────────────────────────────────────────

export interface Call1AResults {
  fluids: {
    oil_viscosity: FieldResult;
    oil_capacity_qts: FieldResult;
    coolant_type: FieldResult;
    coolant_capacity_qts: FieldResult;
    brake_fluid_type: FieldResult;
    power_steering_type: FieldResult;
  };
  intervals: {
    oil_change: IntervalResult;
    spark_plug: IntervalResult;
    transmission_service: IntervalResult;
    coolant_flush: IntervalResult;
    air_filter: IntervalResult;
    cabin_filter: IntervalResult;
    brake_fluid_flush: IntervalResult;
    serpentine_belt: IntervalResult;
    timing_belt_or_chain_service: IntervalResult;
  };
  attributes: {
    timing_system: FieldResult;
    drivetrain: FieldResult;
    turbo: FieldResult;
    fuel_injection_type: FieldResult;
    transmission_type: FieldResult;
  };
}

export interface Call1BResults {
  oem_parts: {
    oil_filter_oem: FieldResult;
    air_filter_oem: FieldResult;
    cabin_filter_oem: FieldResult;
    spark_plug_oem: FieldResult;
    front_brake_pad_oem: FieldResult;
    rear_brake_pad_oem: FieldResult;
    drain_plug_gasket_oem: FieldResult;
    serpentine_belt_oem: FieldResult;
    timing_belt_oem: FieldResult;
    wiper_blade_set_oem: FieldResult;
    wiper_blade_rear_oem: FieldResult;
  };
  battery: {
    battery_group: FieldResult;
    battery_cca: FieldResult;
  };
  spark_plug: {
    quantity: FieldResult;
    gap_mm: FieldResult;
  };
  parking_brake_type: FieldResult;
  trim_specs: {
    tire_pressure_front_psi: FieldResult;
    tire_pressure_rear_psi: FieldResult;
    lug_nut_torque_ft_lbs: FieldResult;
    front_wiper_size: FieldResult;
    rear_wiper_size: FieldResult;
  };
}

// ─── Call Log Entry ──────────────────────────────────────────────

export interface CallLogEntry {
  call: string;
  tokensIn: number;
  tokensOut: number;
  webSearches: number;
  durationMs: number;
}

// ─── Empty Builders ──────────────────────────────────────────────

export function emptyField(): FieldResult {
  return {
    value: null,
    source_url: null,
    source_type: null,
    confidence: null,
    flagged: false,
    flag_reason: null,
  };
}

export function emptyInterval(): IntervalResult {
  return {
    miles: emptyField(),
    months: emptyField(),
    status: "scheduled",
    display_string: null,
  };
}

// ─── Engine Config Key ───────────────────────────────────────────

/** Normalize all separators to underscores, strip non-alphanumeric. */
function canonicalize(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .trim()
    .replace(/[-_/\\.,]+/g, " ")  // all separators → space
    .replace(/\s+/g, " ")          // collapse spaces
    .trim()
    .replace(/\s/g, "_")           // space → underscore
    .replace(/[^a-z0-9_]/g, "");   // strip the rest
}

/** Known make aliases so "Mercedes-Benz", "Mercedes", "MercedesBenz" all resolve the same. */
const MAKE_ALIASES: Record<string, string> = {
  mercedes_benz: "mercedes_benz",
  mercedes: "mercedes_benz",
  mercedesbenz: "mercedes_benz",
  land_rover: "land_rover",
  landrover: "land_rover",
  vw: "volkswagen",
};

function canonicalizeMake(raw: string): string {
  const base = canonicalize(raw);
  return MAKE_ALIASES[base] ?? base;
}

export function buildEngineKey(input: VehicleInput): string {
  const year = String(input.year);
  const make = canonicalizeMake(input.make);
  const model = canonicalize(input.model);
  const trim = canonicalize(input.trim);
  const engine = canonicalize(input.engineCode);

  const parts = [year, make, model, trim, engine].filter((p) => p.length > 0);
  return parts.join("_");
}

/**
 * NHTSA-only base key used for cache lookups BEFORE engine code resolution.
 *
 * Built entirely from raw NHTSA vPIC fields, which are deterministic per VIN.
 * This lets confirmVehicleForUser short-circuit to a cached vehicle_config the
 * moment we decode a VIN — even for makes where NHTSA returns engine descriptors
 * (e.g. VW "1.4 TSI", Hyundai "Smartstream", Ford "EcoBoost") that need
 * Haiku resolution before the canonical config_key can be computed.
 *
 * Format: `{year}_{makeSlug}_{modelSlug}_{trimSlug}_{displacementL}l_{cylinders}cyl_{fuelSlug}`
 * Example: "2020_volkswagen_jetta_r_line_1.4l_4cyl_gas"
 */
export function buildNhtsaVinKey(input: {
  year: number;
  make: string;
  model: string;
  trim?: string;
  displacementL?: number | string;
  cylinders?: number | string;
  fuelType?: string;
}): string {
  const year = String(input.year);
  const make = canonicalizeMake(input.make);
  const model = canonicalize(input.model);
  const trim = canonicalize(input.trim ?? "");

  // Displacement: round to 1 decimal so "1.40" and "1.4" produce the same key.
  let disp = "";
  if (input.displacementL !== undefined && input.displacementL !== null && input.displacementL !== "") {
    const n = typeof input.displacementL === "number" ? input.displacementL : Number(input.displacementL);
    if (Number.isFinite(n) && n > 0) {
      disp = `${n.toFixed(1)}l`;
    }
  }

  let cyl = "";
  if (input.cylinders !== undefined && input.cylinders !== null && input.cylinders !== "") {
    const n = typeof input.cylinders === "number" ? input.cylinders : Number(input.cylinders);
    if (Number.isFinite(n) && n > 0) {
      cyl = `${Math.round(n)}cyl`;
    }
  }

  const fuel = canonicalize(input.fuelType ?? "");

  const parts = [year, make, model, trim, disp, cyl, fuel].filter((p) => p.length > 0);
  return parts.join("_");
}

// ─── Field Lists (for fill rate calculation) ─────────────────────

/**
 * Fields that are safe to copy from sibling engine records across model years.
 * These are physical/mechanical facts tied to the engine or platform that
 * cannot change between years. Everything else must be freshly sourced.
 */
export const SIBLING_SAFE_FIELDS = new Set([
  "timing_system",            // chain vs belt — engine-specific, never changes
  "drivetrain",               // AWD/RWD — platform-specific
  "turbo",                    // turbo vs NA — engine-specific
  "power_steering_type",      // electric vs hydraulic — platform-specific
  "parking_brake_type",       // electronic vs manual — platform-specific
  "spark_plug_quantity",      // determined by cylinder count
  "fuel_injection_type",      // direct vs port — engine-specific
  "transmission_type",        // auto vs manual — platform-specific
  "trans_fluid_type",         // ZF Lifetime, Dexron VI — transmission-specific
  "diff_fluid_type",          // gear oil spec — axle-specific
  "transfer_case_fluid_type", // transfer case fluid — platform-specific
]);

/** All flat FieldResult field keys for fill rate counting. */
export const V4_FIELD_KEYS = [
  // Fluids (6)
  "oil_viscosity", "oil_capacity_qts", "coolant_type",
  "coolant_capacity_qts", "brake_fluid_type", "power_steering_type",
  // Interval miles+months (18)
  "oil_change_miles", "oil_change_months",
  "spark_plug_miles", "spark_plug_months",
  "transmission_service_miles", "transmission_service_months",
  "coolant_flush_miles", "coolant_flush_months",
  "air_filter_miles", "air_filter_months",
  "cabin_filter_miles", "cabin_filter_months",
  "brake_fluid_flush_miles", "brake_fluid_flush_months",
  "serpentine_belt_miles", "serpentine_belt_months",
  "timing_service_miles", "timing_service_months",
  // Attributes (5)
  "timing_system", "drivetrain", "turbo",
  "fuel_injection_type", "transmission_type",
  // Battery details (2)
  "battery_type", "battery_location",
  // OEM Parts (11) — wiper_blade_set_oem = front pair, wiper_blade_rear_oem = rear
  "oil_filter_oem", "air_filter_oem", "cabin_filter_oem",
  "spark_plug_oem", "front_brake_pad_oem", "rear_brake_pad_oem",
  "drain_plug_gasket_oem", "serpentine_belt_oem", "timing_belt_oem",
  "wiper_blade_set_oem", "wiper_blade_rear_oem",
  // Battery & Electrical (5)
  "battery_group", "battery_cca", "spark_plug_quantity",
  "spark_plug_gap", "parking_brake_type",
  // Trim (5)
  "tire_pressure_front_psi", "tire_pressure_rear_psi",
  "lug_nut_torque_ft_lbs", "front_wiper_size", "rear_wiper_size",
  // Pricing (6)
  "oil_change_price", "brake_pad_front_price", "brake_pad_rear_price",
  "spark_plug_price", "air_filter_price", "cabin_filter_price",
  // Labor (4)
  "estimated_labor_oil_change_hrs", "estimated_labor_brake_front_hrs",
  "estimated_labor_brake_rear_hrs", "estimated_labor_spark_plug_hrs",

  // ── v7 New OEM Parts (4) ──
  "rotor_front_oem", "rotor_rear_oem", "battery_oem", "coolant_oem",
  // ── v7 New Fluid Types (3) ──
  "trans_fluid_type", "diff_fluid_type", "transfer_case_fluid_type",
  // ── v7 New Fluid Intervals (4) ──
  "diff_fluid_miles", "diff_fluid_months",
  "transfer_case_fluid_miles", "transfer_case_fluid_months",
  // ── v7 New Pricing (7) ──
  "rotor_front_price", "rotor_rear_price", "battery_price",
  "serpentine_belt_price", "coolant_flush_price",
  "transmission_service_price", "brake_fluid_flush_price",
  // ── v7 New Labor (8) ──
  "estimated_labor_rotor_front_hrs", "estimated_labor_rotor_rear_hrs",
  "estimated_labor_serpentine_belt_hrs", "estimated_labor_coolant_flush_hrs",
  "estimated_labor_trans_fluid_hrs", "estimated_labor_battery_hrs",
  "estimated_labor_brake_fluid_flush_hrs", "estimated_labor_timing_service_hrs",
] as const;

/** Service names for pricing (22 services). */
export const SERVICE_LIST = [
  "Oil Change",
  "Spark Plug Replacement",
  "Air Filter Replacement",
  "Cabin Air Filter Replacement",
  "Brake Pad Replacement - Front",
  "Brake Pad Replacement - Rear",
  "Brake Pad + Rotor Replacement - Front",
  "Brake Pad + Rotor Replacement - Rear",
  "Brake Fluid Flush",
  "Coolant Flush",
  "Transmission Fluid Service",
  "Power Steering Fluid Flush",
  "Serpentine Belt Replacement",
  "Timing Belt/Chain Service",
  "Battery Replacement",
  "Tire Rotation",
  "Wheel Alignment (4-wheel)",
  "Wiper Blade Replacement (set)",
  "Engine Air Intake Cleaning",
  "Fuel System Cleaning",
  "AC Recharge / Service",
  "Multi-Point Inspection / Diagnostic",
] as const;
