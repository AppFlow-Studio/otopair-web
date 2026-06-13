/**
 * director_service_parts — admin queries + mutations for the Service Parts tab.
 *
 * Backs the Director → Service Parts UI. Read/edit parts rules for the 23
 * canonical services (and any future services), pin specific OEM parts to a
 * service-subcategory role, and override the per-vehicle quantity resolver.
 *
 * No auth at the Convex layer — access-controlled at the Next.js middleware
 * level, same pattern as convex/director.ts and convex/directorPricing.ts.
 * All mutations write audit_log entries.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const partsKindValidator = v.union(
  v.literal("labor_only"),
  v.literal("per_axle"),
  v.literal("per_cylinder"),
  v.literal("per_unit_spec"),
  v.literal("per_wheel"),
  v.literal("fixed_kit"),
);

const pinnedPartValidator = v.object({
  subcategory: v.string(),
  part_id: v.id("oem_parts"),
  is_core: v.boolean(),
});

// Allowed engines.* fields for parts_kind='per_unit_spec'. Mirrors the
// allowlist in lib/serviceUnits.ts so silent fallback to baseline can't
// happen due to a typo.
const VALID_SPEC_SOURCES = [
  "oil_capacity_qts",
  "coolant_capacity_qts",
  "transmission_fluid_capacity_qts",
  "differential_fluid_capacity_qts",
] as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const listAllRules = query({
  args: {},
  handler: async (ctx) => {
    const [services, rules, categories] = await Promise.all([
      ctx.db.query("services").collect(),
      ctx.db.query("service_parts_rules").collect(),
      ctx.db.query("service_categories").collect(),
    ]);

    const ruleByService = new Map<string, Doc<"service_parts_rules">>();
    for (const r of rules) ruleByService.set(String(r.service_id), r);

    const categoryById = new Map<string, Doc<"service_categories">>();
    for (const c of categories) categoryById.set(String(c._id), c);

    return services
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      .map((svc) => {
        const rule = ruleByService.get(String(svc._id)) ?? null;
        const category = svc.service_category_id
          ? categoryById.get(String(svc.service_category_id))
          : null;
        return {
          service: {
            id: svc._id,
            name: svc.name,
            slug: svc.slug ?? null,
            category_id: svc.service_category_id ?? null,
            category_name: category?.name ?? null,
            parts_kind: svc.parts_kind ?? null,
            parts_unit_label: svc.parts_unit_label ?? null,
            parts_unit_spec_source: svc.parts_unit_spec_source ?? null,
            default_labor_hours: svc.default_labor_hours ?? null,
          },
          rule: rule
            ? {
                id: rule._id,
                parts_kind: rule.parts_kind,
                parts_unit_label: rule.parts_unit_label ?? null,
                parts_unit_spec_source: rule.parts_unit_spec_source ?? null,
                core_subcategories: rule.core_subcategories,
                as_needed_subcategories: rule.as_needed_subcategories,
                pinned_parts: rule.pinned_parts,
                qty_override: rule.qty_override ?? null,
                updated_at: rule.updated_at,
              }
            : null,
        };
      });
  },
});

export const subcategoryCatalog = query({
  args: {},
  handler: async (ctx) => {
    // Union of every subcategory string referenced anywhere: oem_parts
    // catalog rows + every rule's core / as_needed / pinned arrays. Sorted.
    const [parts, rules] = await Promise.all([
      ctx.db.query("oem_parts").collect(),
      ctx.db.query("service_parts_rules").collect(),
    ]);
    const set = new Set<string>();
    for (const p of parts) if (p.subcategory) set.add(p.subcategory);
    for (const r of rules) {
      for (const s of r.core_subcategories) set.add(s);
      for (const s of r.as_needed_subcategories) set.add(s);
      for (const p of r.pinned_parts) set.add(p.subcategory);
    }
    return Array.from(set).sort();
  },
});

/**
 * Per-subcategory usage stats. Powers the picker UI: shows how many
 * oem_parts rows reference each subcategory, plus which subcategories
 * are already used by at least one service rule (so unknown free-text
 * entries don't get lost on next render).
 */
export const subcategoryUsage = query({
  args: {},
  handler: async (ctx) => {
    const [parts, rules] = await Promise.all([
      ctx.db.query("oem_parts").collect(),
      ctx.db.query("service_parts_rules").collect(),
    ]);
    const oem_parts_count: Record<string, number> = {};
    for (const p of parts) {
      if (!p.subcategory) continue;
      oem_parts_count[p.subcategory] = (oem_parts_count[p.subcategory] ?? 0) + 1;
    }
    const used_in_rules = new Set<string>();
    for (const r of rules) {
      for (const s of r.core_subcategories) used_in_rules.add(s);
      for (const s of r.as_needed_subcategories) used_in_rules.add(s);
      for (const p of r.pinned_parts) used_in_rules.add(p.subcategory);
    }
    return {
      oem_parts_count,
      used_in_rules: Array.from(used_in_rules).sort(),
    };
  },
});

export const partsBySubcategory = query({
  args: {
    subcategory: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cap = Math.min(args.limit ?? 50, 200);
    const rows = await ctx.db
      .query("oem_parts")
      .withIndex("by_subcategory", (q) => q.eq("subcategory", args.subcategory))
      .take(cap);
    return rows.map((p) => ({
      id: p._id,
      oem_part_number: p.oem_part_number,
      name: p.name,
      brand: p.brand ?? null,
      part_tier: p.part_tier ?? null,
      subcategory: p.subcategory ?? null,
    }));
  },
});

export const partsByIds = query({
  args: { ids: v.array(v.id("oem_parts")) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return rows
      .filter((r): r is Doc<"oem_parts"> => r != null)
      .map((p) => ({
        id: p._id,
        oem_part_number: p.oem_part_number,
        name: p.name,
        brand: p.brand ?? null,
        subcategory: p.subcategory ?? null,
      }));
  },
});

export const serviceCategoriesList = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("service_categories").collect();
    return rows
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      .map((c) => ({ id: c._id, name: c.name }));
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function validateSpecSource(
  parts_kind: string,
  spec_source: string | undefined,
): string | null {
  if (parts_kind !== "per_unit_spec") return null;
  if (!spec_source) return "spec_source_required_for_per_unit_spec";
  if (!VALID_SPEC_SOURCES.includes(spec_source as any)) {
    return `invalid_spec_source:${spec_source}`;
  }
  return null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const upsertRule = mutation({
  args: {
    service_id: v.id("services"),
    parts_kind: partsKindValidator,
    parts_unit_label: v.optional(v.string()),
    parts_unit_spec_source: v.optional(v.string()),
    core_subcategories: v.array(v.string()),
    as_needed_subcategories: v.array(v.string()),
    pinned_parts: v.array(pinnedPartValidator),
    qty_override: v.optional(v.number()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const svc = await ctx.db.get(args.service_id);
    if (!svc) return { ok: false as const, reason: "service_not_found" };

    const specErr = validateSpecSource(
      args.parts_kind,
      args.parts_unit_spec_source,
    );
    if (specErr) return { ok: false as const, reason: specErr };

    const now = Date.now();
    const existing = await ctx.db
      .query("service_parts_rules")
      .withIndex("by_service", (q) => q.eq("service_id", args.service_id))
      .first();

    // Keep services row's quantification fields in sync so the runtime
    // resolver in lib/serviceUnits.ts keeps reading from the services doc.
    await ctx.db.patch(args.service_id, {
      parts_kind: args.parts_kind,
      parts_unit_label: args.parts_unit_label ?? undefined,
      parts_unit_spec_source: args.parts_unit_spec_source ?? undefined,
    });

    const payload = {
      service_id: args.service_id,
      parts_kind: args.parts_kind,
      parts_unit_label: args.parts_unit_label ?? undefined,
      parts_unit_spec_source: args.parts_unit_spec_source ?? undefined,
      core_subcategories: args.core_subcategories,
      as_needed_subcategories: args.as_needed_subcategories,
      pinned_parts: args.pinned_parts,
      qty_override: args.qty_override,
      updated_at: now,
    };

    let ruleId: Id<"service_parts_rules">;
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      ruleId = existing._id;
    } else {
      ruleId = await ctx.db.insert("service_parts_rules", payload);
    }

    await ctx.db.insert("audit_log", {
      entity_type: "service_parts_rule",
      entity_id: String(ruleId),
      action: existing ? "field_edit" : "create",
      actor: args.actorName,
      actor_id: args.actorId,
      detail:
        `${svc.name} · kind=${args.parts_kind}` +
        ` · core=${args.core_subcategories.length}` +
        ` · as_needed=${args.as_needed_subcategories.length}` +
        ` · pinned=${args.pinned_parts.length}` +
        (args.qty_override != null ? ` · qty_override=${args.qty_override}` : ""),
      created_at: now,
    });

    return { ok: true as const, id: ruleId };
  },
});

export const createService = mutation({
  args: {
    name: v.string(),
    slug: v.optional(v.string()),
    service_category_id: v.optional(v.id("service_categories")),
    default_labor_hours: v.optional(v.number()),
    parts_kind: partsKindValidator,
    parts_unit_label: v.optional(v.string()),
    parts_unit_spec_source: v.optional(v.string()),
    core_subcategories: v.array(v.string()),
    as_needed_subcategories: v.array(v.string()),
    pinned_parts: v.array(pinnedPartValidator),
    qty_override: v.optional(v.number()),
    actorName: v.string(),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) return { ok: false as const, reason: "name_required" };

    const slug = (args.slug?.trim() || slugify(name)).toLowerCase();
    if (!slug) return { ok: false as const, reason: "slug_required" };

    const existing = await ctx.db
      .query("services")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (existing) return { ok: false as const, reason: "slug_taken" };

    const specErr = validateSpecSource(
      args.parts_kind,
      args.parts_unit_spec_source,
    );
    if (specErr) return { ok: false as const, reason: specErr };

    const now = Date.now();
    const serviceId = await ctx.db.insert("services", {
      name,
      slug,
      service_category_id: args.service_category_id,
      default_labor_hours: args.default_labor_hours,
      is_labor_only: args.parts_kind === "labor_only",
      parts_kind: args.parts_kind,
      parts_unit_label: args.parts_unit_label ?? undefined,
      parts_unit_spec_source: args.parts_unit_spec_source ?? undefined,
      created_at: now,
    });

    const ruleId = await ctx.db.insert("service_parts_rules", {
      service_id: serviceId,
      parts_kind: args.parts_kind,
      parts_unit_label: args.parts_unit_label ?? undefined,
      parts_unit_spec_source: args.parts_unit_spec_source ?? undefined,
      core_subcategories: args.core_subcategories,
      as_needed_subcategories: args.as_needed_subcategories,
      pinned_parts: args.pinned_parts,
      qty_override: args.qty_override,
      updated_at: now,
    });

    await ctx.db.insert("audit_log", {
      entity_type: "service",
      entity_id: String(serviceId),
      action: "create",
      actor: args.actorName,
      actor_id: args.actorId,
      detail: `New service: ${name} (${slug}) · kind=${args.parts_kind}`,
      created_at: now,
    });

    return { ok: true as const, service_id: serviceId, rule_id: ruleId };
  },
});
