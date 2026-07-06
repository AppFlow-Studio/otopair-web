/**
 * vehicleEnrichment/prompts/batch1Prompt.ts — Batch 1 prompts (NO web search)
 *
 * Claude receives pre-scraped markdown from OEM parts catalogs and owner's manuals.
 * Its ONLY job is to extract and structure the data — it does NOT search the web.
 * Batch 1 should produce ~5-10k input tokens, not 160k.
 *
 * Training data allowed ONLY for 4 stable factual fields:
 *   brake_fluid_type, power_steering_type, parking_brake_type, timing_system
 */

import type { VehicleInput, VehicleIdentity } from "../types";
import type { DetectedPackage } from "../../lib/vehicleDatabases";

export const BATCH_1_SYSTEM = `You are a data extraction specialist for Otopair. You will receive raw markdown scraped from OEM parts catalog pages (bmwpartsdeal.com or equivalent) and owner's manual / maintenance schedule pages for a specific vehicle.

Your ONLY job: extract and structure the data into the exact JSON schema provided. You are NOT searching the web. You are reading pre-scraped source documents and extracting values.

RULES:
1. Extract values ONLY from the provided source documents. Do NOT use training knowledge for: OEM part numbers, service intervals (miles or months), oil capacity, coolant capacity, labor hours, or pricing.
2. You MAY use training knowledge ONLY for these 4 stable factual fields (mark as source_type: "training_data", confidence 0.75):
   - brake_fluid_type (e.g., DOT 4, DOT 3)
   - power_steering_type (electric vs hydraulic)
   - parking_brake_type (electronic vs manual)
   - timing_system (chain vs belt)
3. If a value is not present in the source documents and is not one of the 4 allowed training data fields, return null. A null is always better than a guess.
4. For OEM part numbers, validate the format for this vehicle's make:
   - BMW: 11 digits numeric (e.g., 11427583220) OR alphanumeric up to 13 chars (e.g., 64115A1BDB6)
   - Toyota: 5-5 alphanumeric (e.g., 04152-YZZA1)
   - Honda: segmented alphanumeric (e.g., 15400-PLM-A02)
   If the format doesn't match, return null.
5. Return VALID JSON only. No markdown fences, no explanation, no preamble.

WIPER BLADE FIELDS:
- wiper_blade_set_oem: front-pair part number. Front driver + passenger blades are usually sold as a single matched set; return that part number. If they are sold separately and the part numbers differ, return the driver-side part number.
- wiper_blade_rear_oem: rear wiper part number. Many vehicles do not have a rear wiper — if the vehicle has none, return null.

SUPERSESSION HANDLING (critical for correct part numbers):
- Parts pages may list MULTIPLE part numbers when parts have been superseded.
- Always pick the CURRENT part for the target vehicle year:
  - If a part shows "Replaced by: [new_number]", the correct answer is the NEW number.
  - If multiple parts listed, match by fitment year range that includes the vehicle year.
  - Example: cabin air filter lists "64116996208 (2018-2020, Replaced by 64115A1BDB6)" and "64115A1BDB6 (2018-2023, current)" → correct answer is 64115A1BDB6.

PRICING:
- Do NOT extract or return any prices. Part pricing is captured separately and
  deterministically from the page's structured data (JSON-LD). The markdown you
  receive flattens the real price together with the struck-through MSRP and the
  "You Save $X" figure, so any price read from it is unreliable. Omit pricing.

CONFIDENCE TIERS:
- 0.95-1.0: Value extracted directly from OEM catalog or owner's manual in the source documents
- 0.85-0.94: Value inferred from adjacent data in source (e.g., capacity derived from diagram)
- 0.70-0.79: Training data (only for the 4 allowed fields listed above)
- Below 0.70: Do not return — set to null

NHTSA DATA: The NHTSA vPIC section is verified and deterministic. Use these values as-is for the attribute fields they cover (drivetrain, turbo, transmission_type, fuel_injection_type, cylinders). Do not override them with values from other sources.`;

export function buildBatch1Prompt(
  vehicle: VehicleInput,
  vPicData: VehicleIdentity | null,
  partsMarkdown: string,
  manualMarkdown: string,
  packages: DetectedPackage[] = [],
): string {
  const vPicSection = vPicData
    ? `=== NHTSA vPIC DATA (verified — use these values directly) ===
${JSON.stringify(
  {
    drivetrain: vPicData.drivetrain,
    turbo: vPicData.turbo,
    transmission_type: vPicData.transmission_type,
    fuel_injection_type: vPicData.fuel_injection_type,
    timing_system: vPicData.timing_system,
    cylinders: vPicData.cylinders,
    displacement_l: vPicData.displacement_l,
    fuel_type: vPicData.fuel_type,
  },
  null,
  2,
)}`
    : "=== NHTSA vPIC DATA ===\n(not available — determine from source documents)";

  const partsSection = partsMarkdown
    ? `=== OEM PARTS CATALOG (scraped) ===\n${partsMarkdown.slice(0, 20_000)}`
    : "=== OEM PARTS CATALOG ===\n(no scraped data available — leave OEM part number fields null)";

  const manualSection = manualMarkdown
    ? `=== OWNER'S MANUAL / MAINTENANCE SCHEDULE (scraped) ===\n${manualMarkdown.slice(0, 20_000)}`
    : "=== OWNER'S MANUAL ===\n(no scraped data available — leave interval fields null)";

  // CVT filter conditioning: when NHTSA already tells us the transmission is
  // NOT a CVT, hard-null the CVT filter fields in the instructions instead of
  // trusting the model to return null — LLMs happily "find" a CVT filter for
  // a conventional automatic. Unknown/CVT transmissions keep them searchable.
  const transType = vPicData?.transmission_type?.toLowerCase() ?? null;
  const knownNonCvt = transType != null && transType.length > 0 && !transType.includes("cvt")
    && !transType.includes("continuously variable");
  const cvtReminder = knownNonCvt
    ? `cvt_internal_filter_oem / cvt_external_filter_oem: this vehicle's transmission is "${vPicData!.transmission_type}" (NOT a CVT) — set BOTH to null.`
    : `cvt_internal_filter_oem / cvt_external_filter_oem: CVT transmissions only — the internal mesh-screen filter (pan service) and the external cooler-line spin-on filter. Null on conventional automatics, DCTs and manuals.`;

  const packagesSection = packages.length > 0
    ? `=== PACKAGES AVAILABLE FOR THIS TRIM ===
This trim ships with optional packages that change which OEM parts are correct for some services.
For EACH package below, return the package-specific OEM part numbers IF they differ from the base trim.
Use null for any part that uses the same number as the base trim.

The packages, with their service slugs and the OEM part fields you must consider:
${packages.map((p) => `  - code: "${p.code}"  label: "${p.label}"  affects: ${p.services_affected.join(", ")}`).join("\n")}

Add a top-level "packages" object to your response, with one key per package code. Each value MUST follow this shape:

  "packages": {
    "${packages[0]?.code ?? "package_code"}": {
      "oem_parts": {
        // Same field names as the top-level "oem_parts" block.
        // Include ONLY the fields whose part number differs from the base trim.
        // Use the same { value, source_url, source_type, confidence } shape.
        "front_brake_pad_oem": { "value": "...", "source_url": "...", "source_type": "scraped", "confidence": 0.9 },
        "rear_brake_pad_oem":  { "value": "...", "source_url": "...", "source_type": "scraped", "confidence": 0.9 }
      }
    }
  }

If a package's part numbers are unknown or unavailable in the source documents, omit that package's entry rather than guessing.
`
    : "";

  return `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} — ${vehicle.engineCode} ${vehicle.displacement}L

${vPicSection}

${partsSection}

${manualSection}

${packagesSection}

Extract into this exact JSON structure. For NHTSA-provided fields (drivetrain, turbo, transmission_type, fuel_injection_type, timing_system), use source_type: "nhtsa" and confidence: 1.0:

{
  "fluids": {
    "oil_viscosity": { "value": "0W-30", "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
    "oil_capacity_qts": { "value": 11.1, "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
    "coolant_type": { "value": "BMW HT-12", "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
    "coolant_capacity_qts": { "value": 9.25, "source_url": "https://...", "source_type": "scraped", "confidence": 0.9 },
    "brake_fluid_type": { "value": "DOT 4", "source_url": null, "source_type": "training_data", "confidence": 0.75 },
    "brake_fluid_capacity_oz": { "value": 32, "source_url": "https://...", "source_type": "scraped", "confidence": 0.9 },
    "power_steering_type": { "value": "electric", "source_url": null, "source_type": "training_data", "confidence": 0.75 },
    "ps_fluid_capacity_oz": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "transmission_fluid_capacity_qts": { "value": 4.5, "source_url": "https://...", "source_type": "scraped", "confidence": 0.9 }
  },
  "intervals": {
    "oil_change": {
      "miles": { "value": 10000, "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
      "months": { "value": 12, "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
      "status": "scheduled",
      "display_string": "Every 10,000 miles or 12 months"
    },
    "spark_plug": { "miles": { ... }, "months": { ... }, "status": "scheduled", "display_string": "..." },
    "transmission_service": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." },
    "coolant_flush": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." },
    "air_filter": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." },
    "cabin_filter": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." },
    "brake_fluid_flush": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." },
    "serpentine_belt": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." },
    "timing_belt_or_chain_service": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." },
    "brake_pads": { "miles": { ... }, "months": { ... }, "status": "inspect_only", "display_string": "..." },
    "tire_rotation": { "miles": { ... }, "months": { ... }, "status": "scheduled", "display_string": "..." }
  },
  "attributes": {
    "timing_system": { "value": "chain", "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    "drivetrain": { "value": "AWD", "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    "turbo": { "value": true, "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    "fuel_injection_type": { "value": "direct", "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    "transmission_type": { "value": "automatic", "source_url": null, "source_type": "nhtsa", "confidence": 1.0 }
  },
  "oem_parts": {
    "oil_filter_oem": { "value": "11427583220", "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
    "air_filter_oem": { "value": "...", "source_url": "...", "source_type": "scraped", "confidence": 0.9 },
    "cabin_filter_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "spark_plug_oem": { "value": "...", ... },
    "front_brake_pad_oem": { "value": "...", ... },
    "rear_brake_pad_oem": { "value": "...", ... },
    "rotor_front_oem": { "value": "...", ... },
    "rotor_rear_oem": { "value": "...", ... },
    "drain_plug_gasket_oem": { "value": "...", ... },
    "serpentine_belt_oem": { "value": "...", ... },
    "timing_belt_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "wiper_blade_set_oem": { "value": "...", ... },
    "wiper_blade_rear_oem": { "value": "...", ... },
    "battery_oem": { "value": "...", ... },
    "coolant_oem": { "value": "...", ... },
    "engine_oil_oem": { "value": "...", ... },
    "oil_filter_housing_oring_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "ignition_coil_oem": { "value": "...", ... },
    "intake_manifold_gasket_oem": { "value": "...", ... },
    "timing_kit_oem": { "value": "...", ... },
    "water_pump_oem": { "value": "...", ... },
    "atf_fluid_oem": { "value": "...", ... },
    "trans_filter_oem": { "value": "...", ... },
    "trans_pan_gasket_oem": { "value": "...", ... },
    "brake_fluid_oem": { "value": "...", ... },
    "ps_fluid_oem": { "value": "...", ... },
    "gear_oil_oem": { "value": "...", ... },
    "friction_modifier_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "brake_hardware_kit_front_oem": { "value": "...", ... },
    "brake_hardware_kit_rear_oem": { "value": "...", ... },
    "brake_wear_sensor_front_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "brake_wear_sensor_rear_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "thermostat_oem": { "value": "...", ... },
    "thermostat_gasket_oem": { "value": "...", ... },
    "cvt_internal_filter_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null },
    "cvt_external_filter_oem": { "value": null, "source_url": null, "source_type": null, "confidence": null }
  },
  "battery": {
    "battery_group": { "value": "H8/Group 49", "source_url": "...", "source_type": "scraped", "confidence": 0.9 },
    "battery_cca": { "value": 850, "source_url": "...", "source_type": "scraped", "confidence": 0.9 }
  },
  "spark_plug": {
    "quantity": { "value": 8, "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    "gap_mm": { "value": 0.7, "source_url": "...", "source_type": "scraped", "confidence": 0.9 }
  },
  "parking_brake_type": { "value": "electronic", "source_url": null, "source_type": "training_data", "confidence": 0.75 },
  "trim_specs": {
    "tire_pressure_front_psi": { "value": 35, "source_url": "...", "source_type": "scraped", "confidence": 0.9 },
    "tire_pressure_rear_psi": { "value": 38, "source_url": "...", "source_type": "scraped", "confidence": 0.9 },
    "lug_nut_torque_ft_lbs": { "value": 103, "source_url": "...", "source_type": "scraped", "confidence": 0.9 },
    "front_wiper_size": { "value": "26", "source_url": "...", "source_type": "scraped", "confidence": 0.8 },
    "rear_wiper_size": { "value": null, "source_url": null, "source_type": null, "confidence": null }
  }
}

REMINDERS:
- If timing_system is "chain" (from NHTSA or scraped), set timing_belt_oem to null.
- spark_plug quantity = cylinder count from NHTSA if available (use source_type: "nhtsa").
- If status is "not_applicable" (e.g., timing belt on a chain engine), set miles/months values to null.
- For rotor_front_oem and rotor_rear_oem: both may appear on the same "brake_disc" page. Extract front and rear part numbers separately if they differ by axle position.
- oil_capacity_qts / coolant_capacity_qts must be in US quarts for THIS exact engine. If the source lists the capacity in liters, convert (qts = L × 1.057); never copy a liter figure as a quart figure. Do not use a capacity for a different engine option.
- coolant_capacity_qts is the TOTAL cooling-system capacity (initial fill). Owner's manuals usually print both "total fill" and "drain and refill" — use total fill (a coolant flush exchanges the full system), never the smaller drain-and-refill figure.
- brake_fluid_capacity_oz: full-flush brake system capacity in US fluid OUNCES (typical 16-48 oz; 1 L = 33.8 oz). ps_fluid_capacity_oz: power-steering system capacity in US fluid OUNCES — null when power_steering_type is electric.
- transmission_fluid_capacity_qts: the DRAIN-AND-FILL (pan drop) capacity in US quarts, NOT the total/dry-fill figure — a fluid service exchanges the pan, not the torque converter. Lifetime-fill units still have a published drain-and-fill capacity; return it.
- coolant_oem is the OEM coolant/antifreeze part number (e.g., BMW HT-12 coolant product number), not the coolant type string.
- engine_oil_oem is the OEM engine oil part number / SKU (e.g., BMW TwinPower Turbo 5W-30 SKU 83215A2AF99, Toyota 0W-20 SKU 00279-0WQTE, Mercedes 229.5 SKU A0009898301), NOT the viscosity string. Prefer the make's 1-quart / 1-liter bottle SKU when both bottle and bulk-jug SKUs exist — quoting multiplies by oil_capacity_qts at quote time.
- FLUID SKUs (atf_fluid_oem, brake_fluid_oem, ps_fluid_oem, gear_oil_oem, friction_modifier_oem): return the OEM FLUID BOTTLE part number, NEVER the spec string (e.g. NOT "DOT 4", "SP-IV", "ATF WS", "GL-5 75W-90", "Type 3 PSF"). Prefer the make's 1-quart / 1-liter bottle SKU when both bottle and bulk-jug SKUs exist — quoting multiplies by the vehicle's fluid capacity at quote time. Each fluid SKU is conditional: set it to null when the vehicle doesn't use it — atf_fluid_oem null on a manual transmission, ps_fluid_oem null on electric power steering, gear_oil_oem null when there is no serviceable differential, friction_modifier_oem null on a non-LSD (open) differential.
- oil_filter_housing_oring_oem: the oil-filter cap O-ring part number for CARTRIDGE-filter engines only; null on spin-on (canister) filter engines.
- timing_kit_oem / water_pump_oem: null on chain-driven engines (no belt service). timing_kit_oem is the tensioner/idler/seal kit SKU; water_pump_oem is the belt-driven water pump.
- trans_filter_oem / trans_pan_gasket_oem: the pan-service filter and pan gasket (or RTV) SKUs; null when the transmission has no serviceable filter / sealed unit.
- brake_wear_sensor_front_oem / brake_wear_sensor_rear_oem: the pad-wear sensor part number per axle (standard on most BMW / Euro); null on cars without electronic pad-wear sensors.
- brake_hardware_kit_front_oem / brake_hardware_kit_rear_oem: the caliper hardware (clips / shims / abutment) kit SKU per axle.
- thermostat_oem / thermostat_gasket_oem: replaced only if found bad during a coolant flush — still extract the SKUs when the catalog lists them.
- ${cvtReminder}
- brake_pads interval: the manufacturer's INSPECTION / typical pad-life guidance (wear-based, not a hard schedule) — use status "inspect_only" unless the schedule explicitly mandates replacement. tire_rotation: the rotation schedule (typically 5,000-8,000 miles).
- Conditional existence IS the data: returning null for any of the above means the vehicle does not use that part — do not guess a substitute.
- Return null for any field not found in sources and not in the 4 allowed training data fields.`;
}
