// ============================================================================
// convex/directorRoadTo10.ts — the Road-to-1.0 census, as a director surface.
//
// Until Sep 2026 the fleet quotability census (bands, blocker cohorts, role
// gaps) lived in devOnly tooling and operator sessions; the nightly legs that
// drain the cohorts report only to console. This query puts the whole program
// on the Enrichment Console: one call returns the live band histogram, every
// cohort with its member configs (deep-dive-linkable), the fleet-wide role-gap
// ranking, and the standing-legs panel (which legs are lit, their budgets,
// and how much of the fleet their rotation stamps touched recently).
//
// Read shape: one bounded pass over vehicle_configs (fleet is a few hundred;
// take cap 2000) + up to 8 latest runs per config via by_vehicle_config +
// memoized make/model gets — ~3-4k document reads, well inside query limits.
// Recompute happens per open of the tab; there is no materialization to go
// stale (the census IS the source of truth the operator reads).
// ============================================================================

import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

/** Synthetic engine-suffix keys — the corrupt-identity cohort (matches
 *  devOnly/roadTo10; `_2l_2cyl` is the cylinders-column corruption era). */
const SYNTHETIC_KEY_RE = /_(unknownl_unknowncyl|unknownl_[0-9]+cyl|[0-9_]+l_(unknown|[0-9]+)cyl)$/;

const FIXTURE_STATUSES = new Set(["validation_fixture", "spec_v2_anchor"]);
const NEVER_RUN_STATUSES = new Set(["pending", "enriching"]);
const CONSUMABLE_ROLES = new Set(["atf_fluid", "battery", "coolant"]);

type CohortKey =
  | "price_only"
  | "consumables_only"
  | "synthetic_key"
  | "deep_tail"
  | "never_run"
  | "thin_fill";

type CensusRow = {
  configId: string;
  configKey: string | null;
  vehicle: string;
  status: string | null;
  q: number | null;
  fill: number | null;
  /** Human-readable blocker summary, e.g. "atf_fluid, battery · 2 unpriced". */
  blockers: string;
};

const ROW_CAP_PER_COHORT = 150;

export const census = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    return await computeRoadTo10Census(ctx);
  },
});

/**
 * Decision stream for one run's Deep-Dive: everything the pipeline chose and
 * why — in-run events (identity chain, batch-2 health, verify verdicts, the
 * finalize gate) plus the config's POST-run events (heal rungs, gate
 * re-evaluations from the nightly legs), which carry no run id or a later
 * one but are exactly the "what happened to this config after the run" story.
 */
export const runDecisions = query({
  args: {
    token: v.string(),
    runId: v.id("enrichment_runs"),
  },
  handler: async (ctx, { token, runId }) => {
    await requireDirector(ctx, token);
    const run: any = await ctx.db.get(runId);
    if (!run) return { inRun: [], postRun: [] };

    const shape = (d: any) => ({
      id: String(d._id),
      at: d.created_at,
      stage: d.stage,
      key: d.decision_key,
      chosen: d.chosen,
      alternatives: d.alternatives ?? [],
      reason: d.reason,
      evidence: d.evidence ?? [],
      outcome: d.outcome ?? null,
      cost: d.cost ?? null,
      flags: d.flags ?? null,
    });

    const inRun = (
      await ctx.db
        .query("enrichment_decisions")
        .withIndex("by_run", (q) => q.eq("enrichment_run_id", runId))
        .take(200)
    ).map(shape);
    inRun.sort((a, b) => a.at - b.at);

    let postRun: any[] = [];
    if (run.vehicle_config_id) {
      const runStart = run.created_at ?? run._creationTime;
      postRun = (
        await ctx.db
          .query("enrichment_decisions")
          .withIndex("by_config", (q) =>
            q.eq("vehicle_config_id", run.vehicle_config_id).gt("created_at", runStart),
          )
          .take(200)
      )
        .filter((d: any) => String(d.enrichment_run_id ?? "") !== String(runId))
        .map(shape);
      postRun.sort((a, b) => a.at - b.at);
    }
    return { inRun, postRun };
  },
});

/** The census body, auth-free — shared by the director query above and the
 *  devOnly read-limit probe so the two can never drift. */
export async function computeRoadTo10Census(ctx: { db: any }) {
  {
    const now = Date.now();
    const FRESH_MS = 36 * 60 * 60 * 1000;

    const configs = await ctx.db.query("vehicle_configs").take(2000);

    // Memoized name lookups — the fleet shares a few dozen makes/models.
    const nameCache = new Map<string, string>();
    const nameOf = async (id: any): Promise<string> => {
      if (!id) return "?";
      const key = String(id);
      const hit = nameCache.get(key);
      if (hit !== undefined) return hit;
      const doc: any = await ctx.db.get(id);
      const name = String(doc?.name ?? "?");
      nameCache.set(key, name);
      return name;
    };

    const bands = { at10: 0, b90: 0, b80: 0, b70: 0, below70: 0, noSnapshot: 0 };
    const cohorts: Record<CohortKey, CensusRow[]> = {
      price_only: [],
      consumables_only: [],
      synthetic_key: [],
      deep_tail: [],
      never_run: [],
      thin_fill: [],
    };
    const cohortTotals: Record<CohortKey, number> = {
      price_only: 0,
      consumables_only: 0,
      synthetic_key: 0,
      deep_tail: 0,
      never_run: 0,
      thin_fill: 0,
    };
    const roleGapCounts = new Map<string, number>();
    const unpricedByService = new Map<string, number>();
    const statusCounts = new Map<string, number>();
    let fixtures = 0;
    let measured = 0;

    // Standing-leg rotation stamps, tallied on the same pass.
    const stamps = {
      swept: { total: 0, fresh: 0 },
      dispatched: { total: 0, fresh: 0 },
      audited: { total: 0, fresh: 0 },
    };

    const push = (key: CohortKey, row: CensusRow) => {
      cohortTotals[key]++;
      if (cohorts[key].length < ROW_CAP_PER_COHORT) cohorts[key].push(row);
    };

    for (const c of configs as any[]) {
      const status: string | null = c.enrichment_status ?? null;
      statusCounts.set(status ?? "none", (statusCounts.get(status ?? "none") ?? 0) + 1);

      if (c.price_sweep_at != null) {
        stamps.swept.total++;
        if (now - c.price_sweep_at < FRESH_MS) stamps.swept.fresh++;
      }
      if (c.cohort_dispatched_at != null) {
        stamps.dispatched.total++;
        if (now - c.cohort_dispatched_at < FRESH_MS) stamps.dispatched.fresh++;
      }
      if (c.fitment_audited_at != null) {
        stamps.audited.total++;
        if (now - c.fitment_audited_at < FRESH_MS) stamps.audited.fresh++;
      }

      if (status && FIXTURE_STATUSES.has(status)) {
        fixtures++;
        continue;
      }

      const runs = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", c._id))
        .order("desc")
        .take(8);
      const withQ: any = runs.find((r: any) => r.quotability?.pct != null);
      const q: number | null = withQ?.quotability?.pct ?? null;
      const fill: number | null =
        withQ?.applicable_fill_rate ?? withQ?.fill_rate ?? c.fill_rate ?? null;

      if (q == null) bands.noSnapshot++;
      else {
        measured++;
        if (q >= 1) bands.at10++;
        else if (q >= 0.9) bands.b90++;
        else if (q >= 0.8) bands.b80++;
        else if (q >= 0.7) bands.b70++;
        else bands.below70++;
      }

      // Blockers from the stored quotability snapshot — the same arithmetic
      // the completion gate and the nightly legs read.
      const services: any[] = withQ?.quotability?.services ?? [];
      const missingRoles = new Set<string>();
      let unpricedServices = 0;
      for (const s of services) {
        for (const r of s.missing_roles ?? []) missingRoles.add(String(r));
        const unpriced = Math.max(0, (s.core_with_fitment ?? 0) - (s.core_with_price ?? 0));
        if (unpriced > 0) {
          unpricedServices++;
          unpricedByService.set(s.slug, (unpricedByService.get(s.slug) ?? 0) + 1);
        }
      }
      for (const r of missingRoles) roleGapCounts.set(r, (roleGapCounts.get(r) ?? 0) + 1);

      const [makeName, modelName] = await Promise.all([nameOf(c.make_id), nameOf(c.model_id)]);
      const row: CensusRow = {
        configId: String(c._id),
        configKey: c.config_key ?? null,
        vehicle: `${c.year ?? "?"} ${makeName} ${modelName} ${c.trim_name ?? ""}`.trim(),
        status,
        q,
        fill,
        blockers:
          (missingRoles.size > 0 ? [...missingRoles].sort().join(", ") : "") +
          (missingRoles.size > 0 && unpricedServices > 0 ? " · " : "") +
          (unpricedServices > 0 ? `${unpricedServices} unpriced service${unpricedServices === 1 ? "" : "s"}` : ""),
      };

      if (status && NEVER_RUN_STATUSES.has(status)) push("never_run", row);
      if (c.config_key && SYNTHETIC_KEY_RE.test(String(c.config_key))) push("synthetic_key", row);
      if (q != null && q < 1) {
        if (missingRoles.size === 0 && unpricedServices > 0) push("price_only", row);
        if (
          missingRoles.size > 0 &&
          [...missingRoles].every((r) => CONSUMABLE_ROLES.has(r))
        )
          push("consumables_only", row);
        if (missingRoles.size >= 4) push("deep_tail", row);
      }
      if (status === "partial" && q != null && q >= 0.9 && (fill ?? 100) < 70)
        push("thin_fill", row);
    }

    const env = process.env;
    const budgetOf = (name: string): number => {
      const n = Number(env[name] ?? "0");
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const legs = [
      {
        id: "cohort_dispatch",
        label: "Cohort dispatcher",
        cron: "08:00 UTC",
        envVar: "PARTS_COHORT_DISPATCH_BUDGET",
        budget: budgetOf("PARTS_COHORT_DISPATCH_BUDGET"),
        unit: "configs/night",
        stamped: stamps.dispatched,
        what: "Routes stored missing_roles to the proven rungs (fluids → battery → rest)",
      },
      {
        id: "role_repair",
        label: "Fleet role repair",
        cron: "08:15 UTC",
        envVar: "PARTS_ROLE_REPAIR_FLEET_BUDGET",
        budget: budgetOf("PARTS_ROLE_REPAIR_FLEET_BUDGET"),
        unit: "configs/night",
        stamped: null,
        what: "Worst-first repair of missing binding core roles (skips same-night dispatched)",
      },
      {
        id: "price_refresh",
        label: "Stale-price refresh",
        cron: "09:00 UTC",
        envVar: "PARTS_PRICE_REFRESH_BUDGET",
        budget: budgetOf("PARTS_PRICE_REFRESH_BUDGET"),
        unit: "parts/night",
        stamped: null,
        what: "Re-verifies parts whose newest price row went stale",
      },
      {
        id: "price_sweep",
        label: "Zero-price sweep",
        cron: "10:00 UTC",
        envVar: "PARTS_PRICE_SWEEP_BUDGET",
        budget: budgetOf("PARTS_PRICE_SWEEP_BUDGET"),
        unit: "parts/night",
        stamped: stamps.swept,
        what: "Discovers prices for never-priced fitments (the price-only cohort's drain)",
      },
      {
        id: "fitment_audit",
        label: "Fitment audit",
        cron: "07:30 UTC",
        envVar: "PARTS_FITMENT_AUDIT_BUDGET",
        budget: budgetOf("PARTS_FITMENT_AUDIT_BUDGET"),
        unit: "configs/night",
        stamped: stamps.audited,
        what: "Re-adjudicates stored fitments (Sonnet verify, double-refute to delete)",
      },
    ];

    return {
      generatedAt: now,
      fleet: {
        total: configs.length,
        fixtures,
        operational: configs.length - fixtures,
        measured,
        statusCounts: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
      },
      bands,
      cohorts: (Object.keys(cohorts) as CohortKey[]).map((key) => ({
        key,
        count: cohortTotals[key],
        rows: cohorts[key],
      })),
      roleGaps: [...roleGapCounts.entries()]
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => b.count - a.count),
      unpricedByService: [...unpricedByService.entries()]
        .map(([slug, count]) => ({ slug, count }))
        .sort((a, b) => b.count - a.count),
      legs,
    };
  }
}
