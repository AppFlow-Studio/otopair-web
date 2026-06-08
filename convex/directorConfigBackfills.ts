/**
 * directorConfigBackfills — three PUBLIC director actions that power the
 * per-vehicle-config backfill buttons in the director panel:
 *
 *   1. reEnrichConfig      — FULL re-enrich (force=true, writeScope="full")
 *   2. backfillConfigParts — PARTS-ONLY re-enrich (force=true, writeScope="parts")
 *   3. repriceConfigParts  — PRICES-ONLY, self-contained, no LLM / no pipeline
 *
 * All three follow the existing director convention (see directorConfigActions.ts):
 * NO ctx.auth — actorName/actorId are TRUSTED audit args supplied by the already
 * authenticated director panel. Each writes one audit_log row on success and
 * returns a small summary object for a UI toast.
 *
 * Actions can't touch ctx.db, so the audit row is written through the
 * `_writeBackfillAudit` internalMutation below via ctx.runMutation.
 */

import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { VehicleInput } from "./vehicleEnrichment/types";
import { scrapeVehicleSources } from "./vehicleEnrichment/scraper";
import { normalizeOemNumber } from "./vehicleEnrichment/priceParser";

// ---------------------------------------------------------------------------
// Audit-log writer (actions can't use ctx.db — go through a mutation).
// Mirrors the audit_log shape used across directorConfigActions.ts.
// ---------------------------------------------------------------------------

export const _writeBackfillAudit = internalMutation({
  args: {
    id: v.id("vehicle_configs"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
    detail: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: String(args.id),
      action: "backfill",
      actor: args.actorName,
      actor_id: args.actorId,
      detail: args.detail,
      created_at: Date.now(),
    });
  },
});

// Shared args for all three director backfill actions.
const backfillArgs = {
  id: v.id("vehicle_configs"),
  actorName: v.string(),
  actorId: v.optional(v.id("director_users")),
} as const;

// ---------------------------------------------------------------------------
// 1. reEnrichConfig — FULL re-enrich (force + writeScope="full")
// ---------------------------------------------------------------------------

export const reEnrichConfig = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    if (!resolved) {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }
    if (!resolved.vehicleId) {
      // The vehicle-keyed pipeline requires a vehicles row to enrich against.
      return {
        status: "no_vehicle" as const,
        message: "No vehicle row attached to this config",
      };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      {
        vehicleId: resolved.vehicleId,
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim,
        engineCode: resolved.engineCode,
        displacement: resolved.displacement,
        drivetrain: resolved.drivetrain,
        force: true,
        writeScope: "full",
      },
    );

    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: args.actorName,
      actorId: args.actorId,
      detail: `Full re-enrich scheduled (force) for ${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim(),
    });

    return { status: "scheduled" as const, scope: "full" as const };
  },
});

// ---------------------------------------------------------------------------
// 2. backfillConfigParts — PARTS-ONLY re-enrich (force + writeScope="parts")
// ---------------------------------------------------------------------------

export const backfillConfigParts = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    if (!resolved) {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }
    if (!resolved.vehicleId) {
      return {
        status: "no_vehicle" as const,
        message: "No vehicle row attached to this config",
      };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      {
        vehicleId: resolved.vehicleId,
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim,
        engineCode: resolved.engineCode,
        displacement: resolved.displacement,
        drivetrain: resolved.drivetrain,
        force: true,
        writeScope: "parts",
      },
    );

    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: args.actorName,
      actorId: args.actorId,
      detail: `Parts-only re-enrich scheduled (force) for ${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim(),
    });

    return { status: "scheduled" as const, scope: "parts" as const };
  },
});

// ---------------------------------------------------------------------------
// 3. repriceConfigParts — PRICES-ONLY, self-contained (no LLM, no pipeline)
// ---------------------------------------------------------------------------
//
// Scrapes this config's registry sources for deterministic JSON-LD prices and
// writes them onto THIS config's EXISTING parts only. Replicates the v3pipeline
// deterministic price loop (v3pipeline.ts @1946-2078): build a Map keyed by
// normalizeOemNumber(oem_part_number) → { price, source_domain, source_url } and
// upsert a "sale" price for every existing part whose normalized OEM number is in
// the map. Deterministic "sale" prices remain authoritative — we only write
// price_type:"sale", never an llm_estimate, so this can't be outranked by a
// later LLM estimate.
//
// Runs live on an explicit director click — NOT gated on BACKFILL_PARTS_PRICES.

export const repriceConfigParts = action({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    if (!resolved) {
      return { status: "not_found" as const, message: "Vehicle config not found" };
    }

    // (a) Load this config's existing fitments → distinct part_ids → oem_parts.
    const fitments = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getPartFitments,
      { vehicleConfigId: args.id },
    );
    // Dedup part_ids (a part can have multiple fitments — base + package variants).
    const partIdById = new Map<string, (typeof fitments)[number]["part_id"]>();
    for (const f of fitments) {
      partIdById.set(String(f.part_id), f.part_id);
    }
    if (partIdById.size === 0) {
      return { status: "no_parts" as const, priced: 0 };
    }

    // Hydrate each distinct part → its OEM number (the join key for pricing).
    const existingParts: Array<{
      part_id: (typeof fitments)[number]["part_id"];
      oem_part_number: string | null;
    }> = [];
    for (const partId of partIdById.values()) {
      const part = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getOemPartById,
        { partId },
      );
      if (!part) continue;
      existingParts.push({
        part_id: partId,
        oem_part_number: (part as any).oem_part_number ?? null,
      });
    }
    if (existingParts.length === 0) {
      return { status: "no_parts" as const, priced: 0 };
    }

    // (b) Resolve the YMMT into the VehicleInput shape scrapeVehicleSources wants,
    // then scrape. scrapeVehicleSources caches + returns deterministic prices.
    const vehicle: VehicleInput = {
      vehicleId: resolved.vehicleId ? String(resolved.vehicleId) : "",
      year: resolved.year,
      make: resolved.make,
      model: resolved.model,
      trim: resolved.trim,
      engineCode: resolved.engineCode,
      displacement: resolved.displacement,
    };
    const sources = await scrapeVehicleSources(ctx, vehicle);

    // Build the deterministic price Map exactly like the v3pipeline loop:
    // key = normalizeOemNumber(oem_part_number) → { price, source_domain, source_url }.
    const deterministicPrices = new Map<
      string,
      { price: number; source_domain: string; source_url: string }
    >();
    for (const p of sources.partPrices ?? []) {
      if (p?.oem_part_number && typeof p.price === "number" && p.price > 0) {
        deterministicPrices.set(normalizeOemNumber(p.oem_part_number), {
          price: p.price,
          source_domain: p.source_domain,
          source_url: p.source_url,
        });
      }
    }

    // Match this config's existing parts against the deterministic map and write
    // the authoritative "sale" price for each hit.
    let priced = 0;
    for (const part of existingParts) {
      if (!part.oem_part_number) continue;
      const dp = deterministicPrices.get(normalizeOemNumber(part.oem_part_number));
      if (!dp) continue;
      await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.upsertPartPrice,
        {
          part_id: part.part_id,
          price: dp.price,
          price_type: "sale",
          source_url: dp.source_url,
          source_domain: dp.source_domain,
        },
      );
      priced++;
    }

    // (c) Audit-log with the count.
    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: args.actorName,
      actorId: args.actorId,
      detail: `Repriced parts (deterministic): ${priced}/${existingParts.length} priced for ${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim(),
    });

    return {
      status: "done" as const,
      priced,
      partsTotal: existingParts.length,
    };
  },
});
