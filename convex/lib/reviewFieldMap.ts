// =============================================================================
// convex/lib/reviewFieldMap.ts — single source of truth for "which table does
// a sanity-flag field name actually live in", shared by:
//   - directorConfigActions.resolveReviewField (writes a director's approve/
//     adjust decision)
//   - dataOverview / directorEnrichment (reads the CURRENT stored value so
//     the review-resolve modal can show "scraped value: X" next to the flag)
//
// Reverse-engineered from vehicleEnrichment/v3pipeline.ts's writeNormalizedData
// / v3mutations.ts (the pipeline's own finalize writer). Two things to know
// before extending this map:
//   - Several fields are DUAL-WRITTEN by the pipeline (brake/ps fluid
//     capacity → vehicle_configs AND chassis_specs; lug torque + battery type
//     → trim_specs AND chassis_specs). This map only targets the canonical
//     copy (vehicle_configs / trim_specs) — the chassis_specs mirror can be
//     corrected separately from the Vehicle Config modal's chassis editor.
//   - `air_filter_miles` and `cabin_filter_miles` share ONE service_intervals
//     row (both map to the `filter_replacement` service) — adjusting either
//     overwrites that row's interval_miles.
// =============================================================================
import { INTERVAL_TO_SERVICE } from "../vehicleEnrichment/v3pipeline";

export type FieldTarget =
  | { t: "engine"; col: string }
  | { t: "vehicle_config"; col: string }
  | { t: "chassis_specs"; col: string }
  | { t: "transmission"; col: string }
  | { t: "trim_specs"; col: string }
  | { t: "drivetrain_config"; col: string }
  | { t: "service_interval"; unit: "miles" | "months"; slug: string };

export type FieldSpec = { valueType: "number" | "string"; targets: FieldTarget[] };

export const FIELD_SPECS: Record<string, FieldSpec> = {
  // engines
  oil_capacity_qts:        { valueType: "number", targets: [{ t: "engine", col: "oil_capacity_qts" }] },
  coolant_capacity_qts:    { valueType: "number", targets: [{ t: "engine", col: "coolant_capacity_qts" }] },
  oil_viscosity:           { valueType: "string", targets: [{ t: "engine", col: "oil_viscosity" }] },
  spark_plug_quantity:     { valueType: "number", targets: [{ t: "engine", col: "spark_plug_quantity" }] },
  spark_plug_gap:          { valueType: "number", targets: [{ t: "engine", col: "spark_plug_gap_mm" }] },
  timing_system:           { valueType: "string", targets: [{ t: "engine", col: "timing_system" }] },
  fuel_injection_type:     { valueType: "string", targets: [{ t: "engine", col: "fuel_injection" }] },
  // transmissions
  transmission_fluid_capacity_qts: { valueType: "number", targets: [{ t: "transmission", col: "fluid_capacity_drain_fill_qts" }] },
  transmission_type:       { valueType: "string", targets: [{ t: "transmission", col: "type" }] },
  // drivetrain_configs
  diff_fluid_capacity_qts:          { valueType: "number", targets: [{ t: "drivetrain_config", col: "diff_fluid_capacity_qts" }] },
  transfer_case_fluid_capacity_qts: { valueType: "number", targets: [{ t: "drivetrain_config", col: "tc_fluid_capacity_qts" }] },
  // vehicle_configs (canonical copy)
  drivetrain:               { valueType: "string", targets: [{ t: "vehicle_config", col: "drivetrain" }] },
  brake_fluid_capacity_oz:  { valueType: "number", targets: [{ t: "vehicle_config", col: "brake_fluid_capacity_oz" }] },
  ps_fluid_capacity_oz:     { valueType: "number", targets: [{ t: "vehicle_config", col: "ps_fluid_capacity_oz" }] },
  // Rotor DISCARD minimums — the replace-at number the inspection grades
  // against. This is the ONLY interactive path that can fill one, because
  // resolveReviewField requires a source URL; the extraction paths that don't
  // carry a quotable label are blocked upstream (getNullFields). Resolving one
  // here stamps quality "director_verified" and adds the column to
  // vehicle_configs.verified_fields so the next re-enrich cannot clobber it.
  // NEVER map the nominal here — it is not a minimum and is never graded.
  rotor_front_min_thickness_mm: { valueType: "number", targets: [{ t: "vehicle_config", col: "rotor_front_min_thickness_mm" }] },
  rotor_rear_min_thickness_mm:  { valueType: "number", targets: [{ t: "vehicle_config", col: "rotor_rear_min_thickness_mm" }] },
  // trim_specs
  lug_nut_torque_ft_lbs:    { valueType: "number", targets: [{ t: "trim_specs", col: "lug_nut_torque_ft_lbs" }] },
  tire_pressure_front_psi:  { valueType: "number", targets: [{ t: "trim_specs", col: "recommended_tire_pressure_front_psi" }] },
  tire_pressure_rear_psi:   { valueType: "number", targets: [{ t: "trim_specs", col: "recommended_tire_pressure_rear_psi" }] },
  battery_cca:              { valueType: "number", targets: [{ t: "trim_specs", col: "battery_cca" }] },
  battery_type:             { valueType: "string", targets: [{ t: "trim_specs", col: "battery_type" }] },
  // chassis_specs
  parking_brake_type:       { valueType: "string", targets: [{ t: "chassis_specs", col: "parking_brake_type" }] },
};
// Maintenance-interval fields (oil_change_miles, spark_plug_miles, …) — one
// service_intervals row per (vehicle_config, service), derived from the same
// prefix→slug map the pipeline itself writes from.
for (const [prefix, slug] of Object.entries(INTERVAL_TO_SERVICE)) {
  FIELD_SPECS[`${prefix}_miles`] = { valueType: "number", targets: [{ t: "service_interval", unit: "miles", slug }] };
  FIELD_SPECS[`${prefix}_months`] = { valueType: "number", targets: [{ t: "service_interval", unit: "months", slug }] };
}
