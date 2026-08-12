// =============================================================================
// dataLabor.ts — gated read queries for the Data portal Labor Command Center
// (/data/labor, Data spec §9.1). Read-only: the source ladder is an inspection
// surface; the adjustment lever (weights/caps) is Super-Admin + co-sign and is
// deliberately NOT implemented here.
//
// Reality notes vs the spec's source names:
//   - "estimator_book"     → labor_observations.source === "estimator_endpoint"
//   - "vehicle_databases"   → labor_observations.source === "vdb_repair_estimates"
//   - "empirical"           → labor_times.empirical_* fields (aggregated from
//                             job_actuals; NOT stored in labor_observations)
//   - "multiplier"          → computeLaborTierFloorHours (Camry × tier bound)
//   Additional live catalog sources: olp_labor, web_labor, llm_training, llm_web.
//   labor_times.source is optional — rows that pre-date the aggregation model
//   carry no tag and are surfaced as null ("untagged" in the UI).
// =============================================================================

import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import { detectTier, resolveLaborHours } from "./lib/quoteEngine";
import { computeLaborTierFloorHours } from "./lib/laborFallback";
import { canonicalizeSourceName } from "./lib/sourceNames";

/** Service picker source — services is a small table (23 rows measured). */
export const servicesList = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const services = await ctx.db.query("services").collect();
    return services
      .map((s) => ({
        id: s._id,
        name: s.name,
        slug: s.slug ?? null,
        default_labor_hours: s.default_labor_hours ?? null,
        // DUAL-READ: pre-migration rows still carry the legacy column.
        estimator_slug: s.estimator_slug ?? (s as any).repairpal_slug ?? null,
        labor_determinant: s.labor_determinant ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Config search for the selector bar. Bounded window (no unbounded collect):
 *  scans up to 400 configs by config_key and substring-filters server-side.
 *  Production holds ~30 configs, so the window covers reality with headroom;
 *  `truncated` is honest when it doesn't. */
export const searchConfigs = query({
  args: { token: v.string(), search: v.string() },
  handler: async (ctx, { token, search }) => {
    await requireDirector(ctx, token);
    const windowRows = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key")
      .order("asc")
      .take(400);
    const q = search.trim().toLowerCase();
    const filtered = q
      ? windowRows.filter((c) => c.config_key.toLowerCase().includes(q))
      : windowRows;
    return {
      truncated: windowRows.length === 400,
      results: filtered.slice(0, 30).map((c) => ({
        id: c._id,
        config_key: c.config_key,
        year: c.year,
        pricing_tier: c.pricing_tier ?? null,
        enrichment_status: c.enrichment_status ?? null,
      })),
    };
  },
});

/** The source ladder for one (config, service) pair: every labor value we
 *  hold, one row per source, plus the effective value the quote engine would
 *  actually use and why. */
export const laborLadder = query({
  args: {
    token: v.string(),
    configId: v.id("vehicle_configs"),
    serviceId: v.id("services"),
  },
  handler: async (ctx, { token, configId, serviceId }) => {
    await requireDirector(ctx, token);
    const config = await ctx.db.get(configId);
    const service = await ctx.db.get(serviceId);
    if (!config || !service) return null;

    // Per-source catalog observations (bounded per pair — a handful of sources).
    const observations = await ctx.db
      .query("labor_observations")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", configId).eq("service_id", serviceId),
      )
      .take(50);

    // The materialized aggregate row the app reads.
    const aggregateRow = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config_and_service", (q) =>
        q.eq("vehicle_config_id", configId).eq("service_id", serviceId),
      )
      .first();

    const tier = await detectTier(ctx, config);

    // Effective value: the SAME resolver the quote engine uses at booking time.
    let effective: {
      hours: number;
      source: string;
      confidence: number;
      raw_hours: number | null;
      tier_floor_applied: boolean;
      above_tier_floor: boolean;
    } | null = null;
    let effectiveRefusal: string | null = null;
    if (tier) {
      const r = await resolveLaborHours(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        vehicle_tier: tier,
      });
      if (r.ok) {
        effective = {
          hours: r.hours,
          source: r.source,
          confidence: r.confidence,
          raw_hours: r.raw_hours ?? null,
          tier_floor_applied: r.tier_floor_applied ?? false,
          above_tier_floor: r.above_tier_floor ?? false,
        };
      } else {
        effectiveRefusal = r.reason;
      }
    } else {
      effectiveRefusal = "no pricing tier resolves for this config";
    }

    // Multiplier guardrail bound (Camry hours × tier labor multiplier).
    const floorHours = tier
      ? await computeLaborTierFloorHours(ctx, { serviceId, vehicleTier: tier })
      : null;

    return {
      config: {
        id: config._id,
        config_key: config.config_key,
        year: config.year,
        pricing_tier: tier,
        chassis_code: config.chassis_code ?? null,
      },
      service: {
        id: service._id,
        name: service.name,
        slug: service.slug ?? null,
        default_labor_hours: service.default_labor_hours ?? null,
      },
      observations: observations
        .map((o) => ({
          id: o._id,
          // Canonicalize at the API boundary so the director UI only ever sees
          // current source names, regardless of how far the migration has run.
          source: canonicalizeSourceName(o.source),
          hours: o.hours,
          weight: o.weight,
          tier: o.tier,
          observed_at: o.observed_at,
          sibling_slug: o.sibling_slug ?? null,
          match_key: o.match_key ?? null,
        }))
        .sort((a, b) => b.weight - a.weight),
      aggregate: aggregateRow
        ? {
            id: aggregateRow._id,
            book_hours: aggregateRow.book_hours ?? null,
            // source is optional on legacy rows — null means "untagged".
            source: aggregateRow.source ?? null,
            confidence: aggregateRow.confidence ?? null,
            data_quality: aggregateRow.data_quality ?? null,
            empirical_hours: aggregateRow.empirical_hours ?? null,
            empirical_sample_size: aggregateRow.empirical_sample_size ?? null,
            empirical_p25: aggregateRow.empirical_p25 ?? null,
            empirical_p75: aggregateRow.empirical_p75 ?? null,
            labor_outside_fallback_band:
              aggregateRow.labor_outside_fallback_band ?? false,
            labor_sources_disagree: aggregateRow.labor_sources_disagree ?? false,
            fallback_gap_minutes: aggregateRow.fallback_gap_minutes ?? null,
          }
        : null,
      guardrail: { tier, floor_hours: floorHours },
      effective,
      effective_refusal: effectiveRefusal,
    };
  },
});
