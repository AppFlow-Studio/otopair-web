/**
 * directorConfigActions — admin mutations for the Vehicle Config modal.
 *
 * Edits the platform-level vehicle_configs row + supports marking a config
 * verified (bumps verification_count + last_verified_at — both already
 * fields on the table).
 *
 * AUTH (hardened Jun 10 2026, the deferred sweep from the Jun-9 security
 * commit): every mutation validates a director session token server-side
 * (director_sessions lookup in the same transaction) and derives the audit
 * actor FROM the session. The old convention (public mutations trusting
 * caller-supplied actorName/actorId) let any anonymous caller edit platform
 * vehicle data and forge audit attribution. Mirrors requireDirector in
 * directorConfigBackfills.ts (which gates ACTIONS via
 * api.director_auth.validateSession — mutations have ctx.db, so the lookup
 * is direct and transactional here).
 */

import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireDirector, logAudit } from "./directorGate";
import { writeMechanicVerifiedFitment } from "./fitments";
import { FIELD_SPECS, type FieldTarget } from "./lib/reviewFieldMap";
import type { Id } from "./_generated/dataModel";

/** Director session token arg — localStorage `otopair_director_token`. */
const tokenArg = {
  token: v.string(),
} as const;

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
    ...tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "data.write");
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
      actor:       actor.name,
      actor_id:    actor.userId,
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
    ...tokenArg,
  },
  handler: async (ctx, { id, token, ...fields }) => {
    const actor = await requireDirector(ctx, token, "data.write");
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "engine_not_found" };
    const { patch, changes } = buildPatch(cur as any, Object.entries(fields) as Array<[string, unknown]>);
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    // Director-corrected fields are authoritative: stamp them verified so the
    // enrichment pipeline can't write over them on the next re-enrich.
    const verified = new Set(((cur as any).verified_fields ?? []) as string[]);
    const changedCount = Object.keys(patch).length;
    for (const key of Object.keys(patch)) verified.add(key);
    (patch as any).verified_fields = [...verified];
    await ctx.db.patch(id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "engine", entity_id: String(id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
      detail: `Engine updated · ${changes.join(", ")}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: changedCount };
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
    ...tokenArg,
  },
  handler: async (ctx, { id, token, ...fields }) => {
    const actor = await requireDirector(ctx, token, "data.write");
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "transmission_not_found" };
    const { patch, changes } = buildPatch(cur as any, Object.entries(fields) as Array<[string, unknown]>);
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    await ctx.db.patch(id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "transmission", entity_id: String(id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
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
    ...tokenArg,
  },
  handler: async (ctx, { chassis_code, token, ...fields }) => {
    const actor = await requireDirector(ctx, token, "data.write");
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
      actor: actor.name, actor_id: actor.userId,
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
    ...tokenArg,
  },
  handler: async (ctx, { vehicle_config_id, token, ...fields }) => {
    const actor = await requireDirector(ctx, token, "data.write");
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
      actor: actor.name, actor_id: actor.userId,
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
    id: v.id("vehicle_configs"),
    ...tokenArg,
  },
  handler: async (ctx, { id, token }) => {
    const actor = await requireDirector(ctx, token, "data.write");
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
      actor:       actor.name,
      actor_id:    actor.userId,
      detail:      `Config marked verified (count → ${(cfg.verification_count ?? 0) + 1})`,
      created_at:  now,
    });
    return { ok: true as const, verifications: (cfg.verification_count ?? 0) + 1 };
  },
});

// ---------------------------------------------------------------------------
// addConfigFitment — director inputs a missing OEM part for a gap service so
// that service becomes available on this config (e.g. the 2001 740iA battery
// dropped by OEM-strict enrichment). Writes a mechanic_verified fitment and
// clears any "not applicable" exclusion.
// ---------------------------------------------------------------------------

export const addConfigFitment = mutation({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    serviceSlug: v.string(),
    roleKey: v.string(),
    oemNumber: v.string(),
    partName: v.optional(v.string()),
    quantityNeeded: v.optional(v.number()),
    position: v.optional(v.string()),
    ...tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token);
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return { ok: false as const, reason: "config_not_found" };

    const serviceType = args.serviceSlug.replace(/-/g, "_");
    const now = Date.now();

    const { partId } = await writeMechanicVerifiedFitment(ctx, {
      configId: args.vehicleConfigId,
      configMakeId: (config as any).make_id ?? null,
      serviceType,
      roleKey: args.roleKey,
      mode: "freehand",
      oemNumber: args.oemNumber,
      partName: args.partName,
      quantityNeeded: args.quantityNeeded,
      position: args.position,
      now,
    });

    // Re-adding a part supersedes any "not applicable" mark.
    const exclusions = await ctx.db
      .query("config_service_exclusions")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicleConfigId)
          .eq("service_slug", serviceType),
      )
      .collect();
    for (const e of exclusions) await ctx.db.delete(e._id);

    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config",
      entity_id: String(args.vehicleConfigId),
      action: "status_change",
      actor: actor.name,
      actor_id: actor.userId,
      detail: `Added ${serviceType} part ${args.oemNumber} (${args.roleKey})`,
      created_at: now,
    });

    return { ok: true as const, partId };
  },
});

// ---------------------------------------------------------------------------
// addManualPartPrice — director-entered price for a part with no trusted
// quote. Stored with price_type "manual_seed" (the schema's existing
// human-entered tier — see lib/priceTypes.ts) and source_domain stamped with
// the acting director, so it reads in part_prices exactly like any other
// trusted row while staying traceable to who typed it in and when. A source
// link (where the director found this price — a dealer/retailer listing) is
// REQUIRED and stored on the row's own source_url column, not just buried in
// the audit log, so the price is traceable from part_prices alone. audit_log
// carries the authoritative who/when/source on top of that.
// ---------------------------------------------------------------------------

export const addManualPartPrice = mutation({
  args: {
    partId: v.id("oem_parts"),
    price: v.number(),
    sourceUrl: v.string(),
    ...tokenArg,
  },
  handler: async (ctx, { partId, price, sourceUrl, token }) => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (!Number.isFinite(price) || price <= 0) return { ok: false as const, reason: "invalid_price" };
    const trimmedSource = sourceUrl.trim();
    if (!trimmedSource) return { ok: false as const, reason: "source_url_required" };
    if (!isValidSourceUrl(trimmedSource)) return { ok: false as const, reason: "invalid_source_url" };
    const part = await ctx.db.get(partId);
    if (!part) return { ok: false as const, reason: "part_not_found" };
    const now = Date.now();
    const priceId = await ctx.db.insert("part_prices", {
      part_id: partId,
      price,
      price_type: "manual_seed",
      source_domain: `director_manual:${actor.name}`,
      source_url: trimmedSource,
      refreshed_at: now,
      created_at: now,
    });
    await ctx.db.insert("audit_log", {
      entity_type: "oem_parts",
      entity_id: String(partId),
      action: "field_edit",
      actor: actor.name,
      actor_id: actor.userId,
      detail: `Manual price added for ${part.name} (${part.oem_part_number}) · $${price.toFixed(2)} — source: ${trimmedSource}`,
      created_at: now,
    });
    return { ok: true as const, priceId };
  },
});

// ---------------------------------------------------------------------------
// resolveReviewField — the per-field action behind the review-resolve modal:
// either APPROVE a flagged value as-is (no data change; engine-backed fields
// still get stamped into verified_fields so the next re-enrich can't clobber
// a value a director just confirmed), or ADJUST it to a corrected value.
// Field → storage mapping lives in lib/reviewFieldMap.ts (shared with the
// context query that shows the review-resolve modal its "current value").
// ---------------------------------------------------------------------------

async function upsertByVehicleConfig(
  ctx: MutationCtx,
  table: "trim_specs" | "drivetrain_configs",
  vehicleConfigId: Id<"vehicle_configs">,
) {
  const existing = await ctx.db
    .query(table)
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", vehicleConfigId))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert(table, { vehicle_config_id: vehicleConfigId } as any);
  return (await ctx.db.get(id))!;
}

async function upsertChassisSpecs(ctx: any, chassisCode: string) {
  const existing = await ctx.db
    .query("chassis_specs")
    .withIndex("by_chassis_code", (q: any) => q.eq("chassis_code", chassisCode))
    .unique();
  if (existing) return existing;
  const id = await ctx.db.insert("chassis_specs", { chassis_code: chassisCode, created_at: Date.now() });
  return (await ctx.db.get(id))!;
}

/** Basic sanity check for a director-supplied source URL — must parse as an
 *  absolute http(s) URL. Not a reachability check, just "is this a link at
 *  all" so a director can't wave the requirement through with junk text. */
function isValidSourceUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** vehicle_configs column → axle, for the rotor-minimum provenance stamp.
 *  Note both axles share one rotor_min_source_url: the most recent authority
 *  wins there, while the per-axle *_min_quality badges stay independent. */
const ROTOR_MIN_COLUMN_AXLE: Record<string, "front" | "rear" | undefined> = {
  rotor_front_min_thickness_mm: "front",
  rotor_rear_min_thickness_mm: "rear",
};

/** Apply one field target's write + its own audit_log row. Returns the
 *  before/after label for the caller's summary, or null when it was a no-op. */
async function applyFieldTarget(
  ctx: any,
  cfg: any,
  target: FieldTarget,
  parsedValue: number | string,
  actor: { name: string; userId: Id<"director_users"> },
  sourceUrl: string,
): Promise<string | null> {
  const now = Date.now();
  const src = ` — source: ${sourceUrl}`;
  if (target.t === "engine") {
    if (!cfg.engine_id) throw new Error("This config has no linked engine to edit.");
    const engine = await ctx.db.get(cfg.engine_id);
    if (!engine) throw new Error("Linked engine not found.");
    const cur = (engine as any)[target.col];
    if (cur === parsedValue) return null;
    const verified = new Set(((engine as any).verified_fields ?? []) as string[]);
    verified.add(target.col);
    await ctx.db.patch(cfg.engine_id, { [target.col]: parsedValue, verified_fields: [...verified] } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "engine", entity_id: String(cfg.engine_id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
      detail: `${target.col}: ${cur ?? "—"} → ${parsedValue} (review resolution)${src}`,
      created_at: now,
    });
    return `${target.col}: ${cur ?? "—"} → ${parsedValue}`;
  }
  if (target.t === "transmission") {
    if (!cfg.transmission_id) throw new Error("This config has no linked transmission to edit.");
    const trans = await ctx.db.get(cfg.transmission_id);
    if (!trans) throw new Error("Linked transmission not found.");
    const cur = (trans as any)[target.col];
    if (cur === parsedValue) return null;
    await ctx.db.patch(cfg.transmission_id, { [target.col]: parsedValue } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "transmission", entity_id: String(cfg.transmission_id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
      detail: `${target.col}: ${cur ?? "—"} → ${parsedValue} (review resolution)${src}`,
      created_at: now,
    });
    return `${target.col}: ${cur ?? "—"} → ${parsedValue}`;
  }
  if (target.t === "vehicle_config") {
    const cur = (cfg as any)[target.col];
    if (cur === parsedValue) return null;
    // Stamp the column as human-verified so the pipeline's patchVehicleConfig
    // skips it on the next finalize. Without this the correction is silently
    // overwritten — which is exactly what happened to drivetrain /
    // brake_fluid_capacity_oz / ps_fluid_capacity_oz before the guard existed.
    const verified = new Set(((cfg as any).verified_fields ?? []) as string[]);
    verified.add(target.col);
    const patch: Record<string, unknown> = { [target.col]: parsedValue };
    // A rotor minimum a director confirmed against a source outranks any
    // scrape, and carries its provenance so the inspection grades it as real
    // rather than as an estimate. Only the VERIFIED AXLE's observed label is
    // cleared (the value is now attested by a human, not read off a page) —
    // the other axle's scrape provenance must survive. The legacy shared
    // label is cleared too: after a human verification it no longer reliably
    // describes either axle.
    const rotorAxle = ROTOR_MIN_COLUMN_AXLE[target.col];
    if (rotorAxle) {
      patch[`rotor_${rotorAxle}_min_quality`] = "director_verified";
      patch.rotor_min_source_url = sourceUrl;
      patch[`rotor_${rotorAxle}_min_observed_label`] = undefined;
      patch.rotor_min_observed_label = undefined;
      verified.add(`rotor_${rotorAxle}_min_quality`);
    }
    patch.verified_fields = [...verified];
    await ctx.db.patch(cfg._id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config", entity_id: String(cfg._id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
      detail: `${target.col}: ${cur ?? "—"} → ${parsedValue} (review resolution)${src}`,
      created_at: now,
    });
    return `${target.col}: ${cur ?? "—"} → ${parsedValue}`;
  }
  if (target.t === "chassis_specs") {
    if (!cfg.chassis_code) throw new Error("This config has no chassis code resolved yet.");
    const row = await upsertChassisSpecs(ctx, cfg.chassis_code);
    const cur = (row as any)[target.col];
    if (cur === parsedValue) return null;
    await ctx.db.patch(row._id, { [target.col]: parsedValue } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "chassis_specs", entity_id: String(row._id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
      detail: `${target.col}: ${cur ?? "—"} → ${parsedValue} (review resolution, ${cfg.chassis_code})${src}`,
      created_at: now,
    });
    return `${target.col}: ${cur ?? "—"} → ${parsedValue}`;
  }
  if (target.t === "trim_specs") {
    const row = await upsertByVehicleConfig(ctx, "trim_specs", cfg._id);
    const cur = (row as any)[target.col];
    if (cur === parsedValue) return null;
    await ctx.db.patch(row._id, { [target.col]: parsedValue } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "trim_specs", entity_id: String(row._id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
      detail: `${target.col}: ${cur ?? "—"} → ${parsedValue} (review resolution)${src}`,
      created_at: now,
    });
    return `${target.col}: ${cur ?? "—"} → ${parsedValue}`;
  }
  if (target.t === "drivetrain_config") {
    const row = await upsertByVehicleConfig(ctx, "drivetrain_configs", cfg._id);
    const cur = (row as any)[target.col];
    if (cur === parsedValue) return null;
    await ctx.db.patch(row._id, { [target.col]: parsedValue } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "drivetrain_configs", entity_id: String(row._id), action: "field_edit",
      actor: actor.name, actor_id: actor.userId,
      detail: `${target.col}: ${cur ?? "—"} → ${parsedValue} (review resolution)${src}`,
      created_at: now,
    });
    return `${target.col}: ${cur ?? "—"} → ${parsedValue}`;
  }
  // service_interval
  const svc = await ctx.db
    .query("services")
    .withIndex("by_slug", (q: any) => q.eq("slug", target.slug))
    .first();
  if (!svc) throw new Error(`No service found for slug "${target.slug}".`);
  let row = await ctx.db
    .query("service_intervals")
    .withIndex("by_config_service", (q: any) => q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id))
    .first();
  const col = target.unit === "miles" ? "interval_miles" : "interval_months";
  const cur = row ? (row as any)[col] : undefined;
  if (cur === parsedValue) return null;
  if (!row) {
    const id = await ctx.db.insert("service_intervals", {
      vehicle_config_id: cfg._id, service_id: svc._id, [col]: parsedValue, mechanic_verified: true,
    } as any);
    row = (await ctx.db.get(id))!;
  } else {
    await ctx.db.patch(row._id, { [col]: parsedValue, mechanic_verified: true } as any);
  }
  await ctx.db.insert("audit_log", {
    entity_type: "service_intervals", entity_id: String(row._id), action: "field_edit",
    actor: actor.name, actor_id: actor.userId,
    detail: `${svc.name} ${target.unit}: ${cur ?? "—"} → ${parsedValue} (review resolution)${src}`,
    created_at: now,
  });
  return `${svc.name} ${target.unit}: ${cur ?? "—"} → ${parsedValue}`;
}

export const resolveReviewField = mutation({
  args: {
    token: v.string(),
    vehicleConfigId: v.id("vehicle_configs"),
    field: v.string(),
    action: v.union(v.literal("approve"), v.literal("adjust")),
    value: v.optional(v.string()),
    // Required for BOTH approve and adjust — a director confirming or
    // correcting a value must point at where they verified it (owner's
    // manual page, OEM catalog, etc.), so the audit trail shows not just
    // who/when but what they checked against.
    sourceUrl: v.string(),
  },
  handler: async (ctx, { token, vehicleConfigId, field, action, value, sourceUrl }) => {
    const actor = await requireDirector(ctx, token, "data.write");
    const trimmedSource = sourceUrl.trim();
    if (!trimmedSource) return { ok: false as const, reason: "source_url_required" };
    if (!isValidSourceUrl(trimmedSource)) return { ok: false as const, reason: "invalid_source_url" };
    const cfg = await ctx.db.get(vehicleConfigId);
    if (!cfg) return { ok: false as const, reason: "config_not_found" };
    const spec = FIELD_SPECS[field];
    if (!spec) return { ok: false as const, reason: "field_not_editable" };

    if (action === "approve") {
      // No value change — just protect engine-backed fields from being
      // overwritten by the next re-enrich, same as a manual engine edit does.
      let stamped = false;
      for (const target of spec.targets) {
        if (target.t === "engine" && cfg.engine_id) {
          const engine = await ctx.db.get(cfg.engine_id);
          if (engine) {
            const verified = new Set(((engine as any).verified_fields ?? []) as string[]);
            if (!verified.has(target.col)) {
              verified.add(target.col);
              await ctx.db.patch(cfg.engine_id, { verified_fields: [...verified] } as any);
              stamped = true;
            }
          }
        }
      }
      await ctx.db.insert("audit_log", {
        entity_type: "vehicle_config", entity_id: String(vehicleConfigId), action: "status_change",
        actor: actor.name, actor_id: actor.userId,
        detail: `Confirmed "${field}" correct as-is (review resolution) — source: ${trimmedSource}`,
        created_at: Date.now(),
      });
      return { ok: true as const, changed: stamped };
    }

    // adjust
    if (value === undefined || value.trim() === "") return { ok: false as const, reason: "value_required" };
    const parsedValue: number | string =
      spec.valueType === "number" ? Number(value) : value.trim();
    if (spec.valueType === "number" && !Number.isFinite(parsedValue as number)) {
      return { ok: false as const, reason: "invalid_number" };
    }
    const summaries: string[] = [];
    for (const target of spec.targets) {
      const summary = await applyFieldTarget(ctx, cfg, target, parsedValue, actor, trimmedSource);
      if (summary) summaries.push(summary);
    }
    return { ok: true as const, changed: summaries.length > 0, summary: summaries.join("; ") };
  },
});

// ---------------------------------------------------------------------------
// correctWrongPart — the three actions behind the Wrong Parts drawer
// (directorPartQuality.scanWrongParts). Deliberately three DIFFERENT data
// effects, not one:
//   - approve: mechanic_verified = true — "I checked, this IS correct."
//     Trusted for quoting from now on, same as any other verified fitment.
//   - dismiss: flag_dismissed_at stamped only — "not fixing this right now,
//     stop showing it to me" WITHOUT claiming it's correct. Quote-time
//     selection is untouched; only the review scan excludes it.
//   - adjust: deletes the wrong fitment and writes a mechanic_verified
//     replacement via the same writer the pre-job "Add part" flow uses, so
//     the wrong part stops being a competing candidate at all.
// ---------------------------------------------------------------------------

export const correctWrongPart = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    fitmentId: v.id("part_fitments"),
    action: v.union(v.literal("approve"), v.literal("dismiss"), v.literal("adjust")),
    oemNumber: v.optional(v.string()),
    partName: v.optional(v.string()),
  },
  handler: async (ctx, { token, reason, fitmentId, action, oemNumber, partName }) => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) return { ok: false as const, reason: "reason_required" };
    const fitment = await ctx.db.get(fitmentId);
    if (!fitment) return { ok: false as const, reason: "fitment_not_found" };
    const part = await ctx.db.get(fitment.part_id);
    const label = part ? `${part.oem_part_number} (${part.name})` : String(fitment.part_id);
    const now = Date.now();

    if (action === "approve") {
      await ctx.db.patch(fitmentId, { mechanic_verified: true, confidence: 1, data_quality: "mechanic_verified" });
      await logAudit(ctx, actor, {
        entity_type: "part_fitments", entity_id: String(fitmentId), action: "approved_as_correct",
        detail: `${label}: confirmed correct despite the wrong-part flag — ${reason.trim()}`,
      });
      return { ok: true as const };
    }

    if (action === "dismiss") {
      await ctx.db.patch(fitmentId, {
        flag_dismissed_at: now, flag_dismissed_by: actor.name, flag_dismissed_by_id: actor.userId,
      });
      await logAudit(ctx, actor, {
        entity_type: "part_fitments", entity_id: String(fitmentId), action: "flag_dismissed",
        detail: `${label}: wrong-part flag dismissed (not marked correct) — ${reason.trim()}`,
      });
      return { ok: true as const };
    }

    // adjust
    const raw = (oemNumber ?? "").trim();
    if (!raw) return { ok: false as const, reason: "oem_number_required" };
    if (!fitment.service_type) return { ok: false as const, reason: "fitment_has_no_service_type" };
    const cfg = await ctx.db.get(fitment.vehicle_config_id);
    if (!cfg) return { ok: false as const, reason: "config_not_found" };
    const roleKey = part?.subcategory ?? fitment.service_type;

    const { partId: newPartId, oemNumber: newOem } = await writeMechanicVerifiedFitment(ctx, {
      configId: fitment.vehicle_config_id,
      configMakeId: cfg.make_id ?? null,
      serviceType: fitment.service_type,
      roleKey,
      mode: "freehand",
      oemNumber: raw,
      partName: partName?.trim() || undefined,
      quantityNeeded: fitment.quantity_needed,
      position: fitment.position,
      now,
    });
    // The wrong fitment is superseded, not just outranked — delete it so it
    // can never win arbitration again.
    await ctx.db.delete(fitmentId);
    await logAudit(ctx, actor, {
      entity_type: "part_fitments", entity_id: String(fitmentId), action: "adjusted_wrong_part",
      detail: `${label} → ${newOem} (${String(newPartId)}) — ${reason.trim()}`,
    });
    return { ok: true as const, newPartId: String(newPartId) };
  },
});
