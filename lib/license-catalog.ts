/**
 * license-catalog.ts — shared catalog of shop compliance documents.
 *
 * Single source of truth for the licenses & certifications a shop can upload,
 * imported by BOTH the portal owner uploader (components/shop/license-uploader)
 * and the director review UI (app/(director-panel)/.../ShopDetail, TabShops).
 * Data-only (no styling) so it crosses route groups freely.
 *
 * The `shop_licenses.license_type` column is a free string, so:
 *   - known documents use the stable `key`s below (mapped to a human label);
 *   - a CUSTOM document stores its human label directly AS the license_type,
 *     and `licenseLabel()` falls through to the raw value — no schema change,
 *     and the existing single-active-per-type rule keys on that label.
 */

export type DocumentGroup = "license" | "insurance" | "certification";

export type DocumentType = {
  /** Stored in shop_licenses.license_type for known documents. */
  key: string;
  label: string;
  group: DocumentGroup;
  /** Only the state-inspection license unlocks services when verified. */
  gatesServices?: boolean;
  /** Prefilled issuer (e.g. "NY DMV") when the owner uploads this type. */
  issuerDefault?: string;
  /** One-line helper shown under the card title. */
  helper?: string;
};

export const DOCUMENT_TYPES: DocumentType[] = [
  // ── Licenses ──
  {
    key: "dmv_inspection_station",
    label: "NY DMV Inspection Station License",
    group: "license",
    gatesServices: true,
    issuerDefault: "NY DMV",
    helper:
      "Required to offer State Inspection & Emissions Test services to customers.",
  },
  {
    key: "business_license",
    label: "Business License / Repair Shop Registration",
    group: "license",
    helper: "Your state or municipal auto-repair business registration.",
  },
  {
    key: "dealer_license",
    label: "Dealer License",
    group: "license",
    helper: "If you also buy/sell vehicles under a dealer license.",
  },

  // ── Insurance ──
  {
    key: "garage_liability_insurance",
    label: "Garage Liability Insurance (COI)",
    group: "insurance",
    helper: "Certificate of insurance covering your shop operations.",
  },

  // ── Certifications ──
  {
    key: "ase_certification",
    label: "ASE Certification",
    group: "certification",
    helper: "Automotive Service Excellence certification for your technicians.",
  },
  {
    key: "oem_certification",
    label: "Manufacturer / OEM Certification",
    group: "certification",
    helper: "Brand-specific training (e.g. I-CAR, Toyota, BMW).",
  },
  {
    key: "epa_609",
    label: "EPA 609 (A/C) Certification",
    group: "certification",
    helper: "Required to service motor-vehicle air-conditioning refrigerant.",
  },
];

/** Ordered groups with display labels, for section headers on both sides. */
export const DOCUMENT_GROUPS: Array<{
  group: DocumentGroup;
  label: string;
}> = [
  { group: "license", label: "Licenses" },
  { group: "insurance", label: "Insurance" },
  { group: "certification", label: "Certifications" },
];

/** Label shown for the catch-all custom bucket. */
export const CUSTOM_GROUP_LABEL = "Other documents";

const BY_KEY: Record<string, DocumentType> = Object.fromEntries(
  DOCUMENT_TYPES.map((d) => [d.key, d]),
);

/** True when a stored license_type is one of the known catalog keys. */
export function isKnownDocumentType(type: string): boolean {
  return type in BY_KEY;
}

export function documentType(type: string): DocumentType | null {
  return BY_KEY[type] ?? null;
}

/**
 * Human label for a stored license_type. Known keys map to their catalog
 * label; a custom document's license_type IS its label, so it returns as-is.
 */
export function licenseLabel(type: string): string {
  return BY_KEY[type]?.label ?? type;
}

/** Group a stored license_type falls under ("license" | ... | null for custom). */
export function documentGroupOf(type: string): DocumentGroup | null {
  return BY_KEY[type]?.group ?? null;
}
