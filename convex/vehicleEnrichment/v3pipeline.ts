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
import { buildEngineKey, emptyField, V4_FIELD_KEYS, SIBLING_SAFE_FIELDS, ON_DEMAND_SERVICE_SLUGS } from "./types";
import { submitBatch, getBatchStatus, getBatchResults } from "./utils/batchClient";
import { BATCH_1_SYSTEM, buildBatch1Prompt } from "./prompts/batch1Prompt";
import { BATCH_1B_SYSTEM, buildBatch1bPrompt } from "./prompts/batch1bPrompt";
import { BATCH_2_SYSTEM, buildBatch2Prompt } from "./prompts/batch2Prompt";
import { GAP_FILL_SYSTEM, buildGapFillPrompt } from "./prompts/gapFillPrompt";
import { callClaudeWithWebSearch } from "./utils/claudeClient";
import { deriveEngineFamily } from "./laborSibling";
import { runSanityChecks, normalizeOilViscosity, aggregateFieldConfidence } from "./validation/sanityChecks";
import { resolveCapacities } from "./capacityResolver";
import { validateAllOemParts } from "./validation/oemValidation";
import { BLOCKED_DOMAINS, isMarketplaceUrl } from "./sourceRegistry";
import { applyApplicabilityRules, applyVerifiedEngineFields, applyKnownEngineFacts } from "./applicabilityRules";
import { scrapeVehicleSources } from "./scraper";
import { normalizeOemNumber } from "./priceParser";
import { reextractPartPrice, isAffirmativeRejection, priceAllSources } from "./priceReextract";
import { extractPriceFirecrawl } from "./firecrawl";
import { discoverPriceUrls } from "./priceDiscovery";
import { UNVERIFIED_PRICE_TYPE } from "../lib/priceTypes";
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
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
import { laborFlagsFromEnv } from "./laborResearch";
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
  f.brake_fluid_capacity_oz = parseField(fluids.brake_fluid_capacity_oz);
  f.ps_fluid_capacity_oz = parseField(fluids.ps_fluid_capacity_oz);
  f.transmission_fluid_capacity_qts = parseField(fluids.transmission_fluid_capacity_qts);

  // Intervals
  const intervals = data.intervals ?? {};
  for (const key of ["oil_change", "spark_plug", "transmission_service", "coolant_flush", "air_filter", "cabin_filter", "brake_fluid_flush", "serpentine_belt", "brake_pads", "tire_rotation"]) {
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
    "rotor_front_oem", "rotor_rear_oem", "battery_oem", "coolant_oem", "engine_oil_oem",
    // Service Parts Reference expansion (§5) — every reference role's OEM SKU.
    "oil_filter_housing_oring_oem", "ignition_coil_oem", "intake_manifold_gasket_oem",
    "timing_kit_oem", "water_pump_oem", "atf_fluid_oem", "trans_filter_oem",
    "trans_pan_gasket_oem", "brake_fluid_oem", "ps_fluid_oem", "gear_oil_oem",
    "friction_modifier_oem", "brake_hardware_kit_front_oem", "brake_hardware_kit_rear_oem",
    "brake_wear_sensor_front_oem", "brake_wear_sensor_rear_oem",
    // coolant_flush / transmission_service discovery (2026-07)
    "thermostat_oem", "thermostat_gasket_oem",
    "cvt_internal_filter_oem", "cvt_external_filter_oem"]) {
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
    // Service Parts Reference expansion (§5) — every reference role's OEM SKU.
    "oil_filter_housing_oring_oem", "ignition_coil_oem", "intake_manifold_gasket_oem",
    "timing_kit_oem", "water_pump_oem", "atf_fluid_oem", "trans_filter_oem",
    "trans_pan_gasket_oem", "brake_fluid_oem", "ps_fluid_oem", "gear_oil_oem",
    "friction_modifier_oem", "brake_hardware_kit_front_oem", "brake_hardware_kit_rear_oem",
    "brake_wear_sensor_front_oem", "brake_wear_sensor_rear_oem",
    // coolant_flush / transmission_service discovery (2026-07)
    "thermostat_oem", "thermostat_gasket_oem",
    "cvt_internal_filter_oem", "cvt_external_filter_oem",
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

  // Additional 1B fields: new fluid types + capacities + intervals
  const fluids = data.fluids ?? {};
  f.trans_fluid_type = parseField(fluids.trans_fluid_type);
  f.diff_fluid_type = parseField(fluids.diff_fluid_type);
  f.transfer_case_fluid_type = parseField(fluids.transfer_case_fluid_type);
  f.diff_fluid_capacity_qts = parseField(fluids.diff_fluid_capacity_qts);
  f.transfer_case_fluid_capacity_qts = parseField(fluids.transfer_case_fluid_capacity_qts);

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

/** Fields Batch 2 should gap-fill: null AND not deliberately nulled. A field
 *  the applicability rules stamped flag_reason="not_applicable" is FINAL —
 *  asking Batch 2 to re-search it resurrected impossible data (chain cars
 *  grew timing-belt parts, and FWD diff fields could come back the same way).
 *  Jun-9 review medium finding; exported for tests. */
export function getNullFields(fields: Record<string, FieldResult>): string[] {
  return V4_FIELD_KEYS.filter(
    (k) =>
      fields[k]?.value == null && fields[k]?.flag_reason !== "not_applicable",
  );
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

/**
 * Per-field empty-reason ledger, persisted to enrichment_runs.field_gaps.
 * sanity_flags only explains fields that HAD a value and failed a rule; this
 * covers the other side — every V4 field that ended the run null, and why —
 * so completion work can be targeted instead of guessed at. Exported for
 * tests. Pure.
 *
 * Reasons:
 *   never_asked          — field key absent from the merged field map
 *   not_applicable       — deliberately nulled by applicability rules (final)
 *   validation_dropped:X — extracted, then nulled by sanity/authority/sanitize
 *   llm_null             — asked in every batch, no source produced a value
 */
export function classifyFieldGaps(
  fields: Record<string, FieldResult>,
  sanityFlags: Array<{ field: string; severity: string; reason: string }>,
): Array<{ field: string; reason: string }> {
  const rejectedBySanity = new Map<string, string>();
  for (const f of sanityFlags) {
    if (f.severity === "reject") rejectedBySanity.set(f.field, f.reason);
  }
  const gaps: Array<{ field: string; reason: string }> = [];
  for (const k of V4_FIELD_KEYS) {
    const f = fields[k];
    if (f?.value != null) continue;
    if (f == null) {
      gaps.push({ field: k, reason: "never_asked" });
      continue;
    }
    if (f.flag_reason === "not_applicable") {
      gaps.push({ field: k, reason: "not_applicable" });
      continue;
    }
    const sanityReason = rejectedBySanity.get(k);
    if (sanityReason) {
      gaps.push({ field: k, reason: `validation_dropped:${sanityReason}` });
      continue;
    }
    if (f.flagged && f.flag_reason) {
      gaps.push({ field: k, reason: `validation_dropped:${f.flag_reason}` });
      continue;
    }
    gaps.push({ field: k, reason: "llm_null" });
  }
  return gaps;
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
      || si.status === "on_demand"
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

/** Batch-2 URL rejection: spec-quality blocklist + marketplaces. A marketplace
 *  entry keeps its price_low but loses the URL, so the part flows into the
 *  discovery fallback instead of being scraped from an untrustable listing. */
function isRejectedPriceUrl(url: string | null | undefined): boolean {
  return isBlockedDomain(url) || isMarketplaceUrl(url);
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
    if (raw && !isRejectedPriceUrl(raw.source_url)) {
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
        const blocked = isRejectedPriceUrl(sanitizedSourceUrl);
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
  // Batch-2's prompt SERVICE_LIST asks about this service, but the map had no
  // entry — so `SERVICE_NAME_TO_SLUG[name]` returned undefined and the pricing
  // + labor loops silently `continue`d: gear_oil / friction_modifier fitments
  // were NEVER priced and differential labor estimates were dropped.
  // ("Transfer Case Fluid Service" stays unmapped on purpose: there is no
  // separate TC service in the 23 and conflating its labor into
  // differential_service would skew the anchor.)
  "Differential Fluid Service": "differential_service",
};

/**
 * Map OEM part field to { name, category, subcategory, serviceSlug, serviceRole, position }.
 *
 * `serviceRole` is the Service Parts Reference role this part plays within its
 * service — "core" (on essentially every invoice; locked price), "as_needed"
 * (situational discovery; makes the quote a range), or "kit" (variant bundle:
 * timing kit, trans pan service). Derived 1:1 from
 * convex/lib/servicePartsReference.ts by (serviceSlug, subcategory); the
 * resolver stamps it on the snapshot. NOT oem_parts.part_tier (part quality)
 * nor VehicleTier (pricing tier). serpentine_belt / wipers have no reference
 * service (not in the 23) — left "core" with their existing slugs.
 */
export const PART_FIELD_MAP: Record<string, {
  name: string;
  category: string;
  subcategory: string;
  serviceSlug: string | null;
  serviceRole: "core" | "as_needed" | "kit";
  position?: string;
}> = {
  oil_filter_oem: { name: "Oil Filter", category: "filter", subcategory: "oil_filter", serviceSlug: "oil_change", serviceRole: "core" },
  drain_plug_gasket_oem: { name: "Oil Drain Plug Gasket", category: "gasket", subcategory: "drain_plug_gasket", serviceSlug: "oil_change", serviceRole: "core" },
  air_filter_oem: { name: "Engine Air Filter", category: "filter", subcategory: "air_filter", serviceSlug: "filter_replacement", serviceRole: "core" },
  cabin_filter_oem: { name: "Cabin Air Filter", category: "filter", subcategory: "cabin_filter", serviceSlug: "filter_replacement", serviceRole: "core" },
  spark_plug_oem: { name: "Spark Plug", category: "ignition", subcategory: "spark_plug", serviceSlug: "spark_plugs", serviceRole: "core" },
  front_brake_pad_oem: { name: "Front Brake Pads", category: "brake", subcategory: "front_brake_pad", serviceSlug: "brake_pad_replacement", serviceRole: "core", position: "front" },
  rear_brake_pad_oem: { name: "Rear Brake Pads", category: "brake", subcategory: "rear_brake_pad", serviceSlug: "brake_pad_replacement", serviceRole: "core", position: "rear" },
  rotor_front_oem: { name: "Front Brake Rotor", category: "rotor", subcategory: "front_rotor", serviceSlug: "rotor_replacement", serviceRole: "core", position: "front" },
  rotor_rear_oem: { name: "Rear Brake Rotor", category: "rotor", subcategory: "rear_rotor", serviceSlug: "rotor_replacement", serviceRole: "core", position: "rear" },
  // serviceSlug INTENTIONALLY null: the fitment lands as service_type
  // "serpentine_belt" (serviceSlug ?? subcategory) — timing_belt borrows it
  // via the reference role's fitmentService: "serpentine_belt", and Batch-2
  // pricing looks it up under SERVICE_NAME_TO_SLUG["Serpentine Belt
  // Replacement"] = "serpentine_belt". Pointing it at "timing_belt" would
  // break both lookups.
  serpentine_belt_oem: { name: "Serpentine Belt", category: "belt", subcategory: "serpentine_belt", serviceSlug: null, serviceRole: "core" },
  timing_belt_oem: { name: "Timing Belt", category: "timing", subcategory: "timing_belt", serviceSlug: "timing_belt", serviceRole: "core" },
  // Front wipers ship as a set (driver + passenger as one part). Rear wiper is its own part.
  wiper_blade_set_oem: { name: "Wiper Blade Set (Front)", category: "wiper", subcategory: "wiper_blade_front_set", serviceSlug: "wiper_blade_replacement", serviceRole: "core", position: "front" },
  wiper_blade_rear_oem: { name: "Wiper Blade (Rear)", category: "wiper", subcategory: "wiper_blade_rear", serviceSlug: "wiper_blade_replacement", serviceRole: "core", position: "rear" },
  battery_oem: { name: "Battery", category: "electrical", subcategory: "battery", serviceSlug: "battery_replacement", serviceRole: "core" },
  coolant_oem: { name: "Coolant", category: "cooling", subcategory: "coolant", serviceSlug: "coolant_flush", serviceRole: "core" },
  // Bottle-SKU OEM engine oil. quantity_needed on the resulting fitment stays
  // unset; quoting multiplies the per-bottle price by oil_capacity_qts from
  // engine_specs at quote time. Mirrors how coolant_oem is sized via
  // coolant_capacity_qts — the fitment is per-unit, the engine row supplies qty.
  engine_oil_oem: { name: "Engine Oil", category: "fluid", subcategory: "engine_oil", serviceSlug: "oil_change", serviceRole: "core" },

  // ── Service Parts Reference expansion (§5) — every reference role gets a
  // discovered + priced OEM SKU. Conditional existence IS the data: a null
  // from the prompt means the vehicle doesn't use that part. ──────────────────
  // oil_change extras
  oil_filter_housing_oring_oem: { name: "Oil Filter Housing Cap O-Ring", category: "gasket", subcategory: "oil_filter_housing_oring", serviceSlug: "oil_change", serviceRole: "core" },
  // spark_plugs extras (discovery)
  ignition_coil_oem: { name: "Ignition Coil", category: "ignition", subcategory: "ignition_coil", serviceSlug: "spark_plugs", serviceRole: "as_needed" },
  intake_manifold_gasket_oem: { name: "Intake Manifold Gasket", category: "gasket", subcategory: "intake_manifold_gasket", serviceSlug: "spark_plugs", serviceRole: "as_needed" },
  // timing_belt kit bundle
  timing_kit_oem: { name: "Timing Kit (tensioner, idlers, seals)", category: "timing", subcategory: "timing_kit", serviceSlug: "timing_belt", serviceRole: "kit" },
  water_pump_oem: { name: "Water Pump", category: "cooling", subcategory: "water_pump", serviceSlug: "timing_belt", serviceRole: "kit" },
  // transmission_service fluid + pan-service kit
  atf_fluid_oem: { name: "Transmission Fluid (ATF / CVT)", category: "fluid", subcategory: "atf_fluid", serviceSlug: "transmission_service", serviceRole: "core" },
  trans_filter_oem: { name: "Transmission Filter", category: "filter", subcategory: "trans_filter", serviceSlug: "transmission_service", serviceRole: "kit" },
  trans_pan_gasket_oem: { name: "Transmission Pan Gasket", category: "gasket", subcategory: "trans_pan_gasket", serviceSlug: "transmission_service", serviceRole: "kit" },
  // CVT-only filters — applicabilityRules nulls these on known non-CVT
  // transmissions; the prompt also hard-nulls them when transmission_type
  // is known non-CVT.
  cvt_internal_filter_oem: { name: "CVT Internal Filter", category: "filter", subcategory: "cvt_internal_filter", serviceSlug: "transmission_service", serviceRole: "as_needed" },
  cvt_external_filter_oem: { name: "CVT External (Cooler Line) Filter", category: "filter", subcategory: "cvt_external_filter", serviceSlug: "transmission_service", serviceRole: "as_needed" },
  // coolant_flush extras (discovery — if_found_bad)
  thermostat_oem: { name: "Thermostat", category: "cooling", subcategory: "thermostat", serviceSlug: "coolant_flush", serviceRole: "as_needed" },
  thermostat_gasket_oem: { name: "Thermostat Gasket", category: "gasket", subcategory: "thermostat_gasket", serviceSlug: "coolant_flush", serviceRole: "as_needed" },
  // brake_fluid_flush
  brake_fluid_oem: { name: "Brake Fluid", category: "fluid", subcategory: "brake_fluid", serviceSlug: "brake_fluid_flush", serviceRole: "core" },
  // power_steering_flush
  ps_fluid_oem: { name: "Power Steering Fluid", category: "fluid", subcategory: "ps_fluid", serviceSlug: "power_steering_flush", serviceRole: "core" },
  // differential_service
  gear_oil_oem: { name: "Gear Oil (GL-5 hypoid)", category: "fluid", subcategory: "gear_oil", serviceSlug: "differential_service", serviceRole: "core" },
  friction_modifier_oem: { name: "LSD Friction Modifier", category: "fluid", subcategory: "friction_modifier", serviceSlug: "differential_service", serviceRole: "as_needed" },
  // brake_pad_replacement extras (discovery; wear sensor promotes to core when has_brake_pad_sensor at resolve time)
  brake_hardware_kit_front_oem: { name: "Brake Hardware Kit (Front)", category: "brake", subcategory: "front_brake_hardware_kit", serviceSlug: "brake_pad_replacement", serviceRole: "as_needed", position: "front" },
  brake_hardware_kit_rear_oem: { name: "Brake Hardware Kit (Rear)", category: "brake", subcategory: "rear_brake_hardware_kit", serviceSlug: "brake_pad_replacement", serviceRole: "as_needed", position: "rear" },
  brake_wear_sensor_front_oem: { name: "Brake Wear Sensor (Front)", category: "brake", subcategory: "front_brake_wear_sensor", serviceSlug: "brake_pad_replacement", serviceRole: "as_needed", position: "front" },
  brake_wear_sensor_rear_oem: { name: "Brake Wear Sensor (Rear)", category: "brake", subcategory: "rear_brake_wear_sensor", serviceSlug: "brake_pad_replacement", serviceRole: "as_needed", position: "rear" },
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
  // Wear/rotation guidance (2026-07): brake pads are wear-based — the value
  // is the manufacturer's INSPECTION/typical-life guidance, not a hard
  // replacement schedule. adversarialVerification bounds both.
  brake_pads: "brake_pad_replacement",
  tire_rotation: "tire_rotation",
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
  /**
   * Write scope (additive). "full" (default) writes every section exactly as
   * before. "parts" writes ONLY sections F + F2 (the upsertPartAndFitment parts
   * writes) and skips A engine / B trans / C drivetrain / D trim / E vehicle_config
   * / E2 chassis / G intervals / H evidence — used by the director PARTS-ONLY
   * backfill. The parts sections depend only on vehicleConfigId + makeId + the
   * parsed _oem fields (all passed in), so gating the others is safe.
   */
  writeScope: "full" | "parts" = "full",
) {
  const now = Date.now();
  const partsOnly = writeScope === "parts";

  if (!partsOnly) {
  // A. Engine specs — typed coercion
  const turboVal = fields.turbo?.value;
  let aspiration: string | undefined;
  if (turboVal === true || turboVal === "Yes" || turboVal === "yes") aspiration = "turbo";
  else if (turboVal === "twin-turbo") aspiration = "twin-turbo";
  else if (turboVal === false || turboVal === "No" || turboVal === "no") aspiration = "natural";

  // Capacity fields that sanity checks / the capacity resolver REJECTED (value
  // nulled AND flagged) must be actively erased from the engine row, else the
  // old poison (e.g. coolant 16.9 qt) survives — asNumber(null) is undefined,
  // and updateEngineSpecs skips undefined to preserve genuinely-absent data.
  // A field that is merely absent (flagged === false) stays off this list.
  const ENGINE_CAPACITY_KEYS = ["oil_capacity_qts", "coolant_capacity_qts"] as const;
  const clear_fields = ENGINE_CAPACITY_KEYS.filter(
    (k) => fields[k]?.value === null && fields[k]?.flagged === true,
  );

  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEngineSpecs, {
    engine_id: engineId,
    clear_fields,
    // Only ever store a clean SAE grade. runSanityChecks already normalized the
    // common case in `fields`; re-assert here so an unparseable value (no grade)
    // becomes undefined → the mutation skips it → a previously-stored good
    // viscosity is kept rather than clobbered by garbage on re-enrich.
    oil_viscosity: normalizeOilViscosity(fields.oil_viscosity?.value) ?? undefined,
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
      // Drain-and-fill qts — the mutation always accepted this but nothing
      // passed it, leaving both ATF quantity paths (partRoleQuantity's fluid
      // role and serviceUnits' per_unit_spec count) with no enrichment feed.
      fluid_capacity_drain_fill_qts: asNumber(
        fields.transmission_fluid_capacity_qts?.value,
      ),
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
    // Capacities (drain-and-fill qts) — the mutation always accepted these but
    // the pipeline never passed them, which made differential_service
    // structurally unquotable by real fluid volume.
    diff_fluid_capacity_qts: hasDiff
      ? asNumber(fields.diff_fluid_capacity_qts?.value)
      : undefined,
    has_transfer_case: hasTC,
    tc_fluid_type: hasTC ? tcFluid : undefined,
    tc_fluid_capacity_qts: hasTC
      ? asNumber(fields.transfer_case_fluid_capacity_qts?.value)
      : undefined,
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
    // Mean confidence over the trim fields written here — describes the
    // latest enrichment (merge-semantics: a re-run overwrites it).
    confidence_score: aggregateFieldConfidence(fields, [
      "tire_pressure_front_psi", "tire_pressure_rear_psi",
      "lug_nut_torque_ft_lbs", "front_wiper_size", "rear_wiper_size",
      "battery_group", "battery_cca", "battery_type", "battery_location",
    ]),
  });

  // E. Vehicle config fields — typed coercion
  const psType = asString(fields.power_steering_type?.value);
  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
    vehicle_config_id: vehicleConfigId,
    brake_fluid_type: asString(fields.brake_fluid_type?.value),
    brake_fluid_capacity_oz: asNumber(fields.brake_fluid_capacity_oz?.value),
    has_brake_pad_sensor: MAKES_WITH_BRAKE_PAD_SENSORS.has(make),
    ps_fluid_type: psType && psType !== "electric" ? psType : undefined,
    // Electric steering has no fluid — never accrete a capacity for it.
    ps_fluid_capacity_oz:
      psType && psType !== "electric"
        ? asNumber(fields.ps_fluid_capacity_oz?.value)
        : undefined,
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
        ...(asNumber(fields.brake_fluid_capacity_oz?.value) !== undefined ? { brake_fluid_capacity_oz: asNumber(fields.brake_fluid_capacity_oz?.value) } : {}),
        ...(psType && psType !== "electric" ? { ps_fluid_type: psType } : {}),
        ...(psType && psType !== "electric" && asNumber(fields.ps_fluid_capacity_oz?.value) !== undefined ? { ps_fluid_capacity_oz: asNumber(fields.ps_fluid_capacity_oz?.value) } : {}),
        ...(steeringType ? { steering_type: steeringType } : {}),
        ...(parkingBrake ? { parking_brake_type: parkingBrake } : {}),
        // Mean confidence over the chassis fields written here (arg already
        // existed on the mutation but was never populated).
        confidence_score: aggregateFieldConfidence(fields, [
          "lug_nut_torque_ft_lbs", "front_wiper_size", "rear_wiper_size",
          "battery_group", "battery_type", "battery_location",
          "brake_fluid_type", "power_steering_type", "parking_brake_type",
        ]),
      });
      console.log(`[v8] chassis_specs written for ${chassisCfg.chassis_code}`);
    }
  } catch (e) {
    console.warn("[v8] chassis_specs write failed (non-fatal):", e);
  }
  } // end if (!partsOnly) — sections A–E2 skipped under "parts" scope

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
      service_role: meta.serviceRole,
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
          service_role: meta.serviceRole,
          confidence: pkgFields[fieldKey]?.confidence ?? 0.7,
          source_domain: extractDomain(pkgFields[fieldKey]?.source_url),
        });
      }
    }
  }

  if (partsOnly) return; // "parts" scope: F/F2 done — skip G intervals + H evidence

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

  // G2. On-demand services (inspections, diagnostics, alignment…) have no
  // mileage schedule by nature — stamp them so they read as complete instead
  // of permanently missing (they are inherently un-fillable by extraction).
  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.markOnDemandIntervals, {
    vehicle_config_id: vehicleConfigId,
    service_slugs: [...ON_DEMAND_SERVICE_SLUGS],
  });

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
    // Director per-config backfill knobs (additive — default behavior is
    // byte-identical to the signup path which passes neither). See
    // directorConfigBackfills.ts.
    //   force=true   → bypass the complete/verified cache short-circuits in
    //                  STEP 0 so the run always re-executes (the IN_PROGRESS
    //                  guard still holds, except the >4h stuck case).
    //   writeScope="parts" → write ONLY parts (sections F/F2 in
    //                  writeNormalizedData) and skip Batch-2 entirely, finalizing
    //                  the run after Batch-1. "full" (default) is unchanged.
    force: v.optional(v.boolean()),
    writeScope: v.optional(v.union(v.literal("full"), v.literal("parts"))),
    // Director re-enrich: PIN to this exact config_id instead of resolving by
    // key. Prevents proliferation — re-enriching updates the triggered config in
    // place (and reconciles its config_key) rather than spawning a duplicate.
    // Omitted on the signup path → behavior is byte-identical.
    targetConfigId: v.optional(v.id("vehicle_configs")),
  },
  handler: async (ctx, args) => {
    const startTime = Date.now();
    const scope = args.writeScope ?? "full";
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
        let bypassInProgress = runAge >= STUCK_MS;

        // Director force-unstick (Jun-9 review item 3 follow-up): a crashed
        // run (action killed at the 10-min cap, deploy restart) leaves the
        // config 'enriching' with no live poll chain — previously
        // unrecoverable for 4h even by force. A live chain stamps the run's
        // last_heartbeat_at every poll attempt (~60s); when the latest run
        // shows no activity inside the live window, force may take over. The
        // dead run is marked failed so it can never read as live again.
        // (Residual race: a final poll mid-processing with a heartbeat just
        // over the window could be superseded — bounded by the 10-min action
        // cap, director-triggered only, and upserts are idempotent.)
        if (!bypassInProgress && args.force) {
          const LIVE_WINDOW_MS = 15 * 60 * 1000; // > 10-min action cap + poll gap
          const LIVE_RUN_STATUSES = new Set(["started", "scraping", "batch1", "batch2"]);
          const latestRun = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
            { vehicleConfigId: existingConfig._id },
          );
          const lastActivity = latestRun
            ? Math.max(latestRun.started_at ?? latestRun._creationTime, latestRun.last_heartbeat_at ?? 0)
            : 0;
          const isLive =
            !!latestRun &&
            LIVE_RUN_STATUSES.has(latestRun.status) &&
            Date.now() - lastActivity < LIVE_WINDOW_MS;
          if (!isLive) {
            console.log(`[v8] Force-unstick: no live run for ${configKey} (status=${status}) — taking over`);
            if (latestRun && LIVE_RUN_STATUSES.has(latestRun.status)) {
              await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
                run_id: latestRun._id,
                status: "failed",
                errors: ["superseded_by_force_unstick"],
                completed_at: Date.now(),
              });
            }
            bypassInProgress = true;
          }
        }

        if (!bypassInProgress) {
          console.log(`[v8] Enrichment already in progress for ${configKey} (status=${status}), skipping`);
          await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
            { vehicle_id: args.vehicleId, vehicle_config_id: existingConfig._id },
          );
          return { status: "already_enriching" as const, configId: existingConfig._id };
        }
        console.log(`[v8] Stale/dead in-progress run for ${configKey} (${Math.round(runAge / 60000)}min old), re-enriching`);
      }

      // Complete/verified — use cache unless stale.
      // force=true (director backfill) bypasses BOTH cache short-circuits so the
      // run always re-executes. The IN_PROGRESS guard above still holds.
      if ((status === "complete" || status === "verified") && !args.force) {
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

    // STEP 3a: Ensure a REAL transmission record is linked for ICE vehicles.
    //
    // upsertTransmission keys by (trim_id, type), so requesting "unknown" never
    // matches a prior "automatic" row — it inserts a SECOND row and relinks the
    // vehicle to it, orphaning the good value. That's how a re-enrich regressed
    // the 2024 Alfa Stelvio from "Automatic" (conf 0.7) to "unknown" (conf 0.1),
    // Jul 2026. So we (a) never create an "unknown" placeholder when a real row
    // already exists for the trim, and (b) actively HEAL a link that already
    // points at an "unknown"/placeholder row when a better real row exists — so
    // a re-enrich REPAIRS previously-poisoned configs instead of pinning them.
    let transmissionId = vehicleDoc.transmission_id ?? null;
    const trimId = vehicleDoc.trim_id;
    if (trimId) {
      const isReal = (t: string | undefined | null): t is string =>
        !!t && t.trim().toLowerCase() !== "unknown";
      const trimTransmissions = await ctx.runQuery(
        api.transmissions.listByTrimId,
        { trim_id: trimId },
      );
      const linked = transmissionId
        ? (trimTransmissions ?? []).find(
            (t: any) => String(t._id) === String(transmissionId),
          )
        : null;
      const bestExisting = (trimTransmissions ?? [])
        .filter((t: any) => isReal(t.transmission_type))
        .sort(
          (a: any, b: any) =>
            (b.confidence_score ?? 0) - (a.confidence_score ?? 0),
        )[0];
      const linkIsMissingOrPlaceholder =
        !transmissionId || !linked || !isReal((linked as any).transmission_type);

      if (linkIsMissingOrPlaceholder && bestExisting?._id) {
        // Link (or heal) to the best real row; abandon the placeholder link.
        transmissionId = bestExisting._id;
        await ctx.runMutation(api.vehicles.upsertVehicle, {
          vin: vehicleDoc.vin,
          transmission_id: transmissionId,
        });
        console.log(
          `[v8] Linked transmission ${transmissionId} (${bestExisting.transmission_type}) for trim — skipped/healed "unknown" placeholder`,
        );
      } else if (!transmissionId && !bestExisting?._id) {
        // No link AND no real row anywhere — only now create the placeholder.
        console.log("[v8] No transmission for trim — creating placeholder");
        const transDoc = await ctx.runMutation(api.transmissions.upsertTransmission, {
          trim_id: trimId,
          transmission_type: "unknown",
          confidence_score: 0.1,
        });
        if (transDoc?._id) {
          transmissionId = transDoc._id;
          await ctx.runMutation(api.vehicles.upsertVehicle, {
            vin: vehicleDoc.vin,
            transmission_id: transmissionId,
          });
          console.log(`[v8] Placeholder transmission created: ${transmissionId}`);
        }
      }
      // else: link already points at a real row — leave it untouched.
    }

    // STEP 3b: Fuzzy dedup — if a config with the same engine+year+make exists
    // under a slightly different key, reuse it instead of creating a duplicate.
    // SKIPPED when pinning (targetConfigId): the dedup keys on the vehicle's
    // engine, which can be a placeholder that mismatches the pinned config's real
    // engine and would redirect the key away from the config we mean to update.
    if (!args.targetConfigId) {
      const possibleDupe = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.findSimilarConfig,
        { engine_id: vehicleDoc.engine_id, year: args.year, make_id: makeDoc._id },
      );
      if (possibleDupe && possibleDupe.config_key !== configKey) {
        console.log(`[v8] Dedup: using existing key "${possibleDupe.config_key}" instead of "${configKey}"`);
        configKey = possibleDupe.config_key;
      }
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
    let vehicleConfigId;
    if (args.targetConfigId) {
      // PIN: update the triggered config in place. Reconcile its config_key to
      // match its real engine (fixing any prior key↔engine desync) but KEEP its
      // existing engine_id (don't overwrite with the vehicle's placeholder).
      await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.reconcileConfigForReenrich,
        {
          config_id: args.targetConfigId,
          config_key: configKey,
          drivetrain: drivetrainVal,
          nhtsa_vin_key: args.nhtsaVinKey,
          transmission_id: transmissionId ?? undefined,
        },
      );
      vehicleConfigId = args.targetConfigId;
      console.log(`[v8] PIN: enriching config ${args.targetConfigId} in place (key → ${configKey})`);
    } else {
      vehicleConfigId = await ctx.runMutation(
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
    }

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

    // STEP 7b: Record deterministic supersession chains parsed from the same
    // registry HTML (marks known-superseded oem_parts rows so fitment writes
    // redirect to the successor and superseded numbers stop being priced).
    if (sources.supersessions.length > 0) {
      try {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recordSupersessions, {
          supersessions: sources.supersessions,
        });
      } catch (e) {
        console.warn("[v8] recordSupersessions failed (non-fatal):", e);
      }
    }

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
      // No batch-1 data was written this run → restore 'pending' (review item 3).
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
        run_id: runId,
        vehicle_config_id: vehicleConfigId,
        run_status: "failed",
        errors: [`batch1_submission_failed: ${e}`],
        config_status: "pending",
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
        writeScope: scope,
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
    // Director backfill scope (additive). "parts" → write only F/F2 parts and
    // finalize after Batch-1 (no Batch-2). Defaults to "full".
    writeScope: v.optional(v.union(v.literal("full"), v.literal("parts"))),
  },
  handler: async (ctx, args) => {
    // Catch-all failure handler (Jun-9 review item 3): ANY unexpected throw in
    // the poll body must restore the config to a terminal status — 'pending'
    // before batch-1 data hit the normalized tables, 'partial' after — or the
    // config is stuck 'enriching' forever (only the run row got marked).
    const progress = { batch1DataWritten: false };
    try {
      return await runPollBatch1Body(ctx, args, progress);
    } catch (e) {
      console.error(`[v8/_pollBatch1] UNEXPECTED failure — restoring terminal status:`, e);
      try {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
          run_id: args.runId,
          vehicle_config_id: args.vehicleConfigId,
          run_status: "failed",
          errors: [`batch1_unexpected: ${e}`],
          config_status: progress.batch1DataWritten ? "partial" : "pending",
        });
      } catch (e2) {
        console.error(`[v8/_pollBatch1] failEnrichmentRun also failed:`, e2);
      }
    }
  },
});

// Body of _pollBatch1V3, extracted so the handler can wrap it in a catch-all
// failure handler. progress.batch1DataWritten flips once writeNormalizedData
// lands, switching the restore status from 'pending' to 'partial'.
async function runPollBatch1Body(
  ctx: any,
  args: any,
  progress: { batch1DataWritten: boolean },
): Promise<void> {
    const attempt = args.attempt ?? 1;
    const writeScope = args.writeScope ?? "full";
    console.log(`[v8/_pollBatch1] Poll attempt ${attempt} for batchId=${args.batchId}`);

    // Liveness heartbeat for the STEP 0 force-unstick probe — stamped every
    // attempt so a crashed chain goes visibly stale within minutes.
    try {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: args.runId,
        last_heartbeat_at: Date.now(),
      });
    } catch (e) {
      console.warn(`[v8/_pollBatch1] heartbeat stamp failed (non-fatal):`, e);
    }

    // A transient API error on a status poll must not kill a paid batch run —
    // treat it as "not ended" and let the bounded retry loop continue.
    let status: string | null = null;
    try {
      status = await getBatchStatus(args.batchId);
    } catch (e) {
      console.warn(`[v8/_pollBatch1] getBatchStatus failed (attempt ${attempt}) — treating as not-ended:`, e);
    }
    if (status !== "ended") {
      if (attempt >= MAX_POLL_ATTEMPTS) {
        console.error(`[v8/_pollBatch1] Timed out after ${attempt} attempts`);
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
          run_id: args.runId,
          vehicle_config_id: args.vehicleConfigId,
          run_status: "failed",
          errors: ["batch1_timeout"],
          config_status: "pending",
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
          // VDB labor is verified-bad (too generic per car) — kept at near-zero
          // weight as a last-resort tiebreaker only. The weighted median now
          // honors weights (labor_aggregation.ts), so OLP/LLM dominate.
          // book_only skips the empirical job_actuals scan.
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
            vehicle_config_id: args.vehicleConfigId,
            service_id: svc._id,
            hours,
            source: "vdb_repair_estimates",
            weight: 0.05,
            tier: "catalog",
          });
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime, {
            vehicle_config_id: args.vehicleConfigId,
            service_id: svc._id,
            book_only: true,
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
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
        run_id: args.runId,
        vehicle_config_id: args.vehicleConfigId,
        run_status: "failed",
        errors: ["no_batch1a_result"],
        config_status: "pending",
      });
      return;
    }

    // Fix #3: Detect errored/expired batch requests
    if (r1a.error) {
      console.error(`[v8/_pollBatch1] batch1a ${r1a.error} — aborting`);
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
        run_id: args.runId,
        vehicle_config_id: args.vehicleConfigId,
        run_status: "failed",
        errors: [`batch1a_${r1a.error}`],
        config_status: "pending",
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

    // Human-verified engine fields override the fresh extraction BEFORE the
    // applicability rules run — the chain rule keys off fields.timing_system,
    // so a director-corrected belt car must not re-null its belt parts just
    // because the LLM repeated its misclassification (Jetta, Jun 10 2026).
    // Curated family facts run first (protects FUTURE engine rows of a known
    // family); a per-row human stamp still wins over both.
    applyKnownEngineFacts(fields, args.engineCode);
    try {
      const engineForVerified = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getEngine,
        { engineId: args.engineId },
      );
      applyVerifiedEngineFields(fields, engineForVerified as any);
    } catch (e) {
      console.warn("[v8/_pollBatch1] verified-field override failed (non-fatal):", e);
    }

    // Apply applicability rules
    const vPicData = args.vPicData as VehicleIdentity | null;
    fields = applyApplicabilityRules(fields, vPicData);

    const filledCount = V4_FIELD_KEYS.filter((k) => fields[k]?.value != null).length;
    console.log(`[v8/_pollBatch1] ${filledCount}/${V4_FIELD_KEYS.length} fields after merge+applicability`);

    // Sanity checks BEFORE the first write. Previously only the batch-2
    // finalize ran these, but this write already persists batch-1 values and
    // the merge-semantics mutations skip undefined — so a value rejected at
    // finalize (nulled) could never un-write what batch-1 stored (the 16.9 qt
    // coolant survival vector). Rejecting here also puts the field back in the
    // batch-2 gap-fill set, giving the pipeline a second chance at a clean
    // value. Finalize re-runs the checks over the merged map as before.
    const batch1SanityFlags = runSanityChecks(fields, vPicData?.cylinders ?? 4);
    if (batch1SanityFlags.length > 0) {
      console.log(
        `[v8/_pollBatch1] Sanity: ${batch1SanityFlags.length} flags applied before batch-1 write (${batch1SanityFlags.map((f) => f.field).join(", ")})`,
      );
    }

    // Write to normalized tables
    const serviceCache = new Map<string, Id<"services">>();
    await writeNormalizedData(
      ctx, fields,
      args.vehicleConfigId, args.engineId, args.transmissionId,
      args.makeId, args.runId, args.make, serviceCache,
      args.wheelSizeOptions,
      args.wheelSizeSource,
      packageParts,
      writeScope,
    );
    // Batch-1 data is now in the normalized tables — a failure from here on
    // restores 'partial', not 'pending' (see the catch-all in the handler).
    progress.batch1DataWritten = true;

    // PARTS-ONLY backfill: stop after the Batch-1 parts write. Do NOT submit
    // Batch-2 (gap fill / pricing). Finalize the run the same terminal way
    // _pollBatch2V3 does — mark the enrichment_run complete, recompute the
    // normalized fill rate, and restore a terminal enrichment_status +
    // last_enriched_at on the config — then return.
    //
    // STEP 4 of enrichVehicleBatchV3 clobbers the existing config to
    // status="enriching" / fill_rate=0 on EVERY run (including this force/parts
    // one), so we MUST restore a terminal status here or a previously-complete
    // config would be left stuck "enriching". We recompute fill_rate and apply
    // the SAME >=70 → "complete" / else "partial" rule the full path uses in
    // _pollBatch2V3, so the config lands in a correct terminal state. No Batch-2,
    // sibling backfill, notifications, or adversarial verification — this is a
    // targeted parts refresh, not a full enrichment.
    if (writeScope === "parts") {
      const partsCallLog: CallLogEntry[] = callLog;
      let partsFillRate = 0;
      try {
        const { rate } = await calculateV3FillRate(
          ctx, args.vehicleConfigId, args.engineId, args.transmissionId,
        );
        partsFillRate = rate;
      } catch (e) {
        console.warn("[v8/_pollBatch1] parts-scope fill rate recompute failed (non-fatal):", e);
      }
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: args.runId,
        status: "complete",
        total_tokens_in: partsCallLog.reduce((s, c) => s + c.tokensIn, 0),
        total_tokens_out: partsCallLog.reduce((s, c) => s + c.tokensOut, 0),
        total_web_searches: partsCallLog.reduce((s, c) => s + c.webSearches, 0),
        completed_at: Date.now(),
        duration_ms: Date.now() - args.startTime,
        fill_rate: partsFillRate,
      });
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
        vehicle_config_id: args.vehicleConfigId,
        enrichment_status: partsFillRate >= 70 ? "complete" : "partial",
        fill_rate: partsFillRate,
        last_enriched_at: Date.now(),
      });
      console.log(
        `[v8/_pollBatch1] PARTS-ONLY backfill complete for config ${args.vehicleConfigId} ` +
        `— fill_rate=${partsFillRate}%, Batch-2 skipped`,
      );
      return;
    }

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

    // Give gap-fill more searches when numeric specs (capacities, CCA, gap) are
    // missing — with the old flat maxSearchUses:1 a single part-number lookup
    // consumed the whole budget and specs never got searched. Capped to bound cost.
    const numericSpecGaps = nullFields.filter((k) =>
      ["coolant_capacity_qts", "oil_capacity_qts", "battery_cca", "spark_plug_gap"].includes(k),
    ).length;
    const batch2SearchUses = Math.min(1 + numericSpecGaps, 5);

    let batch2Id: string;
    try {
      batch2Id = await submitBatch([
        {
          customId: "batch2",
          system: BATCH_2_SYSTEM,
          userPrompt: buildBatch2Prompt(vehicle, nullFields, oemParts),
          maxTokens: 16384,
          temperature: 0,
          maxSearchUses: batch2SearchUses,
          blockedDomains: BLOCKED_DOMAINS,
        },
      ]);
    } catch (e) {
      console.error(`[v8] Batch 2 submission FAILED:`, e);
      // Batch-1 data IS written by this point → 'partial' (review item 3).
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
        run_id: args.runId,
        vehicle_config_id: args.vehicleConfigId,
        run_status: "failed",
        errors: [`batch2_submission_failed: ${e}`],
        config_status: "partial",
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
}

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
    // Catch-all failure handler (Jun-9 review item 3): batch-1 data is always
    // written by the time this action runs, so any unexpected throw restores
    // the config to 'partial' instead of leaving it stuck 'enriching'.
    try {
      return await runPollBatch2Body(ctx, args);
    } catch (e) {
      console.error(`[v8/_pollBatch2] UNEXPECTED failure — restoring terminal status:`, e);
      try {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
          run_id: args.runId,
          vehicle_config_id: args.vehicleConfigId,
          run_status: "failed",
          errors: [`batch2_unexpected: ${e}`],
          config_status: "partial",
        });
      } catch (e2) {
        console.error(`[v8/_pollBatch2] failEnrichmentRun also failed:`, e2);
      }
    }
  },
});

// Body of _pollBatch2V3, extracted so the handler can wrap it in a catch-all
// failure handler.
async function runPollBatch2Body(ctx: any, args: any): Promise<void> {
    const attempt = args.attempt ?? 1;
    console.log(`[v8/_pollBatch2] Poll attempt ${attempt} for batchId=${args.batchId}`);

    // Liveness heartbeat for the STEP 0 force-unstick probe.
    try {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: args.runId,
        last_heartbeat_at: Date.now(),
      });
    } catch (e) {
      console.warn(`[v8/_pollBatch2] heartbeat stamp failed (non-fatal):`, e);
    }

    // A transient API error on a status poll must not kill a paid batch run —
    // treat it as "not ended" and let the bounded retry loop continue.
    let status: string | null = null;
    try {
      status = await getBatchStatus(args.batchId);
    } catch (e) {
      console.warn(`[v8/_pollBatch2] getBatchStatus failed (attempt ${attempt}) — treating as not-ended:`, e);
    }
    // Review item 6: on timeout the batch has NOT ended — reading its results
    // would throw (stuck config) or mis-mark the run 'complete'. Skip the
    // results entirely, finalize with batch-1 data only (r2 undefined), and
    // record the run as 'timeout'.
    let timedOut = false;
    if (status !== "ended") {
      if (attempt >= MAX_POLL_ATTEMPTS) {
        console.error("[v8/_pollBatch2] Timed out — finalizing with batch-1 data only");
        timedOut = true;
      } else {
        await ctx.scheduler.runAfter(
          POLL_INTERVAL_MS,
          internal.vehicleEnrichment.v3pipeline._pollBatch2V3,
          { ...args, attempt: attempt + 1 },
        );
        return;
      }
    }

    const results = timedOut ? {} : await getBatchResults(args.batchId);
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

      // Batch 3 (gap-fill re-ask): ONE bounded targeted pass over fields
      // STILL null after Batch 2 (getNullFields excludes not_applicable —
      // re-asking N/A fields resurrected impossible data, see comment above
      // getNullFields). One synchronous web-search call, capped field count,
      // values flow through the same parseBatch2 → sanity → sanitize gates as
      // Batch-2 gap fills. No loop — a field that survives this stays in the
      // run's field_gaps ledger instead.
      if (process.env.PARTS_GAPFILL !== "off") {
        const gapFillMax = Number(process.env.PARTS_GAPFILL_MAX_FIELDS ?? "15");
        const stillNull = getNullFields(allFields).slice(0, gapFillMax);
        if (stillNull.length > 0) {
          try {
            const gfVehicle: VehicleInput = {
              vehicleId: args.vehicleId,
              year: args.year, make: args.make, model: args.model,
              trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
            };
            const gfRes = await callClaudeWithWebSearch({
              system: GAP_FILL_SYSTEM,
              userPrompt: buildGapFillPrompt(gfVehicle, stillNull),
              maxSearchUses: Math.min(stillNull.length * 2, 12),
              maxTokens: 4000,
              temperature: 0,
            });
            callLog.push({
              call: "gapfill",
              tokensIn: gfRes.usage.tokensIn,
              tokensOut: gfRes.usage.tokensOut,
              webSearches: gfRes.usage.webSearches,
              durationMs: 0,
            });
            const gfParsed = parseBatch2(gfRes.data, stillNull);
            let gfFilled = 0;
            for (const [k, fv] of Object.entries(gfParsed.gapFields)) {
              if (allFields[k]?.value == null) {
                allFields[k] = fv;
                gfFilled++;
              }
            }
            console.log(`[v8/gapfill] re-asked ${stillNull.length} fields, filled ${gfFilled}`);
          } catch (e) {
            console.warn("[v8/gapfill] re-ask pass failed (non-fatal):", e);
          }
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

    // Authoritative capacity resolution — actively re-fetch coolant/oil capacity
    // from OEM/service-manual sources when sanity checks nulled a bad value (e.g.
    // the 16.9 qt forum coolant) or the batches found none. Mutates allFields in
    // place; writeNormalizedData below persists accepted values and erases
    // still-unresolved ones. Non-fatal — a failure never breaks enrichment.
    if (process.env.SPECS_AUTHORITATIVE_REFETCH !== "off") {
      try {
        const engineRow = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getEngine,
          { engineId: args.engineId },
        );
        const decisions = await resolveCapacities(ctx, {
          vehicle, engineId: args.engineId, cylinders, fields: allFields,
          runId: args.runId, verifiedFields: ((engineRow as any)?.verified_fields ?? []) as string[],
        });
        if (decisions.length > 0) {
          console.log(
            `[v8/cap] ${decisions.map((d) => `${d.field}=${d.value_qts ?? "review"}(${d.source_count}src${d.authoritative ? ",auth" : ""},${d.tier})`).join(" ")}`,
          );
        }
      } catch (e) {
        console.warn("[v8/cap] capacity resolver failed (non-fatal):", e);
      }
    }

    // Write sanitized data to normalized tables
    if (r2) {
      const serviceCache = new Map<string, Id<"services">>();
      await writeNormalizedData(
        ctx, allFields,
        args.vehicleConfigId, args.engineId, args.transmissionId,
        args.makeId, args.runId, args.make, serviceCache,
      );

      // Deterministic per-SKU prices parsed from the registry HTML (JSON-LD) at
      // scrape time, carried on the parts_catalog cache row. These are the
      // authoritative price source; the LLM breakdown below only fills parts
      // these did not cover, and may never overwrite a deterministically-priced
      // part (tracked in `deterministicallyPriced`).
      const deterministicPrices = new Map<
        string,
        { price: number; source_domain: string; source_url: string }
      >();
      const deterministicallyPriced = new Set<Id<"oem_parts">>();
      try {
        const cachedParts = await ctx.runQuery(
          internal.vehicleEnrichment.scraperQueries.getCachedScrape,
          {
            vehicleMake: args.make,
            vehicleModel: args.model,
            vehicleYear: args.year,
            vehicleTrim: args.trim ?? "",
            sourceType: "parts_catalog",
          },
        );
        if (cachedParts?.part_prices_json) {
          const arr = JSON.parse(cachedParts.part_prices_json) as Array<{
            oem_part_number: string;
            price: number;
            source_domain: string;
            source_url: string;
          }>;
          for (const p of arr) {
            if (p?.oem_part_number && typeof p.price === "number" && p.price > 0) {
              deterministicPrices.set(normalizeOemNumber(p.oem_part_number), {
                price: p.price,
                source_domain: p.source_domain,
                source_url: p.source_url,
              });
            }
          }
        }
      } catch (e) {
        console.warn("[v8] deterministic price load failed (non-fatal):", e);
      }
      if (deterministicPrices.size > 0) {
        console.log(`[v8] ${deterministicPrices.size} deterministic JSON-LD prices for ${args.make} ${args.model}`);
      }

      // Fallback price-URL discovery for parts Batch-2 left without a source
      // URL (the prompt tells the model to OMIT unpriced parts, so omission is
      // routine — without this, those parts get zero fetch attempts). One
      // Firecrawl search per part, capped per run to bound credit spend.
      const priceDiscoveryEnabled = process.env.PARTS_PRICE_URL_DISCOVERY !== "off";
      const priceDiscoveryMax = Number(process.env.PARTS_PRICE_DISCOVERY_MAX ?? "10");
      let priceDiscoveryUsed = 0;

      // ── Multi-source labor (ONCE per car). The `laborAllSources` orchestrator
      //    fans out to OLP + RepairPal + open-web (each flag-gated), merges the
      //    per-source hours into weighted `labor_observations`, and recomputes the
      //    weighted-median labor_times row — all internally. It REPLACES the old
      //    OLP-only resolution + write loop. The LLM book-time loop below (llm_web
      //    / llm_training) is a SEPARATE source the orchestrator does NOT handle,
      //    so it stays. Flags: OLP on-by-default; RepairPal/web opt-in (read from
      //    env in ONE place via laborFlagsFromEnv so this path and the laborRelabor
      //    backfill can never drift).
      const laborFlags = laborFlagsFromEnv();

      // Engine descriptors fetched ONCE for the orchestrator inputs (named
      // distinctly from the LLM loop's per-service `engineDoc` to avoid clashing).
      const laborEngineDoc: any = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getEngine,
        { engineId: args.engineId },
      );
      const laborEngineFamily =
        laborEngineDoc?.engine_family ??
        deriveEngineFamily(laborEngineDoc?.engine_code) ??
        deriveEngineFamily(args.engineCode);
      const laborRawDisp = laborEngineDoc?.displacement_l ?? laborEngineDoc?.displacement_liters ?? null;
      const laborDisplacementL = laborRawDisp == null ? null : Number(laborRawDisp) || null;
      const laborCylinders = laborEngineDoc?.cylinders ?? null;
      const laborTurbo =
        laborEngineDoc?.aspiration != null ? /turbo|supercharg/i.test(laborEngineDoc.aspiration) : null;
      const laborVc: any = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleConfigById,
        { vehicleConfigId: args.vehicleConfigId },
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

        // LLM book-time estimate → one CATALOG observation. web_search only if
        // there's a real, non-blocked source URL (rare for labor — it's usually
        // training knowledge). Engine-family is stamped so siblings converge.
        const laborSourceUrl = svc.labor_hours?.source_url;
        const isWebSource = laborSourceUrl && !isBlockedDomain(laborSourceUrl);

        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
          vehicle_config_id: args.vehicleConfigId,
          service_id: serviceId,
          hours: laborVal,
          source: isWebSource ? "llm_web" : "llm_training",
          weight: isWebSource ? 0.5 : 0.3,
          tier: "catalog",
          engine_family: engineDoc?.engine_family,
        });
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime, {
          vehicle_config_id: args.vehicleConfigId,
          service_id: serviceId,
          book_only: true,
        });
      }

      // Multi-source labor — written independently of the LLM loop so that every
      // APPLICABLE MAPPED service gets resolved (OLP + RepairPal + web) regardless
      // of whether the LLM provided labor_hours (Phase-2 parity with the backfill
      // in laborRelabor.ts). The orchestrator does the observation writes + recompute
      // internally; olp_labor lands at weight 0.7 here (the multi-source SOURCE_WEIGHTS
      // recalibration), NOT the single-source 0.8 of olpRelabor.ts. Replaces the old
      // OLP-only resolution + write loop.
      const laborServices: Array<{
        slug: string;
        serviceId: Id<"services">;
        name: string;
        repairpal_slug: string | null;
      }> = [];
      // resolveServiceId is serviceCache-memoized, so re-iterating `services` here
      // (after the LLM book-time loop above already resolved these slugs) reads from
      // the cache and does NOT double-query the DB.
      for (const svc of services) {
        if (!svc.is_applicable) continue;
        const slug = SERVICE_NAME_TO_SLUG[svc.service_name];
        if (!slug) continue;
        const serviceId = await resolveServiceId(ctx, slug, serviceCache);
        if (!serviceId) continue;
        laborServices.push({
          slug,
          serviceId,
          name: svc.service_name,
          repairpal_slug: LABOR_SERVICE_CONFIG[slug]?.repairpal_slug ?? null,
        });
      }

      // Resolve the OLP Next.js buildId only when OLP is enabled (it's the one
      // shared input across all OLP service pages); undefined if OLP off/unresolved.
      let laborBuildId: string | undefined = undefined;
      if (laborFlags.olp) {
        const bid = await ctx.runAction(internal.vehicleEnrichment.olpLaborScrape.resolveBuildId, {});
        laborBuildId = bid.buildId ?? undefined;
      }

      console.log(
        `[v8/labor] laborAllSources for ${args.make} ${args.model} ${args.trim ?? ""}: ` +
        `flags={olp:${laborFlags.olp},web:${laborFlags.web}}, ` +
        `${laborServices.length} services, buildId=${laborBuildId ? "resolved" : "none"}`,
      );

      // Wrapped in try/catch so a total orchestrator failure NEVER aborts the
      // downstream part-price writes (graceful degradation, like the old OLP block).
      try {
        await ctx.runAction(internal.vehicleEnrichment.laborResearch.laborAllSources, {
          vehicleConfigId: args.vehicleConfigId,
          make: args.make,
          model: args.model,
          trim: args.trim ?? "",
          year: args.year,
          engine: laborEngineDoc?.engine_code ?? null,
          engine_family: laborEngineFamily,
          displacementL: laborDisplacementL,
          cylinders: laborCylinders,
          drivetrain: laborVc?.drivetrain ?? null,
          turbo: laborTurbo,
          buildId: laborBuildId,
          services: laborServices,
          flags: laborFlags,
        });
      } catch (e) {
        console.warn("[v3pipeline] laborAllSources failed (non-fatal):", e);
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

        if (process.env.PARTS_FIRECRAWL_PRICING === "off") {
          // ===== LEGACY PATH (flag-off fallback) =====

          // Authoritative: deterministic JSON-LD prices. Write the real per-SKU
          // price for any fitment whose OEM number was parsed from the registry
          // HTML, and mark it so the LLM breakdown below can't overwrite it.
          for (const f of fitments) {
            const num = (f as any).oem_part_number as string | null;
            if (!num) continue;
            const dp = deterministicPrices.get(normalizeOemNumber(num));
            if (!dp) continue;
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id:       f.part_id,
              price:         dp.price,
              price_type:    "sale",
              source_url:    dp.source_url,
              source_domain: dp.source_domain,
            });
            deterministicallyPriced.add(f.part_id);
          }

          // Preferred: itemized parts_breakdown — write each part's own price.
          if (svc.parts_breakdown && svc.parts_breakdown.length > 0) {
            // Build a quick oem_number → part_id lookup. Same OEM may have
            // multiple fitments under one service (base + package variant) —
            // every match gets the same per-unit price. Keys are NORMALIZED
            // (mirrors the deterministic path above): the LLM frequently
            // reformats numbers ("5Q0 698 451 A" vs stored "5Q0698451A"), and a
            // raw-string match silently dropped those prices (Jun-9 review).
            const numberToPartIds = new Map<string, Id<"oem_parts">[]>();
            for (const f of fitments) {
              const num = (f as any).oem_part_number;
              if (!num) continue;
              const key = normalizeOemNumber(num);
              const arr = numberToPartIds.get(key) ?? [];
              arr.push(f.part_id);
              numberToPartIds.set(key, arr);
            }

            for (const entry of svc.parts_breakdown) {
              if (entry.price_low == null) continue;
              if (!entry.oem_part_number) continue;
              const partIds = numberToPartIds.get(normalizeOemNumber(entry.oem_part_number));
              if (!partIds || partIds.length === 0) continue;
              const sourceDomain = entry.source_domain ?? extractDomain(entry.source_url ?? undefined) ?? "enrichment";

              // FIX AT SOURCE: verify the web-search LLM's price against its own
              // cited page via the shared two-tier re-extraction (Tier 1 structured
              // → Tier 2 LLM that excludes MSRP/"was"/"You Save"). When it confirms
              // a real price we store the verified "sale" value instead of the raw
              // estimate, so a fresh enrichment never persists a discount/MSRP
              // figure. Flag-gated because it adds a fetch per itemized part; falls
              // back to the unverified llm_estimate when off, unreachable, or
              // neither tier can trust the page.
              let verified: number | null = null;
              // Affirmative rejection = the cited page itself testified AGAINST
              // this number (price>=MSRP / wrong OEM / outside the median band).
              // Persisting it as trusted 'llm_estimate' would feed a known-bad
              // value into the customer median (Jun-9 review, item 8) — write it
              // as UNVERIFIED instead (kept for audit, excluded from the median).
              // Passive failures (empty page, no text, LLM error) keep the old
              // fail-open llm_estimate behavior: we learned nothing new.
              let affirmativeReject = false;
              if (process.env.PARTS_REEXTRACT_BATCH2 === "on" && entry.source_url) {
                try {
                  const outcome = await reextractPartPrice({
                    oem: entry.oem_part_number,
                    partName: (entry as any).part_name ?? null,
                    source_url: entry.source_url,
                    crossSourceMedian: null,
                  });
                  if (outcome.status === "sale") {
                    verified = outcome.price;
                  } else if (
                    outcome.status === "unverified" &&
                    isAffirmativeRejection(outcome.reason)
                  ) {
                    affirmativeReject = true;
                    console.warn(
                      `[v8] Batch-2 price affirmatively rejected (${outcome.reason}) for ` +
                        `${entry.oem_part_number} @ ${sourceDomain} — storing as unverified`,
                    );
                  }
                } catch (e) {
                  console.warn("[v8] Batch-2 Tier-2 reextract failed (non-fatal):", e);
                }
              }

              for (const partId of partIds) {
                // Deterministic JSON-LD price already owns this part — the LLM
                // estimate must not overwrite it or pollute the median.
                if (deterministicallyPriced.has(partId)) continue;
                await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
                  part_id:       partId,
                  price:         verified ?? entry.price_low,
                  price_type:
                    verified != null
                      ? "sale"
                      : affirmativeReject
                        ? UNVERIFIED_PRICE_TYPE
                        : "llm_estimate",
                  source_url:    entry.source_url ?? undefined,
                  source_domain: sourceDomain,
                });
                if (verified != null) deterministicallyPriced.add(partId);
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
            // Skip parts the deterministic JSON-LD parser already priced.
            if (deterministicallyPriced.has(fitment.part_id)) continue;
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id:       fitment.part_id,
              price:         priceVal,
              price_type:    "llm_estimate",
              source_domain: extractDomain(svc.parts_cost_low?.source_url) ?? "enrichment",
              source_url:    svc.parts_cost_low?.source_url ?? undefined,
            });
          }
        } else {
          // ===== Firecrawl structured pricing (default) =====
          // Price each fitment across the UNION of its discovered source URLs
          // (deterministic JSON-LD source + parts_breakdown entries). Every price
          // is re-verified via Firecrawl json + gauge/guided-retry; only validated
          // "sale" rows are written (msrp/discount included). Parts with no
          // discovered product URL get no price here (better than an llm guess).
          const urlsByPart = new Map<string, { urls: string[]; oem: string | null; name: string | null; subcategory: string | null }>();
          const addUrl = (partId: any, url: string | undefined | null, oem: string | null, name: string | null, subcategory: string | null = null) => {
            if (!url) return;
            const k = String(partId);
            const e = urlsByPart.get(k) ?? { urls: [], oem, name, subcategory };
            if (!e.urls.includes(url)) e.urls.push(url);
            if (!e.oem && oem) e.oem = oem;
            if (!e.name && name) e.name = name;
            if (!e.subcategory && subcategory) e.subcategory = subcategory;
            urlsByPart.set(k, e);
          };
          const subcatByPartId = new Map<string, string | null>();
          for (const f of fitments) {
            subcatByPartId.set(String(f.part_id), ((f as any).part_subcategory as string | null) ?? null);
          }
          // Seed EVERY fitment part into the map (empty urls) so a part the
          // LLM omitted from parts_breakdown still reaches the discovery
          // fallback below — addUrl alone only enters parts that have a URL.
          for (const f of fitments) {
            const k = String(f.part_id);
            if (!urlsByPart.has(k)) {
              urlsByPart.set(k, {
                urls: [],
                oem: ((f as any).oem_part_number as string | null) ?? null,
                name: ((f as any).part_name as string | null) ?? null,
                subcategory: ((f as any).part_subcategory as string | null) ?? null,
              });
            }
          }
          for (const f of fitments) {
            const num = (f as any).oem_part_number as string | null;
            const dp = num ? deterministicPrices.get(normalizeOemNumber(num)) : null;
            if (dp?.source_url) addUrl(f.part_id, dp.source_url, num ?? null, (f as any).part_name ?? null, (f as any).part_subcategory ?? null);
          }
          if (svc.parts_breakdown && svc.parts_breakdown.length > 0) {
            const numToPartIds = new Map<string, any[]>();
            for (const f of fitments) {
              const num = (f as any).oem_part_number;
              if (!num) continue;
              const key = normalizeOemNumber(num);
              const arr = numToPartIds.get(key) ?? [];
              arr.push(f.part_id);
              numToPartIds.set(key, arr);
            }
            for (const entry of svc.parts_breakdown) {
              if (!entry.oem_part_number || !entry.source_url) continue;
              for (const pid of numToPartIds.get(normalizeOemNumber(entry.oem_part_number)) ?? []) {
                addUrl(pid, entry.source_url, entry.oem_part_number, (entry as any).part_name ?? null, subcatByPartId.get(String(pid)) ?? null);
              }
            }
          }
          for (const [partIdStr, e] of urlsByPart) {
            let urlsDiscovered = false;
            if (e.urls.length === 0) {
              // Discovery fallback: search for a product page instead of
              // giving up. Skipped for parts the JSON-LD path already priced,
              // parts with no OEM anchor, or once the per-run cap is hit.
              if (
                !priceDiscoveryEnabled ||
                !e.oem ||
                deterministicallyPriced.has(partIdStr as any) ||
                priceDiscoveryUsed >= priceDiscoveryMax
              ) {
                continue;
              }
              priceDiscoveryUsed++;
              e.urls = await discoverPriceUrls({ oem: e.oem, make: args.make, name: e.name });
              urlsDiscovered = true;
              if (e.urls.length === 0) {
                console.warn(`[v8/price] discovery found no usable source for part ${partIdStr} (oem=${e.oem})`);
                continue;
              }
            }
            const rows = await priceAllSources(
              e.urls,
              { oem: e.oem, partName: e.name, subcategory: e.subcategory, requireOemEcho: urlsDiscovered },
              extractPriceFirecrawl,
            );
            for (const row of rows) {
              if (row.outcome.status !== "sale") continue;
              await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
                part_id: partIdStr as any,
                price: row.outcome.price,
                price_type: "sale",
                source_domain: row.source_domain,
                source_url: row.source_url,
                msrp: row.outcome.msrp ?? undefined,
                discount: row.outcome.discount ?? undefined,
              });
            }
            // Observability: a part where NO source yielded a trusted price gets
            // no row (better than an llm guess) — but log it so a degraded run
            // (anti-bot blocks / Firecrawl outage) is diagnosable, not silent.
            if (!rows.some((r) => r.outcome.status === "sale")) {
              console.warn(
                `[v8/price] no trusted price for part ${partIdStr} (oem=${e.oem ?? "?"}) from ${e.urls.length} source(s): ` +
                  rows.map((r) => `${r.source_domain}:${r.outcome.status}${r.outcome.status === "unverified" ? `(${r.outcome.reason})` : ""}`).join(", "),
              );
            }
          }
        }
      }
    } else {
      // Batch-2 timed out/errored → writeNormalizedData is skipped, but the
      // capacity resolver may have produced a corrected or cleared value. Persist
      // just the two capacity fields so the fix isn't lost on the degraded path.
      const clear_fields = (["oil_capacity_qts", "coolant_capacity_qts"] as const).filter(
        (k) => allFields[k]?.value === null && allFields[k]?.flagged === true,
      );
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEngineSpecs, {
        engine_id: args.engineId,
        oil_capacity_qts: asNumber(allFields.oil_capacity_qts?.value),
        coolant_capacity_qts: asNumber(allFields.coolant_capacity_qts?.value),
        clear_fields,
      });
    }

    // Reverse fitment corroboration (flag-gated, PARTS_REVERSE_FITMENT=on):
    // now that part_prices carry product-page URLs, verify each part's own
    // fitment table lists this vehicle. Scheduled so it never eats this
    // action's remaining budget; the action itself no-ops when the flag is off.
    if (process.env.PARTS_REVERSE_FITMENT === "on") {
      await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.reverseFitment.verifyConfigFitments, {
        vehicleConfigId: args.vehicleConfigId,
        year: args.year,
        make: args.make,
        model: args.model,
      });
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

    // Update enrichment run. A batch-2 timeout still finalizes (batch-1 data
    // is real and the config gets its normal terminal status below) but the
    // run records 'timeout' — not a fake 'complete' (review item 6).
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
      run_id: args.runId,
      status: timedOut ? "timeout" : "complete",
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
        ...(timedOut ? ["batch2_timeout"] : []),
        ...sanityFlags.map((f) => `sanity:${f.field}:${f.reason}`),
        ...oemFlags.map((f) => `oem:${f.field}:${f.reason}`),
      ],
      // Structured mirror of the sanity/OEM strings above — queryable, so
      // flagged-but-complete runs surface in manual_review_queue.list instead
      // of dying in a write-only string array.
      sanity_flags: [
        ...sanityFlags.map((f) => ({
          field: f.field,
          severity: f.severity,
          reason: f.reason,
          value: f.value != null ? String(f.value) : undefined,
        })),
        ...oemFlags.map((f) => ({
          field: f.field,
          severity: "flag",
          reason: f.reason,
          value: f.value != null ? String(f.value) : undefined,
        })),
      ],
      field_gaps: classifyFieldGaps(allFields, sanityFlags),
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
      `[v8] ${timedOut ? "TIMEOUT (finalized with batch-1 data)" : "COMPLETE"}: ` +
      `${buildEngineKey(vehicle)} — fillRate=${fillRate}% (flat=${flatFillRate}%), ` +
      `tokens=${totalTokensIn}in/${totalTokensOut}out, ` +
      `searches=${totalWebSearches}, time=${Math.round(durationMs / 1000)}s`,
    );
}
