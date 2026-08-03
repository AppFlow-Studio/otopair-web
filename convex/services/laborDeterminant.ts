import { internalMutation } from "../_generated/server";

/**
 * Static per-service labor sourcing config.
 *
 * Keys are the AUTHORITATIVE services.slug values (underscore form, seeded by
 * convex/seeds/seedServices.ts — NOT the stale hyphenated seed_services*.ts).
 *
 *  determinant   — which platform key drives this service's labor:
 *                  "engine" (engine-bay access → engine_family),
 *                  "chassis" (corner/body/cabin → chassis_code), or "both".
 *  estimator_slug — Estimator estimator slug whose page scope matches OURS 1:1,
 *                  or null where Estimator has no matching page (fluids, bundles,
 *                  diagnostics) → those rely on the LLM source. We deliberately
 *                  DON'T map bundles (e.g. filter_replacement = engine+cabin air
 *                  filter) since a partial Estimator value would be wrong, not
 *                  merely missing.
 */
export const LABOR_SERVICE_CONFIG: Record<
  string,
  { determinant: "engine" | "chassis" | "both"; estimator_slug: string | null }
> = {
  // Engine-determined, clean 1:1 Estimator coverage:
  oil_change: { determinant: "engine", estimator_slug: "oil-change" },
  spark_plugs: { determinant: "engine", estimator_slug: "spark-plug-replacement" },
  timing_belt: { determinant: "engine", estimator_slug: "timing-belt-replacement" },
  // Chassis-determined, clean 1:1 Estimator coverage:
  brake_pad_replacement: { determinant: "chassis", estimator_slug: "brake-pad-replacement" },
  rotor_replacement: { determinant: "chassis", estimator_slug: "brake-rotor-replacement" },
  battery_replacement: { determinant: "chassis", estimator_slug: "battery-replacement" },
  wheel_alignment: { determinant: "chassis", estimator_slug: "wheel-alignment" },
  // Known Estimator gaps / bundles / diagnostics — determinant recorded, slug
  // null → sourced from the LLM path, not Estimator.
  filter_replacement: { determinant: "engine", estimator_slug: null },
  coolant_flush: { determinant: "engine", estimator_slug: null },
  power_steering_flush: { determinant: "engine", estimator_slug: null },
  transmission_service: { determinant: "both", estimator_slug: null },
  differential_service: { determinant: "both", estimator_slug: null },
  brake_fluid_flush: { determinant: "chassis", estimator_slug: null },
};

/** Stamp labor_determinant + estimator_slug onto matching services rows. */
export const stampLaborServiceConfig = internalMutation({
  args: {},
  handler: async (ctx) => {
    const services = await ctx.db.query("services").collect();
    let stamped = 0;
    const unmapped: string[] = [];
    for (const svc of services) {
      const cfg = svc.slug ? LABOR_SERVICE_CONFIG[svc.slug] : undefined;
      if (!cfg) {
        if (svc.slug) unmapped.push(svc.slug);
        continue;
      }
      await ctx.db.patch(svc._id, {
        labor_determinant: cfg.determinant,
        estimator_slug: cfg.estimator_slug,
      });
      stamped++;
    }
    return { stamped, total: services.length, unmapped };
  },
});
