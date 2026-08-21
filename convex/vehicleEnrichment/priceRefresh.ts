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
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { extractPriceFirecrawl } from "./firecrawl";
import { priceAllSources } from "./priceReextract";
import { discoverPriceUrls } from "./priceDiscovery";
import { isPoisonPriceType, isNonPooledPriceType } from "../lib/priceTypes";

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
  /** Wave 1: a fresh "no_listing" discovery verdict is on file — the part
   *  stays in the CENSUS (its gap is real and must not read as healed) but
   *  target selection skips it so budget goes to winnable parts. */
  discovery_dead?: boolean;
};

/** How long a "no_listing" verdict suppresses re-discovery. Listings do
 *  appear over time (restocks, new sellers), so dead parts retry on a slow
 *  cadence instead of never. */
function noListingRetryMs(): number {
  return Number(process.env.PARTS_PRICE_NO_LISTING_RETRY_DAYS ?? "30") * 24 * 60 * 60 * 1000;
}

/**
 * How long an "unparsed" verdict suppresses re-discovery.
 *
 * SHORTER than no_listing on purpose, because the two describe opposite
 * situations. `no_listing` means nobody sells this number — only the market
 * changing fixes that. `unparsed` means sellers exist and we could not read a
 * price off their pages, which OUR next deploy might fix: a new selector, a
 * store admitted to getPriceStores, a JSON-LD shape learned. Retrying our own
 * fixable failure on the market's cadence would be wrong in both directions.
 */
function unparsedRetryMs(): number {
  return Number(process.env.PARTS_PRICE_UNPARSED_RETRY_DAYS ?? "7") * 24 * 60 * 60 * 1000;
}

/**
 * Is this part suppressed from target selection right now?
 *
 * THE SPLIT (Aug 2026). This used to recognise one verdict, and the gap was
 * not the one it looks like: a part whose discovery found URLs but whose pages
 * yielded NO PRICE recorded nothing at all. It therefore stayed fully eligible
 * and every sweep re-selected it, re-searched it, re-fetched the same
 * unparseable pages and failed identically — spending backfill budget on a
 * known-losing part, forever, while genuinely winnable parts waited behind it.
 *
 * "Found nothing" and "found something unreadable" now record separately and
 * back off on their own clocks. Any unrecognised verdict suppresses nothing,
 * so an older row or a future value can only ever cost a retry.
 */
/** How long ONE failed attempt suppresses re-discovery. Hours, not days:
 *  the heal-tail leg fires seconds after a part is written, and a single
 *  transient miss there (search racing the write, a throttled SERP) used to
 *  inherit the full no_listing/unparsed window — the Aug 20 2026 Nautilus had
 *  two parts with abundant dealer listings frozen for what would have been
 *  weeks, and the completion gate had nothing to promote on. The full windows
 *  now require a SECOND consecutive failure, hours later, when the miss is no
 *  longer plausibly a race. */
function firstFailureRetryMs(): number {
  return Number(process.env.PARTS_PRICE_FIRST_RETRY_HOURS ?? "6") * 60 * 60 * 1000;
}

/** Pure core of the suppression check (exported for tests). Rows stamped
 *  before the strikes column existed read as one strike — the short window —
 *  so every pre-existing frozen transient melts on the next nightly leg
 *  without a migration. */
export function discoveryDeadNow(
  part: {
    price_discovery_outcome?: string;
    price_discovery_at?: number;
    price_discovery_strikes?: number;
  },
  now: number,
): boolean {
  const at = part.price_discovery_at;
  if (typeof at !== "number") return false;
  const age = now - at;
  const strikes =
    typeof part.price_discovery_strikes === "number" ? part.price_discovery_strikes : 1;
  if (strikes <= 1) return age < firstFailureRetryMs();
  switch (part.price_discovery_outcome) {
    case "no_listing":
      return age < noListingRetryMs();
    case "unparsed":
      return age < unparsedRetryMs();
    default:
      return false;
  }
}

function isDiscoveryDead(part: {
  price_discovery_outcome?: string;
  price_discovery_at?: number;
  price_discovery_strikes?: number;
}): boolean {
  return discoveryDeadNow(part, Date.now());
}

/** Durable per-part discovery verdict — the answer to the canary's open
 *  question ("no listing found" vs "budget exhausted" were
 *  indistinguishable). outcome null clears the marker (a price landed). */
export const markPriceDiscoveryOutcome = internalMutation({
  args: {
    part_id: v.id("oem_parts"),
    outcome: v.union(v.literal("no_listing"), v.literal("unparsed"), v.null()),
  },
  handler: async (ctx, args) => {
    if (args.outcome === null) {
      await ctx.db.patch(args.part_id, {
        price_discovery_outcome: undefined,
        price_discovery_at: undefined,
        price_discovery_strikes: undefined,
      });
      return;
    }
    // Strikes escalate the backoff: the first failure suppresses for hours
    // (it may be a race with the part's own write), a repeat failure earns
    // the full per-outcome window. See discoveryDeadNow.
    const part: any = await ctx.db.get(args.part_id);
    const strikes =
      (typeof part?.price_discovery_strikes === "number" ? part.price_discovery_strikes : 0) + 1;
    await ctx.db.patch(args.part_id, {
      price_discovery_outcome: args.outcome,
      price_discovery_at: Date.now(),
      price_discovery_strikes: strikes,
    });
  },
});

/** A part counts as unpriced when it has no TRUSTED row — poison rows
 *  (unverified / online_discount / you_save) and non-pooled fallbacks never
 *  feed a quote, but the old any-row check made them hide the part from
 *  backfill forever (740iA: 6 parts stuck at price_unverified_sources). */
async function hasTrustedPriceRow(ctx: any, partId: any): Promise<boolean> {
  const rows = await ctx.db
    .query("part_prices")
    .withIndex("by_part", (q: any) => q.eq("part_id", partId))
    .collect();
  return rows.some(
    (r: any) => !isPoisonPriceType(r.price_type) && !isNonPooledPriceType(r.price_type),
  );
}

/**
 * One page of the zero-price scan. Paginates oem_parts (a part with no
 * part_prices rows never appears in the stale scan above) and returns current
 * parts that have at least one fitment but no trusted price row.
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
      // Fresh no_listing verdict → the fleet sweep skips it entirely (the
      // targeted config census below keeps such parts, flagged, so gaps
      // stay honest).
      if (isDiscoveryDead(part as any)) continue;

      if (await hasTrustedPriceRow(ctx, part._id)) continue;

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

      if (await hasTrustedPriceRow(ctx, f.part_id)) continue;

      const make = part.make_id ? await ctx.db.get(part.make_id) : null;
      out.push({
        part_id: key,
        oem_part_number: part.oem_part_number,
        name: part.name ?? null,
        subcategory: part.subcategory ?? null,
        make_name: make?.name ?? null,
        discovery_dead: isDiscoveryDead(part as any),
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
    // Bounded self-rescheduling for the targeted (per-config) backfill: when a
    // leg exhausts its per-action budget with parts still unpriced, it
    // re-chains up to maxChainDepth times before falling to the nightly sweep.
    chainDepth: v.optional(v.float64()),
    maxChainDepth: v.optional(v.float64()),
    /** Ignore no_listing/unparsed suppression for this run — the operator's
     *  targeted melt (replaces the zero-the-env-vars hack). Intended for
     *  per-config runs; a fleet-wide forceRetry re-spends budget on genuinely
     *  dead parts, so pair it with vehicleConfigId. */
    forceRetry: v.optional(v.boolean()),
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
      const skippedDead = args.forceRetry
        ? 0
        : zeroTargets.filter((t) => t.discovery_dead).length;
      const targets = zeroTargets
        .filter((t) => args.forceRetry === true || !t.discovery_dead)
        .slice(0, backfillBudget);
      console.log(
        `[price-refresh] ${targets.length} zero-price parts selected (backfill budget ${backfillBudget}` +
          (skippedDead > 0 ? `, ${skippedDead} skipped as no_listing/unparsed` : "") +
          (args.forceRetry ? `, forceRetry` : "") + `)`,
      );

      for (const t of targets) {
        try {
          const urls = await discoverPriceUrls({
            oem: t.oem_part_number,
            make: t.make_name,
            name: t.name,
          });
          if (urls === null) {
            // Discovery channel down (Firecrawl outage/limit) — leave the part
            // eligible; a no_listing stamp here would be an outage artifact
            // suppressing retries for the whole retry window.
            console.warn(
              `[price-refresh] backfill: discovery unavailable for ${t.oem_part_number} — no verdict recorded`,
            );
            continue;
          }
          if (urls.length === 0) {
            console.warn(`[price-refresh] backfill: no usable source found for ${t.oem_part_number}`);
            // Durable verdict: searched, nothing sells this number. Retries
            // after PARTS_PRICE_NO_LISTING_RETRY_DAYS, not next run.
            await ctx.runMutation(internal.vehicleEnrichment.priceRefresh.markPriceDiscoveryOutcome, {
              part_id: t.part_id as any,
              outcome: "no_listing",
            });
            continue;
          }
          const wrote = await priceAndWrite({ ...t, urls, discovered: true });
          if (wrote) {
            backfilledParts++;
            // A price landed — clear any stale marker of either kind.
            await ctx.runMutation(internal.vehicleEnrichment.priceRefresh.markPriceDiscoveryOutcome, {
              part_id: t.part_id as any,
              outcome: null,
            });
          } else {
            // Sellers EXIST and we could not read a price off any of them.
            // Recording nothing here is what made the sweep re-select this
            // part every run to fail the same way; recording `no_listing`
            // would be a lie about the market and would back off far too long
            // for a failure that is ours to fix.
            console.warn(
              `[price-refresh] backfill: ${urls.length} source(s) found for ` +
                `${t.oem_part_number} but no price parsed — unparsed`,
            );
            await ctx.runMutation(internal.vehicleEnrichment.priceRefresh.markPriceDiscoveryOutcome, {
              part_id: t.part_id as any,
              outcome: "unparsed",
            });
          }
        } catch (e) {
          console.error(`[price-refresh] backfill failed for ${t.oem_part_number}:`, e);
        }
      }
    }

    // ── Targeted-heal epilogue (vehicleConfigId runs only) ───────────────
    // 1. Chain: parts still unpriced + depth remaining → reschedule self.
    // 2. Reconcile: the run's quotability + part_price gaps were a snapshot at
    //    finalize — without this, a healed config reads "quotability:0.42"
    //    forever and stays partial (740iA post-mortem).
    if (args.vehicleConfigId && backfillOn) {
      let stillUnpriced: ZeroPricePart[] = [];
      try {
        stillUnpriced = await ctx.runQuery(
          internal.vehicleEnrichment.priceRefresh.zeroPricePartsForConfig,
          { vehicle_config_id: args.vehicleConfigId },
        );
      } catch (e) {
        console.warn("[price-refresh] post-heal unpriced re-scan failed:", e);
      }

      const chainDepth = args.chainDepth ?? 0;
      const maxChainDepth = args.maxChainDepth ?? 0;
      if (stillUnpriced.length > 0 && chainDepth < maxChainDepth && backfilledParts > 0) {
        // Re-chain only while we're making progress — a leg that priced
        // nothing would loop on permanently-undiscoverable parts.
        console.log(
          `[price-refresh] ${stillUnpriced.length} part(s) still unpriced — chaining (depth ${chainDepth + 1}/${maxChainDepth})`,
        );
        await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.priceRefresh.refreshStalePrices, {
          budget: 0,
          backfillBudget,
          vehicleConfigId: args.vehicleConfigId,
          chainDepth: chainDepth + 1,
          maxChainDepth,
        });
      }

      // Full reconcile + heal-only completion-gate re-run, shared with the
      // healAfterRun tail and devOnly/gateResweep (completionReevaluate.ts).
      // It recomputes fill via calculateV3FillRate and quotability from live
      // fitments — the stored config.fill_rate is a finalize-time snapshot,
      // and gating on it left every heal-lifted config stuck partial (Aug-8
      // fresh-VIN round 2: all five, e.g. Palisade run fill 64 → config 91).
      try {
        const gate: any = await ctx.runAction(
          internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
          { vehicleConfigId: args.vehicleConfigId },
        );
        console.log(
          `[price-refresh] reconciled run health: ${gate?.status}` +
            (gate?.status === "evaluated"
              ? ` — quotability ${gate.quotability_pct}, fill ${gate.fill} (${gate.fill_source}), ` +
                `${stillUnpriced.length} part(s) still unpriced` +
                (gate.promoted ? " — config promoted partial → complete" : "")
              : ""),
        );
      } catch (e) {
        console.warn("[price-refresh] run-health reconciliation failed (non-fatal):", e);
      }
    }

    console.log(`[price-refresh] done: ${refreshedParts} refreshed, ${backfilledParts} backfilled, ${rowsWritten} rows written`);
    return { refreshedParts, backfilledParts, rowsWritten, skipped: false };
  },
});
