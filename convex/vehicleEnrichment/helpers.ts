/**
 * vehicleEnrichment/helpers.ts — Shared types and utilities
 *
 * Central type definitions for the vehicle enrichment pipeline.
 * Every other module in this directory imports from here.
 */

export type FieldResult = {
  value: string | number | boolean | null;
  source: string | null;
  confidence: number | null; // 0.0–1.0
  verified: boolean;
  apiConfirmed: boolean;
  apiDisagreed: boolean;
  apiValue: string | null;
};

export type EnrichedVehicleData = {
  engineConfig: string; // "{year}_{make}_{model}_{engineCode}" normalized key

  // Fluids
  oil_viscosity: FieldResult;
  oil_capacity_qts: FieldResult;
  coolant_type: FieldResult;
  coolant_capacity_qts: FieldResult;
  power_steering_type: FieldResult;
  brake_fluid_type: FieldResult;

  // Service Intervals
  oil_change_miles: FieldResult;
  oil_change_months: FieldResult;
  spark_plug_miles: FieldResult;
  spark_plug_months: FieldResult;
  transmission_service_miles: FieldResult;
  transmission_service_months: FieldResult;
  coolant_flush_miles: FieldResult;
  coolant_flush_months: FieldResult;
  air_filter_miles: FieldResult;
  air_filter_months: FieldResult;
  cabin_filter_miles: FieldResult;
  cabin_filter_months: FieldResult;

  // Vehicle Attributes
  timing_system: FieldResult;
  drivetrain: FieldResult;
  turbo: FieldResult;

  // OEM Part Numbers
  oil_filter_oem: FieldResult;
  air_filter_oem: FieldResult;
  cabin_filter_oem: FieldResult;
  spark_plug_oem: FieldResult;
  front_brake_pad_oem: FieldResult;
  rear_brake_pad_oem: FieldResult;
  drain_plug_gasket_oem: FieldResult;
  battery_group: FieldResult;
  battery_cca: FieldResult;
  parking_brake_type: FieldResult;

  // Pricing (from Call 2)
  oil_change_price: FieldResult;
  brake_pad_front_price: FieldResult;
  brake_pad_rear_price: FieldResult;
  spark_plug_price: FieldResult;
  air_filter_price: FieldResult;
  cabin_filter_price: FieldResult;

  // Labor estimates (from Call 2)
  estimated_labor_oil_change_hrs: FieldResult;
  estimated_labor_brake_front_hrs: FieldResult;
  estimated_labor_brake_rear_hrs: FieldResult;
  estimated_labor_spark_plug_hrs: FieldResult;

  // Meta
  enrichedAt: number;
  fillRate: number; // 0–100
  sourceUrls: string[];
};

export type VehicleInput = {
  vehicleId: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  engineCode: string;
  displacement: string;
};

export type FirecrawlResult = {
  url: string;
  markdown: string;
  title: string;
  /** Raw HTML, present only when the caller requested it (price extraction). */
  html?: string;
};

export type ApiVerificationResult = {
  [fieldName: string]: {
    apiValue: string | null;
    agrees: boolean | null; // null = API had no data for this field
  };
};

/** All field keys that hold FieldResult values (excludes meta fields). */
export const ENRICHMENT_FIELD_KEYS: (keyof EnrichedVehicleData)[] = [
  // Fluids
  "oil_viscosity",
  "oil_capacity_qts",
  "coolant_type",
  "coolant_capacity_qts",
  "power_steering_type",
  "brake_fluid_type",
  // Service Intervals
  "oil_change_miles",
  "oil_change_months",
  "spark_plug_miles",
  "spark_plug_months",
  "transmission_service_miles",
  "transmission_service_months",
  "coolant_flush_miles",
  "coolant_flush_months",
  "air_filter_miles",
  "air_filter_months",
  "cabin_filter_miles",
  "cabin_filter_months",
  // Vehicle Attributes
  "timing_system",
  "drivetrain",
  "turbo",
  // OEM Part Numbers
  "oil_filter_oem",
  "air_filter_oem",
  "cabin_filter_oem",
  "spark_plug_oem",
  "front_brake_pad_oem",
  "rear_brake_pad_oem",
  "drain_plug_gasket_oem",
  "battery_group",
  "battery_cca",
  "parking_brake_type",
  // Pricing
  "oil_change_price",
  "brake_pad_front_price",
  "brake_pad_rear_price",
  "spark_plug_price",
  "air_filter_price",
  "cabin_filter_price",
  // Labor estimates
  "estimated_labor_oil_change_hrs",
  "estimated_labor_brake_front_hrs",
  "estimated_labor_brake_rear_hrs",
  "estimated_labor_spark_plug_hrs",
];

/** Fields extracted by Call 1A (fluids, intervals, attributes). */
export const CALL_1A_FIELDS = [
  "oil_viscosity",
  "oil_capacity_qts",
  "coolant_type",
  "coolant_capacity_qts",
  "power_steering_type",
  "brake_fluid_type",
  "oil_change_miles",
  "oil_change_months",
  "spark_plug_miles",
  "spark_plug_months",
  "transmission_service_miles",
  "transmission_service_months",
  "coolant_flush_miles",
  "coolant_flush_months",
  "air_filter_miles",
  "air_filter_months",
  "cabin_filter_miles",
  "cabin_filter_months",
  "timing_system",
  "drivetrain",
  "turbo",
];

/** Fields extracted by Call 1B (OEM part numbers). */
export const CALL_1B_FIELDS = [
  "oil_filter_oem",
  "air_filter_oem",
  "cabin_filter_oem",
  "spark_plug_oem",
  "front_brake_pad_oem",
  "rear_brake_pad_oem",
  "drain_plug_gasket_oem",
  "battery_group",
  "battery_cca",
  "parking_brake_type",
];

export function buildEngineKey(input: VehicleInput): string {
  return `${input.year}_${input.make}_${input.model}_${input.engineCode}`
    .toLowerCase()
    .replace(/\s+/g, "_");
}

export function emptyFieldResult(): FieldResult {
  return {
    value: null,
    source: null,
    confidence: null,
    verified: false,
    apiConfirmed: false,
    apiDisagreed: false,
    apiValue: null,
  };
}
