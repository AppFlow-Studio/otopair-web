/**
 * backfillTires — bulk-populate tire data on vehicle_configs that are missing it.
 *
 * For each candidate vehicle_config:
 *   1. Resolves year/make/model/trim/displacement_l from the related rows
 *   2. Calls wheel-size.com via scrapeWheelSizeOptions()
 *   3. Writes the returned tire_options + tire_options_source to trim_specs
 *      (and, when fillSingleFitment is true, the OEM-standard option's
 *      front/rear sizes + pressures to the single-fitment columns)
 *
 * Safety:
 *   - Default limit per call is 50, hard-capped at 300 (free-tier daily quota)
 *   - skipExisting (default true) — never overwrites a config that already has
 *     tire_options[]. Set false to force-refresh.
 *   - dryRun returns the candidate list without making any API calls or writes.
 *
 * Usage from Convex dashboard:
 *   npx convex run backfillTires:run '{"limit":25,"dryRun":true}'
 *   npx convex run backfillTires:run '{"limit":50}'
 *   npx convex run backfillTires:run '{"limit":10,"skipExisting":false,"fillSingleFitment":true}'
 */

import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { scrapeWheelSizeOptions, type TireOption } from "./vehicleEnrichment/utils/wheelSizeScraper";

// ── candidate selection ──────────────────────────────────────────────────────

/**
 * Returns vehicle_configs that are candidates for tire backfill, oldest-first
 * (so repeated runs walk the table). When skipExisting is true, configs whose
 * trim_specs already have a non-empty tire_options[] are filtered out.
 *
 * Returns up to `limit` rows. Walks the full table so the filter can be applied
 * — Convex doesn't support index-time "is missing" predicates on optional
 * fields, so we paginate-then-filter in JS.
 */
export const _listCandidates = internalQuery({
  args: {
    limit: v.number(),
    skipExisting: v.boolean(),
  },
  handler: async (ctx, { limit, skipExisting }) => {
    const out: Array<{
      _id: Id<"vehicle_configs">;
      config_key: string | null;
      year: number | null;
      had_trim_specs: boolean;
      had_tire_options: boolean;
    }> = [];

    // Walk vehicle_configs newest-first; we want the most recently added
    // configs to be filled in first since they're most likely to be queried.
    const configs = await ctx.db.query("vehicle_configs").order("desc").take(2000);

    for (const c of configs) {
      const ts = await ctx.db
        .query("trim_specs")
        .withIndex("by_vehicle_config", q => q.eq("vehicle_config_id", c._id))
        .first();
      const optsLen = Array.isArray((ts as any)?.tire_options)
        ? (ts as any).tire_options.length
        : 0;
      const hasOptions = optsLen > 0;

      if (skipExisting && hasOptions) continue;

      out.push({
        _id: c._id,
        config_key: (c as any).config_key ?? null,
        year: c.year ?? null,
        had_trim_specs: !!ts,
        had_tire_options: hasOptions,
      });

      if (out.length >= limit) break;
    }

    return out;
  },
});

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Pick the OEM-standard option (or the first option as fallback) and project
 * its sizes + pressures into the single-fitment shape used by
 * trim_specs.tire_size_front/rear/recommended_tire_pressure_*.
 */
function pickSingleFitment(options: TireOption[]) {
  if (options.length === 0) return null;
  const primary = options.find(o => o.is_oem_standard) ?? options[0];
  return {
    tire_size_front: primary.size_front,
    tire_size_rear: primary.size_rear ?? primary.size_front,
    recommended_tire_pressure_front_psi: primary.pressure_front_psi,
    recommended_tire_pressure_rear_psi: primary.pressure_rear_psi,
    // Derived flag — is_run_flat isn't reliably returned by wheel-size.com,
    // so we only derive is_staggered here.
    is_staggered: !!primary.size_rear && primary.size_rear !== primary.size_front,
  };
}

// ── public action ────────────────────────────────────────────────────────────

type ConfigResult = {
  configId: string;
  configKey: string | null;
  status: "ok" | "no_data" | "missing_labels" | "errored";
  vehicle?: string;
  tireOptionsAdded?: number;
  oemStandardCount?: number;
  source?: string;
  error?: string;
};

export const run = action({
  args: {
    limit:              v.optional(v.number()),
    skipExisting:       v.optional(v.boolean()),
    dryRun:             v.optional(v.boolean()),
    fillSingleFitment:  v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { limit = 50, skipExisting = true, dryRun = false, fillSingleFitment = false },
  ): Promise<{
    requested: number;
    candidates: number;
    dryRun: boolean;
    summary: { ok: number; no_data: number; missing_labels: number; errored: number; skipped_existing: number };
    results: ConfigResult[];
  }> => {
    const max = Math.min(Math.max(1, limit), 300); // free-tier daily quota cap

    const candidates: Array<{
      _id: Id<"vehicle_configs">;
      config_key: string | null;
      year: number | null;
      had_trim_specs: boolean;
      had_tire_options: boolean;
    }> = await ctx.runQuery(internal.backfillTires._listCandidates, {
      limit: max,
      skipExisting,
    });

    const summary = { ok: 0, no_data: 0, missing_labels: 0, errored: 0, skipped_existing: 0 };
    const results: ConfigResult[] = [];

    if (dryRun) {
      return {
        requested: max,
        candidates: candidates.length,
        dryRun: true,
        summary,
        results: candidates.map(c => ({
          configId: String(c._id),
          configKey: c.config_key,
          status: "ok" as const,
          vehicle: `${c.year ?? "?"}`,
        })),
      };
    }

    for (const cand of candidates) {
      const result: ConfigResult = {
        configId: String(cand._id),
        configKey: cand.config_key,
        status: "errored",
      };

      try {
        const labels = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleLabels,
          { vehicleConfigId: cand._id },
        );

        if (!labels?.year || !labels?.make || !labels?.model) {
          result.status = "missing_labels";
          summary.missing_labels++;
          results.push(result);
          continue;
        }

        result.vehicle = [labels.year, labels.make, labels.model, labels.trim].filter(Boolean).join(" ");

        const wheelResult = await scrapeWheelSizeOptions(
          labels.year,
          labels.make,
          labels.model,
          labels.trim || undefined,
          labels.displacement_l,
        ).catch(() => null);

        if (!wheelResult || wheelResult.tireOptions.length === 0) {
          result.status = "no_data";
          summary.no_data++;
          results.push(result);
          continue;
        }

        const patch: Record<string, unknown> = {
          vehicle_config_id: cand._id,
          tire_options: wheelResult.tireOptions,
          tire_options_source: wheelResult.sourceUrl,
        };

        if (fillSingleFitment) {
          const single = pickSingleFitment(wheelResult.tireOptions);
          if (single) Object.assign(patch, single);
        }

        await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.upsertTrimSpecs,
          patch as any,
        );

        result.status = "ok";
        result.tireOptionsAdded = wheelResult.tireOptions.length;
        result.oemStandardCount = wheelResult.tireOptions.filter(t => t.is_oem_standard).length;
        result.source = wheelResult.sourceUrl;
        summary.ok++;
      } catch (e) {
        result.status = "errored";
        result.error = e instanceof Error ? e.message : String(e);
        summary.errored++;
      }

      results.push(result);
    }

    return {
      requested: max,
      candidates: candidates.length,
      dryRun: false,
      summary,
      results,
    };
  },
});
