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
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { axlePairGaps, computeQuotability, missingCoreRoles } from "./quotability";
import { resourceMissingRoles, soleFlaggedWinnerRoles } from "./utils/roleResource";
import { extractReplacementCandidates, normalizeCandidate } from "./utils/refuteHarvest";
import { verifyPartFitments } from "./utils/partFitmentVerifier";
import { PART_FIELD_MAP, calculateV3FillRate } from "./v3pipeline";

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

    // Live fill for the reconcile's heal-only gate re-run — the parts this
    // repair just wrote made the stored (finalize-time) fill_rate stale.
    let liveFillRate: number | undefined;
    try {
      liveFillRate = (
        await calculateV3FillRate(
          ctx, args.vehicleConfigId, configRow?.engine_id, configRow?.transmission_id,
        )
      ).rate;
    } catch (e) {
      console.warn("[role-resource] live fill recompute failed (non-fatal):", e);
    }

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchRunRoleHealth, {
      vehicle_config_id: args.vehicleConfigId,
      quotability,
      role_gaps: roleGaps,
      role_errors: roleErrors,
      missing_core_roles: missingAfter.map((m) => `${m.serviceSlug}:${m.roleKey}`),
      axle_pair_gaps: axleGapsAfter.map((g) => `${g.serviceSlug}:${g.missingRole}`),
      live_fill_rate: liveFillRate,
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

/** Refute-harvest rung (Aug 2026): recover the replacement part the VERIFIER
 *  itself named while refuting the wrong one. Refutation reasons routinely
 *  carry the correct number ("catalog lists 001-982-80-08 or 001-982-81-08
 *  for the 2020 GLC43, not 001-982-82-08-26") and that evidence used to be
 *  discarded — the repair rung re-searched from scratch and often refilled
 *  nothing. Harvested numbers are CANDIDATES only: each one passes the make
 *  format gate (inside extractReplacementCandidates), then the SAME
 *  verifyPartFitments that produced the refutation, and only a positively
 *  CONFIRMED candidate reaches upsertPartAndFitment — which applies every
 *  write gate again (role identity, refute blocklist, cross-make, existence).
 *  One write per role; first confirmed candidate wins.
 *  Disable: PARTS_REFUTE_HARVEST=off. */
export const harvestRefutedReplacements = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    if (process.env.PARTS_REFUTE_HARVEST === "off") {
      return { status: "disabled" as const };
    }
    const resolved: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!resolved || !resolved.makeId) return { status: "no_config" as const };

    // Applicable services + N/A roles — same recovery ladder as
    // repairMissingRoles, so the two rungs agree on what "missing" means.
    const latestRun: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    let applicableSlugs: string[] = ((latestRun?.quotability?.services ?? []) as any[]).map(
      (s: any) => s.slug,
    );
    if (applicableSlugs.length === 0) {
      applicableSlugs = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getPriorApplicableSlugs,
        { vehicleConfigId: args.vehicleConfigId },
      );
    }
    if (applicableSlugs.length === 0) return { status: "no_run_quotability" as const };

    const configRow: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigById,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const naKeys = new Set<string>([
      ...(((latestRun?.field_gaps ?? []) as Array<{ field: string; reason: string }>)
        .filter((g) => g.reason === "not_applicable" && (PART_FIELD_MAP as any)[g.field])
        .map((g) => (PART_FIELD_MAP as any)[g.field].subcategory) as string[]),
      ...(((configRow?.na_role_keys ?? []) as string[]) ?? []),
    ]);

    const fitments = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const missing = missingCoreRoles(fitments, applicableSlugs, naKeys);
    if (missing.length === 0) return { status: "nothing_missing" as const };
    const missingBySlug = new Map<string, string[]>();
    for (const m of missing) {
      missingBySlug.set(m.serviceSlug, [...(missingBySlug.get(m.serviceSlug) ?? []), m.roleKey]);
    }

    // The durable refutation ledger — oem + reason + service_type — plus the
    // blocklist the harvested candidates must never re-propose.
    const blockedRows: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getBlockedOemsForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const blocked = new Set<string>(
      blockedRows.map((b) => String(b.oem_part_number_normalized ?? "").toUpperCase()),
    );

    const metaBySubcategory: Record<string, any> = Object.fromEntries(
      Object.values(PART_FIELD_MAP).map((m: any) => [m.subcategory, m]),
    );

    // One verify batch across every (role, candidate) pair.
    const toVerify: Array<{ roleKey: string; oem: string; name: string; quantity: number | null; observedTitle: string | null }> = [];
    for (const row of blockedRows) {
      const rolesForService = (missingBySlug.get(String(row.service_type ?? "")) ?? []).filter(
        (rk) => metaBySubcategory[rk],
      );
      // Ambiguous (two empty roles behind one service) or already filled → skip.
      if (rolesForService.length !== 1) continue;
      const roleKey = rolesForService[0];
      const candidates = extractReplacementCandidates({
        reason: row.reason,
        refutedOem: row.oem_part_number_normalized,
        make: resolved.make,
        exclude: blocked,
      });
      for (const c of candidates) {
        if (toVerify.some((t) => normalizeCandidate(t.oem) === c.normalized)) continue;
        toVerify.push({
          roleKey,
          oem: c.oem,
          name: metaBySubcategory[roleKey].name,
          quantity: null,
          observedTitle: null,
        });
      }
    }
    if (toVerify.length === 0) {
      return { status: "no_candidates" as const, missing: missing.map((m) => m.roleKey) };
    }

    console.log(
      `[refute-harvest] verifying ${toVerify.length} candidate(s) from refutation evidence: ` +
        toVerify.map((t) => `${t.roleKey}:${t.oem}`).join(", "),
    );
    const verdicts = await verifyPartFitments(
      {
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim ?? "",
        engineCode: resolved.engineCode ?? undefined,
        displacement: resolved.displacement ?? undefined,
      },
      toVerify,
    );

    const written: string[] = [];
    const outcomes: string[] = [];
    const filledRoles = new Set<string>();
    for (const t of toVerify) {
      const vd = verdicts.find(
        (x) => x.roleKey === t.roleKey && normalizeCandidate(x.oem) === normalizeCandidate(t.oem),
      );
      const verdict = vd?.verdict ?? "uncertain";
      outcomes.push(`${t.roleKey}:${t.oem}:${verdict}`);
      // A harvested number's provenance is a refutation SENTENCE — positive
      // confirmation is the bar, uncertain does not write.
      if (verdict !== "confirmed" || filledRoles.has(t.roleKey)) continue;
      const meta = metaBySubcategory[t.roleKey];
      const res: any = await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
        {
          oem_part_number: t.oem,
          name: meta.name,
          category: meta.category,
          subcategory: meta.subcategory,
          make_id: resolved.makeId,
          vehicle_config_id: args.vehicleConfigId,
          service_type: meta.serviceSlug ?? meta.subcategory,
          quantity_needed: t.roleKey === "front_rotor" || t.roleKey === "rear_rotor" ? 2 : 1,
          position: meta.position,
          service_role: meta.serviceRole,
          confidence: 0.7,
        },
      );
      if (res?.part_id && !res?.rejected) {
        filledRoles.add(t.roleKey);
        written.push(`${t.roleKey}:${t.oem}`);
      } else {
        outcomes.push(`${t.roleKey}:${t.oem}:write_rejected_${res?.rejected ?? "unknown"}`);
      }
    }
    const summary = { status: "done" as const, candidates: toVerify.length, outcomes, written };
    console.log(`[refute-harvest]`, JSON.stringify(summary));
    return summary;
  },
});

/** Post-finalize instant heal (Aug 2026) — bookability cannot wait for the
 *  nightly cron. Scheduled by v3pipeline finalize AFTER the terminal config
 *  write, in its own action budget, and attacks the run's residual gaps
 *  immediately:
 *    1. repairMissingRoles — fills core roles still empty at the END of the
 *       run, including holes the late gates themselves created (a pass-2
 *       refutation empties a role after the in-run repair already finished).
 *    2. The TARGETED zero-price backfill for this config — scheduled, not
 *       awaited, so the two legs never share one 600s action budget. Its
 *       census runs inside refreshStalePrices, so it SEES the parts step 1
 *       just wrote (the mid-finalize census at v3pipeline ~4780 runs before
 *       role-repair writes — GLC-43 run 4 finished with a role-repair
 *       battery and spark plug that no heal ever priced).
 *  Both steps self-noop when there is nothing to do, so scheduling this on
 *  every run is cheap. Kill switch: PARTS_IMMEDIATE_HEAL=off (read at the
 *  scheduling site in v3pipeline).
 */
export const healAfterRun = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    // Harvest FIRST: the refutation ledger already names replacement
    // candidates, so this is the cheapest possible fill (one verify call, no
    // search). The repair pass then only re-searches roles harvest could not
    // close — and its end-of-pass reconcile stamps quotability AFTER both.
    let harvest: any = null;
    try {
      harvest = await ctx.runAction(
        internal.vehicleEnrichment.resourceRoles.harvestRefutedReplacements,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.error("[heal-after-run] refute harvest failed (non-fatal):", e);
    }
    // Curated genuine-fluid seeds next — make-level truth (one MB 325.0 jug
    // row serves every Mercedes), spec-anchored to THIS vehicle and verified
    // before writing. Cheapest rung after harvest: one DB read + one verify.
    let fluids: any = null;
    try {
      fluids = await ctx.runAction(
        internal.vehicleEnrichment.genuineFluids.seedFluidsRung,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.error("[heal-after-run] genuine-fluid seed failed (non-fatal):", e);
    }
    // Deterministic catalog structure next: the store's own vehicle-scoped
    // category pages (fitment stated by the URL itself), then RockAuto
    // OEM/Interchange backtracking off the refuted numbers — both cheaper
    // and stronger-provenance than the open-web research repair below,
    // which now only runs for whatever they could not close.
    let categories: any = null;
    try {
      categories = await ctx.runAction(
        internal.vehicleEnrichment.categoryHarvest.harvestVehicleCategories,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.error("[heal-after-run] category harvest failed (non-fatal):", e);
    }
    let interchange: any = null;
    try {
      interchange = await ctx.runAction(
        internal.vehicleEnrichment.categoryHarvest.backtrackInterchange,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.error("[heal-after-run] interchange backtrack failed (non-fatal):", e);
    }
    // Engine oil is NEVER in missingCoreRoles — its universal fallback keeps
    // the service quotable at a synthetic $/qt — so no rung above touches it.
    // This one replaces the synthetic with the car's real spec-viscosity
    // product + per-quart price; self-noops once a trusted price exists.
    let oil: any = null;
    try {
      oil = await ctx.runAction(
        internal.vehicleEnrichment.oilProduct.fetchEngineOilProduct,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.error("[heal-after-run] oil product fetch failed (non-fatal):", e);
    }
    let repair: any = null;
    try {
      repair = await ctx.runAction(
        internal.vehicleEnrichment.resourceRoles.repairMissingRoles,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.error("[heal-after-run] role repair failed (non-fatal):", e);
    }
    try {
      await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.priceRefresh.refreshStalePrices, {
        budget: 0, // fleet-wide stale leg stays off — this is a targeted heal
        backfillBudget: Number(process.env.PARTS_PRICE_IMMEDIATE_BACKFILL_CAP ?? "12"),
        vehicleConfigId: args.vehicleConfigId,
        maxChainDepth: Number(process.env.PARTS_PRICE_BACKFILL_CHAIN_DEPTH ?? "2"),
      });
    } catch (e) {
      console.error("[heal-after-run] price backfill scheduling failed:", e);
    }
    // Completion-gate re-evaluation on the state the synchronous rungs just
    // built (live fill + live quotability — the finalize gate judged a
    // snapshot these rungs have since outgrown). Promote-only; the scheduled
    // price backfill's epilogue re-runs the same evaluation again after its
    // prices land, so this only misses when that leg is env-disabled — which
    // is exactly why it also runs here.
    let gate: any = null;
    try {
      gate = await ctx.runAction(
        internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
        { vehicleConfigId: args.vehicleConfigId },
      );
    } catch (e) {
      console.error("[heal-after-run] completion-gate re-evaluation failed (non-fatal):", e);
    }
    const summary = {
      harvest: harvest?.status ?? "error",
      harvestWritten: harvest?.written ?? [],
      fluids: fluids?.status ?? "error",
      fluidsWritten: fluids?.written ?? [],
      categories: categories?.status ?? "error",
      categoriesWritten: categories?.written ?? [],
      interchange: interchange?.status ?? "error",
      interchangeWritten: interchange?.written ?? [],
      oil: oil?.status ?? "error",
      oilWritten: oil?.written ?? null,
      roleRepair: repair?.status ?? "error",
      outcomes: repair?.outcomes ?? [],
      missingAfter: repair?.missingAfter ?? [],
      quotabilityPct: repair?.quotabilityPct,
      gateReevaluate: gate?.status ?? "error",
      gateDecision: gate?.decision ?? null,
      gatePromoted: gate?.promoted ?? false,
    };
    console.log("[heal-after-run]", JSON.stringify(summary));
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

// ─── Wave 2: fleet sweep — the scheduled driver the gates were waiting on ───

/** One page of the fleet scan: configs whose LATEST run's quotability
 *  snapshot shows a binding core role without a fitment. Read-only. */
export const fleetRoleGapPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), pageSize: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor, numItems: args.pageSize });
    const gapConfigs: Array<{ id: string; missing: number; status: string }> = [];
    for (const config of page.page) {
      const status = (config as any).enrichment_status ?? "";
      if (status !== "complete" && status !== "partial" && status !== "verified") continue;
      const run = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
        .order("desc")
        .first();
      const services: any[] = (run as any)?.quotability?.services ?? [];
      const missing = services.reduce(
        (n, s) => n + Math.max(0, (s.core_total ?? 0) - (s.core_with_fitment ?? 0)),
        0,
      );
      if (missing > 0) gapConfigs.push({ id: String(config._id), missing, status });
    }
    return { continueCursor: page.isDone ? null : page.continueCursor, gapConfigs };
  },
});

/** Nightly fleet role-repair driver (Wave 2, Aug 2026). Per-run heals only
 *  fire on FRESH runs — already-enriched configs never healed, which is why
 *  the core-role/axle gates must stay log-only ("enforce" would un-book
 *  working configs). This sweep is the missing driver: scan the fleet's
 *  latest-run quotability snapshots, log the residual (THE metric that
 *  decides when the gates flip), and schedule the existing sequential batch
 *  repair over the worst configs under a nightly budget.
 *
 *  Dark by default — spends Firecrawl/Anthropic only when
 *  PARTS_ROLE_REPAIR_FLEET_BUDGET (configs/night, max 10) is set > 0,
 *  mirroring the price-refresh cron's budget pattern. The repair itself is
 *  the proven repairMissingRolesBatch; parts it writes get priced by the
 *  09:00 UTC price-refresh cron the same night (this runs at 08:15). */
export const repairFleetSweep = internalAction({
  args: { budget: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const budget = Math.min(
      args.budget ?? Number(process.env.PARTS_ROLE_REPAIR_FLEET_BUDGET ?? "0"),
      10,
    );
    let cursor: string | null = null;
    const gaps: Array<{ id: string; missing: number; status: string }> = [];
    let pages = 0;
    do {
      const r: any = await ctx.runQuery(
        internal.vehicleEnrichment.resourceRoles.fleetRoleGapPage,
        { cursor, pageSize: 100 },
      );
      cursor = r.continueCursor;
      gaps.push(...r.gapConfigs);
      pages++;
    } while (cursor != null && pages < 100);

    // Worst-first: most missing binding roles. `complete` configs outrank
    // `partial` at equal severity — they are LIVE-bookable with holes.
    gaps.sort((a, b) => b.missing - a.missing || (a.status === "complete" ? -1 : 1));
    const targets = budget > 0 ? gaps.slice(0, budget) : [];
    if (targets.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.vehicleEnrichment.resourceRoles.repairMissingRolesBatch,
        { vehicleConfigIds: targets.map((t) => t.id) as any },
      );
    }
    const summary = {
      status: budget > 0 ? "scheduled" : "census_only",
      fleetResidualConfigs: gaps.length,
      fleetResidualRoles: gaps.reduce((n, g) => n + g.missing, 0),
      scheduled: targets.length,
      budget,
    };
    console.log("[fleet-role-repair]", JSON.stringify(summary));
    return summary;
  },
});
