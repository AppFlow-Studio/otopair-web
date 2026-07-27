/**
 * endpointPartPriceBackfill.ts — DEV-ONLY driver: reads estimator_estimates
 * and writes each endpoint part's averaged PER-UNIT point into part_prices
 * (source_domain="estimator_endpoint"), joined to the config's fitment by role.
 * Inert to existing consumers (price_type excluded from the pooled aggregate);
 * only resolvePartsCost's gated real-band block reads them. Not prod wiring.
 *
 *   npx convex run devOnly/endpointPartPriceBackfill:backfill
 *   npx convex run devOnly/endpointPartPriceBackfill:backfill '{"configIds":["xd7.."]}'
 */
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { endpointPartCategory, endpointRoleToSubcategory } from "../vehicleEnrichment/estimatorEndpointMatch";
import { ESTIMATOR_SOURCE_URL } from "../lib/estimatorApi";
import { collectEstimates, listEstimatesByConfig } from "../lib/estimatorEstimates";

/**
 * One-shot DB migration: re-map every stored estimator_estimates part's
 * `role`/`position` from its `name` using the current endpointPartCategory — so
 * existing rows pick up role-mapper fixes (engine oil recognized, filter seals
 * split out of oil_filter, transmission filter routed correctly) WITHOUT
 * re-fetching from Estimator. The position from the name wins; otherwise the
 * already-stored position is kept (brake parts carry position with no front/rear
 * in the name). Idempotent.
 */
export const remapEndpointPartRoles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await collectEstimates(ctx);
    let rowsTouched = 0;
    let partsChanged = 0;
    for (const row of rows) {
      const parts = row.parts ?? [];
      if (!parts.length) continue;
      let changed = false;
      const next = parts.map((p: any) => {
        const cat = endpointPartCategory(p.name ?? "");
        const role = cat?.category;
        const position = cat?.position ?? p.position;
        if (role !== p.role || position !== p.position) {
          changed = true;
          partsChanged++;
        }
        return { ...p, role, position };
      });
      if (changed) {
        await ctx.db.patch(row._id, { parts: next });
        rowsTouched++;
      }
    }
    return { rows: rows.length, rowsTouched, partsChanged };
  },
});

/** Resolve the (config, service slug, endpoint part) → part_id by subcategory. */
export const matchFitmentForEndpointPart = internalQuery({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_slug: v.string(),
    subcategory: v.string(),
  },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id).eq("service_type", args.service_slug))
      .collect();
    for (const f of fitments) {
      const part = await ctx.db.get(f.part_id);
      if ((part as any)?.subcategory === args.subcategory) {
        return { part_id: f.part_id, quantity_needed: f.quantity_needed ?? null };
      }
    }
    return null;
  },
});

/** Join the endpoint rows to their service slug (the estimates table stores
 *  service_id, but the fitment match keys on the slug). */
export const listEndpointRows = internalQuery({
  args: { configIds: v.optional(v.array(v.id("vehicle_configs"))) },
  handler: async (ctx, args) => {
    const all = args.configIds
      ? (await Promise.all(args.configIds.map((id) => listEstimatesByConfig(ctx, id)))).flat()
      : await collectEstimates(ctx);
    const out: any[] = [];
    for (const row of all) {
      const service = await ctx.db.get(row.service_id);
      out.push({
        vehicle_config_id: row.vehicle_config_id,
        serviceSlug: (service as any)?.slug ?? null,
        parts: row.parts ?? [],
        fetched_at: row.fetched_at,
      });
    }
    return out;
  },
});

export const backfill = internalAction({
  args: { configIds: v.optional(v.array(v.id("vehicle_configs"))) },
  handler: async (ctx, args): Promise<any> => {
    const rows: any[] = await ctx.runQuery(
      internal.devOnly.endpointPartPriceBackfill.listEndpointRows,
      { configIds: args.configIds },
    );
    let written = 0;
    let skipped = 0;
    for (const row of rows) {
      const slug = row.serviceSlug as string | null;
      if (!slug) { skipped++; continue; }
      for (const p of row.parts ?? []) {
        const sub = endpointRoleToSubcategory(p.role, p.position);
        const qty = typeof p.quantity === "number" && p.quantity > 0 ? p.quantity : null;
        if (!sub || qty == null || typeof p.price_low !== "number" || typeof p.price_high !== "number") {
          skipped++; continue;
        }
        const match: any = await ctx.runQuery(
          internal.devOnly.endpointPartPriceBackfill.matchFitmentForEndpointPart,
          { vehicle_config_id: row.vehicle_config_id, service_slug: slug, subcategory: sub },
        );
        if (!match) { skipped++; continue; }
        // Divisor is the ENDPOINT's reported unit count (p.quantity) — that is
        // the count Estimator's total_price covers, so avg / p.quantity is the
        // true PER-UNIT price. Do NOT divide by the fitment's quantity_needed:
        // the config's canonical quantity is applied later at READ time
        // (resolvePartsCost → resolveRoleQuantity), which re-multiplies the
        // per-unit point by the actual vehicle's count.
        const avg = (p.price_low + p.price_high) / 2;
        await ctx.runMutation(
          internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice,
          { part_id: match.part_id, price: avg / qty, source_url: ESTIMATOR_SOURCE_URL, refreshed_at: row.fetched_at },
        );
        written++;
      }
    }
    return { rows: rows.length, written, skipped };
  },
});
