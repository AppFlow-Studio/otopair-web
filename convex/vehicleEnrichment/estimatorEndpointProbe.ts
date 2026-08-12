/**
 * estimatorEndpointProbe.ts — one-shot GATE check: can a Convex cloud action
 * reach the Estimator next-api endpoints? It works from our dev IP, but
 * Cloudflare may treat Convex datacenter IPs differently. Run this BEFORE
 * trusting the live-in-pipeline resolver:
 *   npx convex run vehicleEnrichment/estimatorEndpointProbe:probe
 * Green = both `makesStatus` and `estimateStatus` are 200 and
 * `estimateHasMinutes` is true. Throwaway once verified.
 */
import { internalAction } from "../_generated/server";
import { requireEstimatorApiBase } from "../lib/estimatorApi";

export const probe = internalAction({
  args: {},
  handler: async (): Promise<Record<string, unknown>> => {
    const headers = { accept: "application/json" } as const;
    const out: Record<string, unknown> = {};
    const BASE = requireEstimatorApiBase("endpoint reachability probe");
    if (!BASE) return { error: "ESTIMATOR_API_BASE not set on this deployment" };
    try {
      const r = await fetch(`${BASE}/makes?year=2021`, { headers });
      out.makesStatus = r.status;
      const j: unknown = r.status === 200 ? await r.json() : null;
      out.makesCount = Array.isArray(j) ? j.length : null;
    } catch (e: unknown) {
      out.makesError = String((e as Error)?.message ?? e);
    }
    try {
      // 2021 Honda Civic (baseVehicleId 78290) × Oil Change (serviceId 107) — known-good.
      const r = await fetch(
        `${BASE}/estimate?baseVehicleId=78290&serviceId=107&zipCode=10001&scheduled=0`,
        { headers },
      );
      out.estimateStatus = r.status;
      const j: unknown = r.status === 200 ? await r.json() : null;
      out.estimateHasMinutes = !!j && JSON.stringify(j).includes('"minutes"');
    } catch (e: unknown) {
      out.estimateError = String((e as Error)?.message ?? e);
    }
    return out;
  },
});
