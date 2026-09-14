/**
 * vehicleEnrichment/utils/wheelSizeScraper.ts
 *
 * Fetches OEM tire options from the wheel-size.com REST API (v2).
 * API key stored as WHEEL_SIZE_API_KEY Convex environment variable.
 * Rate limit: 300 vehicles/day on the free tier.
 *
 * Auth:     ?user_key=KEY  (query param name confirmed from OpenAPI spec)
 * Make/model: slug format — lowercase, spaces→hyphens (e.g. "5 Series" → "5-series")
 * Region:   region=usdm first, then no filter fallback
 *
 * Response shape (confirmed from live API):
 *   data[].name              — trim name, e.g. "M550i xDrive"
 *   data[].wheels[]          — array of fitment options
 *   wheels[].is_stock        — true = OEM standard fitment
 *   wheels[].front.tire      — "245/40ZR19"
 *   wheels[].rear.tire       — "275/35ZR19" or "" when non-staggered
 *   wheels[].front.rim       — "8Jx19 ET30"
 *   wheels[].front.tire_pressure.psi
 *   wheels[].rear.tire_pressure.psi
 *   wheels[].front.load_index
 *   wheels[].front.speed_index  — "Y" (plain string)
 *
 * Non-fatal: any failure returns null and enrichment continues without tire data.
 */

import { findHaloVariant } from "../../lib/haloVariantRules";
import { inferHaloVariantWithHaiku } from "../../lib/haloVariantInference";

const WHEEL_SIZE_API_BASE = "https://api.wheel-size.com/v2";

export interface TireOption {
  size_front: string;           // "245/40R19"
  size_rear?: string;           // "275/35R19" — only on staggered setups
  oem_name?: string;            // "Michelin Pilot Super Sport" — from tirerack
  // Front size components
  width_mm?: number;
  aspect_ratio?: number;
  rim_diameter_in?: number;
  // Rear size components — only when staggered
  width_mm_rear?: number;
  aspect_ratio_rear?: number;
  rim_diameter_in_rear?: number;
  wheel_spec?: string;          // "8Jx19 ET30"
  load_index?: number;
  speed_rating?: string;        // "Y"
  load_index_rear?: number;
  speed_rating_rear?: string;   // "Y" — only when staggered
  pressure_front_psi?: number;
  pressure_rear_psi?: number;
  is_oem_standard: boolean;
}

export interface WheelSizeResult {
  tireOptions: TireOption[];
  sourceUrl: string;
}

// ─── API response shape ───────────────────────────────────────────

interface ApiTireAxle {
  tire?: string;                     // "245/40ZR19"
  rim?: string;                      // "8Jx19 ET30"
  load_index?: number;
  speed_index?: string;              // "Y" — plain string, not an object
  tire_pressure?: { psi?: number };
}

interface ApiWheel {
  is_stock?: boolean;
  front?: ApiTireAxle;
  rear?: ApiTireAxle;
}

interface ApiTrimEntry {
  name?: string;                     // "M550i xDrive"
  wheels?: ApiWheel[];
}

interface ApiResponse {
  data?: ApiTrimEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────

/** "bmw" stays "bmw"; "5 Series" → "5-series"; "Wrangler 4xe" → "wrangler-4xe" */
function toSlug(str: string): string {
  return str.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/**
 * wheel-size.com make slugs that differ from toSlug(make). Keyed by toSlug of
 * the decode make. Only mismatches our decode sources actually emit are mapped
 * — verified against GET /v2/makes/ (Aug 2026). Without this, the query silently
 * returns an empty (HTTP 200) result set and no tire data is stored.
 */
const MAKE_SLUG_ALIASES: Record<string, string> = {
  "mercedes-benz": "mercedes", // decode reports "Mercedes-Benz"; catalog slug is "mercedes"
};

/** Make slug for the wheel-size.com catalog (applies known aliases). */
function toMakeSlug(make: string): string {
  const base = toSlug(make);
  return MAKE_SLUG_ALIASES[base] ?? base;
}

/** Normalize "245/40ZR19" or "P245/40R19" → "245/40R19" */
function normalizeSize(raw: string): string {
  return raw.replace(/^P/, "").replace(/(\d{3}\/\d{2})ZR(\d{2})/, "$1R$2").trim();
}

/** "245/40R19" → { width_mm, aspect_ratio, rim_diameter_in } or null */
function parseSizeComponents(size: string): { width_mm: number; aspect_ratio: number; rim_diameter_in: number } | null {
  const m = size.match(/^(\d{3})\/(\d{2})[A-Z]?(\d{2})$/);
  if (!m) return null;
  return { width_mm: parseInt(m[1]), aspect_ratio: parseInt(m[2]), rim_diameter_in: parseInt(m[3]) };
}

/** Find best-matching trim entry: exact name → partial name → displacement → null */
function findTrimEntry(entries: ApiTrimEntry[], trim: string, displacementL?: number | null): ApiTrimEntry | null {
  const q = trim.toLowerCase().trim();

  // 1. Exact trim name match
  const exact = entries.find(e => e.name?.toLowerCase().trim() === q);
  if (exact) return exact;

  // 2. Partial trim name match
  const partial = entries.find(e => {
    const name = e.name?.toLowerCase() ?? "";
    return name.includes(q) || q.includes(name);
  });
  if (partial) return partial;

  // 3. Displacement match — wheel-size.com uses engine-based names like "6.2i", "1.6 T-GDi"
  if (displacementL) {
    const dispStr = displacementL.toFixed(1); // "6.2", "1.6"
    const byDisp = entries.find(e => e.name?.startsWith(dispStr) || e.name?.includes(` ${dispStr}`));
    if (byDisp) return byDisp;
  }

  return null;
}

/** Map API wheels array to TireOption[], deduplicating by front+rear+rim. */
function buildTireOptions(wheels: ApiWheel[]): TireOption[] {
  const options: TireOption[] = [];
  const seen = new Set<string>();

  for (const wheel of wheels) {
    const frontRaw = wheel.front?.tire;
    if (!frontRaw) continue;

    const frontSize = normalizeSize(frontRaw);
    if (!frontSize) continue;

    const rearRaw   = wheel.rear?.tire;
    const rearNorm  = rearRaw ? normalizeSize(rearRaw) : "";
    const rearSize  = rearNorm && rearNorm !== frontSize ? rearNorm : undefined;

    const dedupKey = `${frontSize}|${rearSize ?? ""}|${wheel.front?.rim ?? ""}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const frontComponents = parseSizeComponents(frontSize);

    const option: TireOption = {
      size_front: frontSize,
      is_oem_standard: wheel.is_stock ?? false,
    };

    if (rearSize) option.size_rear = rearSize;
    if (frontComponents) {
      option.width_mm        = frontComponents.width_mm;
      option.aspect_ratio    = frontComponents.aspect_ratio;
      option.rim_diameter_in = frontComponents.rim_diameter_in;
    }
    if (rearSize) {
      const rc = parseSizeComponents(rearSize);
      if (rc) {
        option.width_mm_rear        = rc.width_mm;
        option.aspect_ratio_rear    = rc.aspect_ratio;
        option.rim_diameter_in_rear = rc.rim_diameter_in;
      }
    }
    if (wheel.front?.rim)                        option.wheel_spec          = wheel.front.rim;
    if (wheel.front?.load_index)                 option.load_index          = wheel.front.load_index;
    if (wheel.front?.speed_index)                option.speed_rating        = wheel.front.speed_index;
    if (wheel.front?.tire_pressure?.psi)         option.pressure_front_psi  = wheel.front.tire_pressure.psi;
    if (rearSize && wheel.rear?.load_index)      option.load_index_rear     = wheel.rear.load_index;
    if (rearSize && wheel.rear?.speed_index)     option.speed_rating_rear   = wheel.rear.speed_index;
    if (wheel.rear?.tire_pressure?.psi)          option.pressure_rear_psi   = wheel.rear.tire_pressure.psi;

    options.push(option);
  }

  return options;
}

// ─── API fetch ────────────────────────────────────────────────────

async function fetchByModel(
  makeSlug: string,
  modelSlug: string,
  year: number,
  apiKey: string,
  region?: string,
): Promise<ApiResponse | null> {
  const params = new URLSearchParams({ make: makeSlug, model: modelSlug, year: String(year), user_key: apiKey });
  if (region) params.set("region", region);

  const url = `${WHEEL_SIZE_API_BASE}/search/by_model/?${params}`;
  console.log(`[wheel-size-api] GET ${url.replace(apiKey, "***")}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[wheel-size-api] HTTP ${res.status} for ${year} ${makeSlug} ${modelSlug} (region=${region ?? "any"})`);
      return null;
    }
    return (await res.json()) as ApiResponse;
  } catch (e) {
    console.warn(`[wheel-size-api] Fetch error: ${e}`);
    return null;
  }
}

// ─── Public export ────────────────────────────────────────────────

/**
 * Fetch all OEM tire options for a vehicle from the wheel-size.com API.
 * Returns null if the API key is missing, the API returns no data, or
 * no tire options can be parsed — never throws.
 */
export async function scrapeWheelSizeOptions(
  year: number,
  make: string,
  model: string,
  trim?: string,
  displacementL?: number | null,
): Promise<WheelSizeResult | null> {
  const apiKey = process.env.WHEEL_SIZE_API_KEY;
  if (!apiKey) {
    console.warn("[wheel-size-api] WHEEL_SIZE_API_KEY not set — skipping tire lookup");
    return null;
  }

  // Promote halo variants (M3, AMG GT, Type R, Blackwing, etc.) to the
  // model name catalogs actually use. See lib/haloVariantRules.ts.
  const haloRule = findHaloVariant(make, model, trim ?? "");
  let effectiveModel = haloRule?.promotedModel ?? model;
  if (haloRule && haloRule.promotedModel.toLowerCase() !== model.toLowerCase()) {
    console.log(`[wheel-size-api] Halo variant promoted: "${model}" → "${effectiveModel}" (rule=${haloRule.ruleId})`);
  }
  const makeSlug  = toMakeSlug(make);
  let modelSlug = toSlug(effectiveModel);

  // region=usdm is required by the API — omitting it returns HTTP 400
  // "Invalid input", so there is no valid "no region" fallback. An empty USDM
  // result means the make/model slug is off; the Haiku fallback below handles
  // that by inferring the catalog model name.
  let response = await fetchByModel(makeSlug, modelSlug, year, apiKey, "usdm");
  if (!response?.data?.length) {
    console.log(`[wheel-size-api] No USDM results for ${year} ${make} ${effectiveModel}`);
  }

  // Long-tail fallback: if curated rule didn't promote AND the query returned
  // zero data, ask Haiku what catalog model this halo is filed under and retry.
  // Cost-bounded — only on zero-result misses, results cached per worker.
  if ((!response?.data?.length) && !haloRule && trim) {
    const inferred = await inferHaloVariantWithHaiku(make, model, trim, year);
    if (inferred && inferred.promotedModel.toLowerCase() !== effectiveModel.toLowerCase()) {
      console.log(
        `[wheel-size-api] Haiku inferred promotion: "${effectiveModel}" → "${inferred.promotedModel}" — retrying`
      );
      effectiveModel = inferred.promotedModel;
      modelSlug = toSlug(effectiveModel);
      response = await fetchByModel(makeSlug, modelSlug, year, apiKey, "usdm");
    }
  }

  const entries = response?.data;
  if (!entries?.length) {
    console.warn(`[wheel-size-api] No data for ${year} ${make} ${effectiveModel}`);
    return null;
  }

  console.log(`[wheel-size-api] ${entries.length} trim entries for ${year} ${make} ${effectiveModel}`);

  // Pick matching trim or fall back to all
  let wheels: ApiWheel[];

  if (trim) {
    const trimEntry = findTrimEntry(entries, trim, displacementL);
    if (trimEntry) {
      console.log(`[wheel-size-api] Trim match: "${trimEntry.name}" for query "${trim}" (disp=${displacementL ?? "?"}L)`);
      wheels = trimEntry.wheels ?? [];
    } else {
      console.log(`[wheel-size-api] No trim match for "${trim}" (disp=${displacementL ?? "?"}L) among [${entries.map(e => e.name).join(", ")}] — using all trims`);
      wheels = entries.flatMap(e => e.wheels ?? []);
    }
  } else {
    wheels = entries.flatMap(e => e.wheels ?? []);
  }

  const tireOptions = buildTireOptions(wheels);

  if (tireOptions.length === 0) {
    console.warn(`[wheel-size-api] 0 tire options parsed for ${year} ${make} ${effectiveModel} ${trim ?? ""}`);
    return null;
  }

  const oemCount = tireOptions.filter(t => t.is_oem_standard).length;
  console.log(`[wheel-size-api] ${tireOptions.length} tire options (${oemCount} OE) for ${year} ${make} ${effectiveModel} ${trim ?? ""}`);

  const sourceUrl = `https://www.wheel-size.com/size/${makeSlug}/${modelSlug}/${year}/`;
  return { tireOptions, sourceUrl };
}
