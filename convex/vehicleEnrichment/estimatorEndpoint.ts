/**
 * estimatorEndpoint.ts — Estimator ESTIMATE-ENDPOINT resolver (the new
 * high-confidence labor + parts source).
 *
 * STATUS: IMPLEMENTED. Resolves make → base-vehicle → per-service estimates
 * via the Estimator next-api estimator-flow endpoint, upserts raw rows into
 * estimator_estimates, and returns { resolved, services: {slug: hours} }
 * for the labor_observations merge (weight 0.9).
 *
 * Pure helpers composed (do not re-implement):
 *   convex/vehicleEnrichment/estimatorEndpointMatch.ts
 *   (resolveMakeId, resolveBaseVehicleId, extractVariants, selectVariant,
 *    endpointPartCategory, SERVICE_ESTIMATOR_IDS)
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import {
  resolveMakeId,
  resolveBaseVehicleId,
  extractVariants,
  selectVariant,
  endpointPartCategory,
  SERVICE_ESTIMATOR_IDS,
  type EndpointVariant,
} from "./estimatorEndpointMatch";
import { internal } from "../_generated/api";
import { selectEngineSiblingLLM } from "./estimatorEndpointSibling";
import { requireEstimatorApiBase } from "../lib/estimatorApi";

export type EstimatorEndpointResult = {
  resolved: boolean;
  /** serviceSlug -> labor hours (fed into the labor_observations merge at weight 0.9). */
  services: Record<string, number>;
};

const ZIP = "10001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.status === 200) return await r.json();
      if (r.status === 404) return null;
    } catch { /* retry */ }
    await sleep(400 * (i + 1));
  }
  return null;
}

/** Brake services need a front/rear position to disambiguate variants. */
function svcPosition(slug: string): string | null {
  return slug.includes("rotor") || slug.includes("brake_pad") ? "front" : null;
}

/** Map a raw endpoint part → our stored row shape (role via endpointPartCategory). */
function mapPart(p: any) {
  const name = p?.part ?? "";
  const cat = endpointPartCategory(name);
  // Prefer the helper's name-derived front/rear; else normalize the raw
  // part.position ("Front Upper"/"Rear"/"N/A") to front/rear (matters for brakes).
  let position = cat?.position;
  if (!position && typeof p?.position === "string") {
    const pl = p.position.toLowerCase();
    if (pl.startsWith("front")) position = "front";
    else if (pl.startsWith("rear")) position = "rear";
  }
  return {
    role: cat?.category,
    position,
    name,
    quantity: typeof p?.quantity === "number" ? p.quantity : undefined,
    price_low: p?.total_price?.low,
    price_high: p?.total_price?.high,
  };
}

export const resolveEstimatorEndpointForConfig = internalAction({
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
  handler: async (ctx, args): Promise<EstimatorEndpointResult> => {
    // Provider host comes from the deployment env, never from source. Unset →
    // report unresolved so the labor aggregate falls back to its other sources.
    const BASE = requireEstimatorApiBase("estimate-endpoint resolution");
    if (!BASE) return { resolved: false, services: {} };

    const makes = await getJson(`${BASE}/makes?year=${args.year}`);
    const makeId = Array.isArray(makes) ? resolveMakeId(makes, args.make) : null;
    if (makeId == null) return { resolved: false, services: {} };

    const baseVehicles = await getJson(`${BASE}/base-vehicles?year=${args.year}&makeId=${makeId}`);
    let baseVehicleId: number | null = Array.isArray(baseVehicles)
      ? resolveBaseVehicleId(baseVehicles, { model: args.model, trim: args.trim ?? null })
      : null;
    let matchQuality = "exact";
    let matchedVia: string | undefined = undefined;

    // Tier 2: exact/token-set miss -> ask the LLM for the closest engine-equivalent
    // RP base vehicle (flagged engine_sibling). Inert if no ANTHROPIC_API_KEY.
    if (baseVehicleId == null && Array.isArray(baseVehicles)) {
      const sib = await selectEngineSiblingLLM(
        {
          year: args.year, make: args.make, model: args.model, trim: args.trim ?? null,
          displacementL: args.displacementL ?? null, cylinders: args.cylinders ?? null,
          drivetrain: args.drivetrain ?? null,
        },
        baseVehicles,
      );
      if (sib) { baseVehicleId = sib.id; matchQuality = "engine_sibling"; matchedVia = sib.modelName; }
    }
    if (baseVehicleId == null) return { resolved: false, services: {} };

    const services: Record<string, number> = {};

    const fetchVariant = async (sid: number, slug: string) => {
      await sleep(140);
      const j = await getJson(`${BASE}/estimate?baseVehicleId=${baseVehicleId}&serviceId=${sid}&zipCode=${ZIP}&scheduled=0`);
      const variants = j ? extractVariants(j) : [];
      if (!variants.length) return null;
      return selectVariant(variants, {
        displacementL: args.displacementL ?? null,
        cylinders: args.cylinders ?? null,
        trim: args.trim ?? null,
        position: svcPosition(slug),
      });
    };

    for (const svc of args.services) {
      const map = SERVICE_ESTIMATOR_IDS[svc.slug];
      if (!map) continue;

      if (svc.slug === "filter_replacement") {
        // SUM both ids (air 14 + cabin 35): combine minutes + parts so the service
        // captures BOTH filters rather than air-only.
        const picks: EndpointVariant[] = [];
        for (const sid of map.serviceIds) {
          const vrt = await fetchVariant(sid, svc.slug);
          if (vrt) picks.push(vrt);
        }
        if (!picks.length) continue;
        const minutes = picks.reduce((s, vrt) => s + vrt.minutes, 0);
        const parts = picks.flatMap((vrt) => (vrt.parts ?? []).map(mapPart));
        const sum = (f: (vrt: any) => number | undefined) => {
          const t = picks.reduce((s, vrt) => s + (f(vrt) ?? 0), 0);
          return t || undefined;
        };
        services[svc.slug] = minutes / 60;
        await ctx.runMutation(internal.vehicleEnrichment.estimatorEndpointMutations.upsertEstimatorEstimate, {
          vehicle_config_id: args.vehicleConfigId, service_id: svc.serviceId, base_vehicle_id: baseVehicleId,
          variant_label: picks.map((vrt) => vrt.label).join(" + "),
          labor_minutes: minutes, labor_hours: minutes / 60,
          labor_low: sum((vrt) => vrt.laborLow), labor_high: sum((vrt) => vrt.laborHigh),
          total_independent_low: sum((vrt) => vrt.total?.independent?.low), total_independent_high: sum((vrt) => vrt.total?.independent?.high),
          total_dealer_low: sum((vrt) => vrt.total?.dealer?.low), total_dealer_high: sum((vrt) => vrt.total?.dealer?.high),
          parts, zip: ZIP, match_quality: matchQuality, matched_via: matchedVia, fetched_at: Date.now(),
        });
        continue;
      }

      // Single id, or multi-id FALLBACK chain (e.g. rotor: standalone 31 then composite 4453439):
      // the first id that yields a selected variant wins.
      for (const sid of map.serviceIds) {
        const picked = await fetchVariant(sid, svc.slug);
        if (!picked) continue;
        services[svc.slug] = picked.minutes / 60;
        const parts = (picked.parts ?? []).map(mapPart);
        await ctx.runMutation(internal.vehicleEnrichment.estimatorEndpointMutations.upsertEstimatorEstimate, {
          vehicle_config_id: args.vehicleConfigId, service_id: svc.serviceId, base_vehicle_id: baseVehicleId,
          variant_label: picked.label,
          labor_minutes: picked.minutes, labor_hours: picked.minutes / 60,
          labor_low: picked.laborLow, labor_high: picked.laborHigh,
          total_independent_low: picked.total?.independent?.low, total_independent_high: picked.total?.independent?.high,
          total_dealer_low: picked.total?.dealer?.low, total_dealer_high: picked.total?.dealer?.high,
          parts, zip: ZIP, match_quality: matchQuality, matched_via: matchedVia, fetched_at: Date.now(),
        });
        break; // this service resolved
      }
    }

    return { resolved: Object.keys(services).length > 0, services };
  },
});
