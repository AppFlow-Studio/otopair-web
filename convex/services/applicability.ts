import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * Determines if a service is applicable to a specific vehicle configuration
 * based on the service's structural applicability rules and the vehicle's
 * engine, chassis_specs, drivetrain, and trim specs.
 *
 * Pure function — no database calls, no side effects.
 */
export function isServiceApplicable(
  service: Doc<"services">,
  engine: Doc<"engines">,
  chassisSpecs: Doc<"chassis_specs"> | null,
  drivetrainConfig: Doc<"drivetrain_configs"> | null,
  trimSpecs: Doc<"trim_specs"> | null,
  vehicleConfig: Doc<"vehicle_configs">
): boolean {
  // 1. ICE-only services don't apply to EVs. NHTSA vPIC writes "Electric"
  // (capitalized) — compare case-insensitively (Jun-9 review: the lowercase
  // literal never fired). Exact match is deliberate: "Plug-in Hybrid
  // Electric" / "Hybrid Electric" still HAVE an ICE.
  if (
    service.requires_ice_engine === true &&
    (engine.fuel_type ?? "").toLowerCase() === "electric"
  ) {
    return false;
  }

  // 2. Timing belt services only apply to belt engines. Gate ONLY when the
  // timing system is actually known — null/undefined must fail OPEN (the
  // enrichment seeding in v3mutations gates positively on "chain" the same
  // way; a car with unknown timing data keeps the service bookable so the
  // user retains recourse).
  if (
    service.requires_timing_belt === true &&
    engine.timing_system != null &&
    engine.timing_system !== "belt"
  ) {
    return false;
  }

  // 3. Hydraulic PS services don't apply to electric steering
  // (case-insensitive — same NHTSA/VDB capitalization hazard as rule 1).
  if (
    service.requires_hydraulic_ps === true &&
    (chassisSpecs?.steering_type ?? "").toLowerCase() === "electric"
  ) {
    return false;
  }

  // 4. Differential services require a serviceable differential. Exclude
  // only on a POSITIVE "no differential" — a missing drivetrain row or
  // unset flag fails open (consistent with every other rule here).
  if (
    service.requires_differential === true &&
    drivetrainConfig != null &&
    drivetrainConfig.has_differential === false
  ) {
    return false;
  }

  // 5. Tire rotation not possible if staggered AND directional
  if (
    service.requires_rotatable_tires === true &&
    trimSpecs?.is_staggered === true &&
    trimSpecs?.tire_directional === true
  ) {
    return false;
  }

  // 6. OBD-II dependent services require min model year. A missing year
  // must fail open (null < N coerces null→0 and would exclude everything).
  if (
    service.min_model_year !== undefined &&
    vehicleConfig.year != null &&
    vehicleConfig.year < service.min_model_year
  ) {
    return false;
  }

  // 7. All checks passed
  return true;
}

/**
 * Returns all services applicable to a given vehicle config.
 * Loads chassis_specs by chassis_code (single source of truth for platform
 * structural attributes — replaces the retired `generations` table).
 */
export async function getApplicableServices(
  ctx: QueryCtx,
  vehicleConfigId: Id<"vehicle_configs">
): Promise<Doc<"services">[]> {
  const vehicleConfig = await ctx.db.get(vehicleConfigId);
  if (!vehicleConfig) {
    return [];
  }

  const [engine, chassisSpecs, drivetrainConfig, trimSpecs, allServices] =
    await Promise.all([
      vehicleConfig.engine_id ? ctx.db.get(vehicleConfig.engine_id) : null,
      vehicleConfig.chassis_code
        ? ctx.db
            .query("chassis_specs")
            .withIndex("by_chassis_code", (q) =>
              q.eq("chassis_code", vehicleConfig.chassis_code!)
            )
            .first()
        : null,
      ctx.db
        .query("drivetrain_configs")
        .withIndex("by_vehicle_config", (q) =>
          q.eq("vehicle_config_id", vehicleConfigId)
        )
        .first(),
      ctx.db
        .query("trim_specs")
        .withIndex("by_vehicle_config", (q) =>
          q.eq("vehicle_config_id", vehicleConfigId)
        )
        .first(),
      ctx.db.query("services").collect(),
    ]);

  if (!engine) {
    return [];
  }

  return allServices.filter((service: Doc<"services">) =>
    isServiceApplicable(
      service,
      engine,
      chassisSpecs,
      drivetrainConfig,
      trimSpecs,
      vehicleConfig
    )
  );
}
