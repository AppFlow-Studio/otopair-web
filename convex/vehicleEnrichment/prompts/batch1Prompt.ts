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
import { assembleVariantFingerprint, renderVariantConstraints } from "../variantFingerprint";
// The prompt's allowed-key lists are generated from the SAME constants the
// output schema enumerates, so the two contracts cannot drift apart.
import {
  BATCH_1A_FIELD_ROW_KEYS,
  BATCH_1A_INTERVAL_KEYS,
  OEM_PART_KEYS,
} from "../utils/batchSchemas";
import { resolveFuelClass } from "../fuelTypeResolver";
import { resolveBuildSource } from "../buildSourceResolver";

/** Assemble the variant fingerprint synchronously from the identity available
 *  at prompt-build time and render its high-consequence facets as an
 *  authoritative constraints block (P5). All resolvers are pure/sync. Fail-open:
 *  returns "" when no facet is confident enough to assert. */
function variantConstraintsFor(vehicle: VehicleInput, vPicData: VehicleIdentity | null): string {
  const engineCode =
    vehicle.engineCode && !vehicle.engineCode.includes("_") ? vehicle.engineCode : null;
  const fuel = resolveFuelClass({
    nhtsa_fuel_type: vPicData?.fuel_type ?? null,
    engine_code: vehicle.engineCode ?? null,
    engine_manufacturer: vPicData?.engine_manufacturer ?? null,
  });
  const build = resolveBuildSource({
    make: vehicle.make,
    model: vehicle.model,
    model_year: vehicle.year,
    engine_manufacturer: vPicData?.engine_manufacturer ?? null,
  });
  const fp = assembleVariantFingerprint({
    make: vehicle.make,
    model: vehicle.model,
    model_year: vehicle.year,
    engine_code: engineCode,
    raw_fuel_type: vPicData?.fuel_type ?? null,
    aspiration: vPicData?.turbo ? "turbo" : null,
    displacement_l:
      vPicData?.displacement_l ??
      (vehicle.displacement ? parseFloat(vehicle.displacement) || null : null),
    cylinders: vPicData?.cylinders ?? null,
    engine_manufacturer: vPicData?.engine_manufacturer ?? null,
    // Transmission family is the raw (unreconciled) decode here — deliberately
    // NOT constrained in the prompt (renderVariantConstraints ignores it).
    transmission_family: null,
    speeds: null,
    drivetrain: (vPicData?.drivetrain as "FWD" | "RWD" | "AWD" | "4WD" | null) ?? null,
    gvwr_lbs: vPicData?.gvwr_lbs ?? null,
    resolved_fuel: { fuel_class: fuel.fuel_class, confidence: fuel.confidence, source: fuel.source },
    resolved_build_source: {
      build_source_make: build.build_source_make,
      confidence: build.confidence,
      source: build.source,
    },
  });
  return renderVariantConstraints(fp);
}

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
4. Transcribe OEM part numbers EXACTLY as the source prints them. Every manufacturer
   uses its own format; these three are illustrations of that variety, NOT an allowlist:
   - BMW: 11 digits numeric (e.g., 11427583220) OR alphanumeric up to 13 chars (e.g., 64115A1BDB6)
   - Toyota: 5-5 alphanumeric (e.g., 04152-YZZA1)
   - Honda: segmented alphanumeric (e.g., 15400-PLM-A02)
   If this vehicle's make is not listed above, that means only that no example was given
   for it — NOT that its numbers are invalid. Return the number as printed.
   Nissan 16546-6CB0A, Mopar 68453097AB, Subaru 26296FJ020 and Mercedes 0019828008 are
   all perfectly valid part numbers.
   Return null ONLY when the source does not show a part number for that role. Never
   return null because a number "looks wrong" for the make — format checking is done
   downstream against a per-make pattern table covering 19 makes plus a general
   fallback, and a number you discard here can never be recovered by it.
5. Return OEM part numbers as JSON STRINGS exactly as printed, preserving leading zeros (e.g. "07119963130", never the bare number 7119963130 — an unquoted number silently loses the leading zero and the part is rejected).
6. Return VALID JSON only. No markdown fences, no explanation, no preamble.

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

  const variantConstraints = variantConstraintsFor(vehicle, vPicData);

  return `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} — ${vehicle.engineCode} ${vehicle.displacement}L
${variantConstraints ? `\n${variantConstraints}` : ""}
${vPicSection}

${partsSection}

${manualSection}

${packagesSection}

Return ONE JSON object containing FOUR ARRAYS. Each entry is one row.

A field you cannot determine is OMITTED ENTIRELY — do not emit a row whose value
is null, and never invent a row to fill the shape. An omitted row IS the answer
"this vehicle has no such value / it was not in the sources"; that is a complete,
correct response, and it is preferred over a guess.

For NHTSA-provided fields (drivetrain, turbo, transmission_type,
fuel_injection_type, timing_system) use source_type "nhtsa" and confidence 1.0.

{
  "fields": [
    { "key": "oil_viscosity", "value": "0W-30", "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
    { "key": "oil_capacity_qts", "value": 11.1, "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
    { "key": "drivetrain", "value": "AWD", "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    { "key": "turbo", "value": true, "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    { "key": "spark_plug_quantity", "value": 8, "source_url": null, "source_type": "nhtsa", "confidence": 1.0 },
    { "key": "parking_brake_type", "value": "electronic", "source_url": null, "source_type": "training_data", "confidence": 0.75 }
  ],
  "intervals": [
    { "key": "oil_change", "interval_miles": 10000, "interval_months": 12, "status": "scheduled", "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 },
    { "key": "brake_pads", "interval_miles": 30000, "interval_months": null, "status": "inspect_only", "source_url": "https://...", "source_type": "scraped", "confidence": 0.8 }
  ],
  "oem_parts": [
    { "key": "oil_filter_oem", "value": "11428583898", "observed_title": "Oil Filter Kit", "source_url": "https://...", "source_type": "scraped", "confidence": 0.95 }
  ],
  "rotor_specs": [
    { "axle": "front", "thickness_kind": "discard_min", "value_mm": 24.0, "observed_label": "Minimum Thickness", "observed_value_text": "24.0 mm", "nominal_mm": 26.0, "source_url": "https://...", "source_type": "scraped", "confidence": 0.9 }
  ]
}

ALLOWED "key" VALUES — any other key is invalid and will be discarded.

fields: ${BATCH_1A_FIELD_ROW_KEYS.join(", ")}

intervals: ${BATCH_1A_INTERVAL_KEYS.join(", ")}

oem_parts: ${OEM_PART_KEYS.join(", ")}

rotor_specs axle: "front" or "rear" (one row per axle you have data for)

REMINDERS:
- If timing_system is "chain" (from NHTSA or scraped), set timing_belt_oem to null.
- spark_plug quantity = cylinder count from NHTSA if available (use source_type: "nhtsa").
- If status is "not_applicable" (e.g., timing belt on a chain engine), set miles/months values to null.
- For rotor_front_oem and rotor_rear_oem: both may appear on the same "brake_disc" page. Extract front and rear part numbers separately if they differ by axle position.
- ROTOR THICKNESS (rotor_specs) — THREE DIFFERENT NUMBERS, NEVER INTERCHANGEABLE:
  (a) NOMINAL / new thickness. Parts listings print this inside the size string ("330x22mm" = 330 mm DIAMETER x 22 mm NOMINAL thickness) and under labels like "Thickness", "Disc Thickness", "New Thickness".
  (b) MACHINE-TO / refinish limit — the thinnest a rotor may be machined TO. Labels: "Machining Limit", "Refinish Thickness", "Machine to".
  (c) DISCARD / MINIMUM — the replace-at number, cast on the rotor hat. Labels: "Minimum Thickness", "Min. Thickness", "Discard Thickness", "Discard at", "Wear Limit", "MIN TH".
  ONLY (c) is a minimum. Reporting (a) as a minimum makes us condemn healthy rotors and recommend brake jobs that are not needed — a WORSE outcome than returning null.
- thickness_kind MUST be the category of the label you ACTUALLY READ. A thickness with no qualifying label — a bare "22mm", a size string, or a table row labelled only "Thickness" — is "nominal". NEVER "discard_min".
- observed_label MUST be copied VERBATIM from the page, and observed_value_text must keep the source's own unit ("0.945 in"). If you cannot quote a label you literally saw, return the whole rotor_specs entry as null — a composed label is a fabricated audit trail, and an unlabelled minimum is discarded downstream anyway.
- NEVER derive one rotor number from another. Do not subtract an allowance from the nominal to produce a minimum. Nominal-only is a complete, correct answer: return it as nominal_mm with thickness_kind "nominal" and leave value_mm null.
- The FIRST number in "330x22mm" is the DIAMETER. Never return it as a thickness.
- Convert inches to mm for value_mm and nominal_mm (mm = in × 25.4), keeping the original in observed_value_text.
- rotor_specs is per AXLE and can differ by trim and brake package — use the figures for THIS vehicle's rotors, and return null for an axle with drum brakes.
- Capacities can differ BY DRIVETRAIN on the same engine (2024 Equinox 1.5T: FWD 4.2 qt vs AWD 5.3 qt oil). Use the figure for THIS vehicle's drivetrain (stated in the vehicle description); if the source only gives the other drivetrain's figure, return null.
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
- INTERVALS ARE MODEL-YEAR-SPECIFIC: manufacturers routinely changed schedules at a generation or model-year boundary (e.g. Toyota moved many nameplates from 5,000-mile to 10,000-mile oil intervals at MY2013). Use the schedule published for THIS exact model year; a schedule for the same nameplate's later/earlier years is WRONG. If the source's year coverage does not include this model year, return null rather than the wrong-year value.
- Interval status "scheduled" is a claim that the cadence is the OEM maintenance schedule (owner's manual / warranty & maintenance guide). A dealer-site or aftermarket convention with no OEM schedule behind it (e.g. "brake fluid every 2 years" on a make whose guide says inspect-only, "transmission service every 60k" when the OEM schedule lists none under normal driving) must use status "inspect_only" or "conditional_severe" — never "scheduled".
- battery_oem is the 12V STARTER battery (or its OEM group-size part). NEVER a telematics/DCM battery, key-fob battery, auxiliary/backup battery, or hybrid HV pack component — and NEVER battery-adjacent hardware: a battery CABLE, ground strap/extension, terminal, hold-down, tray, bracket, vent tube, or sensor is not a battery.
- For EVERY *_oem field, also return "observed_title": the EXACT product listing title/heading the source page shows for that part number, copied VERBATIM (null if the page shows no product title). Do not paraphrase or normalize it, and NEVER compose or infer a title — a title you did not literally see on the page must be null (observed_title is evidence, and a composed one corrupts the evidence chain). The title is evidence of WHAT the part is — if the listing's title names an accessory or adjacent hardware (cable, bracket, tray, housing, cap, sensor, hose) instead of the component the field asks for, that number is the WRONG part for the field: return null for value and keep looking in the sources.
- Conditional existence IS the data: returning null for any of the above means the vehicle does not use that part — do not guess a substitute.
- Return null for any field not found in sources and not in the 4 allowed training data fields.`;
}
