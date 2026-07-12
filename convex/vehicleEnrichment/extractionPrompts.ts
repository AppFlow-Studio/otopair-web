/**
 * vehicleEnrichment/extractionPrompts.ts — Claude prompt templates (v3)
 *
 * Prompts now include <source_material> blocks from Firecrawl pre-gather
 * and instruct Claude to use web_search for gaps. The system prompt no
 * longer forbids training data — it assigns confidence tiers instead.
 *
 * Four prompt builders:
 *   - Call 1A: Fluids, service intervals, vehicle attributes
 *   - Call 1B: OEM part numbers
 *   - Call 2:  Pricing using confirmed part numbers
 *   - Gap Fill: Targeted retry for remaining null fields
 */

import type { VehicleInput, FirecrawlResult, EnrichedVehicleData } from "./helpers";

// ─── System Prompt (shared across all calls) ───────────────────────

export const SYSTEM_PROMPT = `You are an automotive data extraction specialist for Otopair. You have access to web search and pre-gathered source material.

Use this priority order for every field:
1. FIRST: Extract from the provided SOURCE MATERIAL (highest confidence)
2. SECOND: Use web_search to verify or find values not in source material
3. THIRD: Use your training knowledge for well-documented specs only (lower confidence)

Confidence scoring (MUST follow):
- 1.0 = exact value from OEM source material or official manufacturer documentation
- 0.9 = clearly stated on reputable automotive site (Edmunds, Car and Driver, official parts retailer)
- 0.8 = stated on forum or third-party parts site with corroborating evidence from 2+ pages
- 0.7 = from your training knowledge, well-documented fact for this specific vehicle
- 0.6 = from training knowledge, less certain or applies to a model range
- Below 0.6 = return null — do NOT guess

CRITICAL for NUMERIC SPECS (fluid capacities, torques, intervals, pressures):
- A single forum / community / crowd-answer post is NOT a reliable source for a number.
  If a numeric value appears ONLY on a forum with no OEM/manufacturer corroboration,
  score it no higher than 0.6 (and prefer to return null). Never score a single-forum
  number 0.8+.
- Prefer OEM / manufacturer / official service documentation for every numeric spec.
- Report the value for the EXACT engine code provided — do NOT use a figure for a
  different engine option offered on the same model.
- Capacities must be in US quarts. If a source gives liters, CONVERT to quarts
  (quarts = liters × 1.057) before returning. Never copy a liter figure as a quart figure.

For each field return: { "value": ..., "source": "url or 'training_data'", "confidence": 0.0-1.0 }

Return ONLY valid JSON with no preamble, explanation, or markdown formatting.`;

// ─── Source Block Builder ──────────────────────────────────────────

const MAX_TOTAL_SOURCE_CHARS = 20_000;

function sourceBlock(sources: FirecrawlResult[], label: string = "SOURCE MATERIAL"): string {
  if (!sources || sources.length === 0) return "";

  let total = 0;
  const blocks: string[] = [];

  for (const [i, s] of sources.entries()) {
    const remaining = MAX_TOTAL_SOURCE_CHARS - total;
    if (remaining <= 500) break;

    const md =
      s.markdown.length > remaining
        ? s.markdown.slice(0, remaining) + "\n...[truncated]"
        : s.markdown;

    blocks.push(`--- SOURCE ${i + 1}: ${s.title || "Untitled"} (${s.url}) ---\n${md}`);
    total += md.length;
  }

  return `<source_material>\n## ${label}\n${blocks.join("\n\n")}\n</source_material>`;
}

function vehicleBlock(v: VehicleInput): string {
  return `## VEHICLE
Year: ${v.year}
Make: ${v.make}
Model: ${v.model}
Trim: ${v.trim}
Engine Code: ${v.engineCode}
Displacement: ${v.displacement}`;
}

// ─── Call 1A: Fluids, Intervals, Attributes ────────────────────────

export function buildCall1APrompt(
  vehicle: VehicleInput,
  sources: FirecrawlResult[],
): string {
  const base = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;

  return `${vehicleBlock(vehicle)}

${sourceBlock(sources, "PRE-GATHERED: Fluids, Intervals & Attributes")}

## SEARCH STRATEGY
Read the source material above FIRST. For fields not found in sources, use web_search:
1. "${base} owner's manual maintenance schedule"
2. "${vehicle.make} ${vehicle.engineCode || vehicle.displacement + "L"} oil type capacity"
3. "${base} ${vehicle.trim} service intervals miles months"
4. "${base} power steering type timing chain or belt turbo"
Use remaining searches to fill gaps.

## EXTRACT THESE FIELDS

### FLUIDS
- oil_viscosity: OEM recommended engine oil viscosity (e.g. "5W-30"). Must be manufacturer spec.
- oil_capacity_qts: Engine oil capacity in US quarts WITH filter change. Number only. If a source lists liters, convert to quarts (× 1.057).
- coolant_type: OEM coolant specification (e.g. "BMW Long Life Coolant", "HOAT", "OAT", "G13").
- coolant_capacity_qts: Cooling system total capacity in US quarts. Number only. Often published in LITERS — convert to quarts (× 1.057); do NOT copy a liter value. Use the exact engine (${vehicle.engineCode || vehicle.displacement + "L"}), not other engine options. A lone forum post is not sufficient — needs OEM/2+ corroboration.
- power_steering_type: One of exactly: "electric", "hydraulic", "none".
- brake_fluid_type: Exact spec (e.g. "DOT 4", "DOT 4 LV", "DOT 3").

### SERVICE INTERVALS
Return miles AND months separately. If only one unit is available, return the other as null.
- oil_change_miles / oil_change_months
- spark_plug_miles / spark_plug_months
- transmission_service_miles / transmission_service_months
- coolant_flush_miles / coolant_flush_months
- air_filter_miles / air_filter_months
- cabin_filter_miles / cabin_filter_months

### VEHICLE ATTRIBUTES
- timing_system: One of: "chain", "belt". null if not found.
- drivetrain: One of: "FWD", "RWD", "AWD", "4WD". null if not found.
- turbo: true or false. null if not found.

## OUTPUT FORMAT
Return ONLY this JSON structure:
{
  "oil_viscosity": { "value": null, "source": null, "confidence": null },
  "oil_capacity_qts": { "value": null, "source": null, "confidence": null },
  "coolant_type": { "value": null, "source": null, "confidence": null },
  "coolant_capacity_qts": { "value": null, "source": null, "confidence": null },
  "power_steering_type": { "value": null, "source": null, "confidence": null },
  "brake_fluid_type": { "value": null, "source": null, "confidence": null },
  "oil_change_miles": { "value": null, "source": null, "confidence": null },
  "oil_change_months": { "value": null, "source": null, "confidence": null },
  "spark_plug_miles": { "value": null, "source": null, "confidence": null },
  "spark_plug_months": { "value": null, "source": null, "confidence": null },
  "transmission_service_miles": { "value": null, "source": null, "confidence": null },
  "transmission_service_months": { "value": null, "source": null, "confidence": null },
  "coolant_flush_miles": { "value": null, "source": null, "confidence": null },
  "coolant_flush_months": { "value": null, "source": null, "confidence": null },
  "air_filter_miles": { "value": null, "source": null, "confidence": null },
  "air_filter_months": { "value": null, "source": null, "confidence": null },
  "cabin_filter_miles": { "value": null, "source": null, "confidence": null },
  "cabin_filter_months": { "value": null, "source": null, "confidence": null },
  "timing_system": { "value": null, "source": null, "confidence": null },
  "drivetrain": { "value": null, "source": null, "confidence": null },
  "turbo": { "value": null, "source": null, "confidence": null }
}`;
}

// ─── Call 1B: OEM Part Numbers ─────────────────────────────────────

export function buildCall1BPrompt(
  vehicle: VehicleInput,
  sources: FirecrawlResult[],
): string {
  const year = Math.round(vehicle.year);

  return `${vehicleBlock(vehicle)}

${sourceBlock(sources, "PRE-GATHERED: OEM Parts & Catalog Pages")}

## YEAR-PINNING RULES
1. Every part number MUST apply to model year ${year}.
2. If a part number covers multiple years (e.g. "2018-2023") and ${year} is in that range, that's VALID — use confidence 0.8-0.9.
3. If you find a part number but cannot confirm it fits ${year}, set confidence to 0.6 (still include it).
4. OEM part numbers have make-specific formats:
   - BMW: 11 digits (e.g. 11428570590, 34216896975, 64316835405)
   - Toyota: 5+5 format with dash (e.g. 04152-YZZA1)
   - Honda: alphanumeric with dashes (e.g. 15400-PLM-A02)
   - Ford: alphanumeric with dashes
   - GM: 8-digit (e.g. 55594651)
5. Aftermarket "replaces OEM #" listings: extract the OEM number referenced, use confidence 0.7.
6. Part numbers with spaces are fine — return digits only (e.g. "11 42 8 570 590" → "11428570590"). Always as a JSON STRING preserving leading zeros (e.g. "07119963130", never the bare number 7119963130).

## SEARCH STRATEGY
Check source material FIRST. Then use web_search aggressively — you have ${10} searches available:
1. "${year} ${vehicle.make} ${vehicle.model} ${vehicle.engineCode} oil filter OEM part number"
2. "${year} ${vehicle.make} ${vehicle.model} spark plug OEM part number"
3. "${year} ${vehicle.make} ${vehicle.model} air filter cabin filter OEM part number"
4. "${year} ${vehicle.make} ${vehicle.model} front brake pad rear brake pad OEM"
5. "${vehicle.make} ${vehicle.engineCode} drain plug gasket part number"
6. "${year} ${vehicle.make} ${vehicle.model} battery group size CCA"
7. "${year} ${vehicle.make} ${vehicle.model} parking brake type electronic manual"
If a search doesn't return what you need, try different terms. Prioritize OEM parts sites and manufacturer catalogs.

## EXTRACT THESE FIELDS
OEM part numbers ONLY. Do NOT return aftermarket substitutes unless labeled OEM-equivalent.

- oil_filter_oem
- air_filter_oem
- cabin_filter_oem
- spark_plug_oem
- front_brake_pad_oem
- rear_brake_pad_oem
- drain_plug_gasket_oem
- battery_group: BCI group size (e.g. "H6", "35", "51R")
- battery_cca: Cold cranking amps as a number
- parking_brake_type: One of: "electronic", "manual", "drum-in-hat"

## OUTPUT FORMAT
Return ONLY this JSON:
{
  "oil_filter_oem": { "value": null, "source": null, "confidence": null },
  "air_filter_oem": { "value": null, "source": null, "confidence": null },
  "cabin_filter_oem": { "value": null, "source": null, "confidence": null },
  "spark_plug_oem": { "value": null, "source": null, "confidence": null },
  "front_brake_pad_oem": { "value": null, "source": null, "confidence": null },
  "rear_brake_pad_oem": { "value": null, "source": null, "confidence": null },
  "drain_plug_gasket_oem": { "value": null, "source": null, "confidence": null },
  "battery_group": { "value": null, "source": null, "confidence": null },
  "battery_cca": { "value": null, "source": null, "confidence": null },
  "parking_brake_type": { "value": null, "source": null, "confidence": null }
}`;
}

// ─── Call 2: Pricing ───────────────────────────────────────────────

export function buildCall2Prompt(
  vehicle: VehicleInput,
  confirmedParts: Partial<EnrichedVehicleData>,
  sources: FirecrawlResult[],
): string {
  const partLines: string[] = [];
  const partFields = [
    "oil_filter_oem",
    "air_filter_oem",
    "cabin_filter_oem",
    "spark_plug_oem",
    "front_brake_pad_oem",
    "rear_brake_pad_oem",
    "drain_plug_gasket_oem",
  ] as const;

  for (const key of partFields) {
    const field = confirmedParts[key];
    if (field && field.value != null) {
      partLines.push(`${key}: ${field.value}`);
    }
  }

  return `${vehicleBlock(vehicle)}

## CONFIRMED OEM PART NUMBERS
These part numbers have been verified. Use them to find accurate pricing.
${partLines.length > 0 ? partLines.join("\n") : "(no confirmed part numbers)"}

${sourceBlock(sources, "PRE-GATHERED: Pricing Sources")}

## YOUR TASK
Find prices for the following services. Return price in USD as a number.
- oil_change_price: Total oil change cost (oil + filter + labor) or parts-only OEM price if labor unknown
- brake_pad_front_price: Front brake pad set OEM price
- brake_pad_rear_price: Rear brake pad set OEM price
- spark_plug_price: Full set of spark plugs OEM price
- air_filter_price: Engine air filter OEM price
- cabin_filter_price: Cabin air filter OEM price

Also extract labor estimates (flat rate hours):
- estimated_labor_oil_change_hrs: flat rate labor hours for oil change
- estimated_labor_brake_front_hrs: flat rate for front brake pad replacement
- estimated_labor_brake_rear_hrs: flat rate for rear brake pad replacement
- estimated_labor_spark_plug_hrs: flat rate for spark plug replacement

Use web_search to find current prices from OEM parts retailers, dealer sites, or reputable auto parts stores. If a range is found, return the lower OEM price.

## OUTPUT FORMAT
{
  "oil_change_price": { "value": null, "source": null, "confidence": null },
  "brake_pad_front_price": { "value": null, "source": null, "confidence": null },
  "brake_pad_rear_price": { "value": null, "source": null, "confidence": null },
  "spark_plug_price": { "value": null, "source": null, "confidence": null },
  "air_filter_price": { "value": null, "source": null, "confidence": null },
  "cabin_filter_price": { "value": null, "source": null, "confidence": null },
  "estimated_labor_oil_change_hrs": { "value": null, "source": null, "confidence": null },
  "estimated_labor_brake_front_hrs": { "value": null, "source": null, "confidence": null },
  "estimated_labor_brake_rear_hrs": { "value": null, "source": null, "confidence": null },
  "estimated_labor_spark_plug_hrs": { "value": null, "source": null, "confidence": null }
}`;
}

// ─── Gap Fill Prompt ───────────────────────────────────────────────

const FIELD_DESCRIPTIONS: Record<string, string> = {
  oil_viscosity: "OEM recommended engine oil viscosity",
  oil_capacity_qts: "Engine oil capacity in quarts (with filter)",
  coolant_type: "OEM coolant type/specification",
  coolant_capacity_qts: "Cooling system capacity in quarts",
  power_steering_type: "Power steering type (electric/hydraulic)",
  brake_fluid_type: "Brake fluid specification (DOT 4, etc.)",
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
  timing_system: "Timing chain or belt",
  drivetrain: "Drivetrain type (FWD/RWD/AWD/4WD)",
  turbo: "Whether vehicle is turbocharged",
  oil_filter_oem: "OEM oil filter part number",
  air_filter_oem: "OEM engine air filter part number",
  cabin_filter_oem: "OEM cabin air filter part number",
  spark_plug_oem: "OEM spark plug part number",
  front_brake_pad_oem: "OEM front brake pad set part number",
  rear_brake_pad_oem: "OEM rear brake pad set part number",
  drain_plug_gasket_oem: "OEM oil drain plug gasket part number",
  battery_group: "Battery BCI group size",
  battery_cca: "Battery cold cranking amps",
  parking_brake_type: "Parking brake type (electronic/manual)",
};

export function buildGapFillPrompt(
  vehicle: VehicleInput,
  nullFields: string[],
  sources: FirecrawlResult[],
): string {
  const fieldList = nullFields
    .map((f) => `- ${f}: ${FIELD_DESCRIPTIONS[f] || f}`)
    .join("\n");

  return `${vehicleBlock(vehicle)}

${sourceBlock(sources, "PREVIOUSLY GATHERED SOURCES (may contain useful data)")}

## TASK
The following fields are still missing after initial extraction. Use web_search to find them.
For OEM part numbers, search for the specific part for model year ${Math.round(vehicle.year)}.
Return null if you cannot verify the value — null is better than wrong.

## MISSING FIELDS
${fieldList}

## OUTPUT FORMAT
Return JSON with ONLY the fields listed above:
{
${nullFields.map((f) => `  "${f}": { "value": null, "source": null, "confidence": null }`).join(",\n")}
}`;
}
