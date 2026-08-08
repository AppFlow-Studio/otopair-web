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
import { buildEngineKey, emptyField, V4_FIELD_KEYS, SIBLING_SAFE_FIELDS, SIBLING_INHERIT_RULES, parseFrontWiperSizes, ON_DEMAND_SERVICE_SLUGS, WEAR_ITEM_SERVICE_SLUGS } from "./types";
import { submitBatch, getBatchStatus, getBatchResults, type BatchRequest } from "./utils/batchClient";
import {
  buildBatch1aArraySchema,
  buildBatch1bArraySchema,
  buildBatch2ArraySchema,
  normalizeBatchShape,
  buildVdbMappingOutputSchema,
  BATCH_1A_INTERVAL_KEYS,
  BATCH_1B_INTERVAL_KEYS,
  BATCH_1B_FLUID_KEYS,
  TRIM_SPEC_KEYS,
} from "./utils/batchSchemas";
import { mergeBlockedDomains } from "./utils/enrichmentFlags";
import { BATCH_1_SYSTEM, buildBatch1Prompt } from "./prompts/batch1Prompt";
import { BATCH_1B_SYSTEM, buildBatch1bPrompt } from "./prompts/batch1bPrompt";
import { BATCH_2_SYSTEM, buildBatch2Prompt, SERVICES_RESCUE_SYSTEM, buildServicesRescuePrompt } from "./prompts/batch2Prompt";
import { GAP_FILL_SYSTEM, buildGapFillPrompt } from "./prompts/gapFillPrompt";
import { callClaudeWithWebSearch } from "./utils/claudeClient";
import { deriveEngineFamily } from "./laborSibling";
import { runSanityChecks, normalizeOilViscosity, aggregateFieldConfidence, validateRotorResolution, ROTOR_NOMINAL_BANDS } from "./validation/sanityChecks";
import { resolveCapacities } from "./capacityResolver";
import { validateAllOemParts } from "./validation/oemValidation";
import { BLOCKED_DOMAINS, isMarketplaceUrl } from "./sourceRegistry";
import { applyApplicabilityRules, applyVerifiedEngineFields, applyKnownEngineFacts, applyFinalizeApplicability, applyEpsSuppression, IDENTITY_DEPENDENT_FIELDS } from "./applicabilityRules";
import { deriveIdentityFromTrim, mergeIdentity } from "./identityResolution";
import { computeEnrichmentStatus, explainGateDecision } from "./completionGate";
import {
  resolveRotorMinimums,
  rotorErrorTag,
  rotorGapReason,
  rotorMinGaps,
  computeAxlesWithFitment,
  type RotorAxle,
  type RotorAxleResolution,
} from "./utils/rotorSpecResource";
import { scrapeVehicleSources } from "./scraper";
import { normalizeOemNumber } from "./priceParser";
import { reextractPartPrice, isAffirmativeRejection, priceAllSources } from "./priceReextract";
import { extractPriceFirecrawl } from "./firecrawl";
import { discoverPriceUrls, prioritizeDiscoveryQueue, type DiscoveryQueueItem } from "./priceDiscovery";
import {
  axlePairGaps,
  computeQuotability,
  missingCoreRoles,
  type QuotabilityResult,
} from "./quotability";
import { resourceMissingRoles, soleFlaggedWinnerRoles } from "./utils/roleResource";
import { SERVICE_PARTS_REFERENCE, type PartRoleSpec } from "../lib/servicePartsReference";
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
import { validateChassisCodeYear, validateEngineCodeYear } from "./generationGate";
import { hasOemCatalogDomain } from "../partSelector";
import { backfillKilledRoles } from "./utils/roleBackfill";
import { resolveEngineCode, isNhtsaDescriptor, verifyEngineCode } from "./utils/engineCodeLookup";
import { verifyPartFitments, VERIFY_ROLE_KEYS, VERIFY_MAX_PARTS } from "./utils/partFitmentVerifier";
import { checkRoleIdentity } from "./roleIdentity";
import { verifyTransFluid, decideTransFluidAction } from "./utils/transFluidVerifier";
import { reconcileDrivetrain } from "./drivetrainReconcile";
import { canonicalizeTransmissionType } from "../lib/transmissionTypeInference";
import { reconcileTransmissionType, speedsFromTransUnit } from "./transmissionTypeReconcile";
import { fluidNamesForeignChassisBrand, FLUID_TYPE_TO_PART_FIELD } from "./fluidBrandConsistency";
import { reconcileTransFluidSpecWithPart } from "./transFluidSpecReconcile";
import { resolveScrapeRedirect } from "./buildSourceResolver";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
import { laborFlagsFromEnv } from "./laborResearch";
import { shouldAbortChain } from "./runFence";
import { buildLateSanityFlag, type LateSanityFlag, type LateSanityStage } from "./utils/lateSanityFlags";
import type { ClaimConsensus } from "./sourceAdapters/claimLedger";
import type { Id } from "../_generated/dataModel";

// ─── Authored return types ─────────────────────────────────────────
// Explicit handler return types are load-bearing (see convex/backfillTires.ts
// _listCandidates): this module references `internal.*` (a barrel
// self-reference) inside its handlers, so without authored annotations TS must
// infer each handler while resolving the whole ApiFromModules barrel — a
// circular resolution that silently degrades api.* / internal.* types to `any`
// for every file checked afterwards (the @ts-nocheck above hides the TS2589
// that would otherwise surface here).

export type EnrichVehicleBatchV3Result =
  | { status: "already_enriching"; configId: Id<"vehicle_configs"> }
  | { status: "cache_hit_validating"; configId: Id<"vehicle_configs"> }
  | { status: "cache_hit"; configId: Id<"vehicle_configs"> }
  | { status: "error"; reason: string }
  | { status: "batch_submitted"; configKey: string; batchId: string };

// ─── Poll-chain write fence ────────────────────────────────────────
// An orphaned chain (superseded by force-unstick/stuck-bypass, reaped by the
// zombie cron, or purged) must self-abort BEFORE writing — its finalize or
// catch-all failEnrichmentRun would otherwise clobber the successor run's
// config. Reads only; the fence itself never patches config status. Fail-open
// on read errors: a transient query failure must not kill a healthy paid run.
async function chainFenced(
  ctx: any,
  args: { runId: Id<"enrichment_runs">; vehicleConfigId: Id<"vehicle_configs"> },
  lateCollect: boolean,
  site: string,
): Promise<boolean> {
  try {
    const ownRun = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getEnrichmentRunById,
      { runId: args.runId },
    );
    const latestRun = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const verdict = shouldAbortChain(
      ownRun,
      latestRun?._id ?? null,
      args.runId,
      lateCollect,
    );
    if (verdict.abort) {
      console.log(
        `[fence] chain cancelled (${verdict.reason}) at ${site} — run=${args.runId}`,
      );
    }
    return verdict.abort;
  } catch (e) {
    console.warn(`[fence] check failed at ${site} (non-fatal, continuing):`, e);
    return false;
  }
}

// ─── Run-step trace (best-effort, non-fatal) ───────────────────────
// Writes one enrichment_run_steps row per stage for the Enrichment Console
// Deep-Dive replay. ALWAYS wrapped so a trace failure can never break a run.
async function traceStep(ctx: any, patch: Record<string, unknown>): Promise<void> {
  try {
    await ctx.runMutation(internal.vehicleEnrichment.runSteps.recordRunStep, patch);
  } catch (e) {
    console.warn(`[v8/trace] step '${String(patch.step)}' record failed (non-fatal):`, e);
  }
}

// ─── Constants ─────────────────────────────────────────────────────

const MAX_POLL_ATTEMPTS = 180;
const POLL_INTERVAL_MS = 1 * 60 * 1000;
// Batch-1 slow-poll extension (5-VIN test, Jul 2026): a 3h Anthropic batch
// queue is normal-tail, not dead — the Soul's batch completed after the old
// 180-attempt cap had already abandoned the run, leaving a zombie "pending"
// config and orphaned paid results. Batches resolve (or expire) within 24h,
// so after the fast window we keep polling every 10 min out to ~24h total.
// 10 min stays under the 15-min heartbeat-liveness window, so force-unstick
// still treats the run as alive.
const SLOW_POLL_INTERVAL_MS = 10 * 60 * 1000;
const MAX_POLL_ATTEMPTS_TOTAL = MAX_POLL_ATTEMPTS + 126; // 3h fast + ~21h slow ≈ 24h

// Fitment-refute proportional skepticism (batch-5 fix): a refuted fitment is
// hard-deleted only when its independent corroboration is at or below this many
// sources. Parts backed by MORE than this (multi-source consensus) are kept and
// soft-flagged instead — one hallucinated "refuted" verdict must not erase a
// part several sources agreed on (the G90 rear-pad false-positive). Env-tunable.
const FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES = Number(
  process.env.FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES ?? "1",
);

const MAKES_WITH_BRAKE_PAD_SENSORS = new Set([
  "BMW", "Mercedes-Benz", "Porsche", "Audi", "Mini", "Rolls-Royce",
  "Lexus", "Volvo", "Jaguar", "Land Rover", "Maserati", "Alfa Romeo", "Genesis",
]);

// ─── Field Parsing (copied from pipelineBatch.ts — same logic) ────

/** Fields whose string values must survive verbatim — numeric coercion via
 *  parseFloat destroys leading zeros, and OEM part numbers carry them (BMW
 *  "07119963130" → 7119963130 → 10 digits → fails the 11-digit make pattern
 *  → oem_part_rejected; found live on the 2001 740iA, Jul 11 2026).
 *  battery_group values like "49" are catalog strings too. Exported for tests. */
export function isVerbatimStringField(fieldKey: string | undefined): boolean {
  if (!fieldKey) return false;
  return fieldKey.endsWith("_oem") || fieldKey === "battery_group";
}

/** Exported for tests. */
export function parseField(raw: any, fieldKey?: string): FieldResult {
  if (!raw || raw.value === undefined) return emptyField();
  let value = raw.value ?? null;
  if (typeof value === "string" && !isVerbatimStringField(fieldKey)) {
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
    // Round 12: verbatim listing title echoed by the prompts for *_oem fields —
    // component-identity evidence (the Equinox battery slot held a CABLE whose
    // page title said so; nothing retained it).
    observed_title:
      typeof raw.observed_title === "string" && raw.observed_title.trim()
        ? raw.observed_title.trim().slice(0, 200)
        : null,
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

/**
 * One axle of the Batch-1 `rotor_specs` block.
 *
 * This only DESTRUCTURES — it routes the reported value into the minimum or the
 * nominal column according to the kind the model claimed, and carries the
 * claimed kind plus the verbatim label through as metadata. Whether the claim
 * is believable is decided in validation/sanityChecks.ts, so a rejection shows
 * up as a sanity flag instead of vanishing silently here.
 *
 * A `machine_to` answer fills neither column: it is a refinish limit, higher
 * than the discard minimum, and grading against it condemns healthy rotors.
 */
function parseRotorSpecAxle(spec: any): {
  min: FieldResult;
  nominal: FieldResult;
  kind: FieldResult;
  label: FieldResult;
} {
  const provenance = {
    source_url: spec?.source_url ?? null,
    source_type: spec?.source_type ?? (spec?.source_url ? "scraped" : null),
    confidence: spec?.confidence ?? null,
  };
  const kind =
    typeof spec?.thickness_kind === "string" ? spec.thickness_kind.trim() : null;
  const label =
    typeof spec?.observed_label === "string" ? spec.observed_label.trim() : null;
  const value = typeof spec?.value_mm === "number" ? spec.value_mm : null;

  const nominalValue =
    typeof spec?.nominal_mm === "number"
      ? spec.nominal_mm
      : kind === "nominal"
        ? value
        : null;

  const meta = (v: string | null): FieldResult => ({
    value: v,
    source_url: null,
    source_type: null,
    confidence: null,
    flagged: false,
    flag_reason: null,
  });

  return {
    min:
      kind === "discard_min" && value != null
        ? parseField({ value, ...provenance })
        : emptyField(),
    nominal:
      nominalValue != null
        ? parseField({ value: nominalValue, ...provenance })
        : emptyField(),
    kind: meta(kind),
    label: meta(label ? label.slice(0, 120) : null),
  };
}

// ─── Parsers (same as pipelineBatch.ts) ──────────────────────────

/**
 * Parse a batch response's `intervals` block for the given schema keys into
 * `${prefix}_miles` / `${prefix}_months` / `${prefix}_status` FieldResults.
 * Shared by parseBatch1a (BATCH_1A_INTERVAL_KEYS) and parseBatch1b
 * (BATCH_1B_INTERVAL_KEYS) — census P0.1 R7: 1B previously re-ran the whole
 * 1A parser over 40+ fields its schema can't return.
 *
 * The schema key "timing_belt_or_chain_service" lands under the field prefix
 * "timing_service" — every other key IS its prefix.
 *
 * Round 9 (batch-11): the model's per-interval status ("inspect_only",
 * "conditional_severe") was parsed and then dropped, so every interval wrote
 * as "scheduled". Carry it through to the G-section writer.
 */
function parseIntervalFields(
  intervals: Record<string, any>,
  keys: readonly string[],
): Record<string, FieldResult> {
  const f: Record<string, FieldResult> = {};
  for (const key of keys) {
    const prefix = key === "timing_belt_or_chain_service" ? "timing_service" : key;
    const iv = parseInterval(intervals[key]);
    f[`${prefix}_miles`] = iv.miles;
    f[`${prefix}_months`] = iv.months;
    f[`${prefix}_status`] = {
      value: iv.status,
      source_url: null,
      source_type: null,
      confidence: null,
      flagged: false,
      flag_reason: null,
    };
  }
  return f;
}

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

  // Intervals (incl. timing_belt_or_chain_service → timing_service_*)
  Object.assign(f, parseIntervalFields(data.intervals ?? {}, BATCH_1A_INTERVAL_KEYS));

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
    f[k] = parseField(parts[k], k);
  }

  // Census P0.1 R6: the old `data.oem_pricing ?? data.pricing` parse for
  // rotor_front_price / rotor_rear_price / battery_price was DEAD CODE — the
  // 1A schema (additionalProperties: false) forbids any pricing block, so the
  // read could never produce a value. Those fields fill from Batch-2 services
  // via SERVICE_FIELD_MAP / mapPricingToFields.

  // Battery & electrical
  const battery = data.battery ?? {};
  f.battery_group = parseField(battery.battery_group, "battery_group");
  f.battery_cca = parseField(battery.battery_cca);
  f.battery_type = parseField(battery.battery_type);
  f.battery_location = parseField(battery.battery_location);
  const spark = data.spark_plug ?? {};
  f.spark_plug_quantity = parseField(spark.quantity);
  f.spark_plug_gap = parseField(spark.gap_mm);
  f.parking_brake_type = parseField(data.parking_brake_type);

  // Rotor thickness (per axle) — three different numbers, never interchangeable.
  const rotorSpecs = data.rotor_specs ?? {};
  for (const axle of ["front", "rear"] as const) {
    const parsed = parseRotorSpecAxle(rotorSpecs[axle]);
    f[`rotor_${axle}_min_thickness_mm`] = parsed.min;
    f[`rotor_${axle}_nominal_thickness_mm`] = parsed.nominal;
    f[`rotor_${axle}_min_kind`] = parsed.kind;
    f[`rotor_${axle}_min_observed_label`] = parsed.label;
  }

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
      const parsed = parseField(parts[k], k);
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

/**
 * Parse the Batch-1B (web search) response. Census P0.1 R7: this used to call
 * parseBatch1a(data) wholesale, "parsing" 40+ fields the 1B structured-output
 * schema (buildBatch1bOutputSchema) forbids — oem_parts, rotor_specs, pricing,
 * drivetrain/turbo/fuel_injection_type/transmission_type, spark quantity —
 * all of which could only ever come back empty. It now parses exactly the
 * sections the 1B schema can return: intervals (incl. diff/TC/PS fluid),
 * fluids, battery (group/cca/type/location), attributes (timing_system +
 * parking_brake_type — which 1B nests under `attributes`, unlike 1A's
 * top-level slot, so the old code silently dropped it), trim specs, and
 * spark plug gap.
 */
function parseBatch1b(data: Record<string, any>): Record<string, FieldResult> {
  const f: Record<string, FieldResult> = {};
  if (!data) return f;

  // Intervals — the 1A set plus diff_fluid / transfer_case_fluid / ps_fluid
  Object.assign(f, parseIntervalFields(data.intervals ?? {}, BATCH_1B_INTERVAL_KEYS));

  // Fluids — types + capacities (keys are the V4 field keys 1:1)
  const fluids = data.fluids ?? {};
  for (const k of BATCH_1B_FLUID_KEYS) {
    f[k] = parseField(fluids[k]);
  }

  // Battery
  const battery = data.battery ?? {};
  f.battery_group = parseField(battery.battery_group, "battery_group");
  f.battery_cca = parseField(battery.battery_cca);
  f.battery_type = parseField(battery.battery_type);
  f.battery_location = parseField(battery.battery_location);

  // Attributes (1B returns only these two)
  const attrs = data.attributes ?? {};
  f.timing_system = parseField(attrs.timing_system);
  f.parking_brake_type = parseField(attrs.parking_brake_type);

  // Trim specs (keys are the V4 field keys 1:1)
  const trim = data.trim_specs ?? {};
  for (const k of TRIM_SPEC_KEYS) {
    f[k] = parseField(trim[k]);
  }

  // Spark plug gap (1B has no quantity slot)
  const spark = data.spark_plug ?? {};
  f.spark_plug_gap = parseField(spark.gap_mm);

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
/**
 * Rotor DISCARD minimums are deliberately excluded from Batch-2 / gap-fill
 * re-asks. Those paths carry a flat {value, source_url} shape with no room for
 * the verbatim label, and an unlabelled minimum is indistinguishable from a
 * nominal — the one failure that condemns healthy rotors. They are filled only
 * by paths that can quote a label: Batch 1, the rotor-spec resource tiers, a
 * mechanic reading the casting, or a director with a source link.
 * Nominals stay gap-fillable; they are never graded against.
 */
export const GAP_FILL_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  "rotor_front_min_thickness_mm",
  "rotor_rear_min_thickness_mm",
]);

export function getNullFields(fields: Record<string, FieldResult>): string[] {
  return V4_FIELD_KEYS.filter(
    (k) =>
      !GAP_FILL_EXCLUDED_FIELDS.has(k) &&
      fields[k]?.value == null &&
      fields[k]?.flag_reason !== "not_applicable",
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
 *   blocked_on_identity:X — null AND its applicability rule couldn't run
 *                           because identity input X is unknown (the field may
 *                           be physically absent from the vehicle)
 *   llm_null             — asked in every batch, no source produced a value
 */
export function classifyFieldGaps(
  fields: Record<string, FieldResult>,
  sanityFlags: Array<{ field: string; severity: string; reason: string }>,
  identity?: {
    drivetrain: string | null;
    transmission_type: string | null;
    body_class: string | null;
  } | null,
): Array<{ field: string; reason: string }> {
  const rejectedBySanity = new Map<string, string>();
  for (const f of sanityFlags) {
    if (f.severity === "reject") rejectedBySanity.set(f.field, f.reason);
  }
  // Reverse map: field → the UNKNOWN identity input that would have decided
  // its applicability. Field-level values take priority over the decode
  // identity, mirroring applyApplicabilityRules' own input resolution.
  const blockedBy = new Map<string, string>();
  for (const [input, depFields] of Object.entries(IDENTITY_DEPENDENT_FIELDS)) {
    const known =
      (fields[input]?.value as string | null) ??
      (identity ? (identity as any)[input] : null);
    if (known == null) {
      for (const df of depFields) blockedBy.set(df, input);
    }
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
    const blockingInput = blockedBy.get(k);
    if (blockingInput) {
      gaps.push({ field: k, reason: `blocked_on_identity:${blockingInput}` });
      continue;
    }
    gaps.push({ field: k, reason: "llm_null" });
  }
  return gaps;
}

/** V3 fill rate — counts actual data coverage across normalized tables. */
// Exported for the post-heal completion-gate re-evaluation
// (completionReevaluate.ts / priceRefresh epilogue): the gate must judge the
// config's CURRENT fill, not the finalize-time snapshot stored on the row.
export async function calculateV3FillRate(
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

/**
 * Live block-list for web_search requests (audit F18): hardcoded
 * BLOCKED_DOMAINS merged with the `blocked_domains` Convex table, so domains
 * quarantined at runtime (evidenceConsensus writes them) actually affect the
 * batch path. Fail-open to the static list — a table read failure must never
 * block an enrichment run.
 */
async function loadRuntimeBlockedDomains(ctx: { runQuery: any }): Promise<string[]> {
  try {
    const docs = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getBlockedDomains, {});
    const merged = mergeBlockedDomains(
      BLOCKED_DOMAINS,
      (docs ?? []).map((d: any) => d?.domain),
    );
    if (merged.length > BLOCKED_DOMAINS.length) {
      console.log(
        `[v8] blocked_domains: ${BLOCKED_DOMAINS.length} static + ` +
        `${merged.length - BLOCKED_DOMAINS.length} from table → ${merged.length} total`,
      );
    }
    return merged;
  } catch (e) {
    console.warn("[v8] blocked_domains table read failed — using static BLOCKED_DOMAINS only:", e);
    return mergeBlockedDomains(BLOCKED_DOMAINS, []);
  }
}

/** Batch-2 URL rejection: spec-quality blocklist + marketplaces. A marketplace
 *  entry keeps its price_low but loses the URL, so the part flows into the
 *  discovery fallback instead of being scraped from an untrustable listing. */
function isRejectedPriceUrl(url: string | null | undefined): boolean {
  return isBlockedDomain(url) || isMarketplaceUrl(url);
}

/** Exported for tests (services-rescue parse path). Pure. */
export function parseBatch2(
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
      const f = parseField(raw, k);
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

/**
 * Map service name from Batch 2 pricing to our service slug.
 *
 * INVARIANT (census P0.1 R2, enforced by tests/serviceRouting.test.ts): every
 * SERVICE_LIST name has an entry here, and every slug resolves to a seeded
 * services row (seeds/seedServices.ts SEEDED_SERVICE_SLUGS). A missing entry
 * or unseeded slug makes the pricing + labor loops silently `continue` — that
 * is how differential labor, wiper pricing, and five other services' data
 * dropped on every run. Dataset-only slugs (serpentine_belt, transfer_case_
 * service, …) are seeded is_bookable:false: the DATASET keeps the data, the
 * booking menu never shows them.
 */
export const SERVICE_NAME_TO_SLUG: Record<string, string> = {
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
  "Differential Fluid Service": "differential_service",
  // Census P0.1 R2 (2026-07-30): the six names below were in SERVICE_LIST but
  // had no map entry — their pricing + labor silently dropped on every run.
  // Transfer case now has its OWN dataset-only service row (previously left
  // unmapped on purpose so its labor wouldn't skew the differential_service
  // anchor — the dedicated row removes that conflation risk).
  "Wiper Blade Replacement (set)": "wiper_blade_replacement",
  "Transfer Case Fluid Service": "transfer_case_service",
  "AC Recharge / Service": "ac_recharge",
  "Engine Air Intake Cleaning": "engine_intake_cleaning",
  "Multi-Point Inspection / Diagnostic": "multi_point_inspection",
  "Wheel Bearing Replacement": "wheel_bearing_replacement",
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

/** roleKeys whose part field the applicability rules stamped not_applicable —
 *  feeds computeQuotability so physically-absent roles (chain engine's timing
 *  belt) leave the quotability denominator. Exported for tests. Pure. */
export function naRoleKeysFromFields(
  fields: Record<string, FieldResult>,
): Set<string> {
  const out = new Set<string>();
  for (const [k, meta] of Object.entries(PART_FIELD_MAP)) {
    if (fields[k]?.value == null && fields[k]?.flag_reason === "not_applicable") {
      out.add(meta.subcategory);
    }
  }
  return out;
}

// ─── Batch-3 gap-fill priority ───────────────────────────────────
// The re-ask pass is capped (PARTS_GAPFILL_MAX_FIELDS, default 15) and used
// to slice getNullFields() in V4_FIELD_KEYS declaration order — battery_oem
// (a core role with no universalFallback: missing it singly zeroes
// battery_replacement's quotability) competed with cosmetic fields for the
// cap (2001 740iA: battery_oem stayed llm_null, service unbookable).

/** roleKey (== oem_parts.subcategory) → reference role spec, first-declared wins. */
const ROLE_SPEC_BY_KEY: Map<string, PartRoleSpec> = (() => {
  const m = new Map<string, PartRoleSpec>();
  for (const svc of Object.values(SERVICE_PARTS_REFERENCE)) {
    for (const role of svc.roles) {
      if (!m.has(role.roleKey)) m.set(role.roleKey, role);
    }
  }
  return m;
})();

/** Capacity/spec fields that feed quantity resolution at quote time. */
const QUANTITY_SPEC_FIELDS = new Set([
  "oil_capacity_qts",
  "coolant_capacity_qts",
  "brake_fluid_capacity_oz",
  "transmission_fluid_capacity_qts",
  "diff_fluid_capacity_qts",
  "transfer_case_fluid_capacity_qts",
  "ps_fluid_capacity_oz",
  "spark_plug_quantity",
]);

/**
 * Order gap-fill candidates by quotability impact (stable within a tier):
 *   P0 — core-role parts with NO universalFallback and no where_equipped /
 *        if_found_bad condition: a miss singly zeroes a service's quotability
 *   P1 — remaining core-role part fields
 *   P2 — capacity/spec fields feeding quantity resolution
 *   P3 — everything else
 *   P4 — identity-blocked dependents while their identity input is unknown
 *        (searching "transfer case fluid" for an unknown-drivetrain car burns
 *        budget on a part the vehicle may not have)
 * Exported for tests. Pure.
 */
export function rankGapFillFields(
  nullFields: string[],
  identity?: {
    drivetrain: string | null;
    transmission_type: string | null;
    body_class: string | null;
  } | null,
): string[] {
  const identityBlocked = new Set<string>();
  for (const [input, depFields] of Object.entries(IDENTITY_DEPENDENT_FIELDS)) {
    const known = identity ? (identity as any)[input] : null;
    if (known == null) for (const df of depFields) identityBlocked.add(df);
  }
  const tier = (k: string): number => {
    if (identityBlocked.has(k)) return 4;
    const part = PART_FIELD_MAP[k];
    if (part) {
      if (part.serviceRole !== "core") return 3;
      const role = ROLE_SPEC_BY_KEY.get(part.subcategory);
      const hasEscape =
        !!role?.universalFallback ||
        role?.condition === "where_equipped" ||
        role?.condition === "if_found_bad";
      return hasEscape ? 1 : 0;
    }
    if (QUANTITY_SPEC_FIELDS.has(k)) return 2;
    return 3;
  };
  return nullFields
    .map((k, i) => ({ k, i, t: tier(k) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((e) => e.k);
}

// ─── P2.4 · Field-level sibling inheritance ──────────────────────
//
// v8 clones whole ROWS from a sibling config but never a single field, so
// engine-intrinsic facts a verified sibling already holds are re-asked of an
// LLM on every config (live census: timing_system 76% filled). This pass fills
// ONLY the audited SIBLING_INHERIT_RULES fields (types.ts), ONLY where the run
// ended null, and stamps everything it writes so an inherited value can never
// be mistaken for a directly-sourced one:
//
//   source_type "sibling_engine" · confidence capped at 0.7 (below the 0.75
//   quote gate, so inheritance alone can never make a service quotable) ·
//   flagged with the donor config key · one lateSanityFlags entry each.
//
// It never touches a field that is human-verified, was REJECTED this run, or
// was ruled not_applicable — the three ways the run already knows better.

/** Ceiling on an inherited field's confidence. Inherited data must never
 *  outrank directly-sourced data, nor clear the 0.75 quote gate on its own. */
export const SIBLING_INHERIT_CONFIDENCE_CAP = 0.7;

/** One donor candidate as returned by v3queries.findSiblingFieldDonors, after
 *  the rule's `fromColumn` decode. Plain data — no Convex types. */
export interface SiblingDonorCandidate {
  config_id: string;
  config_key: string;
  /** Decoded FieldResult value (never null — nulls are dropped upstream). */
  value: string | number | boolean;
  /** Donor CONFIG confidence_avg, or null when unknown. */
  confidence: number | null;
  /** Donor's engines.verified_fields names this column/field — a human said so. */
  verified: boolean;
  last_enriched_at: number | null;
  via: string;
}

/**
 * Pick the single best donor for one field. Precedence, in order:
 *   1. human-verified donor (verified_fields) beats everything
 *   2. higher confidence
 *   3. more recently enriched
 *   4. stable tiebreak on config_key so the choice is deterministic run-to-run
 *
 * Candidates with a null/undefined value are ignored. Returns null when no
 * candidate qualifies. Pure; exported for tests.
 */
export function selectSiblingDonor(
  candidates: readonly SiblingDonorCandidate[] | null | undefined,
  field: string,
): SiblingDonorCandidate | null {
  if (!candidates || candidates.length === 0) return null;
  if (!SIBLING_SAFE_FIELDS.has(field)) return null;
  const usable = candidates.filter((c) => c && c.value != null);
  if (usable.length === 0) return null;
  const ranked = [...usable].sort((a, b) => {
    if (!!b.verified !== !!a.verified) return b.verified ? 1 : -1;
    const ca = a.confidence ?? 0;
    const cb = b.confidence ?? 0;
    if (cb !== ca) return cb - ca;
    const ta = a.last_enriched_at ?? 0;
    const tb = b.last_enriched_at ?? 0;
    if (tb !== ta) return tb - ta;
    return String(a.config_key).localeCompare(String(b.config_key));
  });
  return ranked[0];
}

/** Why an inheritance was allowed or refused — recorded verbatim in the flag. */
export type SiblingInheritDecision =
  | { inherit: true; reason: "inherited" }
  | {
      inherit: false;
      reason:
        | "not_sibling_safe"
        | "no_donor"
        | "already_filled"
        | "rejected_this_run"
        | "not_applicable"
        | "human_verified";
    };

/**
 * Decide whether `field` may be filled from `donor`. Pure; exported for tests.
 *
 * `verifiedFields` accepts BOTH naming conventions in play: the FieldResult
 * key (`fuel_injection_type`) and the engines column a director actually
 * stamps (`fuel_injection`).
 */
export function shouldInheritField(
  field: string,
  existing: FieldResult | null | undefined,
  donor: SiblingDonorCandidate | null | undefined,
  verifiedFields: readonly string[] | null | undefined,
): SiblingInheritDecision {
  if (!SIBLING_SAFE_FIELDS.has(field)) return { inherit: false, reason: "not_sibling_safe" };
  if (!donor || donor.value == null) return { inherit: false, reason: "no_donor" };

  const verified = new Set(verifiedFields ?? []);
  const column = SIBLING_INHERIT_RULES[field]?.column;
  // A human's word is final — checked BEFORE the null test, because a director
  // who verified a field to null meant that null.
  if (verified.has(field) || (column && verified.has(column))) {
    return { inherit: false, reason: "human_verified" };
  }
  // Applicability ruled the field off this vehicle; resurrecting it is the
  // "N/A fields resurrected impossible data" failure getNullFields exists for.
  if (existing?.flag_reason === "not_applicable") {
    return { inherit: false, reason: "not_applicable" };
  }
  // A value this run examined and threw out must not come back through a side
  // door — the sibling is not new evidence against our own rejection.
  if (existing?.rejected === true) return { inherit: false, reason: "rejected_this_run" };
  // Fill NULLS ONLY. Sourced data always outranks inherited data.
  if (existing?.value != null) return { inherit: false, reason: "already_filled" };

  return { inherit: true, reason: "inherited" };
}

/** Build the FieldResult an inheritance writes. Pure; exported for tests. */
export function buildInheritedField(
  field: string,
  donor: SiblingDonorCandidate,
): FieldResult {
  const capped = Math.min(
    typeof donor.confidence === "number" && donor.confidence > 0
      ? donor.confidence
      : SIBLING_INHERIT_CONFIDENCE_CAP,
    SIBLING_INHERIT_CONFIDENCE_CAP,
  );
  return {
    value: donor.value,
    source_url: null,
    source_type: "sibling_engine",
    confidence: capped,
    // Flagged on purpose: an inherited value is review-visible until something
    // sources it directly.
    flagged: true,
    flag_reason: `sibling_inherit:donor=${donor.config_key}:via=${donor.via}`,
  };
}

/** Effective per-run cap. Read at CALL time so an env change takes effect
 *  without a redeploy of the module. 0 disables; garbage falls back to 12. */
export function siblingInheritMax(env: Record<string, string | undefined>): number {
  const raw = env.ENRICHMENT_SIBLING_INHERIT_MAX;
  if (raw == null || raw === "") return 12;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12;
}

/** Kill switch — ON unless explicitly "off". Read at CALL time. */
export function siblingInheritEnabled(env: Record<string, string | undefined>): boolean {
  return env.ENRICHMENT_SIBLING_INHERIT !== "off";
}

/** A donor row exactly as v3queries.findSiblingFieldDonors returns it — the
 *  column value is still RAW (undecoded). */
export interface RawSiblingDonor {
  config_id: string;
  config_key: string;
  raw_value: unknown;
  confidence?: number | null;
  verified?: boolean;
  last_enriched_at?: number | null;
  via?: string;
}

/**
 * The whole inheritance decision as ONE pure function: decode each donor
 * through its rule, pick the best, apply the gating rules, and stop at `cap`.
 * Returns the fields to write, in evaluation order. Never mutates its inputs.
 * Exported for tests.
 */
export function planSiblingInheritance(
  fields: Record<string, FieldResult>,
  donorsByField: Record<string, RawSiblingDonor[] | undefined>,
  verifiedFields: readonly string[],
  cap: number,
): Array<{ field: string; donor: SiblingDonorCandidate; result: FieldResult }> {
  const plan: Array<{ field: string; donor: SiblingDonorCandidate; result: FieldResult }> = [];
  if (!Number.isFinite(cap) || cap <= 0) return plan;

  for (const field of Object.keys(SIBLING_INHERIT_RULES)) {
    if (plan.length >= cap) break;
    const rule = SIBLING_INHERIT_RULES[field];
    // Decode first: an unrecognised column token is REFUSED here rather than
    // inherited (present-but-wrong is forbidden).
    const decoded: SiblingDonorCandidate[] = (donorsByField[field] ?? []).flatMap((d) => {
      if (!d) return [];
      const value = rule.fromColumn(d.raw_value);
      return value == null
        ? []
        : [{
            config_id: String(d.config_id),
            config_key: String(d.config_key),
            value,
            confidence: typeof d.confidence === "number" ? d.confidence : null,
            verified: d.verified === true,
            last_enriched_at: typeof d.last_enriched_at === "number" ? d.last_enriched_at : null,
            via: String(d.via ?? "engine"),
          }];
    });

    const donor = selectSiblingDonor(decoded, field);
    const decision = shouldInheritField(field, fields[field], donor, verifiedFields);
    if (!decision.inherit || !donor) continue;
    plan.push({ field, donor, result: buildInheritedField(field, donor) });
  }
  return plan;
}

/**
 * Stage tag for the P2.4 flags. `LATE_SANITY_STAGES` lives in
 * utils/lateSanityFlags.ts, which this task does not own, so the new stage is
 * asserted here instead of added there; the persisted column is
 * `stage: v.optional(v.string())`, so the value round-trips unchanged. Fold
 * "sibling_inherit" into LATE_SANITY_STAGES when that file is next edited.
 */
const SIBLING_INHERIT_STAGE = "sibling_inherit" as unknown as LateSanityStage;

/**
 * Severity for the P2.4 flags: "info", per lateSanityFlags.ts's own semantics —
 * "observability record, NOT a review signal". Inheritance is a routine,
 * deterministic, capped fill from an already-complete sibling, not a gate that
 * caught something suspicious. manual_review_queue.list admits any run with a
 * non-"info" flag, so "flag" here would push EVERY inheriting run into the
 * human queue and drown the real rejects. The value's own weakness is carried
 * where it actually bites: confidence capped below the quote gate, flagged:true
 * and source_type "sibling_engine" on the FieldResult.
 */
export const SIBLING_INHERIT_FLAG_SEVERITY = "info" as const;

/**
 * Fill still-null sibling-safe fields from a complete/verified sibling config.
 * Mutates `fields` in place, appends one structured flag per inheritance, and
 * returns how many fields were filled. Non-fatal by construction: any failure
 * logs and leaves the field map untouched.
 */
async function applySiblingInheritance(
  ctx: any,
  opts: { vehicleConfigId: any; verifiedFields: readonly string[] },
  fields: Record<string, FieldResult>,
  lateSanityFlags: LateSanityFlag[],
): Promise<number> {
  if (!siblingInheritEnabled(process.env)) {
    console.log("[v8/sibling-inherit] disabled via ENRICHMENT_SIBLING_INHERIT=off");
    return 0;
  }
  const cap = siblingInheritMax(process.env);
  if (cap <= 0) return 0;

  // Pre-filter: only ask the DB about fields that could actually be filled.
  // `null` donor here means "no donor yet" — every refusal except no_donor is
  // already decidable from local state.
  const wanted = Object.keys(SIBLING_INHERIT_RULES).filter((f) => {
    const d = shouldInheritField(f, fields[f], { value: "probe" } as any, opts.verifiedFields);
    return d.inherit;
  });
  if (wanted.length === 0) return 0;

  let donorsByField: Record<string, any[]> = {};
  try {
    donorsByField = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.findSiblingFieldDonors,
      {
        target_config_id: opts.vehicleConfigId,
        requests: wanted.map((f) => ({ field: f, column: SIBLING_INHERIT_RULES[f].column })),
      },
    );
  } catch (e) {
    console.warn("[v8/sibling-inherit] donor lookup failed (non-fatal):", e);
    return 0;
  }

  const plan = planSiblingInheritance(fields, donorsByField, opts.verifiedFields, cap);
  for (const { field, donor, result } of plan) {
    fields[field] = result;
    lateSanityFlags.push(
      buildLateSanityFlag(
        SIBLING_INHERIT_STAGE,
        field,
        SIBLING_INHERIT_FLAG_SEVERITY,
        `sibling_inherit:donor=${donor.config_key}:via=${donor.via}` +
          `:donor_verified=${donor.verified}:confidence=${result.confidence}`,
        String(donor.value),
      ),
    );
  }

  if (plan.length > 0) {
    console.log(
      `[v8/sibling-inherit] filled ${plan.length}/${wanted.length} sibling-safe field(s) ` +
        `(cap ${cap}): ${plan.map((p) => `${p.field}←${p.donor.config_key}`).join(", ")}`,
    );
  }
  return plan.length;
}

/** Map interval field prefix to service slug. */
export const INTERVAL_TO_SERVICE: Record<string, string> = {
  oil_change: "oil_change",
  spark_plug: "spark_plugs",
  transmission_service: "transmission_service",
  coolant_flush: "coolant_flush",
  air_filter: "filter_replacement",
  cabin_filter: "filter_replacement",
  brake_fluid_flush: "brake_fluid_flush",
  serpentine_belt: "serpentine_belt",
  timing_service: "timing_belt",
  diff_fluid: "differential_service",
  // Census P0.1 R4: transfer_case_fluid previously ALSO mapped to
  // differential_service — both prefixes upserted the same service row, so
  // whichever wrote last (loop order: transfer case) overwrote the
  // differential interval. It now writes its own dataset-only service row.
  transfer_case_fluid: "transfer_case_service",
  ps_fluid: "power_steering_flush",
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

/** Round 12: normalized OEM number → JSON-LD Product.name from the cached
 *  parts_catalog scrape. Deterministic component-identity evidence — takes
 *  precedence over the LLM's observed_title echo at the write site. Fail-open:
 *  cache miss / legacy cache rows (pre-`name` capture) yield an empty map. */
async function loadJsonLdTitlesByOem(
  ctx: any,
  vehicle: { make: string; model: string; year: number; trim?: string | null },
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const cached = await ctx.runQuery(
      internal.vehicleEnrichment.scraperQueries.getCachedScrape,
      {
        vehicleMake: vehicle.make,
        vehicleModel: vehicle.model,
        vehicleYear: vehicle.year,
        vehicleTrim: vehicle.trim ?? "",
        sourceType: "parts_catalog",
      },
    );
    if (cached?.part_prices_json) {
      const arr = JSON.parse(cached.part_prices_json) as Array<{
        oem_part_number?: string;
        name?: string | null;
      }>;
      for (const p of arr) {
        if (p?.oem_part_number && typeof p.name === "string" && p.name.trim()) {
          titles.set(normalizeOemNumber(p.oem_part_number), p.name.trim().slice(0, 200));
        }
      }
    }
  } catch (e) {
    console.warn("[v8-parts] JSON-LD title load failed (non-fatal):", e);
  }
  return titles;
}

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
  /** P2.5: for a badge-engineered vehicle, the builder's brand (e.g. "Mazda"
   *  for a Toyota Yaris) — so a part number from the builder's catalog passes
   *  the OEM-format guard, which otherwise validates only against the badge make
   *  and NULLs the correct Mazda parts the source-redirected scrape surfaced. */
  partSanitizeBrand?: string | null,
  /** Round 12: normalized OEM → deterministic JSON-LD listing title
   *  (loadJsonLdTitlesByOem). Wins over the field's observed_title echo. */
  jsonLdTitlesByOem?: Map<string, string> | null,
) {
  const now = Date.now();
  const partsOnly = writeScope === "parts";
  // Accept a part matching EITHER the badge make OR the builder brand (badge-
  // engineered cars carry the builder's OEM numbers; the badge's re-box numbers
  // still pass against `make`). Try the badge make first, then the builder.
  const sanitizePart = (rawStr: string): string | null => {
    const primary = sanitizePartNumber(rawStr, make);
    if (primary != null && primary.length > 0) return primary;
    if (partSanitizeBrand && partSanitizeBrand.toLowerCase() !== make.toLowerCase()) {
      return sanitizePartNumber(rawStr, partSanitizeBrand);
    }
    return primary;
  };

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
    let normalizedType = rawTransType
      ? (await canonicalizeTransmissionType(rawTransType)) ?? undefined
      : undefined;
    const transFluid = asString(fields.trans_fluid_type?.value);
    // Reconcile a wrong automatic-vs-manual decode against the trans fluid
    // (batch-8: vPIC "6-speed manual" on a ZF-8HP diesel automatic). A 3-pedal
    // manual never takes ATF, so an automatic fluid means the "manual" decode
    // is wrong — correct it here so the bad type doesn't persist and poison
    // downstream (fluid gate, CVT/manual applicability, director display).
    const transRecon = reconcileTransmissionType(normalizedType, transFluid);
    if (transRecon.corrected && transRecon.type) {
      console.warn(
        `[v8] Transmission type "${normalizedType}" reconciled → "${transRecon.type}" via fluid (${transRecon.flagReason})`,
      );
      normalizedType = transRecon.type;
      if (fields.transmission_type) {
        fields.transmission_type = {
          ...fields.transmission_type,
          value: transRecon.type,
          flagged: true,
          flag_reason: transRecon.flagReason ?? "transmission_type_reconciled",
        };
      }
    } else if (transRecon.flagReason && fields.transmission_type) {
      // A weaker contradiction (automatic decode, manual-reading fluid) — flag
      // for review, keep the decoded value (do not overwrite a likely-correct
      // automatic on a possibly-misslotted gear-oil string).
      fields.transmission_type = {
        ...fields.transmission_type,
        flagged: true,
        flag_reason: transRecon.flagReason,
      };
    }
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateTransmissionSpecs, {
      transmission_id: transmissionId,
      type: normalizedType,
      fluid_type: transFluid,
      // Drain-and-fill qts — the mutation always accepted this but nothing
      // passed it, leaving both ATF quantity paths (partRoleQuantity's fluid
      // role and serviceUnits' per_unit_spec count) with no enrichment feed.
      fluid_capacity_drain_fill_qts: asNumber(
        fields.transmission_fluid_capacity_qts?.value,
      ),
      data_quality: "enriched",
    });
  }

  // C. Drivetrain config — resolve drivetrain from the Batch-1 LLM fields
  // before setting diff/TC. (Census P0.1 R7 comment fix: the drivetrain
  // attribute arrives via Batch 1A's attributes block — the 1B schema has no
  // drivetrain slot, despite what these comments used to claim.)
  const batch1Drivetrain = asString(fields.drivetrain?.value);
  const diffFluid = asString(fields.diff_fluid_type?.value);
  const tcFluid = asString(fields.transfer_case_fluid_type?.value);

  // Read the current vehicle_config to check if drivetrain was resolved
  const currentVc = await ctx.runQuery(
    internal.vehicleEnrichment.v3queries.getVehicleConfigById,
    { vehicleConfigId },
  );
  const existingDrivetrain = currentVc?.drivetrain;

  // Priority: the NHTSA-decoded value stored on the config (existingDrivetrain)
  // is authoritative on the 2WD-vs-4WD axle count; the Batch-1 LLM value only
  // refines within that axle class. Batch-3 audit: the Sienna (4x2 FWD) and
  // F-150 (4x2) had their correct 2WD decode overwritten by an LLM "AWD"
  // guess, shipping phantom diff/transfer-case service. reconcileDrivetrain
  // keeps NHTSA's axle count and takes the LLM's specific label only when
  // they agree on the axle.
  const isResolved = (val: string | undefined | null): val is string =>
    !!val && val !== "unknown";

  const resolvedDrivetrain =
    reconcileDrivetrain(existingDrivetrain, batch1Drivetrain) ??
    (isResolved(batch1Drivetrain)
      ? batch1Drivetrain
      : isResolved(existingDrivetrain)
        ? existingDrivetrain
        : "FWD"); // last resort — all sources exhausted

  if (resolvedDrivetrain !== existingDrivetrain) {
    const overrode =
      isResolved(batch1Drivetrain) && resolvedDrivetrain !== batch1Drivetrain;
    console.log(
      `[v8] Drivetrain "${existingDrivetrain}" → "${resolvedDrivetrain}"` +
        (overrode
          ? ` (kept NHTSA axle over Batch-1 guess "${batch1Drivetrain}")`
          : ` (Batch 1)`),
    );
    // Update vehicle_config with the reconciled drivetrain
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
      vehicle_config_id: vehicleConfigId,
      drivetrain: resolvedDrivetrain,
    });
  } else if (existingDrivetrain === "unknown") {
    console.log(`[v8] Drivetrain still unknown after Batch 1 — defaulting to FWD`);
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
    // Rotor thickness. A minimum that is still non-null here passed the label
    // cross-check in sanityChecks — anything unlabelled or backed by a nominal
    // label was nulled there — so surviving to this point IS what "sourced"
    // means. Nominal is written to its own column and never promoted.
    // A value that survived only WITH a sanity flag (delta-implausible,
    // front-below-rear) is stamped "oem_spec_flagged": classify() grades it
    // like an estimate (warn-capped), never as a clean spec.
    rotor_front_min_thickness_mm: asNumber(fields.rotor_front_min_thickness_mm?.value),
    rotor_rear_min_thickness_mm: asNumber(fields.rotor_rear_min_thickness_mm?.value),
    rotor_front_nominal_thickness_mm: asNumber(fields.rotor_front_nominal_thickness_mm?.value),
    rotor_rear_nominal_thickness_mm: asNumber(fields.rotor_rear_nominal_thickness_mm?.value),
    rotor_front_min_quality:
      fields.rotor_front_min_thickness_mm?.value != null
        ? (fields.rotor_front_min_thickness_mm?.flagged ? "oem_spec_flagged" : "oem_spec")
        : undefined,
    rotor_rear_min_quality:
      fields.rotor_rear_min_thickness_mm?.value != null
        ? (fields.rotor_rear_min_thickness_mm?.flagged ? "oem_spec_flagged" : "oem_spec")
        : undefined,
    rotor_min_source_url:
      fields.rotor_front_min_thickness_mm?.source_url ??
      fields.rotor_rear_min_thickness_mm?.source_url ??
      undefined,
    // Per-axle labels (the shared column let a front label vouch for a rear
    // value); the legacy column still receives front-first for old readers.
    rotor_front_min_observed_label:
      asString(fields.rotor_front_min_observed_label?.value) ?? undefined,
    rotor_rear_min_observed_label:
      asString(fields.rotor_rear_min_observed_label?.value) ?? undefined,
    rotor_min_observed_label:
      asString(fields.rotor_front_min_observed_label?.value) ??
      asString(fields.rotor_rear_min_observed_label?.value) ??
      undefined,
    // A sanity REJECT this run invalidates the stored value too — without the
    // explicit clear, a pre-gate-era diameter-as-thickness survives every
    // re-run (nulled value → undefined → undefined-skip).
    clear_fields: (() => {
      const clears: string[] = [];
      if (fields.rotor_front_min_thickness_mm?.rejected) {
        clears.push(
          "rotor_front_min_thickness_mm",
          "rotor_front_min_quality",
          "rotor_front_min_observed_label",
        );
      }
      if (fields.rotor_rear_min_thickness_mm?.rejected) {
        clears.push(
          "rotor_rear_min_thickness_mm",
          "rotor_rear_min_quality",
          "rotor_rear_min_observed_label",
        );
      }
      return clears.length ? clears : undefined;
    })(),
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
      // A front set has TWO blades and they usually differ (26"/18"). The old
      // bare parseFloat kept only the first number, which is why
      // wiper_blade_passenger_size_in was 0%-filled while the driver column
      // was 100%. When only one size is known we write the driver and leave
      // passenger NULL — never a driver→passenger copy.
      const frontWipers = parseFrontWiperSizes(asString(fields.front_wiper_size?.value));
      const frontWiper = frontWipers.driver;
      const rearWiper  = parseFloat(asString(fields.rear_wiper_size?.value)  ?? "") || undefined;
      const steeringType = psType === "electric" ? "electric"
        : psType ? "hydraulic"
        : undefined;
      const parkingBrake = asString(fields.parking_brake_type?.value) ?? undefined;

      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertChassisSpecs, {
        chassis_code: chassisCfg.chassis_code,
        ...(asNumber(fields.lug_nut_torque_ft_lbs?.value) !== undefined ? { lug_nut_torque_ft_lbs: asNumber(fields.lug_nut_torque_ft_lbs?.value) } : {}),
        ...(frontWiper ? { wiper_blade_driver_size_in: frontWiper } : {}),
        ...(frontWipers.passenger ? { wiper_blade_passenger_size_in: frontWipers.passenger } : {}),
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
    const val = rawStr != null ? sanitizePart(rawStr) : null;

    console.log(`[v8-parts] ${fieldKey}: raw=${rawVal} (type=${typeof rawVal}), sanitized=${val}, confidence=${conf}, source=${src}`);

    if (val == null || val.length === 0) {
      const skipReason = rawStr ? "failed_sanitization" : "null_or_empty";
      console.log(`[v8-parts] SKIPPED ${fieldKey}: reason=${skipReason}`);
      if (rawStr) {
        // A rejected part number must NOT stay "filled" in the field map —
        // that made the loss invisible: no field_gap entry, and batch-2
        // gap-fill never re-asked because the field looked populated, while
        // no fitment existed (how VAG fluids stayed missing across runs).
        // Null+flag → batch-1 callers re-ask it in batch 2; finalize ledgers
        // it as validation_dropped.
        fields[fieldKey] = {
          ...(fields[fieldKey] ?? {}),
          value: null,
          flagged: true,
          flag_reason: `oem_part_rejected: ${rawStr}`,
        } as any;
      }
      continue;
    }

    let qty = 1;
    if (meta.subcategory === "spark_plug") {
      qty = asNumber(fields.spark_plug_quantity?.value) ?? 1;
    } else if (meta.subcategory === "front_rotor" || meta.subcategory === "rear_rotor") {
      qty = 2;
    }

    console.log(`[v8-parts] Writing part: ${val} as ${meta.subcategory} for service ${meta.serviceSlug ?? meta.subcategory}`);

    // Round 12: component-identity evidence — deterministic JSON-LD listing
    // title first, the extraction's verbatim observed_title echo second.
    const observedTitle =
      jsonLdTitlesByOem?.get(normalizeOemNumber(val)) ??
      fields[fieldKey]?.observed_title ??
      undefined;

    const writeRes: any = await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartAndFitment, {
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
      build_source_make: partSanitizeBrand ?? undefined,
      observed_title: observedTitle,
    });
    // Round 12: a role-identity rejection must not leave the field "filled" —
    // null + flag re-enters it into Batch-2 gap-fill (same self-healing path
    // as oem_part_rejected above; the re-ask finds the REAL component, never a
    // silent substitution). Finalize scans this flag prefix into run_errors.
    if (writeRes?.rejected === "role_identity") {
      fields[fieldKey] = {
        ...(fields[fieldKey] ?? {}),
        value: null,
        flagged: true,
        flag_reason: `role_identity_rejected: ${val} ("${observedTitle ?? meta.name}")`,
      } as any;
    }
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
        const val = sanitizePart(rawStr);
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

        const pkgWriteRes: any = await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartAndFitment, {
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
          build_source_make: partSanitizeBrand ?? undefined,
          observed_title:
            jsonLdTitlesByOem?.get(normalizeOemNumber(val)) ??
            pkgFields[fieldKey]?.observed_title ??
            undefined,
        });
        if (pkgWriteRes?.rejected === "role_identity") {
          // Package fields have no gap-fill re-ask loop — log the honest gap.
          console.log(`[v8-packages] role-identity REJECTED ${packageCode}/${fieldKey}: ${val}`);
        }
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

    // Round 9 (batch-11): "scheduled" is a claim that this cadence is the OEM
    // maintenance schedule — it was stamped unconditionally, so wear estimates
    // (pads 50k), inspection guidance, and training-data cadences all read as
    // OEM schedule (RAV4 shipped 10k oil at 0.95 when the 2012 guide says 5k).
    // Reserve "scheduled" for values the extractor tied to a scraped source;
    // wear items and model-declared inspect/conditional cadences are
    // "estimated" (the round-8 honesty status the UI already badges).
    const llmStatus = asString(fields[`${prefix}_status`]?.value);
    if (llmStatus === "not_applicable") continue;
    const hasScrapedSource =
      fields[`${prefix}_miles`]?.source_type === "scraped" ||
      fields[`${prefix}_months`]?.source_type === "scraped";
    const status =
      !(milesVal || monthsVal)
        ? "on_demand"
        : WEAR_ITEM_SERVICE_SLUGS.has(slug) ||
            llmStatus === "inspect_only" ||
            llmStatus === "conditional_severe" ||
            !hasScrapedSource
          ? "estimated"
          : "scheduled";

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertServiceInterval, {
      vehicle_config_id: vehicleConfigId,
      service_id: serviceId,
      interval_miles: milesVal,
      interval_months: monthsVal,
      status,
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
    const entityType = getEntityType(k);
    // Key engine/transmission evidence by the actual entity doc id — rows were
    // previously all keyed by vehicleConfigId, so provenance lookups by engine
    // id (the key the capacity resolver writes under) returned nothing.
    // drivetrain_config/part/interval rows have no doc id at this point and
    // stay keyed by config (known limitation).
    const entityId =
      entityType === "engine"
        ? String(engineId)
        : entityType === "transmission"
          ? String(transmissionId ?? vehicleConfigId)
          : String(vehicleConfigId);
    evidenceRows.push({
      entity_type: entityType,
      entity_id: entityId,
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
  handler: async (ctx, args): Promise<EnrichVehicleBatchV3Result> => {
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
        const stuckBypass = runAge >= STUCK_MS;
        let bypassInProgress = stuckBypass;
        const LIVE_RUN_STATUSES = new Set(["started", "scraping", "batch1", "batch2"]);

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

        // The >4h age bypass re-enriches WITHOUT marking the old run failed
        // (only the force path did) — the orphaned chain kept polling and
        // could finalize over this successor. Mirror the force path; the
        // poll-body fence is the second lock.
        if (stuckBypass) {
          const latestRun = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
            { vehicleConfigId: existingConfig._id },
          );
          if (latestRun && LIVE_RUN_STATUSES.has(latestRun.status)) {
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
              run_id: latestRun._id,
              status: "failed",
              errors: ["superseded_by_stuck_bypass"],
              completed_at: Date.now(),
            });
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
    // Adopt a verified replacement code: rebuild the key, thread it through
    // the scheduler chain (poll bodies rebuild `vehicle` from args.engineCode
    // — batch-2 audit: Soul verified "U" yet completed as "2l_4cyl"), and
    // check whether a complete config already exists under the resolved key.
    const adoptVerifiedEngineCode = async (code: string) => {
      vehicle.engineCode = code;
      configKey = buildEngineKey(vehicle);
      resolvedEngineCodeForPersist = code;
      (args as any).engineCode = code;
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
        return resolvedConfig._id;
      }
      return null;
    };

    if (isNhtsaDescriptor(args.engineCode)) {
      console.log(`[v8] Engine code "${args.engineCode}" is a placeholder — resolving real OEM code`);
      const resolved = await resolveEngineCode(
        args.year, args.make, args.model, args.trim,
        args.displacement, vPicData?.cylinders ?? 4,
        vPicData?.fuel_type ?? "Gasoline", args.engineCode,
      );
      if (resolved.source === "verified" && !isNhtsaDescriptor(resolved.engineCode)) {
        console.log(`[v8] Engine code resolved+verified: "${args.engineCode}" → "${resolved.engineCode}"`);
        const cacheHitId = await adoptVerifiedEngineCode(resolved.engineCode);
        if (cacheHitId) return { status: "cache_hit" as const, configId: cacheHitId };
      } else if (resolved.source === "unverified") {
        // 5-VIN test (Jul 2026): unverified codes were how CZDA/ERG/G4FJ
        // poisoned config keys and extraction prompts. Keep the displacement
        // placeholder — it is honest and still unique enough to key on.
        console.warn(`[v8] Engine code candidate "${resolved.engineCode}" failed verification — keeping placeholder "${args.engineCode}"`);
      } else if (resolved.source === "unknown") {
        console.log(`[v8] Engine code resolution returned unknown — keeping placeholder "${args.engineCode}"`);
      }
    } else if (args.engineCode && args.engineCode.replace(/[^a-zA-Z0-9]/g, "").length <= 4) {
      // Round 10 (batch-11 Equinox): a SHORT decoder code (GM RPO shape —
      // "LSD", "LYX", "LFX") passed straight into the config key with zero
      // verification, and vPIC itself can return the WRONG YEAR's RPO (2025
      // "LSD" on a 2024 VIN), anchoring next-generation content.
      // Round 11: the deterministic RPO×year table decides first — wave-3
      // proved adversarial search cannot refute a code that is genuinely
      // valid one model year later on the same nameplate. Table-invalid →
      // straight to re-resolution; table-valid → trusted (no LLM call);
      // unknown codes keep the round-10 adversarial check.
      const codeYear = validateEngineCodeYear(args.engineCode, args.year);
      let verdict: "confirmed" | "refuted" | "uncertain";
      if (codeYear.known) {
        verdict = codeYear.ok ? "confirmed" : "refuted";
        if (!codeYear.ok) {
          console.warn(`[v8] RPO-YEAR GATE — ${(codeYear as any).reason}`);
        }
      } else {
        verdict = await verifyEngineCode(
          args.engineCode, args.year, args.make, args.model, args.trim,
          args.displacement, vPicData?.cylinders ?? 4,
        );
      }
      if (verdict === "refuted") {
        console.warn(`[v8] Short engine code "${args.engineCode}" REFUTED for MY${args.year} — re-resolving`);
        const resolved = await resolveEngineCode(
          args.year, args.make, args.model, args.trim,
          args.displacement, vPicData?.cylinders ?? 4,
          vPicData?.fuel_type ?? "Gasoline", args.engineCode,
          { forceResolve: true },
        );
        if (resolved.source === "verified" && !isNhtsaDescriptor(resolved.engineCode)) {
          console.log(`[v8] Engine code corrected: "${args.engineCode}" → "${resolved.engineCode}"`);
          const cacheHitId = await adoptVerifiedEngineCode(resolved.engineCode);
          if (cacheHitId) return { status: "cache_hit" as const, configId: cacheHitId };
        } else {
          console.warn(`[v8] Refuted code "${args.engineCode}" could not be replaced with a verified one — keeping (visible in logs only)`);
        }
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
    const decodeStartedAt = Date.now();
    const vdbRaw = vehicleDoc.vin ? await advancedVinDecode(vehicleDoc.vin) : null;
    const vdbFields = vdbRaw ? extractVDBFields(vdbRaw) : null;
    const decodeEndedAt = Date.now();

    // Identity gap-fill: the applicability rules fail OPEN when drivetrain /
    // transmission_type / body_class are null (2001 740iA: no rule fired on a
    // RWD sedan and 9 impossible fields ended as llm_null gaps). Fill nulls
    // from the VDB decode and the trim string before vPicData flows anywhere.
    {
      const trimDerived = deriveIdentityFromTrim(args.trim);
      vPicData = mergeIdentity(vPicData, vdbFields, trimDerived);
      console.log(
        `[v8] Identity after merge: drivetrain=${vPicData.drivetrain}, transmission=${vPicData.transmission_type}, body=${vPicData.body_class}`,
      );
    }

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
    // The real drivetrain value comes from the Batch-1 LLM extraction (the
    // attributes block of Batch 1A). Use "unknown" as placeholder.
    // Priority: args.drivetrain (from processVin) > vPicData (from getIdentity) > "unknown"
    const nhtsDrivetrain = args.drivetrain ?? vPicData?.drivetrain ?? null;
    const drivetrainVal = nhtsDrivetrain ?? "unknown";
    if (nhtsDrivetrain) {
      console.log(`[v8] Drivetrain from decode: ${nhtsDrivetrain}`);
    } else {
      console.log(`[v8] Drivetrain unknown — deferring to Batch 1`);
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

    // Attach the vehicle to the config being enriched NOW — not only at finalize.
    // Finalize (below) also attaches, but that's the very END of a 20-40min run.
    // When a re-enrichment's decode CHANGES the config_key — e.g. a variant
    // correction "Impreza WRX" → "Impreza Outback", or a resolved engine code —
    // the new config differs from the vehicle's old (possibly purged) one, and
    // the vehicle otherwise keeps pointing at the stale config for the entire
    // run (invisible/wrong by VIN), and forever if the run stalls before
    // finalize. Attaching here makes the VIN reflect the live config from the
    // start; the finalize attach is idempotent.
    await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
      { vehicle_id: args.vehicleId, vehicle_config_id: vehicleConfigId },
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

    // Trace: decode stage. Runs before the run row exists (NHTSA vPic decode is
    // passed in; VDB advancedVinDecode above), so it's timed via locals and
    // recorded now that runId is known.
    await traceStep(ctx, {
      run_id: runId,
      vehicle_config_id: vehicleConfigId,
      step: "decode",
      seq: 1,
      status: "ok",
      started_at: decodeStartedAt,
      ended_at: decodeEndedAt,
      summary: `drivetrain=${vPicData?.drivetrain ?? "?"} · transmission=${vPicData?.transmission_type ?? "?"} · body=${vPicData?.body_class ?? "?"}`,
      response_text: JSON.stringify({ nhtsa_merged_identity: vPicData, vdb_fields: vdbFields }, null, 2),
    });

    // STEP 6: Upsert drivetrain_config — only if we have a REAL value from NHTSA.
    // If drivetrain is unknown, skip this. _pollBatch1V3 will create it after
    // Batch 1 resolves the drivetrain (the Batch-1A attributes block).
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

      // Round 10 (batch-11 Tucson): validate the returned code against the
      // model year BEFORE storing — launch-overlap years get the next
      // generation's code from web search ("NX4" on a 2021 TL Tucson), and a
      // wrong stored chassis poisons year-band refutes + sibling cloning.
      // Deterministic table, fail-open on unknown nameplates/codes.
      if (chassisResult.chassisCode) {
        const genVerdict = validateChassisCodeYear(
          args.make, args.model, chassisResult.chassisCode, args.year,
        );
        if (!genVerdict.ok) {
          console.warn(
            `[v8] CHASSIS-YEAR GATE — rejected "${chassisResult.chassisCode}": ${genVerdict.reason}` +
              (genVerdict.expectedForYear ? ` — substituting ${genVerdict.expectedForYear}` : " — leaving chassis null"),
          );
          chassisResult.chassisCode = genVerdict.expectedForYear;
        }
      }

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
    const scrapeStartedAt = Date.now();
    // `vehicle` is built before the decode runs, so fold in the drivetrain we
    // resolved at STEP 4 — the manual scrape needs it to pick between
    // drivetrain-qualified source variants (see scrapeManual → LEMON).
    const sources = await scrapeVehicleSources(ctx, { ...vehicle, drivetrain: nhtsDrivetrain });
    const scrapeEndedAt = Date.now();

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

    // Trace: scrape stage (covers VDB-repair fetch, chassis/engine sibling
    // merges, and the FireCrawl source scrape).
    await traceStep(ctx, {
      run_id: runId,
      vehicle_config_id: vehicleConfigId,
      step: "scrape",
      seq: 2,
      status: "ok",
      started_at: scrapeStartedAt,
      ended_at: scrapeEndedAt,
      summary: `${sources.partsSourceUrls.length + sources.manualSourceUrls.length} sources · ${sources.supersessions.length} supersessions · ${vdbRepairRaw?.blocks.length ?? 0} VDB repair blocks`,
      response_text: JSON.stringify(
        {
          parts_source_urls: sources.partsSourceUrls,
          manual_source_urls: sources.manualSourceUrls,
          supersessions: sources.supersessions,
        },
        null,
        2,
      ),
    });

    // STEP 8: Submit Batch [1A, 1B]
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
      run_id: runId,
      status: "batch1",
    });

    // Audit F18: block-list = hardcoded BLOCKED_DOMAINS + blocked_domains table.
    const runtimeBlockedDomains = await loadRuntimeBlockedDomains(ctx);

    const batch1Requests: BatchRequest[] = [
      {
        customId: "batch1a",
        system: BATCH_1_SYSTEM,
        userPrompt: buildBatch1Prompt(vehicle, vPicData, sources.partsMarkdown, sources.manualMarkdown, detectedPackages),
        maxTokens: 8192,
        temperature: 0,
        maxSearchUses: 0,
        outputSchema: buildBatch1aArraySchema(detectedPackages.map((p) => p.code)),
      },
      {
        customId: "batch1b",
        system: BATCH_1B_SYSTEM,
        userPrompt: buildBatch1bPrompt(vehicle),
        maxTokens: 16384,
        temperature: 0,
        // 8, raised from 1 (Aug 2026). The prompt asks ~15-20 spec fields at
        // "1-2 searches per field"; the 1-search budget was latent for months
        // because batchClient silently dropped max_uses (the request searched
        // 37 times unbounded and worked). Once the cap was actually enforced,
        // a 1-search batch1b hit the refusal loop after its single search and
        // the server ended the turn with stop_reason=pause_turn — no final
        // JSON, every spec field lost (observed on BOTH web_search tool
        // versions, runs 2-3 of the GLC-43 verification).
        maxSearchUses: 8,
        blockedDomains: runtimeBlockedDomains,
        outputSchema: buildBatch1bArraySchema(),
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
        outputSchema: buildVdbMappingOutputSchema(),
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

    // Trace: batch 1 request (response is patched onto this same row in
    // _pollBatch1V3 once the batch results return).
    await traceStep(ctx, {
      run_id: runId,
      vehicle_config_id: vehicleConfigId,
      step: "batch1",
      seq: 3,
      status: "submitted",
      started_at: Date.now(),
      summary: `batchId=${batchId} · ${batch1Requests.length} requests`,
      request_text: JSON.stringify(
        batch1Requests.map((r) => ({
          customId: r.customId,
          model: r.model ?? "sonnet",
          maxTokens: r.maxTokens,
          maxSearchUses: r.maxSearchUses,
          system: r.system,
          userPrompt: r.userPrompt,
        })),
        null,
        2,
      ),
    });

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
  handler: async (ctx, args): Promise<void> => {
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

    // Write fence: abort silently if this chain's run was purged, marked
    // terminal (force-unstick/reaper), or superseded by a newer run.
    if (await chainFenced(ctx, args, false, "pollBatch1")) return;

    // A transient API error on a status poll must not kill a paid batch run —
    // treat it as "not ended" and let the bounded retry loop continue.
    let status: string | null = null;
    try {
      status = await getBatchStatus(args.batchId);
    } catch (e) {
      console.warn(`[v8/_pollBatch1] getBatchStatus failed (attempt ${attempt}) — treating as not-ended:`, e);
    }
    if (status !== "ended") {
      if (attempt >= MAX_POLL_ATTEMPTS_TOTAL) {
        // ~24h: the batch should have ended or expired by now. Fail the run
        // loudly (config back to retryable "pending"); this branch should be
        // near-unreachable since Anthropic force-resolves batches at 24h.
        console.error(`[v8/_pollBatch1] Batch not ended after ~24h (${attempt} attempts) — failing run`);
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.failEnrichmentRun, {
          run_id: args.runId,
          vehicle_config_id: args.vehicleConfigId,
          run_status: "failed",
          errors: ["batch1_timeout_24h"],
          config_status: "pending",
        });
        return;
      }
      if (attempt === MAX_POLL_ATTEMPTS) {
        console.warn(`[v8/_pollBatch1] Batch still queued after ${attempt} fast polls (~3h) — switching to 10-min slow poll (paid batch, will collect when it ends)`);
      }
      await ctx.scheduler.runAfter(
        attempt >= MAX_POLL_ATTEMPTS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
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

    // Trace: batch 1 response — patch the row opened at submit. Recorded before
    // the error early-returns below so a failed batch still leaves a trace.
    await traceStep(ctx, {
      run_id: args.runId,
      vehicle_config_id: args.vehicleConfigId,
      step: "batch1",
      seq: 3,
      status: r1a?.error ? "error" : "ok",
      ended_at: Date.now(),
      tokens_in: (r1a?.usage.tokensIn ?? 0) + (r1b?.usage.tokensIn ?? 0) + (r1c?.usage.tokensIn ?? 0),
      tokens_out: (r1a?.usage.tokensOut ?? 0) + (r1b?.usage.tokensOut ?? 0) + (r1c?.usage.tokensOut ?? 0),
      web_searches: (r1a?.usage.webSearches ?? 0) + (r1b?.usage.webSearches ?? 0) + (r1c?.usage.webSearches ?? 0),
      response_text: JSON.stringify(results, null, 2),
    });

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
        // Round 11 (batch-11 wave-3 Accord): VDB ships fixed mileage
        // schedules; on Maintenance-Minder makes those are dealer-convention
        // cadences, not the OEM system — they overwrote correct MM-derived
        // semantics at conf 0.9 (oil 10k above the 5-9k MM band, brake fluid
        // regaining a mileage on a months-only service). On MM makes, ingest
        // as low-confidence "estimated" so extraction-derived rows win.
        const MAINTENANCE_MINDER_MAKES = new Set(["honda", "acura"]);
        const isMmMake = MAINTENANCE_MINDER_MAKES.has(args.make.toLowerCase());
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
            status: isMmMake ? "estimated" : "active",
            confidence: isMmMake ? 0.6 : 0.9,
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

    const fields1a = parseBatch1a(normalizeBatchShape(r1a.data, "1a"));
    const fields1b = r1b && !r1b.error ? parseBatch1b(normalizeBatchShape(r1b.data, "1b")) : {};
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
    // Round 8: deterministic EPS suppression — a known electric-PS platform
    // extracted as "hydraulic" shipped a phantom PS-fluid capacity + a
    // scheduled (unperformable) PS flush on the batch-10 Cobalt.
    if (applyEpsSuppression(fields, args.make, args.model, args.year)) {
      console.log(`[v8/_pollBatch1] known EPS platform — power_steering_type forced electric, PS fluid fields suppressed`);
    }

    const filledCount = V4_FIELD_KEYS.filter((k) => fields[k]?.value != null).length;
    console.log(`[v8/_pollBatch1] ${filledCount}/${V4_FIELD_KEYS.length} fields after merge+applicability`);

    // Sanity checks BEFORE the first write. Previously only the batch-2
    // finalize ran these, but this write already persists batch-1 values and
    // the merge-semantics mutations skip undefined — so a value rejected at
    // finalize (nulled) could never un-write what batch-1 stored (the 16.9 qt
    // coolant survival vector). Rejecting here also puts the field back in the
    // batch-2 gap-fill set, giving the pipeline a second chance at a clean
    // value. Finalize re-runs the checks over the merged map as before.
    // Round 10 (batch-11 SRX, 2nd recurrence): the flex-fuel gate reads
    // fields["fuel_type"], but fuel_type is not an extraction key — the
    // decoded fuel lives on the engines row and never entered the map, so
    // the gate was dead on every config. Inject the decoded value (same
    // fallback applicabilityRules already uses) so the gate can see it.
    if (!fields.fuel_type && vPicData?.fuel_type) {
      fields.fuel_type = {
        value: vPicData.fuel_type,
        source_url: null,
        source_type: "nhtsa",
        confidence: 0.9,
        flagged: false,
        flag_reason: null,
      };
    }
    const batch1SanityFlags = runSanityChecks(fields, vPicData?.cylinders ?? 4, {
      gvwrLbs: vPicData?.gvwr_lbs ?? null,
    });
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
      // P2.5: for a badge-engineered car, also accept the builder's OEM numbers
      // (the source-redirected scrape pulls Mazda parts for a Toyota Yaris).
      resolveScrapeRedirect({ make: args.make, model: args.model, model_year: args.year })?.make ?? null,
      // Round 12: deterministic JSON-LD listing titles for the role-identity gate.
      await loadJsonLdTitlesByOem(ctx, { make: args.make, model: args.model, year: args.year, trim: args.trim }),
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
      // Quotability isn't computed on the parts-only path — reuse the latest
      // full run's persisted snapshot so a parts refresh can't silently flip
      // an unquotable config to complete on fill alone.
      let priorQuotabilityPct: number | null = null;
      let priorHadPriceGaps = false;
      try {
        const latestRun = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
          { vehicleConfigId: args.vehicleConfigId },
        );
        priorQuotabilityPct = (latestRun as any)?.quotability?.pct ?? null;
        priorHadPriceGaps = ((latestRun as any)?.field_gaps ?? []).some(
          (g: any) => typeof g?.field === "string" && g.field.startsWith("part_price:"),
        );
      } catch (e) {
        console.warn("[v8/_pollBatch1] prior quotability read failed (non-fatal):", e);
      }
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchVehicleConfig, {
        vehicle_config_id: args.vehicleConfigId,
        enrichment_status: computeEnrichmentStatus({
          fillRate: partsFillRate,
          quotabilityPct: priorQuotabilityPct,
          hasPriceGaps: priorHadPriceGaps,
        }),
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

    // Search budget scaled to the workload. The old `1 + numericSpecGaps`
    // (cap 5) formula predates max_uses actually being SENT (batchClient
    // dropped it, so the model searched unbounded — 48 searches on a "1
    // search" budget — and the oversized turn ended without its final JSON:
    // the fleet-wide batch-2 `json_extraction_empty` of Aug 2026). Now that
    // the cap is enforced, 1-5 searches for ~60 gap fields would starve the
    // gap fill instead. ~1 search per 8 fields with a floor of 6 keeps small
    // gap lists cheap and gives a full 59-field re-fill enough road; 14 caps
    // cost AND keeps the turn short enough to finish with a JSON block.
    const batch2SearchUses = Math.min(6 + Math.ceil(nullFields.length / 8), 14);

    const batch2UserPrompt = buildBatch2Prompt(vehicle, nullFields, oemParts);
    // Audit F18: block-list = hardcoded BLOCKED_DOMAINS + blocked_domains table.
    const batch2BlockedDomains = await loadRuntimeBlockedDomains(ctx);
    let batch2Id: string;
    try {
      batch2Id = await submitBatch([
        {
          customId: "batch2",
          system: BATCH_2_SYSTEM,
          userPrompt: batch2UserPrompt,
          maxTokens: 16384,
          temperature: 0,
          maxSearchUses: batch2SearchUses,
          blockedDomains: batch2BlockedDomains,
          outputSchema: buildBatch2ArraySchema(nullFields),
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

    // Trace: batch 2 request (response patched onto this row in _pollBatch2V3).
    await traceStep(ctx, {
      run_id: args.runId,
      vehicle_config_id: args.vehicleConfigId,
      step: "batch2",
      seq: 4,
      status: "submitted",
      started_at: Date.now(),
      summary: `batchId=${batch2Id} · ${nullFields.length} gap fields · ${batch2SearchUses} searches`,
      request_text: JSON.stringify(
        { customId: "batch2", system: BATCH_2_SYSTEM, userPrompt: batch2UserPrompt },
        null,
        2,
      ),
    });

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

    // Wave 3 (Aug 2026): catalog-attested-first BRAKES. Rotors/pads were the
    // most cross-generation-contaminated class when born from LLM extraction
    // (wrong on all 3 vehicles that had them in the batch-3 audit) — so
    // harvest the storefront's own vehicle-scoped brake category pages NOW,
    // while Batch 2 polls, in a separate action budget. Roles Batch 1A
    // already filled are skipped inside the action (empty-fill only); the
    // URL itself is the fitment statement, and the usual verifier still
    // cross-examines at finalize. Kill: PARTS_CATEGORY_HARVEST_EARLY=off.
    if (process.env.PARTS_CATEGORY_HARVEST_EARLY !== "off") {
      try {
        await ctx.scheduler.runAfter(
          0,
          internal.vehicleEnrichment.categoryHarvest.harvestVehicleCategories,
          {
            vehicleConfigId: args.vehicleConfigId,
            roleFilter: ["front_brake_pad", "rear_brake_pad", "front_rotor", "rear_rotor"],
          },
        );
      } catch (e) {
        console.warn("[v8] early brake harvest scheduling failed (non-fatal):", e);
      }
    }
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
    // Late-collection mode (batch-2 audit, Jul 2026): after the 3h timeout
    // finalizes with batch-1 data, the PAID batch keeps processing at
    // Anthropic — this flag keeps slow-polling it and applies the gap-fill
    // when it ends instead of orphaning the results (Challenger case).
    lateCollect: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    // Catch-all failure handler (Jun-9 review item 3): batch-1 data is always
    // written by the time this action runs, so any unexpected throw restores
    // the config to 'partial' instead of leaving it stuck 'enriching'.
    try {
      return await runPollBatch2Body(ctx, args);
    } catch (e) {
      if (args.lateCollect) {
        // The run already finalized at the 3h timeout — a late-collection
        // failure must not re-mark it failed; the config's terminal state
        // stands and only the bonus gap-fill is lost.
        console.error(`[v8/_pollBatch2] late-collection failure (non-fatal, config already finalized):`, e);
        return;
      }
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

    // Convex hard-kills an action at 600s — un-catchable, so the run gets
    // stuck at status "batch2" (observed live 2026-07-10: capacity
    // corroboration + a 24-part discovery budget pushed finalize past the
    // limit; one 408-hanging PDF extraction alone ate ~3 min). Past this
    // deadline no NEW Firecrawl price work is started; skipped parts land in
    // the gap ledger and the nightly backfill picks them up. 360s leaves room
    // for a worst-case ~3 min in-flight extraction plus the finalize writes.
    const actionStartedAt = Date.now();
    const priceWorkDeadline =
      actionStartedAt + Number(process.env.PARTS_PRICE_PASS_DEADLINE_MS ?? "360000");

    // Liveness heartbeat for the STEP 0 force-unstick probe.
    try {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: args.runId,
        last_heartbeat_at: Date.now(),
      });
    } catch (e) {
      console.warn(`[v8/_pollBatch2] heartbeat stamp failed (non-fatal):`, e);
    }

    // Write fence: abort silently if this chain's run was purged, marked
    // terminal, or superseded. lateCollect runs are legitimately "timeout" —
    // they abort only on failed/purged/newer-run (runFence semantics).
    if (await chainFenced(ctx, args, args.lateCollect === true, "pollBatch2")) return;

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
    // record the run as 'timeout'. NEW (batch-2 audit, Jul 2026): the paid
    // batch keeps processing at Anthropic, so the timeout ALSO arms a
    // late-collection chain that slow-polls to ~24h and applies the gap-fill
    // through this same body when the batch finally ends (Challenger case:
    // finalized thin at 3h while its batch completed into the void).
    let timedOut = false;
    if (status !== "ended") {
      if (args.lateCollect) {
        if (attempt >= MAX_POLL_ATTEMPTS_TOTAL) {
          console.error("[v8/_pollBatch2] Late collection: batch never ended by ~24h — giving up (config already finalized)");
          return;
        }
        await ctx.scheduler.runAfter(
          SLOW_POLL_INTERVAL_MS,
          internal.vehicleEnrichment.v3pipeline._pollBatch2V3,
          { ...args, attempt: attempt + 1 },
        );
        return;
      }
      if (attempt >= MAX_POLL_ATTEMPTS) {
        console.error("[v8/_pollBatch2] Timed out — finalizing with batch-1 data only; arming late collector for the paid batch");
        timedOut = true;
        try {
          await ctx.scheduler.runAfter(
            SLOW_POLL_INTERVAL_MS,
            internal.vehicleEnrichment.v3pipeline._pollBatch2V3,
            { ...args, attempt: attempt + 1, lateCollect: true },
          );
        } catch (e) {
          console.warn("[v8/_pollBatch2] failed to arm late collector (non-fatal):", e);
        }
      } else {
        await ctx.scheduler.runAfter(
          POLL_INTERVAL_MS,
          internal.vehicleEnrichment.v3pipeline._pollBatch2V3,
          { ...args, attempt: attempt + 1 },
        );
        return;
      }
    } else if (args.lateCollect) {
      console.log("[v8/_pollBatch2] Late collection: paid batch ended — applying gap-fill to the finalized config");
    }

    const results = timedOut ? {} : await getBatchResults(args.batchId);
    const r2 = results["batch2"];

    // Trace: batch 2 response — patch the row opened at submit.
    await traceStep(ctx, {
      run_id: args.runId,
      vehicle_config_id: args.vehicleConfigId,
      step: "batch2",
      seq: 4,
      status: timedOut ? "timeout" : r2?.error ? "error" : "ok",
      ended_at: Date.now(),
      tokens_in: r2?.usage.tokensIn ?? 0,
      tokens_out: r2?.usage.tokensOut ?? 0,
      web_searches: r2?.usage.webSearches ?? 0,
      response_text: timedOut
        ? "(batch 2 timed out — no response collected)"
        : JSON.stringify(results, null, 2),
    });

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
      const parsed = parseBatch2(normalizeBatchShape(r2.data, "2"), args.nullFields);
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

    // ── Services rescue rung (fresh-5 round 2, Aug 2026) ─────────────────
    // On first-contact makes the paid batch-2 turn keeps ending with
    // `services: []` — the raw payloads (CX-30/Sierra/Jeep/Palisade) all show
    // stop_reason=end_turn after 12-13 searches with the final text block
    // empty or fields-only: the model researches, then quits before the
    // services write-out. That single empty array starves SIX consumers at
    // once (pricing writes, labor, quotability ×2, role applicability,
    // repair scope), each of which then limps on its own degraded fallback —
    // the structural DB list fails open on unknown drivetrain, inflating the
    // quotability denominator (CX-30 0.58) while ~25 price/labor V4 fields
    // stay null and drag applicable_fill_rate to batch-1-only levels
    // (Sierra 14%). One synchronous services-ONLY re-ask — no 60-103-field
    // gap list competing for the write-out budget — restores the model-judged
    // set before any consumer runs. Runs whenever batch-2 produced zero
    // applicable services (r2.error, empty payload, or fields-only partial —
    // the Jeep/Palisade shape is deliberately NOT an r2.error, because that
    // would discard the real fields it returned). Not run on timeout
    // (r2 undefined): the late collector applies the paid batch's result.
    // Disable: PARTS_SERVICES_RESCUE=off.
    const batch2RescueErrors: string[] = [];
    if (r2 && process.env.PARTS_SERVICES_RESCUE !== "off") {
      const applicableCount = services.filter((s) => s.is_applicable).length;
      if (applicableCount === 0) {
        try {
          const knownParts: Record<string, string> = {};
          for (const k of Object.keys(PART_FIELD_MAP)) {
            const v = allFields[k]?.value;
            if (typeof v === "string" && v.trim()) knownParts[k] = v.trim();
            if (Object.keys(knownParts).length >= 20) break;
          }
          const rescueVehicle: VehicleInput = {
            vehicleId: args.vehicleId,
            year: args.year, make: args.make, model: args.model,
            trim: args.trim, engineCode: args.engineCode, displacement: args.displacement,
          };
          const rescueRes = await callClaudeWithWebSearch({
            system: SERVICES_RESCUE_SYSTEM,
            userPrompt: buildServicesRescuePrompt(rescueVehicle, knownParts),
            maxSearchUses: 8,
            maxTokens: 8000,
            temperature: 0,
          });
          callLog.push({
            call: "services_rescue",
            tokensIn: rescueRes.usage.tokensIn,
            tokensOut: rescueRes.usage.tokensOut,
            webSearches: rescueRes.usage.webSearches,
            durationMs: 0,
          });
          const rescueParsed = parseBatch2(normalizeBatchShape(rescueRes.data, "2"), []);
          const rescuedApplicable = rescueParsed.services.filter((s) => s.is_applicable).length;
          if (rescuedApplicable > 0) {
            services = rescueParsed.services;
            const rescuePricing = mapPricingToFields(services);
            let rescueFilled = 0;
            for (const [k, fv] of Object.entries(rescuePricing)) {
              if (allFields[k]?.value == null) {
                allFields[k] = fv;
                rescueFilled++;
              }
            }
            batch2RescueErrors.push("applicable_services_rescue_used");
            console.log(
              `[v8/services-rescue] batch-2 services empty — rescue returned ` +
                `${services.length} rows (${rescuedApplicable} applicable), filled ${rescueFilled} price/labor fields`,
            );
          } else {
            batch2RescueErrors.push("applicable_services_rescue_failed");
            console.warn(
              `[v8/services-rescue] rescue also returned no applicable services ` +
                `(${rescueParsed.services.length} rows) — structural fallback will apply`,
            );
          }
        } catch (e) {
          batch2RescueErrors.push("applicable_services_rescue_failed");
          console.warn("[v8/services-rescue] rescue pass failed (non-fatal):", e);
        }
      }
    }

    // Batch 3 (gap-fill re-ask): ONE bounded targeted pass over fields STILL
    // null at this point (getNullFields excludes not_applicable — re-asking
    // N/A fields resurrected impossible data, see comment above getNullFields).
    // One synchronous web-search call, capped field count, values flow through
    // the same parseBatch2 → sanity → sanitize gates as Batch-2 gap fills. No
    // loop — a field that survives this stays in the run's field_gaps ledger.
    //
    // Deliberately a SIBLING of the batch-2 success branch, not a child: when
    // batch-2 comes back unparseable (json_extraction_empty — the GLC-43 /
    // round-19 fleet shape) this ranked re-ask is the only part-number rung
    // left in the run, and nesting it under success skipped it exactly when it
    // was needed most. Quotability ranking puts core roles (pads, rotors,
    // battery, coolant, plugs) at the head of the 15-field cap. Not run on
    // timeout (r2 undefined): the paid batch is still processing and the late
    // collector applies the full gap fill when it ends.
    if (r2) {
      if (process.env.PARTS_GAPFILL !== "off") {
        const gapFillMax = Number(process.env.PARTS_GAPFILL_MAX_FIELDS ?? "15");
        // Rank by quotability impact before slicing to the cap — core-role
        // parts without a fallback (battery) must not lose their re-ask slot
        // to cosmetic fields. Field-level identity wins over trim tokens.
        const gfTrimIdentity = deriveIdentityFromTrim(args.trim);
        const stillNull = rankGapFillFields(getNullFields(allFields), {
          drivetrain:
            (allFields.drivetrain?.value as string | null) ?? gfTrimIdentity.drivetrain,
          transmission_type:
            (allFields.transmission_type?.value as string | null) ??
            gfTrimIdentity.transmission_type,
          body_class: gfTrimIdentity.body_class,
        }).slice(0, gapFillMax);
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
            const gfParsed = parseBatch2(normalizeBatchShape(gfRes.data, "2"), stillNull);
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

    // Re-apply applicability with everything we know NOW: Batch 2/3 may have
    // resolved drivetrain/transmission_type that Batch 1 didn't have, and the
    // trim string carries body/transmission tokens the decode lacked (2001
    // 740iA). Then convert residual N/A-by-elimination nulls (chain-engine
    // timing service) so they ledger as not_applicable, not llm_null.
    const finalIdentity = mergeIdentity(
      enginePicData,
      null,
      deriveIdentityFromTrim(args.trim),
    );
    allFields = applyApplicabilityRules(allFields, finalIdentity);
    if (applyEpsSuppression(allFields, args.make, args.model, args.year)) {
      console.log(`[v8] known EPS platform — power_steering_type forced electric, PS fluid fields suppressed (finalize)`);
    }
    allFields = applyFinalizeApplicability(allFields);

    // Round 10: same fuel_type injection as the batch-1 call site — the
    // flex-fuel gate is otherwise blind (fuel lives on engines, not in the
    // extraction map). See batch-11 SRX P1-1.
    if (!allFields.fuel_type && enginePicData?.fuel_type) {
      allFields.fuel_type = {
        value: enginePicData.fuel_type,
        source_url: null,
        source_type: "nhtsa",
        confidence: 0.9,
        flagged: false,
        flag_reason: null,
      };
    }
    const sanityFlags = runSanityChecks(allFields, cylinders, {
      gvwrLbs: enginePicData?.gvwr_lbs ?? null,
    });
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

    // Price-gap ledger — merged into the run's field_gaps at finalize so
    // unpriced parts are VISIBLE (and targetable by the nightly backfill)
    // instead of silently absent. Reasons: price_budget_exhausted /
    // price_no_source / price_unverified_sources / price_no_oem_anchor.
    const priceGaps: Array<{ field: string; reason: string }> = [];

    // Parts-side quotability — computed after pricing (below), persisted on
    // the run so a "complete · 93%" can no longer hide an unquotable service.
    let quotability: QuotabilityResult | undefined;

    // W1.5 (G32/G33): structured provenance for the finalize gates below.
    // writeNormalizedData runs early; the late gates (fitment refute,
    // trans-fluid, fluid-brand, role-identity, rotor resolver, completion
    // gate) then mutate allFields/fitments and used to record their outcomes
    // ONLY as strings in errors[] — unqueryable, because the structured
    // sanity_flags array was snapshotted before they ran. Each late gate now
    // pushes a structured entry here ALONGSIDE its errors[] string
    // (dual-channel during transition); the accumulator is merged into the
    // ONE existing updateEnrichmentRun finalize call — no second write.
    const lateSanityFlags: LateSanityFlag[] = [];

    // Labor outcome, declared OUTSIDE the `if (r2)` branch below so the
    // finalize triggers can see whether the inline labor pass produced anything.
    // Null means the inline pass never ran at all (batch-2 absent → the else
    // branch at the bottom of this block). See the labor follow-up scheduler
    // near the NHTSA/adversarial triggers: labor must not be a child of batch-2
    // success, because OLP + the RepairPal estimate endpoint need only
    // make/model/year/engine — all of which come from batch 1 and the DB.
    let laborOutcome: {
      resolved: boolean;
      written: number;
      failed: string[];
      sources: { olp: number; web: number; repairpalEndpoint: number };
    } | null = null;

    // Structural applicable-service slugs, derived from the DB rather than from
    // the batch-2 LLM payload, resolved at most once per run.
    //
    // Three finalize consumers key off "which services apply to this vehicle"
    // and all three read it from the batch-2 `services[]` array, so an empty or
    // unparseable batch-2 body silently blanks all three at once: quotability
    // computed over zero services (canary: `{pct: 1, services: []}` — a vacuous
    // PASS, the worst possible failure shape for a completion gate), the
    // role-resource pass logging `applicable_services_unknown`, and labor
    // resolution dropping every fetched row.
    //
    // getApplicableServices (via _laborConfigInputs) is the CANONICAL gate —
    // the same one the booking surface and Oto use — and it fails open by
    // returning [] when it cannot evaluate, which callers must treat as
    // "unknown", never as "nothing applies".
    let _dbApplicableSlugs: string[] | null = null;
    const dbApplicableSlugs = async (): Promise<string[]> => {
      if (_dbApplicableSlugs !== null) return _dbApplicableSlugs;
      try {
        const inputs: any = await ctx.runQuery(
          internal.vehicleEnrichment.laborRelabor._laborConfigInputs,
          { vehicleConfigId: args.vehicleConfigId },
        );
        _dbApplicableSlugs = ((inputs?.services ?? []) as Array<{ slug: string }>)
          .map((s) => s.slug)
          .filter((s): s is string => !!s);
      } catch (e) {
        console.warn("[v8] DB applicable-slug resolution failed (non-fatal):", e);
        _dbApplicableSlugs = [];
      }
      return _dbApplicableSlugs;
    };

    // Write sanitized data to normalized tables
    if (r2) {
      // P2.4: field-level sibling inheritance. Placed HERE deliberately —
      // after extraction, batch-2/batch-3 gap-fill, applicability, sanity and
      // the capacity resolver (so every "rejected this run" and
      // "not_applicable" marker already exists and is honoured), and
      // immediately BEFORE writeNormalizedData so an inherited value flows
      // through the normal write path and is persisted, not just counted.
      // Well before the completion gate, which therefore sees the filled map.
      // Applicability is NOT re-run afterwards: an inherited timing_system
      // informs the NEXT run rather than resurrecting parts in this one.
      try {
        const engineForInherit = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getEngine,
          { engineId: args.engineId },
        );
        const configForInherit = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigById,
          { vehicleConfigId: args.vehicleConfigId },
        );
        await applySiblingInheritance(
          ctx,
          {
            vehicleConfigId: args.vehicleConfigId,
            // Union of both human-verification ledgers — engine columns and
            // config columns — so neither can be overwritten by a sibling.
            verifiedFields: [
              ...(((engineForInherit as any)?.verified_fields ?? []) as string[]),
              ...(((configForInherit as any)?.verified_fields ?? []) as string[]),
            ],
          },
          allFields,
          lateSanityFlags,
        );
      } catch (e) {
        console.warn("[v8/sibling-inherit] pass failed (non-fatal):", e);
      }

      const serviceCache = new Map<string, Id<"services">>();
      await writeNormalizedData(
        ctx, allFields,
        args.vehicleConfigId, args.engineId, args.transmissionId,
        args.makeId, args.runId, args.make, serviceCache,
        undefined, // wheelSizeOptions
        undefined, // wheelSizeSource
        undefined, // packageParts
        "full",    // writeScope
        // P2.5: accept the builder's OEM numbers on a badge-engineered car.
        resolveScrapeRedirect({ make: args.make, model: args.model, model_year: args.year })?.make ?? null,
        // Round 12: deterministic JSON-LD listing titles for the role-identity gate.
        await loadJsonLdTitlesByOem(ctx, { make: args.make, model: args.model, year: args.year, trim: args.trim }),
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
      // URL-less parts are QUEUED here across all services (not discovered
      // inline) so the budget above is spent by priority — core parts on
      // otherwise-unpriced services first — instead of by fitment iteration
      // order (which starved the battery/rear pads on the Jul 2026 A4 run).
      const discoveryQueue: DiscoveryQueueItem[] = [];
      const pricedPartsByService = new Map<string, number>();
      const bumpPriced = (slug: string) =>
        pricedPartsByService.set(slug, (pricedPartsByService.get(slug) ?? 0) + 1);

      // ── Multi-source labor (ONCE per car). The `laborAllSources` orchestrator
      //    fans out to OLP + Estimator + open-web (each flag-gated), merges the
      //    per-source hours into weighted `labor_observations`, and recomputes the
      //    weighted-median labor_times row — all internally. It REPLACES the old
      //    OLP-only resolution + write loop. The LLM book-time loop below (llm_web
      //    / llm_training) is a SEPARATE source the orchestrator does NOT handle,
      //    so it stays. Flags: OLP on-by-default; Estimator/web opt-in (read from
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
      // APPLICABLE MAPPED service gets resolved (OLP + Estimator + web) regardless
      // of whether the LLM provided labor_hours (Phase-2 parity with the backfill
      // in laborRelabor.ts). The orchestrator does the observation writes + recompute
      // internally; olp_labor lands at weight 0.7 here (the multi-source SOURCE_WEIGHTS
      // recalibration), NOT the single-source 0.8 of olpRelabor.ts. Replaces the old
      // OLP-only resolution + write loop.
      const laborServices: Array<{
        slug: string;
        serviceId: Id<"services">;
        name: string;
        estimator_slug: string | null;
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
          estimator_slug: LABOR_SERVICE_CONFIG[slug]?.estimator_slug ?? null,
        });
      }

      // ── Empty-services fallback (2020 Yaris canary, Jul 30 2026) ──────────
      // `services` comes from the batch-2 LLM payload and is [] whenever that
      // payload fails to parse. The old code then called laborAllSources with
      // `services: []`, which makes the orchestrator's write loop drop EVERY
      // fetched row (`if (!serviceId) continue;`, laborResearch.ts) — OLP and
      // RepairPal were paid for over the network and their hours thrown away,
      // silently. The seeder then stamped all 27 rows `default_fallback`.
      //
      // The labor source list must not depend on LLM output at all: it is a
      // structural property of the vehicle. `_laborConfigInputs` already
      // computes it correctly from the `services` table gated by the CANONICAL
      // getApplicableServices helper (the same gate the booking surface uses),
      // and fails open. Reuse it rather than growing a second ladder.
      //
      // Used only as a FALLBACK, not unconditionally: when batch 2 parsed, the
      // existing list is preserved byte-for-byte so the happy path is unchanged.
      if (laborServices.length === 0) {
        try {
          const dbInputs: any = await ctx.runQuery(
            internal.vehicleEnrichment.laborRelabor._laborConfigInputs,
            { vehicleConfigId: args.vehicleConfigId },
          );
          for (const s of (dbInputs?.services ?? []) as Array<{
            slug: string;
            serviceId: Id<"services">;
            name: string;
            repairpal_slug: string | null;
          }>) {
            laborServices.push(s);
          }
          console.warn(
            `[v8/labor] batch-2 returned NO services — fell back to the DB-derived ` +
              `applicable list (${laborServices.length} service(s))`,
          );
        } catch (e) {
          console.warn("[v8/labor] DB-derived service fallback failed (non-fatal):", e);
        }
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
        `flags={olp:${laborFlags.olp},web:${laborFlags.web},estimatorEndpoint:${laborFlags.estimatorEndpoint},lemon:${laborFlags.lemon}}, ` +
        `${laborServices.length} services, buildId=${laborBuildId ? "resolved" : "none"}`,
      );

      // Wrapped in try/catch so a total orchestrator failure NEVER aborts the
      // downstream part-price writes (graceful degradation, like the old OLP block).
      // The RESULT is captured (it used to be discarded): `written === 0` is the
      // signal that every labor source came back empty, and it is what decides
      // whether the scheduled labor retry below fires. Without this there was no
      // forensic evidence anywhere that labor had failed.
      try {
        laborOutcome = await ctx.runAction(internal.vehicleEnrichment.laborResearch.laborAllSources, {
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
      console.log(
        `[v8/labor] laborAllSources result: ` +
          (laborOutcome
            ? `resolved=${laborOutcome.resolved} written=${laborOutcome.written} ` +
              `sources={olp:${laborOutcome.sources.olp},web:${laborOutcome.sources.web},` +
              `repairpalEndpoint:${laborOutcome.sources.repairpalEndpoint}}` +
              (laborOutcome.failed.length > 0 ? ` failed=[${laborOutcome.failed.join(", ")}]` : "")
            : "threw — no result"),
      );

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
          const roleByPartId = new Map<string, string | null>();
          for (const f of fitments) {
            subcatByPartId.set(String(f.part_id), ((f as any).part_subcategory as string | null) ?? null);
            roleByPartId.set(String(f.part_id), ((f as any).service_role as string | null) ?? null);
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
            if (e.urls.length === 0) {
              // No Batch-2/deterministic URL: queue for the PRIORITIZED pass-2
              // discovery after the service loop (was: inline first-come-first-
              // served spend with a SILENT skip once the cap hit — no gap entry,
              // no log; exactly how the A4 battery ended at 0 prices).
              if (deterministicallyPriced.has(partIdStr as any)) {
                bumpPriced(slug);
                continue;
              }
              if (!e.oem) {
                priceGaps.push({
                  field: `part_price:${e.subcategory ?? partIdStr}`,
                  reason: "price_no_oem_anchor",
                });
                continue;
              }
              if (!priceDiscoveryEnabled) continue;
              discoveryQueue.push({
                partId: partIdStr,
                oem: e.oem,
                name: e.name,
                subcategory: e.subcategory,
                serviceSlug: slug,
                serviceRole: roleByPartId.get(partIdStr) ?? null,
              });
              continue;
            }
            if (Date.now() > priceWorkDeadline) {
              priceGaps.push({
                field: `part_price:${e.subcategory ?? e.oem ?? partIdStr}`,
                reason: "price_deferred_timeout",
              });
              continue;
            }
            const rows = await priceAllSources(
              e.urls,
              { oem: e.oem, partName: e.name, subcategory: e.subcategory, requireOemEcho: false },
              extractPriceFirecrawl,
            );
            let wroteSale = false;
            for (const row of rows) {
              if (row.outcome.status !== "sale") continue;
              wroteSale = true;
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
            if (wroteSale) {
              bumpPriced(slug);
            } else {
              // Observability: a part where NO source yielded a trusted price gets
              // no row (better than an llm guess) — but log it so a degraded run
              // (anti-bot blocks / Firecrawl outage) is diagnosable, not silent.
              console.warn(
                `[v8/price] no trusted price for part ${partIdStr} (oem=${e.oem ?? "?"}) from ${e.urls.length} source(s): ` +
                  rows.map((r) => `${r.source_domain}:${r.outcome.status}${r.outcome.status === "unverified" ? `(${r.outcome.reason})` : ""}`).join(", "),
              );
              priceGaps.push({
                field: `part_price:${e.subcategory ?? e.oem ?? partIdStr}`,
                reason: "price_unverified_sources",
              });
            }
          }
        }
      }
      // ── Pass 2: prioritized price-URL discovery ─────────────────────────
      // Spend the per-run discovery budget in priority order across ALL
      // services: core parts on services with zero priced parts first, then
      // other core parts, then as_needed/kit. Leftovers land in the gap
      // ledger instead of vanishing.
      if (discoveryQueue.length > 0) {
        const ordered = prioritizeDiscoveryQueue(discoveryQueue, pricedPartsByService);
        const attempted = new Set<string>(); // one attempt per part even if it serves 2 services
        for (const item of ordered) {
          if (attempted.has(item.partId)) continue;
          attempted.add(item.partId);
          if (Date.now() > priceWorkDeadline) {
            priceGaps.push({
              field: `part_price:${item.subcategory ?? item.oem}`,
              reason: "price_deferred_timeout",
            });
            continue;
          }
          if (priceDiscoveryUsed >= priceDiscoveryMax) {
            priceGaps.push({
              field: `part_price:${item.subcategory ?? item.oem}`,
              reason: "price_budget_exhausted",
            });
            continue;
          }
          priceDiscoveryUsed++;
          const urls = await discoverPriceUrls({ oem: item.oem, make: args.make, name: item.name });
          if (urls === null) {
            console.warn(`[v8/price] discovery unavailable for part ${item.partId} (oem=${item.oem})`);
            priceGaps.push({
              field: `part_price:${item.subcategory ?? item.oem}`,
              reason: "price_discovery_unavailable",
            });
            continue;
          }
          if (urls.length === 0) {
            console.warn(`[v8/price] discovery found no usable source for part ${item.partId} (oem=${item.oem})`);
            priceGaps.push({
              field: `part_price:${item.subcategory ?? item.oem}`,
              reason: "price_no_source",
            });
            continue;
          }
          const rows = await priceAllSources(
            urls,
            // Discovered pages must echo the OEM number — a search hit is a
            // weaker tie to the part than an LLM/deterministic citation.
            { oem: item.oem, partName: item.name, subcategory: item.subcategory, requireOemEcho: true },
            extractPriceFirecrawl,
          );
          let wroteSale = false;
          for (const row of rows) {
            if (row.outcome.status !== "sale") continue;
            wroteSale = true;
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
              part_id: item.partId as any,
              price: row.outcome.price,
              price_type: "sale",
              source_domain: row.source_domain,
              source_url: row.source_url,
              msrp: row.outcome.msrp ?? undefined,
              discount: row.outcome.discount ?? undefined,
            });
          }
          if (wroteSale) {
            bumpPriced(item.serviceSlug);
          } else {
            console.warn(
              `[v8/price] no trusted price for part ${item.partId} (oem=${item.oem}) from ${urls.length} discovered source(s): ` +
                rows.map((r) => `${r.source_domain}:${r.outcome.status}${r.outcome.status === "unverified" ? `(${r.outcome.reason})` : ""}`).join(", "),
            );
            priceGaps.push({
              field: `part_price:${item.subcategory ?? item.oem}`,
              reason: "price_unverified_sources",
            });
          }
        }
        console.log(
          `[v8/price] discovery budget: ${priceDiscoveryUsed}/${priceDiscoveryMax} spent, ` +
            `${discoveryQueue.length} queued, ${priceGaps.filter((g) => g.reason === "price_budget_exhausted").length} deferred to backfill`,
        );
      }

      // Quotability snapshot — after all price writes so it reflects what a
      // customer could actually be quoted right now. Non-fatal.
      try {
        let applicableSlugs = services
          .filter((s: any) => s.is_applicable)
          .map((s: any) => SERVICE_NAME_TO_SLUG[s.service_name])
          .filter((x: any): x is string => !!x);
        // An empty applicable set makes computeQuotability return pct 1 over
        // zero services — a vacuous pass that reads as perfect coverage and
        // sails through the completion gate. Fall back to the structural list.
        if (applicableSlugs.length === 0) {
          applicableSlugs = await dbApplicableSlugs();
          console.warn(
            `[v8/quotability] batch-2 gave no applicable services — using the ` +
              `DB-derived list (${applicableSlugs.length} slug(s))`,
          );
        }
        const qFitments = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
          { vehicleConfigId: args.vehicleConfigId },
        );
        quotability = computeQuotability(
          qFitments,
          applicableSlugs,
          naRoleKeysFromFields(allFields),
        );
        console.log(
          `[v8/quotability] ${Math.round(quotability.pct * 100)}% — ` +
            quotability.services
              .map((s) => `${s.slug}:${s.core_with_price}/${s.core_total}`)
              .join(" "),
        );
      } catch (e) {
        console.warn("[v8/quotability] compute failed (non-fatal):", e);
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

    // Deferred-pricing self-heal: the in-action price deadline (600s-kill
    // guard) defers work to keep the run alive — but the nightly cron is too
    // slow a healer for a fresh config (wave-1 stress fleet: 17-22 parts/run
    // deferred, quotability cratered until the next morning). Schedule the
    // TARGETED zero-price backfill for this config immediately, in its own
    // action budget. The per-action cap keeps the backfill inside the 600s
    // limit; leftovers re-chain (bounded) before falling to the nightly sweep.
    // unverified-source parts count too — their poison rows hide them from
    // the old any-row scan and they'd otherwise never be retried (740iA: 6).
    const deferredPriceCount = priceGaps.filter(
      (g) =>
        g.reason === "price_deferred_timeout" ||
        g.reason === "price_budget_exhausted" ||
        g.reason === "price_unverified_sources",
    ).length;
    // Round 13 (parts triangle, 7/10 on the canary): the self-heal above only
    // retried parts whose pricing was DEFERRED. A part whose price discovery
    // simply came up empty produced no deferred gap, so it was never retried at
    // all — it just sat with no trusted price until the nightly cron, and the
    // triangle (fitment ⇒ verified part ⇒ trusted price) stayed broken on a
    // config already stamped "complete". Two of the canary's three broken legs
    // were exactly this (drain_plug_gasket, rear_brake_pad).
    //
    // Round 13b — THE HEAL MUST NOT BE DRIVEN BY THE GAP LEDGER.
    //
    // Counting price GAPS looks right and is subtly useless: a gap is only
    // recorded by the price pass, and the price pass lives inside `if (r2)`
    // alongside everything else keyed off batch-2's `services[]`. When batch 2
    // returns nothing — which happened on THREE of four canary runs — the pass
    // never executes, so it records ZERO gaps while leaving parts unpriced.
    //
    // Measured on the 2019 Forester: 10 of 27 parts with no trusted price and
    // `field_gaps` containing **zero** price entries. A heal triggered on
    // `priceGaps.length` was therefore a no-op in precisely the case that
    // needed it most.
    //
    // Ask the DATABASE what is unpriced instead. `getFitmentsWithPriceFlag`
    // already computes `has_trusted_price` with the same poison/non-pooled
    // exclusions quotability uses, so this counts exactly what the triangle
    // counts — and it is true regardless of which upstream stage ran.
    let unpricedCount = 0;
    try {
      const pricedFlags = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
        { vehicleConfigId: args.vehicleConfigId },
      );
      unpricedCount = pricedFlags.filter((f: any) => !f.has_trusted_price).length;
    } catch (e) {
      // Fail open to the old signal rather than skipping the heal entirely.
      console.warn("[v8/price] unpriced census failed, falling back to gap count:", e);
      unpricedCount = priceGaps.length;
    }
    const priceHealCount = Math.max(deferredPriceCount, unpricedCount);
    if (priceHealCount > 0) {
      const immediateCap = Number(process.env.PARTS_PRICE_IMMEDIATE_BACKFILL_CAP ?? "12");
      await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.priceRefresh.refreshStalePrices, {
        budget: 0,
        backfillBudget: Math.min(priceHealCount, immediateCap),
        vehicleConfigId: args.vehicleConfigId,
        maxChainDepth: Number(process.env.PARTS_PRICE_BACKFILL_CHAIN_DEPTH ?? "2"),
      });
      console.log(
        `[v8/price] scheduled follow-up backfill for ${priceHealCount} part(s) — ` +
          `${unpricedCount} unpriced in DB, ${deferredPriceCount} deferred/budget-skipped, ` +
          `${priceGaps.length} gaps ledgered`,
      );
    }
    // A config that finished with unpriced parts but recorded NO price gaps is
    // the signature of a skipped price pass, not of clean pricing. Surface it.
    if (unpricedCount > 0 && priceGaps.length === 0) {
      lateSanityFlags.push(
        buildLateSanityFlag(
          "completion_gate",
          "__price_pass_skipped",
          "flag",
          `${unpricedCount} part(s) unpriced but zero price gaps ledgered — the price pass ` +
            `did not run (batch-2 services empty?)`,
        ),
      );
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

    // Applicable-fill headline metrics — not_applicable fields drop OUT of the
    // denominator so a RWD sedan isn't penalized for lacking a transfer case
    // (the 740iA read 72% when its applicable coverage was ~90%).
    const fieldsFilledCount = V4_FIELD_KEYS.filter((k) => allFields[k]?.value != null).length;
    const fieldsNotApplicable = V4_FIELD_KEYS.filter(
      (k) => allFields[k]?.value == null && allFields[k]?.flag_reason === "not_applicable",
    ).length;
    const applicableFillRate = Math.round(
      (fieldsFilledCount / Math.max(1, V4_FIELD_KEYS.length - fieldsNotApplicable)) * 100,
    );

    // ── Fitment verification gate (Jul 2026, 5-VIN test) ──────────────
    // Format sanitization can't catch a REAL part number from the WRONG
    // vehicle (HEMI filter on the 3.6, Golf pads on the Atlas, Seltos filter
    // on the Soul). One adversarial web-search call cross-examines the
    // core-role parts written this run; refuted fitments are deleted so the
    // role falls to its universal fallback or an honest gap. "uncertain"
    // never deletes. Disable with PARTS_FITMENT_VERIFY=0.
    let fitmentRefutedErrors: string[] = [];
    if ((process.env.PARTS_FITMENT_VERIFY ?? "1") !== "0" && !timedOut) {
      try {
        const allFitments = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getPartFitments,
          { vehicleConfigId: args.vehicleConfigId },
        );
        // Batch-2 v2: every priced non-universal part is eligible (a Genesis
        // V6 o-ring shipped on a Soul because only priority roles were
        // sampled); priority roles are verified first when the cap bites.
        const candidates: {
          roleKey: string;
          oem: string;
          name: string;
          sourceCount: number;
          domainCount: number;
          catalogAttested: boolean;
          quantity: number | null;
          observedTitle: string | null;
          requireMiss: boolean;
        }[] = [];
        const seenOem = new Set<string>();
        for (const f of allFitments) {
          const part: any = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getOemPartById,
            { partId: (f as any).part_id },
          );
          const sub = part?.subcategory ?? "";
          const oem = part?.oem_part_number ?? "";
          if (!oem || oem.startsWith("OTOPAIR-UNIV") || seenOem.has(oem)) continue;
          seenOem.add(oem);
          // sourceCount = how many independent sources corroborated this fitment.
          // Carried so a single hallucinated "refuted" verdict can't hard-delete
          // a well-corroborated part (batch-5: the gate wrongly deleted the
          // correct G90 rear pad 58302-T4A10). Proportional skepticism below.
          // Round 9 (batch-11): domainCount (DISTINCT source domains) is the
          // corroboration basis when available — raw source_count counts every
          // re-scrape of the same wrong year-band listing as "support" (the
          // Forester's refuted 2010-2018 pads survived on page count alone).
          // quantity feeds the dual-plug count check (batch-5: HEMI = 2×cyl).
          // Round 12: observedTitle (oem_parts.scraped_name) gives the checker
          // the LISTING's own component identity; a require-miss verdict
          // (title present but missing the role's noun) promotes the part into
          // the priority sort so the soft signal always gets adjudicated.
          const observedTitle: string | null = part?.scraped_name ?? null;
          const idVerdict = checkRoleIdentity(sub, observedTitle);
          candidates.push({
            roleKey: sub,
            oem,
            name: part?.name ?? sub,
            sourceCount: (f as any).source_count ?? 1,
            domainCount: Array.isArray((f as any).source_domains)
              ? (f as any).source_domains.length
              : 0,
            catalogAttested: hasOemCatalogDomain((f as any).source_domains ?? undefined),
            quantity: (f as any).quantity_needed ?? null,
            observedTitle,
            requireMiss:
              idVerdict.verdict === "require_miss" ||
              (idVerdict.verdict === "reject" && idVerdict.mode === "flag"),
          });
        }
        candidates.sort(
          (a, b) =>
            Number(VERIFY_ROLE_KEYS.has(b.roleKey) || b.requireMiss) -
            Number(VERIFY_ROLE_KEYS.has(a.roleKey) || a.requireMiss),
        );
        const toVerify = candidates.slice(0, VERIFY_MAX_PARTS);
        if (candidates.length > toVerify.length) {
          console.log(`[fitment-verify] ${candidates.length - toVerify.length} lower-priority part(s) beyond the ${VERIFY_MAX_PARTS}-part cap left unverified`);
        }
        if (toVerify.length > 0) {
          const verdicts = await verifyPartFitments(
            {
              year: args.year,
              make: args.make,
              model: args.model,
              trim: args.trim,
              engineCode: vehicle.engineCode,
              displacement: args.displacement,
              // Aspiration + transmission family feed the batch-3 hardening
              // (NA-plug-on-turbo, DCT-filter-on-torque-converter). turbo is the
              // boolean the extractor writes; the verifier prompt still confirms
              // via search, this is just the seed hint.
              aspiration:
                allFields.turbo?.value === true ? "turbocharged" : undefined,
              transmissionType:
                (allFields.transmission_type?.value as string | null) ?? undefined,
              // Cylinder count lets the verifier judge dual-plug spark-plug
              // totals (2× cyl); engine manufacturer lets it apply engine-maker
              // fluid specs (Cummins-in-Ford, etc.). enginePicData is the
              // finalize-scope identity (vPicData is first-action only).
              cylinders: enginePicData?.cylinders ?? undefined,
              engineManufacturer: enginePicData?.engine_manufacturer ?? undefined,
              // Batch-10: a 5W-20 blend oil product shipped on the 0W-20 MDX —
              // the verifier refutes fluid products whose grade differs from
              // the vehicle's stored requirement.
              oilViscosity:
                (allFields.oil_viscosity?.value as string | null) ?? undefined,
            },
            toVerify.map((c) => ({
              roleKey: c.roleKey,
              oem: c.oem,
              name: c.name,
              quantity: c.quantity,
              observedTitle: c.observedTitle,
            })),
          );
          const refuted = verdicts.filter((vd) => vd.verdict === "refuted");
          console.log(
            `[fitment-verify] ${toVerify.length} core parts checked: ` +
              `${verdicts.filter((vd) => vd.verdict === "confirmed").length} confirmed, ` +
              `${refuted.length} refuted, ` +
              `${verdicts.filter((vd) => vd.verdict === "uncertain").length} uncertain`,
          );
          // Proportional skepticism (batch-5 fix): deletion is destructive, so
          // the evidence bar to delete scales with the part's independent
          // support. A single Haiku verdict may delete a WEAKLY-supported part
          // (sourceCount ≤ FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES), but a
          // well-corroborated part (multiple independent sources) is only
          // soft-flagged for review, not deleted — a lone hallucinated "refuted"
          // must not erase a part that several sources agreed fits.
          // Round 9: support = distinct attesting domains when recorded (rows
          // enriched since Jul 2026 all carry source_domains); legacy rows
          // without domain data keep the old page-count basis rather than
          // losing their multi-source protection.
          const supportByOem = new Map(
            toVerify.map((c) => [
              c.oem.toUpperCase(),
              c.domainCount > 0 ? c.domainCount : c.sourceCount,
            ]),
          );
          // Round 10 (batch-11 Cobalt/Accord): an OEM/dealer-CATALOG-attested
          // part is never hard-deleted on one verdict — batch-verified correct
          // parts (25894265, 15400-PLM-A02) were destroyed by single Haiku
          // refutes fed by mistitled aftermarket listings. Catalog-attested
          // refutes demote (soft-flag) instead: reversible, and the selector
          // already prefers unflagged rivals.
          const catalogByOem = new Map(
            toVerify.map((c) => [c.oem.toUpperCase(), c.catalogAttested]),
          );
          const hardDelete = refuted.filter(
            (r) =>
              (supportByOem.get(r.oem.toUpperCase()) ?? 1) <=
                FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES &&
              !catalogByOem.get(r.oem.toUpperCase()),
          );
          const softFlag = refuted.filter(
            (r) =>
              (supportByOem.get(r.oem.toUpperCase()) ?? 1) >
                FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES ||
              catalogByOem.get(r.oem.toUpperCase()),
          );
          if (softFlag.length > 0) {
            console.warn(
              `[fitment-verify] ${softFlag.length} refuted part(s) KEPT (multi-source support > ${FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES}) — flagged for review, not deleted: ` +
                softFlag.map((r) => `${r.roleKey}:${r.oem}`).join(", "),
            );
            // Persist the flag so the part selector demotes kept-but-refuted
            // fitments (they must not win a quote over an unflagged rival).
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.flagRefutedFitments,
              {
                vehicle_config_id: args.vehicleConfigId,
                refuted: softFlag.map((r) => ({ oem: r.oem, reason: r.reason })),
              },
            );
          }
          if (hardDelete.length > 0) {
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.removeRefutedFitments,
              {
                vehicle_config_id: args.vehicleConfigId,
                refuted: hardDelete.map((r) => ({ oem: r.oem, reason: r.reason })),
              },
            );
          }

          // ── Refute RESOLVE (2020 Yaris canary) ────────────────────────────
          // A soft flag had no route back: three writers set refute_flagged and
          // nothing ever cleared it, so one flag broke that part's quotability
          // triangle forever — even when a later pass confirmed the same
          // number. This is that route. Only parts this pass CONFIRMED are
          // offered, and the mutation itself refuses to overturn an
          // adjudicated `block`.
          const confirmedVerdicts = verdicts.filter((vd) => vd.verdict === "confirmed");
          if (confirmedVerdicts.length > 0) {
            try {
              const cleared = await ctx.runMutation(
                internal.vehicleEnrichment.v3mutations.resolveRefutedFitment,
                {
                  vehicle_config_id: args.vehicleConfigId,
                  confirmed: confirmedVerdicts.map((vd) => ({
                    oem: vd.oem,
                    reason: (vd as any).reason ?? "confirmed by fitment verification",
                  })),
                },
              );
              if (cleared.resolved > 0) {
                fitmentRefutedErrors.push(
                  `fitment_refute_resolved:${cleared.resolved}`,
                );
                lateSanityFlags.push(
                  buildLateSanityFlag(
                    "fitment_refute",
                    "__refute_resolved",
                    "info",
                    `cleared ${cleared.resolved} soft refute flag(s) on re-confirmation` +
                      (cleared.blocked_kept > 0
                        ? `; kept ${cleared.blocked_kept} adjudicated block(s)`
                        : ""),
                  ),
                );
              }
            } catch (e) {
              console.warn("[fitment-verify] refute resolve failed (non-fatal):", e);
            }
          }
          if (hardDelete.length > 0 || softFlag.length > 0) {
            // Round 10 (batch-11 Cobalt/Crosstrek): a kill used to leave a
            // permanent hole. One focused re-extraction call for the emptied
            // roles; answers flow through upsertPartAndFitment where the
            // fresh blocklist rows reject the refuted numbers, so this can
            // only add a DIFFERENT part. Round 11: soft-flagged (demoted)
            // roles are included too — a demoted part with no sourced rival
            // still WINS selection (wave-3 Crosstrek resurrections), so every
            // kill AND demote must source a replacement candidate.
            // Disable: PARTS_REFUTE_BACKFILL=0.
            if ((process.env.PARTS_REFUTE_BACKFILL ?? "1") !== "0") {
              try {
                const killed = [...hardDelete, ...softFlag].slice(0, 5).map((r) => ({
                  roleKey: r.roleKey,
                  killedOem: r.oem,
                }));
                const refills = await backfillKilledRoles(
                  {
                    year: args.year,
                    make: args.make,
                    model: args.model,
                    trim: args.trim,
                    engineCode: vehicle.engineCode,
                    displacement: args.displacement,
                  },
                  killed,
                );
                if (refills.length > 0) {
                  const makeDocForBackfill = await ctx.runQuery(
                    internal.vehicleEnrichment.v3queries.getMakeByName,
                    { name: args.make },
                  );
                  for (const r of refills) {
                    const meta = Object.values(PART_FIELD_MAP).find(
                      (m: any) => m.subcategory === r.roleKey,
                    ) as any;
                    if (!meta || !makeDocForBackfill) continue;
                    const res: any = await ctx.runMutation(
                      internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
                      {
                        oem_part_number: r.oem,
                        name: meta.name ?? r.name,
                        category: meta.category,
                        subcategory: meta.subcategory,
                        make_id: makeDocForBackfill._id,
                        vehicle_config_id: args.vehicleConfigId,
                        service_type: meta.serviceSlug ?? meta.subcategory,
                        quantity_needed: 1,
                        position: meta.position,
                        service_role: meta.serviceRole,
                        confidence: 0.7,
                        source_domain: extractDomain(r.source_url),
                        // Round 12: the researcher's found NAME is the listing
                        // title evidence — a backfill returning "Battery
                        // Ground Cable" now gets role-identity gated too.
                        observed_title: r.name ?? undefined,
                      },
                    );
                    console.log(
                      `[role-backfill] ${r.roleKey}: ${r.oem}${res?.rejected ? ` REJECTED (${res.rejected})` : " written"}`,
                    );
                  }
                }
              } catch (e) {
                console.warn("[role-backfill] pass failed (non-fatal):", e);
              }
            }
          }
          fitmentRefutedErrors = [
            ...hardDelete.map((r) => `fitment_refuted:${r.roleKey}:${r.oem}`),
            ...softFlag.map((r) => `fitment_refute_kept_multisource:${r.roleKey}:${r.oem}`),
          ];
          // W1.5 (G33): structured mirror of the strings above.
          lateSanityFlags.push(
            ...hardDelete.map((r) =>
              buildLateSanityFlag(
                "fitment_refute",
                r.roleKey,
                "reject",
                `fitment_refuted:${r.roleKey}:${r.oem}`,
                r.oem,
              ),
            ),
            ...softFlag.map((r) =>
              buildLateSanityFlag(
                "fitment_refute",
                r.roleKey,
                "flag",
                `fitment_refute_kept_multisource:${r.roleKey}:${r.oem}`,
                r.oem,
              ),
            ),
          );
        }
      } catch (e) {
        console.warn("[fitment-verify] pass failed (non-fatal):", e);
      }
    }

    // ── Round 12: STATE-based core-role completeness (repair + fresh facts) ──
    // Two prior bugs live here. (1) backfillKilledRoles above is EVENT-based:
    // on a re-run the blocklisted numbers are rejected at WRITE time, no kill
    // event fires, and empty roles stay empty forever (the Crosstrek's front
    // pads/rotor). (2) The persisted quotability snapshot was computed BEFORE
    // the verifier's kills, so the completion gate consumed pre-kill data.
    // This block asks the state question from a FRESH fitment read, repairs
    // missing binding core roles via resourceMissingRoles (empty-fill only),
    // persists positive not-applicable findings to na_role_keys, then
    // RECOMPUTES quotability + missing_roles + axle-pair gaps from another
    // fresh read for the run row and the completion gate.
    // Disable: PARTS_ROLE_RESOURCE=0 (detection still runs; only repair stops).
    let roleResourceGaps: Array<{ field: string; reason: string }> = [];
    let roleResourceErrors: string[] = [];
    // Round 18: everything the post-pass-2 REPAIR RUNG needs, captured where it
    // is in scope. Without a repair stage behind the second sweep, a pass-2
    // refutation empties a role and nothing refills it until the next run —
    // which is why the round-17 Jeep Grand Cherokee finished 0/3 quotable.
    let repairCtx: {
      metaBySubcategory: Record<string, any>;
      fieldBySubcategory: Record<string, string>;
      applicableSlugs: string[];
      naKeys: Set<string>;
      priorAttemptsByRole: Map<string, number>;
      blockedOems: Set<string>;
    } | null = null;
    let missingCoreRoleStrings: string[] = [];
    let axlePairGapStrings: string[] = [];
    let axleGapSanityFlags: Array<{ field: string; severity: "flag"; reason: string }> = [];
    if (!timedOut) {
      try {
        const metaBySubcategory: Record<string, any> = Object.fromEntries(
          Object.values(PART_FIELD_MAP).map((m: any) => [m.subcategory, m]),
        );
        const fieldBySubcategory: Record<string, string> = {};
        for (const [fieldKey, m] of Object.entries(PART_FIELD_MAP)) {
          fieldBySubcategory[(m as any).subcategory] = fieldKey;
        }
        let applicableSlugsForRoles = (services ?? [])
          .filter((s: any) => s.is_applicable)
          .map((s: any) => SERVICE_NAME_TO_SLUG[s.service_name])
          .filter((x: any): x is string => !!x);
        // Round 12b: an EMPTY applicable set from Batch-2 (observed live —
        // Crosstrek re-run returned services: []) must not read as "nothing
        // to check": fall back to the last run whose snapshot had one, and
        // say so loudly. With no prior truth either, detection is skipped —
        // an honest unknown, not a clean bill.
        if (applicableSlugsForRoles.length === 0) {
          const prior: string[] = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getPriorApplicableSlugs,
            { vehicleConfigId: args.vehicleConfigId, excludeRunId: args.runId },
          );
          if (prior.length > 0) {
            console.warn(
              `[role-resource] batch returned NO applicable services — falling back to prior run's ${prior.length} slugs`,
            );
            applicableSlugsForRoles = prior;
            roleResourceErrors.push("applicable_services_empty_fallback_used");
          } else {
            // Round 13: a FIRST run has no prior snapshot, so the fallback above
            // cannot fire and detection was skipped entirely — which is exactly
            // what happened on the 2020 Yaris canary
            // (`applicable_services_unknown`, zero roles checked). Applicability
            // is structural, so the DB can answer it without any prior run:
            // getApplicableServices is the same canonical gate the booking
            // surface uses. Only a genuinely unanswerable case (helper failed or
            // returned nothing) still records the honest unknown.
            const structural = await dbApplicableSlugs();
            if (structural.length > 0) {
              console.warn(
                `[role-resource] batch returned NO applicable services and there is no prior run — ` +
                  `falling back to the DB-derived structural list (${structural.length} slugs)`,
              );
              applicableSlugsForRoles = structural;
              roleResourceErrors.push("applicable_services_structural_fallback_used");
            } else {
              roleResourceErrors.push("applicable_services_unknown");
            }
          }
        }
        const configRowForRoles: any = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigById,
          { vehicleConfigId: args.vehicleConfigId },
        );
        // N/A union: run-level applicability nulls ∪ the config's durable
        // role-level N/A memory (rear drums survive re-runs only here).
        const naKeys = new Set<string>([
          ...naRoleKeysFromFields(allFields),
          ...(((configRowForRoles?.na_role_keys ?? []) as string[]) ?? []),
        ]);

        const freshFitments = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
          { vehicleConfigId: args.vehicleConfigId },
        );
        let missing = missingCoreRoles(freshFitments, applicableSlugsForRoles, naKeys);

        // Round 13: sole-flagged-winner roles from the verify pass that just
        // ran — a soft-flagged wrong part with no rival wins selection
        // unopposed (batch-11's "demoted-wrong-winner"; live: the Crosstrek's
        // 2022-2023-only pad 26296FL032). Research + verify a RIVAL; the
        // selector's refute-demotion layer swaps winners; the incumbent is
        // never touched. Disable: PARTS_ROLE_RIVAL=0.
        let rivalTargets: Array<{
          serviceSlug: string;
          roleKey: string;
          fitmentService: string;
          kind: "rival";
          flaggedOems: string[];
        }> = [];
        if ((process.env.PARTS_ROLE_RIVAL ?? "1") !== "0") {
          const candidateRows: any[] = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getFitmentCandidateRows,
            { vehicleConfigId: args.vehicleConfigId },
          );
          rivalTargets = soleFlaggedWinnerRoles(candidateRows)
            .filter((r) => !naKeys.has(r.roleKey))
            .map((r) => ({
              serviceSlug: r.serviceType,
              roleKey: r.roleKey,
              fitmentService: r.serviceType,
              kind: "rival" as const,
              flaggedOems: r.flaggedOems,
            }));
          if (rivalTargets.length > 0) {
            console.log(
              `[role-resource] ${rivalTargets.length} sole-flagged-winner role(s) to rival: ` +
                rivalTargets.map((t) => `${t.roleKey} (vs ${t.flaggedOems.join(",")})`).join(", "),
            );
          }
        }

        if ((missing.length > 0 || rivalTargets.length > 0) && (process.env.PARTS_ROLE_RESOURCE ?? "1") !== "0") {
          console.log(
            `[role-resource] ${missing.length} missing binding core role(s): ` +
              missing.map((m) => `${m.serviceSlug}:${m.roleKey}`).join(", "),
          );
          const attemptsByField: Record<string, number> = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getRoleResourceAttempts,
            { vehicleConfigId: args.vehicleConfigId },
          );
          const priorAttemptsByRole = new Map<string, number>();
          for (const [fieldKey, n] of Object.entries(attemptsByField)) {
            const sub = (PART_FIELD_MAP as any)[fieldKey]?.subcategory;
            if (sub) priorAttemptsByRole.set(sub, n);
          }
          const blockedRows: any[] = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getBlockedOemsForConfig,
            { vehicleConfigId: args.vehicleConfigId },
          );
          const blockedOems = new Set<string>(
            blockedRows.map((b) => b.oem_part_number_normalized),
          );
          // Rival incumbents join the exclusion set — the researcher must not
          // re-derive the very number that is flagged.
          for (const t of rivalTargets) for (const oem of t.flaggedOems) blockedOems.add(oem);
          // Captured for the post-pass-2 repair rung below.
          repairCtx = {
            metaBySubcategory,
            fieldBySubcategory,
            applicableSlugs: applicableSlugsForRoles,
            naKeys,
            priorAttemptsByRole,
            blockedOems,
          };
          const outcomes = await resourceMissingRoles(
            ctx,
            {
              year: args.year,
              make: args.make,
              model: args.model,
              trim: args.trim,
              engineCode: vehicle.engineCode,
              displacement: args.displacement,
              transmissionType:
                (allFields.transmission_type?.value as string | null) ?? undefined,
              vehicleConfigId: args.vehicleConfigId,
              makeId: args.makeId,
              buildSourceMake:
                resolveScrapeRedirect({ make: args.make, model: args.model, model_year: args.year })
                  ?.make ?? null,
            },
            // Fills first — an EMPTY role outranks a flagged-but-present one.
            [...missing, ...rivalTargets],
            metaBySubcategory,
            { priorAttemptsByRole, blockedOems },
          );
          const naFound = outcomes.filter((o) => o.outcome === "not_applicable");
          if (naFound.length > 0) {
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.addNaRoleKeys, {
              vehicle_config_id: args.vehicleConfigId,
              role_keys: naFound.map((o) => o.roleKey),
            });
            for (const o of naFound) naKeys.add(o.roleKey);
          }
          for (const o of outcomes) {
            const field = fieldBySubcategory[o.roleKey] ?? o.roleKey;
            const reason =
              o.outcome === "written"
                ? "resourced"
                : o.outcome === "not_applicable"
                  ? "resource_not_applicable"
                  : o.outcome === "rejected_refuted"
                    ? "resource_refuted_no_replacement"
                    // Two DIFFERENT situations that used to share one label, and
                    // the confusion cost a diagnosis: "untried, more budget
                    // would try it" versus "tried its lifetime allowance,
                    // more budget changes nothing".
                    : o.outcome === "skipped_run_budget"
                      ? "resource_skipped_run_budget"
                      : o.outcome === "skipped_lifetime_cap"
                        ? "resource_skipped_lifetime_cap"
                        : o.outcome === "skipped_budget"
                          ? "resource_skipped_budget"
                          : "resource_never_found";
            // Rival misses are not field gaps — the role is occupied (by the
            // flagged incumbent); the flag already carries the review signal.
            if (o.outcome !== "written" && o.kind !== "rival") {
              roleResourceGaps.push({ field, reason });
            }
            roleResourceErrors.push(
              `role_resource:${o.roleKey}:${o.kind === "rival" ? (o.outcome === "written" ? "rivaled" : `rival_${o.outcome}`) : o.outcome}`,
            );
          }
        }

        // Fresh post-repair facts — what the run row and completion gate see.
        const fitmentsAfter = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
          { vehicleConfigId: args.vehicleConfigId },
        );

        // ── Post-repair price heal ────────────────────────────────────────
        // The earlier heal is scheduled ~570 lines above, BEFORE the role-
        // resource repair writes the parts it re-sources. Two things follow,
        // and both deny a first pricing attempt to exactly the parts that most
        // need one:
        //
        //   1. its budget is sized from a census taken before those parts
        //      existed, so they are not in the count; and
        //   2. it is scheduled runAfter(0), racing the repair's own writes.
        //
        // The canary evidence is the confidence-0.7 signature (roleResource's
        // stamp): five Forester parts — atf_fluid, front_brake_pad,
        // front_rotor, intake_manifold_gasket, rear_rotor — plus the Grand
        // Highlander's three, on a run that logged role_resource:5 and ZERO web
        // searches. All landed unpriced with no part_prices row of any type.
        //
        // `fitmentsAfter` is already fetched here for the quotability recompute,
        // so this costs one filter and no extra query. The earlier schedule
        // stays as the fallback for runs where this block is env-gated off
        // (PARTS_ROLE_RESOURCE=0) or throws.
        try {
          const stillUnpriced = fitmentsAfter.filter((f: any) => !f.has_trusted_price).length;
          if (stillUnpriced > 0) {
            const cap = Number(process.env.PARTS_PRICE_IMMEDIATE_BACKFILL_CAP ?? "12");
            await ctx.scheduler.runAfter(
              0,
              internal.vehicleEnrichment.priceRefresh.refreshStalePrices,
              {
                budget: 0,
                backfillBudget: Math.min(stillUnpriced, cap),
                vehicleConfigId: args.vehicleConfigId,
                maxChainDepth: Number(process.env.PARTS_PRICE_BACKFILL_CHAIN_DEPTH ?? "2"),
              },
            );
            console.log(
              `[v8/price] post-repair heal scheduled for ${stillUnpriced} unpriced part(s) ` +
                `(includes parts written by the role-resource repair, which the pre-repair ` +
                `heal could not have seen)`,
            );
          }
        } catch (e) {
          console.warn("[v8/price] post-repair heal scheduling failed (non-fatal):", e);
        }

        missing = missingCoreRoles(fitmentsAfter, applicableSlugsForRoles, naKeys);
        const axleGaps = axlePairGaps(fitmentsAfter, applicableSlugsForRoles, naKeys);
        missingCoreRoleStrings = missing.map((m) => `${m.serviceSlug}:${m.roleKey}`);
        axlePairGapStrings = axleGaps.map((g) => `${g.serviceSlug}:${g.missingRole}`);
        axleGapSanityFlags = axleGaps.map((g) => ({
          field: fieldBySubcategory[g.missingRole] ?? g.missingRole,
          severity: "flag" as const,
          reason: `axle_pair_gap:${g.serviceSlug}:${g.filledRole}_present_${g.missingRole}_missing`,
        }));
        roleResourceErrors.push(
          ...axleGaps.map((g) => `axle_pair_gap:${g.serviceSlug}:${g.missingRole}`),
        );

        const missingBySlug = new Map<string, string[]>();
        for (const m of missing) {
          missingBySlug.set(m.serviceSlug, [...(missingBySlug.get(m.serviceSlug) ?? []), m.roleKey]);
        }
        const freshQuotability = computeQuotability(fitmentsAfter, applicableSlugsForRoles, naKeys);
        quotability = {
          pct: freshQuotability.pct,
          services: freshQuotability.services.map((s) => ({
            ...s,
            ...(missingBySlug.has(s.slug) ? { missing_roles: missingBySlug.get(s.slug) } : {}),
          })),
        } as any;
        console.log(
          `[role-resource] post-repair quotability ${Math.round(freshQuotability.pct * 100)}%` +
            (missingCoreRoleStrings.length > 0
              ? ` — still missing: ${missingCoreRoleStrings.join(", ")}`
              : " — all binding core roles filled") +
            (axlePairGapStrings.length > 0 ? ` — AXLE GAPS: ${axlePairGapStrings.join(", ")}` : ""),
        );
      } catch (e) {
        console.warn("[role-resource] pass failed (non-fatal):", e);
        // G38: if this pass died before the post-repair recompute, the
        // `quotability` variable still holds the PRE-kill snapshot (computed
        // before the fitment verifier's deletes) — the completion gate would
        // silently consume stale data. Clear it so the gate's null-branch
        // decides honestly, and record the failure on both channels.
        quotability = undefined;
        roleResourceErrors.push("quotability_recompute_failed");
        lateSanityFlags.push(
          buildLateSanityFlag(
            "completion_gate",
            "quotability",
            "flag",
            "quotability_recompute_failed",
          ),
        );
      }
    }

    // ── Fitment verification, SECOND SWEEP (round 15b) ────────────────────
    //
    // The pass above runs BEFORE the role-resource repair, and that ordering
    // is deliberate: verification deletes refuted parts, leaving a role empty,
    // and role-resource then sources a RIVAL into it ("source a rival instead
    // of deleting"). The consequence nobody had traced is that everything
    // role-resource writes lands AFTER the only adversarial gate, and is
    // therefore never checked.
    //
    // Round 15b measured the cost: the 2019 911 GT3 RS finalized with NINE of
    // its ten parts written by role-resource — including the Cayenne brake
    // pads `9Y0698151AN` / `9Y0698451AE`, which shipped priced, unflagged and
    // quotable. It was not the 25-part cap (the car had 10 parts) and not the
    // prompt (it names cross-model misfit explicitly): re-running the real
    // verifier on that exact 10-part list refutes both pads 2/2, twice over.
    // The gate simply never saw them.
    //
    // So: re-verify ONLY what role-resource wrote this run. Same verdict
    // semantics as the first pass — "uncertain" never acts, catalog-attested
    // and multi-source refutes soft-flag rather than delete.
    const secondSweepRoles = new Set(
      roleResourceErrors
        .map((e) => /^role_resource:([^:]+):(?:written|rivaled)$/.exec(e)?.[1])
        .filter((r): r is string => !!r),
    );
    if (
      (process.env.PARTS_FITMENT_VERIFY ?? "1") !== "0" &&
      !timedOut &&
      secondSweepRoles.size > 0
    ) {
      try {
        const freshFitments = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getPartFitments,
          { vehicleConfigId: args.vehicleConfigId },
        );
        const sweep: {
          roleKey: string; oem: string; name: string; quantity: number | null;
          observedTitle: string | null; support: number; catalogAttested: boolean;
        }[] = [];
        const seen = new Set<string>();
        for (const f of freshFitments) {
          const part: any = await ctx.runQuery(
            internal.vehicleEnrichment.v3queries.getOemPartById,
            { partId: (f as any).part_id },
          );
          const sub = part?.subcategory ?? "";
          const oem = part?.oem_part_number ?? "";
          if (!oem || oem.startsWith("OTOPAIR-UNIV")) continue;
          if (!secondSweepRoles.has(sub) || seen.has(oem)) continue;
          // Already adjudicated by the first pass — don't pay for it twice.
          if ((f as any).refute_flagged === true) continue;
          seen.add(oem);
          const domains = Array.isArray((f as any).source_domains)
            ? (f as any).source_domains.length
            : 0;
          sweep.push({
            roleKey: sub,
            oem,
            name: part?.name ?? sub,
            quantity: (f as any).quantity_needed ?? null,
            observedTitle: part?.scraped_name ?? null,
            support: domains > 0 ? domains : ((f as any).source_count ?? 1),
            catalogAttested: hasOemCatalogDomain((f as any).source_domains ?? undefined),
          });
        }
        if (sweep.length > 0) {
          const verdicts2 = await verifyPartFitments(
            {
              year: args.year, make: args.make, model: args.model, trim: args.trim,
              engineCode: vehicle.engineCode, displacement: args.displacement,
              aspiration: allFields.turbo?.value === true ? "turbocharged" : undefined,
              transmissionType:
                (allFields.transmission_type?.value as string | null) ?? undefined,
              cylinders: enginePicData?.cylinders ?? undefined,
              engineManufacturer: enginePicData?.engine_manufacturer ?? undefined,
              oilViscosity: (allFields.oil_viscosity?.value as string | null) ?? undefined,
            },
            sweep.slice(0, VERIFY_MAX_PARTS).map((c) => ({
              roleKey: c.roleKey, oem: c.oem, name: c.name,
              quantity: c.quantity, observedTitle: c.observedTitle,
            })),
          );
          const refuted2 = verdicts2.filter((vd) => vd.verdict === "refuted");
          console.log(
            `[fitment-verify:2] ${sweep.length} role-resource part(s) checked: ` +
              `${verdicts2.filter((v) => v.verdict === "confirmed").length} confirmed, ` +
              `${refuted2.length} refuted, ` +
              `${verdicts2.filter((v) => v.verdict === "uncertain").length} uncertain`,
          );
          // Observability: the first pass had NO persisted evidence of having
          // run, so "gate found nothing" and "gate never ran" were
          // indistinguishable in the audit — the same ambiguity that hid the
          // batch-2 keystone bug. This tag makes the sweep queryable.
          fitmentRefutedErrors.push(`fitment_verify_pass2:checked:${sweep.length}`);
          const byOem = new Map(sweep.map((c) => [c.oem.toUpperCase(), c]));
          const hard2 = refuted2.filter((r) => {
            const c = byOem.get(r.oem.toUpperCase());
            return (
              (c?.support ?? 1) <= FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES &&
              !c?.catalogAttested
            );
          });
          const soft2 = refuted2.filter((r) => !hard2.includes(r));
          if (soft2.length > 0) {
            console.warn(
              `[fitment-verify:2] ${soft2.length} refuted part(s) KEPT (catalog-attested or multi-source) — flagged: ` +
                soft2.map((r) => `${r.roleKey}:${r.oem}`).join(", "),
            );
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.flagRefutedFitments,
              {
                vehicle_config_id: args.vehicleConfigId,
                refuted: soft2.map((r) => ({ oem: r.oem, reason: r.reason })),
              },
            );
          }
          if (hard2.length > 0) {
            console.warn(
              `[fitment-verify:2] ${hard2.length} refuted part(s) REMOVED: ` +
                hard2.map((r) => `${r.roleKey}:${r.oem}`).join(", "),
            );
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.removeRefutedFitments,
              {
                vehicle_config_id: args.vehicleConfigId,
                refuted: hard2.map((r) => ({ oem: r.oem, reason: r.reason })),
              },
            );
          }
          for (const r of refuted2) {
            fitmentRefutedErrors.push(`fitment_refuted_pass2:${r.roleKey}:${r.oem}`);
          }

          // ── REPAIR RUNG (round 18) ──────────────────────────────────────
          //
          // Until now the sequence ended at a verdict: verify -> repair ->
          // verify. A pass-2 refutation therefore emptied a role with NOTHING
          // behind it, and the role stayed empty until the next run. Round 17
          // measured the cost — the Jeep Grand Cherokee had all three of its
          // parts refuted here and finished 0/3 quotable, an honest but
          // unusable config.
          //
          // This closes the loop: whatever pass 2 just removed or demoted is
          // re-sourced now, reusing the SAME machinery as the first repair —
          // missingCoreRoles for roles pass 2 emptied, soleFlaggedWinnerRoles
          // for roles where it flagged the only candidate. Nothing new is
          // invented; the existing stages simply get to run once more.
          //
          // The refuted numbers join blockedOems, so the researcher cannot
          // re-find the very part just rejected — without that, a role whose
          // wrong number dominates the open web would loop straight back to it.
          if (refuted2.length > 0 && repairCtx) {
            try {
              const rc = repairCtx;
              for (const r of refuted2) rc.blockedOems.add(r.oem.toUpperCase());
              const after = await ctx.runQuery(
                internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
                { vehicleConfigId: args.vehicleConfigId },
              );
              const refill = missingCoreRoles(after, rc.applicableSlugs, rc.naKeys);
              const candidateRows: any[] = await ctx.runQuery(
                internal.vehicleEnrichment.v3queries.getFitmentCandidateRows,
                { vehicleConfigId: args.vehicleConfigId },
              );
              const rivals = soleFlaggedWinnerRoles(candidateRows)
                .filter((r) => !rc.naKeys.has(r.roleKey))
                .map((r) => ({
                  serviceSlug: r.serviceType,
                  roleKey: r.roleKey,
                  fitmentService: r.serviceType,
                  kind: "rival" as const,
                  flaggedOems: r.flaggedOems,
                }));
              const targets = [...refill, ...rivals];
              if (targets.length > 0) {
                console.log(
                  `[role-resource:2] repairing ${targets.length} role(s) emptied or demoted by pass 2: ` +
                    targets.map((t) => t.roleKey).join(", "),
                );
                const repaired = await resourceMissingRoles(
                  ctx,
                  {
                    year: args.year,
                    make: args.make,
                    model: args.model,
                    trim: args.trim,
                    engineCode: vehicle.engineCode,
                    displacement: args.displacement,
                    transmissionType:
                      (allFields.transmission_type?.value as string | null) ?? undefined,
                    vehicleConfigId: args.vehicleConfigId,
                    makeId: args.makeId,
                    buildSourceMake:
                      resolveScrapeRedirect({
                        make: args.make, model: args.model, model_year: args.year,
                      })?.make ?? null,
                  },
                  targets,
                  rc.metaBySubcategory,
                  {
                    priorAttemptsByRole: rc.priorAttemptsByRole,
                    blockedOems: rc.blockedOems,
                  },
                );
                const written = repaired.filter((o) => o.outcome === "written");
                console.log(
                  `[role-resource:2] ${written.length}/${targets.length} role(s) refilled after pass-2 refutation`,
                );
                for (const o of repaired) {
                  roleResourceErrors.push(`role_resource_pass2:${o.roleKey}:${o.outcome}`);
                }
                fitmentRefutedErrors.push(
                  `repair_rung:refilled:${written.length}/${targets.length}`,
                );
              }
            } catch (e) {
              console.warn("[role-resource:2] repair rung failed (non-fatal):", e);
              fitmentRefutedErrors.push("repair_rung:failed");
            }
          }
        }
      } catch (e) {
        // Non-fatal, but recorded — see the observability note above.
        console.warn("[fitment-verify:2] sweep failed (non-fatal):", e);
        fitmentRefutedErrors.push("fitment_verify_pass2:failed");
      }
    }

    // ── Transmission-fluid family gate (round-6, FLAG-ONLY) ───────────
    // The fitment verifier above cross-examines OEM PART numbers, but the
    // transmission fluid SPEC ("Dexron VI", "NS-2", "Mercon LV") lives in the
    // trans_fluid_type FIELD, never in a part row — so it reached quotes
    // unchecked (batch-7: NS-2-vs-NS-3, Dexron-VI-vs-ULV, wet-Mercon in a dry
    // DCT; a wrong trans fluid DESTROYS the unit).
    //
    // BATCH-8 (Jul 21 2026) changed this from a CORRECTOR to a FLAGGER. The
    // original design overwrote the stored fluid on a "mismatch" — and live
    // validation showed the web-search verifier falls into the SAME unit-mis-ID
    // trap it was built to catch, overwriting TWO correct values (Corolla ATF
    // WS→T-IV via a U341E-vs-U240E mix-up; Wrangler ZF ATF→ATF+4 off a bad vPIC
    // "manual" decode). An autonomous LLM verifier is not reliable enough to
    // overwrite a damaging-consequence value. So a positively-supported
    // "mismatch" now only FLAGS for review + caps the field confidence — it
    // never changes the stored value. Disable with TRANS_FLUID_VERIFY=0.
    let transFluidErrors: string[] = [];
    // Round 11: when the round-7 verifier positively names the correct fluid
    // AND the deterministic family gate independently finds the same-direction
    // contradiction, the two together authorize correction (captured here,
    // consumed in the spec-reconcile block below).
    let verifierClaimedCorrectFluid: string | null = null;
    const transmissionId = args.transmissionId;
    if (
      (process.env.TRANS_FLUID_VERIFY ?? "1") !== "0" &&
      !timedOut &&
      transmissionId != null &&
      allFields.trans_fluid_type?.value != null
    ) {
      try {
        const trans: any = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getTransmission,
          { transmissionId },
        );
        const storedFluid = String(allFields.trans_fluid_type.value);
        const verdict = await verifyTransFluid(
          {
            year: args.year,
            make: args.make,
            model: args.model,
            trim: args.trim,
            engineCode: vehicle.engineCode,
            displacement: args.displacement,
            aspiration:
              allFields.turbo?.value === true ? "turbocharged" : undefined,
            transmissionType:
              (allFields.transmission_type?.value as string | null) ??
              (trans?.type as string | null) ??
              undefined,
            transmissionSpeeds: (trans?.speeds as number | null) ?? undefined,
          },
          storedFluid,
        );
        console.log(
          `[trans-fluid-verify] ${verdict.verdict} — unit=${verdict.transUnit ?? "?"}, ` +
            `stored="${storedFluid}", claimed_correct="${verdict.correctFluid ?? "?"}"`,
        );
        const action = decideTransFluidAction(verdict, storedFluid);
        if (action.action === "flag") {
          // FLAG ONLY — never overwrite. Cap the field confidence (0.55: below
          // the 0.75 quote/consensus gates) so a suspected-wrong fluid can't
          // ship as high-confidence, and record the suspicion for review. The
          // stored fluid_type is left untouched (the verifier is not trusted to
          // replace it).
          allFields.trans_fluid_type = {
            ...allFields.trans_fluid_type,
            flagged: true,
            flag_reason: `trans_fluid_suspect:${action.suspectUnit}: stored "${storedFluid}", verifier expected "${action.claimedCorrect}"`,
            confidence: Math.min(
              allFields.trans_fluid_type.confidence ?? 0.55,
              0.55,
            ),
          };
          transFluidErrors = [
            `trans_fluid_suspect:${action.suspectUnit}:stored=${storedFluid}:expected=${action.claimedCorrect}`,
          ];
          // W1.5 (G32): the flag+cap above mutates allFields AFTER
          // writeNormalizedData — persist the outcome structurally too.
          lateSanityFlags.push(
            buildLateSanityFlag(
              "trans_fluid",
              "trans_fluid_type",
              "flag",
              `trans_fluid_suspect:${action.suspectUnit}:stored=${storedFluid}:expected=${action.claimedCorrect}`,
              storedFluid,
            ),
          );
          verifierClaimedCorrectFluid = action.claimedCorrect;
          console.warn(
            `[trans-fluid-verify] FLAGGED (not changed) trans_fluid_type "${storedFluid}" — ` +
              `verifier expected "${action.claimedCorrect}" for ${action.suspectUnit} (${action.reason})`,
          );
        }

        // ── Round 8: speeds-vs-unit reconcile (batch-10 Cobalt) ──────────
        // NHTSA's transSpeeds can carry the OTHER gearbox's gear count (the
        // manual's 5 merged onto the resolved 4T45 automatic → "5-speed
        // automatic", a config that never existed). The verifier names the
        // specific unit; most units lead with their gear count. Correct only
        // in the high-precision direction: the fluid verdict was "match"
        // (unit↔fluid corroborated), the unit encodes a count, and the stored
        // count differs. Anything weaker is flag-only.
        const impliedSpeeds = speedsFromTransUnit(verdict.transUnit);
        const storedSpeeds = (trans?.speeds as number | null) ?? null;
        if (impliedSpeeds != null && storedSpeeds != null && storedSpeeds !== impliedSpeeds) {
          if (verdict.verdict === "match") {
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateTransmissionSpecs, {
              transmission_id: transmissionId,
              speeds: impliedSpeeds,
            });
            transFluidErrors.push(
              `trans_speeds_reconciled:${verdict.transUnit}:stored=${storedSpeeds}:unit_implies=${impliedSpeeds}`,
            );
            console.warn(
              `[trans-speeds-reconcile] speeds ${storedSpeeds} → ${impliedSpeeds} (unit ${verdict.transUnit}, fluid verdict=match)`,
            );
          } else {
            transFluidErrors.push(
              `trans_speeds_suspect:${verdict.transUnit ?? "?"}:stored=${storedSpeeds}:unit_implies=${impliedSpeeds}`,
            );
            console.warn(
              `[trans-speeds-reconcile] SUSPECT (not changed): stored ${storedSpeeds} vs unit-implied ${impliedSpeeds} (${verdict.transUnit}, verdict=${verdict.verdict})`,
            );
          }
        }
      } catch (e) {
        console.warn("[trans-fluid-verify] pass failed (non-fatal):", e);
      }
    }

    // ── Round 9: deterministic CVT spec↔part reconcile (batch-11 Rogue) ─
    // No LLM involved (see transFluidSpecReconcile.ts for why this is exempt
    // from the batch-8 flag-only doctrine): fires only when the resolved type
    // is CVT, the stored spec is token-identifiably a stepped-gearbox ATF,
    // and the extracted fluid PART is token-identifiably CVT-family — then
    // the spec is reconciled to the part's family. Weaker evidence flags.
    if (
      (process.env.TRANS_FLUID_SPEC_RECONCILE ?? "1") !== "0" &&
      !timedOut &&
      transmissionId != null &&
      allFields.trans_fluid_type?.value != null
    ) {
      try {
        const trans: any = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getTransmission,
          { transmissionId },
        );
        const typeText = [
          asString(allFields.transmission_type?.value),
          trans?.type,
          trans?.transmission_type,
        ]
          .filter(Boolean)
          .join(" ");
        const specRecon = reconcileTransFluidSpecWithPart({
          transTypeText: typeText,
          spec: asString(allFields.trans_fluid_type?.value),
          partText: asString(allFields.atf_fluid_oem?.value),
        });
        if (specRecon.action === "correct") {
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateTransmissionSpecs, {
            transmission_id: transmissionId,
            fluid_type: specRecon.correctedSpec,
          });
          const oldSpec = String(allFields.trans_fluid_type.value);
          allFields.trans_fluid_type = {
            ...allFields.trans_fluid_type,
            value: specRecon.correctedSpec,
          };
          transFluidErrors.push(
            `trans_fluid_spec_reconciled:stored=${oldSpec}:part_implies=${specRecon.correctedSpec}`,
          );
          lateSanityFlags.push(
            buildLateSanityFlag(
              "trans_fluid",
              "trans_fluid_type",
              "flag",
              `trans_fluid_spec_reconciled:stored=${oldSpec}:part_implies=${specRecon.correctedSpec}`,
              specRecon.correctedSpec,
            ),
          );
          console.warn(
            `[trans-fluid-spec-reconcile] "${oldSpec}" → "${specRecon.correctedSpec}" (${specRecon.reason})`,
          );
        } else if (specRecon.action === "flag" && verifierClaimedCorrectFluid) {
          // Round 11 (batch-11 Equinox): TWO independent gates agree the
          // stored spec is the wrong FAMILY for this unit — the deterministic
          // family reconcile (this gate) and the round-7 web verifier, which
          // positively named both the unit and its required fluid. A
          // multi-gate agreement on a family constant is a different evidence
          // class from the single-verifier overwrites that round-6 banned
          // (those failed on unit mis-ID; here the family conflict is
          // decided without the verifier). Correct to the verifier's named
          // fluid instead of shipping a flagged-but-live wrong family.
          const oldSpec = String(allFields.trans_fluid_type.value);
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateTransmissionSpecs, {
            transmission_id: transmissionId,
            fluid_type: verifierClaimedCorrectFluid,
          });
          allFields.trans_fluid_type = {
            ...allFields.trans_fluid_type,
            value: verifierClaimedCorrectFluid,
          };
          transFluidErrors.push(
            `trans_fluid_corrected_multigate:stored=${oldSpec}:corrected=${verifierClaimedCorrectFluid}`,
          );
          lateSanityFlags.push(
            buildLateSanityFlag(
              "trans_fluid",
              "trans_fluid_type",
              "flag",
              `trans_fluid_corrected_multigate:stored=${oldSpec}:corrected=${verifierClaimedCorrectFluid}`,
              verifierClaimedCorrectFluid,
            ),
          );
          console.warn(
            `[trans-fluid-spec-reconcile] MULTI-GATE CORRECTED "${oldSpec}" → "${verifierClaimedCorrectFluid}" (${specRecon.reason})`,
          );
        } else if (specRecon.action === "flag") {
          allFields.trans_fluid_type = {
            ...allFields.trans_fluid_type,
            flagged: true,
            flag_reason: `trans_fluid_spec_family_conflict: ${specRecon.reason}`,
            confidence: Math.min(allFields.trans_fluid_type.confidence ?? 0.55, 0.55),
          };
          transFluidErrors.push(
            `trans_fluid_spec_family_conflict:stored=${String(allFields.trans_fluid_type.value)}`,
          );
          lateSanityFlags.push(
            buildLateSanityFlag(
              "trans_fluid",
              "trans_fluid_type",
              "flag",
              `trans_fluid_spec_family_conflict: ${specRecon.reason}`,
              String(allFields.trans_fluid_type.value),
            ),
          );
          console.warn(`[trans-fluid-spec-reconcile] FLAGGED: ${specRecon.reason}`);
        }
      } catch (e) {
        console.warn("[trans-fluid-spec-reconcile] pass failed (non-fatal):", e);
      }
    }

    // ── Fluid brand-consistency gate (round-7, batch-8) ───────────────
    // The fluid TYPE field and the orderable fluid PART are independent LLM
    // extractions with no cross-check; the part's brand is only ever validated
    // against the CHASSIS make. On a badge-engineered car that lets a
    // chassis-brand fluid PN ride under a correct foreign-brand spec (batch-8:
    // a Mazda-built Yaris had trans_fluid_type "Mazda ATF FZ" but part
    // 00289-ATFWS = Toyota ATF WS; coolant "Mazda FL22" but part 00272-SLLC2 =
    // Toyota SLLC). When the fluid SPEC names a different marque than the make,
    // flag the PART for brand review. FLAG ONLY (batch-8 doctrine — never
    // rewrite a fluid part). Disable with FLUID_BRAND_VERIFY=0.
    if ((process.env.FLUID_BRAND_VERIFY ?? "1") !== "0") {
      for (const [typeKey, partKey] of FLUID_TYPE_TO_PART_FIELD) {
        const typeVal = allFields[typeKey]?.value;
        if (typeVal == null) continue;
        const foreign = fluidNamesForeignChassisBrand(String(typeVal), args.make);
        if (!foreign) continue;
        transFluidErrors.push(
          `fluid_brand_mismatch:${typeKey}:names_${foreign}_on_${args.make.toLowerCase()}`,
        );
        // W1.5 (G32): field = the PART field routed to brand review (the
        // flag+cap below lands there); reason carries the spec field name.
        lateSanityFlags.push(
          buildLateSanityFlag(
            "fluid_brand",
            partKey,
            "flag",
            `fluid_brand_mismatch:${typeKey}:names_${foreign}_on_${args.make.toLowerCase()}`,
            String(typeVal),
          ),
        );
        const pf = allFields[partKey];
        if (pf && pf.value != null) {
          allFields[partKey] = {
            ...pf,
            flagged: true,
            flag_reason: `fluid_brand_mismatch:spec_names_${foreign}_but_make_is_${args.make.toLowerCase()}`,
            confidence: Math.min(pf.confidence ?? 0.55, 0.55),
          };
        }
        console.warn(
          `[fluid-brand] ${typeKey} spec names "${foreign}" on a ${args.make} — ${partKey} flagged for brand review`,
        );
      }
    }

    // Pattern-suspect sentinel: >=2 oem_part_rejected gaps in ONE run means
    // the make's part pattern is probably wrong, not the data — every pattern
    // gap found so far (BMW leading zeros, VAG G-numbers, Hyundai fluid SKUs)
    // rejected multiple parts at once on its first vehicle. We can't predict
    // what car arrives next, so the run self-reports instead of waiting for a
    // human to read gap lists.
    // Rotor minimums — resolved AND persisted, never gated. classify() refuses
    // to grade a rotor with no minimum on file, so an unresolved axle is an
    // honest gap (the mechanic reads the number off the casting) rather than a
    // silent pass. A drum axle is not a gap. The resolver gets the cached
    // parts markdown (deterministic Tier-0 re-parse — previously backfill-only)
    // and the real fitted-axle set (previously assumed both, producing
    // spurious rear gaps on drum-rear cars). Sourced values persist through
    // patchVehicleConfig, double-gated by the label-aware parse inside the
    // resolver and validateRotorResolution; verified_fields still outranks.
    // ── Claim ledger: rival source adapters ────────────────────────────────
    // Runs BEFORE the rotor resolver so a catalogue-sourced discard minimum is
    // available to it, and before the completion gate so consensus outcomes
    // reach the same terminal run write as every other late gate.
    //
    // Gathering is evidence-only: it writes field_claims and returns consensus,
    // and never touches a vehicle field itself. Rotor minimums are the one
    // consumer wired today, under the resolver's existing double validation.
    //
    // Default ON but killable without a deploy. Adapters fail open individually
    // and the whole call is wrapped, so the worst case is an empty consensus —
    // which callers read as "no evidence", never as "no value".
    let claimConsensus: ClaimConsensus[] = [];
    if (process.env.ENRICHMENT_CLAIM_LEDGER !== "off" && !timedOut) {
      try {
        const gathered = await ctx.runAction(
          internal.vehicleEnrichment.claimGathering.gatherClaims,
          {
            vehicleConfigId: args.vehicleConfigId,
            runId: args.runId,
            year: args.year,
            make: args.make,
            model: args.model,
            trim: args.trim ?? null,
            engineCode: vehicle.engineCode ?? null,
            // `args.displacement` is a STRING through the whole pipeline
            // (`displacement: v.string()`), e.g. "2.4" or "2.4L". The adapters
            // want litres as a NUMBER for their displacement filters, and
            // passing the raw string here threw ArgumentValidationError and
            // killed the entire gather — silently, because the call is
            // wrapped non-fatally. Parse it, and treat an unparseable value as
            // absent rather than coercing it to 0, which would match nothing.
            displacementL: (() => {
              const n = parseFloat(String(args.displacement ?? "").replace(/[^0-9.]/g, ""));
              return Number.isFinite(n) && n > 0 ? n : null;
            })(),
            cylinders: enginePicData?.cylinders ?? null,
            // This run's own extracted values, entered as the web_search
            // family so the adapters have something to agree WITH. Without
            // them every field carries one family and the ledger can only ever
            // report single_source — real corroboration needs two independent
            // families on the SAME field.
            pipelineClaims: Object.entries(allFields)
              .filter(([, fv]) => fv?.value != null && fv.value !== "")
              .map(([key, fv]) => ({
                field_key: key,
                value: String(fv.value),
                source_url: fv.source_url ?? undefined,
                source_domain: fv.source_url
                  ? (extractDomain(fv.source_url) ?? undefined)
                  : undefined,
              })),
            // OEM numbers for the part-KEYED adapters (RockAuto), which can
            // only answer "is this number real, and what is it". Taken from
            // PART_FIELD_MAP so the field_key and role_key are the pipeline's
            // own, not a guess at RockAuto's naming.
            knownParts: Object.keys(PART_FIELD_MAP)
              .filter((key) => {
                const val = allFields[key]?.value;
                return typeof val === "string" && val.trim() !== "" &&
                  !val.startsWith("OTOPAIR-UNIV");
              })
              .map((key) => ({
                field_key: key,
                part_number: String(allFields[key]!.value),
                role_key: PART_FIELD_MAP[key].subcategory,
              })),
          },
        );
        claimConsensus = gathered.consensus;
        for (const c of claimConsensus) {
          if (c.outcome === "conflict_tie") {
            lateSanityFlags.push(
              buildLateSanityFlag(
                "claim_ledger",
                c.field_key,
                "flag",
                `cross-family conflict: ${c.dissent
                  .map((d) => `${d.value}[${d.families.join("+")}]`)
                  .join(" vs ")}`,
              ),
            );
          } else if (c.outcome === "consensus") {
            lateSanityFlags.push(
              buildLateSanityFlag(
                "claim_ledger",
                c.field_key,
                "info",
                `consensus across ${c.families.length} famil${c.families.length === 1 ? "y" : "ies"} ` +
                  `(${c.families.join("+")}), ${c.operators.length} operator(s), conf ${c.confidence}`,
                c.value ?? undefined,
              ),
            );
          }
        }
        if (gathered.skipped_headless.length > 0) {
          console.log(
            `[claim-ledger] ${gathered.skipped_headless.join(", ")} skipped — no headless fetch tier`,
          );
        }
      } catch (e) {
        // Non-fatal, but NOT invisible: a gather that never ran looks exactly
        // like a gather that found nothing (both leave field_claims empty), and
        // that ambiguity cost this round a full canary pass — an
        // ArgumentValidationError killed every gather while the run still
        // reported clean. The flag makes "the ledger failed" queryable on the
        // run row instead of only greppable in deploy logs.
        console.warn("[claim-ledger] gather failed (non-fatal):", e);
        lateSanityFlags.push(
          buildLateSanityFlag(
            "claim_ledger",
            "__claim_ledger",
            "flag",
            `gather failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
          ),
        );
      }
    }

    /** Reconciled catalogue minimum for one axle, or undefined when the ledger
     *  reached no consensus. A conflict_tie yields `value: null` and is
     *  therefore correctly absent — a tie must contribute nothing. */
    const catalogRotorClaim = (axle: "front" | "rear") => {
      const pick = (key: string) =>
        claimConsensus.find((c) => c.field_key === key && c.value != null);
      const min = pick(`rotor_${axle}_min_thickness_mm`);
      const nominal = pick(`rotor_${axle}_nominal_thickness_mm`);
      if (!min && !nominal) return undefined;
      return {
        minMm: min?.value != null ? Number(min.value) : null,
        nominalMm: nominal?.value != null ? Number(nominal.value) : null,
        observedLabel: null,
        sourceUrl: min?.source_urls?.[0] ?? nominal?.source_urls?.[0] ?? null,
      };
    };

    let rotorResolutions: RotorAxleResolution[] = [];
    const rotorResolverEvents: string[] = [];
    try {
      const cfgForRotor: any = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleConfigById,
        { vehicleConfigId: args.vehicleConfigId },
      );
      let rotorMarkdown: string | null = null;
      try {
        const cachedForRotor = await ctx.runQuery(
          internal.vehicleEnrichment.scraperQueries.getCachedScrape,
          {
            vehicleMake: args.make,
            vehicleModel: args.model,
            vehicleYear: args.year,
            vehicleTrim: args.trim ?? "",
            sourceType: "parts_catalog",
          },
        );
        rotorMarkdown = cachedForRotor?.markdown ?? null;
      } catch {
        // fail open — resolver degrades to classification-only
      }
      let rotorAxles: RotorAxle[] | undefined;
      try {
        const fitRows = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
          { vehicleConfigId: args.vehicleConfigId },
        );
        const axles = computeAxlesWithFitment(fitRows);
        rotorAxles = axles.length ? axles : undefined;
      } catch {
        // fail open — assume both axles fitted
      }
      rotorResolutions = resolveRotorMinimums({
        markdown: rotorMarkdown,
        existing: {
          front: {
            minMm: cfgForRotor?.rotor_front_min_thickness_mm ?? null,
            nominalMm: cfgForRotor?.rotor_front_nominal_thickness_mm ?? null,
            quality: cfgForRotor?.rotor_front_min_quality ?? null,
            observedLabel:
              cfgForRotor?.rotor_front_min_observed_label ??
              cfgForRotor?.rotor_min_observed_label ??
              null,
            sourceUrl: cfgForRotor?.rotor_min_source_url ?? null,
          },
          rear: {
            minMm: cfgForRotor?.rotor_rear_min_thickness_mm ?? null,
            nominalMm: cfgForRotor?.rotor_rear_nominal_thickness_mm ?? null,
            quality: cfgForRotor?.rotor_rear_min_quality ?? null,
            observedLabel:
              cfgForRotor?.rotor_rear_min_observed_label ??
              cfgForRotor?.rotor_min_observed_label ??
              null,
            sourceUrl: cfgForRotor?.rotor_min_source_url ?? null,
          },
        },
        naRoleKeys: (cfgForRotor?.na_role_keys ?? []) as string[],
        axlesWithFitment: rotorAxles,
        catalogClaims: {
          front: catalogRotorClaim("front"),
          rear: catalogRotorClaim("rear"),
        },
      });

      // Persist what the resolver sourced (previously discarded — healing was
      // human-only via the director backfill).
      const changedRes = rotorResolutions.filter((r) => r.changed);
      if (changedRes.length > 0) {
        const byAxle: Partial<Record<RotorAxle, RotorAxleResolution>> =
          Object.fromEntries(rotorResolutions.map((r) => [r.axle, r]));
        const verdict = validateRotorResolution({
          front: { minMm: byAxle.front?.minMm, nominalMm: byAxle.front?.nominalMm },
          rear: { minMm: byAxle.rear?.minMm, nominalMm: byAxle.rear?.nominalMm },
        });
        const rotorPatch: {
          rotor_front_min_thickness_mm?: number;
          rotor_rear_min_thickness_mm?: number;
          rotor_front_nominal_thickness_mm?: number;
          rotor_rear_nominal_thickness_mm?: number;
          rotor_front_min_quality?: string;
          rotor_rear_min_quality?: string;
          rotor_front_min_observed_label?: string;
          rotor_rear_min_observed_label?: string;
        } = {};
        for (const r of changedRes) {
          const isFront = r.axle === "front";
          if (r.minMm != null) {
            const rejectReason = verdict.rejects[r.axle];
            if (rejectReason) {
              rotorResolverEvents.push(
                `rotor_min:resolver_rejected:${r.axle}:${rejectReason}`,
              );
              lateSanityFlags.push(
                buildLateSanityFlag(
                  "rotor_resolver",
                  `rotor_${r.axle}_min_thickness_mm`,
                  "reject",
                  `rotor_min:resolver_rejected:${r.axle}:${rejectReason}`,
                  String(r.minMm),
                ),
              );
            } else {
              const flagReason = verdict.flags[r.axle];
              const quality =
                flagReason && r.quality === "oem_spec"
                  ? "oem_spec_flagged"
                  : r.quality ?? "oem_spec";
              if (isFront) {
                rotorPatch.rotor_front_min_thickness_mm = r.minMm;
                rotorPatch.rotor_front_min_quality = quality;
                if (r.observedLabel)
                  rotorPatch.rotor_front_min_observed_label = r.observedLabel;
              } else {
                rotorPatch.rotor_rear_min_thickness_mm = r.minMm;
                rotorPatch.rotor_rear_min_quality = quality;
                if (r.observedLabel)
                  rotorPatch.rotor_rear_min_observed_label = r.observedLabel;
              }
              if (flagReason) {
                rotorResolverEvents.push(
                  `rotor_min:resolver_flagged:${r.axle}:${flagReason}`,
                );
                lateSanityFlags.push(
                  buildLateSanityFlag(
                    "rotor_resolver",
                    `rotor_${r.axle}_min_thickness_mm`,
                    "flag",
                    `rotor_min:resolver_flagged:${r.axle}:${flagReason}`,
                    String(r.minMm),
                  ),
                );
              }
            }
          }
          if (r.nominalMm != null) {
            const nomBand = ROTOR_NOMINAL_BANDS[r.axle];
            if (r.nominalMm >= nomBand.rejectMin && r.nominalMm <= nomBand.rejectMax) {
              if (isFront) rotorPatch.rotor_front_nominal_thickness_mm = r.nominalMm;
              else rotorPatch.rotor_rear_nominal_thickness_mm = r.nominalMm;
            }
          }
        }
        if (Object.keys(rotorPatch).length > 0) {
          await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.patchVehicleConfig,
            { vehicle_config_id: args.vehicleConfigId, ...rotorPatch },
          );
          rotorResolverEvents.push(
            `rotor_min:resolver_persisted:${Object.keys(rotorPatch).join(",")}`,
          );
          lateSanityFlags.push(
            buildLateSanityFlag(
              "rotor_resolver",
              "rotor_min",
              "info",
              `rotor_min:resolver_persisted:${Object.keys(rotorPatch).join(",")}`,
            ),
          );
        }
      }
    } catch (e) {
      console.warn("[v8/rotor-min] resolution read failed (non-fatal):", e);
    }
    const rotorGapEntries = rotorResolutions.flatMap((r) => {
      const reason = rotorGapReason(r.outcome);
      return reason
        ? [{ field: `rotor_${r.axle}_min_thickness_mm`, reason }]
        : [];
    });
    const rotorErrors = [
      ...rotorResolutions.flatMap((r) => {
        const tag = rotorErrorTag(r);
        return tag ? [tag] : [];
      }),
      ...rotorResolverEvents,
    ];
    const rotorGapAxles = rotorMinGaps(rotorResolutions);

    const finalGaps = [
      ...classifyFieldGaps(allFields, sanityFlags, finalIdentity),
      ...priceGaps,
      // Round 12: role re-source outcomes — resource_never_found feeds the
      // lifetime attempt cap; resource_not_applicable documents drum-brake-
      // class findings alongside the durable na_role_keys write.
      ...roleResourceGaps,
      ...rotorGapEntries,
    ];
    const partRejectCount = finalGaps.filter((g) =>
      g.reason.startsWith("validation_dropped:oem_part_rejected"),
    ).length;
    if (partRejectCount >= 2) {
      console.warn(
        `[v8] PATTERN SUSPECT: ${partRejectCount} oem_part_rejected gaps for make=${args.make} — ` +
          `likely a pattern gap, triage via devOnly/auditPartRejections:audit`,
      );
    }

    // Round 12: role-identity rejections (wrong COMPONENT in a role — the
    // Equinox battery-cable class). classifyFieldGaps already ledgers each as
    // validation_dropped:role_identity_rejected:…; mirror them into errors[]
    // so the run lands in the review queue. A make-wide spike here means a
    // lexicon bug (one-file revert), not bad data.
    const roleIdentityRejects = finalGaps.filter((g) =>
      g.reason.startsWith("validation_dropped:role_identity_rejected"),
    );
    // W1.5 (G33): structured mirror — the gap's full reason carries the
    // observed listing title, richer than the errors[] string below.
    lateSanityFlags.push(
      ...roleIdentityRejects.map((g) =>
        buildLateSanityFlag("role_identity", g.field, "reject", g.reason),
      ),
    );

    // Write fence, second check: the discretionary stages above can run for
    // minutes — re-verify this chain still owns the run before the finalize
    // writes (run status, config status, quotability) land. The additive
    // part/price writes above are deliberately NOT fenced individually.
    if (await chainFenced(ctx, args, args.lateCollect === true, "pollBatch2:finalize")) return;

    // W1.5 (G38 transparency): ONE completion-gate evaluation, hoisted from
    // the upsertVehicleConfig args below — computed once here, recorded once
    // (structured info flag on the run row), applied once (the config's
    // enrichment_status). Previously the decision string only ever reached
    // the console. Pure inputs; nothing between here and the upsert mutates
    // them, so the applied status is byte-identical to the old inline IIFE.
    // Interval-provenance census. An interval whose data_quality is
    // "default_fallback", or whose months came only from the default top-up, is
    // an invented cadence wearing the same shape as a real OEM schedule — the
    // canary carried 11 of 27 and nothing surfaced it, because the fill metric
    // counts a fallback row as filled. Computed here so it lands in the ONE
    // terminal run write alongside the other late-gate facts.
    let intervalProvenanceGapStrings: string[] = [];
    try {
      const intervalRows = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getIntervalProvenance,
        { vehicleConfigId: args.vehicleConfigId },
      );
      intervalProvenanceGapStrings = intervalRows
        .filter((row) => row.data_quality === "default_fallback" || row.months_from_default)
        .map((row) =>
          row.data_quality === "default_fallback"
            ? `${row.slug || "?"}:interval`
            : `${row.slug || "?"}:months`,
        )
        .sort();
      if (intervalProvenanceGapStrings.length > 0) {
        lateSanityFlags.push(
          buildLateSanityFlag(
            "interval_provenance",
            "__interval_provenance",
            "info",
            `${intervalProvenanceGapStrings.length}/${intervalRows.length} interval(s) rest on the ` +
              `default table: ${intervalProvenanceGapStrings.slice(0, 12).join(", ")}` +
              (intervalProvenanceGapStrings.length > 12 ? ", …" : ""),
          ),
        );
      }
    } catch (e) {
      console.warn("[v8/interval-provenance] census failed (non-fatal):", e);
    }

    const completionGateInput = {
      fillRate,
      quotabilityPct: quotability?.pct,
      hasPriceGaps: priceGaps.length > 0,
      // Round 12: post-repair completeness facts. Env-staged (default
      // log) — see completionGate.ts for the enforce rollout contract.
      missingCoreRoles: missingCoreRoleStrings,
      axlePairGaps: axlePairGapStrings,
      rotorMinGaps: rotorGapAxles,
      intervalProvenanceGaps: intervalProvenanceGapStrings,
    };
    const completionGateStatus = computeEnrichmentStatus(completionGateInput);
    const completionGateExplain = explainGateDecision(completionGateInput);
    console.log(`[v8] Completion gate → ${completionGateStatus}: ${completionGateExplain}`);
    lateSanityFlags.push(
      buildLateSanityFlag(
        "completion_gate",
        "__completion_gate",
        "info",
        completionGateExplain,
      ),
    );

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
      fields_filled: fieldsFilledCount,
      fields_total: V4_FIELD_KEYS.length,
      fields_not_applicable: fieldsNotApplicable,
      applicable_fill_rate: applicableFillRate,
      fill_rate: fillRate,
      fields_changed: V4_FIELD_KEYS.filter((k) => allFields[k]?.value != null),
      errors: [
        ...(timedOut ? ["batch2_timeout"] : []),
        // Batch-2's own parse verdict (json_extraction_empty / _failed /
        // _empty_payload / API "errored"). Before this it lived only in the
        // console and the step trace's status — the run row said nothing, so
        // auditByVin tallied zero and the Aug-2026 empty-services runs could
        // only be diagnosed by pulling raw batch results from the API.
        ...(r2?.error ? [`batch2_result_error:${String(r2.error).slice(0, 200)}`] : []),
        // Services rescue outcome: _used means batch-2's services leg came
        // back empty (even when no result_error was flagged — the fields-only
        // partial shape) and the synchronous re-ask restored it; _failed means
        // the structural fallback was the last resort.
        ...batch2RescueErrors,
        // The run finalized thin at the 3h timeout and this pass applied the
        // paid batch's gap-fill afterwards — history marker, not an error.
        ...(args.lateCollect ? ["late_collected"] : []),
        // Weak parts coverage routes into the manual review queue without
        // changing status semantics (a data-complete run stays "complete").
        ...(quotability && quotability.pct < 0.8 ? [`quotability:${quotability.pct}`] : []),
        // Repeated part rejections on one run = suspect make pattern, not bad
        // data — routes to review so unknown formats on NEW makes surface.
        ...(partRejectCount >= 2 ? [`part_pattern_suspect:${args.make}:${partRejectCount}`] : []),
        // Round 12: each wrong-component rejection, named per field.
        ...roleIdentityRejects.map((g) => `role_identity_rejected:${g.field}`),
        // Round 12: role re-source outcomes + half-covered axle pairs — the
        // Crosstrek's rear-only brake data now routes to review even while the
        // status gates are still in log stage.
        ...roleResourceErrors,
        // Fitment-verification refutations: wrong-vehicle parts removed at
        // finalize (the fitment rows are already deleted; this is the audit
        // trail + review-queue routing).
        ...fitmentRefutedErrors,
        // Transmission-fluid suspicions: a fluid the round-6 gate believes may
        // be the wrong family/generation for this unit — FLAGGED for review,
        // value left unchanged (the verifier isn't trusted to overwrite).
        ...transFluidErrors,
        // Rotor minimums we could not source. Bucketed under one `rotor_min`
        // prefix so a fleet-wide coverage gap reads as one flag, not noise.
        ...rotorErrors,
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
        // Round 12: half-covered axle pairs — deterministic and threshold-
        // free, so the Crosstrek shape surfaces in review regardless of pct.
        ...axleGapSanityFlags,
        // W1.5 (G32/G33): the post-write finalize gates' structured outcomes
        // (trans_fluid / fluid_brand / fitment_refute / role_identity /
        // rotor_resolver / completion_gate) — previously string-only in
        // errors[] because this array was snapshotted before they ran.
        ...lateSanityFlags,
      ],
      field_gaps: finalGaps,
      quotability,
    });

    // Trace: finalize stage — the run's terminal snapshot.
    await traceStep(ctx, {
      run_id: args.runId,
      vehicle_config_id: args.vehicleConfigId,
      step: "finalize",
      seq: 5,
      status: timedOut ? "timeout" : "ok",
      ended_at: Date.now(),
      summary: `fill ${fillRate}% · applicable ${applicableFillRate}% · quotability ${quotability?.pct ?? "—"} · ${sanityFlags.length} sanity · ${finalGaps.length} gaps`,
      response_text: JSON.stringify(
        {
          fill_rate: fillRate,
          applicable_fill_rate: applicableFillRate,
          fields_filled: fieldsFilledCount,
          fields_total: V4_FIELD_KEYS.length,
          quotability,
          sanity_flags: sanityFlags,
          field_gaps: finalGaps,
        },
        null,
        2,
      ),
    });

    // Read current vehicle_config to get resolved drivetrain
    const currentVcForFinal = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicleConfigId },
    );

    // Config-key migration (batch-2 audit, Jul 2026): when this run holds a
    // REAL engine code (verified resolution threaded through args, or a
    // clean decode) and the stored key differs — e.g. a reused row keyed by
    // an old fabricated code — rename toward the correct key so future
    // decodes cache-hit instead of spawning duplicates. Placeholder codes
    // never migrate; conflicts keep the old key and self-report.
    let finalConfigKey = currentVcForFinal?.config_key ?? buildEngineKey(vehicle);
    {
      const desiredKey = buildEngineKey(vehicle);
      if (
        currentVcForFinal &&
        currentVcForFinal.config_key !== desiredKey &&
        !isNhtsaDescriptor(vehicle.engineCode ?? "")
      ) {
        try {
          const res: any = await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.renameConfigKey,
            { vehicle_config_id: args.vehicleConfigId, new_key: desiredKey },
          );
          if (res?.renamed) finalConfigKey = desiredKey;
        } catch (e) {
          console.warn("[v8] config_key migration failed (non-fatal):", e);
        }
      }
    }

    // Update vehicle_config status — use the (possibly migrated) key
    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertVehicleConfig, {
      config_key: finalConfigKey,
      year: args.year,
      make_id: args.makeId,
      model_id: (await ctx.runQuery(internal.vehicleEnrichment.v3queries.getModelByMakeAndName, { makeId: args.makeId, name: args.model }))?._id ?? args.makeId as any,
      engine_id: args.engineId,
      transmission_id: args.transmissionId,
      // The resolved config drivetrain (NHTSA axle-authoritative) wins over the
      // raw LLM field here too — otherwise finalize re-overwrites the reconciled
      // value with the same Batch-1B guess (batch-3 drivetrain fix).
      drivetrain:
        reconcileDrivetrain(
          currentVcForFinal?.drivetrain,
          allFields.drivetrain?.value as string | null,
        ) ??
        currentVcForFinal?.drivetrain ??
        (allFields.drivetrain?.value as string) ??
        "FWD",
      trim_name: args.trim,
      trim_slug: slugify(args.trim),
      // W1.5: evaluated ONCE just before the finalize updateEnrichmentRun
      // (see completionGateStatus above) — same inputs, same decision; the
      // explain string is persisted as a structured completion_gate flag.
      enrichment_status: completionGateStatus,
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

    // Instant heal (Aug 2026): bookability must not wait for the nightly cron.
    // The mid-finalize price census (~4780) runs BEFORE the late gates, so a
    // part written by role-repair — or the survivor left after a pass-2
    // refutation — finishes the run unpriced with nothing scheduled to fix it
    // (GLC-43 run 4: battery + spark plug). healAfterRun re-censuses from the
    // DB after EVERYTHING has run: one more role-repair pass for holes the
    // late gates opened, then the targeted per-config price backfill, each in
    // its own action budget. Self-noops on a clean run, so it is scheduled
    // unconditionally (including on late collection — the bonus gap-fill can
    // create the same late-born parts). Kill switch: PARTS_IMMEDIATE_HEAL=off.
    if (process.env.PARTS_IMMEDIATE_HEAL !== "off") {
      try {
        await ctx.scheduler.runAfter(
          5_000, // let the terminal writes settle, same as source discovery
          internal.vehicleEnrichment.resourceRoles.healAfterRun,
          { vehicleConfigId: args.vehicleConfigId },
        );
        console.log("[v8] instant heal scheduled (role repair + targeted price backfill)");
      } catch (e) {
        console.warn("[v8] instant heal scheduling failed (non-fatal):", e);
      }
    }

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
    // Wave-1/2 (Aug 2026): OFF by default. source_registry is the DIRECTOR's
    // reference surface (data portal /sources), not scraper config — and it
    // fills as a byproduct of runs (sourceScoring auto-registers every
    // evidence domain; upsertPartPrice registers price domains), so the
    // speculative web-search finder here only burned Firecrawl+Haiku to
    // discover sources the run itself would have recorded for free.
    // Re-enable with ENRICHMENT_SOURCE_DISCOVERY=on if ever needed.
    try {
      const existingSources =
        process.env.ENRICHMENT_SOURCE_DISCOVERY === "on"
          ? await ctx.runQuery(
              internal.vehicleEnrichment.v3queries.getSourcesForMake,
              { make_id: args.makeId },
            )
          : null;
      if (existingSources && existingSources.length < 3) {
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
          // Same two-leg gate as the finalize upsert — a fill-only improvement
          // must not flip an unquotable config to complete.
          enrichment_status: computeEnrichmentStatus({
            fillRate: finalFillRate,
            quotabilityPct: quotability?.pct,
            hasPriceGaps: priceGaps.length > 0,
          }),
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

    // NHTSA ODI (recalls + complaint signals) — free public-domain data,
    // refreshed per config after enrichment. Fail-open end to end; the daily
    // refresh-nhtsa-odi cron keeps it current afterward.
    try {
      await ctx.scheduler.runAfter(
        15_000,
        internal.vehicleEnrichment.nhtsaOdi.refreshOdiForConfig,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.warn("[v8] NHTSA ODI refresh trigger failed (non-fatal):", e);
    }

    // ── EPA fuel economy (round 15b) ────────────────────────────────────────
    // epaFuelEconomy.ts advertised `refreshEpaForConfig` as a per-config
    // wire-in point from the day it shipped, and the call was never written:
    // its ONLY caller was its own daily stale sweep (crons.ts), which is capped
    // and age-filtered. So a freshly enriched config carried no EPA row at all
    // — `epa_joined: false` on 10/10 audited vehicles across rounds 15 and 15b,
    // and the commit that shipped the module recorded the symptom ("EPA did not
    // join despite its hook being scheduled") without finding the cause.
    //
    // This is not only MPG/CO2. The module stores the EPA record's own
    // displacement/cylinders/turbo/fuel-type and computes `coherence_mismatch`
    // — a government-backed second opinion on engine identity that the P0.3
    // identity-coherence gate consumes. With no row, that gate has no input,
    // which is why `identity.epa_says` audits as null.
    //
    // Scheduled, not awaited: the join is two public API calls with a 15s abort
    // each, and it must not spend this action's 600s budget. It runs after the
    // engine identity it corroborates is already persisted. The picker never
    // guesses — an engine it cannot match to exactly one EPA option stores
    // nothing — so the worst case is the status quo.
    try {
      await ctx.scheduler.runAfter(
        20_000,
        internal.vehicleEnrichment.epaFuelEconomy.refreshEpaForConfig,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.warn("[v8] EPA economy refresh trigger failed (non-fatal):", e);
    }

    // ── Agent research: rotor minimums (round 19) ───────────────────────────
    //
    // LAST RESORT, and only on positive evidence that the deterministic path
    // produced nothing: fires solely when BOTH axles are still null after the
    // rotor resolver, its adapters, and the whole run have had their turn.
    //
    // Round 19 measured the need — 0 of 12 axles populated, and 0 across ~30
    // vehicles over five rounds, with `brembo` absent from adapters_seen on
    // every one. This is the tool filter's criterion: data we cannot get today.
    //
    // Scheduled and never awaited: one agent task runs ~226s (measured), far
    // beyond what this action's remaining budget can absorb. It writes CLAIMS
    // only — the rotor resolver's existing double validation still decides
    // whether any of it becomes a stored minimum, which is what stops an
    // aftermarket retailer's product dimension being promoted to a
    // manufacturer discard spec.
    //
    // Off unless ENRICHMENT_AGENT=on, so this costs nothing until switched on.
    try {
      const cfgForRotor: any = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleConfigById,
        { vehicleConfigId: args.vehicleConfigId },
      );
      const rotorStillMissing =
        cfgForRotor?.rotor_front_min_thickness_mm == null &&
        cfgForRotor?.rotor_rear_min_thickness_mm == null;
      if (rotorStillMissing && process.env.ENRICHMENT_AGENT === "on") {
        await ctx.scheduler.runAfter(
          30_000,
          internal.vehicleEnrichment.agentResearch.researchRotorMinimums,
          {
            vehicleConfigId: args.vehicleConfigId,
            runId: args.runId,
            year: args.year,
            make: args.make,
            model: args.model,
            trim: args.trim ?? null,
            engineCode: vehicle.engineCode ?? null,
            displacement: args.displacement ?? null,
          },
        );
        console.log("[v8] agent rotor research scheduled (both axles still null)");
      }
    } catch (e) {
      console.warn("[v8] agent rotor research trigger failed (non-fatal):", e);
    }

    // ── Agent research: roles the deterministic path EXHAUSTED ─────────────
    //
    // `never_found` is the only outcome that qualifies, and the distinction is
    // load-bearing. `skipped_run_budget` / `skipped_lifetime_cap` mean UNTRIED
    // — more budget would try them, so paying an agent skips a cheaper answer.
    // `rejected_*` means found and REJECTED — a research pass would simply
    // re-find the number the gates just threw out.
    //
    // Round 19 sized it: 11 residual `never_found` across 5 vehicles, EIGHT of
    // them on the Chevrolet Equinox — precisely why that config finished at 3
    // roles while the F-150 reached 13. Concentrated where it is needed.
    try {
      if (process.env.ENRICHMENT_AGENT === "on") {
        const exhausted = roleResourceErrors
          .map((e) => /^role_resource(?:_pass2)?:([^:]+):never_found$/.exec(e)?.[1])
          .filter((r): r is string => !!r);
        const uniqueRoles = [...new Set(exhausted)];
        if (uniqueRoles.length > 0) {
          const fieldFor: Record<string, string> = {};
          for (const [fieldKey, meta] of Object.entries(PART_FIELD_MAP)) {
            fieldFor[(meta as any).subcategory] = fieldKey;
          }
          // The blocklist travels with the request: a rejected number that
          // dominates the open web is exactly what a research agent re-finds.
          const blockedRows: any[] = await ctx
            .runQuery(internal.vehicleEnrichment.v3queries.getBlockedOemsForConfig, {
              vehicleConfigId: args.vehicleConfigId,
            })
            .catch(() => []);
          await ctx.scheduler.runAfter(
            60_000,
            internal.vehicleEnrichment.agentResearch.researchMissingRoles,
            {
              vehicleConfigId: args.vehicleConfigId,
              runId: args.runId,
              year: args.year,
              make: args.make,
              model: args.model,
              trim: args.trim ?? null,
              engineCode: vehicle.engineCode ?? null,
              displacement: args.displacement ?? null,
              roles: uniqueRoles.map((roleKey) => ({
                roleKey,
                fieldKey: fieldFor[roleKey] ?? roleKey,
              })),
              blockedOems: (blockedRows ?? [])
                .map((b: any) => String(b?.oem_part_number_normalized ?? ""))
                .filter(Boolean),
            },
          );
          console.log(
            `[v8] agent role research scheduled for ${uniqueRoles.length} exhausted role(s): ` +
              uniqueRoles.join(", "),
          );
        }
      }
    } catch (e) {
      console.warn("[v8] agent role research trigger failed (non-fatal):", e);
    }

    // ── Labor retry (2020 Yaris canary, Jul 30 2026) ────────────────────────
    // The inline labor pass lives inside `if (r2)`, so a batch-2 timeout or an
    // unparseable batch-2 body means NO labor source is ever contacted — and
    // `ensureAllLaborTimes` above then stamps every row `default_fallback`
    // (canary: 27/27, worse than the 64% fleet baseline). Labor does not need
    // batch 2: OLP and the RepairPal estimate endpoint key off make/model/year/
    // engine/drivetrain, all of which come from batch 1 and the DB.
    //
    // `laborRelaborConfig` is the existing per-config driver that resolves the
    // OLP buildId and calls the same `laborAllSources` orchestrator with the
    // DB-derived, applicability-gated service list. Scheduling it (rather than
    // inlining) keeps it out of this action's 600s budget — the RepairPal
    // resolver alone sleeps 140ms per service plus retry backoff.
    //
    // Ordering is safe against the fallback seeder that just ran:
    // recomputeLaborForConfigService PATCHES an existing row when catalog
    // observations drive book_hours, relabelling source/data_quality to
    // "aggregated". So a default_fallback row seeded a moment ago is upgraded,
    // not duplicated, when real hours land.
    //
    // Fires only when the inline pass produced nothing — never both, so the
    // happy path pays for OLP/RepairPal exactly once.
    const laborNeedsRetry = laborOutcome == null || laborOutcome.written === 0;
    if (laborNeedsRetry) {
      try {
        await ctx.scheduler.runAfter(
          20_000,
          internal.vehicleEnrichment.laborRelabor.laborRelaborConfig,
          { vehicleConfigId: args.vehicleConfigId },
        );
        console.warn(
          `[v8/labor] inline labor produced ${laborOutcome == null ? "NOTHING (batch-2 absent)" : "0 rows"} ` +
            `— scheduled laborRelaborConfig retry`,
        );
      } catch (e) {
        console.warn("[v8/labor] labor retry trigger failed (non-fatal):", e);
      }
    }

    // ── Manual library (months intervals) ───────────────────────────────────
    // OEM maintenance PDFs are the only source that carries real MONTHS
    // intervals; storefront listings and the LLM's own schedule guesses carry
    // miles. Until now manualLibrary was reachable ONLY from the nightly
    // backfill cron (3 configs/night), so a fresh config finalized with
    // has_manual:false and months at 19%.
    //
    // Scheduled, never inline: the chain is a multi-MB PDF download plus a
    // Files API upload plus a large-context extraction, and this action is hard
    // -killed at 600s. Resolve first, then extract — the two are separate
    // actions, and extract no-ops with "no_manual_file" if resolve found
    // nothing, so the delay gap is a safe coupling rather than a race that can
    // corrupt anything.
    //
    // `force` is NOT set: shouldSkipManualLookup's negative cache is the whole
    // point of not re-paying for a manual that is known to be missing.
    if (process.env.ENRICHMENT_MANUAL_LIBRARY !== "off") {
      try {
        await ctx.scheduler.runAfter(
          25_000,
          internal.vehicleEnrichment.manualLibrary.resolveManualForVehicle,
          { make: args.make, model: args.model, year: args.year },
        );
        const extractDelayMs = Number(process.env.ENRICHMENT_MANUAL_EXTRACT_DELAY_MS ?? "180000");
        await ctx.scheduler.runAfter(
          extractDelayMs,
          internal.vehicleEnrichment.manualLibrary.extractIntervalsFromManual,
          { vehicleConfigId: args.vehicleConfigId },
        );

        // ── Second pass over the SAME uploaded PDF: the specifications table ──
        // The interval pass answers one question; the document also carries
        // capacities, viscosities, fluid specs, pressures and torque. This pass
        // files those as field_claims (family owners_manual, weight 3) rather
        // than writing them, so the reconciler weighs them against the
        // storefront/aggregator claims already on file — AMSOIL and a manual
        // agreeing is the first two-family, quote-grade evidence those fields
        // have ever had.
        //
        // Deliberately close behind the interval pass: the document block
        // carries cache_control, so landing inside the cache window makes this
        // read ~10% the price of a cold ingest. 60s is comfortably inside the
        // 5-minute ephemeral TTL while still leaving the first call room to
        // finish a large PDF.
        if (process.env.ENRICHMENT_MANUAL_SPECS !== "off") {
          await ctx.scheduler.runAfter(
            extractDelayMs + 60_000,
            (internal as any).vehicleEnrichment.manualSpecs.extractSpecsFromManual,
            { vehicleConfigId: args.vehicleConfigId, runId: args.runId },
          );
        }
        console.log("[v8] Manual library resolve + extract (+specs) scheduled");
      } catch (e) {
        console.warn("[v8] Manual library trigger failed (non-fatal):", e);
      }
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
