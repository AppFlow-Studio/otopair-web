/**
 * publicLabor.ts — the ONE mapper between the quote engine's labor ladder and
 * anything a /v0 API key holder can see (Data spec §12 layer gate).
 *
 * The ladder (quoteEngine.resolveLaborHours) can resolve from licensed Layer-B
 * inputs — vdb / aggregated (Estimator / Book Rate medians) / vdb_camry_baseline /
 * sibling book_hours — and those raw hours must never leave the building. The
 * public surface serves exactly two source labels:
 *
 *   "empirical"       — measured Otopair post-job actuals (Layer D, ours)
 *   "model_estimate"  — the Camry-anchor × own-multiplier tier derivation
 *                       (the "Yassin fallback"), a materially transformed
 *                       model output, not a licensed book time
 *
 * When the ladder resolved from a B-source, we substitute the recomputed tier
 * floor (the same number the ladder would have used as its guardrail) instead
 * of the raw book hours; if no floor exists for the service/tier, we serve
 * nothing rather than leak. Enforced by dataApi.laborGateCheck.
 */
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { VehicleTier } from "./vehicleTiers";
import { resolveLaborHours } from "./quoteEngine";
import { computeLaborTierFloorHours } from "./laborFallback";

export type PublicLaborEstimate = {
  hours: number;
  source: "empirical" | "model_estimate";
  confidence: number | null;
  /** True when the served hours are the Camry×tier floor substituted for an
   *  internal (licensed) book-time resolution. */
  tier_floor_applied: boolean;
} | null;

export async function resolvePublicLaborEstimate(
  ctx: QueryCtx,
  args: {
    vehicle_config_id: Id<"vehicle_configs">;
    service_id: Id<"services">;
    vehicle_tier: VehicleTier;
  },
): Promise<PublicLaborEstimate> {
  const res = await resolveLaborHours(ctx, args);
  if (!res.ok) return null;

  if (res.source === "empirical") {
    return { hours: res.hours, source: "empirical", confidence: res.confidence, tier_floor_applied: false };
  }
  if (res.source === "tier_estimate") {
    return { hours: res.hours, source: "model_estimate", confidence: res.confidence, tier_floor_applied: false };
  }

  // B-sourced resolution (vdb / aggregated / vdb_camry_baseline / sibling).
  // When the floor was substituted, res.hours already IS the Camry-derived
  // floor; otherwise recompute it. Either way the raw book hours stay inside.
  if (res.tier_floor_applied === true) {
    return { hours: res.hours, source: "model_estimate", confidence: 0.3, tier_floor_applied: true };
  }
  const floor = await computeLaborTierFloorHours(ctx, {
    serviceId: args.service_id,
    vehicleTier: args.vehicle_tier as unknown as string,
  });
  if (floor == null) return null;
  return { hours: floor, source: "model_estimate", confidence: 0.3, tier_floor_applied: true };
}
