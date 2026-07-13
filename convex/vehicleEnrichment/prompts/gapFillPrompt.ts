/**
 * vehicleEnrichment/prompts/gapFillPrompt.ts — Batch-3 gap-fill re-ask prompt.
 *
 * One bounded, targeted web-search pass over fields STILL null after Batch 2
 * (reason: the model returned null, or validation dropped the value). Gap
 * fill only — no pricing, no services array — so the response reuses the
 * Batch-2 `gap_fields` contract and parseBatch2 parses it unchanged.
 *
 * Same design principle as Batch 2: minimal system prompt; source quality is
 * enforced mechanically in the parser (blocked domains, sanitization, sanity
 * checks), not via prompt blacklists the model ignores.
 */

import type { VehicleInput } from "../types";
import { FIELD_DESCRIPTIONS } from "./batch2Prompt";

export const GAP_FILL_SYSTEM = `You are a vehicle data specialist for Otopair. Your ONLY job is gap fill: search the web for each field listed under "FIELDS NEEDING GAP FILL". Use 1-2 targeted queries per field: "[year] [make] [model] [field]". If you cannot find a value after 1-2 searches, return null for that field. Do NOT do broad vehicle searches. Do NOT guess from training knowledge — every value needs a source URL.

Return OEM part numbers as JSON STRINGS exactly as printed, preserving leading zeros (e.g. "07119963130", never the bare number 7119963130).

Return VALID JSON only. No markdown fences, no explanation, no preamble.`;

export function buildGapFillPrompt(vehicle: VehicleInput, nullFields: string[]): string {
  const fieldList = nullFields
    .map((f) => `- ${f}: ${FIELD_DESCRIPTIONS[f] || f}`)
    .join("\n");

  return `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} — ${vehicle.engineCode} ${vehicle.displacement}L

=== FIELDS NEEDING GAP FILL (still missing after two extraction passes) ===
${fieldList}

Search for each missing field with 1-2 targeted queries. Return this exact JSON structure:

{
  "gap_fields": {
    "field_name": { "value": ..., "source_url": "...", "source_type": "web_search", "confidence": 0.9 },
    ...
  }
}

Include an entry for every listed field — value null when not found.`;
}
