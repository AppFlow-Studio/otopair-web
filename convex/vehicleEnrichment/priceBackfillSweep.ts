/**
 * vehicleEnrichment/priceBackfillSweep.ts — nightly sweep for parts that have
 * NEVER been priced (Sep 4 2026 census: the price-only cohort — 76 configs
 * with every fitment present and ≥1 unpriced part — sat frozen for a week
 * with lit budgets).
 *
 * WHY A THIRD PRICE LEG. The nightly refresh (priceRefresh.refreshStalePrices)
 * re-verifies parts that already HAVE a price row — its stale scan paginates
 * part_prices, so a zero-row part is invisible to it. Its fleet backfill leg
 * (PARTS_PRICE_BACKFILL_BUDGET) walks oem_parts in table order, blind to which
 * configs a part would make quotable. And the TARGETED per-config backfill
 * only fires from run/heal epilogues — a config whose run finished last week
 * never runs again, so its unpriced parts are reachable by nothing. This sweep
 * closes the triangle: walk the FLEET stalest-first, find configs whose own
 * quotability snapshot says "fitment present, price missing"
 * (core_with_price < core_with_fitment), and point the existing targeted
 * backfill at them.
 *
 * MECHANISM. Freshness-ordered like fitmentReverify.nightly — a stamp column
 * (vehicle_configs.price_sweep_at) instead of cursor state; never-swept first,
 * oldest stamp next; every EXAMINED config is stamped (no-op ones included) so
 * the rotation is fair. A qualifying config's unpriced parts are re-resolved
 * LIVE (summarizePartPrices sample_size — the quote engine's own standard;
 * snapshots lie after heals), then the config is dispatched to
 * priceRefresh.refreshStalePrices with vehicleConfigId — the SAME entry point
 * healAfterRun schedules — so URL discovery, the no_listing/unparsed backoff
 * verdicts, and the completion-gate re-evaluation at that action's tail are
 * all inherited, not reimplemented.
 *
 * DARK unless PARTS_PRICE_SWEEP_BUDGET (parts per night) is set > 0 — the
 * budget env is the kill switch, same as every sibling leg. Cron slot 10:00
 * UTC, after the 09:00 refresh, so the two Firecrawl spends never share a
 * window.
 *
 * GOTCHAs:
 *  - The budget counts parts SCHEDULED for discovery, not prices landed — a
 *    dispatched config's targeted run re-runs its own census when it fires
 *    and skips anything priced or backing off by then, so the number is an
 *    upper bound on spend, never a promise of writes.
 *  - No reevaluateGate is scheduled for DISPATCHED configs: the targeted
 *    refreshStalePrices epilogue already runs the gate inline after its
 *    discovery completes (its sequencing is synchronous at the action tail —
 *    there is no scheduler delay to copy). A second gate call on a guessed
 *    delay would only race it. The gate IS called from here for one case:
 *    a config whose snapshot says "unpriced" but whose parts are all
 *    live-priced now — nothing to dispatch, only the snapshot is stale.
 *  - Parts inside their discovery backoff window (discoveryDeadNow — see the
 *    strikes semantics on oem_parts in schema.ts) never count against the
 *    budget; a config whose gaps are ALL backing off is examined + stamped
 *    but not dispatched, so budget flows to winnable parts.
 *  - Configs sharing an unpriced part are deduped per night: the first
 *    config's dispatch carries the part; a later config with nothing NEW is
 *    skipped undispatched (its snapshot heals on a later rotation once the
 *    shared part is priced). Dispatches are staggered 90s apart — the
 *    fitmentReverify heal-stagger precedent — so shared parts usually have a
 *    price row before the second run's census reads them.
 *
 * Manual run: nightly '{"budget":10,"dryRun":true}' (census + report only).
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { summarizePartPrices } from "../part_prices";
import { discoveryDeadNow } from "./priceRefresh";

// This module is new — `internal.vehicleEnrichment.priceBackfillSweep` is
// absent from _generated/api.d.ts until the next codegen, so self-references
// go through the same `(internal as any)` escape crons.ts uses for nhtsaOdi
// et al. Tighten after codegen.
const selfApi = () => (internal as any).vehicleEnrichment.priceBackfillSweep;

/** Only settled configs are sweepable — a config mid-run belongs to its
 *  pipeline chain (which prices its own parts and runs its own epilogue);
 *  spending sweep budget there would double-attempt the same discoveries.
 *  Same status filter as resourceRoles.fleetRoleGapPage. */
const SWEEPABLE_STATUSES = new Set(["complete", "partial", "verified"]);

/** One page of (config id, sweep stamp, status). Minimal rows on purpose: the
 *  action accumulates the whole fleet's stamps to sort stalest-first, and a
 *  full-table `.collect()` in one query is the thing this pagination avoids
 *  (the fitmentReverify._stalestConfigs shortcut, made read-bounded). */
export const _configStampPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), pageSize: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor, numItems: Math.max(1, Math.trunc(args.pageSize)) });
    return {
      rows: page.page.map((c: any) => ({
        id: c._id,
        at: (c.price_sweep_at as number | undefined) ?? 0,
        status: (c.enrichment_status as string | undefined) ?? "",
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Examined means "went through the loop" — including configs with no gap and
 *  configs whose gaps are all in backoff. Without stamping those, they'd sit
 *  at the front of the stalest-first ordering forever, eating the nightly
 *  examine window on no-ops (the fitment_audited_at lesson). */
export const _stampSwept = internalMutation({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.vehicleConfigId, { price_sweep_at: Date.now() });
  },
});

/**
 * Census for ONE config: does its latest quotability snapshot show a service
 * with fitments-but-no-price, and which parts are ACTUALLY unpriced right now?
 *
 * Two layers on purpose. The snapshot qualifies cheaply (no per-part reads for
 * the majority of the fleet); the live layer is the truth — snapshots go stale
 * the moment any heal lands, and dispatching off a stale one would spend
 * discovery on already-priced parts. sample_size === 0 is the quote engine's
 * own "unpriced" standard (poison/non-pooled/out-of-band rows don't count).
 */
export const _priceGapCensus = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const cfg: any = await ctx.db.get(args.vehicleConfigId);
    if (!cfg) return null;

    // Latest run carrying a quotability snapshot (finalize-time or healed) —
    // the roadTo10 census read: newest 12, first with a pct.
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .order("desc")
      .take(12);
    const withQ: any = runs.find((r: any) => r.quotability?.pct != null);
    const gapServices = ((withQ?.quotability?.services ?? []) as any[])
      .filter((s) => Math.max(0, (s.core_with_fitment ?? 0) - (s.core_with_price ?? 0)) > 0)
      .map((s) => s.slug as string);

    const base = {
      configKey: (cfg.config_key as string | undefined) ?? String(args.vehicleConfigId),
      gapServices,
      unpricedPartIds: [] as string[],
      skippedBackoff: 0,
    };
    if (gapServices.length === 0) return { ...base, qualifies: false };

    // Live resolution. Bounded fitment read; dedupe by part; universal
    // consumable fallbacks (OTOPAIR-UNIV) are synthetic rows that discovery
    // can never price; superseded parts are no longer quoted.
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .take(200);
    const seen = new Set<string>();
    const now = Date.now();
    for (const f of fitments) {
      const key = String(f.part_id);
      if (seen.has(key)) continue;
      seen.add(key);
      const part: any = await ctx.db.get(f.part_id);
      if (!part || part.is_current === false) continue;
      const oem: string = part.oem_part_number ?? "";
      if (!oem || oem.startsWith("OTOPAIR-UNIV")) continue;
      const summary = await summarizePartPrices(ctx, f.part_id);
      if (summary.sample_size > 0) continue;
      if (discoveryDeadNow(part, now)) {
        base.skippedBackoff++;
        continue;
      }
      base.unpricedPartIds.push(key);
    }
    return { ...base, qualifies: true };
  },
});

/** Nightly driver. Dark (no-op with a log) unless PARTS_PRICE_SWEEP_BUDGET
 *  (parts per night) is set > 0. Args are manual-run overrides; cron passes
 *  {} and env decides. */
export const nightly = internalAction({
  args: {
    budget: v.optional(v.number()),
    /** Configs examined per night before giving up on finding budget-worth of
     *  gaps (default max(40, budget*4)) — bounds the action's wall clock. */
    examineCap: v.optional(v.number()),
    /** Census + report only: no stamps, no dispatches, no gate calls. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const budget = args.budget ?? Number(process.env.PARTS_PRICE_SWEEP_BUDGET ?? "0");
    if (!Number.isFinite(budget) || budget <= 0) {
      console.log("[price-sweep] PARTS_PRICE_SWEEP_BUDGET unset/0 — nightly zero-price sweep dark");
      return { skipped: true };
    }
    const dryRun = args.dryRun === true;
    const examineCap = Math.max(
      1,
      Math.trunc(args.examineCap ?? Math.max(40, budget * 4)),
    );

    // ── Stalest-first candidate order (bounded page loop, no cursor state) ──
    const candidates: Array<{ id: any; at: number }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const page: any = await ctx.runQuery(selfApi()._configStampPage, {
        cursor,
        pageSize: 100,
      });
      for (const row of page.rows) {
        if (!SWEEPABLE_STATUSES.has(row.status)) continue;
        candidates.push({ id: row.id, at: row.at });
      }
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    candidates.sort((a, b) => a.at - b.at);

    // Per-config cap: the SAME env the heal epilogue passes as its targeted
    // backfillBudget, so one sweep dispatch can never out-spend a heal.
    const perConfigCap = Number(process.env.PARTS_PRICE_IMMEDIATE_BACKFILL_CAP ?? "12");
    const seenParts = new Set<string>();
    let examined = 0;
    let qualified = 0;
    let dispatchedConfigs = 0;
    let partsDispatched = 0;
    let skippedBackoff = 0;
    let skippedSharedOnly = 0;
    let gateOnly = 0;
    const dispatches: string[] = [];

    for (const cand of candidates) {
      if (examined >= examineCap || partsDispatched >= budget) break;
      examined++;

      let census: any = null;
      try {
        census = await ctx.runQuery(selfApi()._priceGapCensus, {
          vehicleConfigId: cand.id,
        });
      } catch (e) {
        console.error(`[price-sweep] census failed for ${String(cand.id)}:`, e);
      }
      if (!dryRun) {
        await ctx.runMutation(selfApi()._stampSwept, { vehicleConfigId: cand.id });
      }
      if (!census?.qualifies) continue;
      qualified++;
      skippedBackoff += census.skippedBackoff;

      if (census.unpricedPartIds.length === 0) {
        if (census.skippedBackoff === 0) {
          // Prices landed since the snapshot (another leg healed this config)
          // but nothing ever re-asked the gate — the exact stale-forever
          // failure completionReevaluate exists for. DB-only, promote-only.
          gateOnly++;
          console.log(
            `[price-sweep] ${census.configKey}: snapshot stale (all parts live-priced) — gate re-evaluation only`,
          );
          if (!dryRun) {
            await ctx.scheduler.runAfter(
              0,
              internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
              { vehicleConfigId: cand.id },
            );
          }
        }
        continue;
      }

      // Cross-config dedupe: a part shared with an earlier dispatch tonight is
      // already being discovered; a config contributing NOTHING new skips its
      // turn (a later rotation re-evaluates it once prices exist).
      const newParts = census.unpricedPartIds.filter((p: string) => !seenParts.has(p));
      if (newParts.length === 0) {
        skippedSharedOnly++;
        continue;
      }
      for (const p of census.unpricedPartIds) seenParts.add(p);

      const backfillBudget = Math.min(
        census.unpricedPartIds.length,
        perConfigCap,
        budget - partsDispatched,
      );
      if (backfillBudget <= 0) break;
      if (!dryRun) {
        // The heal epilogue's exact entry point + invocation style (schedule,
        // never await — discovery must not share this action's wall clock).
        // Deliberately NO chainDepth: the nightly cadence IS the retry loop
        // here, and a chained re-leg would spend past the budget.
        await ctx.scheduler.runAfter(
          dispatchedConfigs * 90_000,
          internal.vehicleEnrichment.priceRefresh.refreshStalePrices,
          {
            budget: 0, // fleet-wide stale leg stays off — this is a targeted dispatch
            backfillBudget,
            vehicleConfigId: cand.id,
          },
        );
      }
      partsDispatched += backfillBudget;
      dispatchedConfigs++;
      dispatches.push(
        `${census.configKey}: ${backfillBudget}/${census.unpricedPartIds.length} part(s) [${census.gapServices.join(",")}]`,
      );
    }

    const summary = {
      examined,
      qualified,
      dispatchedConfigs,
      partsDispatched,
      skippedBackoff,
      skippedSharedOnly,
      gateOnly,
      budget,
      dryRun,
      dispatches,
    };
    console.log(
      `[price-sweep] ${examined} config(s) examined, ${qualified} qualified: ` +
        `${partsDispatched} part(s) dispatched across ${dispatchedConfigs} config(s) ` +
        `(budget ${budget}), ${skippedBackoff} part(s) in backoff, ` +
        `${skippedSharedOnly} shared-only config(s) skipped, ${gateOnly} gate-only` +
        (dryRun ? " [dry-run]" : ""),
    );
    return summary;
  },
});
