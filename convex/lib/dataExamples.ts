// =============================================================================
// Canonical example response fragments — real 2019 Honda CR-V EX data. ONE
// source of truth shared by the OpenAPI spec (convex/openapi.ts) and the
// interactive playground (/developers/docs/quickstart), so the machine spec,
// the rendered reference, and the "try it" sample previews can never drift.
//
// Pure data module: no server imports, safe for both the Convex bundle and the
// Next.js client bundle. Keep in lockstep with convex/dataApi.ts response shapes.
// =============================================================================
import { LAYER_FORMULA } from "./dataLayers";

export const CONFIG_EX = {
  config_key: "2019_honda_cr_v_ex_l15be",
  year: 2019,
  make: "Honda",
  model: "CR-V",
  trim: "EX",
  chassis_code: "RW",
  drivetrain: "4WD",
  engine: { label: "1.5L L15BE 4cyl", code: "L15BE", cylinders: 4, displacement_l: 1.5, aspiration: "natural", fuel_injection: "direct" },
  transmission: "CVT",
  enrichment: { status: "complete", fill_rate: 92, confidence_avg: 0.83 },
};

export const FLUID_FIELDS_EX = [
  { field: "oil_viscosity", label: "Oil viscosity", group: "Fluids", value: "0W-20", layer: "C", confidence: 0.9, source_domain: "hondainfo.com" },
  { field: "oil_capacity_qts", label: "Oil capacity (qts)", group: "Fluids", value: "3.7", layer: "C", confidence: 0.9, source_domain: "hondainfo.com" },
  { field: "coolant_type", label: "Coolant type", group: "Fluids", value: "Honda Long Life Antifreeze/Coolant Type 2", layer: "C", confidence: 0.88, source_domain: "crvowners.com" },
  { field: "diff_fluid_type", label: "Differential fluid", group: "Fluids", value: "Honda Dual Pump Fluid II (DPSF-II)", layer: "C", confidence: 0.8, source_domain: "hondapartsnow.com" },
];

export const CHASSIS_FIELDS_EX = [
  { field: "lug_nut_torque_ft_lbs", label: "Lug nut torque (ft-lbs)", group: "Chassis", value: "80", layer: "C", confidence: 0.85, source_domain: "hondainfo.com" },
  { field: "battery_group", label: "Battery group", group: "Chassis", value: "51R", layer: "C", confidence: 0.8, source_domain: "batterieplus.com" },
  { field: "front_wiper_size", label: "Front wiper size (in)", group: "Chassis", value: "26", layer: "C", confidence: 0.8, source_domain: "wiperblades.com" },
  { field: "steering_type", label: "Steering type", group: "Chassis", value: "electric", layer: "C", confidence: null, source_domain: null },
];

export const META_EX = {
  gate: "A+C+D+E served (incl. stored values without an evidence trail, tagged C). B (licensed DB, except public NHTSA) and X excluded and listed.",
  layer_formula: LAYER_FORMULA,
  generated_at: 1787174247134,
};

export const TIRES_EX = {
  options: [{ oem_name: "235/60R18", size_front: "235/60R18", size_rear: "235/60R18", pressure_front_psi: 33, pressure_rear_psi: 30, load_index: 103, speed_rating: "H", is_oem_standard: true }],
  front_size: "235/60R18", rear_size: "235/60R18", pressure_front_psi: 33, pressure_rear_psi: 30, is_staggered: false, is_run_flat: false, battery_cca: 400, source: "https://www.wheel-size.com/size/honda/cr-v/2019/",
};

export const INTERVALS_EX = [
  { service: "oil-change", name: "Oil Change", interval_miles: 7500, interval_months: 12, display: "7,500 mi / 12 mo", confidence: 0.9, mechanic_verified: false },
  { service: "tire-rotation", name: "Tire Rotation", interval_miles: 7500, interval_months: 6, display: "7,500 mi / 6 mo", confidence: 0.7, mechanic_verified: false },
];

export const SERVICE_ENTRY_EX = {
  service: "front-brake-pads", name: "Front Brake Pads", applicable: true,
  parts: [{ oem_part_number: "45022-TLA-A01", name: "Front Brake Pads", subcategory: "front_brake_pad", role: "core", position: "front", quantity: 1, mechanic_verified: false, confidence: 0.7, price: { amount: 62.4, msrp: 84.13, source_domain: "hondapartsnow.com", as_of: 1787174000000 } }],
  labor: { hours: 1.1, source: "model_estimate", confidence: 0.3, sample_size: null, tier_floor_applied: false },
};
