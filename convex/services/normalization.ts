/**
 * services/normalization.ts — Field value normalizers for consensus grouping.
 *
 * Ensures "11 42 7 583 220" and "11427583220" end up in the same consensus
 * group instead of conflicting. Each normalizer is idempotent.
 */

// ─── Part Numbers ────────────────────────────────────────────────

export function normalizePartNumber(raw: string, make?: string): string {
  // Strip all spaces, hyphens, dots
  const stripped = raw.replace(/[\s\-\.]/g, "").toUpperCase();

  if (make) {
    const m = make.toLowerCase();
    // BMW: 11 pure digits
    if (m === "bmw" && /^\d{11}$/.test(stripped)) {
      return stripped;
    }
    // Toyota/Lexus: 5-5 format (store as stripped digits+letters)
    if ((m === "toyota" || m === "lexus") && /^\d{5}[A-Z0-9]{5}$/.test(stripped)) {
      return stripped;
    }
    // Honda/Acura: segmented (store as stripped)
    if ((m === "honda" || m === "acura") && /^[A-Z0-9]{8,14}$/.test(stripped)) {
      return stripped;
    }
  }

  // Default: alphanumeric only, uppercase
  return stripped.replace(/[^A-Z0-9]/g, "");
}

// ─── Fluid Specs ─────────────────────────────────────────────────

export function normalizeFluidSpec(raw: string): string {
  let s = raw.toLowerCase().trim().replace(/\s+/g, " ");

  // Oil viscosity: extract XW-YY pattern
  const viscosityMatch = s.match(/(\d+)\s*w[\-\s]*(\d+)/i);
  if (viscosityMatch) {
    return `${viscosityMatch[1]}w-${viscosityMatch[2]}`;
  }

  // Brake fluid: "DOT 4", "dot-4", "DOT4" → "dot 4"
  const dotMatch = s.match(/dot[\s\-]*(\d+(?:\.\d+)?(?:\s*lv)?)/i);
  if (dotMatch) {
    return `dot ${dotMatch[1].replace(/\s+/g, " ").trim()}`;
  }

  // BMW coolant: normalize HT-12 variants
  if (s.includes("ht") && s.includes("12")) {
    return "bmw ht-12";
  }

  // ZF Lifeguard: normalize variations
  const zfMatch = s.match(/zf\s*life\s*guard\s*(?:fluid\s*)?(\d+)/i);
  if (zfMatch) {
    return `zf lifeguard ${zfMatch[1]}`;
  }

  return s;
}

// ─── Intervals ───────────────────────────────────────────────────

export function normalizeInterval(raw: string | number): number | null {
  if (typeof raw === "number") {
    return raw > 0 ? raw : null;
  }

  let s = raw.toLowerCase().trim();
  // Remove "miles", "months", commas
  s = s.replace(/,/g, "").replace(/\s*(miles|months|mi|mo)\s*/gi, "");

  // Handle "10k" → "10000"
  const kMatch = s.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kMatch) {
    return parseFloat(kMatch[1]) * 1000;
  }

  const n = parseFloat(s);
  return !isNaN(n) && n > 0 ? n : null;
}

// ─── Tire Size ───────────────────────────────────────────────────

export function normalizeTireSize(raw: string): string {
  // "245/40R19", "245/40/R19", "245/40 R19" → "245/40r19"
  return raw
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\/r/g, "r")
    .replace(/(\d+)\/(\d+)(\d{2})$/, "$1/$2r$3");
}

// ─── Generic ─────────────────────────────────────────────────────

export function normalizeGeneric(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

// ─── Router ──────────────────────────────────────────────────────

const FLUID_FIELDS = new Set([
  "oil_viscosity",
  "coolant_type",
  "brake_fluid_type",
  "trans_fluid_type",
  "diff_fluid_type",
  "transfer_case_fluid_type",
  "tc_fluid_type",
  "ps_fluid_type",
  "power_steering_type",
]);

export function normalizeFieldValue(
  fieldName: string,
  value: string,
  make?: string,
): string {
  if (fieldName.endsWith("_oem")) {
    return normalizePartNumber(value, make);
  }
  if (FLUID_FIELDS.has(fieldName)) {
    return normalizeFluidSpec(value);
  }
  if (fieldName.endsWith("_miles") || fieldName.endsWith("_months")) {
    const n = normalizeInterval(value);
    return n !== null ? String(n) : value;
  }
  if (fieldName.includes("tire_size")) {
    return normalizeTireSize(value);
  }
  return normalizeGeneric(value);
}
