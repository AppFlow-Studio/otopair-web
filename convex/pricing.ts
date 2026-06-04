/**
 * pricing.ts — MVP Pricing Multiplier (tier × category × Toyota baseline).
 *
 * Tables: pricing_tiers, pricing_service_categories, pricing_multipliers,
 * pricing_baselines, pricing_vehicle_assignments, ccb_absolute_prices.
 *
 * Reads are unauthenticated (admin dashboard, mechanic UI, customer-facing
 * quote screens all need them). Writes require an auth identity and log to
 * audit_log per the platform_settings + director.ts pattern. Director-role
 * gating is enforced at the caller, not here.
 *
 * Final per-vehicle quote at MVP launch:
 *   low  = baseline.low_cents  × multiplier
 *   high = baseline.high_cents × multiplier
 * Quote routing (locked / tight / wide) is derived from
 *   baseline.is_real_data && multiplier.is_locked.
 * CCB brakes route around the multiplier to ccb_absolute_prices instead.
 */

import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, query, QueryCtx } from "./_generated/server";

// ──────────────────────────────────────────────────────────────────────────
// Enum guardrails — kept here (not validators) so admin UIs can fetch them.
// ──────────────────────────────────────────────────────────────────────────

const BRAKE_SYSTEMS = [
  "iron_standard",
  "iron_high_performance",
  "ccb_optional",
  "ccb_standard",
] as const;

const POWERTRAIN_TYPES = ["ice", "hybrid", "phev", "bev"] as const;

const DATA_SOURCES = ["enrichment", "bookings", "modeled", "manual"] as const;

const DEFAULT_MIN_BOOKINGS_FOR_LOCK = 20;

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────

async function requireIdentity(ctx: { auth: QueryCtx["auth"] }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity;
}

async function logAudit(
  ctx: { db: any; auth: QueryCtx["auth"] },
  args: {
    entity_type: string;
    entity_id: string;
    action: string;
    actor: string;
    detail: unknown;
  },
) {
  await ctx.db.insert("audit_log", {
    entity_type: args.entity_type,
    entity_id: args.entity_id,
    action: args.action,
    actor: args.actor,
    detail: JSON.stringify(args.detail),
    created_at: Date.now(),
  });
}

// ============================================================================
// QUERIES
// ============================================================================

export const listTiers = query({
  args: { include_inactive: v.optional(v.boolean()) },
  handler: async (ctx, { include_inactive }) => {
    const rows = await ctx.db
      .query("pricing_tiers")
      .withIndex("by_display_order")
      .collect();
    return include_inactive ? rows : rows.filter((r) => r.is_active);
  },
});

export const listCategories = query({
  args: { include_inactive: v.optional(v.boolean()) },
  handler: async (ctx, { include_inactive }) => {
    const rows = await ctx.db
      .query("pricing_service_categories")
      .withIndex("by_display_order")
      .collect();
    return include_inactive ? rows : rows.filter((r) => r.is_active);
  },
});

/**
 * Returns the full 4×8 grid for the admin matrix editor. Shape:
 *   { tiers, categories, cells: { [tier_code]: { [category_code]: row } } }
 * Missing cells are returned as null so the UI can render an empty slot
 * waiting for an admin to set a value.
 */
export const getMultiplierMatrix = query({
  args: {},
  handler: async (ctx) => {
    const tiers = await ctx.db
      .query("pricing_tiers")
      .withIndex("by_display_order")
      .collect();
    const categories = await ctx.db
      .query("pricing_service_categories")
      .withIndex("by_display_order")
      .collect();
    const multipliers = await ctx.db.query("pricing_multipliers").collect();

    const tierById = new Map(tiers.map((t) => [t._id, t]));
    const catById = new Map(categories.map((c) => [c._id, c]));

    const cells: Record<string, Record<string, Doc<"pricing_multipliers"> | null>> = {};
    for (const t of tiers) {
      cells[t.code] = {};
      for (const c of categories) {
        cells[t.code][c.code] = null;
      }
    }
    for (const m of multipliers) {
      const t = tierById.get(m.tier_id);
      const c = catById.get(m.pricing_category_id);
      if (t && c) cells[t.code][c.code] = m;
    }
    return { tiers, categories, cells };
  },
});

export const getMultiplier = query({
  args: {
    tier_id: v.id("pricing_tiers"),
    pricing_category_id: v.id("pricing_service_categories"),
  },
  handler: async (ctx, { tier_id, pricing_category_id }) => {
    return await ctx.db
      .query("pricing_multipliers")
      .withIndex("by_tier_and_category", (q) =>
        q.eq("tier_id", tier_id).eq("pricing_category_id", pricing_category_id),
      )
      .first();
  },
});

export const getBaseline = query({
  args: { service_id: v.id("services") },
  handler: async (ctx, { service_id }) => {
    return await ctx.db
      .query("pricing_baselines")
      .withIndex("by_service", (q) => q.eq("service_id", service_id))
      .first();
  },
});

export const getCcbPrice = query({
  args: { service_id: v.id("services") },
  handler: async (ctx, { service_id }) => {
    return await ctx.db
      .query("ccb_absolute_prices")
      .withIndex("by_service", (q) => q.eq("service_id", service_id))
      .first();
  },
});

export const getVehicleAssignment = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, { vehicle_config_id }) => {
    return await ctx.db
      .query("pricing_vehicle_assignments")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", vehicle_config_id),
      )
      .first();
  },
});

export const listVehicleAssignmentsByTier = query({
  args: { tier_id: v.id("pricing_tiers") },
  handler: async (ctx, { tier_id }) => {
    return await ctx.db
      .query("pricing_vehicle_assignments")
      .withIndex("by_tier", (q) => q.eq("tier_id", tier_id))
      .collect();
  },
});

// ============================================================================
// MUTATIONS — admin-gated upstream. Each one writes audit_log.
// ============================================================================

export const upsertTier = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    anchor_vehicle_label: v.string(),
    display_order: v.number(),
    description: v.optional(v.string()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (!args.code.trim()) throw new Error("tier code is required");
    if (!args.name.trim()) throw new Error("tier name is required");

    const now = Date.now();
    const existing = await ctx.db
      .query("pricing_tiers")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        anchor_vehicle_label: args.anchor_vehicle_label,
        display_order: args.display_order,
        description: args.description,
        is_active: args.is_active ?? existing.is_active,
        updated_at: now,
      });
      await logAudit(ctx, {
        entity_type: "pricing_tier",
        entity_id: existing._id,
        action: "update",
        actor: identity.email ?? identity.subject,
        detail: args,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("pricing_tiers", {
      code: args.code,
      name: args.name,
      anchor_vehicle_label: args.anchor_vehicle_label,
      display_order: args.display_order,
      description: args.description,
      is_active: args.is_active ?? true,
      created_at: now,
      updated_at: now,
      updated_by_user_id: undefined,
    });
    await logAudit(ctx, {
      entity_type: "pricing_tier",
      entity_id: id,
      action: "create",
      actor: identity.email ?? identity.subject,
      detail: args,
    });
    return id;
  },
});

export const deactivateTier = mutation({
  args: { tier_id: v.id("pricing_tiers") },
  handler: async (ctx, { tier_id }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(tier_id);
    if (!row) throw new Error("tier not found");
    await ctx.db.patch(tier_id, { is_active: false, updated_at: Date.now() });
    await logAudit(ctx, {
      entity_type: "pricing_tier",
      entity_id: tier_id,
      action: "deactivate",
      actor: identity.email ?? identity.subject,
      detail: { code: row.code },
    });
  },
});

export const upsertCategory = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    display_order: v.number(),
    notes: v.optional(v.string()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (!args.code.trim()) throw new Error("category code is required");

    const now = Date.now();
    const existing = await ctx.db
      .query("pricing_service_categories")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        display_order: args.display_order,
        notes: args.notes,
        is_active: args.is_active ?? existing.is_active,
        updated_at: now,
      });
      await logAudit(ctx, {
        entity_type: "pricing_service_category",
        entity_id: existing._id,
        action: "update",
        actor: identity.email ?? identity.subject,
        detail: args,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("pricing_service_categories", {
      code: args.code,
      name: args.name,
      display_order: args.display_order,
      notes: args.notes,
      is_active: args.is_active ?? true,
      created_at: now,
      updated_at: now,
    });
    await logAudit(ctx, {
      entity_type: "pricing_service_category",
      entity_id: id,
      action: "create",
      actor: identity.email ?? identity.subject,
      detail: args,
    });
    return id;
  },
});

export const deactivateCategory = mutation({
  args: { pricing_category_id: v.id("pricing_service_categories") },
  handler: async (ctx, { pricing_category_id }) => {
    const identity = await requireIdentity(ctx);
    const row = await ctx.db.get(pricing_category_id);
    if (!row) throw new Error("category not found");
    await ctx.db.patch(pricing_category_id, {
      is_active: false,
      updated_at: Date.now(),
    });
    await logAudit(ctx, {
      entity_type: "pricing_service_category",
      entity_id: pricing_category_id,
      action: "deactivate",
      actor: identity.email ?? identity.subject,
      detail: { code: row.code },
    });
  },
});

export const setMultiplier = mutation({
  args: {
    tier_id: v.id("pricing_tiers"),
    pricing_category_id: v.id("pricing_service_categories"),
    multiplier: v.number(),
    min_bookings_for_lock: v.optional(v.number()),
    validated_booking_count: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (args.multiplier <= 0) throw new Error("multiplier must be > 0");
    if (args.multiplier > 50) throw new Error("multiplier must be <= 50 (sanity cap)");
    if (args.min_bookings_for_lock != null && args.min_bookings_for_lock < 0) {
      throw new Error("min_bookings_for_lock must be >= 0");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("pricing_multipliers")
      .withIndex("by_tier_and_category", (q) =>
        q
          .eq("tier_id", args.tier_id)
          .eq("pricing_category_id", args.pricing_category_id),
      )
      .first();

    const min_bookings =
      args.min_bookings_for_lock ??
      existing?.min_bookings_for_lock ??
      DEFAULT_MIN_BOOKINGS_FOR_LOCK;
    const validated_count =
      args.validated_booking_count ?? existing?.validated_booking_count ?? 0;
    const is_locked = validated_count >= min_bookings;

    if (existing) {
      await ctx.db.patch(existing._id, {
        multiplier: args.multiplier,
        min_bookings_for_lock: min_bookings,
        validated_booking_count: validated_count,
        is_locked,
        notes: args.notes ?? existing.notes,
        updated_at: now,
      });
      await logAudit(ctx, {
        entity_type: "pricing_multiplier",
        entity_id: existing._id,
        action: "update",
        actor: identity.email ?? identity.subject,
        detail: args,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("pricing_multipliers", {
      tier_id: args.tier_id,
      pricing_category_id: args.pricing_category_id,
      multiplier: args.multiplier,
      min_bookings_for_lock: min_bookings,
      validated_booking_count: validated_count,
      is_locked,
      notes: args.notes,
      created_at: now,
      updated_at: now,
    });
    await logAudit(ctx, {
      entity_type: "pricing_multiplier",
      entity_id: id,
      action: "create",
      actor: identity.email ?? identity.subject,
      detail: args,
    });
    return id;
  },
});

export const setBaseline = mutation({
  args: {
    service_id: v.id("services"),
    anchor_vehicle_config_id: v.optional(v.id("vehicle_configs")),
    base_price_low_cents: v.number(),
    base_price_high_cents: v.number(),
    is_real_data: v.boolean(),
    data_source: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (args.base_price_low_cents < 0 || args.base_price_high_cents < 0) {
      throw new Error("baseline prices must be >= 0");
    }
    if (args.base_price_low_cents > args.base_price_high_cents) {
      throw new Error("low_cents must be <= high_cents");
    }
    if (!(DATA_SOURCES as readonly string[]).includes(args.data_source)) {
      throw new Error(
        `data_source must be one of: ${DATA_SOURCES.join(", ")}`,
      );
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("pricing_baselines")
      .withIndex("by_service", (q) => q.eq("service_id", args.service_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        anchor_vehicle_config_id: args.anchor_vehicle_config_id,
        base_price_low_cents: args.base_price_low_cents,
        base_price_high_cents: args.base_price_high_cents,
        is_real_data: args.is_real_data,
        data_source: args.data_source,
        last_validated_at: args.is_real_data ? now : existing.last_validated_at,
        notes: args.notes ?? existing.notes,
        updated_at: now,
      });
      await logAudit(ctx, {
        entity_type: "pricing_baseline",
        entity_id: existing._id,
        action: "update",
        actor: identity.email ?? identity.subject,
        detail: args,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("pricing_baselines", {
      service_id: args.service_id,
      anchor_vehicle_config_id: args.anchor_vehicle_config_id,
      base_price_low_cents: args.base_price_low_cents,
      base_price_high_cents: args.base_price_high_cents,
      is_real_data: args.is_real_data,
      data_source: args.data_source,
      last_validated_at: args.is_real_data ? now : undefined,
      notes: args.notes,
      created_at: now,
      updated_at: now,
    });
    await logAudit(ctx, {
      entity_type: "pricing_baseline",
      entity_id: id,
      action: "create",
      actor: identity.email ?? identity.subject,
      detail: args,
    });
    return id;
  },
});

export const setCcbPrice = mutation({
  args: {
    service_id: v.id("services"),
    price_low_cents: v.number(),
    price_high_cents: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (args.price_low_cents < 0 || args.price_high_cents < 0) {
      throw new Error("CCB prices must be >= 0");
    }
    if (args.price_low_cents > args.price_high_cents) {
      throw new Error("low_cents must be <= high_cents");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("ccb_absolute_prices")
      .withIndex("by_service", (q) => q.eq("service_id", args.service_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        price_low_cents: args.price_low_cents,
        price_high_cents: args.price_high_cents,
        notes: args.notes ?? existing.notes,
        updated_at: now,
      });
      await logAudit(ctx, {
        entity_type: "ccb_absolute_price",
        entity_id: existing._id,
        action: "update",
        actor: identity.email ?? identity.subject,
        detail: args,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("ccb_absolute_prices", {
      service_id: args.service_id,
      price_low_cents: args.price_low_cents,
      price_high_cents: args.price_high_cents,
      notes: args.notes,
      created_at: now,
      updated_at: now,
    });
    await logAudit(ctx, {
      entity_type: "ccb_absolute_price",
      entity_id: id,
      action: "create",
      actor: identity.email ?? identity.subject,
      detail: args,
    });
    return id;
  },
});

export const assignVehicleTier = mutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    tier_id: v.id("pricing_tiers"),
    brake_system: v.string(),
    powertrain_type: v.string(),
    is_manual_override: v.boolean(),
    override_reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (!(BRAKE_SYSTEMS as readonly string[]).includes(args.brake_system)) {
      throw new Error(
        `brake_system must be one of: ${BRAKE_SYSTEMS.join(", ")}`,
      );
    }
    if (!(POWERTRAIN_TYPES as readonly string[]).includes(args.powertrain_type)) {
      throw new Error(
        `powertrain_type must be one of: ${POWERTRAIN_TYPES.join(", ")}`,
      );
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("pricing_vehicle_assignments")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        tier_id: args.tier_id,
        brake_system: args.brake_system,
        powertrain_type: args.powertrain_type,
        is_manual_override: args.is_manual_override,
        override_reason: args.override_reason ?? existing.override_reason,
        assigned_at: now,
        updated_at: now,
      });
      await logAudit(ctx, {
        entity_type: "pricing_vehicle_assignment",
        entity_id: existing._id,
        action: "update",
        actor: identity.email ?? identity.subject,
        detail: args,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("pricing_vehicle_assignments", {
      vehicle_config_id: args.vehicle_config_id,
      tier_id: args.tier_id,
      brake_system: args.brake_system,
      powertrain_type: args.powertrain_type,
      is_manual_override: args.is_manual_override,
      override_reason: args.override_reason,
      classifier_score_breakdown: undefined,
      assigned_by_user_id: undefined,
      assigned_at: now,
      created_at: now,
      updated_at: now,
    });
    await logAudit(ctx, {
      entity_type: "pricing_vehicle_assignment",
      entity_id: id,
      action: "create",
      actor: identity.email ?? identity.subject,
      detail: args,
    });
    return id;
  },
});

export const mapServiceToPricingCategory = mutation({
  args: {
    service_id: v.id("services"),
    pricing_category_id: v.union(
      v.id("pricing_service_categories"),
      v.null(),
    ),
  },
  handler: async (ctx, { service_id, pricing_category_id }) => {
    const identity = await requireIdentity(ctx);
    const service = await ctx.db.get(service_id);
    if (!service) throw new Error("service not found");

    await ctx.db.patch(service_id, {
      pricing_category_id: pricing_category_id ?? undefined,
    });
    await logAudit(ctx, {
      entity_type: "service",
      entity_id: service_id,
      action: "map_pricing_category",
      actor: identity.email ?? identity.subject,
      detail: { pricing_category_id },
    });
  },
});
