/**
 * directorConfigActions — admin mutations for the Vehicle Config modal.
 *
 * Edits the platform-level vehicle_configs row + supports marking a config
 * verified (bumps verification_count + last_verified_at — both already
 * fields on the table).
 */

import { mutation } from "./_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// updateConfigBasics — patch the edit-friendly fields on vehicle_configs
// ---------------------------------------------------------------------------

export const updateConfigBasics = mutation({
  args: {
    id:               v.id("vehicle_configs"),
    trim_name:        v.optional(v.string()),
    chassis_code:     v.optional(v.string()),
    drivetrain:       v.optional(v.string()),
    brake_fluid_type: v.optional(v.string()),
    ps_fluid_type:    v.optional(v.string()),
    enrichment_status: v.optional(v.string()),
    actorName:        v.string(),
    actorId:          v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const cfg = await ctx.db.get(args.id);
    if (!cfg) return { ok: false as const, reason: "config_not_found" };

    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const noop = (cur: unknown, nxt: unknown) => {
      const ce = cur == null || cur === "";
      const ne = nxt == null || nxt === "";
      if (ce && ne) return true;
      return cur === nxt;
    };
    const tryPatch = (key: string, label: string, nextVal: unknown) => {
      if (nextVal === undefined) return;
      const cur = (cfg as any)[key];
      if (noop(cur, nextVal)) return;
      patch[key] = nextVal;
      const before = cur == null || cur === "" ? "—" : String(cur);
      const after  = nextVal == null || nextVal === "" ? "—" : String(nextVal);
      changes.push(`${label}: ${before} → ${after}`);
    };

    tryPatch("trim_name",         "trim_name",         args.trim_name);
    tryPatch("chassis_code",      "chassis_code",      args.chassis_code);
    tryPatch("drivetrain",        "drivetrain",        args.drivetrain);
    tryPatch("brake_fluid_type",  "brake_fluid_type",  args.brake_fluid_type);
    tryPatch("ps_fluid_type",     "ps_fluid_type",     args.ps_fluid_type);
    tryPatch("enrichment_status", "enrichment_status", args.enrichment_status);

    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };

    await ctx.db.patch(args.id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id:   String(args.id),
      action:      "field_edit",
      actor:       args.actorName,
      actor_id:    args.actorId,
      detail:      `Config updated · ${changes.join(", ")}`,
      created_at:  Date.now(),
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// ---------------------------------------------------------------------------
// Shared "patch only the fields the caller actually changed" helper.
// Empty string ↔ null/undefined is treated as "no change" so opening a form
// and hitting Save without typing doesn't trigger phantom audit rows.
// ---------------------------------------------------------------------------

const noop = (cur: unknown, nxt: unknown) => {
  const ce = cur == null || cur === "";
  const ne = nxt == null || nxt === "";
  if (ce && ne) return true;
  return cur === nxt;
};

function buildPatch<T extends Record<string, unknown>>(
  current: T,
  candidates: Array<[keyof T & string, unknown]>,
): { patch: Record<string, unknown>; changes: string[] } {
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  for (const [key, nxt] of candidates) {
    if (nxt === undefined) continue;
    const cur = current[key];
    if (noop(cur, nxt)) continue;
    patch[key] = nxt;
    const before = cur == null || cur === "" ? "—" : String(cur);
    const after  = nxt == null || nxt === "" ? "—" : String(nxt);
    changes.push(`${key}: ${before} → ${after}`);
  }
  return { patch, changes };
}

// ---------------------------------------------------------------------------
// updateEngineFields
// ---------------------------------------------------------------------------

export const updateEngineFields = mutation({
  args: {
    id:                       v.id("engines"),
    engine_code:              v.optional(v.string()),
    engine_family:            v.optional(v.string()),
    configuration:            v.optional(v.string()),
    cylinders:                v.optional(v.number()),
    displacement_l:           v.optional(v.number()),
    aspiration:               v.optional(v.string()),
    fuel_type:                v.optional(v.string()),
    fuel_injection:           v.optional(v.string()),
    timing_system:            v.optional(v.string()),
    oil_viscosity:            v.optional(v.string()),
    oil_capacity_qts:         v.optional(v.number()),
    coolant_type:             v.optional(v.string()),
    coolant_capacity_qts:     v.optional(v.number()),
    spark_plug_quantity:      v.optional(v.number()),
    spark_plug_gap_mm:        v.optional(v.number()),
    water_pump_timing_driven: v.optional(v.boolean()),
    data_quality:             v.optional(v.string()),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "engine_not_found" };
    const { patch, changes } = buildPatch(cur as any, Object.entries(fields) as Array<[string, unknown]>);
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    await ctx.db.patch(id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "engine", entity_id: String(id), action: "field_edit",
      actor: actorName, actor_id: actorId,
      detail: `Engine updated · ${changes.join(", ")}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// ---------------------------------------------------------------------------
// updateTransmissionFields
// ---------------------------------------------------------------------------

export const updateTransmissionFields = mutation({
  args: {
    id:                       v.id("transmissions"),
    transmission_type:        v.optional(v.string()),
    code:                     v.optional(v.string()),
    speeds:                   v.optional(v.number()),
    manufacturer:             v.optional(v.string()),
    fluid_type:               v.optional(v.string()),
    fluid_capacity_drain_fill_qts: v.optional(v.number()),
    is_lifetime_fill:         v.optional(v.boolean()),
    has_serviceable_filter:   v.optional(v.boolean()),
    service_method:           v.optional(v.string()),
    data_quality:             v.optional(v.string()),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "transmission_not_found" };
    const { patch, changes } = buildPatch(cur as any, Object.entries(fields) as Array<[string, unknown]>);
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    await ctx.db.patch(id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "transmission", entity_id: String(id), action: "field_edit",
      actor: actorName, actor_id: actorId,
      detail: `Transmission updated · ${changes.join(", ")}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// ---------------------------------------------------------------------------
// updateChassisSpecsFields — patches by chassis_code (1 row per code)
// ---------------------------------------------------------------------------

export const updateChassisSpecsFields = mutation({
  args: {
    chassis_code:                  v.string(),
    brake_fluid_type:              v.optional(v.string()),
    brake_fluid_capacity_oz:       v.optional(v.number()),
    ps_fluid_type:                 v.optional(v.string()),
    ps_fluid_capacity_oz:          v.optional(v.number()),
    lug_nut_torque_ft_lbs:         v.optional(v.number()),
    wiper_blade_driver_size_in:    v.optional(v.number()),
    wiper_blade_passenger_size_in: v.optional(v.number()),
    wiper_blade_rear_size_in:      v.optional(v.number()),
    battery_group:                 v.optional(v.string()),
    battery_type:                  v.optional(v.string()),
    battery_location:              v.optional(v.string()),
    has_brake_pad_sensor:          v.optional(v.boolean()),
    steering_type:                 v.optional(v.string()),
    parking_brake_type:            v.optional(v.string()),
    has_rear_wiper:                v.optional(v.boolean()),
    data_quality:                  v.optional(v.string()),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { chassis_code, actorName, actorId, ...fields }) => {
    let row = await ctx.db
      .query("chassis_specs")
      .withIndex("by_chassis_code", (q) => q.eq("chassis_code", chassis_code))
      .unique();
    if (!row) {
      // Create the row if it doesn't exist yet.
      const id = await ctx.db.insert("chassis_specs", {
        chassis_code,
        created_at: Date.now(),
      });
      row = (await ctx.db.get(id))!;
    }
    const { patch, changes } = buildPatch(row as any, Object.entries(fields) as Array<[string, unknown]>);
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    await ctx.db.patch(row._id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "chassis_specs", entity_id: String(row._id), action: "field_edit",
      actor: actorName, actor_id: actorId,
      detail: `Chassis specs (${chassis_code}) updated · ${changes.join(", ")}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// ---------------------------------------------------------------------------
// updateTrimSpecsFields — patches by vehicle_config_id (1 row per config)
// ---------------------------------------------------------------------------

export const updateTrimSpecsFields = mutation({
  args: {
    vehicle_config_id:                   v.id("vehicle_configs"),
    tire_size_front:                     v.optional(v.string()),
    tire_size_rear:                      v.optional(v.string()),
    recommended_tire_pressure_front_psi: v.optional(v.number()),
    recommended_tire_pressure_rear_psi:  v.optional(v.number()),
    is_staggered:                        v.optional(v.boolean()),
    tire_directional:                    v.optional(v.boolean()),
    is_run_flat:                         v.optional(v.boolean()),
    alignment_type:                      v.optional(v.string()),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { vehicle_config_id, actorName, actorId, ...fields }) => {
    let row = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicle_config_id))
      .first();
    if (!row) {
      const id = await ctx.db.insert("trim_specs", {
        vehicle_config_id,
      });
      row = (await ctx.db.get(id))!;
    }
    const { patch, changes } = buildPatch(row as any, Object.entries(fields) as Array<[string, unknown]>);
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    await ctx.db.patch(row._id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "trim_specs", entity_id: String(row._id), action: "field_edit",
      actor: actorName, actor_id: actorId,
      detail: `Trim specs updated · ${changes.join(", ")}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// ---------------------------------------------------------------------------
// markConfigVerified — increment verification_count + set last_verified_at
// ---------------------------------------------------------------------------

export const markConfigVerified = mutation({
  args: {
    id:        v.id("vehicle_configs"),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId }) => {
    const cfg = await ctx.db.get(id);
    if (!cfg) return { ok: false as const, reason: "config_not_found" };
    const now = Date.now();
    await ctx.db.patch(id, {
      last_verified_at:   now,
      verification_count: (cfg.verification_count ?? 0) + 1,
    });
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id:   String(id),
      action:      "status_change",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Config marked verified (count → ${(cfg.verification_count ?? 0) + 1})`,
      created_at:  now,
    });
    return { ok: true as const, verifications: (cfg.verification_count ?? 0) + 1 };
  },
});
