/**
 * vehicleEnrichment/prompts/batch2Prompt.ts — Batch 2 prompts (WITH web_search)
 *
 * Batch 2 handles two jobs in one call:
 *   Job 1 — Gap fill: targeted web searches for fields Batch 1 couldn't extract
 *   Job 2 — Pricing: look up current retail prices for OEM part numbers from Batch 1
 *
 * DESIGN PRINCIPLE (learned from R6):
 *   The system prompt is intentionally minimal — no source tier rankings, no DO NOT USE
 *   lists, no confidence tier tables. R6 proved Claude ignores prompt-based blacklists
 *   (kbb.com, justanswer.com still appeared despite explicit instructions).
 *
 *   Source quality enforcement happens mechanically in the parser via blockedDomains.ts.
 *   Short prompt → less reasoning overhead → fewer tokens → lower cost.
 *   R5 had 20 searches at 215K tokens. R6 had 14 searches at 574K — entirely due to
 *   the bloated prompt causing longer reasoning chains, not the search count.
 */

import type { VehicleInput } from "../types";
import { SERVICE_LIST } from "../types";

// Single source of truth lives in ../types (census P0.1 unification — this
// file previously carried a divergent 25-entry copy while types.ts had 22).
// Re-exported so existing importers (utils/batchSchemas.ts, tests) keep
// resolving the SAME array object.
export { SERVICE_LIST };

export const BATCH_2_SYSTEM = `You are a vehicle data specialist for Otopair. You have two jobs:

JOB 1 — GAP FILL: Search the web for each field listed under "FIELDS NEEDING GAP FILL". Use 1-2 targeted queries per field: "[year] [make] [model] [field]". If you cannot find a value after 1-2 searches, return null. Do NOT do broad vehicle searches.

JOB 2 — PRICING + LABOR: Look up current retail prices for each OEM part number provided AND for every OEM part number you yourself report in this response (the *_oem fields / parts you discover). Use "[part_number] OEM price" as your query. Also determine labor hours for each applicable service.

RULES:
1. PRICES ARE PER-UNIT. Each OEM part is priced individually as the retail cost of ONE bottle / one filter / one pad set / one plug. Examples:
   - Spark plug: a V8 needs 8 plugs, but you return ~$15-25 (price of ONE plug), not $200.
   - Brake pads: OEM pads are sold as one axle SET, so the price is for that ONE set, not front+rear combined.
   - Oil filter / cabin filter / battery: one filter, one battery. Always per OEM part number.
   REPORT THE PRICE THE CUSTOMER ACTUALLY PAYS NOW — the final/current sale price. NEVER the MSRP, the list/"was" price, a struck-through price, or the "You Save $X" amount.
2. PREFERRED RESPONSE SHAPE: itemized parts_breakdown — one entry per OEM part number, covering BOTH the part numbers provided below AND every part number you yourself report in this response. On a fresh vehicle no part numbers are provided up front — the parts you discover ARE the pricing target; a discovered part without a parts_breakdown entry is incomplete work. Each entry carries that part's own per-unit price + source URL. Search per SKU ("<part_number> OEM price"), not per service. Multi-part services (oil_change has filter + drain plug gasket + engine oil bottle) MUST itemize — never collapse them into one service-level number.
3. service-level parts_cost_low / parts_cost_high are now OPTIONAL — set them only as a redundant sanity-check sum. The parts_breakdown[] array is the authoritative source. If you can't itemize, you may omit parts_breakdown and fall back to a per-unit parts_cost_low/high, but prefer itemizing.
4. Labor rate: $125/hr fixed. Do not search for this.
5. Labor hours: use training knowledge for well-established book times (mark source_type: "training_data", confidence 0.75). Oil change is typically 0.5 hrs.
6. If you cannot find a price for a specific OEM part after 1-2 targeted searches, OMIT that part from parts_breakdown[]. Do not include it with a null or 0 price. Do not guess.
7. Return OEM part numbers as JSON STRINGS exactly as printed, preserving leading zeros (e.g. "07119963130", never the bare number 7119963130).
8. Return VALID JSON only. No markdown fences, no explanation, no preamble.`;

/** Field descriptions used in the gap fill user prompt. Shared with the
 *  Batch-3 gap-fill re-ask pass (gapFillPrompt.ts). */
export const FIELD_DESCRIPTIONS: Record<string, string> = {
  oil_viscosity: "Engine oil viscosity specification (e.g., 0W-30, 5W-20)",
  oil_capacity_qts: "Engine oil capacity in US quarts (including filter). If a source gives liters, convert (qts = L × 1.057).",
  coolant_type: "Coolant specification (e.g., BMW HT-12, Toyota SLLC)",
  coolant_capacity_qts: "Cooling system TOTAL capacity (initial fill) in US quarts for THIS exact engine — if the source lists both 'total fill' and 'drain and refill', use total fill. Usually published in liters — convert (qts = L × 1.057); never copy a liter value as quarts.",
  brake_fluid_type: "Brake fluid specification (e.g., DOT 4, DOT 3)",
  power_steering_type: "Power steering system type (electric/hydraulic)",
  oil_change_miles: "Oil change interval in miles",
  oil_change_months: "Oil change interval in months",
  spark_plug_miles: "Spark plug replacement interval in miles",
  spark_plug_months: "Spark plug replacement interval in months",
  transmission_service_miles: "Transmission service interval in miles",
  transmission_service_months: "Transmission service interval in months",
  coolant_flush_miles: "Coolant flush interval in miles",
  coolant_flush_months: "Coolant flush interval in months",
  air_filter_miles: "Engine air filter replacement interval in miles",
  air_filter_months: "Engine air filter replacement interval in months",
  cabin_filter_miles: "Cabin air filter replacement interval in miles",
  cabin_filter_months: "Cabin air filter replacement interval in months",
  brake_fluid_flush_miles: "Brake fluid flush interval in miles",
  brake_fluid_flush_months: "Brake fluid flush interval in months",
  serpentine_belt_miles: "Serpentine belt replacement interval in miles",
  serpentine_belt_months: "Serpentine belt replacement interval in months",
  timing_service_miles: "Timing belt/chain service interval in miles",
  timing_service_months: "Timing belt/chain service interval in months",
  timing_system: "Timing system type (chain, belt, or gear)",
  drivetrain: "Drivetrain type (FWD, RWD, AWD, 4WD)",
  turbo: "Whether the engine is turbocharged (true/false)",
  fuel_injection_type: "Fuel injection type (direct, port, dual)",
  transmission_type: "Transmission type (automatic, manual, CVT, DCT)",
  battery_type: "Battery chemistry (AGM, flooded, EFB, lithium-ion)",
  battery_location: "Physical battery location (engine bay, trunk, under rear seat, under front seat)",
  oil_filter_oem: "OEM oil filter part number",
  air_filter_oem: "OEM engine air filter part number",
  cabin_filter_oem: "OEM cabin air filter part number",
  spark_plug_oem: "OEM spark plug part number",
  front_brake_pad_oem: "OEM front brake pad part number",
  rear_brake_pad_oem: "OEM rear brake pad part number",
  rotor_front_oem: "OEM front brake rotor part number",
  rotor_rear_oem: "OEM rear brake rotor part number",
  // NOTE: the rotor DISCARD MINIMUM is deliberately NOT gap-fillable here — this
  // contract has no slot for the verbatim label, and an unlabelled minimum is
  // indistinguishable from a nominal (see getNullFields in v3pipeline.ts). Only
  // the nominal, which is never graded against, may be filled from this path.
  rotor_front_nominal_thickness_mm:
    "Front brake rotor NOMINAL (new) thickness in mm — the SECOND number in a '330x22mm' size string (the first is the diameter). This is NOT a minimum: do not return a discard/minimum figure here, and never derive one from it.",
  rotor_rear_nominal_thickness_mm:
    "Rear brake rotor NOMINAL (new) thickness in mm — same rule as front. Null when the rear axle has drum brakes.",
  drain_plug_gasket_oem: "OEM oil drain plug gasket part number",
  serpentine_belt_oem: "OEM serpentine belt part number",
  timing_belt_oem: "OEM timing belt part number (null if chain engine)",
  wiper_blade_set_oem: "OEM wiper blade set part number",
  battery_oem: "OEM battery part number",
  coolant_oem: "OEM coolant/antifreeze product part number",
  engine_oil_oem: "OEM engine oil product part number — prefer the make's 1-quart/1-liter bottle SKU",
  battery_group: "Battery group size (e.g., H8/Group 49)",
  battery_cca: "Battery cold cranking amps (CCA)",
  spark_plug_quantity: "Number of spark plugs",
  spark_plug_gap: "Spark plug gap in mm",
  parking_brake_type: "Parking brake type (electronic, manual_drum, manual_disc)",
  tire_pressure_front_psi: "Front tire pressure in PSI",
  tire_pressure_rear_psi: "Rear tire pressure in PSI",
  lug_nut_torque_ft_lbs: "Lug nut torque in ft-lbs",
  front_wiper_size: "Front wiper blade size in inches",
  rear_wiper_size: "Rear wiper blade size in inches",
  // v7 new fields
  trans_fluid_type: "Transmission fluid specification (e.g., ZF Lifeguard 8, Dexron VI)",
  diff_fluid_type: "Differential fluid specification (e.g., SAE 75W-90 GL-5)",
  transfer_case_fluid_type: "Transfer case fluid specification (e.g., ATF+4, Pentosin FFL-4)",
  diff_fluid_miles: "Differential fluid change interval in miles",
  diff_fluid_months: "Differential fluid change interval in months",
  transfer_case_fluid_miles: "Transfer case fluid change interval in miles",
  transfer_case_fluid_months: "Transfer case fluid change interval in months",
  ps_fluid_miles: "Power steering fluid flush/replacement interval in miles (hydraulic systems only; null for electric power steering)",
  ps_fluid_months: "Power steering fluid flush/replacement interval in months (hydraulic systems only; null for electric power steering)",
  // Fluid capacities
  diff_fluid_capacity_qts: "Differential fluid drain-and-fill capacity in US quarts (rear diff for RWD/AWD; typical 0.5-4 qts). Convert from liters if needed (qts = L × 1.057).",
  transfer_case_fluid_capacity_qts: "Transfer case fluid drain-and-fill capacity in US quarts (AWD/4WD only; typical 0.5-3 qts). Convert from liters if needed.",
  brake_fluid_capacity_oz: "Full-flush brake system capacity in US fluid OUNCES (typical 16-48 oz; 1 L = 33.8 oz).",
  ps_fluid_capacity_oz: "Power steering system capacity in US fluid OUNCES (hydraulic systems only; 1 L = 33.8 oz).",
  transmission_fluid_capacity_qts: "Transmission DRAIN-AND-FILL (pan drop) capacity in US quarts — NOT the total/dry-fill figure (typical 2-8 qts). Convert from liters if needed (qts = L × 1.057).",
  // Wear/rotation guidance intervals
  brake_pads_miles: "Manufacturer's brake pad inspection / typical pad-life guidance in miles (wear-based, not a hard schedule)",
  brake_pads_months: "Manufacturer's brake pad inspection guidance in months",
  tire_rotation_miles: "Tire rotation schedule in miles (typically 5,000-8,000)",
  tire_rotation_months: "Tire rotation schedule in months",
  // coolant_flush / transmission_service discovery parts
  thermostat_oem: "OEM thermostat part number (replaced only if found bad during a coolant flush)",
  thermostat_gasket_oem: "OEM thermostat gasket/seal part number",
  cvt_internal_filter_oem: "OEM CVT internal (mesh screen) filter part number — CVT transmissions only; null otherwise",
  cvt_external_filter_oem: "OEM CVT external (cooler line) filter part number — CVT transmissions only; null otherwise",

  // ── Census P0.1 R8 (2026-07-30): the 44 fields below had NO entry, so their
  //    gap-fill asks rendered as the bare field key ("- battery_price:
  //    battery_price"). Every V4_FIELD_KEYS entry now has a real description
  //    (tests/serviceRouting.test.ts enforces the invariant). ──────────────────

  // OEM parts previously description-less
  wiper_blade_rear_oem: "OEM rear wiper blade part number (null when the vehicle has no rear wiper)",
  oil_filter_housing_oring_oem: "OEM oil filter housing cap O-ring/seal part number (cartridge-filter engines; null when the vehicle doesn't use one)",
  ignition_coil_oem: "OEM ignition coil part number (price is per ONE coil)",
  intake_manifold_gasket_oem: "OEM intake manifold gasket part number (replaced when spark plug access requires manifold removal; null otherwise)",
  timing_kit_oem: "OEM timing belt kit part number (belt + tensioner + idlers; belt engines only, null for chain)",
  water_pump_oem: "OEM water pump part number (bundled with timing belt service where the belt drives the pump)",
  atf_fluid_oem: "OEM transmission fluid (ATF/CVT) bottle part number — the product SKU, never the spec string",
  trans_filter_oem: "OEM transmission filter part number (pan-service transmissions; null for sealed units without a serviceable filter)",
  trans_pan_gasket_oem: "OEM transmission pan gasket part number (null when the pan has no serviceable gasket)",
  brake_fluid_oem: "OEM brake fluid bottle part number — the product SKU, never the DOT spec string",
  ps_fluid_oem: "OEM power steering fluid bottle part number (hydraulic systems only; null for electric power steering)",
  gear_oil_oem: "OEM differential gear oil bottle part number (GL-5 hypoid; null when the vehicle has no serviceable differential)",
  friction_modifier_oem: "OEM limited-slip differential friction modifier part number (LSD-equipped axles only; null otherwise)",
  brake_hardware_kit_front_oem: "OEM front brake hardware/abutment kit part number (null when the pad set ships with hardware)",
  brake_hardware_kit_rear_oem: "OEM rear brake hardware/abutment kit part number (null when the pad set ships with hardware)",
  brake_wear_sensor_front_oem: "OEM front brake pad wear sensor part number (electronic wear-indicator vehicles only; null otherwise)",
  brake_wear_sensor_rear_oem: "OEM rear brake pad wear sensor part number (electronic wear-indicator vehicles only; null otherwise)",

  // Rotor DISCARD minimums — normally excluded from gap-fill re-asks entirely
  // (GAP_FILL_EXCLUDED_FIELDS: this contract has no slot for the verbatim
  // label). Descriptions exist for completeness; they repeat the guardrail.
  rotor_front_min_thickness_mm: "Front brake rotor DISCARD/minimum thickness in mm — ONLY a value the source explicitly labels minimum/discard; never derive it from the nominal",
  rotor_rear_min_thickness_mm: "Rear brake rotor DISCARD/minimum thickness in mm — same rule as front; null when the rear axle has drum brakes",

  // Per-part retail prices (per-unit, current sale price — see system rule 1)
  oil_change_price: "Total OEM parts cost in USD for an oil change (filter + drain plug gasket + oil at capacity)",
  brake_pad_front_price: "Retail price in USD of the OEM front brake pad set (ONE axle set)",
  brake_pad_rear_price: "Retail price in USD of the OEM rear brake pad set (ONE axle set)",
  spark_plug_price: "Retail price in USD of ONE OEM spark plug (per-unit, not the full engine set)",
  air_filter_price: "Retail price in USD of the OEM engine air filter",
  cabin_filter_price: "Retail price in USD of the OEM cabin air filter",
  rotor_front_price: "Retail price in USD of ONE OEM front brake rotor",
  rotor_rear_price: "Retail price in USD of ONE OEM rear brake rotor",
  battery_price: "Retail price in USD of the OEM-spec replacement battery",
  serpentine_belt_price: "Retail price in USD of the OEM serpentine belt",
  coolant_flush_price: "Total OEM parts cost in USD for a coolant flush (coolant at full system capacity)",
  transmission_service_price: "Total OEM parts cost in USD for a transmission fluid service (fluid + filter/gasket where serviced)",
  brake_fluid_flush_price: "Total OEM parts cost in USD for a brake fluid flush (fluid at full-flush capacity)",

  // Book labor hours (training-data book times; see system rules 4-5)
  estimated_labor_oil_change_hrs: "Book labor hours for an oil change",
  estimated_labor_brake_front_hrs: "Book labor hours for a front brake pad replacement",
  estimated_labor_brake_rear_hrs: "Book labor hours for a rear brake pad replacement",
  estimated_labor_spark_plug_hrs: "Book labor hours for spark plug replacement (all cylinders)",
  estimated_labor_rotor_front_hrs: "Book labor hours for front rotor + pad replacement",
  estimated_labor_rotor_rear_hrs: "Book labor hours for rear rotor + pad replacement",
  estimated_labor_serpentine_belt_hrs: "Book labor hours for serpentine belt replacement",
  estimated_labor_coolant_flush_hrs: "Book labor hours for a coolant flush",
  estimated_labor_trans_fluid_hrs: "Book labor hours for a transmission fluid service",
  estimated_labor_battery_hrs: "Book labor hours for battery replacement (including registration/coding where required)",
  estimated_labor_brake_fluid_flush_hrs: "Book labor hours for a brake fluid flush",
  estimated_labor_timing_service_hrs: "Book labor hours for timing belt replacement (belt engines; null for chain)",
};

export function buildBatch2Prompt(
  vehicle: VehicleInput,
  nullFields: string[],
  oemParts: Record<string, string>,
): string {
  const fieldList = nullFields.length > 0
    ? nullFields.map((f) => `- ${f}: ${FIELD_DESCRIPTIONS[f] || f}`).join("\n")
    : "(none — all fields were extracted from scraped sources)";

  const partsList = Object.keys(oemParts).length > 0
    ? Object.entries(oemParts)
        .map(([field, part]) => `- ${field}: "${part}"`)
        .join("\n")
    : "(none provided — Batch 1 found no part numbers for this vehicle. You will discover the *_oem part numbers yourself in this response: price every part number you report by giving it a parts_breakdown entry in its service, same per-unit rules.)";

  const serviceSchemaExample = SERVICE_LIST.slice(0, 1)
    .map((s) => `    {
      "service_name": "${s}",
      "is_applicable": true,
      "labor_hours": { "value": 0.5, "source_url": null, "source_type": "training_data", "confidence": 0.75 },
      "parts_breakdown": [
        { "oem_part_number": "11427583220", "price_low": 12.50, "price_high": 18.00, "source_url": "https://fcpeuro.com/...", "confidence": 0.9 },
        { "oem_part_number": "7119963132",  "price_low": 3.40,  "price_high": 5.00,  "source_url": "https://realoem.com/...", "confidence": 0.85 }
      ],
      "parts_cost_low": { "value": 15.90, "source_url": null, "source_type": "synthesized", "confidence": 0.85 },
      "parts_cost_high": { "value": 23.00, "source_url": null, "source_type": "synthesized", "confidence": 0.85 },
      "confidence": 0.9,
      "tech_notes": null
    }`)
    .join(",\n");

  return `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} — ${vehicle.engineCode} ${vehicle.displacement}L

=== FIELDS NEEDING GAP FILL (not found in scraped sources) ===
${fieldList}

Search for each missing field with 1-2 targeted queries. Return each as:
{ "field_name": { "value": ..., "source_url": "...", "source_type": "web_search", "confidence": 0.9 } }

For *_oem part-number fields, ALSO include "observed_title": the EXACT product listing title the source shows for that number, verbatim (null if no product title is visible):
{ "battery_oem": { "value": "...", "observed_title": "ACDelco Gold 47AGM Battery", "source_url": "...", "source_type": "web_search", "confidence": 0.9 } }
NEVER compose, paraphrase, or infer a title — if you did not literally see a product listing title for that exact number, observed_title MUST be null. A composed title (e.g. "Battery — <model> Primary (Labeled <number>)") corrupts the component-identity evidence chain and is worse than no title.
The title is evidence of WHAT the part is. If the listing's title names an accessory or adjacent hardware (cable, bracket, tray, housing, cap, sensor, hose) rather than the component the field asks for, that number is the WRONG part: return null for the value and keep searching.

=== OEM PART NUMBERS (from Batch 1, for pricing lookup) ===
${partsList}

Search for current retail prices for each part number.

Return this exact JSON structure:

{
  "gap_fields": {
    "field_name": { "value": ..., "source_url": "...", "source_type": "web_search", "confidence": 0.9 },
    ...
  },
  "services": [
${serviceSchemaExample},
    ...
  ]
}

The "services" array must include ALL of these services (set is_applicable: false for services not relevant to this vehicle):
${SERVICE_LIST.map((s) => `- ${s}`).join("\n")}

REMINDERS:
- Oil Change: always applicable. Labor typically 0.5 hrs.
- Serpentine Belt: only applicable if this vehicle uses one (not all do).
- Brake Fluid Flush: applicable for most vehicles.
- Differential Fluid Service: only applicable if vehicle has a differential (RWD, AWD, 4WD). Set is_applicable: false for FWD.
- Transfer Case Fluid Service: only applicable for AWD/4WD vehicles. Set is_applicable: false for FWD/RWD.
- Timing Belt/Chain Service: if chain engine (no replacement interval), set is_applicable: false or tech_notes: "chain — no scheduled replacement".
- Power Steering Fluid Flush: only applicable if vehicle has hydraulic power steering. Set is_applicable: false for electric PS.
- Tire Rotation, Wheel Alignment, Multi-Point Inspection: always applicable, labor-only (no parts cost).
- Wiper Blade Replacement: always applicable. Include parts cost if wiper OEM part number is available.

OUTPUT SHAPE OVERRIDE (supersedes the JSON template above):
Return ONE object with TWO ARRAYS. "gap_fields" becomes the "fields" ARRAY;
"services" stays an array but its numbers are BARE, not wrapped objects.
{
  "fields":   [ { "key": "oil_viscosity", "value": "5W-30", "source_url": "...", "source_type": "web_search", "confidence": 0.9 } ],
  "services": [ { "service_name": "Oil Change", "is_applicable": true, "labor_hours": 0.5,
                  "parts_cost_low": 30, "parts_cost_high": 60, "confidence": 0.9, "tech_notes": "",
                  "parts_breakdown": [ { "oem_part_number": "04152-YZZA1", "price_low": 8.5, "price_high": 12,
                                         "source_url": "...", "confidence": 0.9 } ] } ]
}
A gap field you cannot determine is OMITTED ENTIRELY — never emit a row whose value is null.
The "services" array must still list EVERY service, with is_applicable false where it does not apply.`;
}
