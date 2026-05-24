/**
 * directorVehicleActions — admin mutations for per-VIN Car modal.
 *
 * Additive to existing convex. No schema changes. Every mutation writes
 * to audit_log so directors can trace edits. All fields are optional;
 * pass only what changes.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// updateVehicleBasics — edit YMM + link IDs on the vehicles row
// ---------------------------------------------------------------------------

export const updateVehicleBasics = mutation({
  args: {
    id:                 v.id("vehicles"),
    year:               v.optional(v.number()),
    trim_id:            v.optional(v.union(v.id("trims"), v.null())),
    engine_id:          v.optional(v.union(v.id("engines"), v.null())),
    transmission_id:    v.optional(v.union(v.id("transmissions"), v.null())),
    chassis_id:         v.optional(v.union(v.id("chassis_variants"), v.null())),
    vehicle_config_id:  v.optional(v.union(v.id("vehicle_configs"), v.null())),
    image_url:          v.optional(v.string()),
    actorName:          v.string(),
    actorId:            v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const veh = await ctx.db.get(args.id);
    if (!veh) return { ok: false as const, reason: "vehicle_not_found" };

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
      const cur = (veh as any)[key];
      if (noop(cur, nextVal)) return;
      patch[key] = nextVal === null ? undefined : nextVal;
      const before = cur == null || cur === "" ? "—" : String(cur);
      const after  = nextVal == null || nextVal === "" ? "—" : String(nextVal);
      changes.push(`${label}: ${before} → ${after}`);
    };

    tryPatch("year",              "year",              args.year);
    tryPatch("trim_id",           "trim_id",           args.trim_id);
    tryPatch("engine_id",         "engine_id",         args.engine_id);
    tryPatch("transmission_id",   "transmission_id",   args.transmission_id);
    tryPatch("chassis_id",        "chassis_id",        args.chassis_id);
    tryPatch("vehicle_config_id", "vehicle_config_id", args.vehicle_config_id);
    tryPatch("image_url",         "image_url",         args.image_url);

    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };

    patch.updated_at = Date.now();
    await ctx.db.patch(args.id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle",
      entity_id:   String(args.id),
      action:      "field_edit",
      actor:       args.actorName,
      actor_id:    args.actorId,
      detail:      `Vehicle specs updated · ${changes.join(", ")}`,
      created_at:  Date.now(),
    });
    return { ok: true as const, changes: Object.keys(patch).length - 1 };
  },
});

// ---------------------------------------------------------------------------
// updateVehicleMileage — patches vehicle_passport (creates if missing) +
// the primary owner's mileage on vehicle_owners
// ---------------------------------------------------------------------------

export const updateVehicleMileage = mutation({
  args: {
    id:         v.id("vehicles"),
    mileage:    v.number(),
    actorName:  v.string(),
    actorId:    v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const veh = await ctx.db.get(args.id);
    if (!veh) return { ok: false as const, reason: "vehicle_not_found" };
    if (!veh.vin) return { ok: false as const, reason: "vehicle_missing_vin" };

    const existing = await ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q) => q.eq("vin", veh.vin))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        mileage: args.mileage,
        last_reported_at: now,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("vehicle_passports", {
        vin: veh.vin,
        mileage: args.mileage,
        last_reported_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    // Also update the primary ownership row if one exists.
    const primary = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", veh.vin))
      .filter((q) => q.eq(q.field("is_primary"), true))
      .first();
    if (primary) {
      await ctx.db.patch(primary._id, { mileage: args.mileage });
    }

    await ctx.db.insert("audit_log", {
      entity_type: "vehicle",
      entity_id:   String(args.id),
      action:      "field_edit",
      actor:       args.actorName,
      actor_id:    args.actorId,
      detail:      `Mileage updated → ${args.mileage.toLocaleString()} mi`,
      created_at:  now,
    });

    return { ok: true as const, mileage: args.mileage };
  },
});

// ---------------------------------------------------------------------------
// reassignPrimaryOwner — swap which owner row carries is_primary
// ---------------------------------------------------------------------------

export const reassignPrimaryOwner = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    newOwnerUserId: v.id("users"),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { vehicleId, newOwnerUserId, actorName, actorId }) => {
    const veh = await ctx.db.get(vehicleId);
    if (!veh) return { ok: false as const, reason: "vehicle_not_found" };

    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin", (q) => q.eq("vin", veh.vin))
      .collect();
    const target = owners.find((o) => o.user_id === newOwnerUserId);
    if (!target) return { ok: false as const, reason: "user_is_not_owner" };

    for (const o of owners) {
      if (String(o._id) === String(target._id)) {
        if (!o.is_primary) await ctx.db.patch(o._id, { is_primary: true });
      } else if (o.is_primary) {
        await ctx.db.patch(o._id, { is_primary: false });
      }
    }

    const u = await ctx.db.get(newOwnerUserId);
    const name = u
      ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || "User"
      : "Unknown";
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle",
      entity_id:   String(vehicleId),
      action:      "field_edit",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Primary owner reassigned → ${name}`,
      created_at:  Date.now(),
    });
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// markVehicleVerified — audit-only "vouching" since vehicles has no
// `verified_at` field. Creates a director note + audit row.
// ---------------------------------------------------------------------------

export const markVehicleVerified = mutation({
  args: {
    id:        v.id("vehicles"),
    note:      v.optional(v.string()),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, note, actorName, actorId }) => {
    const veh = await ctx.db.get(id);
    if (!veh) return { ok: false as const, reason: "vehicle_not_found" };
    const now = Date.now();
    await ctx.db.insert("director_notes", {
      entity_type: "vehicle",
      entity_id:   String(id),
      author:      actorName,
      text:        `✅ Vehicle verified by ${actorName}.${note ? ` Note: ${note}` : ""}`,
      created_at:  now,
    });
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle",
      entity_id:   String(id),
      action:      "status_change",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Vehicle marked verified${note ? ` · ${note}` : ""}`,
      created_at:  now,
    });
    return { ok: true as const };
  },
});

// ===========================================================================
// Per-user driving profile + per-user "vehicle owner specs"
//
// Two tables involved:
//   - vehicle_owners (one row per user × VIN) holds the driving profile:
//     usagePattern, drivingConditions, annualMileageBand, ownership_plan, etc.
//   - vehicle_owner_specs (one row per vehicle_owner) holds the per-car
//     customization: actual tires mounted, modifications, package answers.
// ===========================================================================

// Read: the full owner row + its owner_specs row (creating none if missing).
export const getOwnerProfile = query({
  args: { ownerId: v.id("vehicle_owners") },
  handler: async (ctx, { ownerId }) => {
    const owner = await ctx.db.get(ownerId);
    if (!owner) return null;
    const specs = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicle_owner_id", ownerId))
      .first();
    const user = await ctx.db.get(owner.user_id);
    return {
      ownerId:       owner._id,
      vin:           owner.vin,
      userId:        owner.user_id,
      userName: user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.email || "User"
        : "Unknown",
      // Driving profile (vehicle_owners)
      profile: {
        nickname:                 owner.nickname,
        status:                   owner.status,
        is_primary:               owner.is_primary,
        mileage:                  owner.mileage,
        mileageAtPurchase:        owner.mileageAtPurchase,
        ownershipType:            owner.ownershipType,
        ownedSinceNew:            owner.ownedSinceNew,
        ownershipDuration:        owner.ownershipDuration,
        annualMileageBand:        owner.annualMileageBand,
        usagePattern:             owner.usagePattern,
        avgMonthlyDriving:        owner.avgMonthlyDriving,
        drivingConditions:        owner.drivingConditions,
        lastServiceWhen:          owner.lastServiceWhen,
        lastServiceWhat:          owner.lastServiceWhat,
        serviceLocationPreference: owner.serviceLocationPreference,
        garageRole:               owner.garageRole,
        ownership_plan:           owner.ownership_plan,
        lease_ending_soon:        owner.lease_ending_soon,
        lease_mileage_pace:       owner.lease_mileage_pace,
        vehicle_mode:             owner.vehicle_mode,
        owner_segment:            owner.owner_segment,
        annual_mileage_rate:      owner.annual_mileage_rate,
        health_score:             owner.health_score,
        added_at:                 owner.added_at,
        removed_at:               owner.removed_at,
      },
      // Owner specs (vehicle_owner_specs)
      specs: specs ? {
        id:                  specs._id,
        confirmed_packages:  specs.confirmed_packages ?? [],
        denied_packages:     specs.denied_packages ?? [],
        tire_setup:          specs.tire_setup ?? null,
        modifications:       specs.modifications ?? [],
        last_updated_at:     specs.last_updated_at,
      } : null,
    };
  },
});

// Patch the vehicle_owners driving-profile fields.
export const updateOwnerProfile = mutation({
  args: {
    ownerId:                  v.id("vehicle_owners"),
    nickname:                 v.optional(v.string()),
    mileage:                  v.optional(v.number()),
    mileageAtPurchase:        v.optional(v.number()),
    ownershipType:            v.optional(v.string()),
    ownedSinceNew:            v.optional(v.boolean()),
    ownershipDuration:        v.optional(v.string()),
    annualMileageBand:        v.optional(v.string()),
    usagePattern:             v.optional(v.string()),
    avgMonthlyDriving:        v.optional(v.string()),
    drivingConditions:        v.optional(v.string()),
    lastServiceWhen:          v.optional(v.string()),
    lastServiceWhat:          v.optional(v.string()),
    serviceLocationPreference: v.optional(v.string()),
    garageRole:               v.optional(v.string()),
    ownership_plan:           v.optional(v.string()),
    vehicle_mode:             v.optional(v.string()),
    health_score:             v.optional(v.number()),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, { ownerId, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(ownerId);
    if (!cur) return { ok: false as const, reason: "owner_not_found" };
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const noop = (cur: unknown, nxt: unknown) => {
      const ce = cur == null || cur === ""; const ne = nxt == null || nxt === "";
      if (ce && ne) return true;
      return cur === nxt;
    };
    for (const [k, nxt] of Object.entries(fields)) {
      if (nxt === undefined) continue;
      const c = (cur as any)[k];
      if (noop(c, nxt)) continue;
      patch[k] = nxt;
      const before = c == null || c === "" ? "—" : String(c);
      const after  = nxt == null || nxt === "" ? "—" : String(nxt);
      changes.push(`${k}: ${before} → ${after}`);
    }
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    await ctx.db.patch(ownerId, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_owner",
      entity_id:   String(ownerId),
      action:      "field_edit",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Driver profile updated · ${changes.join(", ")}`,
      created_at:  Date.now(),
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// Upsert vehicle_owner_specs (creates row if missing).
export const updateOwnerSpecs = mutation({
  args: {
    ownerId:            v.id("vehicle_owners"),
    confirmed_packages: v.optional(v.array(v.string())),
    denied_packages:    v.optional(v.array(v.string())),
    tire_front_brand:   v.optional(v.string()),
    tire_front_model:   v.optional(v.string()),
    tire_front_size:    v.optional(v.string()),
    tire_rear_brand:    v.optional(v.string()),
    tire_rear_model:    v.optional(v.string()),
    tire_rear_size:     v.optional(v.string()),
    // Full modifications array — replaces existing on save.
    modifications: v.optional(
      v.array(v.object({
        type:     v.string(),
        brand:    v.optional(v.string()),
        note:     v.optional(v.string()),
        added_at: v.optional(v.number()),
      })),
    ),
    actorName: v.string(),
    actorId:   v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    let row = await ctx.db
      .query("vehicle_owner_specs")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicle_owner_id", args.ownerId))
      .first();

    const now = Date.now();
    if (!row) {
      const id = await ctx.db.insert("vehicle_owner_specs", {
        vehicle_owner_id: args.ownerId,
        created_at: now,
      });
      row = (await ctx.db.get(id))!;
    }

    const tireSetup: Record<string, any> = { ...(row.tire_setup ?? {}) };
    const setIfDef = (side: "front" | "rear", key: string, val: unknown) => {
      if (val === undefined) return;
      tireSetup[side] = tireSetup[side] ?? {};
      tireSetup[side][key] = val;
      tireSetup[side].confirmed_at = now;
      tireSetup[side].source = tireSetup[side].source ?? "director";
    };
    setIfDef("front", "brand", args.tire_front_brand);
    setIfDef("front", "model", args.tire_front_model);
    setIfDef("front", "size",  args.tire_front_size);
    setIfDef("rear",  "brand", args.tire_rear_brand);
    setIfDef("rear",  "model", args.tire_rear_model);
    setIfDef("rear",  "size",  args.tire_rear_size);

    const patch: Record<string, unknown> = { last_updated_at: now };
    const changes: string[] = [];

    if (args.confirmed_packages) {
      patch.confirmed_packages = args.confirmed_packages;
      changes.push(`packages: ${args.confirmed_packages.join(", ") || "(none)"}`);
    }
    if (args.denied_packages) {
      patch.denied_packages = args.denied_packages;
      changes.push(`denied: ${args.denied_packages.join(", ") || "(none)"}`);
    }
    if (tireSetup.front || tireSetup.rear) {
      patch.tire_setup = tireSetup;
      changes.push("tire_setup updated");
    }
    if (args.modifications) {
      patch.modifications = args.modifications;
      changes.push(`modifications: ${args.modifications.length}`);
    }

    if (changes.length === 0) return { ok: true as const, changes: 0 };

    await ctx.db.patch(row._id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_owner_specs",
      entity_id:   String(row._id),
      action:      "field_edit",
      actor:       args.actorName,
      actor_id:    args.actorId,
      detail:      `Owner specs updated · ${changes.join(", ")}`,
      created_at:  now,
    });
    return { ok: true as const, changes: changes.length };
  },
});
