/**
 * vehicleEnrichment/resourceRoles.ts — standalone role-completeness repair
 * (round 12).
 *
 * The in-pipeline hook (v3pipeline finalize) repairs missing binding core
 * roles on every fresh run — but the fleet's ALREADY-enriched configs (the
 * Crosstrek shipped rear-only brake data as "complete") never re-run just to
 * heal. This action repairs one config in place, without a purge or re-run:
 * detect missing roles from live fitments → resourceMissingRoles (Tier-1
 * storefront / Tier-2 verified research, empty-fill only) → persist
 * na_role_keys findings → reconcile the latest run row's quotability /
 * field_gaps / errors via patchRunRoleHealth (heal-only status promotion).
 *
 * Run manually:
 *   npx convex run vehicleEnrichment/resourceRoles:repairMissingRoles \
 *     '{"vehicleConfigId":"<id>"}'
 * or over a set: repairMissingRolesBatch '{"vehicleConfigIds":[...]}' (cap 10).
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { axlePairGaps, computeQuotability, missingCoreRoles } from "./quotability";
import { resourceMissingRoles, soleFlaggedWinnerRoles } from "./utils/roleResource";
import { PART_FIELD_MAP } from "./v3pipeline";

/** field_gaps reason per outcome — shared with the pipeline hook's mapping. */
function gapReasonFor(outcome: string): string {
  switch (outcome) {
    case "written":
      return "resourced";
    case "not_applicable":
      return "resource_not_applicable";
    case "rejected_refuted":
      return "resource_refuted_no_replacement";
    // Untried this run, but a bigger budget or the next run WILL attempt it.
    case "skipped_run_budget":
      return "resource_skipped_run_budget";
    // Untried and futile to retry — lifetime attempts exhausted.
    case "skipped_lifetime_cap":
      return "resource_skipped_lifetime_cap";
    // Legacy: historical rows only. Kept so old runs still map to something.
    case "skipped_budget":
      return "resource_skipped_budget";
    default:
      return "resource_never_found";
  }
}

export const repairMissingRoles = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    maxRoles: v.optional(v.number()),
    /** Round 12b: explicit applicable-service slugs, for configs whose run
     *  history holds no usable quotability snapshot (purge deletes run rows;
     *  a Batch-2 misfire can leave the sole fresh run with services: []).
     *  Director/operator-supplied context — e.g. the pre-purge run's list —
     *  NOT a guess; the drum-brake safety argument still holds because
     *  naRoleKeys and satisfiedWhenAbsent apply on top of it. */
    applicableSlugsOverride: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const resolved: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!resolved || !resolved.makeId) {
      return { status: "no_config" as const };
    }

    const latestRun: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    // Applicable services recovered from the newest run whose quotability
    // snapshot carries them (round 12b: the latest run can hold an EMPTY
    // services array when Batch-2 misfires — fall back to the last non-empty
    // one). Without any prior truth we cannot know which services this
    // vehicle carries, and guessing would demand drum-brake cars grow
    // rotors. Honest abort.
    let applicableSlugs: string[] =
      args.applicableSlugsOverride && args.applicableSlugsOverride.length > 0
        ? args.applicableSlugsOverride
        : ((latestRun?.quotability?.services ?? []) as any[]).map((s: any) => s.slug);
    if (applicableSlugs.length === 0) {
      applicableSlugs = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getPriorApplicableSlugs,
        { vehicleConfigId: args.vehicleConfigId },
      );
    }
    if (applicableSlugs.length === 0) {
      return { status: "no_run_quotability" as const };
    }

    const configRow: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicleConfigId },
    );
    // N/A union — the priceRefresh pattern (run field_gaps) ∪ the durable
    // config-level memory this repair itself writes.
    const naKeys = new Set<string>([
      ...(((latestRun?.field_gaps ?? []) as Array<{ field: string; reason: string }>)
        .filter((g) => g.reason === "not_applicable" && (PART_FIELD_MAP as any)[g.field])
        .map((g) => (PART_FIELD_MAP as any)[g.field].subcategory) as string[]),
      ...(((configRow?.na_role_keys ?? []) as string[]) ?? []),
    ]);

    const fitmentsBefore = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const missingBefore = missingCoreRoles(fitmentsBefore, applicableSlugs, naKeys);

    // Round 13: sole-flagged-winner roles — every candidate in a core slot is
    // soft-flagged, so the wrong part wins unopposed ("demoted-wrong-winner").
    // The remedy is ADDITIVE: research + verify a rival; the selector's
    // existing refute-demotion layer then swaps winners. Incumbents are never
    // touched. Disable: PARTS_ROLE_RIVAL=0.
    let rivalTargets: Array<{
      serviceSlug: string;
      roleKey: string;
      fitmentService: string;
      kind: "rival";
      flaggedOems: string[];
    }> = [];
    if ((process.env.PARTS_ROLE_RIVAL ?? "1") !== "0") {
      const candidateRows: any[] = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getFitmentCandidateRows,
        { vehicleConfigId: args.vehicleConfigId },
      );
      rivalTargets = soleFlaggedWinnerRoles(candidateRows)
        .filter((r) => !naKeys.has(r.roleKey))
        .map((r) => ({
          serviceSlug: r.serviceType,
          roleKey: r.roleKey,
          fitmentService: r.serviceType,
          kind: "rival" as const,
          flaggedOems: r.flaggedOems,
        }));
    }

    let outcomes: Array<{ roleKey: string; outcome: string; oem?: string; kind?: string }> = [];
    if (missingBefore.length > 0 || rivalTargets.length > 0) {
      const metaBySubcategory: Record<string, any> = Object.fromEntries(
        Object.values(PART_FIELD_MAP).map((m: any) => [m.subcategory, m]),
      );
      const attemptsByField: Record<string, number> = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getRoleResourceAttempts,
        { vehicleConfigId: args.vehicleConfigId },
      );
      const priorAttemptsByRole = new Map<string, number>();
      for (const [fieldKey, n] of Object.entries(attemptsByField)) {
        const sub = (PART_FIELD_MAP as any)[fieldKey]?.subcategory;
        if (sub) priorAttemptsByRole.set(sub, n);
      }
      const blockedRows: any[] = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getBlockedOemsForConfig,
        { vehicleConfigId: args.vehicleConfigId },
      );
      const blockedOems = new Set<string>(blockedRows.map((b) => b.oem_part_number_normalized));
      // Rival incumbents are excluded from research everywhere the blocklist is.
      for (const t of rivalTargets) for (const oem of t.flaggedOems) blockedOems.add(oem);

      outcomes = await resourceMissingRoles(
        ctx,
        {
          year: resolved.year,
          make: resolved.make,
          model: resolved.model,
          trim: resolved.trim,
          engineCode: resolved.engineCode,
          displacement: resolved.displacement,
          vehicleConfigId: args.vehicleConfigId,
          makeId: resolved.makeId,
        },
        // Fills first — an EMPTY role outranks a flagged-but-present one.
        [...missingBefore, ...rivalTargets],
        metaBySubcategory,
        { maxRoles: args.maxRoles, priorAttemptsByRole, blockedOems },
      );

      const naFound = outcomes.filter((o) => o.outcome === "not_applicable");
      if (naFound.length > 0) {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.addNaRoleKeys, {
          vehicle_config_id: args.vehicleConfigId,
          role_keys: naFound.map((o) => o.roleKey),
        });
        for (const o of naFound) naKeys.add(o.roleKey);
      }
    }

    // Post-repair truth → run-row reconcile (even when nothing was missing:
    // this clears stale role errors and stamps a fresh quotability snapshot).
    const fieldBySubcategory: Record<string, string> = {};
    for (const [fieldKey, m] of Object.entries(PART_FIELD_MAP)) {
      fieldBySubcategory[(m as any).subcategory] = fieldKey;
    }
    const fitmentsAfter = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const missingAfter = missingCoreRoles(fitmentsAfter, applicableSlugs, naKeys);
    const axleGapsAfter = axlePairGaps(fitmentsAfter, applicableSlugs, naKeys);
    const missingBySlug = new Map<string, string[]>();
    for (const m of missingAfter) {
      missingBySlug.set(m.serviceSlug, [...(missingBySlug.get(m.serviceSlug) ?? []), m.roleKey]);
    }
    const fresh = computeQuotability(fitmentsAfter, applicableSlugs, naKeys);
    const quotability = {
      pct: fresh.pct,
      services: fresh.services.map((s) => ({
        ...s,
        ...(missingBySlug.has(s.slug) ? { missing_roles: missingBySlug.get(s.slug) } : {}),
      })),
    };

    const roleGaps = outcomes
      // Rival misses are NOT field gaps — the role is occupied (by the flagged
      // incumbent); recording them as gaps would double-count with the flag.
      // They still hit the errors ledger + the shared lifetime-attempt cap
      // below is fed by fill failures only.
      .filter((o) => o.outcome !== "written" && o.kind !== "rival")
      .map((o) => ({
        field: fieldBySubcategory[o.roleKey] ?? o.roleKey,
        reason: gapReasonFor(o.outcome),
      }));
    const roleErrors = [
      ...outcomes.map(
        (o) =>
          `role_resource:${o.roleKey}:${o.kind === "rival" ? (o.outcome === "written" ? "rivaled" : `rival_${o.outcome}`) : o.outcome}`,
      ),
      ...axleGapsAfter.map((g) => `axle_pair_gap:${g.serviceSlug}:${g.missingRole}`),
    ];

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchRunRoleHealth, {
      vehicle_config_id: args.vehicleConfigId,
      quotability,
      role_gaps: roleGaps,
      role_errors: roleErrors,
      missing_core_roles: missingAfter.map((m) => `${m.serviceSlug}:${m.roleKey}`),
      axle_pair_gaps: axleGapsAfter.map((g) => `${g.serviceSlug}:${g.missingRole}`),
    });

    const summary = {
      status: "done" as const,
      missingBefore: missingBefore.map((m) => `${m.serviceSlug}:${m.roleKey}`),
      rivalTargets: rivalTargets.map((t) => `${t.serviceSlug}:${t.roleKey} (vs ${t.flaggedOems.join(",")})`),
      outcomes: outcomes.map(
        (o) => `${o.kind === "rival" ? "rival:" : ""}${o.roleKey}:${o.outcome}${o.oem ? `:${o.oem}` : ""}`,
      ),
      missingAfter: missingAfter.map((m) => `${m.serviceSlug}:${m.roleKey}`),
      axleGaps: axleGapsAfter.map((g) => `${g.serviceSlug}:${g.missingRole}`),
      quotabilityPct: fresh.pct,
    };
    console.log(`[role-repair] ${resolved.year} ${resolved.make} ${resolved.model}:`, JSON.stringify(summary));
    return summary;
  },
});

/** Sequential batch wrapper (cap 10 per invocation) — sequential on purpose:
 *  each repair spends Firecrawl/Anthropic budget; parallel fan-out would spike
 *  both. Larger sweeps run this repeatedly with fresh id lists. */
export const repairMissingRolesBatch = internalAction({
  args: {
    vehicleConfigIds: v.array(v.id("vehicle_configs")),
    maxRoles: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ids = args.vehicleConfigIds.slice(0, 10);
    const results: Array<{ id: string; result: any }> = [];
    for (const id of ids) {
      try {
        const result = await ctx.runAction(
          internal.vehicleEnrichment.resourceRoles.repairMissingRoles,
          { vehicleConfigId: id, maxRoles: args.maxRoles },
        );
        results.push({ id: String(id), result });
      } catch (e: any) {
        results.push({ id: String(id), result: { status: "error", message: String(e?.message ?? e) } });
      }
    }
    return { attempted: ids.length, skipped: args.vehicleConfigIds.length - ids.length, results };
  },
});
