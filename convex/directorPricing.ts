/**
 * directorPricing — admin queries + mutations for the Pricing & tiers tab.
 *
 * No auth — access-controlled at the Next.js middleware level, same pattern
 * as convex/director.ts. Mutations all write audit_log entries via the same
 * shape used by directorConfigActions / directorVehicleActions.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { tierValidator, VEHICLE_TIERS, type VehicleTier } from "./lib/vehicleTiers";

// ---------------------------------------------------------------------------
// Shared patch helper (mirrors directorConfigActions.ts)
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

const emptyTierMap = <T>(zero: T): Record<VehicleTier, T> => ({
  T1:  zero,
  T2a: zero,
  T2b: zero,
  T2c: zero,
  T3a: zero,
  T3b: zero,
  T4:  zero,
});

// ---------------------------------------------------------------------------
// pricingOverview — tiers + live-car counts per tier (vehicles + configs)
// ---------------------------------------------------------------------------

export const pricingOverview = query({
  args: {},
  handler: async (ctx) => {
    const [tiers, configs, vehicles] = await Promise.all([
      ctx.db.query("pricing_tiers").collect(),
      ctx.db.query("vehicle_configs").collect(),
      ctx.db.query("vehicles").collect(),
    ]);

    const configCounts: Record<VehicleTier, number> = {
      T1: 0, T2a: 0, T2b: 0, T2c: 0, T3a: 0, T3b: 0, T4: 0,
    };
    const configTierByConfigId = new Map<string, VehicleTier>();
    let unassignedConfigs = 0;
    for (const c of configs) {
      if (c.pricing_tier && VEHICLE_TIERS.includes(c.pricing_tier as VehicleTier)) {
        const t = c.pricing_tier as VehicleTier;
        configCounts[t]++;
        configTierByConfigId.set(String(c._id), t);
      } else {
        unassignedConfigs++;
      }
    }

    const vehicleCounts: Record<VehicleTier, number> = {
      T1: 0, T2a: 0, T2b: 0, T2c: 0, T3a: 0, T3b: 0, T4: 0,
    };
    let unassignedVehicles = 0;
    for (const veh of vehicles) {
      const cid = veh.vehicle_config_id ? String(veh.vehicle_config_id) : null;
      const t = cid ? configTierByConfigId.get(cid) : undefined;
      if (t) vehicleCounts[t]++;
      else unassignedVehicles++;
    }

    return {
      tiers: tiers
        .slice()
        .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
        .map(t => ({
          id: t._id,
          code: t.code,
          name: t.name,
          anchor_vehicle_label: t.anchor_vehicle_label,
          description: t.description ?? null,
          display_order: t.display_order,
          is_active: t.is_active,
          updated_at: t.updated_at,
        })),
      vehicleCounts,
      configCounts,
      unassignedConfigs,
      unassignedVehicles,
      totalConfigs: configs.length,
      totalVehicles: vehicles.length,
    };
  },
});

// ---------------------------------------------------------------------------
// multipliersV1 — 7 tiers × 8 service categories
// ---------------------------------------------------------------------------

export const multipliersV1 = query({
  args: {},
  handler: async (ctx) => {
    const [tiers, categories, multipliers] = await Promise.all([
      ctx.db.query("pricing_tiers").collect(),
      ctx.db.query("pricing_service_categories").collect(),
      ctx.db.query("pricing_multipliers").collect(),
    ]);

    const orderedTiers = tiers
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    const orderedCats = categories
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

    return {
      tiers: orderedTiers.map(t => ({ id: t._id, code: t.code, name: t.name })),
      categories: orderedCats.map(c => ({ id: c._id, code: c.code, name: c.name })),
      cells: multipliers.map(m => ({
        id: m._id,
        tier_id: m.tier_id,
        pricing_category_id: m.pricing_category_id,
        multiplier: m.multiplier,
        is_locked: m.is_locked,
        validated_booking_count: m.validated_booking_count,
        min_bookings_for_lock: m.min_bookings_for_lock,
        notes: m.notes ?? null,
        updated_at: m.updated_at,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// multipliersV2Parts — 7 tiers × 9 parts categories
// ---------------------------------------------------------------------------

export const multipliersV2Parts = query({
  args: {},
  handler: async (ctx) => {
    const [categories, multipliers] = await Promise.all([
      ctx.db.query("pricing_parts_categories").collect(),
      ctx.db.query("pricing_parts_multipliers").collect(),
    ]);
    const ordered = categories
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    return {
      tiers: VEHICLE_TIERS.map(code => ({ code })),
      categories: ordered.map(c => ({ id: c._id, code: c.code, name: c.name })),
      cells: multipliers.map(m => ({
        id: m._id,
        parts_category_id: m.parts_category_id,
        tier: m.tier,
        multiplier: m.multiplier,
        source: m.source,
        updated_at: m.updated_at,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// multipliersV2Labor — 7 tiers × 4 labor categories
// ---------------------------------------------------------------------------

export const multipliersV2Labor = query({
  args: {},
  handler: async (ctx) => {
    const [categories, multipliers] = await Promise.all([
      ctx.db.query("pricing_labor_categories").collect(),
      ctx.db.query("pricing_labor_multipliers").collect(),
    ]);
    const ordered = categories
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    return {
      tiers: VEHICLE_TIERS.map(code => ({ code })),
      categories: ordered.map(c => ({ id: c._id, code: c.code, name: c.name })),
      cells: multipliers.map(m => ({
        id: m._id,
        labor_category_id: m.labor_category_id,
        tier: m.tier,
        multiplier: m.multiplier,
        source: m.source,
        updated_at: m.updated_at,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// baselinesList — Camry-anchored low/high cents per service
// ---------------------------------------------------------------------------

export const baselinesList = query({
  args: {},
  handler: async (ctx) => {
    const baselines = await ctx.db.query("pricing_baselines").collect();
    const services = await ctx.db.query("services").collect();
    const svcById = new Map(services.map(s => [String(s._id), s]));

    return baselines
      .map(b => {
        const svc = svcById.get(String(b.service_id));
        return {
          id: b._id,
          service_id: b.service_id,
          service_name: svc?.name ?? "—",
          service_slug: svc?.slug ?? null,
          base_price_low_cents: b.base_price_low_cents,
          base_price_high_cents: b.base_price_high_cents,
          is_real_data: b.is_real_data,
          data_source: b.data_source,
          last_validated_at: b.last_validated_at ?? null,
          notes: b.notes ?? null,
          updated_at: b.updated_at,
        };
      })
      .sort((a, b) => a.service_name.localeCompare(b.service_name));
  },
});

// ---------------------------------------------------------------------------
// vehicleConfigsByTier — paginated list filtered by tier
// ---------------------------------------------------------------------------

export const vehicleConfigsByTier = query({
  args: {
    tier: v.optional(tierValidator),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { tier, search, limit }) => {
    const cap = Math.min(Math.max(limit ?? 200, 1), 500);

    const configs = tier
      ? await ctx.db
          .query("vehicle_configs")
          .withIndex("by_pricing_tier", q => q.eq("pricing_tier", tier))
          .collect()
      : await ctx.db
          .query("vehicle_configs")
          .filter(q => q.eq(q.field("pricing_tier"), undefined))
          .collect();

    const makes = await ctx.db.query("makes").collect();
    const models = await ctx.db.query("models").collect();
    const makeById  = new Map(makes.map(m => [String(m._id), m.name]));
    const modelById = new Map(models.map(m => [String(m._id), m.name]));

    // VIN counts via vehicles.by_vehicle_config index — but we only need
    // counts, so a single scan + Map is cheaper than N indexed queries.
    const vehicles = await ctx.db.query("vehicles").collect();
    const vinCountByConfig = new Map<string, number>();
    for (const veh of vehicles) {
      if (!veh.vehicle_config_id) continue;
      const k = String(veh.vehicle_config_id);
      vinCountByConfig.set(k, (vinCountByConfig.get(k) ?? 0) + 1);
    }

    const needle = (search ?? "").trim().toLowerCase();
    const rows = configs
      .map(c => ({
        id: c._id,
        config_key: c.config_key,
        year: c.year,
        make: makeById.get(String(c.make_id)) ?? "—",
        model: modelById.get(String(c.model_id)) ?? "—",
        trim: c.trim_name ?? "—",
        chassis_code: c.chassis_code ?? null,
        pricing_tier: (c.pricing_tier as VehicleTier | undefined) ?? null,
        pricing_tier_source: c.pricing_tier_source ?? null,
        pricing_tier_set_at: c.pricing_tier_set_at ?? null,
        vin_count: vinCountByConfig.get(String(c._id)) ?? 0,
      }))
      .filter(r => {
        if (!needle) return true;
        const hay = [String(r.year), r.make, r.model, r.trim, r.chassis_code ?? "", r.config_key]
          .join(" ").toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => b.vin_count - a.vin_count)
      .slice(0, cap);

    return { rows, total: configs.length };
  },
});

// ---------------------------------------------------------------------------
// tierAssignmentDetail — single vehicle_config + assignment record
// ---------------------------------------------------------------------------

export const tierAssignmentDetail = query({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { vehicleConfigId }) => {
    const cfg = await ctx.db.get(vehicleConfigId);
    if (!cfg) return null;

    const assignment = await ctx.db
      .query("pricing_vehicle_assignments")
      .withIndex("by_vehicle_config", q => q.eq("vehicle_config_id", vehicleConfigId))
      .first();

    const [make, model] = await Promise.all([
      ctx.db.get(cfg.make_id),
      ctx.db.get(cfg.model_id),
    ]);

    return {
      config: {
        id: cfg._id,
        config_key: cfg.config_key,
        year: cfg.year,
        make: make?.name ?? "—",
        model: model?.name ?? "—",
        trim: cfg.trim_name ?? "—",
        chassis_code: cfg.chassis_code ?? null,
        pricing_tier: (cfg.pricing_tier as VehicleTier | undefined) ?? null,
        pricing_tier_source: cfg.pricing_tier_source ?? null,
        pricing_tier_set_at: cfg.pricing_tier_set_at ?? null,
      },
      assignment: assignment ? {
        id: assignment._id,
        tier_id: assignment.tier_id,
        brake_system: assignment.brake_system,
        powertrain_type: assignment.powertrain_type,
        is_manual_override: assignment.is_manual_override,
        override_reason: assignment.override_reason ?? null,
        classifier_score_breakdown: assignment.classifier_score_breakdown ?? null,
        assigned_at: assignment.assigned_at,
        updated_at: assignment.updated_at,
      } : null,
    };
  },
});

// ===========================================================================
// MUTATIONS
// ===========================================================================

// updateTierMetadata — edit a pricing_tiers row
export const updateTierMetadata = mutation({
  args: {
    id: v.id("pricing_tiers"),
    name: v.optional(v.string()),
    anchor_vehicle_label: v.optional(v.string()),
    display_order: v.optional(v.number()),
    description: v.optional(v.string()),
    is_active: v.optional(v.boolean()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "tier_not_found" };
    const { patch, changes } = buildPatch(
      cur as any,
      Object.entries(fields) as Array<[string, unknown]>,
    );
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    const now = Date.now();
    await ctx.db.patch(id, { ...patch, updated_at: now } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_tier",
      entity_id: String(id),
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `Tier ${cur.code} updated · ${changes.join(", ")}`,
      created_at: now,
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// updateMultiplierV1 — edit a pricing_multipliers cell
export const updateMultiplierV1 = mutation({
  args: {
    id: v.id("pricing_multipliers"),
    multiplier: v.optional(v.number()),
    is_locked: v.optional(v.boolean()),
    min_bookings_for_lock: v.optional(v.number()),
    notes: v.optional(v.string()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "multiplier_not_found" };
    const { patch, changes } = buildPatch(
      cur as any,
      Object.entries(fields) as Array<[string, unknown]>,
    );
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    const now = Date.now();
    await ctx.db.patch(id, { ...patch, updated_at: now } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_multiplier_v1",
      entity_id: String(id),
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `v1 multiplier updated · ${changes.join(", ")}`,
      created_at: now,
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// updateMultiplierV2Parts — edit a pricing_parts_multipliers cell
export const updateMultiplierV2Parts = mutation({
  args: {
    id: v.id("pricing_parts_multipliers"),
    multiplier: v.optional(v.number()),
    source: v.optional(v.string()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "multiplier_not_found" };
    const { patch, changes } = buildPatch(
      cur as any,
      Object.entries(fields) as Array<[string, unknown]>,
    );
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    const now = Date.now();
    await ctx.db.patch(id, { ...patch, updated_at: now } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_multiplier_v2_parts",
      entity_id: String(id),
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `v2 parts multiplier (${cur.tier}) updated · ${changes.join(", ")}`,
      created_at: now,
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// updateMultiplierV2Labor — edit a pricing_labor_multipliers cell
export const updateMultiplierV2Labor = mutation({
  args: {
    id: v.id("pricing_labor_multipliers"),
    multiplier: v.optional(v.number()),
    source: v.optional(v.string()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "multiplier_not_found" };
    const { patch, changes } = buildPatch(
      cur as any,
      Object.entries(fields) as Array<[string, unknown]>,
    );
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    const now = Date.now();
    await ctx.db.patch(id, { ...patch, updated_at: now } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_multiplier_v2_labor",
      entity_id: String(id),
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `v2 labor multiplier (${cur.tier}) updated · ${changes.join(", ")}`,
      created_at: now,
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// updateBaseline — edit a pricing_baselines row
export const updateBaseline = mutation({
  args: {
    id: v.id("pricing_baselines"),
    base_price_low_cents: v.optional(v.number()),
    base_price_high_cents: v.optional(v.number()),
    is_real_data: v.optional(v.boolean()),
    data_source: v.optional(v.string()),
    last_validated_at: v.optional(v.number()),
    notes: v.optional(v.string()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId, ...fields }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "baseline_not_found" };
    const { patch, changes } = buildPatch(
      cur as any,
      Object.entries(fields) as Array<[string, unknown]>,
    );
    if (Object.keys(patch).length === 0) return { ok: true as const, changes: 0 };
    const now = Date.now();
    await ctx.db.patch(id, { ...patch, updated_at: now } as any);
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_baseline",
      entity_id: String(id),
      action: "field_edit",
      actor: actorName,
      actor_id: actorId,
      detail: `Baseline updated · ${changes.join(", ")}`,
      created_at: now,
    });
    return { ok: true as const, changes: Object.keys(patch).length };
  },
});

// overrideVehicleConfigTier — reassign a vehicle_config to a new tier and
// upsert the matching pricing_vehicle_assignments row with override audit.
export const overrideVehicleConfigTier = mutation({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    newTier: tierValidator,
    reason: v.string(),
    brakeSystem: v.optional(v.string()),
    powertrainType: v.optional(v.string()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const cfg = await ctx.db.get(args.vehicleConfigId);
    if (!cfg) return { ok: false as const, reason: "config_not_found" };

    const prevTier = (cfg.pricing_tier as VehicleTier | undefined) ?? null;
    if (prevTier === args.newTier && !args.brakeSystem && !args.powertrainType) {
      return { ok: true as const, changes: 0 };
    }

    const now = Date.now();
    await ctx.db.patch(args.vehicleConfigId, {
      pricing_tier: args.newTier,
      pricing_tier_source: "manual",
      pricing_tier_set_at: now,
    } as any);

    const tierRow = await ctx.db
      .query("pricing_tiers")
      .withIndex("by_code", q => q.eq("code", args.newTier))
      .first();

    const existing = await ctx.db
      .query("pricing_vehicle_assignments")
      .withIndex("by_vehicle_config", q => q.eq("vehicle_config_id", args.vehicleConfigId))
      .first();

    if (existing) {
      const patch: Record<string, unknown> = {
        is_manual_override: true,
        override_reason: args.reason,
        assigned_at: now,
        updated_at: now,
        updated_by_user_id: undefined,
      };
      if (tierRow) patch.tier_id = tierRow._id;
      if (args.brakeSystem) patch.brake_system = args.brakeSystem;
      if (args.powertrainType) patch.powertrain_type = args.powertrainType;
      await ctx.db.patch(existing._id, patch as any);
    } else if (tierRow) {
      await ctx.db.insert("pricing_vehicle_assignments", {
        vehicle_config_id: args.vehicleConfigId,
        tier_id: tierRow._id,
        brake_system: args.brakeSystem ?? "iron_standard",
        powertrain_type: args.powertrainType ?? "ice",
        is_manual_override: true,
        override_reason: args.reason,
        assigned_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    await ctx.db.insert("audit_log", {
      entity_type: "vehicle_config_tier_override",
      entity_id: String(args.vehicleConfigId),
      action: "tier_change",
      actor: args.actorName,
      actor_id: args.actorId,
      detail: `pricing_tier: ${prevTier ?? "—"} → ${args.newTier} · reason: ${args.reason}`,
      created_at: now,
    });

    return { ok: true as const, changes: 1, prevTier, newTier: args.newTier };
  },
});
