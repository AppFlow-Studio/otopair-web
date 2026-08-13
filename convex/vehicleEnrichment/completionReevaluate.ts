/**
 * vehicleEnrichment/completionReevaluate.ts — post-heal completion-gate
 * re-evaluation (Aug-8 2026 fresh-VIN round 2 post-mortem).
 *
 * The completion gate (fill ≥ 70 AND quotability ≥ 0.8) is evaluated once at
 * finalize, against the run's finalize-time facts. The heal legs that follow
 * (refute harvest, genuine fluids, category pages, RockAuto interchange, oil
 * product, role repair, targeted price backfill) lift the config's REAL fill
 * and quotability within minutes — round 2 lifted config fill to 76–91 — but
 * nothing re-asked the gate with the healed numbers, so all five configs sat
 * "partial" forever ("partial" is terminal: no cron, poller, or later leg
 * re-runs the gate on its own).
 *
 * This action re-computes every gate input from the LIVE database —
 * calculateV3FillRate for fill, computeQuotability over current fitments and
 * trusted prices, the zero-price census for hasPriceGaps, the round-12 role
 * facts, and the interval-provenance census — then routes the verdict through
 * patchRunPriceHealth, which reconciles the latest run row and takes the
 * promotion inside one transaction. Promote-only by construction: STATUS can
 * only move partial → complete; complete/verified configs get run-row and
 * fill reconciliation but never a status write, and in-flight runs are
 * skipped entirely.
 *
 * Wired at the tail of resourceRoles.healAfterRun (covers fill lifted by the
 * synchronous rungs) and reached again through the targeted price-backfill
 * epilogue in priceRefresh.ts (covers prices landed by the async chain).
 * Also the engine behind devOnly/gateResweep for healing already-stuck rows.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { calculateV3FillRate, PART_FIELD_MAP } from "./v3pipeline";
import { computeQuotability, missingCoreRoles, axlePairGaps } from "./quotability";
import { computeEnrichmentStatus, explainGateDecision } from "./completionGate";

export const reevaluateGate = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    /** Compute + report only — no run reconcile, no status/fill writes. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const config: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!config) return { status: "config_not_found", configId: String(args.vehicleConfigId) };

    const before = config.enrichment_status ?? null;
    if (!["partial", "complete", "verified"].includes(before)) {
      // A config mid-run (enriching/batch1/…) belongs to its pipeline chain,
      // not to this path. Terminal complete/verified configs continue: their
      // status can never change here (promote-only, from "partial" alone) but
      // the run-row reconcile below still keeps quotability truthful after
      // late heal legs land on an already-complete config.
      return { status: "skipped_in_flight", enrichment_status: before };
    }

    // ── Live fill — the stored fill_rate is a finalize-time snapshot ──────
    let fillRate: number = config.fill_rate ?? 0;
    let fillSource: "live" | "stored_fallback" = "stored_fallback";
    try {
      const { rate } = await calculateV3FillRate(
        ctx, args.vehicleConfigId, config.engine_id, config.transmission_id,
      );
      fillRate = rate;
      fillSource = "live";
    } catch (e) {
      console.warn("[gate-reevaluate] live fill recompute failed — using stored fill:", e);
    }

    // ── Live quotability over current fitments + trusted prices ───────────
    const latestRun: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const applicableSlugs: string[] = ((latestRun?.quotability?.services ?? []) as any[]).map(
      (s: any) => s.slug,
    );
    if (applicableSlugs.length === 0) {
      // No persisted applicable-service snapshot to recompute against — a
      // promote here would rest on an unverifiable quotability, so report only.
      return {
        status: "no_quotability_snapshot",
        enrichment_status: before,
        fill: fillRate,
        fill_source: fillSource,
      };
    }

    // Same N/A-role recipe as finalize: run-level applicability nulls (from
    // the run's field_gaps ledger — the flat field map is long gone) ∪ the
    // config's durable na_role_keys memory (rear drums survive re-runs there).
    const naRoleKeys = new Set<string>([
      ...(((latestRun?.field_gaps ?? []) as Array<{ field: string; reason: string }>)
        .filter((g) => g.reason === "not_applicable" && PART_FIELD_MAP[g.field])
        .map((g) => PART_FIELD_MAP[g.field].subcategory)),
      ...(((config.na_role_keys ?? []) as string[])),
    ]);

    const fitments: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const quotability = computeQuotability(fitments, applicableSlugs, naRoleKeys);
    const missing = missingCoreRoles(fitments, applicableSlugs, naRoleKeys);
    const axleGaps = axlePairGaps(fitments, applicableSlugs, naRoleKeys);
    const missingStrings = missing.map((m) => `${m.serviceSlug}:${m.roleKey}`);
    const axleStrings = axleGaps.map((g) => `${g.serviceSlug}:${g.missingRole}`);

    const stillUnpriced: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.priceRefresh.zeroPricePartsForConfig,
      { vehicle_config_id: args.vehicleConfigId },
    );

    // Interval-provenance census — env-staged (default log); recomputed so an
    // eventual enforce stage can never be promoted around.
    let intervalProvenanceGaps: string[] = [];
    try {
      const intervalRows: any[] = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getIntervalProvenance,
        { vehicleConfigId: args.vehicleConfigId },
      );
      intervalProvenanceGaps = intervalRows
        .filter((row) => row.data_quality === "default_fallback" || row.months_from_default)
        .map((row) =>
          row.data_quality === "default_fallback"
            ? `${row.slug || "?"}:interval`
            : `${row.slug || "?"}:months`,
        )
        .sort();
    } catch (e) {
      console.warn("[gate-reevaluate] interval-provenance census failed (non-fatal):", e);
    }

    const gateInput = {
      fillRate,
      quotabilityPct: quotability.pct,
      hasPriceGaps: stillUnpriced.length > 0,
      missingCoreRoles: missingStrings,
      axlePairGaps: axleStrings,
      intervalProvenanceGaps,
    };
    const decision = computeEnrichmentStatus(gateInput);
    const explain = explainGateDecision(gateInput);
    console.log(
      `[gate-reevaluate] config ${args.vehicleConfigId} (${before}, stored fill ` +
        `${config.fill_rate ?? "—"}) → ${decision}: ${explain}${args.dryRun ? " [dry-run]" : ""}`,
    );

    const report = {
      status: "evaluated",
      enrichment_status: before,
      decision,
      explain,
      fill: fillRate,
      fill_source: fillSource,
      stored_fill: config.fill_rate ?? null,
      quotability_pct: quotability.pct,
      unpriced_parts: stillUnpriced.length,
      missing_core_roles: missingStrings,
      axle_pair_gaps: axleStrings,
      interval_provenance_gaps: intervalProvenanceGaps.length,
      dry_run: !!args.dryRun,
      promoted: false,
    };
    if (args.dryRun) return report;

    // Reconcile the run row + take the promotion in ONE mutation —
    // patchRunPriceHealth re-checks status inside the transaction, so a run
    // that started between our read and this write can't be clobbered.
    const missingBySlug = new Map<string, string[]>();
    for (const m of missing) {
      missingBySlug.set(m.serviceSlug, [...(missingBySlug.get(m.serviceSlug) ?? []), m.roleKey]);
    }
    const stillUnpricedKeys = stillUnpriced.flatMap((p) =>
      [p.subcategory, p.oem_part_number, p.part_id].filter((x): x is string => !!x),
    );
    const res: any = await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.patchRunPriceHealth,
      {
        vehicle_config_id: args.vehicleConfigId,
        quotability: {
          pct: quotability.pct,
          services: quotability.services.map((s) => ({
            ...s,
            ...(missingBySlug.has(s.slug) ? { missing_roles: missingBySlug.get(s.slug) } : {}),
          })),
        },
        still_unpriced_keys: stillUnpricedKeys,
        live_fill_rate: fillSource === "live" ? fillRate : undefined,
        missing_core_roles: missingStrings,
        axle_pair_gaps: axleStrings,
        interval_provenance_gaps: intervalProvenanceGaps,
      },
    );
    return { ...report, promoted: !!res?.promoted, status_after: res?.status_after ?? before };
  },
});
