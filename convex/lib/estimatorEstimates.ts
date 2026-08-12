/**
 * convex/lib/estimatorEstimates.ts — dual-read access to the estimator's raw
 * estimate cache.
 *
 * Rows written before the vendor-name purge live in the legacy table; rows
 * written after live in `estimator_estimates`. Every READ goes through this
 * module so a partially-migrated deployment sees the union. WRITES always go
 * to `estimator_estimates` (see estimatorEndpointMutations.ts).
 *
 * De-duplication is keyed on (vehicle_config_id, service_id) with the NEW table
 * winning, so a row the migration has already copied is never counted twice and
 * a re-fetch that landed in the new table always shadows its legacy original.
 *
 * ── AFTER THE MIGRATION ───────────────────────────────────────────────────
 * Once every deployment reports a 0-row legacy remainder, delete
 * `readLegacy()` and its call sites here (the exported signatures do not
 * change), then drop the legacy table from schema.ts. See the runbook:
 * docs/superpowers/runbooks/2026-07-27-vendor-name-purge-migration.md
 */

import type { Doc } from "../_generated/dataModel";

const LEGACY_TABLE = "repairpal_endpoint_estimates" as const;
const CURRENT_TABLE = "estimator_estimates" as const;

/**
 * A row from either table. The two shapes are identical apart from the `_id`
 * brand, so callers can read every field; only `_id` is a union. Typing this
 * explicitly (rather than `any`) keeps `vehicle_config_id` / `service_id` as
 * real Ids, so `ctx.db.get()` still narrows to the right document type.
 */
export type EstimateRow = Doc<typeof CURRENT_TABLE> | Doc<typeof LEGACY_TABLE>;

/** (config, service) identity of an estimate row. */
function rowKey(row: EstimateRow): string {
  return `${String(row.vehicle_config_id)}::${String(row.service_id)}`;
}

/**
 * Merge current + legacy rows, current winning on key collision.
 * Order is preserved: current rows first, then legacy rows with no current twin.
 */
function mergeRows(current: EstimateRow[], legacy: EstimateRow[]): EstimateRow[] {
  const seen = new Set(current.map(rowKey));
  const extra = legacy.filter((r) => !seen.has(rowKey(r)));
  return extra.length ? [...current, ...extra] : current;
}

/** True while the legacy table still holds rows on this deployment. */
export async function legacyEstimatesRemain(ctx: any): Promise<boolean> {
  const one = await ctx.db.query(LEGACY_TABLE).first();
  return one != null;
}

/** All estimate rows for one vehicle config (both tables). */
export async function listEstimatesByConfig(ctx: any, configId: any): Promise<EstimateRow[]> {
  const current = await ctx.db
    .query(CURRENT_TABLE)
    .withIndex("by_config", (q: any) => q.eq("vehicle_config_id", configId))
    .collect();
  const legacy = await ctx.db
    .query(LEGACY_TABLE)
    .withIndex("by_config", (q: any) => q.eq("vehicle_config_id", configId))
    .collect();
  return mergeRows(current, legacy);
}

/** The estimate row for one (config, service), preferring the current table. */
export async function findEstimate(ctx: any, configId: any, serviceId: any): Promise<EstimateRow | null> {
  const byKey = (table: typeof CURRENT_TABLE | typeof LEGACY_TABLE) =>
    ctx.db
      .query(table)
      .withIndex("by_config_service", (q: any) =>
        q.eq("vehicle_config_id", configId).eq("service_id", serviceId),
      )
      .first();
  return (await byKey(CURRENT_TABLE)) ?? (await byKey(LEGACY_TABLE));
}

/**
 * Up to `limit` estimate rows across both tables. The legacy table is only
 * touched when the current table hasn't already satisfied the limit, so a
 * fully-migrated deployment pays nothing for the compatibility path.
 */
export async function listEstimates(ctx: any, limit: number): Promise<EstimateRow[]> {
  const current = await ctx.db.query(CURRENT_TABLE).take(limit);
  if (current.length >= limit) return current;
  const legacy = await ctx.db.query(LEGACY_TABLE).take(limit - current.length);
  return mergeRows(current, legacy);
}

/**
 * The `limit` most recently created estimate rows across both tables.
 * Both sides are pulled newest-first, merged, then re-sorted so the result is
 * genuinely the newest N of the union rather than the newest N of either half.
 */
export async function listRecentEstimates(ctx: any, limit: number): Promise<EstimateRow[]> {
  const current = await ctx.db.query(CURRENT_TABLE).order("desc").take(limit);
  const legacy = await ctx.db.query(LEGACY_TABLE).order("desc").take(limit);
  return mergeRows(current, legacy)
    .sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0))
    .slice(0, limit);
}

/** Every estimate row across both tables. Full scan — batch/devOnly paths only. */
export async function collectEstimates(ctx: any): Promise<EstimateRow[]> {
  const current = await ctx.db.query(CURRENT_TABLE).collect();
  const legacy = await ctx.db.query(LEGACY_TABLE).collect();
  return mergeRows(current, legacy);
}
