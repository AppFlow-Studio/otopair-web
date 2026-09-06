// @ts-nocheck
/**
 * vehicleEnrichment/v3queries.ts — Read-only queries for the v3 pipeline.
 *
 * Note: @ts-nocheck above suppresses TS2589 ("excessively deep type instantiation")
 * errors caused by the size of the schema. The runtime types from Convex's codegen
 * are unaffected — only in-file type inference is skipped.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import { isPoisonPriceType, isNonPooledPriceType } from "../lib/priceTypes";
import { findMakeByName } from "../lib/makeKey";
import { makesSameFamily } from "./contentSanitization";
import { LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES } from "../lib/labor_aggregation";

export const getVehicleConfigByKey = internalQuery({
  args: { configKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.configKey))
      .first();
  },
});

/**
 * Look up a cached vehicle_config by its NHTSA-only base key.
 *
 * This is the fast-path dedup used by confirmVehicleForUser BEFORE Haiku
 * engine code resolution. If a config already exists for this NHTSA fingerprint
 * we can skip the entire enrichment pipeline.
 */
export const getVehicleConfigByNhtsaVinKey = internalQuery({
  args: { nhtsaVinKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_nhtsa_vin_key", (q) => q.eq("nhtsa_vin_key", args.nhtsaVinKey))
      .first();
  },
});

export const getMakeByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    // Normalized total lookup (by_name → by_make_key → keyed scan). The old
    // slug fallback missed rows created without a slug, so VIN-decoder casing
    // ("MERCEDES-BENZ") resolved to nothing and callers minted twin rows.
    return await findMakeByName(ctx.db, args.name);
  },
});

export const getModelByMakeAndName = internalQuery({
  args: { makeId: v.id("makes"), name: v.string() },
  handler: async (ctx, args) => {
    const models = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", args.makeId))
      .collect();
    return models.find((m) => m.name === args.name) ?? null;
  },
});

/** Creates a model record — used when pipeline encounters a new model. */
export const createModel = internalMutation({
  args: { make_id: v.id("makes"), name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("models", {
      make_id: args.make_id,
      name: args.name,
    });
  },
});

export const getVehicle = internalQuery({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.vehicleId);
  },
});

export const getEngine = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.engineId);
  },
});

export const getTransmission = internalQuery({
  args: { transmissionId: v.id("transmissions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.transmissionId);
  },
});

export const getServiceBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("services")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

export const getFitmentsByConfigAndService = internalQuery({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    serviceType: v.string(),
  },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicleConfigId)
          .eq("service_type", args.serviceType)
      )
      .collect();
    // Join the part identity so callers can match Batch 2's parts_breakdown[]
    // entries (keyed by oem_part_number) back to part_id without a second query
    // per fitment. Used by v3pipeline's per-part price write loop.
    return await Promise.all(
      fitments.map(async (f) => {
        const part = (await ctx.db.get(f.part_id)) as any | null;
        return {
          ...f,
          oem_part_number: part?.oem_part_number ?? null,
          part_subcategory: part?.subcategory ?? null,
        };
      }),
    );
  },
});

/** Fuzzy dedup: find an existing config with the same engine + year + make. */
export const findSimilarConfig = internalQuery({
  args: {
    engine_id: v.id("engines"),
    year: v.float64(),
    make_id: v.id("makes"),
  },
  handler: async (ctx, args) => {
    const configs = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    return configs.find((c) => c.year === args.year && c.make_id === args.make_id) ?? null;
  },
});

// ─── Fill rate queries ───────────────────────────────────────────

export const getVehicleByVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
  },
});

export const getVehicleConfigById = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.vehicleConfigId);
  },
});

/**
 * Resolve everything the director per-config backfills need from a single
 * vehicle_config_id: the resolved YMMT strings the pipeline expects (year,
 * make name, model name, trim, engine code, displacement string, drivetrain),
 * the engine/transmission/make IDs, and the first vehicles row attached to this
 * config (via the by_vehicle_config index). Returns null if the config is gone.
 *
 * `displacement` is returned as a STRING (the pipeline's VehicleInput.displacement
 * is a string). vehicleId is null when no vehicles row references this config —
 * the caller surfaces that as a "no_vehicle" status because the vehicle-keyed
 * pipeline can't run without one.
 */
/**
 * Latest enrichment_run for a config — the STEP 0 force-unstick liveness probe.
 * A run counts as live only while its status is in-flight AND its heartbeat
 * (stamped each poll attempt) or start time is recent; see enrichVehicleBatchV3.
 */
export const getLatestRunForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicleConfigId),
      )
      .order("desc")
      .first();
  },
});

/** Own-run read for the poll-chain write fence (runFence.shouldAbortChain).
 *  Returns null when the run row was purged — the fence treats that as an
 *  abort, which is what kills still-scheduled chain ticks after purgeAndRerun. */
export const getEnrichmentRunById = internalQuery({
  args: { runId: v.id("enrichment_runs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.runId);
  },
});

/** Round 13: per-fitment candidate rows for the sole-flagged-winner detector
 *  (soleFlaggedWinnerRoles in utils/roleResource.ts). Joined with the part's
 *  subcategory + normalized number; pricing deliberately excluded (identity
 *  and flag state are all the detector needs). */
export const getFitmentCandidateRows = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    const out: Array<{
      serviceType: string | null;
      subcategory: string | null;
      serviceRole: string | null;
      refuteFlagged: boolean;
      refuteReason: string | null;
      mechanicVerified: boolean;
      packageCode: string | null;
      oemNormalized: string;
    }> = [];
    for (const f of fitments) {
      const part: any = await ctx.db.get(f.part_id);
      if (!part) continue;
      out.push({
        serviceType: (f as any).service_type ?? null,
        subcategory: part.subcategory ?? null,
        serviceRole: (f as any).service_role ?? null,
        refuteFlagged: !!(f as any).refute_flagged,
        refuteReason: ((f as any).refute_reason ?? null) as string | null,
        mechanicVerified: !!(f as any).mechanic_verified,
        packageCode: ((f as any).package_code ?? null) as string | null,
        oemNormalized:
          part.oem_part_number_normalized ??
          String(part.oem_part_number ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      });
    }
    return out;
  },
});

/** Round 12b: the most recent run whose quotability snapshot carries a
 *  NON-EMPTY services list — the last known applicable-services set. A live
 *  Crosstrek re-run returned an EMPTY services array from Batch-2 (variance,
 *  not a parse break — the sibling Equinox run was fine), which made
 *  quotability vacuously 1 and blinded the completeness layer: nothing to
 *  check against means "nothing missing". This fallback restores the prior
 *  truth so an empty batch response can't erase the completeness contract. */
export const getPriorApplicableSlugs = internalQuery({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    excludeRunId: v.optional(v.id("enrichment_runs")),
  },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicleConfigId),
      )
      .order("desc")
      .take(6);
    for (const run of runs) {
      if (args.excludeRunId && run._id === args.excludeRunId) continue;
      const slugs = (((run as any).quotability?.services ?? []) as any[]).map(
        (s: any) => s.slug,
      );
      if (slugs.length > 0) return slugs as string[];
    }
    return [] as string[];
  },
});

/** Round 12: this config's hard-blocked OEM numbers (refuted_fitments mode
 *  "block"), keyed for the Tier-2 researcher's exclusion list. Observed live
 *  on the first Crosstrek repair: the researcher returned 26300SA001 — the
 *  exact blocklisted 2004-era rotor (it dominates the open web for the
 *  query) — and while the write gate rejected it safely, without the
 *  exclusion the researcher would re-find it on every retry. */
export const getBlockedOemsForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("refuted_fitments")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    return rows
      .filter((r) => (r as any).mode === "block")
      .map((r) => ({
        oem_part_number_normalized: (r as any).oem_part_number_normalized as string,
        service_type: ((r as any).service_type ?? null) as string | null,
        reason: (r as any).reason as string,
      }));
  },
});

/** Round 12: per-field count of FAILED role re-source attempts across this
 *  config's recent runs (reasons resource_never_found /
 *  resource_refuted_no_replacement in field_gaps). Feeds the lifetime attempt
 *  cap so a genuinely-unfindable role stops burning search credits — while
 *  `resourced` / `resource_not_applicable` end the need and don't count. */
export const getRoleResourceAttempts = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicleConfigId),
      )
      .order("desc")
      .take(10);
    const counts: Record<string, number> = {};
    for (const run of runs) {
      for (const gap of ((run as any).field_gaps ?? []) as Array<{ field: string; reason: string }>) {
        if (
          gap?.reason === "resource_never_found" ||
          gap?.reason === "resource_refuted_no_replacement"
        ) {
          counts[gap.field] = (counts[gap.field] ?? 0) + 1;
        }
      }
    }
    return counts;
  },
});

export const resolveConfigForBackfill = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;

    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);

    // displacement → string. Prefer numeric displacement_l, fall back to the
    // legacy displacement_liters (string|number). Empty string when unknown —
    // buildEngineKey() drops empty parts so this stays consistent with the
    // signup-time enrichment path.
    const rawDisp =
      (engine as any)?.displacement_l ?? (engine as any)?.displacement_liters ?? null;
    const displacement =
      rawDisp == null ? "" : typeof rawDisp === "string" ? rawDisp : String(rawDisp);

    // First vehicles row attached to this config (the vehicle-keyed pipeline needs one).
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicleConfigId),
      )
      .first();

    return {
      vehicleConfigId: args.vehicleConfigId,
      year: (cfg.year as number) ?? 0,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? "",
      engineCode: (engine as any)?.engine_code ?? "",
      /** vPIC-verbatim fuel string, e.g. "Gasoline", "Electric / Gasoline".
       *  Consumers classify it with variantFingerprint.classifyFuelClass
       *  rather than string-matching — "Electric / Gasoline" is a HYBRID and
       *  reads as electric to a naive `includes("Electric")`. */
      fuelType: ((engine as any)?.fuel_type ?? null) as string | null,
      displacement,
      drivetrain: (cfg.drivetrain as string) ?? undefined,
      makeId: cfg.make_id ?? null,
      engineId: cfg.engine_id ?? null,
      transmissionId: cfg.transmission_id ?? null,
      vehicleId: vehicle?._id ?? null,
    };
  },
});

/** Resolve year/make/model/trim strings from a vehicle_config_id. */
export const getVehicleLabels = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;
    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id as any) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id as any) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id as any) : null,
    ]);
    return {
      year: cfg.year as number,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: cfg.trim_name ?? "",
      displacement_l: (engine as any)?.displacement_l ?? (engine as any)?.displacement_liters ?? null,
    };
  },
});

export const getDrivetrainConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .first();
  },
});

export const getTrimSpecs = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .first();
  },
});

export const getPartFitments = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
  },
});

export const getServiceIntervals = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
  },
});

/**
 * Interval provenance census: every interval row for a config, joined to its
 * service slug, with the two provenance facts the floor gate needs.
 *
 * One query rather than a per-row service lookup — the finalize action already
 * runs close to its 600s ceiling, and a 27-row N+1 there is pure waste.
 *
 * `months_from_default` is true when the row carries a months value that came
 * only from the industry default top-up in ensureAllServiceIntervals. That is
 * distinct from `data_quality === "default_fallback"`: a row can hold a real,
 * well-sourced interval_miles and a defaulted months, and reporting it as a
 * fully-invented interval would be as wrong as reporting it as fully sourced.
 */
export const getIntervalProvenance = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    const services = await ctx.db.query("services").collect();
    const slugById = new Map(services.map((s) => [String(s._id), (s as any).slug ?? ""]));
    return rows.map((r) => ({
      slug: slugById.get(String(r.service_id)) ?? "",
      data_quality: (r as any).data_quality ?? null,
      status: (r as any).status ?? null,
      interval_miles: (r as any).interval_miles ?? null,
      interval_months: (r as any).interval_months ?? null,
      months_from_default: (r as any).interval_months_source === "default_fallback",
    }));
  },
});

export const getLaborTimes = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
  },
});

/** Best available labor estimate for a single service on a vehicle config. */
export const getQuotableLaborTime = internalQuery({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
  },
  handler: async (ctx, args) => {
    const labor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config_and_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_id", args.service_id),
      )
      .first();

    if (!labor) return null;

    const useEmpirical =
      labor.empirical_hours != null &&
      (labor.empirical_sample_size ?? 0) >= LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES;

    return {
      hours: useEmpirical ? labor.empirical_hours! : labor.book_hours,
      source: useEmpirical ? ("empirical" as const) : labor.source,
      is_empirical: useEmpirical,
      sample_size: labor.empirical_sample_size,
      book_hours: labor.book_hours,
      empirical_hours: labor.empirical_hours ?? null,
      confidence: useEmpirical ? 0.95 : (labor.confidence ?? 0.75),
    };
  },
});

export const getPricedPartCount = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    let priced = 0;
    for (const f of fitments) {
      // A part is "priced" only when a row the aggregator TRUSTS exists —
      // poison rows (online_discount / you_save / unverified) are excluded
      // from the customer median, so counting them here inflated fill_rate
      // and made backfills skip exactly the broken parts (Jun-9 review).
      // Non-pooled fallback rows (estimator_endpoint) are ALSO excluded — an
      // endpoint-only part has no real SKU price yet, so counting it would
      // make the pipeline skip fetching one (same fill_rate inflation bug).
      const rows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .collect();
      if (
        rows.some(
          (r) =>
            !isPoisonPriceType((r as any).price_type) &&
            !isNonPooledPriceType((r as any).price_type),
        )
      )
        priced++;
    }
    return priced;
  },
});

/** All fitments for a config with the part's subcategory and a TRUSTED-price
 *  flag (poison / non-pooled price rows excluded — same standard as
 *  getPricedPartCount). Feeds computeQuotability at finalize. */
export const getFitmentsWithPriceFlag = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    const out: Array<{
      service_type: string;
      subcategory: string | null;
      has_trusted_price: boolean;
    }> = [];
    for (const f of fitments) {
      const part = (await ctx.db.get(f.part_id)) as any | null;
      const rows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .collect();
      out.push({
        service_type: f.service_type,
        subcategory: part?.subcategory ?? null,
        has_trusted_price: rows.some(
          (r) =>
            !isPoisonPriceType((r as any).price_type) &&
            !isNonPooledPriceType((r as any).price_type),
        ),
      });
    }
    return out;
  },
});

// ─── Source discovery queries ────────────────────────────────────

export const getSourcesForMake = internalQuery({
  args: { make_id: v.id("makes") },
  handler: async (ctx, { make_id }) => {
    return await ctx.db
      .query("source_registry")
      .withIndex("by_make", (q) => q.eq("make_id", make_id))
      .collect();
  },
});

export const getBlockedDomains = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("blocked_domains").collect();
  },
});

export const getAllMakes = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("makes").collect();
  },
});

export const getMakeById = internalQuery({
  args: { makeId: v.id("makes") },
  handler: async (ctx, { makeId }) => {
    return await ctx.db.get(makeId);
  },
});

export const getModelById = internalQuery({
  args: { modelId: v.id("models") },
  handler: async (ctx, { modelId }) => {
    return await ctx.db.get(modelId);
  },
});

export const getEvidenceForField = internalQuery({
  args: { entityId: v.string(), fieldName: v.string() },
  handler: async (ctx, args) => {
    // TODO(ts-fix): by_entity_field index requires entity_type as first field;
    // callers here don't supply it, so fall back to filter scan to preserve
    // runtime behavior (was already collecting all matches).
    return await ctx.db
      .query("enrichment_evidence")
      .filter((q) =>
        q.and(
          q.eq(q.field("entity_id"), args.entityId),
          q.eq(q.field("field_name"), args.fieldName),
        ),
      )
      .collect();
  },
});

export const getEnrichmentRuns = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { vehicleConfigId }) => {
    return await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicleConfigId))
      .collect();
  },
});

export const getAllServices = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("services").collect();
  },
});

export const getPartById = internalQuery({
  args: { partId: v.id("oem_parts") },
  handler: async (ctx, { partId }) => {
    return await ctx.db.get(partId);
  },
});

export const getOemPartById = internalQuery({
  args: { partId: v.id("oem_parts") },
  handler: async (ctx, { partId }) => {
    return await ctx.db.get(partId);
  },
});

/**
 * Leading-prefix vocabulary of OEM numbers we already trust for a MAKE.
 *
 * The discriminator the format gate cannot provide. `sanitizePartNumber`
 * enforces SHAPE, and several manufacturers share one: Subaru's 15208-AA030
 * and Kia's 26300-35504 are both 5+5, so a Kia format check accepts the Subaru
 * number verbatim (verified Aug 2026). That matters for any source whose
 * evidence spans makes — a RockAuto interchange set is exactly that, because
 * one aftermarket filter casting fits a Subaru and a Kia and lists both
 * numbers under all three brands that make it. Brand corroboration cannot
 * separate them either; they are equally corroborated.
 *
 * What DOES separate them is whether this manufacturer has ever been observed
 * selling a number in that family. Prefixes are read from parts already on
 * file for the make, so the vocabulary is evidence we earned rather than a
 * table someone has to maintain, and it sharpens as the fleet grows.
 *
 * Returns an empty array for a make with nothing on file. Callers must treat
 * that as "cannot judge" and decline, NOT as "anything goes" — an empty
 * vocabulary is the cold-start case, and failing open there would reinstate
 * exactly the hole this closes.
 */
export const getOemPrefixesForMake = internalQuery({
  args: { makeId: v.id("makes"), prefixLen: v.optional(v.float64()) },
  handler: async (ctx, args): Promise<string[]> => {
    // THREE, not five, and the difference is measured rather than guessed.
    //
    // Live vocabulary Aug 2026 — Kia holds 26320/26345/27300, Subaru holds
    // 15208. At five characters the gate correctly rejects Subaru's
    // 15208AA030 for a Kia, but ALSO rejects Kia's own 26300-35504, because
    // that exact family is not yet on file: a fail-closed gate that strict
    // throws away true positives at the same rate it stops contamination.
    //
    // At three, 263 matches 26320 and the genuine number survives, while 152
    // is still absent from Kia entirely so the Subaru number still dies. The
    // shape-compatible makes this gate exists for (Subaru / Kia / Hyundai, all
    // 5+5) showed NO three-character overlap in the live vocabularies, which is
    // what makes the looser prefix safe here.
    //
    // It is also not the last line of defence: a candidate still has to clear
    // the make format gate before this and the adversarial fitment verifier
    // after it, and the rung writes only on a positively CONFIRMED verdict.
    const n = Math.max(2, Math.trunc(args.prefixLen ?? 3));
    // ── The vocabulary spans the CORPORATE FAMILY, not just the make ──────
    //
    // Measured Aug 2026: Lincoln has TWO parts on file. A make-only vocabulary
    // rejects essentially every candidate for it, which is fail-closed and
    // therefore safe — but it disabled the RockAuto rung on exactly the makes
    // whose coverage is worst, and those are the ones that need it. The 2021
    // Nautilus is the case in point: five unquotable services, a rung built to
    // fill them, and a gate that could never pass anything. Coverage cannot
    // bootstrap when earning parts requires already having parts.
    //
    // A badge shares its parent's part numbering — Lincoln IS Ford (Ford: 397
    // parts / 252 prefixes, and the source registry already routes Lincoln to
    // Ford's storefront for the same reason). So the family is the honest unit.
    //
    // This does NOT reopen the contamination this gate exists to stop. The
    // failure was Subaru's 15208AA030 passing for a Kia, and Subaru shares no
    // family with Hyundai/Kia/Genesis — cross-family numbers are rejected
    // exactly as before. Only genuine badge-siblings are admitted.
    const self: any = await ctx.db.get(args.makeId);
    const selfName = String(self?.name ?? "");
    const makeIds: Array<typeof args.makeId> = [args.makeId];
    if (selfName) {
      for (const m of await ctx.db.query("makes").collect()) {
        if (m._id === args.makeId) continue;
        if (makesSameFamily(selfName, String((m as any).name ?? ""))) {
          makeIds.push(m._id as typeof args.makeId);
        }
      }
    }

    const rows: any[] = [];
    for (const id of makeIds) {
      rows.push(
        ...(await ctx.db
          .query("oem_parts")
          // by_make_category leads with make_id, so an equality on that alone
          // is a valid prefix scan — no dedicated by_make index needed.
          .withIndex("by_make_category", (q) => q.eq("make_id", id))
          .take(2000)),
      );
    }
    const out = new Set<string>();
    for (const r of rows) {
      const raw = String(
        (r as any).oem_part_number_normalized ?? (r as any).oem_part_number ?? "",
      )
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (raw.length < n) continue;
      // Only parts we actually believe in seed the vocabulary; an unverified
      // row would let a bad number vouch for its own family.
      if ((r as any).part_tier && (r as any).part_tier !== "oem") continue;
      out.add(raw.slice(0, n));
    }
    return [...out].sort();
  },
});

export const getPricesForPart = internalQuery({
  args: { partId: v.id("oem_parts") },
  handler: async (ctx, { partId }) => {
    return await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q) => q.eq("part_id", partId))
      .collect();
  },
});

export const getFirstShop = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("shops").first();
  },
});

export const createTestShop = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.insert("shops", {
      name: "Test Shop",
      slug: "test-shop",
      address: "123 Test St",
      city: "Test City",
      state: "TX",
      zip: "75001",
      lat: 32.7767,
      lng: -96.797,
      phone: "555-0100",
      labor_rate: 125,
      rating: 5,
      review_count: 0,
      is_active: true,
      is_verified: true,
    });
  },
});

export const getOrCreateTestMechanic = internalMutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, { shopId }) => {
    const existing = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("mechanics", {
      first_name: "Test",
      last_name: "Mechanic",
      shop_id: shopId,
      is_active: true,
      rating: 5,
      review_count: 0,
    });
  },
});

export const getEvidenceByRun = internalQuery({
  args: { enrichmentRunId: v.id("enrichment_runs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_enrichment_run", (q) => q.eq("enrichment_run_id", args.enrichmentRunId))
      .collect();
  },
});

export const getEvidenceCount = internalQuery({
  args: { entityId: v.string() },
  handler: async (ctx, args) => {
    // TODO(ts-fix): by_entity_field index requires entity_type as first field;
    // callers here don't supply it, so fall back to filter scan.
    const rows = await ctx.db
      .query("enrichment_evidence")
      .filter((q) => q.eq(q.field("entity_id"), args.entityId))
      .collect();
    return rows.length;
  },
});

export const getEvidenceForEntity = internalQuery({
  args: { entityId: v.string() },
  handler: async (ctx, args) => {
    // TODO(ts-fix): by_entity_field index requires entity_type as first field;
    // callers here don't supply it, so fall back to filter scan.
    return await ctx.db
      .query("enrichment_evidence")
      .filter((q) => q.eq(q.field("entity_id"), args.entityId))
      .collect();
  },
});

// ─── Chassis grouping (Task 22) ─────────────────────────────────────

/**
 * Find a completed vehicle_config with a matching chassis code.
 * Used to determine if we can skip Tier 2 enrichment and clone data instead.
 * Excludes the current config (targetConfigId) from results.
 */
/**
 * Find the best chassis match for cloning — any enrichment status, highest fill_rate wins.
 * This enables "merge-and-continue": clone whatever data exists from the best sibling,
 * then continue to full enrichment to fill gaps. After completion, backfill siblings.
 */
export const findBestChassisMatch = internalQuery({
  args: {
    chassis_code: v.string(),
    target_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.target_config_id);

    // Get all configs with this chassis code (any status)
    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", args.chassis_code)
      )
      .collect();

    // Exclude ourselves AND cross-make configs — chassis codes are
    // make-scoped concepts, but the stored codes are LLM-generated strings
    // ("E12", "MK7") that collide across makes; without this filter a BMW
    // config's parts can be cloned onto a whole different marque.
    // Sort by fill_rate descending.
    const candidates = all
      .filter(
        (c) =>
          c._id !== args.target_config_id &&
          (!target?.make_id || c.make_id === target.make_id),
      )
      .sort((a, b) => (b.fill_rate ?? 0) - (a.fill_rate ?? 0));

    return candidates[0] ?? null;
  },
});

/**
 * Find ALL sibling configs with the same chassis code (for post-enrichment backfill).
 */
export const findChassisGroupSiblings = internalQuery({
  args: {
    chassis_code: v.string(),
    exclude_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.exclude_config_id);

    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", args.chassis_code)
      )
      .collect();

    // Same-make only — LLM-generated chassis codes collide across makes
    // (see findBestChassisMatch above).
    return all.filter(
      (c) =>
        c._id !== args.exclude_config_id &&
        (!source?.make_id || c.make_id === source.make_id),
    );
  },
});

// ─── Task 25: Diagnose fill gaps ──────────────────────────────────────
/**
 * Returns a structured breakdown of what's missing from a vehicle config.
 * Used by the partial enrichment action to build targeted prompts.
 */
export const diagnoseFillGaps = internalQuery({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicle_config_id);
    if (!config) return null;
    const cfg = config as any;

    // Engine gaps
    const engine = cfg.engine_id ? await ctx.db.get(cfg.engine_id) : null;
    const engineFields: Record<string, boolean> = {
      oil_viscosity: !!(engine as any)?.oil_viscosity,
      oil_capacity_qts: !!(engine as any)?.oil_capacity_qts,
      coolant_type: !!(engine as any)?.coolant_type,
      coolant_capacity_qts: !!(engine as any)?.coolant_capacity_qts,
      timing_system: !!(engine as any)?.timing_system,
      fuel_injection: !!(engine as any)?.fuel_injection,
      aspiration: !!(engine as any)?.aspiration,
      spark_plug_quantity: !!(engine as any)?.spark_plug_quantity,
    };
    const missingEngine = Object.entries(engineFields).filter(([, v]) => !v).map(([k]) => k);

    // Trim spec gaps
    const trim = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .first();
    const trimFields: Record<string, boolean> = {
      tire_options: ((trim as any)?.tire_options?.length ?? 0) > 0,
      tire_pressure_front: !!((trim as any)?.recommended_tire_pressure_front_psi ?? (trim as any)?.tire_pressure_front),
      tire_pressure_rear: !!((trim as any)?.recommended_tire_pressure_rear_psi ?? (trim as any)?.tire_pressure_rear),
      lug_nut_torque: !!(trim as any)?.lug_nut_torque_ft_lbs,
      battery_group: !!(trim as any)?.battery_group,
      battery_cca: !!(trim as any)?.battery_cca,
      battery_type: !!(trim as any)?.battery_type,
      battery_location: !!(trim as any)?.battery_location,
    };
    const missingTrim = Object.entries(trimFields).filter(([, v]) => !v).map(([k]) => k);

    // Config-level gaps
    const missingConfig: string[] = [];
    if (!cfg.brake_fluid_type) missingConfig.push("brake_fluid_type");
    if (cfg.has_brake_pad_sensor == null) missingConfig.push("has_brake_pad_sensor");

    // Service intervals
    const allServices = await ctx.db.query("services").collect();
    const intervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const intervalServiceIds = new Set(intervals.map((i) => i.service_id.toString()));
    const missingIntervals = allServices
      .filter((s) => !intervalServiceIds.has(s._id.toString()))
      .map((s) => s.slug);

    // Labor times
    const laborTimes = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const laborServiceIds = new Set(laborTimes.map((l) => l.service_id.toString()));
    const missingLabor = allServices
      .filter((s) => !laborServiceIds.has(s._id.toString()))
      .map((s) => s.slug);

    // Part fitments
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();

    // Part prices
    const partIds = fitments.map((f) => f.part_id);
    let pricedCount = 0;
    for (const pid of partIds) {
      // Exclude poison + non-pooled (estimator_endpoint) rows: an endpoint-only
      // part has no real SKU price, so it must count as missing here too.
      const rows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", pid))
        .collect();
      if (
        rows.some(
          (r) =>
            !isPoisonPriceType((r as any).price_type) &&
            !isNonPooledPriceType((r as any).price_type),
        )
      )
        pricedCount++;
    }
    const missingPrices = fitments.length - pricedCount;

    return {
      vehicle: `${cfg.year} ${cfg.trim_name}`,
      fill_rate: cfg.fill_rate,
      gaps: {
        engine: missingEngine,
        trim: missingTrim,
        config: missingConfig,
        service_intervals: missingIntervals,
        labor_times: missingLabor,
        part_fitments: fitments.length,
        missing_prices: missingPrices,
      },
      summary: {
        total_gaps: missingEngine.length + missingTrim.length + missingConfig.length +
          missingIntervals.length + missingLabor.length + missingPrices,
        categories_with_gaps: [
          missingEngine.length > 0 ? "engine" : null,
          missingTrim.length > 0 ? "trim" : null,
          missingConfig.length > 0 ? "config" : null,
          missingIntervals.length > 0 ? "intervals" : null,
          missingLabor.length > 0 ? "labor" : null,
          missingPrices > 0 ? "prices" : null,
        ].filter(Boolean),
      },
    };
  },
});

// ─── Engine sibling queries ───────────────────────────────────────

/** Best completed sibling sharing the same engine — for head-start cloning. */
export const findBestEngineSibling = internalQuery({
  args: {
    engine_id: v.id("engines"),
    exclude_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.exclude_config_id);

    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    // Same-make only — defense in depth against engine_id reuse across
    // marques (badge-engineered platforms share engines but not OEM parts).
    const candidates = all
      .filter(
        (c) =>
          c._id !== args.exclude_config_id &&
          (!source?.make_id || c.make_id === source.make_id),
      )
      .sort((a, b) => (b.fill_rate ?? 0) - (a.fill_rate ?? 0));

    return candidates[0] ?? null;
  },
});

// ─── P2.4 · Field-level sibling inheritance donors ────────────────

/**
 * Donor candidates for FIELD-LEVEL sibling inheritance (P2.4).
 *
 * v8 clones whole ROWS from a sibling (intervals/labor/fitments/drivetrain/
 * trim_specs) but never a single field, so engine-intrinsic facts that a
 * verified sibling already holds get re-asked of an LLM on every config.
 * This query returns the raw candidates; the CHOICE between them is made by
 * the pure `selectSiblingDonor` in v3pipeline.ts (testable, no IO).
 *
 * Donor admission — all four conditions, no exceptions:
 *   1. Shares the engine with the target, by one of two routes:
 *        via "engine_id"   — literally the same engines row, or
 *        via "engine_code" — a different engines row carrying the SAME
 *                            non-empty engine_code, same make, and the same
 *                            cylinder count / displacement wherever both are
 *                            known. A blank or NHTSA-descriptor-shaped code
 *                            never matches: engines are per-trim rows, so the
 *                            code is the only real identity they share.
 *   2. Same make as the target (defense in depth — engine rows and codes are
 *      reused across marques on badge-engineered platforms; the same guard
 *      findBestEngineSibling already applies).
 *   3. `enrichment_status` is "complete" or "verified".
 *   4. Holds a non-null value in the requested column.
 *
 * `verified` marks a donor whose engines.verified_fields names this column (or
 * the field key) — a human confirmed it, so it outranks every other candidate.
 * `confidence` is the donor CONFIG's confidence_avg (engines rows carry no
 * per-field confidence); it is only ever used to rank and is capped at the
 * call site, never trusted upward.
 *
 * Returns `{ [fieldKey]: DonorCandidate[] }`. Never throws; an unresolvable
 * target yields {} so the caller degrades to "no inheritance".
 */
export const findSiblingFieldDonors = internalQuery({
  args: {
    target_config_id: v.id("vehicle_configs"),
    /** [{ field, column }] — the audited SIBLING_INHERIT_RULES, passed in so
     *  the safe-set lives in exactly one place (types.ts). */
    requests: v.array(v.object({ field: v.string(), column: v.string() })),
    /** Bound on candidate configs inspected (default 25). */
    max_candidates: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    if (args.requests.length === 0) return out;

    const target = await ctx.db.get(args.target_config_id);
    if (!target) return out;
    const targetEngineId = (target as any).engine_id ?? null;
    const targetEngine = targetEngineId ? await ctx.db.get(targetEngineId) : null;
    if (!targetEngine) return out; // engine-scoped rules only

    const maxCandidates = Math.max(1, Math.min(args.max_candidates ?? 25, 100));

    // ── Route 1: the same engines row ──
    const byEngineId = targetEngineId
      ? await ctx.db
          .query("vehicle_configs")
          .withIndex("by_engine", (q) => q.eq("engine_id", targetEngineId))
          .collect()
      : [];

    // ── Route 2: a different engines row with the same engine identity ──
    const code = ((targetEngine as any).engine_code ?? "").trim();
    const siblingEngineIds: Array<any> = [];
    if (code.length > 0) {
      const sameCode = await ctx.db
        .query("engines")
        .withIndex("by_engine_code", (q) => q.eq("engine_code", code))
        .collect();
      for (const e of sameCode) {
        if (e._id === targetEngineId) continue;
        // Same marque, and matching cylinders/displacement wherever both rows
        // know them — a coarse code ("2.0L L4") must not merge an NA and a
        // turbo engine.
        if ((target as any).make_id && (e as any).make_id && (e as any).make_id !== (target as any).make_id) continue;
        const tCyl = (targetEngine as any).cylinders;
        const eCyl = (e as any).cylinders;
        if (tCyl != null && eCyl != null && tCyl !== eCyl) continue;
        const tDisp = (targetEngine as any).displacement_l;
        const eDisp = (e as any).displacement_l;
        if (tDisp != null && eDisp != null && Math.abs(tDisp - eDisp) > 0.05) continue;
        siblingEngineIds.push(e._id);
      }
    }

    const byEngineCode: Array<any> = [];
    for (const eid of siblingEngineIds) {
      const rows = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_engine", (q) => q.eq("engine_id", eid))
        .collect();
      byEngineCode.push(...rows);
      if (byEngineCode.length >= maxCandidates * 2) break;
    }

    const seen = new Set<string>();
    const candidates: Array<{ cfg: any; via: string }> = [];
    for (const [rows, via] of [
      [byEngineId, "engine_id"] as const,
      [byEngineCode, "engine_code"] as const,
    ]) {
      for (const cfg of rows as any[]) {
        if (cfg._id === args.target_config_id) continue;
        if (seen.has(cfg._id.toString())) continue;
        if ((target as any).make_id && cfg.make_id !== (target as any).make_id) continue;
        const st = cfg.enrichment_status;
        if (st !== "complete" && st !== "verified") continue;
        seen.add(cfg._id.toString());
        candidates.push({ cfg, via });
        if (candidates.length >= maxCandidates) break;
      }
      if (candidates.length >= maxCandidates) break;
    }
    if (candidates.length === 0) return out;

    // Donor values live on the engines row; cache reads across candidates.
    const engineCache = new Map<string, any>();
    for (const { cfg, via } of candidates) {
      const eid = cfg.engine_id;
      if (!eid) continue;
      const key = eid.toString();
      if (!engineCache.has(key)) engineCache.set(key, await ctx.db.get(eid));
      const donorEngine = engineCache.get(key);
      if (!donorEngine) continue;
      const donorVerified: string[] = Array.isArray(donorEngine.verified_fields)
        ? donorEngine.verified_fields
        : [];

      for (const req of args.requests) {
        const raw = donorEngine[req.column];
        if (raw == null) continue;
        (out[req.field] ??= []).push({
          config_id: cfg._id.toString(),
          config_key: cfg.config_key ?? cfg._id.toString(),
          raw_value: raw,
          confidence: typeof cfg.confidence_avg === "number" ? cfg.confidence_avg : null,
          verified:
            donorVerified.includes(req.column) || donorVerified.includes(req.field),
          last_enriched_at:
            typeof cfg.last_enriched_at === "number" ? cfg.last_enriched_at : null,
          via,
        });
      }
    }

    return out;
  },
});

/** All sibling configs sharing the same engine — for post-enrichment backfill. */
export const findEngineSiblings = internalQuery({
  args: {
    engine_id: v.id("engines"),
    exclude_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.exclude_config_id);

    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    // Same-make only (see findBestEngineSibling above).
    return all.filter(
      (c) =>
        c._id !== args.exclude_config_id &&
        (!source?.make_id || c.make_id === source.make_id),
    );
  },
});
