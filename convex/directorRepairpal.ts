/**
 * directorRepairpal.ts — read-only director queries surfacing the RepairPal
 * estimate-endpoint data + labor times. Read-only (middleware-gated like the
 * other director queries). RepairPal endpoint minutes are the AUTHORITATIVE
 * labor value when present (exact MOTOR flat-rate); other sources are shown as
 * secondary corroboration, with a flag when they disagree — never as a
 * competing value to pick.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";

/** Overview: counts + the list of configs that have endpoint data. */
export const repairpalLaborOverview = query({
  args: {},
  handler: async (ctx) => {
    const eps = await ctx.db.query("repairpal_endpoint_estimates").take(5000);

    const byConfig = new Map<
      string,
      { id: any; count: number; matchQuality: string | null; matchedVia: string | null }
    >();
    const services = new Set<string>();
    let exactRows = 0;
    let siblingRows = 0;

    for (const ep of eps) {
      const cid = String(ep.vehicle_config_id);
      let c = byConfig.get(cid);
      if (!c) {
        c = { id: ep.vehicle_config_id, count: 0, matchQuality: ep.match_quality ?? "exact", matchedVia: ep.matched_via ?? null };
        byConfig.set(cid, c);
      }
      c.count++;
      services.add(String(ep.service_id));
      if (ep.match_quality === "engine_sibling") {
        siblingRows++;
        c.matchQuality = "engine_sibling";
        c.matchedVia = ep.matched_via ?? c.matchedVia;
      } else {
        exactRows++;
      }
    }

    const configs: any[] = [];
    for (const c of byConfig.values()) {
      const cfg: any = await ctx.db.get(c.id);
      const make: any = cfg?.make_id ? await ctx.db.get(cfg.make_id) : null;
      const model: any = cfg?.model_id ? await ctx.db.get(cfg.model_id) : null;
      configs.push({
        configId: c.id,
        year: cfg?.year ?? null,
        make: make?.name ?? null,
        model: model?.name ?? null,
        trim: cfg?.trim_name ?? null,
        tier: cfg?.pricing_tier ?? null,
        serviceCount: c.count,
        matchQuality: c.matchQuality,
        matchedVia: c.matchedVia,
      });
    }
    configs.sort((a, b) =>
      `${a.make ?? ""} ${a.model ?? ""} ${a.year ?? ""}`.localeCompare(
        `${b.make ?? ""} ${b.model ?? ""} ${b.year ?? ""}`,
      ),
    );

    // Is endpoint labor actually live yet? It's live only once laborAllSources
    // (flag-gated) has written repairpal_endpoint observations. The backfill
    // fills the endpoint table but NOT labor_observations, so this is 0 until
    // LABOR_SOURCE_REPAIRPAL_ENDPOINT is flipped on.
    const endpointObs = await ctx.db
      .query("labor_observations")
      .filter((q) => q.eq(q.field("source"), "repairpal_endpoint"))
      .take(1);
    const endpointLaborLive = endpointObs.length > 0;

    return {
      totalRows: eps.length,
      capped: eps.length === 5000,
      configCount: byConfig.size,
      exactRows,
      siblingRows,
      serviceCount: services.size,
      endpointLaborLive,
      configs,
    };
  },
});

/**
 * Per-config detail: per service, the RepairPal endpoint estimate (authoritative
 * labor) + parts, alongside the current labor_times row and the corroborating
 * observations (secondary). RepairPal minutes are the source of truth here.
 */
export const repairpalLaborByConfig = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, { vehicle_config_id }) => {
    const eps = await ctx.db
      .query("repairpal_endpoint_estimates")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", vehicle_config_id))
      .collect();

    const rows: any[] = [];
    for (const ep of eps) {
      const svc: any = await ctx.db.get(ep.service_id);
      const lt: any = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", vehicle_config_id).eq("service_id", ep.service_id),
        )
        .first();
      const obs = await ctx.db
        .query("labor_observations")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", vehicle_config_id).eq("service_id", ep.service_id),
        )
        .collect();

      rows.push({
        serviceId: ep.service_id,
        serviceName: svc?.name ?? svc?.slug ?? "—",
        slug: svc?.slug ?? null,
        rp: {
          minutes: ep.labor_minutes ?? null,
          hours: ep.labor_hours ?? null,
          laborBand: ep.labor_low != null ? [ep.labor_low, ep.labor_high] : null,
          independentTotal: ep.total_independent_low != null ? [ep.total_independent_low, ep.total_independent_high] : null,
          variant: ep.variant_label ?? null,
          matchQuality: ep.match_quality ?? "exact",
          matchedVia: ep.matched_via ?? null,
          parts: (ep.parts ?? []).map((p: any) => ({
            role: p.role ?? null,
            name: p.name,
            qty: p.quantity ?? null,
            band: p.price_low != null ? [p.price_low, p.price_high] : null,
            position: p.position ?? null,
          })),
          fetchedAt: ep.fetched_at,
        },
        current: lt
          ? {
              bookHours: lt.book_hours ?? null,
              source: lt.source ?? null,
              confidence: lt.confidence ?? null,
              sourcesDisagree: lt.labor_sources_disagree ?? false,
              outsideFallbackBand: lt.labor_outside_fallback_band ?? false,
              fallbackGapMinutes: lt.fallback_gap_minutes ?? null,
            }
          : null,
        // Secondary corroboration only — NOT a competing value.
        corroboration: obs
          .map((o: any) => ({ source: o.source, hours: o.hours, weight: o.weight ?? null }))
          .sort((a: any, b: any) => (b.weight ?? 0) - (a.weight ?? 0)),
      });
    }

    rows.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
    return rows;
  },
});
