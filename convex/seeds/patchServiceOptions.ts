import { internalMutation } from "../_generated/server";

/**
 * After `seedServices` runs, this patches the services that need a
 * per-service options picker (axle position for brakes, filter type
 * for filters) — the canonical seed leaves `has_options: false`.
 *
 * 1. Wipes ALL existing service_options rows (orphans pointing at
 *    deleted service IDs from the prior hyphenated seed).
 * 2. Flips `has_options: true` on rotor_replacement, brake_pad_replacement,
 *    filter_replacement.
 * 3. Inserts the canonical options that originally lived in
 *    `convex/seed.ts` (older seed file, pre-underscored slugs).
 *
 * Run via: npx convex run seeds/patchServiceOptions:patchServiceOptions
 */
export const patchServiceOptions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orphans = await ctx.db.query("service_options").collect();
    for (const row of orphans) await ctx.db.delete(row._id);

    const services = await ctx.db.query("services").collect();
    const bySlug = new Map(services.map((s) => [s.slug, s]));

    const brakePad = bySlug.get("brake_pad_replacement");
    const rotor = bySlug.get("rotor_replacement");
    const filter = bySlug.get("filter_replacement");

    if (!brakePad || !rotor || !filter) {
      throw new Error(
        `Missing services. brakePad=${!!brakePad} rotor=${!!rotor} filter=${!!filter}`,
      );
    }

    await ctx.db.patch(brakePad._id, { has_options: true });
    await ctx.db.patch(rotor._id, { has_options: true });
    await ctx.db.patch(filter._id, { has_options: true });

    const brakePadOpts = [
      { option_label: "Front only", parts_cost_low: 75, parts_cost_high: 95, labor_hours: 0.8, display_order: 1 },
      { option_label: "Rear only", parts_cost_low: 55, parts_cost_high: 75, labor_hours: 0.8, display_order: 2 },
      { option_label: "Both (front + rear)", parts_cost_low: 130, parts_cost_high: 170, labor_hours: 1.5, display_order: 3 },
    ];
    for (const opt of brakePadOpts) {
      await ctx.db.insert("service_options", {
        service_id: brakePad._id,
        option_type: "axle_position",
        ...opt,
      });
    }

    const rotorOpts = [
      { option_label: "Front only", parts_cost_low: 200, parts_cost_high: 260, labor_hours: 1.2, display_order: 1 },
      { option_label: "Rear only", parts_cost_low: 170, parts_cost_high: 220, labor_hours: 1.2, display_order: 2 },
      { option_label: "Both", parts_cost_low: 370, parts_cost_high: 480, labor_hours: 2.2, display_order: 3 },
    ];
    for (const opt of rotorOpts) {
      await ctx.db.insert("service_options", {
        service_id: rotor._id,
        option_type: "axle_position",
        ...opt,
      });
    }

    const filterOpts = [
      { option_label: "Engine air filter only", parts_cost_low: 15, parts_cost_high: 30, labor_hours: 0.15, display_order: 1 },
      { option_label: "Cabin air filter only", parts_cost_low: 15, parts_cost_high: 25, labor_hours: 0.25, display_order: 2 },
      { option_label: "Both", parts_cost_low: 25, parts_cost_high: 50, labor_hours: 0.35, display_order: 3 },
    ];
    for (const opt of filterOpts) {
      await ctx.db.insert("service_options", {
        service_id: filter._id,
        option_type: "filter_type",
        ...opt,
      });
    }

    console.log(
      `Patched. Wiped ${orphans.length} orphan options. Inserted ${brakePadOpts.length + rotorOpts.length + filterOpts.length} fresh options across 3 services.`,
    );
    return {
      orphansWiped: orphans.length,
      brakePadOptions: brakePadOpts.length,
      rotorOptions: rotorOpts.length,
      filterOptions: filterOpts.length,
    };
  },
});
