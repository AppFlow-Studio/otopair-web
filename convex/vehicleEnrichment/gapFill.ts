/**
 * vehicleEnrichment/gapFill.ts — Sibling engine lookup + targeted retry (v3)
 *
 * Two strategies to fill null fields:
 * 1. Sibling engines: reuse verified data from the same engine code (free)
 * 2. Targeted retry: single Claude call with web_search for remaining nulls
 *
 * v3 changes: uses callClaudeWithWebSearch instead of callClaude,
 * filterByConfidence instead of verifyAllFields, single batch retry
 * instead of per-field retries.
 */

import { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type {
  VehicleInput,
  FieldResult,
  FirecrawlResult,
} from "./helpers";
import { emptyFieldResult } from "./helpers";
import { callClaudeWithWebSearch } from "./claudeExtractor";
import { SYSTEM_PROMPT, buildGapFillPrompt } from "./extractionPrompts";
import { filterByConfidence } from "./sourceVerifier";

// Engine-specific fields safe to cross-reference from siblings.
// Brake pads, rotors, tire specs vary by trim — NOT safe to copy.
const CROSS_REF_SAFE = new Set([
  "oil_viscosity",
  "oil_capacity_qts",
  "coolant_type",
  "coolant_capacity_qts",
  "brake_fluid_type",
  "oil_change_miles",
  "oil_change_months",
  "spark_plug_miles",
  "spark_plug_months",
  "transmission_service_miles",
  "transmission_service_months",
  "coolant_flush_miles",
  "coolant_flush_months",
  "timing_system",
  "turbo",
  "oil_filter_oem",
  "drain_plug_gasket_oem",
  "spark_plug_oem",
]);

/**
 * Look up other vehicles with the same engine code that already have
 * enriched data. Copy high-confidence values with a slight confidence
 * penalty (−0.1) since they're from a sibling trim, not this exact one.
 *
 * Only copies engine-specific fields (CROSS_REF_SAFE), not trim-specific ones.
 */
export async function fillFromSiblingEngines(
  engineCode: string,
  nullFields: string[],
  ctx: ActionCtx,
): Promise<Record<string, FieldResult>> {
  const filled: Record<string, FieldResult> = {};

  try {
    const siblings = await ctx.runQuery(
      internal.vehicleEnrichment.queries.getByEngineCode,
      { engineCode },
    );

    if (!siblings || siblings.length === 0) return filled;

    const eligibleFields = nullFields.filter((f) => CROSS_REF_SAFE.has(f));

    for (const field of eligibleFields) {
      for (const sibling of siblings) {
        const siblingField = sibling[field as keyof typeof sibling] as
          | FieldResult
          | undefined;

        if (
          siblingField &&
          typeof siblingField === "object" &&
          siblingField.value != null &&
          siblingField.verified &&
          typeof siblingField.confidence === "number" &&
          siblingField.confidence >= 0.8
        ) {
          filled[field] = {
            ...siblingField,
            confidence: Math.max(0.6, siblingField.confidence - 0.1),
            source: `sibling_engine:${(sibling as any).engineConfig || "unknown"}`,
          };
          break; // Use first matching sibling
        }
      }
    }
  } catch (error) {
    console.error("[gapFill] Sibling engine lookup failed:", error);
  }

  return filled;
}

/**
 * Retry null fields with a single Claude call using web_search.
 * Passes pre-gathered source context for reference. Limited to 5 fields
 * to keep costs low — picks the highest-value fields first.
 */
export async function retryNullFields(
  vehicle: VehicleInput,
  nullFields: string[],
  allSources: FirecrawlResult[],
): Promise<Record<string, FieldResult>> {
  const filled: Record<string, FieldResult> = {};

  // Limit to 5 fields to control cost
  const maxFields = 5;
  const priorityFields = nullFields.slice(0, maxFields);

  if (priorityFields.length === 0) return filled;

  try {
    const prompt = buildGapFillPrompt(vehicle, priorityFields, allSources);

    // Single Claude call with web_search for all gap fields
    const result = await callClaudeWithWebSearch(
      SYSTEM_PROMPT,
      prompt,
      5, // max web searches
      4000,
    );

    // Apply confidence filtering (no string-match verification)
    const filtered = filterByConfidence(result.data, vehicle.make);

    // Only take fields we were looking for
    for (const field of priorityFields) {
      if (filtered[field] && filtered[field].value != null) {
        filled[field] = filtered[field];
      }
    }

    console.log(
      `[gapFill] Retry filled ${Object.keys(filled).length}/${priorityFields.length} fields`,
    );
  } catch (error) {
    console.error("[gapFill] Retry failed:", error);
  }

  return filled;
}
