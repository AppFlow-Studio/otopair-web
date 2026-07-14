// =============================================================================
// Data portal · Service Catalog — /data/service-catalog (Data spec §11).
// The 23 services grouped by category (default_labor_hours edits are a
// ceremony — the value multiplies across every shop's pricing), options
// editor, and the SLIM 7→4 migration card: on deployments where the
// consolidation already ran (dev, Jul 13) the card is a collapsed green
// record backed by its audit row; where it hasn't (prod), the dry-run diff +
// execute affordances run migrations/categoryConsolidation via the shared
// runCategoryConsolidation body. Co-sign is not enforced (no co-sign
// primitive exists repo-wide) — single-signer ceremony + audit, stated in UI.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";
import {
  runCategoryConsolidation,
  type ConsolidationResult,
} from "./migrations/categoryConsolidation";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ServiceRow = {
  id: string;
  name: string;
  slug: string | null;
  default_labor_hours: number | null;
  display_order: number | null;
  options_count: number;
  offered_by_shops: number;
  bookable_signal: boolean; // false + 0 offerings = phantom candidate
  parts_kind: string | null;
};
export type CategoryGroup = {
  id: string;
  name: string;
  display_order: number | null;
  services: ServiceRow[];
};

export const catalog = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<CategoryGroup[]> => {
    await requireDirector(ctx, token);
    const categories = await ctx.db.query("service_categories").collect(); // 4 rows
    const services = await ctx.db.query("services").collect(); // 23 rows
    const groups = new Map<string, CategoryGroup>();
    for (const c of categories) {
      groups.set(String(c._id), {
        id: String(c._id),
        name: c.name,
        display_order: c.display_order ?? null,
        services: [],
      });
    }
    const uncategorized: CategoryGroup = {
      id: "(none)",
      name: "Uncategorized",
      display_order: 999,
      services: [],
    };
    for (const s of services) {
      const options = await ctx.db
        .query("service_options")
        .withIndex("by_service_id", (q) => q.eq("service_id", s._id))
        .take(60);
      const offerings = await ctx.db
        .query("shop_services")
        .withIndex("by_service_id", (q) => q.eq("service_id", s._id))
        .take(50);
      const row: ServiceRow = {
        id: String(s._id),
        name: s.name,
        slug: s.slug ?? null,
        default_labor_hours: s.default_labor_hours ?? null,
        display_order: s.display_order ?? null,
        options_count: options.length,
        offered_by_shops: offerings.length,
        bookable_signal: offerings.length > 0,
        parts_kind: s.parts_kind ?? null,
      };
      const group = s.service_category_id ? groups.get(String(s.service_category_id)) : null;
      (group ?? uncategorized).services.push(row);
    }
    const out = [...groups.values()];
    if (uncategorized.services.length > 0) out.push(uncategorized);
    for (const g of out)
      g.services.sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99));
    return out.sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99));
  },
});

export type ServiceOptionRow = {
  id: string;
  option_label: string;
  option_type: string | null;
  labor_hours: number | null;
  parts_cost_low: number | null; // stored for records — removed from math (May 28)
  parts_cost_high: number | null;
  state_fee: number | null;
  display_order: number | null;
};

export const optionsForService = query({
  args: { token: v.string(), serviceId: v.id("services") },
  handler: async (ctx, { token, serviceId }): Promise<ServiceOptionRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("service_options")
      .withIndex("by_service_id", (q) => q.eq("service_id", serviceId))
      .take(60);
    return rows
      .map((o) => ({
        id: String(o._id),
        option_label: o.option_label,
        option_type: o.option_type ?? null,
        labor_hours: o.labor_hours ?? null,
        parts_cost_low: o.parts_cost_low ?? null,
        parts_cost_high: o.parts_cost_high ?? null,
        state_fee: o.state_fee ?? null,
        display_order: o.display_order ?? null,
      }))
      .sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99));
  },
});

export const updateDefaultLaborHours = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    serviceId: v.id("services"),
    hours: v.number(),
  },
  handler: async (ctx, { token, reason, serviceId, hours }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    if (!(hours > 0 && hours <= 40)) throw new Error("Hours must be in (0, 40].");
    const service = await ctx.db.get(serviceId);
    if (!service) throw new Error("That service no longer exists.");
    const before = service.default_labor_hours ?? null;
    if (before === hours) throw new Error(`default_labor_hours is already ${hours}.`);
    await ctx.db.patch(serviceId, { default_labor_hours: hours });
    await logAudit(ctx, actor, {
      entity_type: "service",
      entity_id: String(serviceId),
      action: "default_labor_hours_changed",
      detail: `${service.name}: ${before ?? "—"}h → ${hours}h (multiplies across every shop's pricing) — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

export const upsertOption = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    serviceId: v.id("services"),
    optionId: v.optional(v.id("service_options")),
    option_label: v.string(),
    option_type: v.optional(v.string()),
    labor_hours: v.optional(v.number()),
    state_fee: v.optional(v.number()),
    display_order: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: true; id: string }> => {
    const actor = await requireDirector(ctx, args.token, "data.write");
    if (args.reason.trim().length < 4) throw new Error("A reason is required.");
    if (!args.option_label.trim()) throw new Error("Option label is required.");
    const service = await ctx.db.get(args.serviceId);
    if (!service) throw new Error("That service no longer exists.");
    let id: string;
    let detail: string;
    if (args.optionId) {
      const existing = await ctx.db.get(args.optionId);
      if (!existing || String(existing.service_id) !== String(args.serviceId))
        throw new Error("That option no longer exists on this service.");
      await ctx.db.patch(args.optionId, {
        option_label: args.option_label.trim(),
        option_type: args.option_type,
        labor_hours: args.labor_hours,
        state_fee: args.state_fee,
        display_order: args.display_order,
      });
      id = String(args.optionId);
      detail = `option "${existing.option_label}" updated on ${service.name}`;
    } else {
      id = String(
        await ctx.db.insert("service_options", {
          service_id: args.serviceId,
          option_label: args.option_label.trim(),
          option_type: args.option_type,
          labor_hours: args.labor_hours,
          state_fee: args.state_fee,
          display_order: args.display_order,
        }),
      );
      detail = `option "${args.option_label.trim()}" added to ${service.name}`;
    }
    await logAudit(ctx, actor, {
      entity_type: "service_option",
      entity_id: id,
      action: args.optionId ? "option_updated" : "option_created",
      detail: `${detail} — ${args.reason.trim()}`,
    });
    return { ok: true, id };
  },
});

// --- 7→4 migration card -------------------------------------------------------

export type MigrationStatusResult = {
  executed: boolean;
  executed_at: number | null;
  executed_detail: string | null;
  categories: { name: string; display_order: number | null; services: number }[];
  target_names: string[];
};

export const migrationStatus = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<MigrationStatusResult> => {
    await requireDirector(ctx, token);
    const auditRow = await ctx.db
      .query("audit_log")
      .withIndex("by_entity", (q) =>
        q.eq("entity_type", "service_categories").eq("entity_id", "7to4-consolidation"),
      )
      .order("desc")
      .first();
    const categories = await ctx.db.query("service_categories").collect();
    const services = await ctx.db.query("services").collect();
    const counts = new Map<string, number>();
    for (const s of services) {
      const key = s.service_category_id ? String(s.service_category_id) : "(none)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      executed: auditRow != null,
      executed_at: auditRow?.created_at ?? null,
      executed_detail: auditRow?.detail ?? null,
      categories: categories
        .map((c) => ({
          name: c.name,
          display_order: c.display_order ?? null,
          services: counts.get(String(c._id)) ?? 0,
        }))
        .sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99)),
      target_names: ["Routine", "Tires & Brakes", "Scheduled Service", "Inspections"],
    };
  },
});

export const runCategoryMigration = mutation({
  args: { token: v.string(), reason: v.string(), dryRun: v.boolean() },
  handler: async (ctx, { token, reason, dryRun }): Promise<ConsolidationResult> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const result = await runCategoryConsolidation(ctx, dryRun);
    // The execute path writes its own migration audit row; add the actor's.
    await logAudit(ctx, actor, {
      entity_type: "service_categories",
      entity_id: "7to4-consolidation",
      action: dryRun ? "category_migration_dry_run" : "category_migration_executed",
      detail: `${dryRun ? "dry-run" : "EXECUTED"}: creates=${result.creates.length} moves=${result.moves.length} deletes=${result.deletes.length} — ${reason.trim()}`,
    });
    return result;
  },
});
