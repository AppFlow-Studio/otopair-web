/**
 * seedServicePartsRules — populate `service_parts_rules` for the 23 canonical
 * services per the May 2026 Service Parts Reference PDF (`Otopair Service
 * Parts Reference.pdf`).
 *
 * Per service, sets:
 *   - parts_kind / parts_unit_label / parts_unit_spec_source — also patched
 *     onto the `services` row so the runtime resolver in lib/serviceUnits.ts
 *     keeps reading from the services doc unchanged
 *   - core_subcategories       — the "Core — on essentially every invoice" list
 *   - as_needed_subcategories  — the situational discovery items
 *   - pinned_parts             — initialized empty; director picks via UI
 *   - qty_override             — null; director sets via UI when needed
 *
 * Idempotent on service slug — re-runs upsert in place. Run AFTER
 * seedServiceParts so the services rows exist with the quantification fields.
 *
 *   npx convex run seeds/seedServicePartsRules:run
 */

import { internalMutation } from "../_generated/server";

type PartsKind =
  | "labor_only"
  | "per_axle"
  | "per_cylinder"
  | "per_unit_spec"
  | "per_wheel"
  | "fixed_kit";

type ServiceRuleSpec = {
  slug: string;
  parts_kind: PartsKind;
  parts_unit_label: string | null;
  parts_unit_spec_source?: string;
  core: string[];
  as_needed: string[];
};

// Authoritative mapping — 23 canonical services from the PDF.
// Subcategory strings match oem_parts.subcategory conventions
// (lowercase_snake_case).
const SPECS: ServiceRuleSpec[] = [
  // ── Labor-only — no parts on the invoice (8 services) ──────────────
  { slug: "diagnostic_scan",         parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: [] },
  { slug: "pre_purchase_inspection", parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: [] },
  { slug: "check_engine_light",      parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: [] },
  { slug: "state_inspection",        parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: [] },
  { slug: "emissions_test",          parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: [] },
  { slug: "battery_test",            parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: [] },
  { slug: "tire_rotation",           parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: [] },
  { slug: "wheel_alignment",         parts_kind: "labor_only", parts_unit_label: null, core: [], as_needed: ["alignment_bolt_kit"] },

  // ── Parts-bearing services ─────────────────────────────────────────

  // 6 · Oil Change — fixed_kit (the oil filter IS the scaling unit; oil
  //                  is shop stock, not a billable line)
  {
    slug: "oil_change",
    parts_kind: "fixed_kit", parts_unit_label: "filter",
    core: ["oil_filter"],
    as_needed: ["drain_plug_gasket", "oil_filter_housing_oring"],
  },

  // 7 · Filter Replacement (air + cabin)
  {
    slug: "filter_replacement",
    parts_kind: "fixed_kit", parts_unit_label: "kit",
    core: ["air_filter", "cabin_filter"],
    as_needed: [],
  },

  // 8 · Spark Plugs — per_cylinder
  {
    slug: "spark_plugs",
    parts_kind: "per_cylinder", parts_unit_label: "cyl",
    core: ["spark_plug"],
    as_needed: ["ignition_coil", "intake_manifold_gasket"],
  },

  // 9 · Timing Belt — bundled kit
  {
    slug: "timing_belt",
    parts_kind: "fixed_kit", parts_unit_label: "kit",
    core: ["timing_belt", "timing_kit", "belt_tensioner", "idler_pulley", "camshaft_seal", "crankshaft_seal"],
    as_needed: ["water_pump", "coolant", "serpentine_belt"],
  },

  // 10 · Coolant Flush — per_unit_spec on coolant_capacity_qts
  {
    slug: "coolant_flush",
    parts_kind: "per_unit_spec", parts_unit_label: "qt",
    parts_unit_spec_source: "coolant_capacity_qts",
    core: ["coolant"],
    as_needed: ["coolant_flush_chemical", "thermostat", "thermostat_gasket"],
  },

  // 11 · Transmission Service — per_unit_spec on transmission_fluid_capacity_qts
  {
    slug: "transmission_service",
    parts_kind: "per_unit_spec", parts_unit_label: "qt",
    parts_unit_spec_source: "transmission_fluid_capacity_qts",
    core: ["atf_fluid", "drain_plug_gasket"],
    as_needed: ["trans_filter", "trans_pan_gasket", "cvt_internal_filter", "cvt_external_filter"],
  },

  // 13 · Tire Balance — per_wheel (only wheel weights are consumable)
  {
    slug: "tire_balance",
    parts_kind: "per_wheel", parts_unit_label: "wheel",
    core: ["wheel_weights"],
    as_needed: [],
  },

  // 15 · Tire Replacement — per_wheel
  {
    slug: "tire_replacement",
    parts_kind: "per_wheel", parts_unit_label: "wheel",
    core: ["tire", "tpms_valve_kit", "wheel_weights", "tire_disposal"],
    as_needed: [],
  },

  // 16 · Brake Pad Replacement — per_axle
  {
    slug: "brake_pad_replacement",
    parts_kind: "per_axle", parts_unit_label: "axle",
    core: ["front_brake_pad", "rear_brake_pad", "caliper_grease"],
    as_needed: [
      "front_brake_hardware_kit", "rear_brake_hardware_kit",
      "front_brake_wear_sensor", "rear_brake_wear_sensor",
    ],
  },

  // 17 · Rotor Replacement — per_axle (rotors + pads together)
  {
    slug: "rotor_replacement",
    parts_kind: "per_axle", parts_unit_label: "axle",
    core: ["front_rotor", "rear_rotor", "front_brake_pad", "rear_brake_pad", "caliper_grease"],
    as_needed: [
      "front_brake_hardware_kit", "rear_brake_hardware_kit",
      "front_brake_wear_sensor", "rear_brake_wear_sensor",
    ],
  },

  // 18 · Brake Fluid Flush — fluid only
  {
    slug: "brake_fluid_flush",
    parts_kind: "fixed_kit", parts_unit_label: "kit",
    core: ["brake_fluid"],
    as_needed: [],
  },

  // 20 · Battery Replacement
  {
    slug: "battery_replacement",
    parts_kind: "fixed_kit", parts_unit_label: "kit",
    core: ["battery"],
    as_needed: ["terminal_protection"],
  },

  // 21 · Power Steering Flush
  {
    slug: "power_steering_flush",
    parts_kind: "fixed_kit", parts_unit_label: "kit",
    core: ["ps_fluid"],
    as_needed: ["ps_reservoir_filter", "reservoir_cap_oring"],
  },

  // 22 · Differential Service
  {
    slug: "differential_service",
    parts_kind: "fixed_kit", parts_unit_label: "kit",
    core: ["gear_oil", "drain_plug_gasket"],
    as_needed: ["friction_modifier", "diff_cover_gasket"],
  },

  // 23 · Fuel System / Induction Service — parts scale with depth of service
  {
    slug: "fuel_system_cleaning",
    parts_kind: "fixed_kit", parts_unit_label: "kit",
    core: ["fuel_system_cleaner"],
    as_needed: ["throttle_cleaner", "walnut_media", "intake_manifold_gasket", "throttle_body_cleaner"],
  },
];

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    let inserted = 0;
    let updated = 0;
    const missing_services: string[] = [];
    const now = Date.now();

    for (const spec of SPECS) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", spec.slug))
        .first();
      if (!svc) {
        missing_services.push(spec.slug);
        continue;
      }

      // Keep services row in sync so the runtime resolver (serviceUnits.ts)
      // continues to read from the services doc without a join.
      await ctx.db.patch(svc._id, {
        parts_kind: spec.parts_kind,
        parts_unit_label: spec.parts_unit_label ?? undefined,
        parts_unit_spec_source: spec.parts_unit_spec_source ?? undefined,
      });

      const existing = await ctx.db
        .query("service_parts_rules")
        .withIndex("by_service", (q) => q.eq("service_id", svc._id))
        .first();

      const payload = {
        service_id: svc._id,
        parts_kind: spec.parts_kind,
        parts_unit_label: spec.parts_unit_label ?? undefined,
        parts_unit_spec_source: spec.parts_unit_spec_source ?? undefined,
        core_subcategories: spec.core,
        as_needed_subcategories: spec.as_needed,
        pinned_parts: existing?.pinned_parts ?? [],
        qty_override: existing?.qty_override,
        updated_at: now,
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated += 1;
      } else {
        await ctx.db.insert("service_parts_rules", payload);
        inserted += 1;
      }
    }

    return {
      total_specs: SPECS.length,
      inserted,
      updated,
      missing_services,
    };
  },
});
