/**
 * vehicleEnrichment/backfillNhtsaKey.ts — One-shot backfill for vehicle_configs.nhtsa_vin_key.
 *
 * Why this exists:
 *   The cron-scrape path (marketplaceScraper.enrichAndTrack) and the old
 *   runPublic test path used to schedule enrichVehicleBatchV3 without passing
 *   nhtsaVinKey, so STAGE 4 left vehicle_configs.nhtsa_vin_key empty. That
 *   broke confirmVehicleForUser's primary dedup path for descriptor-emitting
 *   makes (VW "1.4 TSI", Ford "EcoBoost", Hyundai "Smartstream", etc.).
 *
 *   The forward fix is in marketplaceScraper.ts + runPublic.ts. This action
 *   patches the configs already in the DB.
 *
 * How:
 *   1. Find vehicle_configs rows with nhtsa_vin_key unset (uses the
 *      by_nhtsa_vin_key index with eq(undefined)).
 *   2. For each, pick a representative VIN — prefer a real vehicle (vehicles
 *      table, indexed by_vehicle_config), fall back to vin_queue (filter scan).
 *   3. Hit NHTSA vPIC directly (no Haiku, no Claude, no VDB).
 *   4. Build the key with buildNhtsaVinKey().
 *   5. Patch the config, first-writer-wins.
 *
 * Usage (Convex dashboard or MCP):
 *   functionPath: vehicleEnrichment/backfillNhtsaKey:backfillNhtsaVinKeys
 *   args: { limit: 50 }            // default 100
 *   args: { limit: 50, dryRun: true }
 *
 *   Re-run until the returned `scanned` field is 0 or < limit.
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { buildNhtsaVinKey } from "./types";

const NHTSA_API =
  "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/";

function getValue(data: any, key: string): string {
  const row = data?.Results?.[0];
  if (!row) return "";
  const val = row[key];
  return typeof val === "string" ? val.trim() : "";
}

// ─── Internal helpers ────────────────────────────────────────────

export const _listConfigsMissingNhtsaKey = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("vehicle_configs")
      // Convex's index `q.eq` is typed against the field's stored type
      // (here `string`), so passing `undefined` to find unset rows is a
      // type-system false negative. The runtime supports it for optional
      // indexed fields — see schema `nhtsa_vin_key: v.optional(v.string())`.
      // @ts-expect-error TS2769 — see comment above.
      .withIndex("by_nhtsa_vin_key", (q) => q.eq("nhtsa_vin_key", undefined))
      .take(args.limit);
    return rows.map((r) => ({ _id: r._id, config_key: r.config_key }));
  },
});

export const _findVinForConfig = internalQuery({
  args: { configId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.configId),
      )
      .first();
    if (vehicle?.vin) return vehicle.vin;

    // vin_queue has no by_vehicle_config index — scan filter. Acceptable for
    // a one-shot backfill; if this is too slow, add the index.
    const queued = await ctx.db
      .query("vin_queue")
      .filter((q) => q.eq(q.field("vehicle_config_id"), args.configId))
      .first();
    return queued?.vin ?? null;
  },
});

export const _setNhtsaVinKey = internalMutation({
  args: {
    configId: v.id("vehicle_configs"),
    nhtsa_vin_key: v.string(),
  },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) return "missing" as const;
    if (config.nhtsa_vin_key) return "already_set" as const;
    await ctx.db.patch(args.configId, { nhtsa_vin_key: args.nhtsa_vin_key });
    return "patched" as const;
  },
});

// ─── Public action ───────────────────────────────────────────────

// `@ts-expect-error TS2589` silences a known Convex+TypeScript quirk:
// once this file is registered in api.d.ts, the `action({...})` generic
// resolves through an `internal` type tree that contains its own output
// type and the deep chain of runQuery/runMutation calls in this body
// pushes TS past its instantiation depth limit. The `nhtsa_vin_key`
// TS2339 cascades from the same root — once TS bails, doc types
// collapse to the union of all tables. Runtime is unaffected — Convex
// validates via `convex dev`. Same remedy as `convex/oto/chat.ts:115`.
// @ts-expect-error TS2589 — see comment block above.
export const backfillNhtsaVinKeys = action({
  args: {
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const dryRun = args.dryRun ?? false;

    const configs = await ctx.runQuery(
      internal.vehicleEnrichment.backfillNhtsaKey._listConfigsMissingNhtsaKey,
      { limit },
    );
    console.log(
      `[backfillNhtsa] scanned=${configs.length} (limit=${limit}, dryRun=${dryRun})`,
    );

    let patched = 0;
    let noVin = 0;
    let decodeFailed = 0;
    let alreadySet = 0;
    const errors: { configId: string; error: string }[] = [];

    for (const cfg of configs) {
      try {
        const vin: string | null = await ctx.runQuery(
          internal.vehicleEnrichment.backfillNhtsaKey._findVinForConfig,
          { configId: cfg._id },
        );
        if (!vin) {
          noVin++;
          console.log(`[backfillNhtsa] ${cfg.config_key}: no VIN, skipping`);
          continue;
        }

        const resp = await fetch(`${NHTSA_API}/${vin}?format=json`);
        if (!resp.ok) {
          decodeFailed++;
          console.warn(
            `[backfillNhtsa] ${cfg.config_key} (${vin}): NHTSA HTTP ${resp.status}`,
          );
          continue;
        }
        const data = await resp.json();

        const errorCode = getValue(data, "ErrorCode");
        const errorCodes = errorCode.split(",").map((c) => c.trim());
        if (!errorCodes.includes("0")) {
          decodeFailed++;
          console.warn(
            `[backfillNhtsa] ${cfg.config_key} (${vin}): NHTSA error ${errorCode}`,
          );
          continue;
        }

        const make = getValue(data, "Make");
        const model = getValue(data, "Model");
        const year = parseInt(getValue(data, "ModelYear") || "0", 10);
        if (!make || !model || !year) {
          decodeFailed++;
          console.warn(
            `[backfillNhtsa] ${cfg.config_key} (${vin}): missing core NHTSA fields`,
          );
          continue;
        }

        const key = buildNhtsaVinKey({
          year,
          make,
          model,
          trim: getValue(data, "Trim"),
          displacementL: getValue(data, "DisplacementL"),
          cylinders: getValue(data, "EngineCylinders"),
          fuelType: getValue(data, "FuelTypePrimary"),
        });
        if (!key) {
          decodeFailed++;
          console.warn(
            `[backfillNhtsa] ${cfg.config_key} (${vin}): empty key built`,
          );
          continue;
        }

        if (dryRun) {
          patched++;
          console.log(`[backfillNhtsa] (dry) ${cfg.config_key} → ${key}`);
          continue;
        }

        const result = await ctx.runMutation(
          internal.vehicleEnrichment.backfillNhtsaKey._setNhtsaVinKey,
          { configId: cfg._id, nhtsa_vin_key: key },
        );
        if (result === "patched") {
          patched++;
          console.log(`[backfillNhtsa] ${cfg.config_key} → ${key}`);
        } else if (result === "already_set") {
          alreadySet++;
        }
      } catch (e: any) {
        errors.push({
          configId: String(cfg._id),
          error: String(e?.message ?? e),
        });
        console.error(`[backfillNhtsa] config ${cfg._id} failed:`, e);
      }
    }

    const summary = {
      scanned: configs.length,
      patched,
      noVin,
      decodeFailed,
      alreadySet,
      errorCount: errors.length,
      errors: errors.slice(0, 10),
      dryRun,
      moreLikelyRemaining: configs.length === limit,
    };
    console.log(`[backfillNhtsa] done`, summary);
    return summary;
  },
});
