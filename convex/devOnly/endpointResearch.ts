/**
 * endpointResearch.ts — DEV-ONLY read-only survey of the data landscape for the
 * RepairPal endpoint ingestion. Answers: how many configs do we have, what's
 * enriched, which services map to RepairPal (+ their ids), and what's already in
 * repairpal_endpoint_estimates. Drives the backfill. Throwaway; not prod wiring.
 *   npx convex run devOnly/endpointResearch:survey
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { SERVICE_REPAIRPAL_IDS } from "../vehicleEnrichment/repairpalEndpointMatch";

const num = (x: unknown): number | null => {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const survey = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("vehicle_configs").take(4000);
    const byStatus: Record<string, number> = {};
    for (const c of configs) {
      const k = c.enrichment_status ?? "null";
      byStatus[k] = (byStatus[k] ?? 0) + 1;
    }

    const services = await ctx.db.query("services").collect();
    const mappedSlugs = new Set(Object.keys(SERVICE_REPAIRPAL_IDS));
    const mappedServices = services
      .filter((s) => s.slug && mappedSlugs.has(s.slug))
      .map((s) => ({ slug: s.slug as string, serviceId: s._id }));
    const unmappedExpected = [...mappedSlugs].filter(
      (slug) => !mappedServices.some((m) => m.slug === slug),
    );

    const endpoint = await ctx.db.query("repairpal_endpoint_estimates").take(4000);
    const endpointConfigs = new Set(endpoint.map((e) => String(e.vehicle_config_id)));

    // Sample enriched configs with resolved make/model/engine — the resolver inputs.
    const enriched = configs.filter(
      (c) => c.enrichment_status === "complete" || c.enrichment_status === "partial",
    );
    const sample: any[] = [];
    for (const c of enriched.slice(0, 25)) {
      const make = c.make_id ? await ctx.db.get(c.make_id) : null;
      const model = c.model_id ? await ctx.db.get(c.model_id) : null;
      const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
      sample.push({
        configId: c._id,
        year: c.year,
        make: (make as any)?.name ?? null,
        model: (model as any)?.name ?? null,
        trim: c.trim_name ?? null,
        drivetrain: c.drivetrain ?? null,
        pricing_tier: c.pricing_tier ?? null,
        displacementL:
          num((engine as any)?.displacement_l) ?? num((engine as any)?.displacement_liters),
        cylinders: num((engine as any)?.cylinders),
        enrichment_status: c.enrichment_status ?? null,
        hasEndpointRows: endpointConfigs.has(String(c._id)),
      });
    }

    return {
      configsScanned: configs.length,
      configsCapped: configs.length === 4000,
      configsByStatus: byStatus,
      servicesTotal: services.length,
      mappedServiceCount: mappedServices.length,
      mappedServices,
      unmappedExpectedSlugs: unmappedExpected,
      endpointRows: endpoint.length,
      endpointDistinctConfigs: endpointConfigs.size,
      enrichedCount: enriched.length,
      sample,
    };
  },
});

/** DEV-ONLY: find a usable Oto-sim target — a vehicle_owner whose user has a
 *  clerkUserId + a VIN, preferring one with an enriched config + a not-yet-due
 *  oil service (so the "argue the projection" before-behavior is observable). */
export const otoSimTarget = internalQuery({
  args: {},
  handler: async (ctx) => {
    const owners = await ctx.db.query("vehicle_owners").take(200);
    const out: any[] = [];
    for (const o of owners) {
      if (out.length >= 8) break;
      const user: any = o.user_id ? await ctx.db.get(o.user_id) : null;
      if (!user?.clerkUserId || !o.vin) continue;
      const vehicle: any = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", o.vin))
        .first();
      const cfg: any = vehicle?.vehicle_config_id ? await ctx.db.get(vehicle.vehicle_config_id) : null;
      const make: any = cfg?.make_id ? await ctx.db.get(cfg.make_id) : null;
      const model: any = cfg?.model_id ? await ctx.db.get(cfg.model_id) : null;
      out.push({
        clerkUserId: user.clerkUserId,
        email: user.email ?? null,
        firstName: user.first_name ?? null,
        vin: o.vin,
        mileage: o.mileage ?? null,
        knownIssues: o.knownIssues ?? null,
        car: cfg ? `${cfg.year ?? ""} ${make?.name ?? ""} ${model?.name ?? ""}`.trim() : "(no config)",
        enriched: !!cfg && cfg.enrichment_status === "complete",
      });
    }
    return out;
  },
});

/** Verify what landed in repairpal_endpoint_estimates: overall counts + a
 *  detailed dump of one config's rows (default the 2018 Honda Civic). */
export const verifyRows = internalQuery({
  args: { configId: v.optional(v.id("vehicle_configs")) },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("repairpal_endpoint_estimates").take(4000);
    const configs = new Set(all.map((r) => String(r.vehicle_config_id)));
    const withParts = all.filter((r) => (r.parts?.length ?? 0) > 0).length;
    const noMinutes = all.filter((r) => r.labor_minutes == null).length;

    const focusId = args.configId ?? (all[0]?.vehicle_config_id as any);
    const focusRows = all.filter((r) => String(r.vehicle_config_id) === String(focusId));
    const detail: any[] = [];
    for (const r of focusRows) {
      const svc = await ctx.db.get(r.service_id);
      detail.push({
        service: (svc as any)?.slug ?? String(r.service_id),
        match_quality: r.match_quality ?? null,
        matched_via: r.matched_via ?? null,
        variant: r.variant_label ?? null,
        labor_minutes: r.labor_minutes ?? null,
        labor_hours: r.labor_hours ?? null,
        labor_band: r.labor_low != null ? [r.labor_low, r.labor_high] : null,
        indep_total: r.total_independent_low != null ? [r.total_independent_low, r.total_independent_high] : null,
        parts: (r.parts ?? []).map((p: any) => ({
          role: p.role ?? null,
          position: p.position ?? null,
          name: p.name,
          band: p.price_low != null ? [p.price_low, p.price_high] : null,
          qty: p.quantity ?? null,
        })),
      });
    }
    return {
      totalRows: all.length,
      distinctConfigs: configs.size,
      rowsWithParts: withParts,
      rowsMissingMinutes: noMinutes,
      focusConfig: String(focusId),
      focusRowCount: focusRows.length,
      focusMatchQuality: focusRows[0]?.match_quality ?? null,
      focusMatchedVia: focusRows[0]?.matched_via ?? null,
      detail,
    };
  },
});

/** Assemble per-config resolver inputs (make/model/engine resolved + the mapped
 *  service list) for the backfill action. Returns enriched configs by default. */
export const resolverInputs = internalQuery({
  args: {
    configIds: v.optional(v.array(v.id("vehicle_configs"))),
    limit: v.optional(v.number()),
    statuses: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const services = await ctx.db.query("services").collect();
    const mappedSlugs = new Set(Object.keys(SERVICE_REPAIRPAL_IDS));
    const mappedServices = services
      .filter((s) => s.slug && mappedSlugs.has(s.slug))
      .map((s) => ({ slug: s.slug as string, serviceId: s._id }));

    const statuses = new Set(args.statuses ?? ["complete"]);
    let configs: any[];
    if (args.configIds?.length) {
      configs = [];
      for (const id of args.configIds) {
        const c = await ctx.db.get(id);
        if (c) configs.push(c);
      }
    } else {
      const all = await ctx.db.query("vehicle_configs").take(4000);
      configs = all
        .filter((c) => statuses.has(c.enrichment_status ?? ""))
        .slice(0, args.limit ?? 50);
    }

    const out: any[] = [];
    for (const c of configs) {
      const make = c.make_id ? await ctx.db.get(c.make_id) : null;
      const model = c.model_id ? await ctx.db.get(c.model_id) : null;
      const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
      const makeName = (make as any)?.name;
      const modelName = (model as any)?.name;
      if (!makeName || !modelName) continue;
      out.push({
        configId: c._id,
        make: makeName,
        model: modelName,
        trim: c.trim_name ?? null,
        year: c.year,
        displacementL:
          num((engine as any)?.displacement_l) ?? num((engine as any)?.displacement_liters),
        cylinders: num((engine as any)?.cylinders),
        drivetrain: c.drivetrain ?? null,
        services: mappedServices,
      });
    }
    return out;
  },
});
