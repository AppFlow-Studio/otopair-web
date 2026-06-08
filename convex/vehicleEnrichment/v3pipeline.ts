// @ts-nocheck
/**
 * vehicleEnrichment/v3pipeline.ts — v8 Normalized Pipeline
 *
 * Replaces pipelineBatch.ts. Same batch API calls, scraping, and prompts.
 * What changes: parsed results get written to normalized v3 tables
 * (engines, transmissions, vehicle_configs, trim_specs, drivetrain_configs,
 * oem_parts, part_fitments, part_prices, service_intervals, labor_times,
 * enrichment_evidence) instead of the flat enriched_engine_configs table.
 *
 * Note: @ts-nocheck above suppresses TS2589 ("excessively deep type instantiation")
 * errors caused by the size of the schema. The runtime types from Convex's codegen
 * are unaffected — only in-file type inference is skipped.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";
import type {
  VehicleInput,
  FieldResult,
  ServicePricingResult,
  CallLogEntry,
  VehicleIdentity,
} from "./types";
import { buildEngineKey, emptyField, V4_FIELD_KEYS, SIBLING_SAFE_FIELDS } from "./types";
import { submitBatch, getBatchStatus, getBatchResults } from "./utils/batchClient";
import { BATCH_1_SYSTEM, buildBatch1Prompt } from "./prompts/batch1Prompt";
import { BATCH_1B_SYSTEM, buildBatch1bPrompt } from "./prompts/batch1bPrompt";
import { BATCH_2_SYSTEM, buildBatch2Prompt } from "./prompts/batch2Prompt";
import { runSanityChecks } from "./validation/sanityChecks";
import { validateAllOemParts } from "./validation/oemValidation";
import { BLOCKED_DOMAINS } from "./sourceRegistry";
import { applyApplicabilityRules } from "./applicabilityRules";
import { scrapeVehicleSources } from "./scraper";
import { sanitizeString, sanitizeNumber, sanitizePartNumber, sanitizeUrl } from "./contentSanitization";
import {
  advancedVinDecode,
  assessAvailablePackages,
  extractVDBFields,
  fetchVDBRepairRaw,
  applyVDBMappingResult,
  buildVDBMappingPrompt,
  parseVDBMappingResponse,
} from "../lib/vehicleDatabases";
import { MODEL_HAIKU } from "./utils/batchClient";
import { lookupChassisCode } from "./utils/chassisLookup";
import { resolveEngineCode, isNhtsaDescriptor } from "./utils/engineCodeLookup";
import { canonicalizeTransmissionType } from "../lib/transmissionTypeInference";
import type { Id } from "../_generated/dataModel";

// ─── Constants ─────────────────────────────────────────────────────

const MAX_POLL_ATTEMPTS = 180;
const POLL_INTERVAL_MS = 1 * 60 * 1000;

const MAKES_WITH_BRAKE_PAD_SENSORS = new Set([
  "BMW", "Mercedes-Benz", "Porsche", "Audi", "Mini", "Rolls-Royce",
  "Lexus", "Volvo", "Jaguar", "Land Rover", "Maserati", "Alfa Romeo", "Genesis",
]);

// ─── Field Parsing (copied from pipelineBatch.ts — same logic) ────

function parseField(raw: any): FieldResult {
  if (!raw || raw.value === undefined) return emptyField();
  let value = raw.value ?? null;
  if (typeof value === "string") {
    // Parse price strings "$45.00" → 45.00
    if (value.startsWith("$")) {
      const n = parseFloat(value.replace(/[$,]/g, ""));
      if (!isNaN(n)) value = n;
    }
    // Parse numeric strings "0.95" → 0.95
    else if (/^\d+\.?\d*$/.test(value)) {
      const n = parseFloat(value);
      if (!isNaN(n)) value = n;
    }
  }
  return {
    value,
    source_url: raw.source_url ?? raw.source ?? null,
    source_type: raw.source_type ?? (raw.source_url ? "scraped" : null),
    confidence: raw.confidence ?? null,
    flagged: false,
    flag_reason: null,
  };
}

function parseInterval(raw: any): { miles: FieldResult; months: FieldResult; status: string; display_string: string | null } {
  if (!raw) return { miles: emptyField(), months: emptyField(), status: "scheduled", display_string: null };
  return {
    miles: parseField(raw.miles),
    months: parseField(raw.months),
    status: raw.status ?? "scheduled",
    display_string: raw.display_string ?? null,
  };
}

// ─── Parsers (same as pipelineBatch.ts) ──────────────────────────

function parseBatch1a(data: Record<string, any>): Record<string, FieldResult> {
  const f: Record<string, FieldResult> = {};
  if (!data) return f;

  // Fluids
  const fluids = data.fluids ?? {};
  f.oil_viscosity = parseField(fluids.oil_viscosity);
  f.oil_capacity_qts = parseField(fluids.oil_capacity_qts);
  f.coolant_type = parseField(fluids.coolant_type);
  f.coolant_capacity_qts = parseField(fluids.coolant_capacity_qts);
  f.brake_fluid_type = parseField(fluids.brake_fluid_type);
  f.power_steering_type = parseField(fluids.power_steering_type);

  // Intervals
  const intervals = data.intervals ?? {};
  for (const key of ["oil_change", "spark_plug", "transmission_service", "coolant_flush", "air_filter", "cabin_filter", "brake_fluid_flush", "serpentine_belt"]) {
    const iv = parseInterval(intervals[key]);
    f[`${key}_miles`] = iv.miles;
    f[`${key}_months`] = iv.months;
  }
  const timing = parseInterval(intervals.timing_belt_or_chain_service);
  f.timing_service_miles = timing.miles;
  f.timing_service_months = timing.months;

  // Attributes
  const attrs = data.attributes ?? {};
  f.timing_system = parseField(attrs.timing_system);
  f.drivetrain = parseField(attrs.drivetrain);
  f.turbo = parseField(attrs.turbo);
  f.fuel_injection_type = parseField(attrs.fuel_injection_type);
  f.transmission_type = parseField(attrs.transmission_type);

  // OEM Parts
  const parts = data.oem_parts ?? {};
  for (const k of ["oil_filter_oem", "air_filter_oem", "cabin_filter_oem", "spark_plug_oem",
    "front_brake_pad_oem", "rear_brake_pad_oem", "drain_plug_gasket_oem",
    "serpentine_belt_oem", "timing_belt_oem", "wiper_blade_set_oem", "wiper_blade_rear_oem",
    "rotor_front_oem", "rotor_rear_oem", "battery_oem", "coolant_oem", "engine_oil_oem"]) {
    f[k] = parseField(parts[k]);
  }

  // Pricing from parts pages
  const pricing = data.oem_pricing ?? data.pricing ?? {};
  for (const k of ["rotor_front_price", "rotor_rear_price", "battery_price"]) {
    f[k] = parseField(pricing[k]);
  }

  // Battery & electrical
  const battery = data.battery ?? {};
  f.battery_group = parseField(battery.battery_group);
  f.battery_cca = parseField(battery.battery_cca);
  f.battery_type = parseField(battery.battery_type);
  f.battery_location = parseField(battery.battery_location);
  const spark = data.spark_plug ?? {};
  f.spark_plug_quantity = parseField(spark.quantity);
  f.spark_plug_gap = parseField(spark.gap_mm);
  f.parking_brake_type = parseField(data.parking_brake_type);

  // Trim specs
  const trim = data.trim_specs ?? {};
  f.tire_pressure_front_psi = parseField(trim.tire_pressure_front_psi);
  f.tire_pressure_rear_psi = parseField(trim.tire_pressure_rear_psi);
  f.lug_nut_torque_ft_lbs = parseField(trim.lug_nut_torque_ft_lbs);
  f.front_wiper_size = parseField(trim.front_wiper_size);
  f.rear_wiper_size = parseField(trim.rear_wiper_size);

  return f;
}

/**
 * Parse the optional top-level `packages` block from a Batch 1 response.
 *
 * Shape (when present):
 *   data.packages = {
 *     "<package_code>": { oem_parts: { <part_field>: { value, source_url, source_type, confidence }, ... } },
 *     ...
 *   }
 *
 * Returns Map<package_code, Record<part_field_key, FieldResult>>.
 * Empty map if the response has no packages block or no recognized package codes.
 */
function parsePackageParts(data: Record<string, any>): Map<string, Record<string, FieldResult>> {
  const out = new Map<string, Record<string, FieldResult>>();
  const packagesBlock = data?.packages;
  if (!packagesBlock || typeof packagesBlock !== "object") return out;

  // The same OEM part field set used at the top level — package overrides only apply to these.
  const partKeys = [
    "oil_filter_oem", "air_filter_oem", "cabin_filter_oem", "spark_plug_oem",
    "front_brake_pad_oem", "rear_brake_pad_oem", "drain_plug_gasket_oem",
    "serpentine_belt_oem", "timing_belt_oem", "wiper_blade_set_oem", "wiper_blade_rear_oem",
    "rotor_front_oem", "rotor_rear_oem", "battery_oem", "coolant_oem", "engine_oil_oem",
  ];

  for (const [code, body] of Object.entries(packagesBlock)) {
    if (!body || typeof body !== "object") continue;
    const parts = (body as any).oem_parts ?? {};
    const fields: Record<string, FieldResult> = {};
    let any = false;
    for (const k of partKeys) {
      const parsed = parseField(parts[k]);
      // Only carry through fields with a real value — null overrides aren't meaningful here.
      if (parsed.value != null) {
        fields[k] = parsed;
        any = true;
      }
    }
    if (any) out.set(code, fields);
  }
  return out;
}

function parseBatch1b(data: Record<string, any>): Record<string, FieldResult> {
  const f = parseBatch1a(data);
  if (!data) return f;

  // Additional 1B fields: new fluid types + intervals
  const fluids = data.fluids ?? {};
  f.trans_fluid_type = parseField(fluids.trans_fluid_type);
  f.diff_fluid_type = parseField(fluids.diff_fluid_type);
  f.transfer_case_fluid_type = parseField(fluids.transfer_case_fluid_type);

  const intervals = data.intervals ?? {};
  const diff = parseInterval(intervals.diff_fluid);
  f.diff_fluid_miles = diff.miles;
  f.diff_fluid_months = diff.months;
  const tc = parseInterval(intervals.transfer_case_fluid);
  f.transfer_case_fluid_miles = tc.miles;
  f.transfer_case_fluid_months = tc.months;

  return f;
}

function mergeBatch1(
  a: Record<string, FieldResult>,
  b: Record<string, FieldResult>,
): Record<string, FieldResult> {
  const merged = { ...a };
  for (const key of Object.keys(b)) {
    if (merged[key]?.value == null && b[key]?.value != null) {
      merged[key] = b[key];
    }
  }
  // Ensure all V4 keys exist
  for (const k of V4_FIELD_KEYS) {
    if (!merged[k]) merged[k] = emptyField();
  }
  return merged;
}

function getNullFields(fields: Record<string, FieldResult>): string[] {
  return V4_FIELD_KEYS.filter((k) => fields[k]?.value == null);
}

function getOemParts(fields: Record<string, FieldResult>): Record<string, string> {
  const oemFields = V4_FIELD_KEYS.filter((k) => k.endsWith("_oem"));
  const result: Record<string, string> = {};
  for (const k of oemFields) {
    const val = fields[k]?.value;
    if (typeof val === "string" && val.length > 0) {
      result[k] = val;
    }
  }
  return result;
}

/** Legacy flat-field fill rate (for logging comparison only). */
function calculateFlatFillRate(fields: Record<string, FieldResult>): number {
  const total = V4_FIELD_KEYS.length;
  const filled = V4_FIELD_KEYS.filter((k) => fields[k]?.value != null).length;
  return Math.round((filled / total) * 100);
}

/** V3 fill rate — counts actual data coverage across normalized tables. */
async function calculateV3FillRate(
  ctx: any,
  vehicleConfigId: Id<"vehicle_configs">,
  engineId: Id<"engines">,
  transmissionId?: Id<"transmissions">,
): Promise<{ rate: number; breakdown: string }> {
  let filled = 0;
  let total = 0;

  // Engine specs (8 key fields)
  const engine = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, { engineId });
  const engineFields = [
    engine?.oil_viscosity, engine?.oil_capacity_qts,
    engine?.coolant_type, engine?.coolant_capacity_qts,
    engine?.timing_system, engine?.fuel_injection,
    engine?.aspiration, engine?.spark_plug_quantity,
  ];
  const engineTotal = engineFields.length;
  const engineFilled = engineFields.filter((v: unknown) => v != null).length;
  total += engineTotal;
  filled += engineFilled;

  // Transmission specs (1 key field)
  let transFilled = 0;
  let transTotal = 0;
  if (transmissionId) {
    const trans = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getTransmission, { transmissionId });
    transTotal = 1;
    transFilled = trans?.fluid_type ? 1 : 0;
    total += transTotal;
    filled += transFilled;
  }

  // Drivetrain config — always count drivetrain_type, conditionally count fluids
  const dt = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getDrivetrainConfig, { vehicleConfigId });
  let dtTotal = 1; // drivetrain_type itself always counts
  let dtFilled = dt?.drivetrain_type ? 1 : 0;
  if (dt?.has_differential) {
    dtTotal += 1; // diff_fluid_type expected
    if (dt?.diff_fluid_type) dtFilled += 1;
  }
  if (dt?.has_transfer_case) {
    dtTotal += 1; // tc_fluid_type expected
    if (dt?.tc_fluid_type) dtFilled += 1;
  }
  total += dtTotal;
  filled += dtFilled;

  // Trim specs (9 key fields)
  const trim = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getTrimSpecs, { vehicleConfigId });
  const trimFields = [
    (trim as any)?.tire_options?.length > 0 ? true : null,
    trim?.recommended_tire_pressure_front_psi ?? trim?.tire_pressure_front,
    trim?.recommended_tire_pressure_rear_psi ?? trim?.tire_pressure_rear,
    trim?.lug_nut_torque_ft_lbs,
    trim?.battery_group,
    trim?.battery_cca,
    trim?.battery_type,
    trim?.battery_location,
  ];
  const trimTotal = trimFields.length;
  const trimFilled = trimFields.filter((v: unknown) => v != null).length;
  total += trimTotal;
  filled += trimFilled;

  // Vehicle config fields (2 key fields)
  const vc = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleConfigById, { vehicleConfigId });
  const vcFields = [vc?.brake_fluid_type, vc?.has_brake_pad_sensor];
  total += vcFields.length;
  filled += vcFields.filter((v: unknown) => v != null).length;

  // OEM parts — count fitments vs expected
  const isBelt = engine?.timing_system === "belt";
  const expectedParts = isBelt ? 14 : 13;
  const fitments = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getPartFitments, { vehicleConfigId });
  const partsFilled = Math.min(fitments.length, expectedParts);
  total += expectedParts;
  filled += partsFilled;

  // Service intervals — use total service count as denominator (not just rows that exist)
  const allServices = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getAllServices, {});
  const applicableServices = allServices.filter((s: any) => s.is_active !== false);
  const expectedIntervals = applicableServices.length;
  const intervals = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getServiceIntervals, { vehicleConfigId });
  const intervalsFilled = intervals.filter(
    (si: any) => si.interval_miles != null || si.interval_months != null
      || si.status === "cbs_driven" || si.status === "not_applicable"
  ).length;
  total += expectedIntervals;
  filled += Math.min(intervalsFilled, expectedIntervals);

  // Labor times — use same expected count
  const laborTimes = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getLaborTimes, { vehicleConfigId });
  const laborFilled = laborTimes.filter((lt: any) => lt.book_hours != null).length;
  total += expectedIntervals; // same service count as denominator
  filled += Math.min(laborFilled, expectedIntervals);

  // Part prices — count priced parts vs total parts
  const pricedParts = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getPricedPartCount, { vehicleConfigId });
  total += fitments.length;
  filled += pricedParts;

  const rate = total > 0 ? Math.round((filled / total) * 100) : 0;
  const breakdown = `engine=${engineFilled}/${engineTotal}, trans=${transFilled}/${transTotal}, dt=${dtFilled}/${dtTotal}, trim=${trimFilled}/${trimTotal}, vc=${vcFields.filter((v: unknown) => v != null).length}/2, parts=${partsFilled}/${expectedParts}, intervals=${intervalsFilled}/${expectedIntervals}, labor=${laborFilled}/${expectedIntervals}, prices=${pricedParts}/${fitments.length}`;

  return { rate, breakdown };
}

// ─── Pricing Parsers ─────────────────────────────────────────────

const SERVICE_FIELD_MAP: Record<string, { price?: string; labor?: string }> = {
  "Oil Change": { price: "oil_change_price", labor: "estimated_labor_oil_change_hrs" },
  "Brake Pad Replacement - Front": { price: "brake_pad_front_price", labor: "estimated_labor_brake_front_hrs" },
  "Brake Pad Replacement - Rear": { price: "brake_pad_rear_price", labor: "estimated_labor_brake_rear_hrs" },
  "Brake Pad + Rotor Replacement - Front": { price: "rotor_front_price", labor: "estimated_labor_rotor_front_hrs" },
  "Brake Pad + Rotor Replacement - Rear": { price: "rotor_rear_price", labor: "estimated_labor_rotor_rear_hrs" },
  "Spark Plug Replacement": { price: "spark_plug_price", labor: "estimated_labor_spark_plug_hrs" },
  "Air Filter Replacement": { price: "air_filter_price" },
  "Cabin Air Filter Replacement": { price: "cabin_filter_price" },
  "Serpentine Belt Replacement": { price: "serpentine_belt_price", labor: "estimated_labor_serpentine_belt_hrs" },
  "Coolant Flush": { price: "coolant_flush_price", labor: "estimated_labor_coolant_flush_hrs" },
  "Transmission Fluid Service": { price: "transmission_service_price", labor: "estimated_labor_trans_fluid_hrs" },
  "Battery Replacement": { price: "battery_price", labor: "estimated_labor_battery_hrs" },
  "Brake Fluid Flush": { price: "brake_fluid_flush_price", labor: "estimated_labor_brake_fluid_flush_hrs" },
  "Timing Belt/Chain Service": { labor: "estimated_labor_timing_service_hrs" },
};

function isBlockedDomain(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch { return false; }
}

function parseBatch2(
  data: Record<string, any>,
  nullFields: string[],
): { gapFields: Record<string, FieldResult>; services: ServicePricingResult[] } {
  const gapFields: Record<string, FieldResult> = {};
  const services: ServicePricingResult[] = [];

  if (!data) return { gapFields, services };

  // Gap fields — reject values from blocked domains
  const gapData = data.gap_fields ?? {};
  for (const k of nullFields) {
    const raw = gapData[k];
    if (raw && !isBlockedDomain(raw.source_url)) {
      const f = parseField(raw);
      if (f.value != null) {
        f.source_type = f.source_url ? "web_search" : "gap_fill";
        gapFields[k] = f;
      }
    }
  }

  // Services
  const svcData = data.services ?? [];
  for (const s of svcData) {
    // parts_breakdown is the preferred per-OEM-part pricing channel.
    // We strip blocked-domain sources (parser-side, like gap_fields above)
    // and entries without a usable low price.
    const rawBreakdown: any[] = Array.isArray(s.parts_breakdown) ? s.parts_breakdown : [];
    const partsBreakdown = rawBreakdown
      .map((entry) => {
        const sanitizedSourceUrl = sanitizeUrl(entry?.source_url);
        const blocked = isBlockedDomain(sanitizedSourceUrl);
        const priceLow  = sanitizeNumber(entry?.price_low);
        const priceHigh = sanitizeNumber(entry?.price_high);
        const oemNumber = sanitizeString(entry?.oem_part_number)?.trim();
        return {
          oem_part_number: oemNumber ?? "",
          price_low:       priceLow  != null && priceLow  > 0 ? priceLow  : null,
          price_high:      priceHigh != null && priceHigh > 0 ? priceHigh : null,
          source_url:      blocked ? null : (sanitizedSourceUrl ?? null),
          source_domain:   blocked ? null : (extractDomain(sanitizedSourceUrl) ?? null),
          confidence:      typeof entry?.confidence === "number" ? entry.confidence : null,
        };
      })
      .filter((e) => e.oem_part_number && e.price_low != null);

    services.push({
      service_name: s.service_name ?? "",
      is_applicable: s.is_applicable ?? true,
      labor_hours: parseField(s.labor_hours),
      parts_breakdown: partsBreakdown,
      parts_cost_low: parseField(s.parts_cost_low),
      parts_cost_high: parseField(s.parts_cost_high),
      total_cost_low: null,
      total_cost_high: null,
      confidence: s.confidence ?? 0.5,
      tech_notes: s.tech_notes ?? null,
    });
  }

  return { gapFields, services };
}

function mapPricingToFields(services: ServicePricingResult[]): Record<string, FieldResult> {
  const result: Record<string, FieldResult> = {};
  for (const svc of services) {
    if (!svc.is_applicable) continue;
    const mapping = SERVICE_FIELD_MAP[svc.service_name];
    if (!mapping) continue;
    if (mapping.price && svc.parts_cost_low?.value != null) {
      result[mapping.price] = svc.parts_cost_low;
    }
    if (mapping.labor && svc.labor_hours?.value != null) {
      result[mapping.labor] = svc.labor_hours;
    }
  }
  return result;
}

// ─── V3 Write Helpers ────────────────────────────────────────────

/** Map service name from Batch 2 pricing to our service slug. */
const SERVICE_NAME_TO_SLUG: Record<string, string> = {
  "Oil Change": "oil_change",
  "Spark Plug Replacement": "spark_plugs",
  "Air Filter Replacement": "filter_replacement",
  "Cabin Air Filter Replacement": "filter_replacement",
  "Brake Pad Replacement - Front": "brake_pad_replacement",
  "Brake Pad Replacement - Rear": "brake_pad_replacement",
  "Brake Pad + Rotor Replacement - Front": "rotor_replacement",
  "Brake Pad + Rotor Replacement - Rear": "rotor_replacement",
  "Brake Fluid Flush": "brake_fluid_flush",
  "Coolant Flush": "coolant_flush",
  "Transmission Fluid Service": "transmission_service",
  "Power Steering Fluid Flush": "power_steering_flush",
  "Serpentine Belt Replacement": "serpentine_belt",
  "Timing Belt/Chain Service": "timing_belt",
  "Battery Replacement": "battery_replacement",
  "Tire Rotation": "tire_rotation",
  "Wheel Alignment (4-wheel)": "wheel_alignment",
  "Fuel System Cleaning": "fuel_system_cleaning",
};

/** Map OEM part field to { name, category, subcategory, serviceSlug, position }. */
const PART_FIELD_MAP: Record<string, {
  name: string;
  category: string;
  subcategory: string;
  serviceSlug: string | null;
  position?: string;
}> = {
  oil_filter_oem: { name: "Oil Filter", category: "filter", subcategory: "oil_filter", serviceSlug: "oil_change" },
  drain_plug_gasket_oem: { name: "Oil Drain Plug Gasket", category: "gasket", subcategory: "drain_plug_gasket", serviceSlug: "oil_change" },
  air_filter_oem: { name: "Engine Air Filter", category: "filter", subcategory: "air_filter", serviceSlug: "filter_replacement" },
  cabin_filter_oem: { name: "Cabin Air Filter", category: "filter", subcategory: "cabin_filter", serviceSlug: "filter_replacement" },
  spark_plug_oem: { name: "Spark Plug", category: "ignition", subcategory: "spark_plug", serviceSlug: "spark_plugs" },
  front_brake_pad_oem: { name: "Front Brake Pads", category: "brake", subcategory: "front_brake_pad", serviceSlug: "brake_pad_replacement", position: "front" },
  rear_brake_pad_oem: { name: "Rear Brake Pads", category: "brake", subcategory: "rear_brake_pad", serviceSlug: "brake_pad_replacement", position: "rear" },
  rotor_front_oem: { name: "Front Brake Rotor", category: "rotor", subcategory: "front_rotor", serviceSlug: "rotor_replacement", position: "front" },
  rotor_rear_oem: { name: "Rear Brake Rotor", category: "rotor", subcategory: "rear_rotor", serviceSlug: "rotor_replacement", position: "rear" },
  serpentine_belt_oem: { name: "Serpentine Belt", category: "belt", subcategory: "serpentine_belt", serviceSlug: null },
  timing_belt_oem: { name: "Timing Belt", category: "timing", subcategory: "timing_belt", serviceSlug: "timing_belt" },
  // Front wipers ship as a set (driver + passenger as one part). Rear wiper is its own part.
  wiper_blade_set_oem: { name: "Wiper Blade Set (Front)", category: "wiper", subcategory: "wiper_blade_front_set", serviceSlug: "wiper_blade_replacement", position: "front" },
  wiper_blade_rear_oem: { name: "Wiper Blade (Rear)", category: "wiper", subcategory: "wiper_blade_rear", serviceSlug: "wiper_blade_replacement", position: "rear" },
  battery_oem: { name: "Battery", category: "electrical", subcategory: "battery", serviceSlug: "battery_replacement" },
  coolant_oem: { name: "Coolant", category: "cooling", subcategory: "coolant", serviceSlug: "coolant_flush" },
  // Bottle-SKU OEM engine oil. quantity_needed on the resulting fitment stays
  // unset; quoting multiplies the per-bottle price by oil_capacity_qts from
  // engine_specs at quote time. Mirrors how coolant_oem is sized via
  // coolant_capacity_qts — the fitment is per-unit, the engine row supplies qty.
  engine_oil_oem: { name: "Engine Oil", category: "fluid", subcategory: "engine_oil", serviceSlug: "oil_change" },
};

/** Map interval field prefix to service slug. */
const INTERVAL_TO_SERVICE: Record<string, string> = {
  oil_change: "oil_change",
  spark_plug: "spark_plugs",
  transmission_service: "transmission_service",
  coolant_flush: "coolant_flush",
  air_filter: "filter_replacement",
  cabin_filter: "filter_replacement",
  brake_fluid_flush: "brake_fluid_flush",
  timing_service: "timing_belt",
  diff_fluid: "differential_service",
  transfer_case_fluid: "differential_service",
};

function extractDomain(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

// Transmission style canonicalization lives in lib/transmissionTypeInference.ts
// (Haiku-based with in-memory cache). No hardcoded marketing-term whitelist.

function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function asNumber(val: unknown): number | undefined {
  // Task 17: Content sanitization — strips HTML, markdown, units, preamble
  return sanitizeNumber(val);
}

function asString(val: unknown): string | undefined {
  // Task 17: Content sanitization — strips HTML, markdown, normalizes whitespace
  return sanitizeString(val);
}

function asBoolean(val: unknown): boolean | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "boolean") return val;
  if (val === "true") return true;
  if (val === "false") return false;
  return undefined;
}

// ─── Shared args for poll actions ────────────────────────────────

const vehicleArgs = {
  vehicleId: v.id("vehicles"),
  year: v.float64(),
  make: v.string(),
  model: v.string(),
  trim: v.string(),
  engineCode: v.string(),
  displacement: v.string(),
  startTime: v.float64(),
  callLog: v.array(v.object({
    call: v.string(),
    tokensIn: v.float64(),
    tokensOut: v.float64(),
    webSearches: v.float64(),
    durationMs: v.float64(),
  })),
  sourceUrls: v.array(v.string()),
  attempt: v.optional(v.float64()),
};

// ─── Write normalized data from parsed fields ────────────────────

async function writeNormalizedData(
  ctx: any,
  fields: Record<string, FieldResult>,
  vehicleConfigId: Id<"vehicle_configs">,
  engineId: Id<"engines">,
  transmissionId: Id<"transmissions"> | undefined,
  makeId: Id<"makes">,
  runId: Id<"enrichment_runs">,
  make: string,
  serviceCache: Map<string, Id<"services">>,
  wheelSizeOptions?: any[],
  wheelSizeSource?: string,
  /** Package-specific OEM parts: Map<package_code, Record<part_field_key, FieldResult>>. */
  packageParts?: Map<string, Record<string, FieldResult>>,
) {
  const now = Date.now();

  // A. Engine specs — typed coercion
  const turboVal = fields.turbo?.value;
  let aspiration: string | undefined;
  if (turboVal === true || turboVal === "Yes" || turboVal === "yes") aspiration = "turbo";
  else if (turboVal === "twin-turbo") aspiration = "twin-turbo";
  else if (turboVal === false || turboVal === "No" || turboVal === "no") aspiration = "natural";

  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEngineSpecs, {
    engine_id: engineId,
    oil_viscosity: asString(fields.oil_viscosity?.value),
    oil_capacity_qts: asNumber(fields.oil_capacity_qts?.value),
    coolant_type: asString(fields.coolant_type?.value),
    coolant_capacity_qts: asNumber(fields.coolant_capacity_qts?.value),
    timing_system: asString(fields.timing_system?.value),
    fuel_injection: asString(fields.fuel_injection_type?.value),
    aspiration,
    spark_plug_quantity: asNumber(fields.spark_plug_quantity?.value),
    spark_plug_gap_mm: asNumber(fields.spark_plug_gap?.value),
    has_serpentine_belt: fields.serpentine_belt_oem?.value != null ? true : undefined,
    data_quality: "enriched",
  });

  // B. Transmission specs
  //
  // Claude's `attributes.transmission_type` arrives via parseBatch1a in
  // fields.transmission_type. The prompt asks for canonical tokens
  // ("automatic" / "manual" / "CVT" / "DCT"), so usually no normalization is
  // needed — but defensively run it through canonicalizeTransmissionType which
  // has a no-cost fast path for already-canonical strings and only spends a
  // Haiku call when Claude went off-script with a marketing name. Cached.
  //
  // The mutation only patches fields whose value is non-undefined, so when
  // Claude didn't answer we keep the existing row state untouched.
  if (transmissionId) {
    const rawTransType = asString(fields.transmission_type?.value);
    const normalizedType = rawTransType
      ? (await canonicalizeTransmissionType(rawTransType)) ?? undefined
      : undefined;
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateTransmissionSpecs, {
      transmission_id: transmissionId,
      type: normalizedType,
      fluid_type: asString(fields.trans_fluid_type?.value),
      data_quality: "enriched",
    });
  }

  // C. Drivetrain config — resolve drivetrain from Batch 1B before setting diff/TC
  const batch1Drivetrain = asString(fields.drivetrain?.value);
  const diffFluid = asString(fields.diff_fluid_type?.value);
  const tcFluid = asString(fields.transfer_case_fluid_type?.value);

  // Read the current vehicle_config to check if drivetrain was resolved
  const currentVc = await ctx.runQuery(
    internal.vehicleEnrichment.v3queries.getVehicleConfigById,
    { vehicleConfigId },
  );
  const existingDrivetrain = currentVc?.drivetrain;

  // Priority: Batch 1B > existing (if real) > "FWD" as absolute last resort
  const isResolved = (val: string | undefined | null): val is string =>
    !!val && val !== "unknown";

  const resolvedDrivetrain = isResolved(batch1Drivetrain)
    ? batch1Drivetrain
    : isResolved(existingDrivetrain)
      ? existingDrivetrain
      : "FWD"; // last resort — all sources exhausted

  if (batch1Drivetrain && batch1Drivetrain !== existingDrivetrain) {
    console.log(`[v8] Drivetrain resolved by Batch 1B: "${existingDrivetrain}" → "${batch1Drivetrain}"`);
    // Update vehicle_config with the real drivetrain
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
      vehicle_config_id: vehicleConfigId,
      drivetrain: resolvedDrivetrain,
    });
  } else if (existingDrivetrain === "unknown") {
    console.log(`[v8] Drivetrain still unknown after Batch 1B — defaulting to FWD`);
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
      vehicle_config_id: vehicleConfigId,
      drivetrain: "FWD",
    });
  }

  // NOW upsert drivetrain_config with the resolved value
  // Consistency: null out fluid types when the component doesn't exist
  const hasDiff = resolvedDrivetrain !== "FWD";
  const hasTC = resolvedDrivetrain === "AWD" || resolvedDrivetrain === "4WD";
  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertDrivetrainConfig, {
    vehicle_config_id: vehicleConfigId,
    drivetrain_type: resolvedDrivetrain,
    has_differential: hasDiff,
    diff_fluid_type: hasDiff ? diffFluid : undefined,
    has_transfer_case: hasTC,
    tc_fluid_type: hasTC ? tcFluid : undefined,
  });

  // D. Trim specs — typed coercion
  // is_staggered: derived from tire_options (any entry with differing front/rear)
  const isStaggered = wheelSizeOptions
    ? (wheelSizeOptions as any[]).some((t) => t.size_rear && t.size_rear !== t.size_front)
    : undefined;

  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertTrimSpecs, {
    vehicle_config_id: vehicleConfigId,
    tire_pressure_front: asNumber(fields.tire_pressure_front_psi?.value),
    tire_pressure_rear: asNumber(fields.tire_pressure_rear_psi?.value),
    lug_nut_torque_ft_lbs: asNumber(fields.lug_nut_torque_ft_lbs?.value),
    front_wiper_size_in: asString(fields.front_wiper_size?.value),
    rear_wiper_size_in: asString(fields.rear_wiper_size?.value),
    battery_group: asString(fields.battery_group?.value),
    battery_cca: asNumber(fields.battery_cca?.value),
    battery_type: asString(fields.battery_type?.value),
    battery_location: asString(fields.battery_location?.value),
    is_staggered: isStaggered,
    tire_options: wheelSizeOptions ?? undefined,
    tire_options_source: wheelSizeSource ?? undefined,
  });

  // E. Vehicle config fields — typed coercion
  const psType = asString(fields.power_steering_type?.value);
  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
    vehicle_config_id: vehicleConfigId,
    brake_fluid_type: asString(fields.brake_fluid_type?.value),
    has_brake_pad_sensor: MAKES_WITH_BRAKE_PAD_SENSORS.has(make),
    ps_fluid_type: psType && psType !== "electric" ? psType : undefined,
  });

  // E2. chassis_specs — dual-write platform-level fields.
  // Reads chassis_code from vehicle_config (set in Step 6c). No-op if not yet set.
  // Keeps trim_specs writes above for backward compat during migration.
  try {
    const chassisCfg = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId },
    );
    if (chassisCfg?.chassis_code) {
      const frontWiper = parseFloat(asString(fields.front_wiper_size?.value) ?? "") || undefined;
      const rearWiper  = parseFloat(asString(fields.rear_wiper_size?.value)  ?? "") || undefined;
      const steeringType = psType === "electric" ? "electric"
        : psType ? "hydraulic"
        : undefined;
      const parkingBrake = asString(fields.parking_brake_type?.value) ?? undefined;

      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertChassisSpecs, {
        chassis_code: chassisCfg.chassis_code,
        ...(asNumber(fields.lug_nut_torque_ft_lbs?.value) !== undefined ? { lug_nut_torque_ft_lbs: asNumber(fields.lug_nut_torque_ft_lbs?.value) } : {}),
        ...(frontWiper ? { wiper_blade_driver_size_in: frontWiper } : {}),
        ...(rearWiper  ? { wiper_blade_rear_size_in: rearWiper } : {}),
        ...(asString(fields.battery_group?.value)    ? { battery_group: asString(fields.battery_group?.value)! } : {}),
        ...(asString(fields.battery_type?.value)     ? { battery_type: asString(fields.battery_type?.value)! } : {}),
        ...(asString(fields.battery_location?.value) ? { battery_location: asString(fields.battery_location?.value)! } : {}),
        ...(asString(fields.brake_fluid_type?.value) ? { brake_fluid_type: asString(fields.brake_fluid_type?.value)! } : {}),
        ...(psType && psType !== "electric" ? { ps_fluid_type: psType } : {}),
        ...(steeringType ? { steering_type: steeringType } : {}),
        ...(parkingBrake ? { parking_brake_type: parkingBrake } : {}),
      });
      console.log(`[v8] chassis_specs written for ${chassisCfg.chassis_code}`);
    }
  } catch (e) {
    console.warn("[v8] chassis_specs write failed (non-fatal):", e);
  }

  // F. OEM parts + fitments
  for (const [fieldKey, meta] of Object.entries(PART_FIELD_MAP)) {
    const rawVal = fields[fieldKey]?.value;
    const conf = fields[fieldKey]?.confidence;
    const src = fields[fieldKey]?.source_url;

    // Task 17: Sanitize part numbers — strip HTML/markdown, validate against OEM patterns
    const rawStr = rawVal != null ? String(rawVal) : null;
    const val = rawStr != null ? sanitizePartNumber(rawStr, make) : null;

    console.log(`[v8-parts] ${fieldKey}: raw=${rawVal} (type=${typeof rawVal}), sanitized=${val}, confidence=${conf}, source=${src}`);

    if (val == null || val.length === 0) {
      console.log(`[v8-parts] SKIPPED ${fieldKey}: reason=${rawStr ? "failed_sanitization" : "null_or_empty"}`);
      continue;
    }

    let qty = 1;
    if (meta.subcategory === "spark_plug") {
      qty = asNumber(fields.spark_plug_quantity?.value) ?? 1;
    } else if (meta.subcategory === "front_rotor" || meta.subcategory === "rear_rotor") {
      qty = 2;
    }

    console.log(`[v8-parts] Writing part: ${val} as ${meta.subcategory} for service ${meta.serviceSlug ?? meta.subcategory}`);

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartAndFitment, {
      oem_part_number: val,
      name: meta.name,
      category: meta.category,
      subcategory: meta.subcategory,
      make_id: makeId,
      vehicle_config_id: vehicleConfigId,
      service_type: meta.serviceSlug ?? meta.subcategory,
      quantity_needed: qty,
      position: meta.position,
      confidence: fields[fieldKey]?.confidence ?? 0.7,
      source_domain: extractDomain(fields[fieldKey]?.source_url),
    });
  }

  // F2. Package-specific OEM parts + fitments.
  // Same PART_FIELD_MAP, but each fitment row carries package_code so booking-time
  // lookup can filter to only the packages the owner has confirmed.
  if (packageParts && packageParts.size > 0) {
    for (const [packageCode, pkgFields] of packageParts) {
      for (const [fieldKey, meta] of Object.entries(PART_FIELD_MAP)) {
        const rawVal = pkgFields[fieldKey]?.value;
        if (rawVal == null) continue;

        const rawStr = String(rawVal);
        const val = sanitizePartNumber(rawStr, make);
        if (val == null || val.length === 0) {
          console.log(`[v8-packages] SKIPPED ${packageCode}/${fieldKey}: failed sanitization (raw=${rawStr})`);
          continue;
        }

        let qty = 1;
        if (meta.subcategory === "spark_plug") {
          qty = asNumber(fields.spark_plug_quantity?.value) ?? 1;
        } else if (meta.subcategory === "front_rotor" || meta.subcategory === "rear_rotor") {
          qty = 2;
        }

        console.log(`[v8-packages] Writing ${packageCode}/${meta.subcategory}: ${val}`);

        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartAndFitment, {
          oem_part_number: val,
          name: meta.name,
          category: meta.category,
          subcategory: meta.subcategory,
          make_id: makeId,
          vehicle_config_id: vehicleConfigId,
          service_type: meta.serviceSlug ?? meta.subcategory,
          quantity_needed: qty,
          position: meta.position,
          package_code: packageCode,
          confidence: pkgFields[fieldKey]?.confidence ?? 0.7,
          source_domain: extractDomain(pkgFields[fieldKey]?.source_url),
        });
      }
    }
  }

  // G. Service intervals
  const intervalPrefixes = Object.keys(INTERVAL_TO_SERVICE);
  for (const prefix of intervalPrefixes) {
    const milesVal = asNumber(fields[`${prefix}_miles`]?.value);
    const monthsVal = asNumber(fields[`${prefix}_months`]?.value);
    if (milesVal == null && monthsVal == null) continue;

    const slug = INTERVAL_TO_SERVICE[prefix];
    const serviceId = await resolveServiceId(ctx, slug, serviceCache);
    if (!serviceId) continue;

    const confidence = Math.min(
      fields[`${prefix}_miles`]?.confidence ?? 1,
      fields[`${prefix}_months`]?.confidence ?? 1,
    );

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertServiceInterval, {
      vehicle_config_id: vehicleConfigId,
      service_id: serviceId,
      interval_miles: milesVal,
      interval_months: monthsVal,
      status: milesVal || monthsVal ? "scheduled" : "on_demand",
      confidence,
      data_quality: "enriched",
    });
  }

  // H. Evidence batch
  const evidenceRows: Array<{
    entity_type: string;
    entity_id: string;
    field_name: string;
    observed_value: string;
    observed_type: string;
    source_url?: string;
    source_domain?: string;
    source_type: string;
    confidence: number;
    enrichment_run_id: Id<"enrichment_runs">;
    observed_at: number;
  }> = [];

  for (const k of V4_FIELD_KEYS) {
    const f = fields[k];
    if (!f || f.value == null) continue;
    // Task 17: Sanitize evidence values and URLs before storage
    const sanitizedValue = sanitizeString(f.value) ?? String(f.value);
    const sanitizedSourceUrl = sanitizeUrl(f.source_url);
    evidenceRows.push({
      entity_type: getEntityType(k),
      entity_id: String(vehicleConfigId),
      field_name: k,
      observed_value: sanitizedValue,
      observed_type: typeof f.value === "number" ? "number" : typeof f.value === "boolean" ? "boolean" : "string",
      source_url: sanitizedSourceUrl,
      source_domain: extractDomain(sanitizedSourceUrl),
      source_type: f.source_type ?? "training_data",
      confidence: f.confidence ?? 0.5,
      enrichment_run_id: runId,
      observed_at: now,
    });
  }

  // Insert in batches of 50 to avoid transaction limits
  for (let i = 0; i < evidenceRows.length; i += 50) {
    const batch = evidenceRows.slice(i, i + 50);
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.addEvidenceBatch, {
      evidence_rows: batch,
    });
  }
}

function getEntityType(fieldName: string): string {
  if (fieldName.includes("tire") || fieldName.includes("wiper") || fieldName.includes("lug_nut") || fieldName.includes("battery_group") || fieldName.includes("battery_cca") || fieldName.includes("battery_type") || fieldName.includes("battery_location") || fieldName.includes("alignment")) return "trim_spec";
  if (fieldName.includes("oil_") || fieldName.includes("coolant") || fieldName.includes("timing") || fieldName.includes("spark_plug") || fieldName.includes("fuel_injection") || fieldName === "turbo" || fieldName.includes("aspiration") || fieldName.includes("serpentine")) return "engine";
  if (fieldName.includes("trans_fluid") || fieldName.includes("transmission")) return "transmission";
  if (fieldName.includes("diff_fluid") || fieldName.includes("transfer_case")) return "drivetrain_config";
  if (fieldName.endsWith("_oem")) return "part";
  if (fieldName.endsWith("_miles") || fieldName.endsWith("_months")) return "interval";
  if (fieldName.endsWith("_price") || fieldName.startsWith("estimated_labor")) return "vehicle_config";
  return "vehicle_config";
}

async function resolveServiceId(
  ctx: any,
  slug: string,
  cache: Map<string, Id<"services">>,
): Promise<Id<"services"> | null> {
  if (cache.has(slug)) return cache.get(slug)!;
  const svc = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getServiceBySlug, { slug });
  if (svc) {
    cache.set(slug, svc._id);
    return svc._id;
  }
  return null;
}

// ============================================================================
// 1. enrichVehicleBatchV3 — Entry Point
// ============================================================================

export const enrichVehicleBatchV3 = internalAction({
  args: {
    vehicleId: v.id("vehicles"),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.string(),
    engineCode: v.string(),
    displacement: v.string(),
    drivetrain: v.optional(v.string()),
    // NHTSA-only base key passed in from confirmVehicleForUser. Stored on the
    // vehicle_configs row in STAGE 4 so future VIN decodes can dedup against
    // it BEFORE Haiku engine code resolution. See vehicleEnrichment/types.ts.
    nhtsaVinKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const startTime = Date.now();
    const vehicle: VehicleInput = {
      vehicleId: args.vehicleId,
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
      engineCode: args.engineCode,
      displacement: args.displacement,
    };
    let configKey = buildEngineKey(vehicle);
    console.log(`[v8] Starting enrichment for ${configKey}`);

    // STEP 0: Cache + concurrency check
    const existingConfig = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigByKey,
      { configKey },
    );
    if (existingConfig) {
      const status = existingConfig.enrichment_status;

      // Already enriching — don't start a second run
      const IN_PROGRESS = new Set(["enriching", "scraping", "batch1", "batch2", "started"]);
      if (IN_PROGRESS.has(status)) {
        // Check if it's been stuck for >4 hours (safety valve)
        const STUCK_MS = 4 * 60 * 60 * 1000;
        const runAge = Date.now() - (existingConfig.last_enriched_at ?? existingConfig._creationTime);
        if (runAge < STUCK_MS) {
          console.log(`[v8] Enrichment already in progress for ${configKey} (status=${status}), skipping`);
          await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
            { vehicle_id: args.vehicleId, vehicle_config_id: existingConfig._id },
          );
          return { status: "already_enriching" as const, configId: existingConfig._id };
        }
        console.log(`[v8] Stale in-progress run for ${configKey} (${Math.round(runAge / 3600000)}h old), re-enriching`);
      }

      // Complete/verified — use cache unless stale
      if (status === "complete" || status === "verified") {
        const STALE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
        const lastEnriched = existingConfig.last_enriched_at;
        if (!lastEnriched || (Date.now() - lastEnriched) > STALE_MS) {
          console.log(`[v8] Cache stale (>180 days), scheduling validation for ${configKey}`);
          await ctx.scheduler.runAfter(
            0,
            internal.vehicleEnrichment.cacheValidation.validateCachedConfig,
            { vehicle_config_id: existingConfig._id },
          );
          await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
            { vehicle_id: args.vehicleId, vehicle_config_id: existingConfig._id },
          );
          return { status: "cache_hit_validating" as const, configId: existingConfig._id };
        } else {
          console.log(`[v8] Cache hit for ${configKey} (status=${status})`);
          await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
            { vehicle_id: args.vehicleId, vehicle_config_id: existingConfig._id },
          );
          return { status: "cache_hit" as const, configId: existingConfig._id };
        }
      }
    }

    // STEP 1: Read vehicle identity from DB
    let vPicData: VehicleIdentity | null = null;
    try {
      vPicData = await ctx.runQuery(
        internal.vehicleEnrichment.nhtsa.getIdentity,
        { vehicleId: args.vehicleId },
      );
      if (vPicData) {
        console.log(`[v8] DB identity: drivetrain=${vPicData.drivetrain}, cylinders=${vPicData.cylinders}`);
      }
    } catch (e) {
      console.warn("[v8] Could not read vehicle identity:", e);
    }

    // STEP 1b: Resolve engine code if NHTSA returned a descriptor / VDB returned
    // a placeholder / processVin fell back to a synthetic code like "3.6l_3.6cyl".
    // (isNhtsaDescriptor catches all three.) Persist the resolved code back to
    // the engines table after STEP 3 below, so sibling-matching uses it.
    let resolvedEngineCodeForPersist: string | null = null;
    if (isNhtsaDescriptor(args.engineCode)) {
      console.log(`[v8] Engine code "${args.engineCode}" is a placeholder — resolving real OEM code`);
      const resolved = await resolveEngineCode(
        args.year, args.make, args.model, args.trim,
        args.displacement, vPicData?.cylinders ?? 4,
        vPicData?.fuel_type ?? "Gasoline", args.engineCode,
      );
      if (resolved.source === "haiku" && !isNhtsaDescriptor(resolved.engineCode)) {
        console.log(`[v8] Engine code resolved: "${args.engineCode}" → "${resolved.engineCode}"`);
        vehicle.engineCode = resolved.engineCode;
        configKey = buildEngineKey(vehicle);
        resolvedEngineCodeForPersist = resolved.engineCode;
        // Check if a complete config already exists under the resolved key
        const resolvedConfig = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigByKey,
          { configKey },
        );
        if (resolvedConfig && (resolvedConfig.enrichment_status === "complete" || resolvedConfig.enrichment_status === "verified")) {
          console.log(`[v8] Resolved config already complete (status=${resolvedConfig.enrichment_status}) — attaching`);
          await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
            { vehicle_id: args.vehicleId, vehicle_config_id: resolvedConfig._id },
          );
          return { status: "cache_hit" as const, configId: resolvedConfig._id };
        }
      } else if (resolved.source === "unknown") {
        console.log(`[v8] Engine code resolution returned unknown — keeping placeholder "${args.engineCode}"`);
      }
    }

    // STEP 2: Resolve make + model IDs
    const makeDoc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getMakeByName,
      { name: args.make },
    );
    if (!makeDoc) {
      console.error(`[v8] Make "${args.make}" not found in makes table — aborting`);
      return { status: "error" as const, reason: "make_not_found" };
    }

    let modelDoc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getModelByMakeAndName,
      { makeId: makeDoc._id, name: args.model },
    );
    if (!modelDoc) {
      const modelId = await ctx.runMutation(
        internal.vehicleEnrichment.v3queries.createModel,
        { make_id: makeDoc._id, name: args.model },
      );
      modelDoc = { _id: modelId } as any;
    }

    // STEP 3: Read engine + transmission IDs from vehicles table
    const vehicleDoc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicle,
      { vehicleId: args.vehicleId },
    );
    if (!vehicleDoc?.engine_id) {
      console.error("[v8] Vehicle has no engine_id — aborting");
      return { status: "error" as const, reason: "no_engine_id" };
    }

    // v9.6: persist Haiku-resolved engine code back to the engines table so
    // by_engine_code sibling matching uses the real OEM code from now on.
    if (resolvedEngineCodeForPersist) {
      try {
        await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.patchEngineCode,
          { engine_id: vehicleDoc.engine_id, engine_code: resolvedEngineCodeForPersist },
        );
        console.log(`[v8] Persisted resolved engine code "${resolvedEngineCodeForPersist}" to engines.engine_code`);
      } catch (e) {
        console.warn("[v8] patchEngineCode failed (non-fatal):", e);
      }
    }

    // VDB advanced decode — runs once, cached by VIN. Fields used in Step 6b/6e.
    const vdbRaw = vehicleDoc.vin ? await advancedVinDecode(vehicleDoc.vin) : null;
    const vdbFields = vdbRaw ? extractVDBFields(vdbRaw) : null;

    // Package detection — flags packages available for this trim that affect 1+ of
    // the 23 services. Stored on vehicle_configs.packages_available (after the upsert
    // below) and passed into Batch 1 so Claude can return package-specific part numbers.
    // See docs/PACKAGE_AWARE_PARTS.md.
    const detectedPackages = vdbRaw
      ? assessAvailablePackages({
          vdbRaw,
          make: args.make,
          model: args.model,
          trim: args.trim,
          year: args.year,
        })
      : [];
    if (detectedPackages.length > 0) {
      console.log(
        `[v8-packages] Detected ${detectedPackages.length} service-impacting package(s): ${detectedPackages.map((p) => p.code).join(", ")}`,
      );
    }

    // STEP 3a: Ensure transmission record exists for ICE vehicles
    let transmissionId = vehicleDoc.transmission_id ?? null;
    if (!transmissionId) {
      console.log("[v8] No transmission_id on vehicle — creating placeholder");
      const trimId = vehicleDoc.trim_id;
      if (trimId) {
        const transDoc = await ctx.runMutation(api.transmissions.upsertTransmission, {
          trim_id: trimId,
          transmission_type: "unknown",
          confidence_score: 0.1,
        });
        if (transDoc?._id) {
          transmissionId = transDoc._id;
          // Link to vehicle
          await ctx.runMutation(api.vehicles.upsertVehicle, {
            vin: vehicleDoc.vin,
            transmission_id: transmissionId,
          });
          console.log(`[v8] Placeholder transmission created: ${transmissionId}`);
        }
      }
    }

    // STEP 3b: Fuzzy dedup — if a config with the same engine+year+make exists
    // under a slightly different key, reuse it instead of creating a duplicate
    const possibleDupe = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.findSimilarConfig,
      { engine_id: vehicleDoc.engine_id, year: args.year, make_id: makeDoc._id },
    );
    if (possibleDupe && possibleDupe.config_key !== configKey) {
      console.log(`[v8] Dedup: using existing key "${possibleDupe.config_key}" instead of "${configKey}"`);
      configKey = possibleDupe.config_key;
    }

    // STEP 4: Upsert vehicle_config
    // Do NOT default drivetrain to "FWD" here — NHTSA often returns null.
    // The real drivetrain value comes from Batch 1B. Use "unknown" as placeholder.
    // Priority: args.drivetrain (from processVin) > vPicData (from getIdentity) > "unknown"
    const nhtsDrivetrain = args.drivetrain ?? vPicData?.drivetrain ?? null;
    const drivetrainVal = nhtsDrivetrain ?? "unknown";
    if (nhtsDrivetrain) {
      console.log(`[v8] Drivetrain from decode: ${nhtsDrivetrain}`);
    } else {
      console.log(`[v8] Drivetrain unknown — deferring to Batch 1B`);
    }
    const vehicleConfigId = await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.upsertVehicleConfig,
      {
        config_key: configKey,
        nhtsa_vin_key: args.nhtsaVinKey,
        year: args.year,
        make_id: makeDoc._id,
        model_id: modelDoc._id,
        engine_id: vehicleDoc.engine_id,
        transmission_id: transmissionId ?? undefined,
        drivetrain: drivetrainVal,
        trim_name: args.trim,
        trim_slug: slugify(args.trim),
        enrichment_status: "enriching",
        fill_rate: 0,
        enrichment_version: "v8",
      },
    );

    // STEP 4b: Persist detected packages (if any) onto the vehicle_config row.
    // patchVehicleConfig is a no-op when packages_available is undefined, so this
    // is safe to call unconditionally.
    if (detectedPackages.length > 0) {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
        vehicle_config_id: vehicleConfigId,
        packages_available: detectedPackages,
      });
    }

    // STEP 4c: Persist VDB-derived OEM brake tier (drives the Rotor Booking
    // screen's pre-selection). Without this, the field stays undefined and
    // every new config needs the backfill (convex/backfillVdbBrakes.ts).
    if (vdbFields?.brakeSystemType) {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
        vehicle_config_id: vehicleConfigId,
        brake_system_type: vdbFields.brakeSystemType,
      });
    }

    // STEP 5: Create enrichment run (now that vehicle_config_id is known)
    const runId = await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.createEnrichmentRun,
      { vehicle_config_id: vehicleConfigId, version: "v8", trigger: "new_vehicle" },
    );

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
      run_id: runId,
      status: "scraping",
    });

    // STEP 6: Upsert drivetrain_config — only if we have a REAL value from NHTSA.
    // If drivetrain is unknown, skip this. _pollBatch1V3 will create it after
    // Batch 1B resolves the drivetrain.
    if (nhtsDrivetrain) {
      const hasDiffNhtsa = nhtsDrivetrain !== "FWD";
      const hasTCNhtsa = nhtsDrivetrain === "AWD" || nhtsDrivetrain === "4WD";
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertDrivetrainConfig, {
        vehicle_config_id: vehicleConfigId,
        drivetrain_type: nhtsDrivetrain,
        has_differential: hasDiffNhtsa,
        diff_fluid_type: undefined, // populated later by Batch 1 enrichment
        has_transfer_case: hasTCNhtsa,
        tc_fluid_type: undefined,   // populated later by Batch 1 enrichment
      });
    }

    // STEP 6b: VDB Repair Estimates — fetch raw blocks ONLY. The action→slug
    // mapping happens via Haiku as a 1C request piggybacked on Batch 1A/1B (see
    // STEP 8). Mapping result + raw blocks → intervals/labor in _pollBatch1V3.
    let vdbRepairRaw: { blocks: any[]; actions: string[] } | null = null;
    try {
      vdbRepairRaw = vehicleDoc.vin ? await fetchVDBRepairRaw(vehicleDoc.vin) : null;
      if (vdbRepairRaw) {
        console.log(`[v8] VDB repair: fetched ${vdbRepairRaw.blocks.length} blocks, ${vdbRepairRaw.actions.length} unique actions`);
      }
    } catch (e) {
      console.warn("[v8] VDB repair fetch failed (non-fatal):", e);
    }

    // STEP 6c: Chassis code lookup + merge-and-continue (Task 22 v2)
    // Ask Haiku to identify the OEM chassis/generation code (e.g. "G30", "W206").
    // If ANY vehicle_config with the same chassis_code exists (even partial),
    // clone its data as a head start, then CONTINUE to full enrichment to fill gaps.
    // After enrichment completes, backfill siblings with newly discovered fields.
    try {
      const chassisResult = await lookupChassisCode(
        args.year,
        args.make,
        args.model,
        args.trim,
      );

      if (chassisResult.chassisCode) {
        // Patch the chassis code onto the vehicle_config
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
          vehicle_config_id: vehicleConfigId,
          chassis_code: chassisResult.chassisCode,
        });

        // Ensure a chassis_specs record exists for this chassis code.
        // Seed steering_type from VDB advanced decode if available — AI enrichment
        // will fill remaining structural fields (parking_brake_type, has_rear_wiper, etc.).
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertChassisSpecs, {
          chassis_code: chassisResult.chassisCode,
          make_id: makeDoc._id,
          ...(vdbFields?.steeringType ? { steering_type: vdbFields.steeringType } : {}),
        });
        console.log(`[v8] chassis_specs ensured for ${chassisResult.chassisCode}` +
          (vdbFields?.steeringType ? ` (steering=${vdbFields.steeringType} from VDB)` : ""));

        // Find the best sibling config with the same chassis code (any status, highest fill_rate)
        const chassisMatch = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.findBestChassisMatch,
          {
            chassis_code: chassisResult.chassisCode,
            target_config_id: vehicleConfigId,
          },
        );

        if (chassisMatch) {
          console.log(
            `[v8] Chassis sibling found: ${chassisResult.chassisCode} → config ${chassisMatch._id} ` +
            `(${chassisMatch.fill_rate ?? 0}% fill, ${chassisMatch.enrichment_status}). Merging as head start.`
          );

          // Clone whatever data the sibling has — pipeline will fill gaps in Tier 2
          const cloneResult = await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.cloneFromChassisMatch,
            {
              source_config_id: chassisMatch._id,
              target_config_id: vehicleConfigId,
              chassis_code: chassisResult.chassisCode,
            },
          );

          console.log(
            `[v8] Chassis merge done — ${cloneResult.clonedServiceIntervals} intervals, ` +
            `${cloneResult.clonedLaborTimes} labor, ${cloneResult.clonedPartFitments} fitments. ` +
            `Continuing to full enrichment to fill gaps.`
          );
        } else {
          console.log(`[v8] Chassis code ${chassisResult.chassisCode} — first in group, proceeding to full enrichment`);
        }
      } else {
        console.log(`[v8] Chassis code lookup returned null — proceeding to full enrichment`);
      }
    } catch (e) {
      console.warn("[v8] Chassis lookup failed (non-fatal, continuing to full enrichment):", e);
    }

    // STEP 6d: Engine sibling matching — clone engine-bound service data from any config
    // sharing the same engine_id, regardless of chassis/model. Supplements chassis matching.
    try {
      const engineSibling = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.findBestEngineSibling,
        { engine_id: vehicleDoc.engine_id, exclude_config_id: vehicleConfigId },
      );
      if (engineSibling) {
        console.log(
          `[v8] Engine sibling: ${engineSibling.config_key} (${engineSibling.fill_rate ?? 0}% fill) — cloning engine-bound data`
        );
        const cloneResult = await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.cloneFromEngineSibling,
          { source_config_id: engineSibling._id, target_config_id: vehicleConfigId },
        );
        console.log(
          `[v8] Engine clone: ${cloneResult.clonedIntervals} intervals, ${cloneResult.clonedLabor} labor, ${cloneResult.clonedFitments} fitments`
        );
      } else {
        console.log(`[v8] Engine sibling: none found for engine_id=${vehicleDoc.engine_id} — first of this engine`);
      }
    } catch (e) {
      console.warn("[v8] Engine sibling matching failed (non-fatal):", e);
    }

    // STEP 6e: VDB trim specs — seed battery CCA from advanced decode.
    // AI enrichment (Batch 1B) will still search for battery fields and can update this.
    try {
      if (vdbFields?.cca) {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertTrimSpecs, {
          vehicle_config_id: vehicleConfigId,
          battery_cca: vdbFields.cca,
        });
        console.log(`[v8] VDB trim: battery_cca=${vdbFields.cca}`);
      }
    } catch (e) {
      console.warn("[v8] VDB trim specs failed (non-fatal):", e);
    }

    // STEP 7: FireCrawl scrape — parts catalog + owner's manual
    const sources = await scrapeVehicleSources(ctx, vehicle);

    // STEP 8: Submit Batch [1A, 1B]
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
      run_id: runId,
      status: "batch1",
    });

    const batch1Requests: Array<{
      customId: string;
      system: string;
      userPrompt: string;
      maxTokens: number;
      temperature: number;
      maxSearchUses: number;
      blockedDomains?: string[];
      model?: string;
    }> = [
      {
        customId: "batch1a",
        system: BATCH_1_SYSTEM,
        userPrompt: buildBatch1Prompt(vehicle, vPicData, sources.partsMarkdown, sources.manualMarkdown, detectedPackages),
        maxTokens: 8192,
        temperature: 0,
        maxSearchUses: 0,
      },
      {
        customId: "batch1b",
        system: BATCH_1B_SYSTEM,
        userPrompt: buildBatch1bPrompt(vehicle),
        maxTokens: 16384,
        temperature: 0,
        maxSearchUses: 1,
        blockedDomains: BLOCKED_DOMAINS,
      },
    ];

    // v9.8: piggyback the VDB action→slug mapping on Batch 1 as a 1C Haiku request.
    // No web search, structured-extraction only. Result is parsed in _pollBatch1V3
    // and applied to the raw VDB blocks to produce intervals + labor.
    if (vdbRepairRaw && vdbRepairRaw.actions.length > 0) {
      const mapping = buildVDBMappingPrompt(vdbRepairRaw.actions, {
        year: args.year, make: args.make, model: args.model, trim: args.trim,
      });
      batch1Requests.push({
        customId: "batch1c",
        system: mapping.system,
        userPrompt: mapping.userPrompt,
        maxTokens: 4096,
        temperature: 0,
        maxSearchUses: 0,
        model: MODEL_HAIKU,
      });
      console.log(`[v8] Batch 1C (VDB mapping) added: ${vdbRepairRaw.actions.length} actions to map`);
    }

    for (const req of batch1Requests) {
      console.log(`[v8-debug] Batch request ${req.customId}:`);
      console.log(`[v8-debug]   model: sonnet (default)`);
      console.log(`[v8-debug]   system prompt length: ${req.system.length} chars`);
      console.log(`[v8-debug]   user message length: ${req.userPrompt.length} chars`);
      console.log(`[v8-debug]   max_tokens: ${req.maxTokens}`);
      console.log(`[v8-debug]   first 200 chars: ${req.userPrompt.substring(0, 200)}`);
    }

    let batchId: string;
    try {
      batchId = await submitBatch(batch1Requests);
    } catch (e) {
      console.error(`[v8] Batch 1 submission FAILED:`, e);
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: runId,
        status: "failed",
        errors: [`batch1_submission_failed: ${e}`],
      });
      return { status: "error" as const, reason: "batch1_submission_failed" };
    }

    console.log(`[v8] Batch [1A, 1B] submitted (batchId=${batchId}), scheduling poll`);

    await ctx.scheduler.runAfter(
      POLL_INTERVAL_MS,
      internal.vehicleEnrichment.v3pipeline._pollBatch1V3,
      {
        vehicleId: args.vehicleId,
        year: args.year, make: args.make, model: args.model,
        trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
        startTime,
        callLog: [],
        sourceUrls: [...sources.partsSourceUrls, ...sources.manualSourceUrls],
        batchId,
        vPicData: vPicData as any,
        vehicleConfigId,
        engineId: vehicleDoc.engine_id,
        transmissionId: transmissionId ?? undefined,
        makeId: makeDoc._id,
        runId,
        attempt: 1,
        wheelSizeOptions: sources.wheelSizeResult?.tireOptions as any ?? undefined,
        wheelSizeSource: sources.wheelSizeResult?.sourceUrl ?? undefined,
        vdbRepairBlocks: vdbRepairRaw?.blocks ?? undefined,
        vdbRepairActions: vdbRepairRaw?.actions ?? undefined,
      },
    );

    // Schedule tire price scraping in parallel — non-fatal if it fails
    if (sources.wheelSizeResult?.tireOptions?.length) {
      try {
        await ctx.scheduler.runAfter(0, api.tires.scrapeVehicleTires, {
          year: args.year,
          make: args.make,
          model: args.model,
          trim: args.trim,
        });
        console.log(`[v8] Tire scraping scheduled for ${args.year} ${args.make} ${args.model} ${args.trim}`);
      } catch (e) {
        console.warn("[v8] Tire scraping schedule failed (non-fatal):", e);
      }
    }

    return { status: "batch_submitted" as const, configKey, batchId };
  },
});

// ============================================================================
// 2. _pollBatch1V3 — Poll Batch 1A+1B, write to normalized tables
// ============================================================================

export const _pollBatch1V3 = internalAction({
  args: {
    ...vehicleArgs,
    batchId: v.string(),
    vPicData: v.optional(v.any()),
    vehicleConfigId: v.id("vehicle_configs"),
    engineId: v.id("engines"),
    transmissionId: v.optional(v.id("transmissions")),
    makeId: v.id("makes"),
    runId: v.id("enrichment_runs"),
    wheelSizeOptions: v.optional(v.array(v.object({
      oem_name: v.optional(v.string()),
      size_front: v.string(),
      size_rear: v.optional(v.string()),
      width_mm: v.optional(v.number()),
      aspect_ratio: v.optional(v.number()),
      rim_diameter_in: v.optional(v.number()),
      width_mm_rear: v.optional(v.number()),
      aspect_ratio_rear: v.optional(v.number()),
      rim_diameter_in_rear: v.optional(v.number()),
      pressure_front_psi: v.optional(v.number()),
      pressure_rear_psi: v.optional(v.number()),
      load_index: v.optional(v.number()),
      speed_rating: v.optional(v.string()),
      load_index_rear: v.optional(v.number()),
      speed_rating_rear: v.optional(v.string()),
      is_run_flat: v.optional(v.boolean()),
      is_oem_standard: v.optional(v.boolean()),
      wheel_spec: v.optional(v.string()),
    }))),
    wheelSizeSource: v.optional(v.string()),
    vdbRepairBlocks: v.optional(v.array(v.any())),
    vdbRepairActions: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    console.log(`[v8/_pollBatch1] Poll attempt ${attempt} for batchId=${args.batchId}`);

    const status = await getBatchStatus(args.batchId);
    if (status !== "ended") {
      if (attempt >= MAX_POLL_ATTEMPTS) {
        console.error(`[v8/_pollBatch1] Timed out after ${attempt} attempts`);
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
          run_id: args.runId,
          status: "failed",
          errors: ["batch1_timeout"],
        });
        return;
      }
      await ctx.scheduler.runAfter(
        POLL_INTERVAL_MS,
        internal.vehicleEnrichment.v3pipeline._pollBatch1V3,
        { ...args, attempt: attempt + 1 },
      );
      return;
    }

    // Parse Batch 1A + 1B (+ optional 1C VDB mapping)
    const results = await getBatchResults(args.batchId);
    const r1a = results["batch1a"];
    const r1b = results["batch1b"];
    const r1c = results["batch1c"];

    // v9.8: Apply VDB action→slug mapping from 1C, then write intervals + labor.
    // Confidence 0.9 ensures Batch 2 fallback never overwrites this.
    if (r1c && !r1c.error && args.vdbRepairBlocks && args.vdbRepairActions) {
      try {
        const actionMap = parseVDBMappingResponse(
          r1c.data,
          args.vdbRepairActions,
        );
        const vdbResult = applyVDBMappingResult(
          args.vdbRepairBlocks as any[],
          actionMap,
        );
        let intervalCount = 0;
        for (const { slug, interval_miles } of vdbResult.intervals) {
          const svc = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getServiceBySlug,
            { slug },
          );
          if (!svc) continue;
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertServiceInterval, {
            vehicle_config_id: args.vehicleConfigId,
            service_id: svc._id,
            interval_miles,
            status: "active",
            confidence: 0.9,
            data_quality: "vdb_schedule",
          });
          intervalCount++;
        }
        let laborCount = 0;
        for (const [slug, hours] of vdbResult.labor) {
          const svc = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getServiceBySlug,
            { slug },
          );
          if (!svc) continue;
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborTime, {
            vehicle_config_id: args.vehicleConfigId,
            service_id: svc._id,
            book_hours: hours,
            source: "vdb_repair_estimates",
            confidence: 0.9,
          });
          laborCount++;
        }
        console.log(
          `[v8/_pollBatch1] VDB mapping applied: ${intervalCount} intervals, ${laborCount} labor entries ` +
          `(${actionMap.size} actions mapped)`,
        );
      } catch (e) {
        console.warn("[v8/_pollBatch1] VDB mapping apply failed (non-fatal):", e);
      }
    } else if (r1c?.error) {
      console.warn(`[v8/_pollBatch1] batch1c (VDB mapping) ${r1c.error} — skipping VDB writes`);
    }

    if (!r1a) {
      console.error("[v8/_pollBatch1] No batch1a result — aborting");
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: args.runId,
        status: "failed",
        errors: ["no_batch1a_result"],
      });
      return;
    }

    // Fix #3: Detect errored/expired batch requests
    if (r1a.error) {
      console.error(`[v8/_pollBatch1] batch1a ${r1a.error} — aborting`);
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: args.runId,
        status: "failed",
        errors: [`batch1a_${r1a.error}`],
      });
      return;
    }

    if (r1b?.error) {
      console.warn(`[v8/_pollBatch1] batch1b ${r1b.error} — continuing with batch1a only`);
    }

    const callLog: CallLogEntry[] = [
      ...args.callLog,
      { call: "batch1a", tokensIn: r1a.usage.tokensIn, tokensOut: r1a.usage.tokensOut, webSearches: 0, durationMs: 0 },
      ...(r1b && !r1b.error ? [{ call: "batch1b", tokensIn: r1b.usage.tokensIn, tokensOut: r1b.usage.tokensOut, webSearches: r1b.usage.webSearches, durationMs: 0 }] : []),
    ];

    const fields1a = parseBatch1a(r1a.data);
    const fields1b = r1b && !r1b.error ? parseBatch1b(r1b.data) : {};
    let fields = mergeBatch1(fields1a, fields1b);

    // Package-specific OEM parts (only present when assessAvailablePackages
    // detected packages and Claude returned a top-level "packages" block).
    const packageParts = parsePackageParts(r1a.data);
    if (packageParts.size > 0) {
      console.log(
        `[v8/_pollBatch1] Package-specific parts returned for: ${[...packageParts.keys()].join(", ")}`,
      );
    }

    const vehicle: VehicleInput = {
      vehicleId: args.vehicleId,
      year: args.year, make: args.make, model: args.model,
      trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
    };

    // Apply applicability rules
    const vPicData = args.vPicData as VehicleIdentity | null;
    fields = applyApplicabilityRules(fields, vPicData);

    const filledCount = V4_FIELD_KEYS.filter((k) => fields[k]?.value != null).length;
    console.log(`[v8/_pollBatch1] ${filledCount}/${V4_FIELD_KEYS.length} fields after merge+applicability`);

    // Write to normalized tables
    const serviceCache = new Map<string, Id<"services">>();
    await writeNormalizedData(
      ctx, fields,
      args.vehicleConfigId, args.engineId, args.transmissionId,
      args.makeId, args.runId, args.make, serviceCache,
      args.wheelSizeOptions,
      args.wheelSizeSource,
      packageParts,
    );

    // Submit Batch 2
    const oemParts = getOemParts(fields);
    const nullFields = getNullFields(fields);
    console.log(`[v8/_pollBatch1] ${nullFields.length} null fields for Batch 2 gap fill`);

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
      run_id: args.runId,
      status: "batch2",
      total_tokens_in: callLog.reduce((s, c) => s + c.tokensIn, 0),
      total_tokens_out: callLog.reduce((s, c) => s + c.tokensOut, 0),
      total_web_searches: callLog.reduce((s, c) => s + c.webSearches, 0),
    });

    let batch2Id: string;
    try {
      batch2Id = await submitBatch([
        {
          customId: "batch2",
          system: BATCH_2_SYSTEM,
          userPrompt: buildBatch2Prompt(vehicle, nullFields, oemParts),
          maxTokens: 16384,
          temperature: 0,
          maxSearchUses: 1,
          blockedDomains: BLOCKED_DOMAINS,
        },
      ]);
    } catch (e) {
      console.error(`[v8] Batch 2 submission FAILED:`, e);
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: args.runId,
        status: "failed",
        errors: [`batch2_submission_failed: ${e}`],
      });
      return;
    }

    await ctx.scheduler.runAfter(
      POLL_INTERVAL_MS,
      internal.vehicleEnrichment.v3pipeline._pollBatch2V3,
      {
        vehicleId: args.vehicleId,
        year: args.year, make: args.make, model: args.model,
        trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
        startTime: args.startTime,
        callLog,
        sourceUrls: args.sourceUrls,
        batchId: batch2Id,
        batch1Fields: fields as any,
        nullFields,
        vehicleConfigId: args.vehicleConfigId,
        engineId: args.engineId,
        transmissionId: args.transmissionId,
        makeId: args.makeId,
        runId: args.runId,
        attempt: 1,
      },
    );
  },
});

// ============================================================================
// 3. _pollBatch2V3 — Poll Batch 2, gap fill + pricing + finalize
// ============================================================================

export const _pollBatch2V3 = internalAction({
  args: {
    ...vehicleArgs,
    batchId: v.string(),
    batch1Fields: v.any(),
    nullFields: v.array(v.string()),
    vehicleConfigId: v.id("vehicle_configs"),
    engineId: v.id("engines"),
    transmissionId: v.optional(v.id("transmissions")),
    makeId: v.id("makes"),
    runId: v.id("enrichment_runs"),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    console.log(`[v8/_pollBatch2] Poll attempt ${attempt} for batchId=${args.batchId}`);

    const status = await getBatchStatus(args.batchId);
    if (status !== "ended") {
      if (attempt >= MAX_POLL_ATTEMPTS) {
        console.error("[v8/_pollBatch2] Timed out — storing partial results");
      } else {
        await ctx.scheduler.runAfter(
          POLL_INTERVAL_MS,
          internal.vehicleEnrichment.v3pipeline._pollBatch2V3,
          { ...args, attempt: attempt + 1 },
        );
        return;
      }
    }

    const results = await getBatchResults(args.batchId);
    const r2 = results["batch2"];

    // Fix #3: Detect errored/expired batch2 request
    if (r2?.error) {
      console.error(`[v8/_pollBatch2] batch2 ${r2.error} — continuing with batch1 data only`);
      // Don't abort — we still have batch1 data, just skip gap fill
    }

    const callLog: CallLogEntry[] = [
      ...args.callLog,
      ...(r2 && !r2.error ? [{ call: "batch2", tokensIn: r2.usage.tokensIn, tokensOut: r2.usage.tokensOut, webSearches: r2.usage.webSearches, durationMs: 0 }] : []),
    ];

    let allFields: Record<string, FieldResult> = { ...args.batch1Fields };
    let services: ServicePricingResult[] = [];

    if (r2 && !r2.error) {
      // Gap fill — only fill nulls
      const parsed = parseBatch2(r2.data, args.nullFields);
      const gapFields = parsed.gapFields;
      services = parsed.services;
      for (const [k, fv] of Object.entries(gapFields)) {
        if (allFields[k]?.value == null) {
          allFields[k] = fv;
        }
      }

      // Pricing fields
      const pricingFields = mapPricingToFields(services);
      for (const [k, fv] of Object.entries(pricingFields)) {
        if (allFields[k]?.value == null) {
          allFields[k] = fv;
        }
      }

    }

    // Validation — MUST run BEFORE writeNormalizedData so bad values get nulled first
    const vehicle: VehicleInput = {
      vehicleId: args.vehicleId,
      year: args.year, make: args.make, model: args.model,
      trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
    };
    // Use the real cylinder count from the engines table (written upstream
    // from NHTSA's EngineCylinders during processVin). The previous code
    // inferred cylinders from displacement via a hardcoded `>=4 ? 8 : >=2.5
    // ? 6 : 4` ladder, which mishandled I3 (1.0-1.5L), I5 (Audi RS3), V10
    // (R8, M5 E60), V12, W12 — and silently fed wrong values to
    // runSanityChecks. Fallback to 4 only if the engines table read failed
    // entirely (rare; sanity checks just become less informative).
    //
    // Fetched fresh here because this action (_pollBatch2V3) doesn't receive
    // vPicData via args — the first-action local `vPicData` is out of scope.
    const enginePicData = await ctx.runQuery(
      internal.vehicleEnrichment.nhtsa.getIdentity,
      { vehicleId: args.vehicleId },
    );
    const cylinders = enginePicData?.cylinders ?? 4;
    const sanityFlags = runSanityChecks(allFields, cylinders);
    const oemFlags = validateAllOemParts(allFields, vehicle.make);
    if (sanityFlags.length > 0) console.log(`[v8] Sanity: ${sanityFlags.length} flags (applied before write)`);
    if (oemFlags.length > 0) console.log(`[v8] OEM: ${oemFlags.length} issues`);

    // Write sanitized data to normalized tables
    if (r2) {
      const serviceCache = new Map<string, Id<"services">>();
      await writeNormalizedData(
        ctx, allFields,
        args.vehicleConfigId, args.engineId, args.transmissionId,
        args.makeId, args.runId, args.make, serviceCache,
      );

      // Write labor times from Batch 2 pricing
      for (const svc of services) {
        if (!svc.is_applicable) continue;
        const laborVal = asNumber(svc.labor_hours?.value);
        if (laborVal == null) continue;

        const slug = SERVICE_NAME_TO_SLUG[svc.service_name];
        if (!slug) continue;

        const serviceId = await resolveServiceId(ctx, slug, serviceCache);
        if (!serviceId) continue;

        const engineDoc = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getEngine,
          { engineId: args.engineId },
        );

        // Determine source type: web_search only if there's a real, non-blocked source URL
        const laborSourceUrl = svc.labor_hours?.source_url;
        const isWebSource = laborSourceUrl && !isBlockedDomain(laborSourceUrl);
        const laborSource = isWebSource ? "web_search" as const : "training_data" as const;
        const laborConfidence = isWebSource ? 0.85 : 0.75;

        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborTime, {
          vehicle_config_id: args.vehicleConfigId,
          service_id: serviceId,
          book_hours: laborVal,
          source: laborSource,
          confidence: laborConfidence,
          engine_family: engineDoc?.engine_family,
        });
      }

      // Write part prices from Batch 2 pricing.
      //
      // Authoritative path: svc.parts_breakdown[] — one entry per OEM part with
      // its own per-unit price + source URL. Each entry maps directly to one
      // part_prices row via oem_part_number → part_id (resolved from existing
      // part_fitments rows for this vehicle_config + service).
      //
      // Per-part prices land INDEPENDENTLY of any service-level total — a
      // BMW oil_change with `parts_cost_low: null` still writes prices for the
      // filter, gasket, and oil bottle as long as Claude itemized them.
      //
      // Fallback path: when Claude couldn't itemize and only returned a
      // service-level parts_cost_low, stamp that per-unit price on every
      // fitment in the service. Same behavior as before the breakdown was
      // introduced; preserved for legacy / sparse-data cases.
      for (const svc of services) {
        if (!svc.is_applicable) continue;

        const slug = SERVICE_NAME_TO_SLUG[svc.service_name];
        if (!slug) continue;

        const fitments = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getFitmentsByConfigAndService,
          { vehicleConfigId: args.vehicleConfigId, serviceType: slug },
        );
        if (fitments.length === 0) continue;

        // Preferred: itemized parts_breakdown — write each part's own price.
        if (svc.parts_breakdown && svc.parts_breakdown.length > 0) {
          // Build a quick oem_number → part_id lookup. Same OEM may have
          // multiple fitments under one service (base + package variant) —
          // every match gets the same per-unit price.
          const numberToPartIds = new Map<string, Id<"oem_parts">[]>();
          for (const f of fitments) {
            const num = (f as any).oem_part_number;
            if (!num) continue;
            const arr = numberToPartIds.get(num) ?? [];
            arr.push(f.part_id);
            numberToPartIds.set(num, arr);
          }

          for (const entry of svc.parts_breakdown) {
            if (entry.price_low == null) continue;
            const partIds = numberToPartIds.get(entry.oem_part_number);
            if (!partIds || partIds.length === 0) continue;
            const sourceDomain = entry.source_domain ?? extractDomain(entry.source_url ?? undefined) ?? "enrichment";
            for (const partId of partIds) {
              await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
                part_id:       partId,
                price:         entry.price_low,
                price_type:    "online_discount",
                source_url:    entry.source_url ?? undefined,
                source_domain: sourceDomain,
              });
            }
          }
          continue; // breakdown handled this service — don't fall through
        }

        // Fallback: legacy service-level price. Store as per-unit on each
        // fitment in the service (no division — the prompt contracts the
        // service-level price as per-unit too).
        const priceVal = asNumber(svc.parts_cost_low?.value);
        if (priceVal == null) continue;
        for (const fitment of fitments) {
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
            part_id:       fitment.part_id,
            price:         priceVal,
            price_type:    "online_discount",
            source_domain: extractDomain(svc.parts_cost_low?.source_url) ?? "enrichment",
            source_url:    svc.parts_cost_low?.source_url ?? undefined,
          });
        }
      }
    }

    // Finalize
    const flatFillRate = calculateFlatFillRate(allFields);
    const durationMs = Date.now() - args.startTime;
    const totalTokensIn = callLog.reduce((s, c) => s + c.tokensIn, 0);
    const totalTokensOut = callLog.reduce((s, c) => s + c.tokensOut, 0);
    const totalWebSearches = callLog.reduce((s, c) => s + c.webSearches, 0);

    // Calculate v3 normalized fill rate
    const { rate: fillRate, breakdown } = await calculateV3FillRate(
      ctx, args.vehicleConfigId, args.engineId, args.transmissionId,
    );
    console.log(`[v8] Fill rate: ${fillRate}% (flat: ${flatFillRate}%)`);
    console.log(`[v8] Breakdown: ${breakdown}`);

    // Compute weighted average confidence from all evidence rows for this run
    const allEvidence = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getEvidenceByRun,
      { enrichmentRunId: args.runId },
    );
    let confidenceAvg: number | undefined;
    if (allEvidence.length > 0) {
      const SOURCE_WEIGHTS: Record<string, number> = {
        mechanic: 1.0,
        web_search: 0.9,
        training_data: 0.75,
      };
      let weightedSum = 0;
      let weightSum = 0;
      for (const ev of allEvidence) {
        const conf = ev.confidence ?? 0;
        const weight = SOURCE_WEIGHTS[ev.source_type ?? ""] ?? 0.8;
        weightedSum += conf * weight;
        weightSum += weight;
      }
      confidenceAvg = weightSum > 0 ? weightedSum / weightSum : 0;
      console.log(`[v8] Confidence avg: ${confidenceAvg.toFixed(3)} from ${allEvidence.length} evidence rows`);
    }

    // Update enrichment run
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
      run_id: args.runId,
      status: "complete",
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      total_web_searches: totalWebSearches,
      completed_at: Date.now(),
      duration_ms: durationMs,
      fields_filled: V4_FIELD_KEYS.filter((k) => allFields[k]?.value != null).length,
      fields_total: V4_FIELD_KEYS.length,
      fill_rate: fillRate,
      fields_changed: V4_FIELD_KEYS.filter((k) => allFields[k]?.value != null),
      errors: [
        ...sanityFlags.map((f) => `sanity:${f.field}:${f.reason}`),
        ...oemFlags.map((f) => `oem:${f.field}:${f.reason}`),
      ],
    });

    // Read current vehicle_config to get resolved drivetrain
    const currentVcForFinal = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicleConfigId },
    );

    // Update vehicle_config status — use the actual config_key from DB (may differ from
    // buildEngineKey(vehicle) if the engine code was resolved from a NHTSA descriptor)
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertVehicleConfig, {
      config_key: currentVcForFinal?.config_key ?? buildEngineKey(vehicle),
      year: args.year,
      make_id: args.makeId,
      model_id: (await ctx.runQuery(internal.vehicleEnrichment.v3queries.getModelByMakeAndName, { makeId: args.makeId, name: args.model }))?._id ?? args.makeId as any,
      engine_id: args.engineId,
      transmission_id: args.transmissionId,
      drivetrain: (allFields.drivetrain?.value as string) ?? currentVcForFinal?.drivetrain ?? "FWD",
      trim_name: args.trim,
      trim_slug: slugify(args.trim),
      enrichment_status: fillRate >= 70 ? "complete" : "partial",
      fill_rate: fillRate,
      enrichment_version: "v8",
    });

    // Write confidence_avg + last_enriched_at to vehicle_config
    if (confidenceAvg !== undefined) {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
        vehicle_config_id: args.vehicleConfigId,
        confidence_avg: confidenceAvg,
        last_enriched_at: Date.now(),
      });
    }

    // Attach to vehicle
    await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
      { vehicle_id: args.vehicleId, vehicle_config_id: args.vehicleConfigId },
    );

    // Update source reliability scores based on consensus
    try {
      await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.runSourceScoring,
        { enrichment_run_id: args.runId },
      );
    } catch (e) {
      console.warn("[v8] Source scoring failed (non-fatal):", e);
    }

    // Post-enrichment: trigger source discovery if this make has < 3 registered sources.
    // Runs async (scheduled) so it doesn't block the completion path.
    try {
      const existingSources = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getSourcesForMake,
        { make_id: args.makeId },
      );
      if (existingSources.length < 3) {
        console.log(
          `[v8] Source discovery: ${args.make} has ${existingSources.length} sources — scheduling discovery`
        );
        await ctx.scheduler.runAfter(
          5_000, // 5s delay to let the completion settle
          internal.vehicleEnrichment.sourceDiscovery.discoverSourcesForMake,
          {
            make_id: args.makeId,
            make_name: args.make,
            test_year: args.year,
            test_model: args.model,
            test_trim: args.trim,
          },
        );
      }
    } catch (e) {
      console.warn("[v8] Source discovery trigger failed (non-fatal):", e);
    }

    // Post-enrichment: chassis backfill — push newly discovered data to sibling configs
    // that share the same chassis code. This makes the whole chassis group smarter over time.
    try {
      const freshConfig = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleConfigById,
        { vehicleConfigId: args.vehicleConfigId },
      );
      if (freshConfig?.chassis_code) {
        // Push enriched data to sibling vehicle_configs on the same chassis
        const siblings = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.findChassisGroupSiblings,
          {
            chassis_code: freshConfig.chassis_code,
            exclude_config_id: args.vehicleConfigId,
          },
        );
        if (siblings.length > 0) {
          const backfillResult = await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.backfillChassisSiblings,
            {
              source_config_id: args.vehicleConfigId,
              sibling_config_ids: siblings.map((s: any) => s._id),
            },
          );
          console.log(
            `[v8] Chassis backfill: pushed ${backfillResult.totalBackfilled} records to ${siblings.length} sibling(s) (${freshConfig.chassis_code})`
          );
        }

        // Also push platform-level specs to chassis_specs (shared across all vehicles on this platform)
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertChassisSpecs, {
          chassis_code: freshConfig.chassis_code,
          ...(freshConfig.ps_fluid_type ? { ps_fluid_type: freshConfig.ps_fluid_type } : {}),
          ...(freshConfig.brake_fluid_type ? { brake_fluid_type: freshConfig.brake_fluid_type } : {}),
        });
        console.log(`[v8] chassis_specs updated for ${freshConfig.chassis_code}`);
      }
    } catch (e) {
      console.warn("[v8] Chassis backfill failed (non-fatal):", e);
    }


    // Post-enrichment: engine sibling backfill — push newly discovered engine-bound data
    // to all other vehicle_configs sharing the same engine_id.
    try {
      const engineSiblings = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.findEngineSiblings,
        { engine_id: args.engineId, exclude_config_id: args.vehicleConfigId },
      );
      if (engineSiblings.length > 0) {
        const backfillResult = await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.backfillEngineSiblings,
          {
            source_config_id: args.vehicleConfigId,
            sibling_config_ids: engineSiblings.map((s: any) => s._id),
          },
        );
        console.log(
          `[v8] Engine backfill: pushed ${backfillResult.totalBackfilled} records to ${engineSiblings.length} sibling(s)`
        );
      } else {
        console.log(`[v8] Engine backfill: no siblings to push to for engine_id=${args.engineId}`);
      }
    } catch (e) {
      console.warn("[v8] Engine sibling backfill failed (non-fatal):", e);
    }

    // Post-enrichment: push AI-discovered structural attributes to chassis_specs.
    // Reads from the enriched vehicle_config and drivetrain_config to update the
    // shared chassis_specs record that all vehicles on this platform will inherit.
    try {
      const freshConfig = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleConfigById,
        { vehicleConfigId: args.vehicleConfigId },
      );
      if (freshConfig?.chassis_code) {
        const drivetrainCfg = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getDrivetrainConfig,
          { vehicleConfigId: args.vehicleConfigId },
        );
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertChassisSpecs, {
          chassis_code: freshConfig.chassis_code,
          ...(freshConfig.ps_fluid_type ? { ps_fluid_type: freshConfig.ps_fluid_type } : {}),
          ...(freshConfig.brake_fluid_type ? { brake_fluid_type: freshConfig.brake_fluid_type } : {}),
        });
        console.log(`[v8] chassis_specs backfilled for ${freshConfig.chassis_code}`);
      }
    } catch (e) {
      console.warn("[v8] chassis_specs backfill failed (non-fatal):", e);
    }

    // Post-enrichment: ensure all 23 services have at least a default interval (Task 21).
    // Only fills MISSING services — never overwrites enriched data.
    try {
      const fallbackResult = await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.ensureAllServiceIntervals,
        { vehicle_config_id: args.vehicleConfigId },
      );
      if (fallbackResult.added > 0) {
        console.log(
          `[v8] Service fallback: added ${fallbackResult.added} defaults, skipped ${fallbackResult.skipped} non-applicable`
        );
      }
    } catch (e) {
      console.warn("[v8] Service fallback failed (non-fatal):", e);
    }

    // Post-enrichment: fill missing labor times from services.default_labor_hours.
    // Confidence 0.45 — lower than Batch 2 training_data (0.75) so real data always wins.
    try {
      const laborFallbackResult = await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.ensureAllLaborTimes,
        { vehicle_config_id: args.vehicleConfigId },
      );
      if (laborFallbackResult.added > 0) {
        console.log(
          `[v8] Labor fallback: added ${laborFallbackResult.added} defaults, skipped ${laborFallbackResult.skipped} non-applicable/no-default`
        );
      }
    } catch (e) {
      console.warn("[v8] Labor fallback failed (non-fatal):", e);
    }

    // Recalculate fill rate now that fallbacks have added all default intervals + labor times.
    try {
      const { rate: finalFillRate } = await calculateV3FillRate(
        ctx, args.vehicleConfigId, args.engineId, args.transmissionId,
      );
      if (finalFillRate !== fillRate) {
        console.log(`[v8] Fill rate updated post-fallback: ${fillRate}% → ${finalFillRate}%`);
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
          vehicle_config_id: args.vehicleConfigId,
          fill_rate: finalFillRate,
          enrichment_status: finalFillRate >= 70 ? "complete" : "partial",
        });
      }
    } catch (e) {
      console.warn("[v8] Post-fallback fill rate recalculation failed (non-fatal):", e);
    }

    // Notify owners on the partial → complete transition. Fires only when the
    // status genuinely flipped — currentVcForFinal was captured BEFORE this
    // run's writes (line 2040), so comparing it to the final post-fallback
    // state catches the "first time complete" case without re-firing on later
    // re-runs that find the config already complete.
    try {
      const updated = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleConfigById,
        { vehicleConfigId: args.vehicleConfigId },
      );
      const previousStatus = (currentVcForFinal as any)?.enrichment_status;
      const newStatus = (updated as any)?.enrichment_status;
      if (previousStatus !== "complete" && newStatus === "complete") {
        console.log(`[v8] enrichment_status: ${previousStatus ?? "(none)"} → complete — notifying owners`);
        await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.notifyEnrichmentComplete,
          { vehicle_config_id: args.vehicleConfigId },
        );
      }
    } catch (e) {
      console.warn("[v8] Enrichment-complete notification failed (non-fatal):", e);
    }

    // Post-enrichment: adversarial self-verification (Task 26).
    // Challenges suspicious values (outlier capacities, mismatched specs) with a second
    // Haiku pass. Runs async so it doesn't block the completion path.
    try {
      await ctx.scheduler.runAfter(
        10_000, // 10s delay to let writes settle
        internal.vehicleEnrichment.adversarialVerification.runAdversarialVerification,
        { vehicle_config_id: args.vehicleConfigId },
      );
      console.log("[v8] Adversarial verification scheduled");
    } catch (e) {
      console.warn("[v8] Adversarial verification trigger failed (non-fatal):", e);
    }

    // Post-enrichment: backfill engine_id / transmission_id onto the vehicles row,
    // propagate engine_id + chassis_id to labor_quote_snapshots (chassis_id comes
    // from whatever the vehicle already has), and seed the vehicle_passport with
    // OEM fluid specs. Walk-in bookings create vehicle rows without these IDs;
    // this closes the gap once enrichment resolves them.
    try {
      await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.backfillVehicleEngineIds,
        {
          vehicle_id: args.vehicleId,
          engine_id: args.engineId,
          vehicle_config_id: args.vehicleConfigId,
          ...(args.transmissionId ? { transmission_id: args.transmissionId } : {}),
        },
      );
      console.log(`[v8] Engine IDs + snapshot backfill complete for vehicle ${args.vehicleId}`);
    } catch (e) {
      console.warn("[v8] Vehicle engine ID backfill failed (non-fatal):", e);
    }

    console.log(
      `[v8] COMPLETE: ${buildEngineKey(vehicle)} — fillRate=${fillRate}% (flat=${flatFillRate}%), ` +
      `tokens=${totalTokensIn}in/${totalTokensOut}out, ` +
      `searches=${totalWebSearches}, time=${Math.round(durationMs / 1000)}s`,
    );
  },
});
