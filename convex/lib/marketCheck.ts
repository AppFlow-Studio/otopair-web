/**
 * lib/marketCheck.ts — MarketCheck API client (DEV-ONLY evaluation).
 *
 * Candidate VDB replacement. Auth is an `api_key` query param (no handshake).
 * Base: https://api.marketcheck.com/v2. Two decode tiers:
 *   - basic:  GET /decode/car/{vin}/specs
 *   - neovin: GET /decode/car/neovin/{vin}/specs  (enhanced — installed options)
 *
 * Fail-open like advancedVinDecode(): any error → null so a dead provider
 * degrades to an empty column instead of throwing. Normalizer is intentionally
 * defensive (tries several candidate keys) because the harness captures the raw
 * payload to proof/vdb/ so we can tighten the mapping from real responses.
 */

import type { CanonicalVehicleSpec } from "./vdbCompareTypes";

const MC_BASE = "https://api.marketcheck.com/v2";

export interface MarketCheckResult {
  ok: boolean;
  httpStatus?: number;
  reason?: string;
  /** basic decode payload */
  basic: any | null;
  /** neovin enhanced payload (only fetched when basic succeeds) */
  neovin: any | null;
}

async function mcGet(path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const apiKey = process.env.MARKETCHECK_API_KEY;
  if (!apiKey) return { ok: false, status: 0, body: { error: "MARKETCHECK_API_KEY not set" } };
  const sep = path.includes("?") ? "&" : "?";
  const url = `${MC_BASE}${path}${sep}api_key=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 400);
    }
    return { ok: r.ok, status: r.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: String((err as Error)?.message ?? err) } };
  }
}

export async function marketCheckDecodeVin(vin: string): Promise<{ ok: boolean; status: number; body: any }> {
  return mcGet(`/decode/car/${encodeURIComponent(vin)}/specs`);
}

export async function marketCheckNeoVin(vin: string): Promise<{ ok: boolean; status: number; body: any }> {
  return mcGet(`/decode/car/neovin/${encodeURIComponent(vin)}/specs`);
}

/**
 * Fetch both tiers. NeoVIN is only attempted when basic decode succeeds (saves
 * quota on VINs MarketCheck can't decode at all).
 */
export async function marketCheckFetchAll(vin: string): Promise<MarketCheckResult> {
  if (!process.env.MARKETCHECK_API_KEY) {
    return { ok: false, reason: "MARKETCHECK_API_KEY not set on deployment", basic: null, neovin: null };
  }
  const basic = await marketCheckDecodeVin(vin);
  if (!basic.ok) {
    return { ok: false, httpStatus: basic.status, reason: `basic decode ${basic.status}`, basic: basic.body, neovin: null };
  }
  let neovin: any = null;
  const neo = await marketCheckNeoVin(vin);
  if (neo.ok) neovin = neo.body;
  return { ok: true, httpStatus: basic.status, basic: basic.body, neovin };
}

/**
 * MarketCheck has no OEM YMMT spec catalog, but its active-inventory faceted
 * search enumerates the trims actually present in the market for a YMM (with
 * listing counts). This is the closest MarketCheck gets to "trims for a YMM".
 */
export async function marketCheckTrimFacets(args: {
  year: number;
  make: string;
  model: string;
}): Promise<{ ok: boolean; status: number; trims: { item: string; count: number }[] | null }> {
  const q =
    `year=${args.year}&make=${encodeURIComponent(args.make)}` +
    `&model=${encodeURIComponent(args.model)}&rows=0&facets=trim`;
  const r = await mcGet(`/search/car/active?${q}`);
  const facet = r.body?.facets?.trim;
  return { ok: r.ok, status: r.status, trims: Array.isArray(facet) ? facet : null };
}

// ── normalization helpers ───────────────────────────────────────────────────

function pickStr(...vals: any[]): string | null {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function pickNum(...vals: any[]): number | null {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = parseFloat(String(v).replace(/,/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/** Pull package/option codes+names out of NeoVIN's installed-options shapes. */
function extractMcPackages(neovin: any): string[] | null {
  if (!neovin || typeof neovin !== "object") return null;
  const out: string[] = [];
  const candidates = [
    neovin.options_packages, // MarketCheck NeoVIN's package list
    neovin.installed_options_details,
    neovin.high_value_features,
    neovin.installed_options,
    neovin.installed_equipment,
    neovin.options,
    neovin.features,
    neovin.packages,
  ];
  for (const arr of candidates) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object") {
        const label = pickStr(item.name, item.description, item.option, item.code, item.label);
        if (label) out.push(label);
      }
    }
  }
  // dedupe, cap length so the scorecard cell stays readable
  const uniq = [...new Set(out)];
  return uniq.length ? uniq : null;
}

/**
 * Map MarketCheck (neovin preferred, basic fallback) → canonical shape.
 * MarketCheck does not publish OEM engine codes, chassis codes, tire/brake/
 * battery specs — those cells are expected to be null (a real finding).
 */
export function normalizeMarketCheck(res: MarketCheckResult): CanonicalVehicleSpec | null {
  if (!res.ok) return null;
  const b = res.basic ?? {};
  const n = res.neovin ?? {};
  // neovin wins; fall back to basic.
  const g = (key: string) => (n[key] != null ? n[key] : b[key]);

  const spec: CanonicalVehicleSpec = {
    year: pickNum(g("year")),
    make: pickStr(g("make")),
    model: pickStr(g("model")),
    trim: pickStr(g("trim"), g("trim_variant"), g("version")),
    bodyType: pickStr(g("body_type"), g("body_subtype"), g("vehicle_type")),
    doors: pickNum(g("doors")),

    engineCode: pickStr(g("engine_code")), // MarketCheck rarely returns this
    chassisCode: pickStr(g("platform"), g("platform_code"), g("chassis")),
    packages: extractMcPackages(n),

    engineDescription: pickStr(g("engine"), g("powertrain_type")),
    cylinders: pickNum(g("cylinders"), g("engine_cylinders")),
    displacement: pickNum(g("engine_size"), g("displacement")),
    cylindersConfiguration: pickStr(g("engine_block"), g("engine_aspiration")),
    blockType: pickStr(g("engine_block")),
    camType: null,
    drivetrain: pickStr(g("drivetrain"), g("driven_wheels")),
    horsepower: pickNum(g("engine_horsepower"), g("horsepower")),

    fuelType: pickStr(g("fuel_type")),
    mpgCity: pickNum(g("city_mpg")),
    mpgHighway: pickNum(g("highway_mpg")),
    mpgCombined: pickNum(g("combined_mpg")),

    transType: pickStr(g("transmission")),
    transSpeeds: pickNum(g("transmission_speeds")),
    transDescription: pickStr(g("transmission")),

    frontTireSize: pickStr(g("front_tire_size"), g("tire_size")),
    rearTireSize: pickStr(g("rear_tire_size")),
    frontTirePressure: pickNum(g("front_tire_pressure")),
    rearTirePressure: pickNum(g("rear_tire_pressure")),
    wheelTorque: null,

    cca: null,
    frontRotorDia: null,
    rearRotorDia: null,
    brakeType: null,
    brakeSystemType: undefined,
    steeringType: null,

    _provider: "marketcheck",
    _sourceEndpoint: res.neovin ? "decode/car/neovin/{vin}/specs" : "decode/car/{vin}/specs",
  };
  return spec;
}
