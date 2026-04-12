import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * Determines if a service is applicable to a specific vehicle configuration
 * based on the service's structural applicability rules and the vehicle's
 * engine, generation, drivetrain, and trim specs.
 *
 * Pure function — no database calls, no side effects.
 */
export function isServiceApplicable(
  service: Doc<"services">,
  engine: Doc<"engines">,
  generation: Doc<"generations"> | null,
  drivetrainConfig: Doc<"drivetrain_configs"> | null,
  trimSpecs: Doc<"trim_specs"> | null,
  vehicleConfig: Doc<"vehicle_configs">
): boolean {
  // 1. ICE-only services don't apply to EVs
  if (service.requires_ice_engine === true && engine.fuel_type === "electric") {
    return false;
  }

  // 2. Timing belt services only apply to belt engines
  if (service.requires_timing_belt === true && engine.timing_system !== "belt") {
    return false;
  }

  // 3. Hydraulic PS services don't apply to electric steering
  if (
    service.requires_hydraulic_ps === true &&
    generation?.steering_type === "electric"
  ) {
    return false;
  }

  // 4. Differential services require a serviceable differential
  if (
    service.requires_differential === true &&
    drivetrainConfig?.has_differential !== true
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

  // 6. OBD-II dependent services require min model year
  if (
    service.min_model_year !== undefined &&
    vehicleConfig.year < service.min_model_year
  ) {
    return false;
  }

  // 7. All checks passed
  return true;
}

/**
 * Returns all services applicable to a given vehicle config.
 * Loads the vehicle's related entities (engine, generation, drivetrain, trim specs)
 * and filters the full service list through applicability rules.
 */
export async function getApplicableServices(
  ctx: QueryCtx,
  vehicleConfigId: Id<"vehicle_configs">
): Promise<Doc<"services">[]> {
  const vehicleConfig = await ctx.db.get(vehicleConfigId);
  if (!vehicleConfig) {
    return [];
  }

  // Load related entities in parallel
  const [engine, generation, drivetrainConfig, trimSpecs, allServices] =
    await Promise.all([
      ctx.db.get(vehicleConfig.engine_id),
      vehicleConfig.generation_id
        ? ctx.db.get(vehicleConfig.generation_id)
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

  return allServices.filter((service) =>
    isServiceApplicable(
      service,
      engine,
      generation,
      drivetrainConfig,
      trimSpecs,
      vehicleConfig
    )
  );
}
