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

export const BATCH_2_SYSTEM = `You are a vehicle data specialist for Otopair. You have two jobs:

JOB 1 — GAP FILL: Search the web for each field listed under "FIELDS NEEDING GAP FILL". Use 1-2 targeted queries per field: "[year] [make] [model] [field]". If you cannot find a value after 1-2 searches, return null. Do NOT do broad vehicle searches.

JOB 2 — PRICING + LABOR: Look up current retail prices for each OEM part number provided. Use "[part_number] OEM price" as your query. Also determine labor hours for each applicable service.

RULES:
1. PRICES ARE PER-UNIT. Each OEM part is priced individually as the retail cost of ONE bottle / one filter / one pad set / one plug. Examples:
   - Spark plug: a V8 needs 8 plugs, but you return ~$15-25 (price of ONE plug), not $200.
   - Brake pads: OEM pads are sold as one axle SET, so the price is for that ONE set, not front+rear combined.
   - Oil filter / cabin filter / battery: one filter, one battery. Always per OEM part number.
2. PREFERRED RESPONSE SHAPE: itemized parts_breakdown — one entry per OEM part number Batch 1 found, with that part's own per-unit price + source URL. Search per SKU ("<part_number> OEM price"), not per service. Multi-part services (oil_change has filter + drain plug gasket + engine oil bottle) MUST itemize — never collapse them into one service-level number.
3. service-level parts_cost_low / parts_cost_high are now OPTIONAL — set them only as a redundant sanity-check sum. The parts_breakdown[] array is the authoritative source. If you can't itemize, you may omit parts_breakdown and fall back to a per-unit parts_cost_low/high, but prefer itemizing.
4. Labor rate: $125/hr fixed. Do not search for this.
5. Labor hours: use training knowledge for well-established book times (mark source_type: "training_data", confidence 0.75). Oil change is typically 0.5 hrs.
6. If you cannot find a price for a specific OEM part after 1-2 targeted searches, OMIT that part from parts_breakdown[]. Do not include it with a null or 0 price. Do not guess.
7. Return VALID JSON only. No markdown fences, no explanation, no preamble.`;

/** Field descriptions used in the gap fill user prompt. */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  oil_viscosity: "Engine oil viscosity specification (e.g., 0W-30, 5W-20)",
  oil_capacity_qts: "Engine oil capacity in quarts (including filter)",
  coolant_type: "Coolant specification (e.g., BMW HT-12, Toyota SLLC)",
  coolant_capacity_qts: "Cooling system capacity in quarts",
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
};

export const SERVICE_LIST = [
  "Oil Change",
  "Spark Plug Replacement",
  "Air Filter Replacement",
  "Cabin Air Filter Replacement",
  "Brake Pad Replacement - Front",
  "Brake Pad Replacement - Rear",
  "Brake Pad + Rotor Replacement - Front",
  "Brake Pad + Rotor Replacement - Rear",
  "Brake Fluid Flush",
  "Coolant Flush",
  "Transmission Fluid Service",
  "Serpentine Belt Replacement",
  "Timing Belt/Chain Service",
  "Battery Replacement",
  "Tire Rotation",
  "Wheel Alignment (4-wheel)",
  "Wiper Blade Replacement (set)",
  "Power Steering Fluid Flush",
  "Differential Fluid Service",
  "Transfer Case Fluid Service",
  "Engine Air Intake Cleaning",
  "Fuel System Cleaning",
  "AC Recharge / Service",
  "Wheel Bearing Replacement",
  "Multi-Point Inspection / Diagnostic",
];

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
    : "(no part numbers available from Batch 1)";

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
- Wiper Blade Replacement: always applicable. Include parts cost if wiper OEM part number is available.`;
}
