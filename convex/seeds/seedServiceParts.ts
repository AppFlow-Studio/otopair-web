/**
 * seedServiceParts — classify each canonical service per the May 2026
 * Service Parts Reference PDF (`Otopair Service Parts Reference.pdf`).
 *
 * Sets three fields on each `services` row, keyed by slug:
 *   - parts_kind            (scaling rule the engine uses)
 *   - parts_unit_label      (display copy: "axle" | "cyl" | "qt" | ...)
 *   - parts_unit_spec_source (engines.* field for per_unit_spec; else null)
 *
 * Idempotent on slug — re-runs upsert in place. Run order: AFTER
 * seedServiceCategories (which sets parts_multiplier_category_id), BEFORE
 * seedCamryBaseline (which stamps parts_baseline_unit_count on each
 * service_vehicle_specs row, matching parts_kind expectations).
 *
 *   npx convex run seeds/seedServiceParts:run
 */

import { internalMutation } from "../_generated/server";

type PartsKind =
  | "labor_only"
  | "per_axle"
  | "per_cylinder"
  | "per_unit_spec"
  | "per_wheel"
  | "fixed_kit";

type ServiceSpec = {
  slug: string;
  parts_kind: PartsKind;
  parts_unit_label: string | null;
  parts_unit_spec_source?: string;
};

// Authoritative mapping — 23 canonical services per the PDF.
const SPECS: ServiceSpec[] = [
  // ── Labor-only — no parts on the invoice (8 svcs) ────────────────────
  { slug: "diagnostic_scan",         parts_kind: "labor_only",     parts_unit_label: null },
  { slug: "pre_purchase_inspection", parts_kind: "labor_only",     parts_unit_label: null },
  { slug: "check_engine_light",      parts_kind: "labor_only",     parts_unit_label: null },
  { slug: "state_inspection",        parts_kind: "labor_only",     parts_unit_label: null },
  { slug: "emissions_test",          parts_kind: "labor_only",     parts_unit_label: null },
  { slug: "battery_test",            parts_kind: "labor_only",     parts_unit_label: null },
  { slug: "tire_rotation",           parts_kind: "labor_only",     parts_unit_label: null },
  { slug: "wheel_alignment",         parts_kind: "labor_only",     parts_unit_label: null },

  // ── Per-axle — booking position drives count (1 or 2) ────────────────
  { slug: "brake_pad_replacement",   parts_kind: "per_axle",       parts_unit_label: "axle" },
  { slug: "rotor_replacement",       parts_kind: "per_axle",       parts_unit_label: "axle" },

  // ── Per-cylinder — engines.spark_plug_quantity ───────────────────────
  { slug: "spark_plugs",             parts_kind: "per_cylinder",   parts_unit_label: "cyl" },

  // ── Per-unit-spec — engine capacity field ────────────────────────────
  // oil_change moved out of per_unit_spec on 2026-06-09: shops provide
  // engine oil from stock, so the only billable part is the oil_filter
  // (single piece). Scaling by oil_capacity_qts was multiplying the filter
  // price by 5.5×, producing the "$110/qt" bug. Treat oil_change as a
  // fixed_kit instead — one filter, one price, no spec scaling.
  { slug: "coolant_flush",           parts_kind: "per_unit_spec",  parts_unit_label: "qt", parts_unit_spec_source: "coolant_capacity_qts" },
  { slug: "transmission_service",    parts_kind: "per_unit_spec",  parts_unit_label: "qt", parts_unit_spec_source: "transmission_fluid_capacity_qts" },
  // differential_service converted from fixed_kit (2026-07): gear-oil volume
  // varies ~0.5-4 qt across vehicles. Capacity resolves from enriched
  // drivetrain_configs.diff_fluid_capacity_qts first, then the engines column
  // (director edits). Camry baseline_unit_count MUST be re-stamped to 2 (its
  // $42-48 band represents 2 qt) — see seedCamryBaseline.
  { slug: "differential_service",    parts_kind: "per_unit_spec",  parts_unit_label: "qt", parts_unit_spec_source: "differential_fluid_capacity_qts" },

  // ── Per-wheel — fixed 4 ──────────────────────────────────────────────
  { slug: "tire_balance",            parts_kind: "per_wheel",      parts_unit_label: "wheel" },
  { slug: "tire_replacement",        parts_kind: "per_wheel",      parts_unit_label: "wheel" },

  // ── Fixed kit — 1 service = 1 kit (system capacity doesn't vary
  //                materially across cars; the kit IS the scaling unit) ─
  { slug: "oil_change",              parts_kind: "fixed_kit",      parts_unit_label: "filter" },
  { slug: "filter_replacement",      parts_kind: "fixed_kit",      parts_unit_label: "kit" },
  { slug: "timing_belt",             parts_kind: "fixed_kit",      parts_unit_label: "kit" },
  { slug: "battery_replacement",     parts_kind: "fixed_kit",      parts_unit_label: "kit" },
  { slug: "brake_fluid_flush",       parts_kind: "fixed_kit",      parts_unit_label: "kit" },
  { slug: "power_steering_flush",    parts_kind: "fixed_kit",      parts_unit_label: "kit" },
  { slug: "fuel_system_cleaning",    parts_kind: "fixed_kit",      parts_unit_label: "kit" },
];

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    let updated = 0;
    let inserted_default_when_missing = 0;
    const missing_services: string[] = [];

    for (const spec of SPECS) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", spec.slug))
        .first();
      if (!svc) {
        missing_services.push(spec.slug);
        continue;
      }
      await ctx.db.patch(svc._id, {
        parts_kind: spec.parts_kind,
        parts_unit_label: spec.parts_unit_label ?? undefined,
        parts_unit_spec_source: spec.parts_unit_spec_source ?? undefined,
      });
      updated += 1;
    }

    return {
      total_specs: SPECS.length,
      updated,
      inserted_default_when_missing,
      missing_services,
    };
  },
});
