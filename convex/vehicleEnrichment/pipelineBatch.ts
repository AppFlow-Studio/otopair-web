// DEPRECATED — replaced by v3pipeline.ts. Do not use.
// Will be deleted after v3 pipeline is verified stable.

/**
 * vehicleEnrichment/pipelineBatch.ts — v7 Batch API Pipeline
 *
 * Architecture:
 *   1. NHTSA vPIC  → free, deterministic vehicle identity (drivetrain, turbo, cylinders, etc.)
 *   2. FireCrawl   → scrape OEM parts catalog + owner's manual → raw markdown
 *   3. Batch [1A, 1B] — submitted in ONE Batch API call (parallel execution):
 *        1A: Sonnet, NO web search — extract 88 fields from scraped markdown (OEM parts, pricing)
 *        1B: Sonnet, WITH web search — independent fields: intervals, fluid types, tire specs
 *   4. Poll until BOTH 1A+1B complete → merge (1A takes precedence over 1B)
 *   5. Apply applicability rules (chain→timing null, FWD→diff null, sedan→rear wiper null)
 *   6. fillFromSiblings() → copy SAFE physical/mechanical fields from sibling DB records
 *   7. Batch 2 → Sonnet, WITH web search — pricing for OEM part numbers + gap fill remaining nulls
 *   8. Merge → store result
 *
 * Key improvements over v6:
 *   - Parallel Batch 1A+1B in same API call → no sequential wait between scrape-extract and web-search
 *   - 26 new fields (88 total): rotors, battery, coolant OEM + fluid types + diff/transfer intervals
 *   - Applicability rules prevent wasted Batch 2 searches on N/A fields
 *   - Expanded SERVICE_FIELD_MAP covers 14 services (was 6)
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
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

// ─── Field Parsing ────────────────────────────────────────────────

function toDbField(f: FieldResult): Record<string, any> {
  return {
    value: f.value,
    source: f.source_url ?? (f.source_type === "training_data" ? "training_data" : f.source_type === "nhtsa" ? "nhtsa" : null),
    confidence: f.confidence,
    verified: (f.confidence ?? 0) >= 0.8,
    apiConfirmed: false,
    apiDisagreed: false,
    apiValue: null,
  };
}

function parseField(raw: any): FieldResult {
  if (!raw || raw.value === undefined) return emptyField();
  let value = raw.value ?? null;
  if (typeof value === "string") {
    if (value.startsWith("$")) {
      const low = value.replace(/\$/g, "").split("-")[0].trim();
      const n = parseFloat(low);
      if (!isNaN(n)) value = n;
    } else if (/^(0\.\d+|[1-9]\d*(\.\d+)?)$/.test(value)) {
      value = parseFloat(value);
    }
  }
  return {
    value,
    source_url: raw.source_url ?? null,
    source_type: raw.source_type ?? null,
    confidence: typeof raw.confidence === "number" ? raw.confidence : null,
    flagged: false as const,
    flag_reason: null,
  };
}

function parseInterval(raw: any) {
  if (!raw) return { miles: emptyField(), months: emptyField(), status: "scheduled" as const, display_string: null };
  return {
    miles: parseField(raw.miles),
    months: parseField(raw.months),
    status: (raw.status as any) || "scheduled" as const,
    display_string: raw.display_string ?? null,
  };
}

// ─── Batch 1A Parser ──────────────────────────────────────────────

function parseBatch1a(data: Record<string, any>): Record<string, FieldResult> {
  const f: Record<string, FieldResult> = {};

  // Fluids
  f.oil_viscosity = parseField(data?.fluids?.oil_viscosity);
  f.oil_capacity_qts = parseField(data?.fluids?.oil_capacity_qts);
  f.coolant_type = parseField(data?.fluids?.coolant_type);
  f.coolant_capacity_qts = parseField(data?.fluids?.coolant_capacity_qts);
  f.brake_fluid_type = parseField(data?.fluids?.brake_fluid_type);
  f.power_steering_type = parseField(data?.fluids?.power_steering_type);

  // Intervals
  const intervals = data?.intervals ?? {};
  const intervalMap: Record<string, string> = {
    oil_change: "oil_change",
    spark_plug: "spark_plug",
    transmission_service: "transmission_service",
    coolant_flush: "coolant_flush",
    air_filter: "air_filter",
    cabin_filter: "cabin_filter",
    brake_fluid_flush: "brake_fluid_flush",
    serpentine_belt: "serpentine_belt",
    timing_belt_or_chain_service: "timing_service",
  };
  for (const [key, prefix] of Object.entries(intervalMap)) {
    const parsed = parseInterval(intervals[key]);
    f[`${prefix}_miles`] = parsed.miles;
    f[`${prefix}_months`] = parsed.months;
  }

  // Attributes
  f.timing_system = parseField(data?.attributes?.timing_system);
  f.drivetrain = parseField(data?.attributes?.drivetrain);
  f.turbo = parseField(data?.attributes?.turbo);
  f.fuel_injection_type = parseField(data?.attributes?.fuel_injection_type);
  f.transmission_type = parseField(data?.attributes?.transmission_type);

  // OEM Parts (original 10 + new 4)
  const parts = data?.oem_parts ?? {};
  for (const k of [
    "oil_filter_oem", "air_filter_oem", "cabin_filter_oem", "spark_plug_oem",
    "front_brake_pad_oem", "rear_brake_pad_oem", "rotor_front_oem", "rotor_rear_oem",
    "drain_plug_gasket_oem", "serpentine_belt_oem", "timing_belt_oem",
    "wiper_blade_set_oem", "battery_oem", "coolant_oem", "engine_oil_oem",
  ]) {
    f[k] = parseField(parts[k]);
  }

  // New OEM pricing from Batch 1A parts pages
  const pricing = data?.oem_pricing ?? {};
  f.rotor_front_price = parseField(pricing.rotor_front_price);
  f.rotor_rear_price = parseField(pricing.rotor_rear_price);
  f.battery_price = parseField(pricing.battery_price);

  // Battery & Electrical
  f.battery_group = parseField(data?.battery?.battery_group);
  f.battery_cca = parseField(data?.battery?.battery_cca);
  f.battery_type = parseField(data?.battery?.battery_type);
  f.battery_location = parseField(data?.battery?.battery_location);
  f.spark_plug_quantity = parseField(data?.spark_plug?.quantity);
  f.spark_plug_gap = parseField(data?.spark_plug?.gap_mm);
  f.parking_brake_type = parseField(data?.parking_brake_type);

  // Trim specs
  const trim = data?.trim_specs ?? {};
  f.front_tire_size = parseField(trim.front_tire_size);
  f.rear_tire_size = parseField(trim.rear_tire_size);
  f.tire_pressure_front_psi = parseField(trim.tire_pressure_front_psi);
  f.tire_pressure_rear_psi = parseField(trim.tire_pressure_rear_psi);
  f.lug_nut_torque_ft_lbs = parseField(trim.lug_nut_torque_ft_lbs);
  f.front_wiper_size = parseField(trim.front_wiper_size);
  f.rear_wiper_size = parseField(trim.rear_wiper_size);

  return f;
}

// ─── Batch 1B Parser ──────────────────────────────────────────────

function parseBatch1b(data: Record<string, any>): Record<string, FieldResult> {
  const f: Record<string, FieldResult> = {};

  // Fluids (includes new fluid types)
  const fluids = data?.fluids ?? {};
  f.oil_viscosity = parseField(fluids.oil_viscosity);
  f.oil_capacity_qts = parseField(fluids.oil_capacity_qts);
  f.coolant_type = parseField(fluids.coolant_type);
  f.coolant_capacity_qts = parseField(fluids.coolant_capacity_qts);
  f.brake_fluid_type = parseField(fluids.brake_fluid_type);
  f.power_steering_type = parseField(fluids.power_steering_type);
  f.trans_fluid_type = parseField(fluids.trans_fluid_type);
  f.diff_fluid_type = parseField(fluids.diff_fluid_type);
  f.transfer_case_fluid_type = parseField(fluids.transfer_case_fluid_type);

  // Intervals (all existing + new diff/transfer_case)
  const intervals = data?.intervals ?? {};
  const intervalMap: Record<string, string> = {
    oil_change: "oil_change",
    spark_plug: "spark_plug",
    transmission_service: "transmission_service",
    coolant_flush: "coolant_flush",
    air_filter: "air_filter",
    cabin_filter: "cabin_filter",
    brake_fluid_flush: "brake_fluid_flush",
    serpentine_belt: "serpentine_belt",
    timing_belt_or_chain_service: "timing_service",
    diff_fluid: "diff_fluid",
    transfer_case_fluid: "transfer_case_fluid",
  };
  for (const [key, prefix] of Object.entries(intervalMap)) {
    const parsed = parseInterval(intervals[key]);
    f[`${prefix}_miles`] = parsed.miles;
    f[`${prefix}_months`] = parsed.months;
  }

  // Attributes
  const attrs = data?.attributes ?? {};
  f.timing_system = parseField(attrs.timing_system);
  f.parking_brake_type = parseField(attrs.parking_brake_type);

  // Battery
  f.battery_group = parseField(data?.battery?.battery_group);
  f.battery_cca = parseField(data?.battery?.battery_cca);
  f.battery_type = parseField(data?.battery?.battery_type);
  f.battery_location = parseField(data?.battery?.battery_location);

  // Spark plug gap (quantity comes from NHTSA in 1A)
  f.spark_plug_gap = parseField(data?.spark_plug?.gap_mm);

  // Trim specs
  const trim = data?.trim_specs ?? {};
  f.front_tire_size = parseField(trim.front_tire_size);
  f.rear_tire_size = parseField(trim.rear_tire_size);
  f.tire_pressure_front_psi = parseField(trim.tire_pressure_front_psi);
  f.tire_pressure_rear_psi = parseField(trim.tire_pressure_rear_psi);
  f.lug_nut_torque_ft_lbs = parseField(trim.lug_nut_torque_ft_lbs);
  f.front_wiper_size = parseField(trim.front_wiper_size);
  f.rear_wiper_size = parseField(trim.rear_wiper_size);

  return f;
}

/**
 * Merge Batch 1A (scraped, authoritative) and Batch 1B (web search, fallback).
 * 1A values always take precedence. 1B fills nulls.
 */
function mergeBatch1(
  a: Record<string, FieldResult>,
  b: Record<string, FieldResult>,
): Record<string, FieldResult> {
  const merged: Record<string, FieldResult> = { ...a };
  for (const [k, bVal] of Object.entries(b)) {
    if (merged[k]?.value == null && bVal?.value != null) {
      merged[k] = bVal;
    }
  }
  return merged;
}

// ─── fillFromSiblings (SAFE FIELDS ONLY) ─────────────────────────

async function fillFromSiblings(
  ctx: any,
  engineCode: string,
  fields: Record<string, FieldResult>,
  currentEngineKey: string,
): Promise<void> {
  const siblings = await ctx.runQuery(
    internal.vehicleEnrichment.queries.getByEngineCode,
    { engineCode },
  );

  let filled = 0;
  for (const sibling of siblings ?? []) {
    if (sibling.engineConfig === currentEngineKey) continue;

    for (const fieldName of SIBLING_SAFE_FIELDS) {
      if (fields[fieldName]?.value != null) continue;
      const sibVal = sibling[fieldName];
      if (sibVal?.value == null) continue;

      fields[fieldName] = {
        value: sibVal.value,
        source_url: null,
        source_type: "sibling_engine",
        confidence: Math.min((sibVal.confidence ?? 0.8) * 0.9, 0.85),
        flagged: false,
        flag_reason: null,
      };
      filled++;
    }
    if (filled > 0) break;
  }

  if (filled > 0) {
    console.log(`[v7/_siblings] Filled ${filled} safe fields from sibling engine`);
  }
}

// ─── Batch 2 Parser ───────────────────────────────────────────────

function isBlockedDomain(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

function parseBatch2(
  data: Record<string, any>,
  nullFields: string[],
): { gapFields: Record<string, FieldResult>; services: ServicePricingResult[] } {
  const gapFields: Record<string, FieldResult> = {};

  const gf = data?.gap_fields ?? {};
  for (const fieldName of nullFields) {
    const raw = gf[fieldName];
    if (raw && raw.value != null && !isBlockedDomain(raw.source_url)) {
      const parsed = parseField(raw);
      gapFields[fieldName] = {
        value: parsed.value,
        source_url: raw.source_url ?? null,
        source_type: raw.source_type === "training_data" ? "training_data" : "web_search",
        confidence: typeof raw.confidence === "number" ? raw.confidence : 0.7,
        flagged: false,
        flag_reason: null,
      };
    }
  }

  const services = parsePricing(data?.services ?? []);
  return { gapFields, services };
}

// ─── Pricing ─────────────────────────────────────────────────────

const SERVICE_FIELD_MAP: Record<string, { price?: string; labor?: string }> = {
  "Oil Change":                           { price: "oil_change_price",               labor: "estimated_labor_oil_change_hrs" },
  "Brake Pad Replacement - Front":        { price: "brake_pad_front_price",           labor: "estimated_labor_brake_front_hrs" },
  "Brake Pad Replacement - Rear":         { price: "brake_pad_rear_price",            labor: "estimated_labor_brake_rear_hrs" },
  "Brake Pad + Rotor Replacement - Front":{ price: "rotor_front_price",              labor: "estimated_labor_rotor_front_hrs" },
  "Brake Pad + Rotor Replacement - Rear": { price: "rotor_rear_price",               labor: "estimated_labor_rotor_rear_hrs" },
  "Spark Plug Replacement":               { price: "spark_plug_price",               labor: "estimated_labor_spark_plug_hrs" },
  "Air Filter Replacement":               { price: "air_filter_price" },
  "Cabin Air Filter Replacement":         { price: "cabin_filter_price" },
  "Serpentine Belt Replacement":          { price: "serpentine_belt_price",           labor: "estimated_labor_serpentine_belt_hrs" },
  "Coolant Flush":                        { price: "coolant_flush_price",             labor: "estimated_labor_coolant_flush_hrs" },
  "Transmission Fluid Service":           { price: "transmission_service_price",      labor: "estimated_labor_trans_fluid_hrs" },
  "Battery Replacement":                  { price: "battery_price",                  labor: "estimated_labor_battery_hrs" },
  "Brake Fluid Flush":                    { price: "brake_fluid_flush_price",         labor: "estimated_labor_brake_fluid_flush_hrs" },
  "Timing Belt/Chain Service":            {                                            labor: "estimated_labor_timing_service_hrs" },
};

function parsePricing(rawServices: any[]): ServicePricingResult[] {
  if (!Array.isArray(rawServices)) return [];
  const LABOR_RATE = 125;
  return rawServices
    .filter((r) => r?.service_name)
    .map((raw) => {
      const laborHours = parseField(raw.labor_hours);
      const partsLow = parseField(raw.parts_cost_low);
      const partsHigh = parseField(raw.parts_cost_high);
      let totalLow: number | null = null;
      let totalHigh: number | null = null;
      if (raw.is_applicable && laborHours.value != null) {
        const laborCost = Number(laborHours.value) * LABOR_RATE;
        totalLow = laborCost + (Number(partsLow.value) || 0);
        totalHigh = laborCost + (Number(partsHigh.value) || 0);
      }
      return {
        service_name: raw.service_name,
        is_applicable: raw.is_applicable ?? true,
        labor_hours: laborHours,
        // Legacy pipelineBatch path predates parts_breakdown. v3pipeline's
        // parser is the authoritative one — this returns an empty array so
        // the shared ServicePricingResult type remains satisfied.
        parts_breakdown: [],
        parts_cost_low: partsLow,
        parts_cost_high: partsHigh,
        total_cost_low: totalLow,
        total_cost_high: totalHigh,
        confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
        tech_notes: raw.tech_notes ?? null,
      };
    });
}

function mapPricingToFields(services: ServicePricingResult[]): Record<string, FieldResult> {
  const fields: Record<string, FieldResult> = {};
  for (const svc of services) {
    const map = SERVICE_FIELD_MAP[svc.service_name];
    if (!map || !svc.is_applicable) continue;
    if (map.price && svc.parts_cost_low.value != null) {
      fields[map.price] = {
        value: svc.total_cost_low ?? svc.parts_cost_low.value,
        source_url: svc.parts_cost_low.source_url,
        source_type: svc.parts_cost_low.source_type,
        confidence: svc.confidence,
        flagged: false,
        flag_reason: null,
      };
    }
    if (map.labor) {
      const laborVal = svc.labor_hours.value ?? (svc.service_name === "Oil Change" && svc.is_applicable ? 0.5 : null);
      if (laborVal != null) {
        fields[map.labor] = {
          value: laborVal,
          source_url: svc.labor_hours.source_url,
          source_type: svc.labor_hours.value != null ? svc.labor_hours.source_type : "default" as any,
          confidence: svc.labor_hours.value != null ? svc.confidence : 0.7,
          flagged: false,
          flag_reason: null,
        };
      }
    }
  }
  return fields;
}

// ─── Utilities ────────────────────────────────────────────────────

function getNullFields(fields: Record<string, FieldResult>): string[] {
  return V4_FIELD_KEYS.filter((k) => {
    const f = fields[k];
    // Treat "not_applicable" flagged fields as filled (no need to search)
    if (f?.flag_reason === "not_applicable") return false;
    return !f || f.value == null;
  }) as string[];
}

function getOemParts(fields: Record<string, FieldResult>): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const k of [
    "oil_filter_oem", "air_filter_oem", "cabin_filter_oem", "spark_plug_oem",
    "front_brake_pad_oem", "rear_brake_pad_oem", "rotor_front_oem", "rotor_rear_oem",
    "drain_plug_gasket_oem", "serpentine_belt_oem", "wiper_blade_set_oem",
    "battery_oem",
  ]) {
    const val = fields[k]?.value;
    if (typeof val === "string" && val) parts[k] = val;
  }
  return parts;
}

function calculateFillRate(fields: Record<string, FieldResult>): number {
  let filled = 0;
  for (const k of V4_FIELD_KEYS) {
    const f = fields[k];
    if (f?.value != null || f?.flag_reason === "not_applicable") filled++;
  }
  return Math.round((filled / V4_FIELD_KEYS.length) * 100);
}

function ensureAllFields(fields: Record<string, FieldResult>): Record<string, FieldResult> {
  const r: Record<string, FieldResult> = {};
  for (const k of V4_FIELD_KEYS) r[k] = fields[k] ?? emptyField();
  return r;
}

function buildDbRecord(
  engineKey: string,
  vehicle: VehicleInput,
  allFields: Record<string, FieldResult>,
  fillRate: number,
  sourceUrls: string[],
  callLog: CallLogEntry[],
  durationMs: number,
): Record<string, any> {
  const record: Record<string, any> = {
    engineConfig: engineKey,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    engineCode: vehicle.engineCode,
    enrichedAt: Date.now(),
    fillRate,
    sourceUrls: [...new Set(sourceUrls)],
    enrichmentVersion: "v7",
    enrichmentDurationMs: durationMs,
    callLog,
  };
  for (const key of V4_FIELD_KEYS) {
    record[key] = toDbField(allFields[key] ?? emptyField());
  }
  return record;
}

// ─── Shared Args ─────────────────────────────────────────────────

const vehicleArgs = {
  vehicleId: v.id("vehicles"),
  year: v.float64(),
  make: v.string(),
  model: v.string(),
  trim: v.string(),
  engineCode: v.string(),
  displacement: v.string(),
  startTime: v.float64(),
  callLog: v.array(v.any()),
  sourceUrls: v.array(v.string()),
  attempt: v.optional(v.float64()),
};

const MAX_POLL_ATTEMPTS = 180;
const POLL_INTERVAL_MS = 1 * 60 * 1000;

// ─── Entry Point ─────────────────────────────────────────────────

export const enrichVehicleBatch = internalAction({
  args: {
    vehicleId: v.id("vehicles"),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.string(),
    engineCode: v.string(),
    displacement: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
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
    const engineKey = buildEngineKey(vehicle);
    console.log(`[v7] Starting enrichment for ${engineKey}`);

    // Cache check
    const existing = await ctx.runQuery(
      internal.vehicleEnrichment.queries.getByEngineKey,
      { engineKey },
    );
    if (existing && (existing.fillRate ?? 0) > 70) {
      console.log(`[v7] Cache hit for ${engineKey} (fillRate=${existing.fillRate}%)`);
      await ctx.runMutation(
        internal.vehicleEnrichment.mutations.attachToVehicle,
        { vehicleId: args.vehicleId, enrichedDataId: existing._id },
      );
      return { status: "cache_hit" as const, engineKey, fillRate: existing.fillRate };
    }

    // Step 1: Read vehicle identity from DB
    let vPicData: VehicleIdentity | null = null;
    try {
      vPicData = await ctx.runQuery(
        internal.vehicleEnrichment.nhtsa.getIdentity,
        { vehicleId: args.vehicleId },
      );
      if (vPicData) {
        console.log(`[v7] DB identity: drivetrain=${vPicData.drivetrain}, cylinders=${vPicData.cylinders}, body=${vPicData.body_class}`);
      }
    } catch (e) {
      console.warn("[v7] Could not read vehicle identity from DB:", e);
    }

    // Step 2: FireCrawl — scrape parts catalog + owner's manual
    const sources = await scrapeVehicleSources(ctx, vehicle);

    // Step 3: Submit Batch [1A, 1B] — two requests in ONE batch call (run in parallel)
    const batchId = await submitBatch([
      {
        customId: "batch1a",
        system: BATCH_1_SYSTEM,
        userPrompt: buildBatch1Prompt(vehicle, vPicData, sources.partsMarkdown, sources.manualMarkdown),
        maxTokens: 8192,
        temperature: 0,
        maxSearchUses: 0, // NO web search in 1A — pure extraction from scraped content
      },
      {
        customId: "batch1b",
        system: BATCH_1B_SYSTEM,
        userPrompt: buildBatch1bPrompt(vehicle),
        maxTokens: 16384,
        temperature: 0,
        maxSearchUses: 1, // web search enabled, no cap
        blockedDomains: BLOCKED_DOMAINS,
      },
    ]);

    console.log(`[v7] Batch [1A, 1B] submitted (batchId=${batchId}), scheduling poll`);
    const allSourceUrls = [...sources.partsSourceUrls, ...sources.manualSourceUrls];

    await ctx.scheduler.runAfter(
      POLL_INTERVAL_MS,
      internal.vehicleEnrichment.pipelineBatch._pollBatch1,
      {
        vehicleId: args.vehicleId,
        year: args.year, make: args.make, model: args.model,
        trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
        startTime,
        callLog: [],
        sourceUrls: allSourceUrls,
        batchId,
        vPicData: vPicData as any,
        attempt: 1,
      },
    );

    return { status: "batch_submitted" as const, engineKey, batchId };
  },
});

// ─── Poll Batch 1 (1A + 1B) ───────────────────────────────────────

export const _pollBatch1 = internalAction({
  args: {
    ...vehicleArgs,
    batchId: v.string(),
    vPicData: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    console.log(`[v7/_pollBatch1] Poll attempt ${attempt} for batchId=${args.batchId}`);

    const status = await getBatchStatus(args.batchId);

    if (status !== "ended") {
      if (attempt >= MAX_POLL_ATTEMPTS) {
        console.error(`[v7/_pollBatch1] Timed out after ${attempt} attempts`);
        return;
      }
      await ctx.scheduler.runAfter(
        POLL_INTERVAL_MS,
        internal.vehicleEnrichment.pipelineBatch._pollBatch1,
        { ...args, attempt: attempt + 1 },
      );
      return;
    }

    // Parse Batch 1A + 1B results
    const results = await getBatchResults(args.batchId);
    const r1a = results["batch1a"];
    const r1b = results["batch1b"];

    if (!r1a) {
      console.error("[v7/_pollBatch1] No batch1a result — aborting");
      return;
    }

    const callLog: CallLogEntry[] = [
      ...args.callLog,
      { call: "batch1a", tokensIn: r1a.usage.tokensIn, tokensOut: r1a.usage.tokensOut, webSearches: 0, durationMs: 0 },
      ...(r1b ? [{ call: "batch1b", tokensIn: r1b.usage.tokensIn, tokensOut: r1b.usage.tokensOut, webSearches: r1b.usage.webSearches, durationMs: 0 }] : []),
    ];

    const fields1a = parseBatch1a(r1a.data);
    const fields1b = r1b ? parseBatch1b(r1b.data) : {};
    const filledBy1a = V4_FIELD_KEYS.filter((k) => fields1a[k]?.value != null).length;
    const filledBy1b = V4_FIELD_KEYS.filter((k) => fields1b[k]?.value != null).length;
    console.log(`[v7/_pollBatch1] Batch 1A: ${filledBy1a} fields, Batch 1B: ${filledBy1b} fields`);

    // Merge: 1A (scraped) takes precedence, 1B fills nulls
    let fields = mergeBatch1(fields1a, fields1b);
    const filledAfterMerge = V4_FIELD_KEYS.filter((k) => fields[k]?.value != null).length;
    console.log(`[v7/_pollBatch1] After merge: ${filledAfterMerge}/${V4_FIELD_KEYS.length} fields filled`);

    const vehicle: VehicleInput = {
      vehicleId: args.vehicleId,
      year: args.year, make: args.make, model: args.model,
      trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
    };
    const engineKey = buildEngineKey(vehicle);

    // Step 4: Apply applicability rules (chain→timing, FWD→diff, sedan→rear_wiper)
    const vPicData = args.vPicData as VehicleIdentity | null;
    fields = applyApplicabilityRules(fields, vPicData);

    // Step 5: fillFromSiblings — SAFE fields only
    try {
      await fillFromSiblings(ctx, vehicle.engineCode, fields, engineKey);
    } catch (e) {
      console.warn("[v7/_pollBatch1] Sibling lookup failed:", e);
    }

    // Step 6: Submit Batch 2 — gap fill remaining nulls + pricing
    const oemParts = getOemParts(fields);
    const nullFields = getNullFields(fields);
    console.log(`[v7/_pollBatch1] ${nullFields.length} null fields for Batch 2 gap fill`);

    const batch2Id = await submitBatch([
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

    await ctx.scheduler.runAfter(
      POLL_INTERVAL_MS,
      internal.vehicleEnrichment.pipelineBatch._pollBatch2,
      {
        vehicleId: args.vehicleId,
        year: args.year, make: args.make, model: args.model,
        trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
        startTime: args.startTime,
        callLog,
        sourceUrls: [...args.sourceUrls],
        batchId: batch2Id,
        batch1Fields: fields as any,
        nullFields,
        attempt: 1,
      },
    );
  },
});

// ─── Poll Batch 2 ─────────────────────────────────────────────────

export const _pollBatch2 = internalAction({
  args: {
    ...vehicleArgs,
    batchId: v.string(),
    batch1Fields: v.any(),
    nullFields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    console.log(`[v7/_pollBatch2] Poll attempt ${attempt} for batchId=${args.batchId}`);

    const status = await getBatchStatus(args.batchId);

    if (status !== "ended") {
      if (attempt >= MAX_POLL_ATTEMPTS) {
        console.error(`[v7/_pollBatch2] Timed out after ${attempt} attempts — storing partial results`);
      } else {
        await ctx.scheduler.runAfter(
          POLL_INTERVAL_MS,
          internal.vehicleEnrichment.pipelineBatch._pollBatch2,
          { ...args, attempt: attempt + 1 },
        );
        return;
      }
    }

    const results = await getBatchResults(args.batchId);
    const r2 = results["batch2"];

    const callLog: CallLogEntry[] = [
      ...args.callLog,
      { call: "batch2", tokensIn: r2.usage.tokensIn, tokensOut: r2.usage.tokensOut, webSearches: r2.usage.webSearches, durationMs: 0 },
    ];
    const sourceUrls: string[] = [...args.sourceUrls];

    let allFields: Record<string, FieldResult> = { ...args.batch1Fields };

    // Apply gap fill fields — ONLY fill nulls, never overwrite 1A+1B values
    const { gapFields, services } = parseBatch2(r2.data, args.nullFields);
    for (const [k, fv] of Object.entries(gapFields)) {
      if (allFields[k]?.value == null) {
        allFields[k] = fv;
        if ((fv as FieldResult).source_url) sourceUrls.push((fv as FieldResult).source_url!);
      }
    }

    // Apply pricing — pricing fields are new fields (not in 1A/1B), safe to set
    const pricingFields = mapPricingToFields(services);
    for (const [k, fv] of Object.entries(pricingFields)) {
      // Only overwrite if this field doesn't already have a value from Batch 1A (parts pages pricing)
      if (allFields[k]?.value == null) {
        allFields[k] = fv;
      }
    }

    const applicable = services.filter((s) => s.is_applicable).length;
    const gapFilled = Object.keys(gapFields).length;
    console.log(`[v7/_pollBatch2] Gap fill: ${gapFilled} fields filled. Pricing: ${applicable} applicable services`);

    // Validation
    const vehicle: VehicleInput = {
      vehicleId: args.vehicleId,
      year: args.year, make: args.make, model: args.model,
      trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
    };
    const cylinders = parseInt(vehicle.displacement) >= 4 ? 8 : parseInt(vehicle.displacement) >= 2.5 ? 6 : 4;
    const sanityFlags = runSanityChecks(allFields, cylinders);
    const oemFlags = validateAllOemParts(allFields, vehicle.make);
    if (sanityFlags.length > 0) console.log(`[v7] Sanity: ${sanityFlags.length} flags`);
    if (oemFlags.length > 0) console.log(`[v7] OEM: ${oemFlags.length} issues`);

    // Assemble + Store
    const complete = ensureAllFields(allFields);
    const fillRate = calculateFillRate(complete);
    const durationMs = Date.now() - args.startTime;
    const engineKey = buildEngineKey(vehicle);

    const finalData = buildDbRecord(engineKey, vehicle, complete, fillRate, sourceUrls, callLog, durationMs);

    const existing = await ctx.runQuery(
      internal.vehicleEnrichment.queries.getByEngineKey,
      { engineKey },
    );

    let enrichedId;
    if (existing) {
      await ctx.runMutation(
        internal.vehicleEnrichment.mutations.updateEnrichedData,
        { id: existing._id, data: finalData },
      );
      enrichedId = existing._id;
    } else {
      enrichedId = await ctx.runMutation(
        internal.vehicleEnrichment.mutations.storeEnrichedData,
        { data: finalData },
      );
    }

    await ctx.runMutation(
      internal.vehicleEnrichment.mutations.attachToVehicle,
      { vehicleId: args.vehicleId, enrichedDataId: enrichedId },
    );

    console.log(
      `[v7] COMPLETE: ${engineKey} — fillRate=${fillRate}%, ` +
      `fields=${Object.values(complete).filter((f) => f?.value != null).length}/${V4_FIELD_KEYS.length}, ` +
      `time=${Math.round(durationMs / 1000)}s, ` +
      `1a_tokens=${callLog.find((l) => l.call === "batch1a")?.tokensIn ?? 0}, ` +
      `1b_tokens=${callLog.find((l) => l.call === "batch1b")?.tokensIn ?? 0}, ` +
      `2_tokens=${callLog.find((l) => l.call === "batch2")?.tokensIn ?? 0}`,
    );
  },
});
