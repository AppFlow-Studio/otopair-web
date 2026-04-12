/**
 * vehicleEnrichment/cacheValidation.ts — Lightweight background validation
 *
 * When a cached vehicle_config is >180 days stale, this runs instead of a
 * full re-enrichment. It checks part supersessions, price freshness, and
 * spot-checks a few specs. Costs ~8-12 FireCrawl credits. No AI inference.
 * User gets existing data immediately; validation runs in background.
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { fetchUrl, searchAndFetch } from "./firecrawl";

/** OEM part number patterns by make (for extraction from markdown). */
const OEM_PATTERNS: Record<string, RegExp> = {
  BMW: /\b(\d{11})\b/g,
  Toyota: /\b(\d{5}-[A-Z0-9]{5})\b/g,
  Honda: /\b([A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4})\b/g,
};
const DEFAULT_OEM_PATTERN = /\b([A-Z0-9]{5,15})\b/g;

/** Price pattern: $XX.XX */
const PRICE_PATTERN = /\$(\d+(?:,\d{3})*\.\d{2})/g;

export const validateCachedConfig = internalAction({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    // ── 1. LOAD CONTEXT ──────────────────────────────────────────

    const vc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicle_config_id },
    );
    if (!vc) {
      console.error("[validate] Vehicle config not found");
      return;
    }

    const makeDoc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getMakeById,
      { makeId: vc.make_id },
    );
    const makeName = makeDoc?.name ?? "Unknown";

    const modelDoc = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getModelById,
      { modelId: vc.model_id },
    );
    const modelName = modelDoc?.name ?? "Unknown";

    const engine = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getEngine,
      { engineId: vc.engine_id },
    );

    const configKey = vc.config_key;
    console.log(`[validate] Starting for ${configKey} (${vc.year} ${makeName} ${modelName} ${vc.trim_name})`);

    let supersessions = 0;
    let priceChanges = 0;
    let specMismatches = 0;
    let partsChecked = 0;

    // ── 2. GET CURRENT PARTS + PRICES ────────────────────────────

    const fitments = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getPartFitments,
      { vehicleConfigId: args.vehicle_config_id },
    );

    // Build parts list with their latest prices
    const partsWithPrices: Array<{
      fitmentId: string;
      partId: string;
      partNumber: string;
      subcategory: string;
      priceId?: string;
      storedPrice?: number;
      sourceUrl?: string;
      sourceDomain?: string;
    }> = [];

    for (const fitment of fitments) {
      const part = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getOemPartById,
        { partId: fitment.part_id },
      );
      if (!part) continue;

      // Get latest price for this part
      const prices = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getPricesForPart,
        { partId: fitment.part_id },
      );
      const latestPrice = prices[0]; // first by recency

      partsWithPrices.push({
        fitmentId: fitment._id as string,
        partId: fitment.part_id as string,
        partNumber: part.oem_part_number ?? part.name,
        subcategory: part.subcategory ?? part.category,
        priceId: latestPrice?._id as string | undefined,
        storedPrice: latestPrice?.price,
        sourceUrl: latestPrice?.source_url ?? undefined,
        sourceDomain: latestPrice?.source_domain,
      });
    }

    // ── 3. VALIDATE PART NUMBERS (check for supersessions) ───────

    // Use a search query per part to find current listings
    // Limit to 5 parts max to control FireCrawl credit usage
    const partsToCheck = partsWithPrices.slice(0, 5);
    const oemPattern = OEM_PATTERNS[makeName] ?? DEFAULT_OEM_PATTERN;

    for (const part of partsToCheck) {
      partsChecked++;
      try {
        const query = `${makeName} OEM ${part.subcategory?.replace(/_/g, " ")} ${vc.year} ${modelName} ${vc.trim_name} part number`;
        const results = await searchAndFetch(query, 2);

        for (const result of results) {
          if (!result.markdown || result.markdown.length < 200) continue;

          // Find all OEM-format part numbers on the page
          const matches = [...result.markdown.matchAll(oemPattern)];
          const foundNumbers = [...new Set(matches.map((m) => m[1]))];

          // Check if our stored number appears
          const ourNumberFound = foundNumbers.includes(part.partNumber);

          if (!ourNumberFound && foundNumbers.length > 0) {
            // Possible supersession — a different number appears for the same role
            const candidate = foundNumbers[0];
            console.log(
              `[validate] SUPERSESSION: ${part.partNumber} → ${candidate} for ${part.subcategory}`,
            );

            // Mark old part as superseded
            await ctx.runMutation(
              internal.vehicleEnrichment.cacheValidation.markPartSuperseded,
              {
                part_id: part.partId as any,
                superseded_by: candidate,
              },
            );

            supersessions++;
          }
          break; // one result per part is enough
        }
      } catch (err) {
        console.log(`[validate] Part check failed for ${part.partNumber}: ${err}`);
      }
    }

    // ── 4. VALIDATE PRICES ───────────────────────────────────────

    for (const part of partsWithPrices) {
      if (!part.sourceUrl || !part.storedPrice) continue;

      try {
        const markdown = await fetchUrl(part.sourceUrl);
        if (!markdown || markdown.length < 100) continue;

        // Extract prices from the page
        const priceMatches = [...markdown.matchAll(PRICE_PATTERN)];
        if (priceMatches.length === 0) continue;

        const currentPrices = priceMatches
          .map((m) => parseFloat(m[1].replace(/,/g, "")))
          .filter((p) => p > 0 && p < 10000);
        if (currentPrices.length === 0) continue;

        // Find the closest price to our stored price (same product page may have multiple items)
        const closest = currentPrices.reduce((prev, curr) =>
          Math.abs(curr - part.storedPrice!) < Math.abs(prev - part.storedPrice!) ? curr : prev,
        );

        const pctChange = Math.abs(closest - part.storedPrice) / part.storedPrice;

        if (pctChange > 0.20) {
          console.log(
            `[validate] PRICE CHANGE: ${part.partNumber} $${part.storedPrice.toFixed(2)} → $${closest.toFixed(2)} (${part.sourceDomain})`,
          );
          await ctx.runMutation(
            internal.vehicleEnrichment.cacheValidation.updatePartPrice,
            {
              part_id: part.partId as any,
              source_domain: part.sourceDomain!,
              new_price: closest,
            },
          );
          priceChanges++;
        } else {
          // Price is close enough — just refresh the timestamp
          if (part.priceId) {
            await ctx.runMutation(
              internal.vehicleEnrichment.cacheValidation.refreshPriceTimestamp,
              { price_id: part.priceId as any },
            );
          }
        }
      } catch (err) {
        // Fetch failed — page may be down. Skip silently.
      }
    }

    // ── 5. SPOT CHECK SPECS ──────────────────────────────────────

    const specChecks = [
      {
        field: "oil_viscosity",
        storedValue: engine?.oil_viscosity,
        query: `${vc.year} ${makeName} ${modelName} ${vc.trim_name} oil viscosity specification`,
        pattern: /\b(\d+[Ww]-\d+)\b/,
      },
      {
        field: "front_tire_size",
        storedValue: null as string | null, // loaded below
        query: `${vc.year} ${makeName} ${modelName} ${vc.trim_name} tire size OEM`,
        pattern: /\b(\d{3}\/\d{2}[Rr]\d{2})\b/,
      },
    ];

    // Load trim_specs for tire size
    const trimSpecs = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getTrimSpecs,
      { vehicleConfigId: args.vehicle_config_id },
    );
    specChecks[1].storedValue = trimSpecs?.tire_size_front ?? trimSpecs?.front_tire_size ?? null;

    for (const check of specChecks) {
      if (!check.storedValue) continue;

      try {
        const results = await searchAndFetch(check.query, 2);
        for (const result of results) {
          if (!result.markdown || result.markdown.length < 200) continue;

          const match = result.markdown.match(check.pattern);
          if (!match) continue;

          const foundValue = match[1];
          const storedNorm = check.storedValue.toLowerCase().replace(/\s/g, "");
          const foundNorm = foundValue.toLowerCase().replace(/\s/g, "");

          if (storedNorm !== foundNorm) {
            console.log(
              `[validate] SPEC MISMATCH: ${check.field} stored="${check.storedValue}" found="${foundValue}"`,
            );

            // Write evidence for the new observation
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.addEvidenceBatch,
              {
                evidence_rows: [
                  {
                    entity_type: check.field.includes("tire") ? "trim_spec" : "engine",
                    entity_id: String(args.vehicle_config_id),
                    field_name: check.field,
                    observed_value: foundValue,
                    observed_type: "string",
                    source_url: result.url,
                    source_domain: new URL(result.url).hostname.replace(/^www\./, ""),
                    source_type: "web_search" as const,
                    confidence: 0.80,
                    observed_at: Date.now(),
                  },
                ],
              },
            );
            specMismatches++;
          }
          break;
        }
      } catch (err) {
        // Search failed — skip this spec check
      }
    }

    // ── 6. UPDATE TIMESTAMP ──────────────────────────────────────

    await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.patchVehicleConfig,
      {
        vehicle_config_id: args.vehicle_config_id,
        last_enriched_at: Date.now(),
      },
    );

    // ── 7. LOG SUMMARY ───────────────────────────────────────────

    console.log(
      `[validate] ${configKey}: checked ${partsChecked} parts, ` +
        `${supersessions} supersessions, ${priceChanges} price changes, ` +
        `${specMismatches} spec mismatches`,
    );
  },
});

// ── Helper mutations for validation writes ─────────────────────

export const markPartSuperseded = internalAction({
  args: {
    part_id: v.id("oem_parts"),
    superseded_by: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(
      internal.vehicleEnrichment.cacheValidation._markPartSupersededMut,
      args,
    );
  },
});

export const _markPartSupersededMut = internalMutation({
  args: {
    part_id: v.id("oem_parts"),
    superseded_by: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.part_id, {
      is_current: false,
      superseded_by: args.superseded_by,
    });
  },
});

export const updatePartPrice = internalAction({
  args: {
    part_id: v.id("oem_parts"),
    source_domain: v.string(),
    new_price: v.float64(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(
      internal.vehicleEnrichment.cacheValidation._updatePartPriceMut,
      args,
    );
  },
});

export const _updatePartPriceMut = internalMutation({
  args: {
    part_id: v.id("oem_parts"),
    source_domain: v.string(),
    new_price: v.float64(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("part_prices")
      .withIndex("by_part_source", (q) =>
        q.eq("part_id", args.part_id).eq("source_domain", args.source_domain),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        price: args.new_price,
        refreshed_at: Date.now(),
      });
    }
  },
});

export const refreshPriceTimestamp = internalAction({
  args: { price_id: v.id("part_prices") },
  handler: async (ctx, args) => {
    await ctx.runMutation(
      internal.vehicleEnrichment.cacheValidation._refreshPriceTimestampMut,
      args,
    );
  },
});

export const _refreshPriceTimestampMut = internalMutation({
  args: { price_id: v.id("part_prices") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.price_id, { refreshed_at: Date.now() });
  },
});

