/**
 * lib/carApi.ts — CarAPI (carapi.app) client (DEV-ONLY evaluation).
 *
 * Candidate VDB replacement. Auth is a JWT handshake:
 *   POST https://carapi.app/api/auth/login  body {api_token, api_secret}
 *   → JWT returned as PLAIN TEXT (response.text(), NOT .json()), valid 7 days.
 *   → subsequent calls send  Authorization: Bearer <jwt>
 *
 * IMPORTANT: the FREE dataset only covers model years 2015–2020. Callers must
 * gate on carApiYearInFreeRange() and mark out-of-range vehicles n/a rather
 * than counting them as coverage failures. Fail-open like the other clients.
 */

import { carApiYearInFreeRange, type CanonicalVehicleSpec } from "./vdbCompareTypes";
import { extractVDBFields } from "./vehicleDatabases";

const CARAPI_BASE = "https://carapi.app/api";

// Module-level JWT cache. A Convex action isolate may be reused across
// invocations, so cache with a wall-clock stamp and refresh well before the
// 7-day expiry.
let _jwt: { token: string; fetchedAt: number } | null = null;
const JWT_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

async function carApiJwt(): Promise<string | null> {
  const apiToken = process.env.CAR_API_TOKEN;
  const apiSecret = process.env.CAR_API_SECRET;
  if (!apiToken || !apiSecret) {
    console.log("[carapi] CAR_API_TOKEN / CAR_API_SECRET not set — skipping");
    return null;
  }
  if (_jwt && Date.now() - _jwt.fetchedAt < JWT_MAX_AGE_MS) return _jwt.token;
  try {
    const r = await fetch(`${CARAPI_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify({ api_token: apiToken, api_secret: apiSecret }),
      signal: AbortSignal.timeout(20_000),
    });
    // JWT is returned as a raw string, NOT JSON.
    const token = (await r.text()).trim();
    if (!r.ok || !token || token.startsWith("{")) {
      console.log(`[carapi] login failed: ${r.status} ${token.slice(0, 200)}`);
      return null;
    }
    _jwt = { token, fetchedAt: Date.now() };
    return token;
  } catch (err) {
    console.log(`[carapi] login error: ${err}`);
    return null;
  }
}

async function carApiGet(path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const jwt = await carApiJwt();
  if (!jwt) return { ok: false, status: 0, body: { error: "no jwt (auth failed / keys unset)" } };
  try {
    const r = await fetch(`${CARAPI_BASE}${path}`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
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

/**
 * CarAPI YMMT catalog via the v2 endpoints (the v1 /trims,/engines,/bodies are
 * deprecated → 403 on the free plan; v2 works free within 2015–2020). Returns
 * the raw collection bodies for /trims/v2, /engines/v2, /bodies/v2.
 */
export async function carApiYmmtCatalog(args: {
  year: number;
  make: string;
  model: string;
}): Promise<{ trims: any | null; engines: any | null; bodies: any | null }> {
  const q =
    `year=${args.year}&make=${encodeURIComponent(args.make)}` +
    `&model=${encodeURIComponent(args.model)}&verbose=yes`;
  const [t, e, b] = await Promise.all([
    carApiGet(`/trims/v2?${q}`),
    carApiGet(`/engines/v2?${q}`),
    carApiGet(`/bodies/v2?${q}`),
  ]);
  return {
    trims: t.ok ? t.body : null,
    engines: e.ok ? e.body : null,
    bodies: b.ok ? b.body : null,
  };
}

export interface CarApiResult {
  ok: boolean;
  applicable: boolean; // false = skipped as out-of-range (< 2015 or > 2020)
  httpStatus?: number;
  reason?: string;
  vin: any | null;
  trims: any | null;
  engines: any | null;
  bodies: any | null;
}

/**
 * Fetch everything CarAPI can tell us about one VIN (+ optional YMMT to enrich
 * the YMMT-only path). Gated on the free-dataset year range.
 */
export async function carApiFetchAll(args: {
  vin?: string;
  year?: number | null;
  make?: string | null;
  model?: string | null;
}): Promise<CarApiResult> {
  const empty = { vin: null, trims: null, engines: null, bodies: null };
  if (!process.env.CAR_API_TOKEN || !process.env.CAR_API_SECRET) {
    return { ok: false, applicable: true, reason: "CAR_API_TOKEN/SECRET not set on deployment", ...empty };
  }
  // Year gate — but only when we actually know the year. VIN-only calls where
  // year is unknown still attempt (CarAPI's VIN decode returns the year).
  if (args.year != null && !carApiYearInFreeRange(args.year)) {
    return {
      ok: false,
      applicable: false,
      reason: `out_of_free_dataset_range_2015_2020 (year=${args.year})`,
      ...empty,
    };
  }

  let vinBody: any = null;
  let httpStatus: number | undefined;
  if (args.vin) {
    const dec = await carApiGet(`/vin/${encodeURIComponent(args.vin)}`);
    httpStatus = dec.status;
    if (dec.ok) vinBody = dec.body;
    // If the decode reveals an out-of-range year, mark n/a rather than failure.
    const decYear = vinBody?.year != null ? Number(vinBody.year) : null;
    if (decYear != null && !carApiYearInFreeRange(decYear)) {
      return {
        ok: false,
        applicable: false,
        httpStatus,
        reason: `out_of_free_dataset_range_2015_2020 (decoded year=${decYear})`,
        ...empty,
      };
    }
  }

  // YMMT enrichment (trims/engines/bodies) when we have year+make+model.
  let trims: any = null;
  let engines: any = null;
  let bodies: any = null;
  const y = args.year ?? (vinBody?.year != null ? Number(vinBody.year) : null);
  const mk = args.make ?? vinBody?.make ?? null;
  const md = args.model ?? vinBody?.model ?? null;
  if (y != null && carApiYearInFreeRange(y) && mk && md) {
    const cat = await carApiYmmtCatalog({ year: y, make: mk, model: md });
    trims = cat.trims;
    engines = cat.engines;
    bodies = cat.bodies;
  }

  const ok = !!(vinBody || trims || engines || bodies);
  return {
    ok,
    applicable: true,
    httpStatus,
    reason: ok ? undefined : "no data returned",
    vin: vinBody,
    trims,
    engines,
    bodies,
  };
}

// ── normalization helpers ───────────────────────────────────────────────────

function firstOf(arr: any): any {
  if (Array.isArray(arr)) return arr[0] ?? null;
  if (arr && typeof arr === "object" && Array.isArray(arr.data)) return arr.data[0] ?? null;
  return arr ?? null;
}

/** Collect the candidate source objects CarAPI spreads fields across. */
function sources(res: CarApiResult): any[] {
  const v = res.vin ?? {};
  return [
    v,
    v.specs,
    v.engine,
    v.body,
    v.attributes,
    firstOf(v.trims),
    firstOf(v.engines),
    firstOf(v.bodies),
    firstOf(res.trims),
    firstOf(res.engines),
    firstOf(res.bodies),
  ].filter((x) => x && typeof x === "object");
}

function makePick(srcs: any[]) {
  return {
    str(...keys: string[]): string | null {
      for (const k of keys)
        for (const s of srcs)
          if (s[k] != null && String(s[k]).trim()) return String(s[k]).trim();
      return null;
    },
    num(...keys: string[]): number | null {
      for (const k of keys)
        for (const s of srcs) {
          if (s[k] == null || s[k] === "") continue;
          const n = parseFloat(String(s[k]).replace(/,/g, ""));
          if (!Number.isNaN(n)) return n;
        }
      return null;
    },
  };
}

/**
 * Map a CarApiResult → canonical shape. CarAPI is strong on YMMT + engine
 * specs + body dimensions but does NOT publish OEM engine codes, chassis
 * codes, or tire/brake/battery specs — those cells are expected null.
 */
export function normalizeCarApi(res: CarApiResult): CanonicalVehicleSpec | null {
  if (!res.ok || !res.applicable) return null;
  const srcs = sources(res);
  if (!srcs.length) return null;
  const p = makePick(srcs);

  // CarAPI's VIN decode is NHTSA-derived: the useful specs live in vin.specs
  // under NHTSA-style snake_case keys, and trim names live in trims[].description
  // (the top-level `trim` field is a bare sub-code like "3"). We therefore read
  // the snake_case names first and prefer `description` for the trim.
  return {
    year: p.num("year"),
    make: p.str("make"),
    model: p.str("model"),
    trim: p.str("description", "trim", "name"),
    bodyType: p.str("body_class", "type", "body_type"),
    doors: p.num("doors"),

    engineCode: p.str("engine_code"), // CarAPI does not publish OEM engine codes
    chassisCode: p.str("platform", "chassis_code"),
    packages: null,

    engineDescription: p.str("engine_model", "engine_type", "engine"),
    cylinders: p.num("engine_number_of_cylinders", "cylinders"),
    displacement: p.num("displacement_l", "size", "displacement", "engine_size"),
    cylindersConfiguration: p.str("engine_configuration", "configuration"),
    blockType: p.str("engine_configuration", "configuration"),
    camType: p.str("valve_train_design", "cam_type"),
    drivetrain: p.str("drive_type", "drivetrain"),
    horsepower: p.num("engine_brake_hp_from", "horsepower_hp", "horsepower"),

    fuelType: p.str("fuel_type_primary", "fuel_type"),
    mpgCity: p.num("epa_city_mpg", "city_mpg"),
    mpgHighway: p.num("epa_highway_mpg", "highway_mpg"),
    mpgCombined: p.num("epa_combined_mpg", "combined_mpg"),

    transType: p.str("transmission_style", "transmission", "transmission_type"),
    transSpeeds: p.num("transmission_speeds", "gears"),
    transDescription: p.str("transmission_style", "transmission"),

    frontTireSize: p.str("front_tire_size"),
    rearTireSize: p.str("rear_tire_size"),
    frontTirePressure: p.num("front_tire_pressure"),
    rearTirePressure: p.num("rear_tire_pressure"),
    wheelTorque: null,

    cca: null,
    frontRotorDia: null,
    rearRotorDia: null,
    brakeType: null,
    brakeSystemType: undefined,
    steeringType: null,

    _provider: "carapi",
    _sourceEndpoint: res.vin ? "vin/{vin}" : "trims+engines+bodies",
  };
}

// ── production entry points (used by processVin / v3 enrichment) ─────────────

/**
 * Decode one VIN via CarAPI (`/vin/{vin}`). NO year gate — the paid plan covers
 * all model years. Fail-open null (caller falls back to NHTSA), same contract as
 * advancedVinDecode(). Returns the raw `vin` body (make/model/year/specs/trims).
 */
export async function carApiVinDecode(vin: string): Promise<any | null> {
  if (!process.env.CAR_API_TOKEN || !process.env.CAR_API_SECRET) return null;
  const r = await carApiGet(`/vin/${encodeURIComponent(vin)}`);
  return r.ok ? r.body : null;
}

/**
 * Map a CarAPI VIN-decode body → the EXACT shape `extractVDBFields()` returns,
 * so it drops into the processVin merge slot with no downstream changes. CarAPI
 * specs are NHTSA-derived (snake_case); it has no OEM engine code, chassis code,
 * or tire/brake/battery specs → those come back null/undefined (Claude +
 * wheel-size.com fill them). Reuses the sources()/makePick() readers.
 */
export function extractCarApiFields(vinRaw: any): ReturnType<typeof extractVDBFields> {
  const srcs = sources({
    ok: true,
    applicable: true,
    vin: vinRaw,
    trims: null,
    engines: null,
    bodies: null,
  } as CarApiResult);
  const p = makePick(srcs);
  const displacement = p.num("displacement_l", "size", "displacement");
  // Trim: read the regulatory `specs.trim` ("XSE") ONLY. Never `series` — that's
  // a model/engine code ("AXVA70L/GSV70L/AXVH70L") that would match NHTSA's
  // Series field in the merge gate and wrongly win; never top-level `vin.trim`
  // either (a bare sub-code like "3" on some makes).
  const cleanTrim =
    typeof vinRaw?.specs?.trim === "string" && vinRaw.specs.trim.trim()
      ? vinRaw.specs.trim.trim()
      : null;
  return {
    year: p.num("year"),
    make: p.str("make"),
    model: p.str("model"),
    trim: cleanTrim,
    style: null,
    trimAndStyle: null,
    bodyType: p.str("body_class", "type", "body_type"),
    doors: p.num("doors"),
    engineCode: p.str("engine_code"), // CarAPI publishes no OEM engine code
    engineDescription: p.str("engine_model", "engine_type", "description"),
    cylinders: p.num("engine_number_of_cylinders", "cylinders"),
    displacement,
    camType: p.str("valve_train_design", "cam_type"),
    blockType: p.str("engine_configuration"),
    drivetrain: p.str("drive_type", "drivetrain"),
    fuelType: p.str("fuel_type_primary", "fuel_type"),
    horsepower: p.num("engine_brake_hp_from", "horsepower_hp"),
    engineDisplacementLiters: displacement,
    cylindersConfiguration: p.str("engine_configuration"),
    mpgCity: p.num("epa_city_mpg", "city_mpg"),
    mpgHighway: p.num("epa_highway_mpg", "highway_mpg"),
    mpgCombined: p.num("epa_combined_mpg", "combined_mpg"),
    transType: p.str("transmission_style", "transmission"),
    transSpeeds: p.num("transmission_speeds"),
    transDescription: p.str("transmission_style", "transmission"),
    // VDB-unique fields CarAPI doesn't provide → null/undefined (filled elsewhere)
    frontTireSize: null,
    rearTireSize: null,
    frontTirePressure: null,
    rearTirePressure: null,
    wheelTorque: null,
    cca: null,
    frontRotorDia: null,
    rearRotorDia: null,
    brakeType: null,
    brakeSystemType: undefined,
    steeringType: null,
  };
}

/**
 * Resolve our model name to CarAPI's catalog naming (needed only for the no-VIN
 * YMMT path — `/vin/{vin}` returns make/model directly). CarAPI files some makes
 * by variant (BMW "328i" not "3 Series"); returns null when no clean match so
 * the caller falls back to Claude (researchYmmtPowertrain).
 */
/**
 * Does catalog model `candidate` name the same model as `wanted`?
 *
 * Exact match first, then a token-boundary containment — NOT a raw substring
 * one. Stripping separators and asking `target.includes(n)` made every
 * Mercedes SUV resolve to a sedan: "GLE-Class" and "E-Class" both flatten to
 * `gleclass` / `eclass`, and `"gleclass".includes("eclass")` is true. The same
 * collapse hit GLC→C, GLS→S, GLA→A and GLB→B; only G-Class survived, because
 * it matched exactly. Yassin, 2026-09-03: a GLE VIN offered E 450 trims and
 * the car saved as an E-Class.
 *
 * Comparing token runs keeps what the loose match was FOR — "3 Series Sedan"
 * still finds "3 Series" — while refusing to match across a word boundary.
 */
export function modelNamesMatch(candidate: string, wanted: string): boolean {
  const tokens = (s: string) =>
    String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const a = tokens(candidate);
  const b = tokens(wanted);
  if (!a.length || !b.length) return false;
  if (a.join(" ") === b.join(" ")) return true;
  // Is the shorter token list a contiguous run inside the longer one?
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => long[i + j] === t)) return true;
  }
  return false;
}

export async function carApiResolveModel(
  make: string,
  year: number,
  model: string,
): Promise<string | null> {
  const r = await carApiGet(`/models/v2?year=${year}&make=${encodeURIComponent(make)}`);
  const list: any[] = Array.isArray(r.body?.data) ? r.body.data : [];
  if (!list.length) return null;
  const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(model);
  const exact = list.find((m) => norm(m.name) === target);
  if (exact) return exact.name as string;
  const sub = list.find((m) => modelNamesMatch(String(m.name ?? ""), model));
  return sub ? (sub.name as string) : null;
}

/**
 * All model names CarAPI catalogs for a make/year (e.g. Mercedes-Benz 2023 →
 * "GLE 350", "GLE 450", "AMG GLE 63 S", "AMG GLE 63 S Coupe", ...). Used to
 * expand a family-level model name ("GLE-Class") into the specific variants
 * CarAPI files trims under, so the trim picker shows differentiated entries.
 */
export async function carApiModelsForMakeYear(
  make: string,
  year: number,
): Promise<string[]> {
  const r = await carApiGet(`/models/v2?year=${year}&make=${encodeURIComponent(make)}`);
  const list: any[] = Array.isArray(r.body?.data) ? r.body.data : [];
  return list.map((m) => String(m?.name ?? "").trim()).filter(Boolean);
}
