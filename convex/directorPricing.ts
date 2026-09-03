/**
 * directorPricing — admin queries + mutations for the Pricing & tiers tab.
 *
 * No auth — access-controlled at the Next.js middleware level, same pattern
 * as convex/director.ts. Mutations all write audit_log entries via the same
 * shape used by directorConfigActions / directorVehicleActions.
 */

import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { tierValidator, VEHICLE_TIERS, type VehicleTier } from "./lib/vehicleTiers";
import { makeKeyOf } from "./lib/makeKey";
import { pickTierRule, resolveTierWithRules } from "./lib/tierResolver";
import {
  buildEntityLabel,
  diffChanges,
  recordFallbackSnapshot,
  serializeRow,
  summarizeChanges,
  type FallbackEntityType,
} from "./lib/fallbackSnapshots";

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

    const cat = await ctx.db.get(cur.parts_category_id);
    await recordFallbackSnapshot(ctx, {
      entity_type: "parts_multiplier",
      entity_id: String(id),
      entity_label: buildEntityLabel("parts_multiplier", cur, { category_code: cat?.code ?? null }),
      prior_row: cur,
      changes: diffChanges(cur as any, patch),
      actor_name: actorName,
      actor_id: actorId,
    });

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

    const cat = await ctx.db.get(cur.labor_category_id);
    await recordFallbackSnapshot(ctx, {
      entity_type: "labor_multiplier",
      entity_id: String(id),
      entity_label: buildEntityLabel("labor_multiplier", cur, { category_code: cat?.code ?? null }),
      prior_row: cur,
      changes: diffChanges(cur as any, patch),
      actor_name: actorName,
      actor_id: actorId,
    });

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

    // Capture snapshot of the PRIOR state before patching, so "Restore"
    // can replay exactly. Compute the change diff from the same buildPatch
    // output we just used so the summary stays in sync with the audit log.
    const svc = await ctx.db.get(cur.service_id);
    await recordFallbackSnapshot(ctx, {
      entity_type: "baseline",
      entity_id: String(id),
      entity_label: buildEntityLabel("baseline", cur, { service_name: svc?.name ?? null }),
      prior_row: cur,
      changes: diffChanges(cur as any, patch),
      actor_name: actorName,
      actor_id: actorId,
    });

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

// ===========================================================================
// MAKE / MODEL TIER RULES — Director-authored, no-deploy tier assignment layer
// ===========================================================================
// A live rules table (pricing_tier_rules) that sits ABOVE the hardcoded
// ASSIGNMENT_RULES engine. lib/tierResolver consults it first, so a rule
// applies to every FUTURE onboarded car; retierMatchingConfigs applies it to
// ALREADY-onboarded cars now. Per-config manual overrides always win.

/** Load id→name maps for makes/models (small reference tables). */
async function loadNameMaps(ctx: MutationCtx) {
  const [makes, models] = await Promise.all([
    ctx.db.query("makes").collect(),
    ctx.db.query("models").collect(),
  ]);
  return {
    makeName: new Map(makes.map((m) => [String(m._id), m.name])),
    modelName: new Map(models.map((m) => [String(m._id), (m as any).name as string])),
  };
}

/**
 * Re-resolve + persist the tier for every config (optionally scoped to one
 * make_key), skipping director manual pins unless `force`. Never clears a set
 * tier with a null resolution. Returns counts for the audit trail + UI toast.
 */
async function retierMatchingConfigs(
  ctx: MutationCtx,
  opts: { makeKey?: string; force?: boolean },
): Promise<{ scanned: number; retiered: number; stillNull: number }> {
  const { makeName, modelName } = await loadNameMaps(ctx);
  const rules = await ctx.db.query("pricing_tier_rules").collect();
  const configs = await ctx.db.query("vehicle_configs").collect();
  const now = Date.now();
  let scanned = 0;
  let retiered = 0;
  let stillNull = 0;
  for (const cfg of configs) {
    const make = makeName.get(String(cfg.make_id)) ?? "";
    if (opts.makeKey && makeKeyOf(make) !== opts.makeKey) continue;
    scanned++;
    if (cfg.pricing_tier_source === "manual" && !opts.force) continue;
    const model = modelName.get(String(cfg.model_id)) ?? "";
    const res = resolveTierWithRules(rules, {
      make,
      model,
      trim: cfg.trim_name ?? "",
      year: cfg.year,
    });
    if (!res.tier) {
      if (!cfg.pricing_tier) stillNull++;
      continue;
    }
    if (res.tier !== cfg.pricing_tier || res.source !== cfg.pricing_tier_source) {
      await ctx.db.patch(cfg._id, {
        pricing_tier: res.tier,
        pricing_tier_source: res.source ?? undefined,
        pricing_tier_set_at: now,
      } as any);
      retiered++;
    }
  }
  return { scanned, retiered, stillNull };
}

/** Trim to undefined so empty inputs don't persist as "" (which would break
 *  substring matching against every model/trim). */
const orUndef = (s?: string): string | undefined => {
  const t = (s ?? "").trim();
  return t === "" ? undefined : t;
};

// tierRulesList — all rules + how many configs each rule currently OWNS
// (the winning most-specific rule for that car).
export const tierRulesList = query({
  args: {},
  handler: async (ctx) => {
    const [rules, makes, models, configs] = await Promise.all([
      ctx.db.query("pricing_tier_rules").collect(),
      ctx.db.query("makes").collect(),
      ctx.db.query("models").collect(),
      ctx.db.query("vehicle_configs").collect(),
    ]);
    const makeName = new Map(makes.map((m) => [String(m._id), m.name]));
    const modelName = new Map(models.map((m) => [String(m._id), (m as any).name as string]));

    const ownedBy = new Map<string, number>();
    for (const cfg of configs) {
      const make = makeName.get(String(cfg.make_id)) ?? "";
      const model = modelName.get(String(cfg.model_id)) ?? "";
      const win = pickTierRule(rules, {
        make,
        model,
        trim: cfg.trim_name ?? "",
        year: cfg.year,
      });
      if (win) ownedBy.set(String(win._id), (ownedBy.get(String(win._id)) ?? 0) + 1);
    }

    return rules
      .slice()
      .sort((a, b) => a.make.localeCompare(b.make) || b.updated_at - a.updated_at)
      .map((r) => ({
        id: r._id,
        make: r.make,
        make_key: r.make_key,
        model_includes: r.model_includes ?? null,
        trim_includes: r.trim_includes ?? null,
        year_min: r.year_min ?? null,
        year_max: r.year_max ?? null,
        tier: r.tier,
        enabled: r.enabled,
        note: r.note ?? null,
        actor_name: r.actor_name ?? null,
        matchCount: ownedBy.get(String(r._id)) ?? 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
  },
});

// upsertTierRule — create or edit a rule, then re-tier existing matching cars.
export const upsertTierRule = mutation({
  args: {
    id: v.optional(v.id("pricing_tier_rules")),
    make: v.string(),
    model_includes: v.optional(v.string()),
    trim_includes: v.optional(v.string()),
    year_min: v.optional(v.number()),
    year_max: v.optional(v.number()),
    tier: tierValidator,
    enabled: v.optional(v.boolean()),
    note: v.optional(v.string()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const make = args.make.trim();
    if (!make) return { ok: false as const, reason: "make_required" };
    const make_key = makeKeyOf(make);
    const now = Date.now();

    const fields = {
      make,
      make_key,
      model_includes: orUndef(args.model_includes),
      trim_includes: orUndef(args.trim_includes),
      year_min: args.year_min,
      year_max: args.year_max,
      tier: args.tier,
      enabled: args.enabled ?? true,
      note: orUndef(args.note),
      actor_name: args.actorName,
      updated_at: now,
    };

    let ruleId: Id<"pricing_tier_rules">;
    let action: string;
    if (args.id) {
      const cur = await ctx.db.get(args.id);
      if (!cur) return { ok: false as const, reason: "rule_not_found" };
      await ctx.db.patch(args.id, fields);
      ruleId = args.id;
      action = "rule_edit";
    } else {
      ruleId = await ctx.db.insert("pricing_tier_rules", {
        ...fields,
        created_by: args.actorId,
        created_at: now,
      });
      action = "rule_create";
    }

    // Apply to already-onboarded cars now (future onboards pick it up at
    // config creation). Manual pins are left untouched.
    const retier = await retierMatchingConfigs(ctx, { makeKey: make_key });

    const scope =
      `${make}` +
      (fields.model_includes ? ` / ${fields.model_includes}` : "") +
      (fields.trim_includes ? ` / ${fields.trim_includes}` : "");
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_tier_rule",
      entity_id: String(ruleId),
      action,
      actor: args.actorName,
      actor_id: args.actorId,
      detail: `${scope} → ${args.tier}${fields.enabled ? "" : " (disabled)"} · re-tiered ${retier.retiered} car(s)`,
      created_at: now,
    });

    return { ok: true as const, id: ruleId, retier };
  },
});

// setTierRuleEnabled — toggle a rule on/off; re-tier the affected make.
export const setTierRuleEnabled = mutation({
  args: {
    id: v.id("pricing_tier_rules"),
    enabled: v.boolean(),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, enabled, actorName, actorId }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "rule_not_found" };
    const now = Date.now();
    await ctx.db.patch(id, { enabled, updated_at: now });
    const retier = await retierMatchingConfigs(ctx, { makeKey: cur.make_key });
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_tier_rule",
      entity_id: String(id),
      action: enabled ? "rule_enable" : "rule_disable",
      actor: actorName,
      actor_id: actorId,
      detail: `${cur.make} rule ${enabled ? "enabled" : "disabled"} · re-tiered ${retier.retiered} car(s)`,
      created_at: now,
    });
    return { ok: true as const, retier };
  },
});

// deleteTierRule — remove a rule; re-tier the affected make so cars fall back
// through the resolver (director_rule → hardcoded engine, or null → review).
export const deleteTierRule = mutation({
  args: {
    id: v.id("pricing_tier_rules"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { id, actorName, actorId }) => {
    const cur = await ctx.db.get(id);
    if (!cur) return { ok: false as const, reason: "rule_not_found" };
    const makeKey = cur.make_key;
    const label = cur.make;
    await ctx.db.delete(id);
    const retier = await retierMatchingConfigs(ctx, { makeKey });
    const now = Date.now();
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_tier_rule",
      entity_id: String(id),
      action: "rule_delete",
      actor: actorName,
      actor_id: actorId,
      detail: `${label} rule deleted · re-tiered ${retier.retiered} car(s)`,
      created_at: now,
    });
    return { ok: true as const, retier };
  },
});

// retierConfigs — manual "Re-tier now" backfill. Scoped to a make_key when
// given (else the whole catalog). Callable from the UI or `npx convex run`.
export const retierConfigs = mutation({
  args: {
    makeKey: v.optional(v.string()),
    force: v.optional(v.boolean()),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { makeKey, force, actorName, actorId }) => {
    const res = await retierMatchingConfigs(ctx, { makeKey, force });
    await ctx.db.insert("audit_log", {
      entity_type: "pricing_tier_rule",
      entity_id: makeKey ?? "all",
      action: "retier",
      actor: actorName ?? "system",
      actor_id: actorId,
      detail: `Re-tier${makeKey ? ` (${makeKey})` : " (all)"}: ${res.retiered} re-tiered / ${res.scanned} scanned, ${res.stillNull} still unassigned${force ? " · force" : ""}`,
      created_at: Date.now(),
    });
    return { ok: true as const, ...res };
  },
});

// ---------------------------------------------------------------------------
// Fallback-spec history & restore
// ---------------------------------------------------------------------------

const fallbackEntityValidator = v.union(
  v.literal("baseline"),
  v.literal("parts_multiplier"),
  v.literal("labor_multiplier"),
  v.literal("service_labor_hours"),
);

/**
 * Snapshots for a single fallback-spec entity, newest first. Powers the
 * per-row History modal in the Baselines table (and any future History
 * modal hung off the multiplier matrices).
 */
export const fallbackHistory = query({
  args: {
    entity_type: fallbackEntityValidator,
    entity_id: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pricing_fallback_snapshots")
      .withIndex("by_entity", (q) =>
        q.eq("entity_type", args.entity_type).eq("entity_id", args.entity_id),
      )
      .collect();
    return rows
      .slice()
      .sort((a, b) => b.created_at - a.created_at)
      .map((r) => ({
        id: r._id,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        entity_label: r.entity_label,
        payload: r.payload,
        changes_summary: r.changes_summary,
        is_restore: r.is_restore ?? false,
        actor_name: r.actor_name,
        actor_id: r.actor_id ?? null,
        created_at: r.created_at,
      }));
  },
});

/**
 * Restore a fallback-spec entity to the values captured in a snapshot.
 * Before patching, captures the CURRENT live state as a fresh snapshot so
 * the restore itself is reversible. Audit_log entry credits the actor.
 *
 * Only baselines / parts multipliers / labor multipliers are restorable
 * today (no edit mutation exists yet for service default_labor_hours).
 */
export const restoreFallbackSnapshot = mutation({
  args: {
    snapshot_id: v.id("pricing_fallback_snapshots"),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, { snapshot_id, actorName, actorId }) => {
    const snap = await ctx.db.get(snapshot_id);
    if (!snap) return { ok: false as const, reason: "snapshot_not_found" };

    // Parse the prior-state payload (full row minus _id/_creationTime).
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(snap.payload);
    } catch {
      return { ok: false as const, reason: "snapshot_payload_corrupt" };
    }

    const entity_id = snap.entity_id;
    const entity_type = snap.entity_type;

    // Capture current state as a fresh snapshot, then patch.
    if (entity_type === "baseline") {
      const cur = (await ctx.db.get(entity_id as Id<"pricing_baselines">)) as Doc<"pricing_baselines"> | null;
      if (!cur) return { ok: false as const, reason: "target_not_found" };
      const svc = await ctx.db.get(cur.service_id);
      await recordFallbackSnapshot(ctx, {
        entity_type,
        entity_id,
        entity_label: buildEntityLabel(entity_type, cur, { service_name: svc?.name ?? null }),
        prior_row: cur,
        changes: diffChanges(cur as any, payload),
        is_restore: true,
        actor_name: actorName,
        actor_id: actorId,
      });
      const now = Date.now();
      const patch = { ...payload, updated_at: now } as any;
      delete patch.service_id; // never reassign FK on restore
      delete patch.created_at; // preserve original creation time
      await ctx.db.patch(cur._id, patch);
      await ctx.db.insert("audit_log", {
        entity_type: "pricing_baseline",
        entity_id,
        action: "restore",
        actor: actorName,
        actor_id: actorId,
        detail: `Baseline restored from snapshot ${new Date(snap.created_at).toISOString()}`,
        created_at: now,
      });
      return { ok: true as const };
    }

    if (entity_type === "parts_multiplier") {
      const cur = (await ctx.db.get(entity_id as Id<"pricing_parts_multipliers">)) as Doc<"pricing_parts_multipliers"> | null;
      if (!cur) return { ok: false as const, reason: "target_not_found" };
      const cat = await ctx.db.get(cur.parts_category_id);
      await recordFallbackSnapshot(ctx, {
        entity_type,
        entity_id,
        entity_label: buildEntityLabel(entity_type, cur, { category_code: cat?.code ?? null }),
        prior_row: cur,
        changes: diffChanges(cur as any, payload),
        is_restore: true,
        actor_name: actorName,
        actor_id: actorId,
      });
      const now = Date.now();
      const patch = { ...payload, updated_at: now } as any;
      delete patch.parts_category_id;
      delete patch.tier;
      await ctx.db.patch(cur._id, patch);
      await ctx.db.insert("audit_log", {
        entity_type: "pricing_multiplier_v2_parts",
        entity_id,
        action: "restore",
        actor: actorName,
        actor_id: actorId,
        detail: `Parts multiplier restored from snapshot ${new Date(snap.created_at).toISOString()}`,
        created_at: now,
      });
      return { ok: true as const };
    }

    if (entity_type === "labor_multiplier") {
      const cur = (await ctx.db.get(entity_id as Id<"pricing_labor_multipliers">)) as Doc<"pricing_labor_multipliers"> | null;
      if (!cur) return { ok: false as const, reason: "target_not_found" };
      const cat = await ctx.db.get(cur.labor_category_id);
      await recordFallbackSnapshot(ctx, {
        entity_type,
        entity_id,
        entity_label: buildEntityLabel(entity_type, cur, { category_code: cat?.code ?? null }),
        prior_row: cur,
        changes: diffChanges(cur as any, payload),
        is_restore: true,
        actor_name: actorName,
        actor_id: actorId,
      });
      const now = Date.now();
      const patch = { ...payload, updated_at: now } as any;
      delete patch.labor_category_id;
      delete patch.tier;
      await ctx.db.patch(cur._id, patch);
      await ctx.db.insert("audit_log", {
        entity_type: "pricing_multiplier_v2_labor",
        entity_id,
        action: "restore",
        actor: actorName,
        actor_id: actorId,
        detail: `Labor multiplier restored from snapshot ${new Date(snap.created_at).toISOString()}`,
        created_at: now,
      });
      return { ok: true as const };
    }

    return { ok: false as const, reason: "restore_not_supported_for_entity_type" };
  },
});
