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
 *
 * Backfill leg (Jul 2026): parts with ZERO part_prices rows are invisible to
 * the stale scan above (it paginates part_prices), so a part that failed
 * pricing on its enrichment run stayed unpriced forever — 2023 Sierra: 14 of
 * 36 fitments. PARTS_PRICE_BACKFILL_BUDGET (default 0 = OFF) prices such
 * parts via search-based URL discovery (priceDiscovery.ts).
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { extractPriceFirecrawl } from "./firecrawl";
import { priceAllSources } from "./priceReextract";
import { discoverPriceUrls } from "./priceDiscovery";

const DEFAULT_AGE_DAYS = 30;

type StalePart = {
  part_id: string;
  oem_part_number: string;
  name: string | null;
  subcategory: string | null;
  urls: string[];
  /** max(refreshed_at) across the part's rows — drives oldest-first ordering
   *  so the budget goes to the most-aged prices, not pagination order. */
  newest_refreshed_at: number;
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
        newest_refreshed_at: newest,
      });
    }

    return { stale: out, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

type ZeroPricePart = {
  part_id: string;
  oem_part_number: string;
  name: string | null;
  subcategory: string | null;
  make_name: string | null;
};

/**
 * One page of the zero-price scan. Paginates oem_parts (a part with no
 * part_prices rows never appears in the stale scan above) and returns current
 * parts that have at least one fitment but no price row at all.
 */
export const zeroPricePartsPage = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("oem_parts")
      .paginate({ cursor: args.cursor ?? null, numItems: args.pageSize ?? 100 });

    const out: ZeroPricePart[] = [];
    for (const part of page.page) {
      // Superseded parts are no longer quoted; don't spend backfill budget.
      if (part.is_current === false) continue;

      const anyPrice = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", part._id))
        .first();
      if (anyPrice) continue;

      // Only parts actually attached to a vehicle feed quotes.
      const anyFitment = await ctx.db
        .query("part_fitments")
        .withIndex("by_part", (q) => q.eq("part_id", part._id))
        .first();
      if (!anyFitment) continue;

      const make = part.make_id ? await ctx.db.get(part.make_id) : null;
      out.push({
        part_id: String(part._id),
        oem_part_number: part.oem_part_number,
        name: part.name ?? null,
        subcategory: part.subcategory ?? null,
        make_name: make?.name ?? null,
      });
    }

    return { parts: out, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Zero-price parts for ONE vehicle config — the targeted variant of the page
 * scan above, for healing a specific config (e.g. after deleting its
 * marketplace rows) without waiting for the global sweep to reach its parts.
 */
export const zeroPricePartsForConfig = internalQuery({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();

    const seen = new Set<string>();
    const out: ZeroPricePart[] = [];
    for (const f of fitments) {
      const key = String(f.part_id);
      if (seen.has(key)) continue;
      seen.add(key);

      const part = await ctx.db.get(f.part_id);
      if (!part || part.is_current === false) continue;

      const anyPrice = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .first();
      if (anyPrice) continue;

      const make = part.make_id ? await ctx.db.get(part.make_id) : null;
      out.push({
        part_id: key,
        oem_part_number: part.oem_part_number,
        name: part.name ?? null,
        subcategory: part.subcategory ?? null,
        make_name: make?.name ?? null,
      });
    }
    return out;
  },
});

/** Nightly driver. No-op unless PARTS_PRICE_REFRESH_BUDGET > 0. */
export const refreshStalePrices = internalAction({
  args: {
    // Overrides for manual runs; cron passes {} and env vars decide.
    budget: v.optional(v.float64()),
    ageDays: v.optional(v.float64()),
    backfillBudget: v.optional(v.float64()),
    // Restrict the backfill leg to one config's parts (manual healing runs).
    vehicleConfigId: v.optional(v.id("vehicle_configs")),
  },
  handler: async (ctx, args) => {
    const budget = args.budget ?? Number(process.env.PARTS_PRICE_REFRESH_BUDGET ?? "0");
    const backfillBudget =
      args.backfillBudget ?? Number(process.env.PARTS_PRICE_BACKFILL_BUDGET ?? "0");
    const refreshOn = Number.isFinite(budget) && budget > 0;
    const backfillOn = Number.isFinite(backfillBudget) && backfillBudget > 0;
    if (!refreshOn && !backfillOn) {
      console.log("[price-refresh] PARTS_PRICE_REFRESH_BUDGET and PARTS_PRICE_BACKFILL_BUDGET unset/0 — skipping");
      return { refreshedParts: 0, backfilledParts: 0, rowsWritten: 0, skipped: true };
    }

    let rowsWritten = 0;
    /** priceAllSources → write "sale" rows. Shared by both legs. Returns true
     *  when at least one trusted price was written. */
    const priceAndWrite = async (t: {
      part_id: string;
      oem_part_number: string;
      name: string | null;
      subcategory: string | null;
      urls: string[];
      /** True when the urls came from web-search discovery (backfill leg). */
      discovered?: boolean;
    }): Promise<boolean> => {
      const rows = await priceAllSources(
        t.urls,
        {
          oem: t.oem_part_number,
          partName: t.name,
          subcategory: t.subcategory,
          requireOemEcho: t.discovered === true,
        },
        extractPriceFirecrawl,
      );
      let wrote = false;
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
        wrote = true;
      }
      if (!wrote) {
        console.warn(
          `[price-refresh] no trusted price for ${t.oem_part_number}: ` +
            rows.map((r) => `${r.source_domain}:${r.outcome.status}`).join(", "),
        );
      }
      return wrote;
    };

    // ── Leg 1: stale refresh ─────────────────────────────────────────────
    let refreshedParts = 0;
    if (refreshOn) {
      const ageDays = args.ageDays ?? Number(process.env.PARTS_PRICE_REFRESH_AGE_DAYS ?? String(DEFAULT_AGE_DAYS));
      const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;

      // Gather stale parts, then spend the budget oldest-first. Scanning a few
      // pages beyond the budget costs only index reads and lets the sort see a
      // wider pool than raw pagination order.
      const stale: StalePart[] = [];
      let cursor: string | null = null;
      // Page cap guards against a pagination bug looping forever.
      for (let i = 0; i < 200 && stale.length < budget * 4; i++) {
        const page: { stale: StalePart[]; continueCursor: string; isDone: boolean } =
          await ctx.runQuery(internal.vehicleEnrichment.priceRefresh.stalePricePartsPage, {
            cutoff,
            cursor,
          });
        stale.push(...page.stale);
        cursor = page.continueCursor;
        if (page.isDone) break;
      }
      const targets = stale
        .sort((a, b) => (a.newest_refreshed_at ?? 0) - (b.newest_refreshed_at ?? 0))
        .slice(0, budget);
      console.log(`[price-refresh] ${targets.length} stale parts selected (budget ${budget}, age > ${ageDays}d)`);
      refreshedParts = targets.length;

      for (const t of targets) {
        try {
          await priceAndWrite(t);
        } catch (e) {
          console.error(`[price-refresh] failed for ${t.oem_part_number}:`, e);
        }
      }
    }

    // ── Leg 2: zero-price backfill ───────────────────────────────────────
    // Parts with no price rows need URL discovery first (there are no known
    // source URLs to re-hit). Budget counts parts ATTEMPTED, so a part whose
    // discovery finds nothing doesn't burn the whole run retrying forever.
    let backfilledParts = 0;
    if (backfillOn) {
      const zeroTargets: ZeroPricePart[] = [];
      if (args.vehicleConfigId) {
        zeroTargets.push(
          ...(await ctx.runQuery(internal.vehicleEnrichment.priceRefresh.zeroPricePartsForConfig, {
            vehicle_config_id: args.vehicleConfigId,
          })),
        );
      } else {
        let cursor: string | null = null;
        for (let i = 0; i < 200 && zeroTargets.length < backfillBudget; i++) {
          const page: { parts: ZeroPricePart[]; continueCursor: string; isDone: boolean } =
            await ctx.runQuery(internal.vehicleEnrichment.priceRefresh.zeroPricePartsPage, {
              cursor,
            });
          zeroTargets.push(...page.parts);
          cursor = page.continueCursor;
          if (page.isDone) break;
        }
      }
      const targets = zeroTargets.slice(0, backfillBudget);
      console.log(`[price-refresh] ${targets.length} zero-price parts selected (backfill budget ${backfillBudget})`);

      for (const t of targets) {
        try {
          const urls = await discoverPriceUrls({
            oem: t.oem_part_number,
            make: t.make_name,
            name: t.name,
          });
          if (urls.length === 0) {
            console.warn(`[price-refresh] backfill: no usable source found for ${t.oem_part_number}`);
            continue;
          }
          const wrote = await priceAndWrite({ ...t, urls, discovered: true });
          if (wrote) backfilledParts++;
        } catch (e) {
          console.error(`[price-refresh] backfill failed for ${t.oem_part_number}:`, e);
        }
      }
    }

    console.log(`[price-refresh] done: ${refreshedParts} refreshed, ${backfilledParts} backfilled, ${rowsWritten} rows written`);
    return { refreshedParts, backfilledParts, rowsWritten, skipped: false };
  },
});
