/**
 * vehicleEnrichment/prompts/batch1bPrompt.ts — Batch 1B prompts (WITH web_search)
 *
 * Batch 1B runs in parallel with Batch 1A (same Batch API call).
 * Its job: use web_search to find service intervals, fluid specs, and vehicle attributes
 * that may not be in the scraped OEM parts catalog or owner's manual.
 *
 * DESIGN: Batch 1B is fully independent of Batch 1A — it receives no scraped content,
 * only the vehicle identity. This allows true parallel execution. The merge in
 * _pollBatch1 takes Batch 1A values first (scraped = more authoritative), then fills
 * nulls from Batch 1B (web search).
 *
 * Fields covered by Batch 1B:
 * - ALL service intervals (oil, spark plug, trans, coolant, air/cabin filter, brake fluid,
 *   serpentine belt, timing) — via manufacturer maintenance schedule search
 * - NEW intervals: diff fluid, transfer case fluid — drivetrain-specific
 * - Fluid specs: oil viscosity, coolant type, brake fluid type, power steering type,
 *   trans fluid type, diff fluid type, transfer case fluid type
 * - Battery: group size, CCA
 * - Tire specs: sizes, pressures, lug nut torque, wiper sizes
 * - Attributes: timing system, parking brake type
 */

import type { VehicleInput } from "../types";

export const BATCH_1B_SYSTEM = `You are a vehicle data specialist for Otopair. Your job is to search the web for accurate maintenance intervals, fluid specifications, and technical specifications for the given vehicle.

RULES:
1. Use targeted, specific search queries. For intervals: "[year] [make] [model] maintenance schedule". For specs: "[year] [make] [model] [spec name]".
2. Use 1-2 searches per field. Do NOT run broad exploratory searches.
3. For each value found, record the exact source URL and assign confidence:
   - 0.95: OEM source (manufacturer website, official owner's manual PDF)
   - 0.85: Reputable site (dealer site, AutoZone, NAPA, RockAuto, known forum with consensus)
   - 0.75: Training data (use for well-known stable facts you are highly confident of)
   - Below 0.75: Return null — do not guess
4. NHTSA data overrides: drivetrain, turbo, transmission_type, fuel_injection_type — use training knowledge for these only if you are highly confident.
5. For diff_fluid and transfer_case_fluid intervals: if the vehicle is FWD (no differential, no transfer case), set status to "not_applicable" and miles/months to null.
6. Return VALID JSON only. No markdown fences, no explanation.`;

export function buildBatch1bPrompt(vehicle: VehicleInput): string {
  return `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} — ${vehicle.engineCode} ${vehicle.displacement}L

Search the web to find the following data for this exact vehicle. Use targeted queries like "${vehicle.year} ${vehicle.make} ${vehicle.model} maintenance schedule" and "${vehicle.year} ${vehicle.make} ${vehicle.model} fluid specifications".

Return this exact JSON structure:

{
  "intervals": {
    "oil_change": {
      "miles": { "value": 10000, "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
      "months": { "value": 12, "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
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
    "diff_fluid": {
      "miles": { "value": 30000, "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 },
      "months": { "value": null, "source_url": null, "source_type": null, "confidence": null },
      "status": "scheduled",
      "display_string": "Every 30,000 miles"
    },
    "transfer_case_fluid": { "miles": { ... }, "months": { ... }, "status": "...", "display_string": "..." }
  },
  "fluids": {
    "oil_viscosity": { "value": "0W-30", "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "oil_capacity_qts": { "value": 7.4, "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 },
    "coolant_type": { "value": "BMW HT-12", "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "coolant_capacity_qts": { "value": 9.25, "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 },
    "brake_fluid_type": { "value": "DOT 4", "source_url": null, "source_type": "training_data", "confidence": 0.75 },
    "power_steering_type": { "value": "electric", "source_url": null, "source_type": "training_data", "confidence": 0.75 },
    "trans_fluid_type": { "value": "ZF Lifeguard 8", "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "diff_fluid_type": { "value": "SAE 75W-90", "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 },
    "transfer_case_fluid_type": { "value": "ATF+4", "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 }
  },
  "battery": {
    "battery_group": { "value": "H8/Group 49", "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 },
    "battery_cca": { "value": 850, "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 }
  },
  "attributes": {
    "timing_system": { "value": "chain", "source_url": null, "source_type": "training_data", "confidence": 0.75 },
    "parking_brake_type": { "value": "electronic", "source_url": null, "source_type": "training_data", "confidence": 0.75 }
  },
  "trim_specs": {
    "front_tire_size": { "value": "245/45R18", "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "rear_tire_size": { "value": "275/40R18", "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "tire_pressure_front_psi": { "value": 35, "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "tire_pressure_rear_psi": { "value": 38, "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "lug_nut_torque_ft_lbs": { "value": 103, "source_url": "https://...", "source_type": "web_search", "confidence": 0.9 },
    "front_wiper_size": { "value": "26", "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 },
    "rear_wiper_size": { "value": null, "source_url": null, "source_type": null, "confidence": null }
  },
  "spark_plug": {
    "gap_mm": { "value": 0.7, "source_url": "https://...", "source_type": "web_search", "confidence": 0.85 }
  }
}

IMPORTANT REMINDERS:
- diff_fluid and transfer_case_fluid: if FWD (no rear differential, no transfer case), set status: "not_applicable" and values to null.
- timing_belt_or_chain_service: if timing_system is "chain", the status is typically "not_applicable" (chain is inspect-only or lifetime). If timing_system is "belt", fill the interval.
- transmission_service: for "lifetime" fluid (ZF 8HP), status = "not_applicable". For normal service intervals, fill miles/months.
- Return null for any field you cannot confidently determine after 1-2 searches.`;
}
