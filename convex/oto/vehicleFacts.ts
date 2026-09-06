// =============================================================================
// Oto AI — Vehicle Facts query
// =============================================================================
//
// Backs the `get_vehicle_facts` AI tool. Returns the specs Oto needs to
// answer "what kind of engine does my car have?", "what oil does it take?",
// "what tire pressure should I use?", etc.
//
// Joins:
//   vehicles → vehicle_config → engine, transmission, trim, model, make
//                            → trim_specs (tire fitment + pressures)
//
// `vehicle_id` arg is the Convex `vehicles._id` — same convention as
// get_vehicle_health and get_due_services. Identity comes from auth.
// =============================================================================

import { query, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isEvalTestMake } from "./evalTestFilter";
import { resolveVehicleByIdOrVin } from "./resolveVehicle";
import { resolveMileageForOwner } from "../lib/mileage";

export interface VehicleFactsResponse {
  display: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  mileage: number | null;
  engine: {
    displacement_l: number | null;
    cylinders: number | null;
    configuration: string | null;
    aspiration: string | null;
    fuel_type: string | null;
    fuel_injection: string | null;
    engine_code: string | null;
    oil_viscosity: string | null;
    oil_spec: string | null;
    oil_capacity_qts: number | null;
    coolant_type: string | null;
    coolant_capacity_qts: number | null;
    spark_plug_quantity: number | null;
    has_serpentine_belt: boolean | null;
    timing_type: string | null;
  };
  transmission: {
    type: string | null;
    speeds: number | null;
    code: string | null;
    fluid_type: string | null;
    fluid_capacity_qts: number | null;
  };
  drivetrain: string | null;
  tires: {
    size_front: string | null;
    size_rear: string | null;
    pressure_front_psi: number | null;
    pressure_rear_psi: number | null;
    is_staggered: boolean | null;
    is_run_flat: boolean | null;
    is_directional: boolean | null;
  };
  fluids: {
    brake_fluid_type: string | null;
    brake_fluid_capacity_oz: number | null;
    ps_fluid_type: string | null;
    ps_fluid_capacity_oz: number | null;
  };
}

/**
 * Core vehicle-facts logic, keyed by an explicit `userId`. Shared by the
 * public auth-scoped `getVehicleFacts` and the internal
 * `getVehicleFactsForUser` variant (used by the director simulation harness,
 * where the fabricated identity never reaches sub-queries). Behavior is
 * identical to the original handler — only the user-resolution step is
 * hoisted out; the VIN ownership check is preserved.
 */
async function _getVehicleFactsCore(
  ctx: QueryCtx,
  userId: Id<"users">,
  { vehicle_id }: { vehicle_id: string },
): Promise<VehicleFactsResponse> {
  // B-P3: accept VIN-or-id (the tool descriptions disagree; Haiku passes
  // either). resolveVehicleByIdOrVin never throws on a bad id.
  const vehicle = await resolveVehicleByIdOrVin(ctx, vehicle_id);
  if (!vehicle) throw new Error(`vehicle not found: ${vehicle_id}`);

  // Authorize: verify the user actually owns this VIN.
  const owner: Doc<"vehicle_owners"> | null = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) =>
      q.eq("vin", vehicle.vin).eq("user_id", userId),
    )
    .unique();
  if (!owner) throw new Error(`not authorized for vehicle ${vehicle_id}`);

    // Pull the joined rows in parallel where possible. config first since
    // others key off it.
    const config = vehicle.vehicle_config_id
      ? await ctx.db.get(vehicle.vehicle_config_id)
      : null;

    // Engine: try config.engine_id first, fall back to vehicle.engine_id.
    const engineId =
      (config?.engine_id as Id<"engines"> | undefined) ?? vehicle.engine_id;
    const transmissionId =
      (config?.transmission_id as Id<"transmissions"> | undefined) ?? vehicle.transmission_id;
    const trimId =
      (config as any)?.trim_id ?? vehicle.trim_id;

    const [engine, transmission, trim, makeRow, modelRow, trimSpec] =
      await Promise.all([
        engineId ? ctx.db.get(engineId) : Promise.resolve(null),
        transmissionId ? ctx.db.get(transmissionId) : Promise.resolve(null),
        trimId ? ctx.db.get(trimId as Id<"trims">) : Promise.resolve(null),
        config?.make_id ? ctx.db.get(config.make_id) : Promise.resolve(null),
        config?.model_id ? ctx.db.get(config.model_id) : Promise.resolve(null),
        // trim_specs is keyed by trim_id or vehicle_config_id; try both.
        // CRITICAL: use .withIndex (NOT .filter) — trim_specs is a big
        // enrichment-derived table; .filter forces a full table scan and
        // makes this query time out (~1s Convex query budget). The
        // by_trim and by_vehicle_config indexes are defined in schema.ts;
        // use them.
        (async () => {
          if (vehicle.vehicle_config_id) {
            const byCfg = await ctx.db
              .query("trim_specs")
              .withIndex("by_vehicle_config", (q: any) =>
                q.eq("vehicle_config_id", vehicle.vehicle_config_id),
              )
              .first();
            if (byCfg) return byCfg;
          }
          if (trimId) {
            return await ctx.db
              .query("trim_specs")
              .withIndex("by_trim", (q: any) => q.eq("trim_id", trimId))
              .first();
          }
          return null;
        })(),
      ]);

    // EvalTest sentinel: synthetic eval-fixture vehicles must never surface
    // to real users (Day 5 RAG Specialist — re-applied Day 8 via bash).
    if (isEvalTestMake(makeRow)) {
      throw new Error(`vehicle not found: ${vehicle_id}`);
    }

    // Display string — prefer joined make/model/trim, fall back to metadata.
    const meta = (vehicle.metadata ?? {}) as Record<string, unknown>;
    const make =
      (makeRow as any)?.name ??
      (typeof meta.make === "string" ? meta.make : null);
    const model =
      (modelRow as any)?.name ??
      (typeof meta.model === "string" ? meta.model : null);
    const trimName =
      (trim as any)?.name ??
      (typeof meta.trim === "string" ? meta.trim : null) ??
      (config?.trim_name ?? null);
    const year =
      vehicle.year ??
      (typeof meta.year === "number" ? meta.year : null);

    const displayParts = [year, make, model, trimName].filter(
      (v): v is string | number => v != null && v !== "",
    );
    const display = displayParts.length > 0
      ? displayParts.join(" ")
      : (owner.nickname || vehicle.vin);

    const e = (engine as any) ?? {};
    const t = (transmission as any) ?? {};
    const ts = (trimSpec as any) ?? {};

    // Current odometer resolved by recency across the two mileage stores, so the
    // fact Oto quotes matches what the app card and shop surfaces show.
    const resolvedMileage = (await resolveMileageForOwner(ctx, owner)).mileage;

    return {
      display,
      year: typeof year === "number" ? year : null,
      make: make ?? null,
      model: model ?? null,
      trim: trimName ?? null,
      mileage: resolvedMileage ?? null,
      engine: {
        displacement_l: e.displacement_l ?? null,
        cylinders: e.cylinders ?? null,
        configuration: e.configuration ?? null,
        aspiration: e.aspiration ?? null,
        fuel_type: e.fuel_type ?? null,
        fuel_injection: e.fuel_injection ?? null,
        engine_code: e.engine_code ?? null,
        oil_viscosity: e.oil_viscosity ?? null,
        oil_spec: e.oil_spec_standard ?? null,
        oil_capacity_qts: e.oil_capacity_qts ?? null,
        coolant_type: e.coolant_type ?? null,
        coolant_capacity_qts: e.coolant_capacity_qts ?? null,
        spark_plug_quantity: e.spark_plug_quantity ?? null,
        has_serpentine_belt: e.has_serpentine_belt ?? null,
        timing_type: e.timing_type ?? null,
      },
      transmission: {
        type: t.type ?? t.transmission_type ?? null,
        speeds: t.speeds ?? null,
        code: t.code ?? null,
        fluid_type: t.fluid_type ?? null,
        fluid_capacity_qts: t.fluid_capacity_drain_fill_qts ?? null,
      },
      drivetrain: config?.drivetrain ?? null,
      tires: {
        size_front: ts.tire_size_front ?? null,
        size_rear: ts.tire_size_rear ?? null,
        pressure_front_psi: ts.recommended_tire_pressure_front_psi ?? null,
        pressure_rear_psi: ts.recommended_tire_pressure_rear_psi ?? null,
        is_staggered: ts.is_staggered ?? null,
        is_run_flat: ts.is_run_flat ?? null,
        is_directional: ts.tire_directional ?? null,
      },
      fluids: {
        brake_fluid_type: config?.brake_fluid_type ?? null,
        brake_fluid_capacity_oz: config?.brake_fluid_capacity_oz ?? null,
        ps_fluid_type: config?.ps_fluid_type ?? null,
        ps_fluid_capacity_oz: config?.ps_fluid_capacity_oz ?? null,
      },
    };
}

export const getVehicleFacts = query({
  args: { vehicle_id: v.string() },
  handler: async (ctx, { vehicle_id }): Promise<VehicleFactsResponse> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");

    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found");

    return await _getVehicleFactsCore(ctx, user._id, { vehicle_id });
  },
});

/**
 * Internal-only variant: the acting user is passed explicitly instead of being
 * derived from auth. Used by the Oto chat action's tool callables under the
 * director simulation harness. NEVER expose `actingUserId` on the public query
 * — that would be an IDOR hole.
 */
export const getVehicleFactsForUser = internalQuery({
  args: { actingUserId: v.id("users"), vehicle_id: v.string() },
  handler: async (
    ctx,
    { actingUserId, vehicle_id },
  ): Promise<VehicleFactsResponse> => {
    return await _getVehicleFactsCore(ctx, actingUserId, { vehicle_id });
  },
});
