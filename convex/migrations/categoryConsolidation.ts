// 7→4 service-category consolidation (portal decision #5, resolved Jul 13:
// the four names come from the app — Routine · Tires & Brakes · Scheduled
// Service · Inspections).
//
// Idempotent + dry-run-first:
//   npx convex run migrations/categoryConsolidation:migrate '{"dryRun":true}'
//   npx convex run migrations/categoryConsolidation:migrate '{}'
//
// Never point this at --prod without a plan: prod holds its own 7 category
// rows with prod-local IDs; this migration handles that (it keys everything
// by name/slug, not by ID) but prod execution should ride with the seeding
// cutover, per the implementation plan.
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";

// Target taxonomy. display_order = app tab order.
const TARGETS: { name: string; icon_name: string; display_order: number }[] = [
  { name: "Routine", icon_name: "wrench", display_order: 1 },
  { name: "Tires & Brakes", icon_name: "disc", display_order: 2 },
  { name: "Scheduled Service", icon_name: "calendar-check", display_order: 3 },
  { name: "Inspections", icon_name: "scan-search", display_order: 4 },
];

// Every live service slug maps explicitly; the migration REFUSES to run if it
// finds a service outside this map (a new service must be placed on purpose).
// Judgment calls (were flagged for Yassin in the audit):
//   battery_test        → Inspections    (it is a test, not a replacement)
//   battery_replacement → Routine        (common as-needed quick job)
//   brake_fluid_flush   → Tires & Brakes (brake work beats fluid work)
//   timing_belt         → Scheduled Service (mileage-interval job)
//   pre_purchase_inspection → Inspections
const SERVICE_TO_CATEGORY: Record<string, string> = {
  // Routine — frequent quick services
  oil_change: "Routine",
  filter_replacement: "Routine",
  battery_replacement: "Routine",
  // Tires & Brakes
  tire_rotation: "Tires & Brakes",
  tire_balance: "Tires & Brakes",
  tire_replacement: "Tires & Brakes",
  wheel_alignment: "Tires & Brakes",
  brake_pad_replacement: "Tires & Brakes",
  rotor_replacement: "Tires & Brakes",
  brake_fluid_flush: "Tires & Brakes",
  // Scheduled Service — mileage/interval work
  coolant_flush: "Scheduled Service",
  transmission_service: "Scheduled Service",
  spark_plugs: "Scheduled Service",
  timing_belt: "Scheduled Service",
  differential_service: "Scheduled Service",
  power_steering_flush: "Scheduled Service",
  fuel_system_cleaning: "Scheduled Service",
  // Inspections — tests, scans, compliance
  diagnostic_scan: "Inspections",
  check_engine_light: "Inspections",
  pre_purchase_inspection: "Inspections",
  state_inspection: "Inspections",
  emissions_test: "Inspections",
  battery_test: "Inspections",
};

export type ConsolidationResult = {
  dryRun: boolean;
  creates: string[];
  moves: { slug: string; from: string; to: string }[];
  deletes: string[];
  services?: number;
};

/** The migration body, extracted so the Service Catalog portal page can run
 *  the same logic (dry-run diff + execute) through a gated mutation without
 *  the scheduler. Behavior-identical to the original internalMutation. */
export async function runCategoryConsolidation(
  ctx: MutationCtx,
  dryRun: boolean,
): Promise<ConsolidationResult> {
  {
    const services = await ctx.db.query("services").collect();
    const categories = await ctx.db.query("service_categories").collect();
    const categoryNameById = new Map(categories.map((c) => [String(c._id), c.name]));
    const targetNames = new Set(TARGETS.map((t) => t.name));

    // Safety: every service must be mapped (slug is optional in the schema —
    // a slugless service is unmapped by definition).
    const unmapped = services.filter((s) => !s.slug || !SERVICE_TO_CATEGORY[s.slug]);
    if (unmapped.length > 0) {
      throw new Error(
        `Refusing to migrate: unmapped service slugs ${unmapped.map((s) => s.slug).join(", ")} — ` +
          "add them to SERVICE_TO_CATEGORY deliberately.",
      );
    }

    const moves: { slug: string; from: string; to: string }[] = [];
    for (const s of services) {
      const from = categoryNameById.get(String(s.service_category_id)) ?? "(none)";
      const to = SERVICE_TO_CATEGORY[s.slug!];
      if (from !== to) moves.push({ slug: s.slug!, from, to });
    }
    const creates = TARGETS.filter((t) => !categories.some((c) => c.name === t.name)).map(
      (t) => t.name,
    );
    const deletes = categories
      .filter((c) => !targetNames.has(c.name))
      .map((c) => `${c.name}${c.display_order === 99 ? " (phantom)" : ""}`);

    if (dryRun) {
      return { dryRun: true, creates, moves, deletes, services: services.length };
    }

    // 1. Upsert the four targets.
    const targetIdByName = new Map<string, import("../_generated/dataModel").Id<"service_categories">>();
    for (const t of TARGETS) {
      const existing = categories.find((c) => c.name === t.name);
      if (existing) {
        await ctx.db.patch(existing._id, {
          icon_name: t.icon_name,
          display_order: t.display_order,
        });
        targetIdByName.set(t.name, existing._id);
      } else {
        targetIdByName.set(t.name, await ctx.db.insert("service_categories", t));
      }
    }

    // 2. Re-point every service.
    for (const s of services) {
      const targetId = targetIdByName.get(SERVICE_TO_CATEGORY[s.slug!])!;
      if (String(s.service_category_id) !== String(targetId)) {
        await ctx.db.patch(s._id, { service_category_id: targetId });
      }
    }

    // 3. Delete the old categories (all services are re-pointed above, so no
    //    orphaning is possible; the phantom "Maintenance" dies here too).
    for (const c of categories) {
      if (!targetNames.has(c.name)) await ctx.db.delete(c._id);
    }

    await ctx.db.insert("audit_log", {
      entity_type: "service_categories",
      entity_id: "7to4-consolidation",
      action: "category_migration",
      actor: "system:categoryConsolidation-migration",
      detail: `creates=${creates.join("|")} moves=${moves.length} deletes=${deletes.join("|")}`,
      created_at: Date.now(),
    });

    return { dryRun: false, creates, moves, deletes };
  }
}

export const migrate = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }): Promise<ConsolidationResult> =>
    runCategoryConsolidation(ctx, dryRun),
});
