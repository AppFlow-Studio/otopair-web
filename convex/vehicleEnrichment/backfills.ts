/**
 * vehicleEnrichment/backfills.ts — One-time corpus backfills.
 *
 * backfillPartPrices: re-prices already-enriched parts whose part_prices rows
 * hold the old wrong (discount / "You Save" / mis-associated) value.
 *
 * Strategy — keyed off the source_url already stored on each price row (no
 * make/model joins needed):
 *   1. page through oem_parts;
 *   2. for each part, re-fetch the distinct source URLs on its price rows and run
 *      the deterministic parser;
 *   3. write the correct price (price_type 'sale') for any URL whose JSON-LD
 *      contains THIS part's exact OEM number — possibly several sources;
 *   4. ONLY THEN prune the part's legacy poison rows (source_domain 'enrichment'
 *      OR price_type 'online_discount'/'you_save'), snapshotting each into
 *      price_backfill_log first (reversible). A part whose correct page can't be
 *      re-derived (e.g. a rotor mis-stored under a brake-pads URL) keeps its old
 *      row rather than being left priceless.
 *
 * Idempotent: upsertPartPrice dedups by (part_id, source_domain); prune is
 * conditional on a fresh 'sale' row existing. Safe to re-run.
 *
 * Live runs require BACKFILL_PARTS_PRICES=on. Default is dryRun (reports only).
 *   npx convex run vehicleEnrichment/backfills:backfillPartPrices '{"dryRun":true,"selfContinue":false,"limit":20}'
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { fetchUrlWithHtml } from "./firecrawl";
import { parsePartPrices, normalizeOemNumber } from "./priceParser";

const LEGACY_PRICE_TYPES = new Set(["online_discount", "you_save"]);
const LEGACY_DOMAINS = new Set(["enrichment"]);
// Current-format rows the NEW pipeline writes — NEVER prune these, even though
// the llm_estimate fallback can land under the synthetic 'enrichment' domain.
const CURRENT_PRICE_TYPES = new Set(["sale", "llm_estimate"]);

function isLegacyPriceRow(row: { source_domain?: string; price_type?: string }): boolean {
  // A correct current-format price (deterministic 'sale' or tagged 'llm_estimate')
  // is never legacy, regardless of source_domain.
  if (row.price_type != null && CURRENT_PRICE_TYPES.has(row.price_type)) return false;
  return (
    (row.source_domain != null && LEGACY_DOMAINS.has(row.source_domain)) ||
    (row.price_type != null && LEGACY_PRICE_TYPES.has(row.price_type))
  );
}

/** One page of oem_parts with the distinct re-fetchable URLs on their price rows. */
export const _oemPartsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, { cursor, limit }) => {
    const res = await ctx.db.query("oem_parts").paginate({ cursor, numItems: limit });
    const items = [];
    for (const part of res.page) {
      const prices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", part._id))
        .collect();
      const urls = [
        ...new Set(
          prices
            .map((p) => p.source_url)
            .filter((u): u is string => !!u && /^https?:\/\//i.test(u)),
        ),
      ];
      const hasLegacy = prices.some(isLegacyPriceRow);
      items.push({ partId: part._id, oemNumber: part.oem_part_number, urls, hasLegacy });
    }
    return { items, isDone: res.isDone, cursor: res.continueCursor };
  },
});

/** Snapshot + delete a part's legacy poison rows. Returns the count pruned. */
export const _pruneAndLogLegacy = internalMutation({
  args: { partId: v.id("oem_parts"), batch: v.string() },
  handler: async (ctx, { partId, batch }) => {
    const rows = await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q) => q.eq("part_id", partId))
      .collect();
    let pruned = 0;
    for (const r of rows) {
      if (!isLegacyPriceRow(r)) continue;
      await ctx.db.insert("price_backfill_log", {
        part_id: partId,
        deleted_row: r,
        batch,
        deleted_at: Date.now(),
      });
      await ctx.db.delete(r._id);
      pruned++;
    }
    return pruned;
  },
});

type BackfillSummary = {
  batch: string;
  dryRun: boolean;
  partsScanned: number;
  repricedParts: number;
  saleWrites: number;
  prunedParts: number;
  isDone: boolean;
  nextCursor: string;
  samples: Array<{ oem: string; found: string[] }>;
};

export const backfillPartPrices = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    selfContinue: v.optional(v.boolean()),
    batch: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<BackfillSummary> => {
    const dryRun = args.dryRun ?? true;
    if (!dryRun && process.env.BACKFILL_PARTS_PRICES !== "on") {
      throw new Error(
        "Live backfill disabled. Set BACKFILL_PARTS_PRICES=on, or pass dryRun:true.",
      );
    }
    const limit = args.limit ?? 25;
    const selfContinue = args.selfContinue ?? true;
    const batch = args.batch ?? `bf_${Date.now()}`;

    const page = await ctx.runQuery(internal.vehicleEnrichment.backfills._oemPartsPage, {
      cursor: args.cursor ?? null,
      limit,
    });

    // Memoize page fetches across this batch so a shared catalog page (many
    // parts) is only fetched once.
    const fetchMemo = new Map<string, Map<string, { price: number; domain: string; url: string }>>();
    let repricedParts = 0;
    let saleWrites = 0;
    let prunedParts = 0;
    const samples: Array<{ oem: string; found: string[] }> = [];

    for (const item of page.items) {
      if (!item.hasLegacy || item.urls.length === 0) continue;
      const norm = normalizeOemNumber(item.oemNumber);

      const hits: Array<{ price: number; domain: string; url: string }> = [];
      for (const url of item.urls) {
        let parsedMap = fetchMemo.get(url);
        if (!parsedMap) {
          parsedMap = new Map();
          try {
            const { html } = await fetchUrlWithHtml(url);
            if (html) {
              for (const p of parsePartPrices(html, url)) {
                parsedMap.set(p.oem_part_number, {
                  price: p.price,
                  domain: p.source_domain,
                  url: p.source_url,
                });
              }
            }
          } catch (e) {
            console.warn(`[backfill] fetch/parse failed for ${url}:`, e);
          }
          fetchMemo.set(url, parsedMap);
        }
        const hit = parsedMap.get(norm);
        if (hit) hits.push(hit);
      }

      if (hits.length === 0) continue; // no correct source — leave legacy row intact
      repricedParts++;
      if (samples.length < 12) {
        samples.push({ oem: item.oemNumber, found: hits.map((h) => `$${h.price}@${h.domain}`) });
      }

      if (!dryRun) {
        for (const h of hits) {
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
            part_id: item.partId,
            price: h.price,
            price_type: "sale",
            source_url: h.url,
            source_domain: h.domain,
          });
          saleWrites++;
        }
        const pruned = await ctx.runMutation(
          internal.vehicleEnrichment.backfills._pruneAndLogLegacy,
          { partId: item.partId, batch },
        );
        if (pruned > 0) prunedParts++;
      }
    }

    const summary = {
      batch,
      dryRun,
      partsScanned: page.items.length,
      repricedParts,
      saleWrites,
      prunedParts,
      isDone: page.isDone,
      nextCursor: page.cursor,
      samples,
    };
    console.log(`[backfill] ${JSON.stringify({ ...summary, samples: samples.length })}`);

    if (selfContinue && !page.isDone) {
      await ctx.scheduler.runAfter(2000, internal.vehicleEnrichment.backfills.backfillPartPrices, {
        cursor: page.cursor,
        limit,
        dryRun,
        selfContinue,
        batch,
      });
    }
    return summary;
  },
});
