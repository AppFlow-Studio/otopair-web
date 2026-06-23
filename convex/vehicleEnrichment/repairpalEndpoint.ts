/**
 * repairpalEndpoint.ts — RepairPal ESTIMATE-ENDPOINT resolver (the new
 * high-confidence labor + parts source).
 *
 * STATUS: SCAFFOLD. Wired into `laborAllSources` as a parallel, flag-gated
 * (`LABOR_SOURCE_REPAIRPAL_ENDPOINT`, default-off), try/catch-isolated source so
 * the pipeline is prepared to pull endpoint data in parallel. The network fetch
 * + matcher composition is implemented in the follow-up plan
 * (docs/superpowers/plans/2026-06-22-repairpal-endpoint-integration.md) once the
 * Convex-fetch probe (repairpalEndpointProbe:probe) confirms Cloudflare lets a
 * Convex cloud action reach the endpoint. Until then it resolves to empty —
 * fully inert.
 *
 * Pure helpers it will compose are already built + unit-tested:
 *   convex/vehicleEnrichment/repairpalEndpointMatch.ts
 *   (resolveMakeId, resolveBaseVehicleId, extractVariants, selectVariant, endpointPartCategory)
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";

export type RepairpalEndpointResult = {
  resolved: boolean;
  /** serviceSlug -> labor hours (fed into the labor_observations merge at weight 0.9). */
  services: Record<string, number>;
};

export const resolveRepairpalEndpointForConfig = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.union(v.string(), v.null())),
    year: v.number(),
    displacementL: v.optional(v.union(v.number(), v.null())),
    cylinders: v.optional(v.union(v.number(), v.null())),
    drivetrain: v.optional(v.union(v.string(), v.null())),
    services: v.array(v.object({ slug: v.string(), serviceId: v.id("services") })),
  },
  handler: async (_ctx, _args): Promise<RepairpalEndpointResult> => {
    // TODO (follow-up plan — gated on the Convex-fetch probe):
    //  1. Resolve baseVehicleId LIVE: GET /makes?year → resolveMakeId; GET
    //     /base-vehicles?year&makeId → resolveBaseVehicleId(model, trim).
    //  2. Per mapped service (SERVICE_SLUG → RepairPal serviceId): GET /estimate
    //     → extractVariants → selectVariant({displacementL, cylinders, trim, position}).
    //  3. Upsert the raw row → repairpal_endpoint_estimates (labor_minutes/hours,
    //     labor $ band, independent/dealer totals, per-role parts ranges via
    //     endpointPartCategory, baseVehicleId, variant, zip, fetched_at).
    //  4. Return { resolved, services: { slug: labor_hours } } for the merge.
    return { resolved: false, services: {} };
  },
});
