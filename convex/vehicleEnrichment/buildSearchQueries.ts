/**
 * vehicleEnrichment/buildSearchQueries.ts — Query builder + OEM domain table
 *
 * Pure utility functions for constructing search queries and OEM catalog
 * URLs from vehicle identity. No side effects, no API calls, fully testable.
 */

import type { VehicleInput } from "./helpers";

// ─── OEM Parts Catalog Domains ─────────────────────────────────────
// Maps each make to its known OEM parts catalog domains.
// Used for site:-scoped Firecrawl searches that prioritize manufacturer data.

export const OEM_DOMAINS: Record<string, string[]> = {
  BMW: ["realoem.com", "getbmwparts.com"],
  Toyota: ["parts.toyota.com", "toyotapartsdeal.com"],
  Lexus: ["parts.toyota.com"],
  Honda: ["estore.honda.com", "hondapartsnow.com"],
  Acura: ["acurapartsnow.com"],
  Ford: ["parts.ford.com"],
  Lincoln: ["parts.ford.com"],
  Chevrolet: ["gmpartsdirect.com", "gmpartsstore.com"],
  GMC: ["gmpartsdirect.com"],
  Cadillac: ["gmpartsdirect.com"],
  Hyundai: ["hyundaipartsdeal.com"],
  Kia: ["kiapartsnow.com"],
  Nissan: ["nissanpartsdeal.com", "parts.nissanusa.com"],
  Infiniti: ["infinitipartsdeal.com"],
  "Mercedes-Benz": ["mbparts.com"],
  Subaru: ["parts.subaru.com"],
  Volkswagen: ["parts.vw.com"],
  Audi: ["audipartsdeal.com"],
  Mazda: ["mazdapartsdeal.com"],
};

// ─── Search Query Builder ──────────────────────────────────────────

export interface PreGatherQueries {
  fluidsQuery: string;
  partsQuery: string;
  oemSiteQuery: string | null;
}

/**
 * Construct search queries from vehicle identity.
 * Returns three queries: fluids/intervals, OEM parts, and optional site-scoped OEM query.
 */
export function buildPreGatherQueries(vehicle: VehicleInput): PreGatherQueries {
  const { year, make, model, engineCode } = vehicle;
  const base = `${year} ${make} ${model}`;
  const engineDesc = engineCode || "";

  return {
    fluidsQuery: `${base} ${engineDesc} engine oil viscosity capacity coolant service intervals maintenance schedule owner's manual`.trim(),
    partsQuery: `${base} ${engineDesc} OEM oil filter air filter cabin filter spark plug brake pad part number`.trim(),
    oemSiteQuery: buildOemSiteQuery(make, year, model),
  };
}

/**
 * Build a site:-scoped search query targeting OEM parts catalogs.
 * Returns null if no OEM domains are known for this make.
 */
function buildOemSiteQuery(
  make: string,
  year: number,
  model: string,
): string | null {
  const domains = OEM_DOMAINS[make];
  if (!domains || domains.length === 0) return null;

  // Use the first domain for a site: query (Firecrawl handles site: well)
  const siteFilter = domains
    .slice(0, 2)
    .map((d) => `site:${d}`)
    .join(" OR ");
  return `${siteFilter} ${year} ${model} oil filter air filter parts catalog`;
}

/**
 * Get the direct OEM catalog URL for scraping (if known for this make).
 * Returns null for unknown makes — pipeline falls back to general search.
 */
export function getOemCatalogUrl(
  make: string,
  vehicle: VehicleInput,
): string | null {
  const builders: Record<string, (v: VehicleInput) => string | null> = {
    BMW: (v) =>
      `https://www.getbmwparts.com/search?q=${encodeURIComponent(`${v.year} ${v.model} oil filter air filter`)}`,
    Toyota: (v) =>
      `https://parts.toyota.com/search?q=${encodeURIComponent(`${v.year} ${v.model} oil filter`)}`,
    Honda: (v) =>
      `https://www.hondapartsnow.com/parts-list/${v.year}-honda-${v.model.toLowerCase().replace(/\s+/g, "-")}.html`,
    Hyundai: (v) =>
      `https://www.hyundaipartsdeal.com/parts-list/${v.year}-hyundai-${v.model.toLowerCase().replace(/\s+/g, "-")}.html`,
    Nissan: (v) =>
      `https://www.nissanpartsdeal.com/parts-list/${v.year}-nissan-${v.model.toLowerCase().replace(/\s+/g, "-")}.html`,
    Subaru: (v) =>
      `https://parts.subaru.com/search?q=${encodeURIComponent(`${v.year} ${v.model} maintenance parts`)}`,
  };

  const builder = builders[make];
  if (!builder) return null;

  try {
    return builder(vehicle);
  } catch {
    return null;
  }
}

/** Get all makes with OEM domain coverage. */
export function getSupportedMakes(): string[] {
  return Object.keys(OEM_DOMAINS);
}
