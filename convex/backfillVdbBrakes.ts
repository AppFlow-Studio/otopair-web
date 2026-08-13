/**
 * backfillVdbBrakes — bulk-fill vehicle_configs.brake_system_type and
 * .packages_available from cached VDB data.
 *
 * Background: extractVDBFields() (convex/lib/vehicleDatabases.ts) has been
 * computing brakeSystemType from VDB forever, but the v3 pipeline never
 * persisted it — every existing config has brake_system_type === undefined,
 * which breaks the Rotor Booking screen's OEM pre-selection. packages_available
 * was only written when at least one package matched, so configs with no
 * matches look indistinguishable from un-processed configs.
 *
 * Per-config flow:
 *   1. Resolve a sample VIN via vehicles.by_vehicle_config index
 *   2. advancedVinDecode(vin)        (VIN-cached in vdbCache — repeats are free)
 *   3. extractVDBFields(vdbRaw)      → brakeSystemType
 *   4. assessAvailablePackages(...)  → packages[] (may be [], which is a valid
 *                                       "we looked, nothing detected" answer)
 *   5. patchVehicleConfig with only the missing fields (surgical — never
 *      overwrites pre-existing values)
 *
 * Run:
 *   npx convex run backfillVdbBrakes:run '{"limit":25,"dryRun":true}'
 *   npx convex run backfillVdbBrakes:run '{"limit":50}'
 */

import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  advancedVinDecode,
  assessAvailablePackages,
  extractVDBFields,
  type DetectedPackage,
} from "./lib/vehicleDatabases";

// ── candidate selection ──────────────────────────────────────────────────────

interface Candidate {
  _id: Id<"vehicle_configs">;
  config_key: string | null;
  make: string;
  model: string;
  trim: string;
  year: number;
  vin: string | null;
  needs_brake: boolean;
  needs_packages: boolean;
}

/**
 * Walk vehicle_configs newest-first and return rows missing brake_system_type
 * and/or packages_available. Resolves make/model/trim and a sample VIN per
 * config so the action can run with a single Convex round-trip.
 *
 * Convex has no index-time "is missing" predicate on optional fields, so we
 * paginate-then-filter in JS (same pattern as backfillTires._listCandidates).
 * Cap walk at 2000 rows per call — re-run the action to drain the rest.
 */
export const _listCandidates = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const out: Candidate[] = [];

    const configs = await ctx.db.query("vehicle_configs").order("desc").take(2000);

    for (const c of configs) {
      const needsBrake = c.brake_system_type === undefined;
      const needsPackages = c.packages_available === undefined;
      if (!needsBrake && !needsPackages) continue;

      const make = c.make_id ? await ctx.db.get(c.make_id) : null;
      const model = c.model_id ? await ctx.db.get(c.model_id) : null;
      if (!make?.name || !model?.name || !c.trim_name || !c.year) continue;

      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
        .first();

      out.push({
        _id: c._id,
        config_key: c.config_key ?? null,
        make: make.name,
        model: model.name,
        trim: c.trim_name,
        year: c.year,
        vin: vehicle?.vin ?? null,
        needs_brake: needsBrake,
        needs_packages: needsPackages,
      });

      if (out.length >= limit) break;
    }

    return out;
  },
});

// ── public action ────────────────────────────────────────────────────────────

type ConfigResult = {
  configId: string;
  configKey: string | null;
  vehicle: string;
  status:
    | "ok"
    | "no_vin"
    | "vdb_unavailable"
    | "nothing_to_write"
    | "errored";
  brake_system_type?: "standard" | "sport" | "carbon_ceramic";
  packages_detected?: number;
  error?: string;
};

export const run = action({
  args: {
    limit:  v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { limit = 25, dryRun = false },
  ): Promise<{
    requested: number;
    candidates: number;
    dryRun: boolean;
    summary: {
      patchedBrake: number;
      patchedPackages: number;
      skippedNoVin: number;
      skippedNoVdb: number;
      nothingToWrite: number;
      errors: number;
    };
    results: ConfigResult[];
  }> => {
    const max = Math.min(Math.max(1, limit), 300);

    const candidates: Candidate[] = await ctx.runQuery(
      internal.backfillVdbBrakes._listCandidates,
      { limit: max },
    );

    const summary = {
      patchedBrake: 0,
      patchedPackages: 0,
      skippedNoVin: 0,
      skippedNoVdb: 0,
      nothingToWrite: 0,
      errors: 0,
    };
    const results: ConfigResult[] = [];

    for (const c of candidates) {
      const label = `${c.year} ${c.make} ${c.model} ${c.trim}`;

      if (!c.vin) {
        summary.skippedNoVin += 1;
        results.push({
          configId: String(c._id),
          configKey: c.config_key,
          vehicle: label,
          status: "no_vin",
        });
        continue;
      }

      try {
        const vdbRaw = await advancedVinDecode(c.vin);
        if (!vdbRaw) {
          summary.skippedNoVdb += 1;
          results.push({
            configId: String(c._id),
            configKey: c.config_key,
            vehicle: label,
            status: "vdb_unavailable",
          });
          continue;
        }

        const fields = extractVDBFields(vdbRaw);
        const brakeSystemType = fields?.brakeSystemType ?? undefined;

        let packages: DetectedPackage[] = [];
        if (c.needs_packages) {
          packages = assessAvailablePackages({
            vdbRaw,
            make: c.make,
            model: c.model,
            trim: c.trim,
            year: c.year,
          });
        }

        const writeBrake = c.needs_brake && !!brakeSystemType;
        const writePackages = c.needs_packages;

        if (!writeBrake && !writePackages) {
          summary.nothingToWrite += 1;
          results.push({
            configId: String(c._id),
            configKey: c.config_key,
            vehicle: label,
            status: "nothing_to_write",
          });
          continue;
        }

        if (!dryRun) {
          await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.patchVehicleConfig,
            {
              vehicle_config_id: c._id,
              ...(writeBrake ? { brake_system_type: brakeSystemType } : {}),
              ...(writePackages ? { packages_available: packages } : {}),
            },
          );
        }

        if (writeBrake) summary.patchedBrake += 1;
        if (writePackages) summary.patchedPackages += 1;

        results.push({
          configId: String(c._id),
          configKey: c.config_key,
          vehicle: label,
          status: "ok",
          ...(writeBrake ? { brake_system_type: brakeSystemType } : {}),
          ...(writePackages ? { packages_detected: packages.length } : {}),
        });
      } catch (err) {
        summary.errors += 1;
        results.push({
          configId: String(c._id),
          configKey: c.config_key,
          vehicle: label,
          status: "errored",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      requested: max,
      candidates: candidates.length,
      dryRun,
      summary,
      results,
    };
  },
});
