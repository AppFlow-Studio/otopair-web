/**
 * vehicleEnrichment/sourceVerifier.ts — Confidence filter + OEM format validation
 *
 * v3: Replaces string-match verification with confidence-threshold filtering
 * and brand-specific OEM part number format validation. Claude's own confidence
 * assessment (backed by web_search evidence) is the primary quality gate.
 */

import type { FieldResult } from "./helpers";
import { emptyFieldResult } from "./helpers";

// ─── OEM Part Number Format Patterns (ported from v2 vehicle_pipeline.ts) ──

const PART_NUMBER_PATTERNS: Record<string, RegExp[]> = {
  Honda: [/^[A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4}$/i, /^[0-9]{8}-[A-Z0-9]{3}$/i],
  Acura: [/^[A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4}$/i],
  Toyota: [/^[0-9]{5}-[0-9A-Z]{5}$/i, /^[0-9]{10}$/, /^9[0-9]{9}$/],
  Lexus: [/^[0-9]{5}-[0-9A-Z]{5}$/i, /^[0-9]{10}$/],
  Nissan: [/^[0-9]{5}-[A-Z0-9]{2}[A-Z0-9]{2,4}$/i, /^[0-9]{10}$/],
  Infiniti: [/^[0-9]{5}-[A-Z0-9]{2}[A-Z0-9]{2,4}$/i],
  BMW: [/^[0-9]{2}\s?[0-9]{2}\s?[0-9]\s?[0-9]{3}\s?[0-9]{3}$/, /^[0-9]{11}$/],
  "Mercedes-Benz": [/^[A-Z]{1,3}\s?[0-9]{3}\s?[0-9]{3}\s?[0-9]{2}\s?[0-9]{2}$/i, /^[A-Z0-9]{10,13}$/i],
  Ford: [/^[A-Z0-9]{2}[A-Z0-9]{2}-[0-9]{4}[A-Z]$/i, /^[0-9]{4}[A-Z0-9]{4}$/i],
  Lincoln: [/^[A-Z0-9]{2}[A-Z0-9]{2}-[0-9]{4}[A-Z]$/i],
  Chevrolet: [/^[0-9]{8}$/, /^[0-9]{10}$/],
  GMC: [/^[0-9]{8}$/, /^[0-9]{10}$/],
  Cadillac: [/^[0-9]{8}$/, /^[0-9]{10}$/],
  Hyundai: [/^[0-9]{5}-[A-Z0-9]{5}$/i],
  Kia: [/^[0-9]{5}-[A-Z0-9]{5}$/i],
  Subaru: [/^[0-9]{5}-[A-Z0-9]{5}$/i, /^[0-9]{5}[A-Z]{2}[0-9]{3}$/i],
  Mazda: [/^[A-Z0-9]{4}-[0-9]{2}-[0-9]{3}[A-Z]?$/i],
  Volkswagen: [/^[0-9]{3}\s?[0-9]{3}\s?[0-9]{3}[A-Z]?$/i, /^[0-9]{9}[A-Z]?$/i],
  Audi: [/^[0-9]{3}\s?[0-9]{3}\s?[0-9]{3}[A-Z]?$/i],
};

/** Check if a part number matches expected OEM format for the given make. */
function validatePartNumberFormat(partNumber: string, make: string): boolean {
  const normalized = partNumber.trim();
  if (!normalized || normalized === "N/A") return true; // Skip empty
  if (normalized.length < 4 || normalized.length > 24) return false;

  const patterns = PART_NUMBER_PATTERNS[make];
  if (patterns) {
    return patterns.some((p) => p.test(normalized));
  }
  // Unknown make: accept alphanumeric with common separators
  return /^[A-Z0-9\s\-\.]+$/i.test(normalized);
}

// ─── OEM Part Field Names ──────────────────────────────────────────

const OEM_PART_FIELDS = new Set([
  "oil_filter_oem",
  "air_filter_oem",
  "cabin_filter_oem",
  "spark_plug_oem",
  "front_brake_pad_oem",
  "rear_brake_pad_oem",
  "drain_plug_gasket_oem",
]);

// ─── Confidence Filter ─────────────────────────────────────────────

/**
 * Filter extracted data by confidence threshold and validate OEM part formats.
 *
 * - Rejects fields with confidence < 0.6
 * - Validates OEM part number formats (brand-specific regex)
 * - Sets verified=true for confidence >= 0.8
 * - Returns FieldResult map ready for storage
 */
export function filterByConfidence(
  extracted: Record<string, any>,
  make: string,
): Record<string, FieldResult> {
  const result: Record<string, FieldResult> = {};
  let accepted = 0;
  let rejectedConf = 0;
  let rejectedFormat = 0;
  let nullInput = 0;

  for (const [key, raw] of Object.entries(extracted)) {
    // Null or missing value
    if (!raw || raw.value == null) {
      nullInput++;
      result[key] = emptyFieldResult();
      continue;
    }

    // Confidence threshold: reject below 0.6
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
    if (confidence < 0.6) {
      rejectedConf++;
      console.warn(
        `[filterByConfidence] REJECTED ${key}: confidence ${confidence} < 0.6 (value="${raw.value}", source="${raw.source}")`,
      );
      result[key] = emptyFieldResult();
      continue;
    }

    // OEM part number format validation
    if (OEM_PART_FIELDS.has(key) && typeof raw.value === "string") {
      // Normalize: strip spaces from part numbers before validation
      const normalized = raw.value.replace(/\s+/g, "");
      if (!validatePartNumberFormat(normalized, make)) {
        rejectedFormat++;
        console.warn(
          `[filterByConfidence] REJECTED ${key}: format invalid for ${make}: "${raw.value}" (normalized: "${normalized}")`,
        );
        result[key] = emptyFieldResult();
        continue;
      }
      // Use normalized value for storage
      raw.value = normalized;
    }

    // Accepted — build FieldResult
    accepted++;
    result[key] = {
      value: raw.value,
      source: raw.source ?? null,
      confidence: confidence,
      verified: confidence >= 0.8,
      apiConfirmed: false,
      apiDisagreed: false,
      apiValue: null,
    };
  }

  console.log(
    `[filterByConfidence] Results: ${accepted} accepted, ${rejectedConf} rejected (low conf), ${rejectedFormat} rejected (bad format), ${nullInput} null input`,
  );

  return result;
}
