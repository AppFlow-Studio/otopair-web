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
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { buildNhtsaVinKey, transmissionKeyToken } from "./types";
import { canonicalizeTransmissionType } from "../lib/transmissionTypeInference";

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
    if ((config as any).nhtsa_vin_key) return "already_set" as const;
    await ctx.db.patch(args.configId, { nhtsa_vin_key: args.nhtsa_vin_key });
    return "patched" as const;
  },
});

// ─── Admin action (internal since Jun 9 2026; was public + live-by-default,
// the only backfill inverting the dryRun=true convention — review finding).
// Run via `npx convex run vehicleEnrichment/backfillNhtsaKey:backfillNhtsaVinKeys`
// or the dashboard; pass {"dryRun": false} explicitly to write. ───────────────

// `@ts-expect-error TS2589` silences a known Convex+TypeScript quirk:
// once this file is registered in api.d.ts, the `action({...})` generic
// resolves through an `internal` type tree that contains its own output
// type and the deep chain of runQuery/runMutation calls in this body
// pushes TS past its instantiation depth limit. The `nhtsa_vin_key`
// TS2339 cascades from the same root — once TS bails, doc types
// collapse to the union of all tables. Runtime is unaffected — Convex
// validates via `convex dev`. Same remedy as `convex/oto/chat.ts:115`.
export const backfillNhtsaVinKeys = internalAction({
  args: {
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const limit = args.limit ?? 100;
    const dryRun = args.dryRun ?? true;

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

        // Fold transmission into the key so it matches what a live decode now
        // produces — otherwise this backfill writes a stale transmission-less key
        // that a future decode of the same vehicle would miss.
        const transmissionFamily = await canonicalizeTransmissionType(
          getValue(data, "TransmissionStyle"),
        );
        const key = buildNhtsaVinKey({
          year,
          make,
          model,
          trim: getValue(data, "Trim"),
          displacementL: getValue(data, "DisplacementL"),
          cylinders: getValue(data, "EngineCylinders"),
          fuelType: getValue(data, "FuelTypePrimary"),
          transmissionFamily,
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

// ─── One-shot: fold the transmission family into EXISTING config keys ─────────
//
// Why:
//   Configs enriched BEFORE transmission entered the identity carry
//   transmission-less config_key / nhtsa_vin_key. A future decode of the same
//   vehicle now appends a transmission token, so those old keys no longer match —
//   the primary/secondary dedup would MISS and needlessly re-enrich every
//   existing vehicle on its next add.
//
// How (cheap — no NHTSA re-decode, no Claude enrichment):
//   Both buildEngineKey and buildNhtsaVinKey APPEND the transmission token LAST,
//   so the new key is exactly `<oldKey>_<token>`. We resolve each config's
//   canonical family from its own transmission_id and string-append the token.
//   A future decode of the same vehicle rebuilds the identical key → cache hit
//   preserved. Configs with an unknown/absent transmission keep their
//   transmission-less keys (correct — they stay in the legacy namespace).
//
//   Idempotent: a key that already ends with a known token is skipped. A
//   collapsed config re-keys to the ONE transmission it currently holds; the
//   other variant self-heals on its next add (the chosen forward-only behavior).
//
// Usage (dashboard / MCP), page until isDone:
//   vehicleEnrichment/backfillNhtsaKey:migrateTransmissionIntoKeys
//   args: { limit: 200, dryRun: true }
//   args: { limit: 200, dryRun: false, cursor: "<continueCursor from prior run>" }

export const _listConfigsPageForTxMigration = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, args) => {
    const res = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor, numItems: args.limit });
    const page = await Promise.all(
      res.page.map(async (c) => {
        const tx = c.transmission_id ? await ctx.db.get(c.transmission_id) : null;
        return {
          _id: c._id,
          config_key: c.config_key,
          nhtsa_vin_key: (c as any).nhtsa_vin_key ?? null,
          transmission_type: (tx as any)?.transmission_type ?? null,
        };
      }),
    );
    return { page, isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

export const _applyKeyTxMigration = internalMutation({
  args: {
    configId: v.id("vehicle_configs"),
    newConfigKey: v.string(),
    newNhtsaKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cfg = await ctx.db.get(args.configId);
    if (!cfg) return "missing" as const;
    // Guard: never merge onto another config that already holds the target key.
    const clash = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.newConfigKey))
      .first();
    if (clash && String(clash._id) !== String(args.configId)) return "key_clash" as const;
    const patch: Record<string, unknown> = { config_key: args.newConfigKey };
    if (args.newNhtsaKey) patch.nhtsa_vin_key = args.newNhtsaKey;
    await ctx.db.patch(args.configId, patch);
    return "patched" as const;
  },
});

export const migrateTransmissionIntoKeys = internalAction({
  args: {
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<any> => {
    const limit = args.limit ?? 200;
    const dryRun = args.dryRun ?? true;

    const { page, isDone, continueCursor } = await ctx.runQuery(
      internal.vehicleEnrichment.backfillNhtsaKey._listConfigsPageForTxMigration,
      { cursor: args.cursor ?? null, limit },
    );

    let migrated = 0;
    let unknownTransmission = 0;
    let alreadyMigrated = 0;
    let keyClash = 0;

    for (const c of page) {
      const token = transmissionKeyToken(
        await canonicalizeTransmissionType(c.transmission_type),
      );
      if (!token) {
        unknownTransmission++;
        continue; // leave transmission-less keys as-is
      }
      const suffix = `_${token}`;
      if (c.config_key.endsWith(suffix)) {
        alreadyMigrated++;
        continue; // idempotent
      }
      const newConfigKey = c.config_key + suffix;
      const newNhtsaKey =
        c.nhtsa_vin_key && !c.nhtsa_vin_key.endsWith(suffix)
          ? c.nhtsa_vin_key + suffix
          : c.nhtsa_vin_key ?? undefined;

      if (dryRun) {
        migrated++;
        console.log(`[txKeyMigrate] (dry) ${c.config_key} → ${newConfigKey}`);
        continue;
      }
      const result = await ctx.runMutation(
        internal.vehicleEnrichment.backfillNhtsaKey._applyKeyTxMigration,
        { configId: c._id, newConfigKey, newNhtsaKey },
      );
      if (result === "patched") {
        migrated++;
        console.log(`[txKeyMigrate] ${c.config_key} → ${newConfigKey}`);
      } else if (result === "key_clash") {
        keyClash++;
        console.warn(`[txKeyMigrate] key clash, skipped: ${c.config_key} → ${newConfigKey}`);
      }
    }

    const summary = {
      scanned: page.length,
      migrated,
      unknownTransmission,
      alreadyMigrated,
      keyClash,
      dryRun,
      isDone,
      continueCursor,
    };
    console.log(`[txKeyMigrate] done`, summary);
    return summary;
  },
});
