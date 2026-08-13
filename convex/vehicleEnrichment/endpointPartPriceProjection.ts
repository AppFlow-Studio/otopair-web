/**
 * vehicleEnrichment/endpointPartPriceProjection.ts — LIVE per-config projection
 * of estimator endpoint part prices into part_prices (Aug 2026).
 *
 * The estimate endpoint returns per-service parts with total_price bands, and
 * resolveEstimatorEndpointForConfig stores them raw on estimator_estimates —
 * but the only thing that ever projected them into part_prices was the
 * devOnly fleet backfill, so resolvePartsCost's endpoint peer (the fallback
 * point a role uses when it has no SKU price at all) was ALWAYS null on any
 * deployment nobody hand-ran the backfill on. This module is the prod wiring:
 * scheduled fire-and-forget by resolveEstimatorEndpointForConfig after every
 * successful resolution, so both the in-pipeline labor leg and the relabor
 * backfills project automatically.
 *
 * Write policy (unchanged from the backfill): one row per part at
 * source_domain="estimator_endpoint", price_type non-pooled — it never enters
 * summarizePriceRows or any pooled SKU aggregate, and is read ONLY by
 * resolvePartsCost's PARTS_SOURCE_REAL_PRIMARY-gated real-band block. The
 * upsert is idempotent per (part, source_domain), so re-projection is free.
 *
 * Divisor law (see devOnly/endpointPartPriceBackfill.ts for the long form):
 * per-unit = avg(price_low, price_high) / the ENDPOINT's own quantity — never
 * the fitment's quantity_needed, which resolveRoleQuantity re-applies at read
 * time.
 *
 * Kill switch: PARTS_ENDPOINT_PRICE_PROJECTION=off.
 */
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { endpointRoleToSubcategory } from "./estimatorEndpointMatch";
import { ESTIMATOR_SOURCE_URL } from "../lib/estimatorApi";
import { listEstimatesByConfig } from "../lib/estimatorEstimates";

/** One projectable per-unit point derived from a stored estimate row. */
export interface EndpointPricePoint {
  serviceSlug: string;
  subcategory: string;
  perUnit: number;
  fetched_at: number;
}

/** Pure: the projectable points in one estimate row. A part is skipped when
 *  its role cannot be placed on a canonical subcategory, its quantity is
 *  missing/non-positive (the divisor law needs the endpoint's own count), or
 *  either price bound is absent. Exported for tests. */
export function endpointPricePoints(row: {
  serviceSlug: string | null;
  parts: ReadonlyArray<{
    role?: string | null;
    position?: string | null;
    quantity?: number | null;
    price_low?: number | null;
    price_high?: number | null;
  }>;
  fetched_at: number;
}): EndpointPricePoint[] {
  if (!row.serviceSlug) return [];
  const out: EndpointPricePoint[] = [];
  for (const p of row.parts ?? []) {
    const subcategory = endpointRoleToSubcategory(p.role, p.position);
    if (!subcategory) continue;
    const qty = typeof p.quantity === "number" && p.quantity > 0 ? p.quantity : null;
    if (qty == null) continue;
    if (typeof p.price_low !== "number" || typeof p.price_high !== "number") continue;
    const perUnit = (p.price_low + p.price_high) / 2 / qty;
    if (!Number.isFinite(perUnit) || perUnit <= 0) continue;
    out.push({ serviceSlug: row.serviceSlug, subcategory, perUnit, fetched_at: row.fetched_at });
  }
  return out;
}

/** This config's estimate rows joined to their service slug (the estimates
 *  table stores service_id; the fitment match keys on the slug). */
export const listEndpointRowsForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const rows = await listEstimatesByConfig(ctx, args.vehicleConfigId);
    const out: Array<{ serviceSlug: string | null; parts: any[]; fetched_at: number }> = [];
    for (const row of rows) {
      const service = await ctx.db.get(row.service_id);
      out.push({
        serviceSlug: (service as any)?.slug ?? null,
        parts: (row as any).parts ?? [],
        fetched_at: (row as any).fetched_at ?? row._creationTime,
      });
    }
    return out;
  },
});

/** Resolve (config, service slug, subcategory) → the fitment's part_id. */
export const matchFitmentForEndpointPart = internalQuery({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    serviceSlug: v.string(),
    subcategory: v.string(),
  },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", args.vehicleConfigId).eq("service_type", args.serviceSlug))
      .collect();
    for (const f of fitments) {
      const part = await ctx.db.get(f.part_id);
      if ((part as any)?.subcategory === args.subcategory) return { part_id: f.part_id };
    }
    return null;
  },
});

export const projectEndpointPartPricesForConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    if (process.env.PARTS_ENDPOINT_PRICE_PROJECTION === "off") {
      return { status: "disabled" as const };
    }
    const rows: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.endpointPartPriceProjection.listEndpointRowsForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    let written = 0;
    let unmatched = 0;
    for (const row of rows) {
      for (const point of endpointPricePoints(row)) {
        const match: any = await ctx.runQuery(
          internal.vehicleEnrichment.endpointPartPriceProjection.matchFitmentForEndpointPart,
          {
            vehicleConfigId: args.vehicleConfigId,
            serviceSlug: point.serviceSlug,
            subcategory: point.subcategory,
          },
        );
        // No fitment yet (e.g. the role is still empty and a heal rung fills it
        // later) — skip; the next resolution or the devOnly sweep re-projects.
        if (!match) { unmatched++; continue; }
        await ctx.runMutation(
          internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice,
          {
            part_id: match.part_id,
            price: point.perUnit,
            source_url: ESTIMATOR_SOURCE_URL,
            refreshed_at: point.fetched_at,
          },
        );
        written++;
      }
    }
    const summary = { status: "done" as const, rows: rows.length, written, unmatched };
    console.log("[endpoint-price-projection]", JSON.stringify(summary));
    return summary;
  },
});
