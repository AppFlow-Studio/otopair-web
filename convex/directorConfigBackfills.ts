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
import { action, internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { VehicleInput } from "./vehicleEnrichment/types";
import { scrapeVehicleSources } from "./vehicleEnrichment/scraper";
import { normalizeOemNumber, parsePartPrices } from "./vehicleEnrichment/priceParser";
import { fetchUrlWithHtml } from "./vehicleEnrichment/firecrawl";

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
        targetConfigId: args.id, // PIN: update THIS config in place (no duplicate)
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
        targetConfigId: args.id, // PIN: update THIS config in place (no duplicate)
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
//
// SHAPE (fixed 2026-06-09): the live multi-page scrape used to run SYNCHRONOUSLY
// inside this public action, so a slow/erroring config timed out the click
// ("Your request couldn't be completed") AND — because the only audit row was
// written on SUCCESS at the very end — left NO trace that the button was pressed.
// Now the public action is fire-and-return (mirrors reEnrichConfig above): it
// writes a "scheduled" audit row IMMEDIATELY (so every click is recorded), then
// hands the heavy scrape to the _repriceConfigPartsRun internal action below,
// which writes its own completion/error audit row. The click can no longer time
// out, and a failed scrape is recorded instead of vanishing.

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

    const label =
      `${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim();

    // (a) Record EVERY click immediately, BEFORE the heavy scrape — so a timeout
    //     or error downstream can never swallow the fact that reprice was run.
    await ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
      id: args.id,
      actorName: args.actorName,
      actorId: args.actorId,
      detail: `Reprice parts scheduled (deterministic) for ${label}`.trim(),
    });

    // (b) Fire-and-return: do the live scrape + price writes in a scheduled
    //     internal action so this click can't time out. That action writes a
    //     completion (or error) audit row with the priced count.
    await ctx.scheduler.runAfter(
      0,
      internal.directorConfigBackfills._repriceConfigPartsRun,
      { id: args.id, actorName: args.actorName, actorId: args.actorId },
    );

    return { status: "scheduled" as const, scope: "reprice" as const };
  },
});

// The heavy lifting, isolated in a scheduled internal action so it can run for
// as long as the scrape needs without timing out the director's click. The
// ENTIRE body is wrapped so any failure (scrape error, source timeout, missing
// config) is recorded as an audit row instead of vanishing silently.
export const _repriceConfigPartsRun = internalAction({
  args: backfillArgs,
  handler: async (ctx, args) => {
    const audit = (detail: string) =>
      ctx.runMutation(internal.directorConfigBackfills._writeBackfillAudit, {
        id: args.id,
        actorName: args.actorName,
        actorId: args.actorId,
        detail,
      });

    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.id },
    );
    const label = resolved
      ? `${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}`.trim()
      : String(args.id);

    try {
      if (!resolved) {
        await audit(`Reprice parts failed: config not found (${args.id})`);
        return;
      }

      // (1) Load this config's existing fitments → distinct part_ids → oem_parts.
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
        await audit(`Reprice parts complete: no parts on this config (${label})`);
        return;
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
        await audit(`Reprice parts complete: no parts on this config (${label})`);
        return;
      }

      // (2) Resolve the YMMT into the VehicleInput shape scrapeVehicleSources wants,
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

      // PASS 1: match against the vehicle-level scrape's deterministic map (cheap).
      let priced = 0;
      const pricedIds = new Set<string>();
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
        pricedIds.add(String(part.part_id));
        priced++;
      }

      // PASS 2: for every still-unpriced part, RE-PARSE its EXISTING price source
      // URLs with the deterministic parser. The original enrichment already found
      // real product pages (partsgeek/autozone/…) for these parts — it just stored
      // the buggy "online_discount" figure. Re-fetching those same pages and
      // running parsePartPrices extracts the real "sale" price, so coverage jumps
      // from "whatever the registry scrape surfaced" to "every part with a URL".
      for (const part of existingParts) {
        if (!part.oem_part_number || pricedIds.has(String(part.part_id))) continue;
        const normOem = normalizeOemNumber(part.oem_part_number);
        const existing = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getPricesForPart,
          { partId: part.part_id },
        );
        const urls = Array.from(
          new Set(
            (existing as any[]).map((p) => p.source_url).filter((u): u is string => !!u),
          ),
        );
        for (const url of urls) {
          let html: string | null = null;
          try {
            ({ html } = await fetchUrlWithHtml(url));
          } catch {
            continue;
          }
          if (!html) continue;
          const parsed = parsePartPrices(html, url);
          // Prefer the exact OEM match; if the page is a single-product page, that
          // product IS this part (the URL was stored for this part).
          let match = parsed.find((p) => p.oem_part_number === normOem);
          if (!match && parsed.length === 1) match = parsed[0];
          if (match && match.price > 0) {
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.upsertPartPrice,
              {
                part_id: part.part_id,
                price: match.price,
                price_type: "sale",
                source_url: match.source_url,
                source_domain: match.source_domain,
              },
            );
            pricedIds.add(String(part.part_id));
            priced++;
            break; // first URL that yields a real sale price wins
          }
        }
      }

      // (3) Audit the outcome with the count.
      await audit(
        `Reprice parts complete (deterministic): ${priced}/${existingParts.length} priced for ${label}`.trim(),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit(`Reprice parts failed for ${label}: ${msg}`);
      // Re-throw so the failure also surfaces in the Convex function logs.
      throw err;
    }
  },
});
