/**
 * convex/migrations/purgeVendorNames.ts — one-shot vendor-name purge migration.
 *
 * Rewrites every provider-named value written before the rename onto its
 * vendor-neutral equivalent. Safe to run repeatedly: every step is idempotent
 * and skips rows that are already migrated, so a partial or interrupted run is
 * resumed simply by running it again.
 *
 * FULL RUNBOOK (read this before running):
 *   docs/superpowers/runbooks/2026-07-27-vendor-name-purge-migration.md
 *
 * ── ORDER OF OPERATIONS ───────────────────────────────────────────────────
 *   1. status            — read-only census. Run FIRST and record the numbers.
 *   2. migrateEstimates  — copy legacy estimate rows → estimator_estimates.
 *   3. migrateObservations — rewrite labor_observations.source values.
 *   4. migratePartPrices — rewrite part_prices.price_type / source_domain,
 *                          and strip the provider hostname from source_url.
 *   5. migrateServiceSlugs — copy services.repairpal_slug → estimator_slug.
 *   6. status            — confirm every `remaining` count is 0.
 *   7. deleteLegacyEstimates — ONLY after step 6 reads 0 and the app is
 *                          verified healthy. Destructive; deletes copied rows.
 *
 * Steps 2–5 are independent of each other and may run in any order or be
 * re-run individually. Step 7 must be last.
 *
 * Every step is a mutation with a bounded `limit` (default 500) so it never
 * exceeds a Convex transaction budget. Each returns `{ migrated, remaining }`;
 * keep invoking a step until `remaining` is 0.
 */
import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import {
  ESTIMATOR_ENDPOINT_PRICE_TYPE,
  LEGACY_ESTIMATOR_SOURCE_VALUES,
  canonicalizeSourceName,
} from "../lib/sourceNames";
import { ESTIMATOR_SOURCE_URL } from "../lib/estimatorApi";

const DEFAULT_LIMIT = 500;

/** (config, service) identity used to skip rows already copied. */
function estimateKey(row: any): string {
  return `${String(row.vehicle_config_id)}::${String(row.service_id)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 1 + 6. Census — read-only, run before and after.
// ─────────────────────────────────────────────────────────────────────────

export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const legacyEstimates = await ctx.db.query("repairpal_endpoint_estimates").collect();
    const currentEstimates = await ctx.db.query("estimator_estimates").collect();

    const observations = await ctx.db.query("labor_observations").collect();
    const legacyObs = observations.filter((o) =>
      LEGACY_ESTIMATOR_SOURCE_VALUES.includes(o.source),
    );

    const prices = await ctx.db.query("part_prices").collect();
    const legacyPriceType = prices.filter((p) =>
      LEGACY_ESTIMATOR_SOURCE_VALUES.includes(p.price_type ?? ""),
    );
    const legacyPriceDomain = prices.filter((p) =>
      LEGACY_ESTIMATOR_SOURCE_VALUES.includes(p.source_domain ?? ""),
    );
    const legacyPriceUrl = prices.filter((p) => /repairpal\.com/i.test(p.source_url ?? ""));

    const services = await ctx.db.query("services").collect();
    const legacySlugs = services.filter(
      (s: any) => s.repairpal_slug != null && s.estimator_slug == null,
    );

    // Per-source breakdown makes it obvious WHICH legacy value is lingering.
    const bySource: Record<string, number> = {};
    for (const o of legacyObs) bySource[o.source] = (bySource[o.source] ?? 0) + 1;

    return {
      estimates: {
        legacyTable: legacyEstimates.length,
        currentTable: currentEstimates.length,
        remaining: legacyEstimates.filter((r) => {
          const keys = new Set(currentEstimates.map(estimateKey));
          return !keys.has(estimateKey(r));
        }).length,
      },
      observations: { remaining: legacyObs.length, bySource },
      partPrices: {
        remainingPriceType: legacyPriceType.length,
        remainingSourceDomain: legacyPriceDomain.length,
        remainingSourceUrl: legacyPriceUrl.length,
      },
      services: { remaining: legacySlugs.length },
      /** True when every step has fully drained. Gate step 7 on this. */
      clean:
        legacyObs.length === 0 &&
        legacyPriceType.length === 0 &&
        legacyPriceDomain.length === 0 &&
        legacyPriceUrl.length === 0 &&
        legacySlugs.length === 0,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Copy legacy estimate rows into the renamed table.
// ─────────────────────────────────────────────────────────────────────────

export const migrateEstimates = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const legacy = await ctx.db.query("repairpal_endpoint_estimates").collect();
    const current = await ctx.db.query("estimator_estimates").collect();
    const existing = new Set(current.map(estimateKey));

    let migrated = 0;
    for (const row of legacy) {
      if (migrated >= limit) break;
      if (existing.has(estimateKey(row))) continue; // already copied — idempotent
      // Strip Convex system fields; the rest of the shape is identical.
      const { _id, _creationTime, ...fields } = row as any;
      await ctx.db.insert("estimator_estimates", fields);
      existing.add(estimateKey(row));
      migrated++;
    }

    const remaining = legacy.filter((r) => !existing.has(estimateKey(r))).length;
    console.log(`[purge] estimates: copied ${migrated}, ${remaining} remaining`);
    return { migrated, remaining };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Rewrite labor_observations.source.
// ─────────────────────────────────────────────────────────────────────────

export const migrateObservations = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const rows = (await ctx.db.query("labor_observations").collect()).filter((o) =>
      LEGACY_ESTIMATOR_SOURCE_VALUES.includes(o.source),
    );

    let migrated = 0;
    for (const row of rows) {
      if (migrated >= limit) break;
      await ctx.db.patch(row._id, { source: canonicalizeSourceName(row.source) });
      migrated++;
    }

    const remaining = rows.length - migrated;
    console.log(`[purge] observations: rewrote ${migrated}, ${remaining} remaining`);
    return { migrated, remaining };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Rewrite part_prices.price_type / source_domain / source_url.
// ─────────────────────────────────────────────────────────────────────────

export const migratePartPrices = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const rows = (await ctx.db.query("part_prices").collect()).filter(
      (p) =>
        LEGACY_ESTIMATOR_SOURCE_VALUES.includes(p.price_type ?? "") ||
        LEGACY_ESTIMATOR_SOURCE_VALUES.includes(p.source_domain ?? "") ||
        /repairpal\.com/i.test(p.source_url ?? ""),
    );

    let migrated = 0;
    for (const row of rows) {
      if (migrated >= limit) break;
      const patch: Record<string, string> = {};
      if (LEGACY_ESTIMATOR_SOURCE_VALUES.includes(row.price_type ?? "")) {
        patch.price_type = ESTIMATOR_ENDPOINT_PRICE_TYPE;
      }
      if (LEGACY_ESTIMATOR_SOURCE_VALUES.includes(row.source_domain ?? "")) {
        patch.source_domain = canonicalizeSourceName(row.source_domain!);
      }
      // The provider hostname must not survive in the DB. The raw response is
      // already cached in estimator_estimates, so nothing is lost by replacing
      // the URL with the internal marker.
      if (/repairpal\.com/i.test(row.source_url ?? "")) {
        patch.source_url = ESTIMATOR_SOURCE_URL;
      }
      await ctx.db.patch(row._id, patch);
      migrated++;
    }

    const remaining = rows.length - migrated;
    console.log(`[purge] part_prices: rewrote ${migrated}, ${remaining} remaining`);
    return { migrated, remaining };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Copy services.repairpal_slug → services.estimator_slug.
// ─────────────────────────────────────────────────────────────────────────

export const migrateServiceSlugs = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const rows = (await ctx.db.query("services").collect()).filter(
      (s: any) => s.repairpal_slug != null && s.estimator_slug == null,
    );

    let migrated = 0;
    for (const row of rows as any[]) {
      if (migrated >= limit) break;
      await ctx.db.patch(row._id, { estimator_slug: row.repairpal_slug });
      migrated++;
    }

    const remaining = rows.length - migrated;
    console.log(`[purge] service slugs: copied ${migrated}, ${remaining} remaining`);
    return { migrated, remaining };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 7. DESTRUCTIVE cleanup — run only after `status.clean === true`.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deletes legacy estimate rows that have a confirmed twin in the renamed table.
 * A row WITHOUT a twin is left untouched and reported in `orphans` — that means
 * migrateEstimates has not finished, and deleting would lose data.
 *
 * Requires `confirm: true` so it cannot fire from a fat-fingered console call.
 */
export const deleteLegacyEstimates = internalMutation({
  args: { confirm: v.boolean(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!args.confirm) {
      throw new Error(
        "deleteLegacyEstimates is destructive — pass {\"confirm\": true} once status.clean is true.",
      );
    }
    const limit = args.limit ?? DEFAULT_LIMIT;
    const legacy = await ctx.db.query("repairpal_endpoint_estimates").collect();
    const current = await ctx.db.query("estimator_estimates").collect();
    const twins = new Set(current.map(estimateKey));

    let deleted = 0;
    let orphans = 0;
    for (const row of legacy) {
      if (!twins.has(estimateKey(row))) { orphans++; continue; }
      if (deleted >= limit) break;
      await ctx.db.delete(row._id);
      deleted++;
    }

    console.log(`[purge] legacy estimates: deleted ${deleted}, ${orphans} orphans left in place`);
    return { deleted, orphans, remaining: legacy.length - deleted - orphans };
  },
});
