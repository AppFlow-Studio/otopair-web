/**
 * vehicleEnrichment/cohortDispatch.ts — nightly dispatcher pointing the
 * fleet's KNOWN gap lists at the proven repair lanes.
 *
 * WHY. The repair lanes that demonstrably close gaps — the curated fluid rung
 * (genuineFluids.seedFluidsRung) and role repair (resourceRoles) — only ever
 * fire inside a per-config heal, i.e. seconds after a fresh run. A config
 * enriched BEFORE a lane existed never meets it: the fluid catalog shipped
 * and the ATF cohort barely moved (89→81 in a week) because nothing drives
 * seedFluidsRung fleet-wide. repairFleetSweep does walk the fleet, but
 * worst-first by raw deficit count, so a config with ONE cheap fluid gap can
 * wait behind multi-role wrecks indefinitely. This dispatcher walks the
 * fleet's stored missing_roles stalest-first and routes each gap to the
 * cheapest lane that can close it.
 *
 * LANES (priority order when the budget is tight — cheapest fix first):
 *   fluids  (atf_fluid, coolant)  → seedFluidsRung, AWAITED — one DB read +
 *           one verify call, the healAfterRun invocation style.
 *   battery, then brakes/plugs/filters/everything else → the SAME per-config
 *           entry repairFleetSweep drives (repairMissingRoles, via the
 *           sequential repairMissingRolesBatch wrapper). repairMissingRoles
 *           takes no role targeting — it re-derives missing roles live — so
 *           dispatch is per-config; that also means it re-attempts any fluid
 *           gap the awaited rung could not close, which is fine: every rung
 *           is verifier-gated and self-noops on filled roles.
 *   A config with no missing roles is skipped — fitment-present/price-missing
 *   is priceBackfillSweep's job, not this one's.
 *
 * One config counts ONCE against PARTS_COHORT_DISPATCH_BUDGET (configs per
 * night) regardless of lanes fired. Dark (no-op with a log) when the env is
 * unset/0 — the budget env is the kill switch. Every EXAMINED config is
 * stamped (vehicle_configs.cohort_dispatched_at) so gapless configs rotate to
 * the back instead of eating the examine window nightly.
 *
 * After a config's lanes run, the completion gate is re-asked
 * (completionReevaluate.reevaluateGate): inline for awaited-only lanes,
 * delay-scheduled past the batch's estimated position for scheduled ones.
 * Without that, a healed config reads its stale finalize-time quotability
 * forever (the Aug-8 "partial is terminal" defect). The gate is promote-only
 * and every path here is idempotent, so a mistimed call only under-reports —
 * role repair's own patchRunRoleHealth and the price sweep's epilogue re-ask
 * it again later regardless.
 *
 * GOTCHAs:
 *  - Never cache config _ids across nights — configs get merged/deleted
 *    (the Aug 2026 duplicate-config incident); every run re-resolves from a
 *    fresh stamp scan, and ids live only for the one invocation.
 *  - Re-dispatching a config is safe by construction: both lanes re-derive
 *    their targets from LIVE fitments and put every candidate through the
 *    adversarial verifier + all write gates before any row lands.
 *  - The awaited fluid lane spends this action's wall clock (~10 min): each
 *    rung is one verify call (tens of seconds), so keep the budget ≤ ~15;
 *    the role lane is scheduled and costs this action nothing.
 *  - Cron slot 08:00 UTC, BEFORE role repair (08:15) and price refresh
 *    (09:00): fluid parts written here get priced the same night.
 *
 * Manual run: nightly '{"budget":5,"dryRun":true}' (classify + report only).
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

// This module is new — `internal.vehicleEnrichment.cohortDispatch` is absent
// from _generated/api.d.ts until the next codegen, so self-references use the
// same `(internal as any)` escape crons.ts uses for nhtsaOdi et al. Tighten
// after codegen.
const selfApi = () => (internal as any).vehicleEnrichment.cohortDispatch;

/** Roles the curated fluid rung can close from make-family seed rows.
 *  engine_oil is deliberately absent: its universal fallback keeps it out of
 *  missing_roles entirely (see quotability.ts), so it can never appear in a
 *  gap list this dispatcher reads. */
const FLUID_LANE_ROLES = new Set(["atf_fluid", "coolant"]);

/** Settled configs only — a config mid-run belongs to its pipeline chain and
 *  already gets the full heal ladder. Same filter as fleetRoleGapPage. */
const DISPATCHABLE_STATUSES = new Set(["complete", "partial", "verified"]);

/** repairMissingRolesBatch refuses more than 10 ids per invocation. */
const ROLE_BATCH_SIZE = 10;
/** Envelope for one sequential batch of 10 repairs (research + verify each). */
const ROLE_BATCH_WINDOW_MS = 30 * 60_000;
/** Per-position envelope inside a batch, for the delayed gate re-ask. */
const ROLE_REPAIR_EST_MS = 6 * 60_000;

/** One page of (config id, dispatch stamp, status) — minimal rows so the
 *  action can sort the whole fleet stalest-first without any query ever
 *  collecting the table (the read-bounded version of the
 *  fitmentReverify._stalestConfigs full scan). */
export const _configStampPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), pageSize: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor, numItems: Math.max(1, Math.trunc(args.pageSize)) });
    return {
      rows: page.page.map((c: any) => ({
        id: c._id,
        at: (c.cohort_dispatched_at as number | undefined) ?? 0,
        status: (c.enrichment_status as string | undefined) ?? "",
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Examined = stamped, gap or not — gapless configs must rotate to the back
 *  or they'd occupy the examine window every single night. */
export const _stampDispatched = internalMutation({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.vehicleConfigId, { cohort_dispatched_at: Date.now() });
  },
});

/**
 * Gap classification for ONE config off its latest quotability snapshot (the
 * roadTo10 census read: newest 12 runs, first carrying a pct). missing_roles
 * was computed WITH na_role_keys at write time, so a physically-absent role
 * (rear drums) never shows up here. An older snapshot can carry a core
 * deficit WITHOUT role names (missing_roles is optional on the service
 * shape) — that reads as an unnamed deficit and goes to the role lane, which
 * re-derives the actual roles live.
 */
export const _gapClassForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const cfg: any = await ctx.db.get(args.vehicleConfigId);
    if (!cfg) return null;
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .order("desc")
      .take(12);
    const withQ: any = runs.find((r: any) => r.quotability?.pct != null);
    const missingRoles = new Set<string>();
    let unnamedDeficit = false;
    for (const s of (withQ?.quotability?.services ?? []) as any[]) {
      for (const rk of (s.missing_roles ?? []) as string[]) missingRoles.add(rk);
      if (
        (s.missing_roles?.length ?? 0) === 0 &&
        (s.core_with_fitment ?? 0) < (s.core_total ?? 0)
      ) {
        unnamedDeficit = true;
      }
    }
    return {
      configKey: (cfg.config_key as string | undefined) ?? String(args.vehicleConfigId),
      missingRoles: [...missingRoles],
      unnamedDeficit,
    };
  },
});

/** Nightly driver. Dark unless PARTS_COHORT_DISPATCH_BUDGET (configs per
 *  night) is set > 0. Args are manual-run overrides; cron passes {}. */
export const nightly = internalAction({
  args: {
    budget: v.optional(v.number()),
    /** Configs examined per night hunting for budget-worth of gaps (default
     *  max(40, budget*8)) — bounds this action's query count. */
    examineCap: v.optional(v.number()),
    /** Classify + report only: no stamps, no rungs, no schedules. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const budget = args.budget ?? Number(process.env.PARTS_COHORT_DISPATCH_BUDGET ?? "0");
    if (!Number.isFinite(budget) || budget <= 0) {
      console.log(
        "[cohort-dispatch] PARTS_COHORT_DISPATCH_BUDGET unset/0 — nightly dispatcher dark",
      );
      return { skipped: true };
    }
    const dryRun = args.dryRun === true;
    const examineCap = Math.max(1, Math.trunc(args.examineCap ?? Math.max(40, budget * 8)));

    // ── Stalest-first candidate order ────────────────────────────────────
    const candidates: Array<{ id: any; at: number }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const page: any = await ctx.runQuery(selfApi()._configStampPage, {
        cursor,
        pageSize: 100,
      });
      for (const row of page.rows) {
        if (!DISPATCHABLE_STATUSES.has(row.status)) continue;
        candidates.push({ id: row.id, at: row.at });
      }
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    candidates.sort((a, b) => a.at - b.at);

    // ── Examine + classify (stamp everything examined) ───────────────────
    type Classified = {
      id: any;
      configKey: string;
      fluidGaps: string[];
      roleGaps: string[];
      unnamedDeficit: boolean;
    };
    const dispatchable: Classified[] = [];
    let examined = 0;
    let skippedNoGaps = 0;
    for (const cand of candidates.slice(0, examineCap)) {
      examined++;
      let klass: any = null;
      try {
        klass = await ctx.runQuery(selfApi()._gapClassForConfig, {
          vehicleConfigId: cand.id,
        });
      } catch (e) {
        console.error(`[cohort-dispatch] classify failed for ${String(cand.id)}:`, e);
      }
      if (!dryRun) {
        await ctx.runMutation(selfApi()._stampDispatched, { vehicleConfigId: cand.id });
      }
      if (!klass) continue;
      const fluidGaps = (klass.missingRoles as string[]).filter((r) => FLUID_LANE_ROLES.has(r));
      const roleGaps = (klass.missingRoles as string[]).filter((r) => !FLUID_LANE_ROLES.has(r));
      if (fluidGaps.length === 0 && roleGaps.length === 0 && !klass.unnamedDeficit) {
        skippedNoGaps++;
        continue;
      }
      dispatchable.push({
        id: cand.id,
        configKey: klass.configKey,
        fluidGaps,
        roleGaps,
        unnamedDeficit: klass.unnamedDeficit,
      });
    }

    // ── Lane priority under a tight budget: fluids, then battery, then the
    //    rest — cheapest fix first buys the most closed gaps per night.
    //    Stable sort keeps stalest-first inside each tier. ─────────────────
    const tierOf = (c: Classified): number => {
      if (c.fluidGaps.length > 0) return 0;
      if (c.roleGaps.includes("battery")) return 1;
      return 2;
    };
    const targets = dispatchable
      .map((c, idx) => ({ c, idx }))
      .sort((a, b) => tierOf(a.c) - tierOf(b.c) || a.idx - b.idx)
      .map((x) => x.c)
      .slice(0, budget);
    const skippedBudget = dispatchable.length - targets.length;

    // ── Dispatch ─────────────────────────────────────────────────────────
    let dispatched = 0;
    const byLane = { fluids: 0, roles: 0, both: 0 };
    const roleLaneIds: any[] = [];
    const roleLaneKeys: string[] = [];
    const rows: string[] = [];
    for (const t of targets) {
      const hasRoleLane = t.roleGaps.length > 0 || t.unnamedDeficit;
      const laneLabel =
        (t.fluidGaps.length > 0 ? `fluids(${t.fluidGaps.join(",")})` : "") +
        (t.fluidGaps.length > 0 && hasRoleLane ? "+" : "") +
        (hasRoleLane
          ? `roles(${t.roleGaps.join(",") || "unnamed_core_deficit"})`
          : "");
      console.log(`[cohort-dispatch] ${t.configKey}: ${laneLabel}${dryRun ? " [dry-run]" : ""}`);
      rows.push(`${t.configKey}: ${laneLabel}`);
      dispatched++;
      if (t.fluidGaps.length > 0 && hasRoleLane) byLane.both++;
      else if (t.fluidGaps.length > 0) byLane.fluids++;
      else byLane.roles++;
      if (dryRun) continue;

      if (t.fluidGaps.length > 0) {
        // healAfterRun's invocation style: awaited, failure non-fatal.
        try {
          const fluids: any = await ctx.runAction(
            internal.vehicleEnrichment.genuineFluids.seedFluidsRung,
            { vehicleConfigId: t.id },
          );
          console.log(
            `[cohort-dispatch] ${t.configKey}: fluid rung ${fluids?.status ?? "error"}` +
              ((fluids?.written?.length ?? 0) > 0 ? ` wrote ${fluids.written.join(", ")}` : ""),
          );
        } catch (e) {
          console.error(`[cohort-dispatch] fluid rung failed for ${t.configKey} (non-fatal):`, e);
        }
      }

      if (hasRoleLane) {
        roleLaneIds.push(t.id);
        roleLaneKeys.push(t.configKey);
      } else {
        // Fluids-only config: lanes are complete right now — re-ask the gate
        // inline, exactly as healAfterRun does after its awaited rungs.
        try {
          await ctx.runAction(internal.vehicleEnrichment.completionReevaluate.reevaluateGate, {
            vehicleConfigId: t.id,
          });
        } catch (e) {
          console.error(
            `[cohort-dispatch] gate re-evaluation failed for ${t.configKey} (non-fatal):`,
            e,
          );
        }
      }
    }

    // Role lane: ONE sequential batch per 10 configs — sequential on purpose
    // (repairMissingRolesBatch's own rationale: parallel fan-out spikes the
    // Firecrawl/Anthropic spend). Later chunks wait a full batch window. Each
    // config also gets a delayed gate re-ask past its estimated batch
    // position; the estimate being wrong is harmless (promote-only, and the
    // repair's own patchRunRoleHealth reconciles regardless).
    let roleBatchesScheduled = 0;
    if (!dryRun && roleLaneIds.length > 0) {
      for (let k = 0; k * ROLE_BATCH_SIZE < roleLaneIds.length; k++) {
        const chunk = roleLaneIds.slice(k * ROLE_BATCH_SIZE, (k + 1) * ROLE_BATCH_SIZE);
        await ctx.scheduler.runAfter(
          k * ROLE_BATCH_WINDOW_MS,
          internal.vehicleEnrichment.resourceRoles.repairMissingRolesBatch,
          { vehicleConfigIds: chunk as any },
        );
        roleBatchesScheduled++;
        for (let j = 0; j < chunk.length; j++) {
          await ctx.scheduler.runAfter(
            k * ROLE_BATCH_WINDOW_MS + (j + 1) * ROLE_REPAIR_EST_MS,
            internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
            { vehicleConfigId: chunk[j] },
          );
        }
      }
      console.log(
        `[cohort-dispatch] role lane: ${roleLaneIds.length} config(s) in ` +
          `${roleBatchesScheduled} batch(es): ${roleLaneKeys.join(", ")}`,
      );
    }

    const summary = {
      examined,
      dispatched,
      byLane,
      skippedNoGaps,
      skippedBudget,
      roleBatchesScheduled,
      budget,
      dryRun,
      rows,
    };
    console.log(
      `[cohort-dispatch] ${examined} examined, ${dispatched}/${budget} dispatched ` +
        `(fluids ${byLane.fluids}, roles ${byLane.roles}, both ${byLane.both}), ` +
        `${skippedNoGaps} gapless, ${skippedBudget} over budget` +
        (dryRun ? " [dry-run]" : ""),
    );
    return summary;
  },
});
