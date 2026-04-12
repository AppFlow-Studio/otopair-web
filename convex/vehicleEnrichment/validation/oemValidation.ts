/**
 * vehicleEnrichment/validation/oemValidation.ts — OEM part number format validation
 *
 * Brand-specific regex patterns for common automotive OEM part number formats.
 * Invalid formats get flagged (not rejected) since formats vary by part type.
 */

import type { FieldResult } from "../types";

const OEM_PATTERNS: Record<string, RegExp[]> = {
  BMW: [/^\d{11}$/, /^\d{2}\s\d\s\d\s\d{3}\s\d{3}$/],
  Toyota: [/^\d{5}-[A-Z0-9]{5}$/i, /^\d{10}$/, /^9\d{9}$/],
  Honda: [/^[A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4}$/i],
  Hyundai: [/^\d{5}-[A-Z0-9]{5}$/i],
  Kia: [/^\d{5}-[A-Z0-9]{5}$/i],
  "Mercedes-Benz": [/^[A-Z]\d{3}\s?\d{3}\s?\d{2}\s?\d{2}$/i],
  Mercedes: [/^[A-Z]\d{3}\s?\d{3}\s?\d{2}\s?\d{2}$/i],
  Audi: [/^[A-Z0-9]{3}\s?\d{3}\s?\d{3}\s?[A-Z]?$/i],
  Volkswagen: [/^[A-Z0-9]{3}\s?\d{3}\s?\d{3}\s?[A-Z]?$/i, /^\d{9}[A-Z]?$/i],
  Ford: [/^[A-Z0-9]{2,4}-[A-Z0-9]{4,6}-[A-Z0-9]{1,4}$/i, /^\d{4}[A-Z0-9]{4}$/i],
  Chevrolet: [/^\d{7,8}$/, /^\d{10}$/],
  GMC: [/^\d{7,8}$/, /^\d{10}$/],
  Nissan: [/^\d{5}-[A-Z0-9]{2}[A-Z0-9]{2,4}$/i, /^\d{10}$/],
  Subaru: [/^\d{5}-[A-Z0-9]{5}$/i],
  Mazda: [/^[A-Z0-9]{4}-\d{2}-\d{3}[A-Z]?$/i],
  Lexus: [/^\d{5}-[A-Z0-9]{5}$/i, /^\d{10}$/],
  Acura: [/^[A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4}$/i],
  Infiniti: [/^\d{5}-[A-Z0-9]{2}[A-Z0-9]{2,4}$/i],
};

// Fallback: any alphanumeric 4-24 chars with optional separators
const GENERAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\s\-\.]{2,22}[A-Za-z0-9]$/;

/** OEM part fields to validate. */
const OEM_FIELDS = [
  "oil_filter_oem", "air_filter_oem", "cabin_filter_oem",
  "spark_plug_oem", "front_brake_pad_oem", "rear_brake_pad_oem",
  "drain_plug_gasket_oem", "serpentine_belt_oem", "timing_belt_oem",
  "wiper_blade_set_oem",
];

/**
 * Validate a single OEM part number against brand-specific patterns.
 */
export function validateOemPartNumber(
  make: string,
  partNumber: string,
): { valid: boolean; matchedPattern: string } {
  const normalized = make.trim();
  const patterns = OEM_PATTERNS[normalized];

  if (patterns) {
    for (const pattern of patterns) {
      if (pattern.test(partNumber.trim())) {
        return { valid: true, matchedPattern: pattern.source };
      }
    }
    // Try general fallback
    if (GENERAL_PATTERN.test(partNumber.trim())) {
      return { valid: true, matchedPattern: "general_fallback" };
    }
    return { valid: false, matchedPattern: "none" };
  }

  return {
    valid: GENERAL_PATTERN.test(partNumber.trim()),
    matchedPattern: GENERAL_PATTERN.test(partNumber.trim()) ? "general" : "none",
  };
}

/**
 * Validate all OEM part fields in a flat field map.
 * Returns list of invalid parts. Invalid parts are flagged (not nulled).
 */
export function validateAllOemParts(
  fields: Record<string, FieldResult>,
  make: string,
): { field: string; value: string; reason: string }[] {
  const issues: { field: string; value: string; reason: string }[] = [];

  for (const fieldName of OEM_FIELDS) {
    const field = fields[fieldName];
    if (!field || field.value === null || typeof field.value !== "string") continue;

    const { valid, matchedPattern } = validateOemPartNumber(make, field.value);
    if (!valid) {
      issues.push({
        field: fieldName,
        value: field.value,
        reason: `Part number "${field.value}" doesn't match expected ${make} format (tried: ${matchedPattern})`,
      });
      fields[fieldName] = {
        ...field,
        flagged: true,
        flag_reason: `OEM format mismatch for ${make}`,
      };
    }
  }

  return issues;
}
