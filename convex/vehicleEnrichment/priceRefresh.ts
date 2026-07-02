/**
 * vehicleEnrichment/priceRefresh.ts — nightly re-verification of stale part
 * prices (user evidence, Jul 2026: the 2024 Stelvio's battery prices were a
 * month old and nothing ever re-ran them — part_prices rows previously had no
 * refresh path at all outside a manual director reprice).
 *
 * Selection: parts whose NEWEST part_prices row is older than
 * PARTS_PRICE_REFRESH_AGE_DAYS (default 30). Re-pricing reuses the exact
 * enrichment machinery (priceAllSources → gauges → only "sale" rows written),
 * hitting the part's already-known source URLs — no new discovery, and
 * Firecrawl's maxAge cache keeps per-part cost low.
 *
 * Budget: PARTS_PRICE_REFRESH_BUDGET parts per run. DEFAULT 0 = OFF — this
 * spends Firecrawl credits, so it must be enabled deliberately per deployment.
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { extractPriceFirecrawl } from "./firecrawl";
import { priceAllSources } from "./priceReextract";

const DEFAULT_AGE_DAYS = 30;

type StalePart = {
  part_id: string;
  oem_part_number: string;
  name: string | null;
  subcategory: string | null;
  urls: string[];
};

/**
 * One page of the stale-part scan. Paginates part_prices (the staleness lives
 * on the price rows, not the parts) and returns each distinct part whose
 * NEWEST row is older than the cutoff, with the source URLs we already know.
 */
export const stalePricePartsPage = internalQuery({
  args: {
    cutoff: v.float64(),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("part_prices")
      .paginate({ cursor: args.cursor ?? null, numItems: args.pageSize ?? 100 });

    const out: StalePart[] = [];
    const seenParts = new Set<string>();

    for (const row of page.page) {
      const key = String(row.part_id);
      if (seenParts.has(key)) continue;
      if ((row.refreshed_at ?? 0) >= args.cutoff) continue;
      seenParts.add(key);

      // A part counts as stale only when its NEWEST row is stale — one old row
      // next to a fresh one means the refresh already happened.
      const allRows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", row.part_id))
        .collect();
      const newest = Math.max(...allRows.map((r) => r.refreshed_at ?? 0));
      if (newest >= args.cutoff) continue;

      const part = await ctx.db.get(row.part_id);
      if (!part) continue;
      // Superseded parts are no longer quoted; don't spend refresh budget.
      if (part.is_current === false) continue;

      const urls = [...new Set(allRows.map((r) => r.source_url).filter((u): u is string => !!u))];
      if (urls.length === 0) continue;

      out.push({
        part_id: key,
        oem_part_number: part.oem_part_number,
        name: part.name ?? null,
        subcategory: part.subcategory ?? null,
        urls,
      });
    }

    return { stale: out, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Nightly driver. No-op unless PARTS_PRICE_REFRESH_BUDGET > 0. */
export const refreshStalePrices = internalAction({
  args: {
    // Overrides for manual runs; cron passes {} and env vars decide.
    budget: v.optional(v.float64()),
    ageDays: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const budget = args.budget ?? Number(process.env.PARTS_PRICE_REFRESH_BUDGET ?? "0");
    if (!Number.isFinite(budget) || budget <= 0) {
      console.log("[price-refresh] PARTS_PRICE_REFRESH_BUDGET unset/0 — skipping");
      return { refreshedParts: 0, rowsWritten: 0, skipped: true };
    }
    const ageDays = args.ageDays ?? Number(process.env.PARTS_PRICE_REFRESH_AGE_DAYS ?? String(DEFAULT_AGE_DAYS));
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;

    // Gather up to `budget` stale parts.
    const stale: StalePart[] = [];
    let cursor: string | null = null;
    // Page cap guards against a pagination bug looping forever.
    for (let i = 0; i < 200 && stale.length < budget; i++) {
      const page: { stale: StalePart[]; continueCursor: string; isDone: boolean } =
        await ctx.runQuery(internal.vehicleEnrichment.priceRefresh.stalePricePartsPage, {
          cutoff,
          cursor,
        });
      stale.push(...page.stale);
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    const targets = stale.slice(0, budget);
    console.log(`[price-refresh] ${targets.length} stale parts selected (budget ${budget}, age > ${ageDays}d)`);

    let rowsWritten = 0;
    for (const t of targets) {
      try {
        const rows = await priceAllSources(
          t.urls,
          { oem: t.oem_part_number, partName: t.name, subcategory: t.subcategory },
          extractPriceFirecrawl,
        );
        for (const row of rows) {
          if (row.outcome.status !== "sale") continue;
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
            part_id: t.part_id as any,
            price: row.outcome.price,
            price_type: "sale",
            source_domain: row.source_domain,
            source_url: row.source_url,
            msrp: row.outcome.msrp ?? undefined,
            discount: row.outcome.discount ?? undefined,
          });
          rowsWritten++;
        }
        if (!rows.some((r) => r.outcome.status === "sale")) {
          console.warn(
            `[price-refresh] no trusted price for ${t.oem_part_number}: ` +
              rows.map((r) => `${r.source_domain}:${r.outcome.status}`).join(", "),
          );
        }
      } catch (e) {
        console.error(`[price-refresh] failed for ${t.oem_part_number}:`, e);
      }
    }

    console.log(`[price-refresh] done: ${targets.length} parts, ${rowsWritten} rows refreshed`);
    return { refreshedParts: targets.length, rowsWritten, skipped: false };
  },
});
