/**
 * seedCamryBaseline.ts — Pricing v2 (spec May 29 2026) Part 2.
 *
 * Seeds the 2020 Toyota Camry LE (FWD + AWD) as the 1.0× anchor for the
 * Pricing v2 quote engine. The engine A25A-FKS is shared between FWD and
 * AWD trims; the AWD trim adds a rear differential + transfer case.
 *
 * Writes:
 *   - makes / models / engines      (defensive find-or-create)
 *   - vehicle_configs                (FWD + AWD, with pricing_tier='T1')
 *   - service_vehicle_specs          (10 anchor services × shared engine —
 *                                     parts_cost_low/high are the dealer
 *                                     parts-counter ±6% band per spec Part 2)
 *   - labor_times                    (23 services on the FWD config; midpoint
 *                                     when spec gives a range)
 *
 * Run:
 *   npx convex run seeds/seedCamryBaseline:run
 *
 * Idempotent. Re-running upserts in place. Hard-fails if Toyota or Camry
 * are missing from makes/models — those should pre-exist.
 */

import { internalMutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";

const TOYOTA_MAKE_NAME = "Toyota";
const CAMRY_MODEL_NAME = "Camry";
const CAMRY_YEAR = 2020;
const ENGINE_CODE = "A25A-FKS";
const ENGINE_FAMILY = "A25A";

// ─── Part 2 — OEM Camry baseline parts (dealer parts-counter ±6%) ──────────

type BaselineSpec = {
  service_slug: string;
  parts_low: number;
  parts_high: number;
  oem_part_number?: string;
  parts_cost_basis: string;
  applies_to: "shared" | "awd_only";
  /** Per Pricing v2 — how many units the parts_low/parts_high band represents
   *  on this Camry baseline. Other vehicles scale by (vehicle_count / baseline).
   *    per_axle      → 1
   *    per_cylinder  → 4 (Camry A25A-FKS is inline-4)
   *    per_unit_spec → engine capacity count on Camry
   *    per_wheel     → 4 (always)
   *    fixed_kit     → 1 */
  parts_baseline_unit_count: number;
};

const BASELINE: ReadonlyArray<BaselineSpec> = [
  {
    service_slug: "oil_change",
    // Single OEM oil filter — shops supply the engine oil from stock, so
    // it's not billed as a customer line item. Reclassified to fixed_kit
    // on 2026-06-09; the previous (50, 56) band reflected oil + filter +
    // gasket combined, which was multiplied by oil_capacity_qts at quote
    // time and produced the "$110/qt" bug on the Stelvio.
    parts_low: 12, parts_high: 18,
    oem_part_number: "04152-YZZA1",
    parts_cost_basis: "1× Toyota cartridge oil filter (NYC parts-counter, ±20%)",
    applies_to: "shared",
    parts_baseline_unit_count: 1,
  },
  {
    service_slug: "filter_replacement",
    parts_low: 52, parts_high: 58,
    parts_cost_basis: "Both genuine Toyota (engine + cabin)",
    applies_to: "shared",
    parts_baseline_unit_count: 1, // fixed_kit
  },
  {
    service_slug: "spark_plugs",
    parts_low: 80, parts_high: 90,
    oem_part_number: "90919-01289",
    parts_cost_basis: "OEM iridium set of 4 — verify counter price",
    applies_to: "shared",
    parts_baseline_unit_count: 4, // per_cylinder — Camry is I4
  },
  {
    // Front pads canonical; rear ($52-58, 04466-AZ207) noted in basis.
    service_slug: "brake_pad_replacement",
    parts_low: 55, parts_high: 62,
    oem_part_number: "04465-AZ227",
    parts_cost_basis:
      "Genuine Toyota front pad set. Rear pair: $52-58 / 04466-AZ207. XSE EPB adds +0.3hr coding.",
    applies_to: "shared",
    parts_baseline_unit_count: 1, // per_axle (front)
  },
  {
    service_slug: "brake_fluid_flush",
    parts_low: 14, parts_high: 16,
    parts_cost_basis: "DOT 3, 1L",
    applies_to: "shared",
    parts_baseline_unit_count: 1, // fixed_kit
  },
  {
    service_slug: "battery_replacement",
    parts_low: 155, parts_high: 175,
    oem_part_number: "00544-35060",
    parts_cost_basis: "Toyota TrueStart (84-mo) Group 35",
    applies_to: "shared",
    parts_baseline_unit_count: 1, // fixed_kit
  },
  {
    service_slug: "coolant_flush",
    parts_low: 55, parts_high: 61,
    parts_cost_basis: "~2 gal Toyota SLLC (pink), system capacity ~1.7 gal",
    applies_to: "shared",
    // Camry coolant capacity ≈ 1.7 gal ≈ 6.8 qts — round to 7 for the baseline.
    parts_baseline_unit_count: 7,
  },
  {
    service_slug: "transmission_service",
    parts_low: 49, parts_high: 55,
    parts_cost_basis: "~4 qt Toyota WS, drain-and-fill (aftermarket not advised)",
    applies_to: "shared",
    parts_baseline_unit_count: 4, // ~4 qt drain-and-fill
  },
  {
    service_slug: "differential_service",
    parts_low: 42, parts_high: 48,
    parts_cost_basis: "Toyota diff oil, 2qt (rear diff + transfer case). AWD only.",
    applies_to: "awd_only",
    // per_unit_spec conversion (2026-07): the $42-48 band explicitly covers
    // 2 qt per parts_cost_basis, so the baseline is 2 — leaving it at 1 would
    // double/triple every differential quote once capacities scale.
    parts_baseline_unit_count: 2,
  },
];

// ─── Camry labor hours (Part 2 — midpoint when given a range) ──────────────

export const CAMRY_LABOR_HOURS: ReadonlyArray<{ service_slug: string; book_hours: number }> = [
  { service_slug: "oil_change",            book_hours: 0.5 },
  { service_slug: "filter_replacement",    book_hours: 0.3 },
  { service_slug: "spark_plugs",           book_hours: 1.15 },  // 0.9-1.4 midpoint (used in Ex C)
  { service_slug: "coolant_flush",         book_hours: 1.0 },
  { service_slug: "transmission_service",  book_hours: 1.5 },   // 1.4-1.6 midpoint
  { service_slug: "brake_fluid_flush",     book_hours: 0.7 },
  { service_slug: "battery_replacement",   book_hours: 0.4 },
  { service_slug: "pre_purchase_inspection", book_hours: 1.75 }, // 1.5-2.0 midpoint
  { service_slug: "state_inspection",      book_hours: 0.5 },
  { service_slug: "fuel_system_cleaning",  book_hours: 0.5 },
  { service_slug: "differential_service",  book_hours: 1.15 },  // 1.0-1.3 midpoint
  { service_slug: "tire_rotation",         book_hours: 0.4 },
  { service_slug: "tire_balance",          book_hours: 0.6 },
  { service_slug: "wheel_alignment",       book_hours: 1.0 },
  // Anchors added 2026-06-13 so the tier fallback/guardrail exists for these.
  // rotor_replacement: ROTORS-ONLY R&R (our scope is rotors-only — olpLabor.ts
  // :165-166) ≈ pad-removal labor + hub clean/measure; NOT pads+rotors (that
  // would double-count vs brake_pad_replacement's 1.4h). power_steering_flush:
  // routine fluid exchange. timing_belt is intentionally omitted — see header.
  { service_slug: "rotor_replacement",      book_hours: 1.8 },
  { service_slug: "power_steering_flush",   book_hours: 0.6 },
  // Front pads canonical (rear is 1.5 — see service_options for split).
  { service_slug: "brake_pad_replacement", book_hours: 1.4 },   // front 1.1-1.7 midpoint
  { service_slug: "battery_test",          book_hours: 0.2 },
  { service_slug: "diagnostic_scan",       book_hours: 0.5 },
  { service_slug: "check_engine_light",    book_hours: 1.0 },
  { service_slug: "emissions_test",        book_hours: 0.3 },
];

const LABOR_TIMES_SOURCE = "vdb_camry_baseline";
const LABOR_TIMES_CONFIDENCE = 0.9;

// ─── Seed runner ────────────────────────────────────────────────────────────

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // 1) Find Toyota make
    const toyota = await ctx.db
      .query("makes")
      .withIndex("by_name", (q) => q.eq("name", TOYOTA_MAKE_NAME))
      .first();
    if (!toyota) {
      throw new Error(
        `seedCamryBaseline: makes table has no 'Toyota'. Seed makes first.`,
      );
    }

    // 2) Find Camry model under Toyota (models table has no compound index;
    //    collect-and-filter is fine — models is a small reference table.)
    const allModels = await ctx.db.query("models").collect();
    let camryModelDoc = allModels.find(
      (m: any) => m.name === CAMRY_MODEL_NAME && m.make_id === toyota._id,
    );
    if (!camryModelDoc) {
      // Defensive find-or-create (mirrors the engine + config handling below).
      // The Camry model is the anchor's parent row; creating it here keeps the
      // seed self-sufficient instead of hard-failing when the catalog lacks it
      // (the failure that silently left the fallback anchor unseeded).
      const camryModelId = await ctx.db.insert("models", {
        make_id: toyota._id,
        name: CAMRY_MODEL_NAME,
        slug: "camry",
        created_at: now,
      });
      camryModelDoc = (await ctx.db.get(camryModelId))!;
    }

    // 3) Find or create the A25A-FKS engine (shared between FWD + AWD trims)
    let engine = await ctx.db
      .query("engines")
      .withIndex("by_engine_code", (q) => q.eq("engine_code", ENGINE_CODE))
      .first();
    let engineCreated = false;
    if (!engine) {
      const engineId = await ctx.db.insert("engines", {
        engine_code: ENGINE_CODE,
        engine_family: ENGINE_FAMILY,
        make_id: toyota._id,
        cylinders: 4,
        displacement_l: 2.5,
        displacement_liters: 2.5,
        fuel_type: "gasoline",
        configuration: "I4",
        aspiration: "naturally_aspirated",
        fuel_injection: "D-4S port + direct injection",
        oil_viscosity: "0W-16",
        oil_spec_standard: "API SP / ILSAC GF-6A",
        oil_capacity_qts: 4.8,
        coolant_type: "Toyota SLLC (pink)",
        spark_plug_quantity: 4,
        data_quality: "spec_v2_seed",
        last_enriched_at: now,
        created_at: now,
      });
      engine = (await ctx.db.get(engineId))!;
      engineCreated = true;
    }
    const engineId = engine._id as Id<"engines">;

    // 4) Find or create vehicle_configs for FWD + AWD
    const fwdConfigKey = `${CAMRY_YEAR}_toyota_camry_le_fwd_a25a-fks`;
    const awdConfigKey = `${CAMRY_YEAR}_toyota_camry_le_awd_a25a-fks`;

    const upsertConfig = async (
      configKey: string,
      drivetrain: "FWD" | "AWD",
    ): Promise<Id<"vehicle_configs">> => {
      const existing = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) => q.eq("config_key", configKey))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          year: CAMRY_YEAR,
          make_id: toyota._id,
          model_id: camryModelDoc._id,
          trim_name: "LE",
          trim_slug: "le",
          engine_id: engineId,
          drivetrain,
          chassis_code: "XV70",
          pricing_tier: "T1",
          pricing_tier_source: "spec_v2_anchor",
          pricing_tier_set_at: now,
        });
        return existing._id;
      }
      return await ctx.db.insert("vehicle_configs", {
        config_key: configKey,
        year: CAMRY_YEAR,
        make_id: toyota._id,
        model_id: camryModelDoc._id,
        trim_name: "LE",
        trim_slug: "le",
        engine_id: engineId,
        drivetrain,
        chassis_code: "XV70",
        pricing_tier: "T1",
        pricing_tier_source: "spec_v2_anchor",
        pricing_tier_set_at: now,
        enrichment_status: "spec_v2_anchor",
        created_at: now,
      });
    };

    const fwdConfigId = await upsertConfig(fwdConfigKey, "FWD");
    const awdConfigId = await upsertConfig(awdConfigKey, "AWD");

    // 5) Build slug → service_id map for the services we touch
    const allServices = await ctx.db.query("services").collect();
    const serviceBySlug = new Map<string, any>();
    for (const svc of allServices) {
      if (svc.slug) serviceBySlug.set(svc.slug, svc);
    }
    const missingServices: string[] = [];

    // 6) Seed service_vehicle_specs — one row per anchor service against the
    //    shared engine. Differential row tagged via parts_cost_basis since
    //    the engine doesn't carry drivetrain info.
    let specsInserted = 0;
    let specsUpdated = 0;
    for (const row of BASELINE) {
      const svc = serviceBySlug.get(row.service_slug);
      if (!svc) {
        missingServices.push(row.service_slug);
        continue;
      }
      const existing = await ctx.db
        .query("service_vehicle_specs")
        .withIndex("by_engine_and_service", (q) =>
          q.eq("engine_id", engineId).eq("service_id", svc._id),
        )
        .first();
      const patch = {
        parts_cost_low: row.parts_low,
        parts_cost_high: row.parts_high,
        oem_part_number: row.oem_part_number,
        parts_cost_basis: row.parts_cost_basis,
        parts_baseline_unit_count: row.parts_baseline_unit_count,
        confidence_score: 0.95,
        data_source: "spec_v2_camry_baseline",
        last_enriched_at: now,
        is_applicable: true,
      };
      if (existing) {
        await ctx.db.patch(existing._id, patch);
        specsUpdated++;
      } else {
        await ctx.db.insert("service_vehicle_specs", {
          engine_id: engineId,
          service_id: svc._id,
          vehicle_config_id: row.applies_to === "awd_only" ? awdConfigId : fwdConfigId,
          ...patch,
        });
        specsInserted++;
      }
    }

    // 7) Seed labor_times — write to the FWD config (canonical baseline).
    //    Layer 5 (tier_estimate) reads from this config_id.
    let laborInserted = 0;
    let laborUpdated = 0;
    for (const row of CAMRY_LABOR_HOURS) {
      const svc = serviceBySlug.get(row.service_slug);
      if (!svc) {
        if (!missingServices.includes(row.service_slug)) {
          missingServices.push(row.service_slug);
        }
        continue;
      }
      const existing = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", fwdConfigId).eq("service_id", svc._id),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          book_hours: row.book_hours,
          source: LABOR_TIMES_SOURCE,
          confidence: LABOR_TIMES_CONFIDENCE,
          engine_family: ENGINE_FAMILY,
        });
        laborUpdated++;
      } else {
        await ctx.db.insert("labor_times", {
          vehicle_config_id: fwdConfigId,
          service_id: svc._id,
          book_hours: row.book_hours,
          source: LABOR_TIMES_SOURCE,
          confidence: LABOR_TIMES_CONFIDENCE,
          engine_family: ENGINE_FAMILY,
          data_quality: "spec_v2_anchor",
          created_at: now,
        });
        laborInserted++;
      }
    }

    return {
      engine: { code: ENGINE_CODE, created: engineCreated, id: engineId },
      vehicle_configs: { fwd: fwdConfigId, awd: awdConfigId },
      service_vehicle_specs: {
        inserted: specsInserted,
        updated: specsUpdated,
        total: BASELINE.length,
      },
      labor_times: {
        inserted: laborInserted,
        updated: laborUpdated,
        total: CAMRY_LABOR_HOURS.length,
      },
      missing_services: missingServices,
    };
  },
});
