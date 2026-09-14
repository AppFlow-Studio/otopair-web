/**
 * devOnly/vdbCompare.ts — DEV-ONLY, READ-ONLY VDB provider comparison harness.
 *
 * Evaluates MarketCheck and CarAPI as candidate replacements for the paid
 * Vehicle Databases (VDB) VIN-decode source, against the free NHTSA baseline.
 * For each test vehicle it decodes through all four providers, maps every raw
 * response onto ONE canonical shape (lib/vdbCompareTypes.ts), and scores
 * coverage + engine-code agreement vs FLEET ground truth.
 *
 * NO DB writes. All exports are internalAction/internalQuery. Provider clients
 * fail-open (null column) so a dead/unset provider never throws.
 *
 * Run one VIN:  npx convex run devOnly/vdbCompare:compareVin '{"vin":"WZ1DB4C05LW030001"}'
 * Driver:       node scripts/vdb-compare.mjs --fleet --real 5
 *
 * Prereq — set keys on the deployment (NOT read from .env.local):
 *   npx convex env set MARKETCHECK_API_KEY <v>
 *   npx convex env set CAR_API_TOKEN <v>
 *   npx convex env set CAR_API_SECRET <v>
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import {
  advancedVinDecode,
  extractVDBFields,
  assessAvailablePackages,
} from "../lib/vehicleDatabases";
import { marketCheckFetchAll, normalizeMarketCheck, marketCheckTrimFacets } from "../lib/marketCheck";
import { carApiFetchAll, normalizeCarApi, carApiYmmtCatalog } from "../lib/carApi";
import {
  scoreCanonical,
  carApiYearInFreeRange,
  type CanonicalVehicleSpec,
  type CompareProvider,
} from "../lib/vdbCompareTypes";
import { FLEET } from "../vehicleEnrichment/fleetEval";

const NHTSA_DECODE =
  "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended";

// ── per-provider normalizers ────────────────────────────────────────────────

function normalizeVdb(raw: any): CanonicalVehicleSpec {
  const f = extractVDBFields(raw);
  const packages = assessAvailablePackages({
    vdbRaw: raw,
    make: f.make ?? "",
    model: f.model ?? "",
    trim: f.trim ?? "",
    year: f.year ?? 0,
  }).map((p) => p.code);
  return {
    year: f.year,
    make: f.make,
    model: f.model,
    trim: f.trim,
    bodyType: f.bodyType,
    doors: f.doors,
    engineCode: f.engineCode,
    chassisCode: null, // VDB decode doesn't return it — derived downstream today
    packages,
    engineDescription: f.engineDescription,
    cylinders: f.cylinders,
    displacement: f.engineDisplacementLiters ?? f.displacement,
    cylindersConfiguration: f.cylindersConfiguration,
    blockType: f.blockType,
    camType: f.camType,
    drivetrain: f.drivetrain,
    horsepower: f.horsepower,
    fuelType: f.fuelType,
    mpgCity: f.mpgCity,
    mpgHighway: f.mpgHighway,
    mpgCombined: f.mpgCombined,
    transType: f.transType,
    transSpeeds: f.transSpeeds,
    transDescription: f.transDescription,
    frontTireSize: f.frontTireSize,
    rearTireSize: f.rearTireSize,
    frontTirePressure: f.frontTirePressure,
    rearTirePressure: f.rearTirePressure,
    wheelTorque: f.wheelTorque,
    cca: f.cca,
    frontRotorDia: f.frontRotorDia,
    rearRotorDia: f.rearRotorDia,
    brakeType: f.brakeType,
    brakeSystemType: f.brakeSystemType,
    steeringType: f.steeringType,
    _provider: "vdb",
    _sourceEndpoint: "advanced-vin-decode/v2/{vin}",
  };
}

function nhtsaGet(nhtsaData: any, key: string): string {
  const row = nhtsaData?.Results?.[0];
  if (!row) return "";
  const val = row[key];
  return typeof val === "string" ? val.trim() : "";
}

function normalizeNhtsa(nhtsaData: any): CanonicalVehicleSpec {
  const s = (k: string) => nhtsaGet(nhtsaData, k) || null;
  const n = (k: string) => {
    const raw = nhtsaGet(nhtsaData, k);
    if (!raw) return null;
    const x = parseFloat(raw.replace(/,/g, ""));
    return Number.isNaN(x) ? null : x;
  };
  return {
    year: n("ModelYear"),
    make: s("Make"),
    model: s("Model"),
    trim: s("Trim") ?? s("Series"),
    bodyType: s("BodyClass"),
    doors: n("Doors"),
    engineCode: s("EngineModel"), // often a marketing name, not a clean OEM code
    chassisCode: null,
    packages: null,
    engineDescription: s("EngineModel"),
    cylinders: n("EngineCylinders"),
    displacement: n("DisplacementL"),
    cylindersConfiguration: s("EngineConfiguration"),
    blockType: s("EngineConfiguration"),
    camType: null,
    drivetrain: s("DriveType"),
    horsepower: n("EngineHP"),
    fuelType: s("FuelTypePrimary"),
    mpgCity: null,
    mpgHighway: null,
    mpgCombined: null,
    transType: s("TransmissionStyle"),
    transSpeeds: n("TransmissionSpeeds"),
    transDescription: s("TransmissionStyle"),
    frontTireSize: null,
    rearTireSize: null,
    frontTirePressure: null,
    rearTirePressure: null,
    wheelTorque: null,
    cca: null,
    frontRotorDia: null,
    rearRotorDia: null,
    brakeType: s("BrakeSystemType"),
    brakeSystemType: undefined,
    steeringType: null,
    _provider: "nhtsa",
    _sourceEndpoint: "vpic decodevinvaluesextended",
  };
}

async function fetchNhtsa(vin: string): Promise<{ ok: boolean; status?: number; raw: any }> {
  try {
    const r = await fetch(`${NHTSA_DECODE}/${encodeURIComponent(vin)}?format=json`, {
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await r.json();
    return { ok: r.ok, status: r.status, raw };
  } catch (err) {
    return { ok: false, raw: { error: String((err as Error)?.message ?? err) } };
  }
}

// ── core decode (ctx-free — only network + env) ─────────────────────────────

export interface ProviderOutcome {
  ok: boolean;
  applicable: boolean;
  httpStatus?: number;
  reason?: string;
  raw: any;
  canonical: CanonicalVehicleSpec | null;
}

async function decodeVehicle(args: {
  vin?: string;
  ymmt?: { year?: number; make?: string; model?: string; trim?: string };
}): Promise<{ vin: string | null; ymmt: any; providers: Record<CompareProvider, ProviderOutcome> }> {
  const vin = args.vin ?? null;

  // NHTSA first — gives us year/make/model to gate & enrich the CarAPI call.
  let nhtsa: ProviderOutcome = {
    ok: false,
    applicable: true,
    reason: "no vin",
    raw: null,
    canonical: null,
  };
  if (vin) {
    const res = await fetchNhtsa(vin);
    const canonical = res.ok ? normalizeNhtsa(res.raw) : null;
    nhtsa = {
      ok: res.ok && !!canonical?.make,
      applicable: true,
      httpStatus: res.status,
      reason: res.ok ? undefined : "nhtsa fetch failed",
      raw: res.raw,
      canonical,
    };
  }

  const year = args.ymmt?.year ?? nhtsa.canonical?.year ?? null;
  const make = args.ymmt?.make ?? nhtsa.canonical?.make ?? null;
  const model = args.ymmt?.model ?? nhtsa.canonical?.model ?? null;

  // VDB (only with a VIN; costs a credit unless cached).
  let vdb: ProviderOutcome = {
    ok: false,
    applicable: true,
    reason: vin ? "no data" : "no vin",
    raw: null,
    canonical: null,
  };
  if (vin) {
    const data = await advancedVinDecode(vin);
    if (data) vdb = { ok: true, applicable: true, raw: data, canonical: normalizeVdb(data) };
    else vdb = { ok: false, applicable: true, reason: "VDB null (no key / error / no data)", raw: null, canonical: null };
  }

  // MarketCheck.
  let marketcheck: ProviderOutcome = {
    ok: false,
    applicable: true,
    reason: vin ? "no data" : "no vin (MarketCheck harness is VIN-only)",
    raw: null,
    canonical: null,
  };
  if (vin) {
    const mc = await marketCheckFetchAll(vin);
    marketcheck = {
      ok: mc.ok,
      applicable: true,
      httpStatus: mc.httpStatus,
      reason: mc.reason,
      raw: { basic: mc.basic, neovin: mc.neovin },
      canonical: normalizeMarketCheck(mc),
    };
  }

  // CarAPI (free dataset = model years 2015–2020).
  const ca = await carApiFetchAll({ vin: vin ?? undefined, year, make, model });
  const carapi: ProviderOutcome = {
    ok: ca.ok,
    applicable: ca.applicable,
    httpStatus: ca.httpStatus,
    reason: ca.reason,
    raw: { vin: ca.vin, trims: ca.trims, engines: ca.engines, bodies: ca.bodies },
    canonical: normalizeCarApi(ca),
  };

  return {
    vin,
    ymmt: { year, make, model, trim: args.ymmt?.trim ?? null },
    providers: { vdb, nhtsa, marketcheck, carapi },
  };
}

// ── FLEET helpers ───────────────────────────────────────────────────────────

/** Parse the leading model year out of a FLEET label ("2020 Ford F-350 …"). */
function fleetYear(label: string): number | null {
  const m = label.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

function fleetByVin(vin: string) {
  return FLEET.find((f) => f.vin.toUpperCase() === vin.toUpperCase()) ?? null;
}

// ── internal actions / queries ──────────────────────────────────────────────

/** Decode one vehicle through every provider; returns raw + canonical per provider. */
export const decodeAll = internalAction({
  args: {
    vin: v.optional(v.string()),
    ymmt: v.optional(
      v.object({
        year: v.optional(v.number()),
        make: v.optional(v.string()),
        model: v.optional(v.string()),
        trim: v.optional(v.string()),
      }),
    ),
  },
  handler: async (_ctx, args): Promise<any> => decodeVehicle(args),
});

/** Decode + score one VIN against FLEET ground truth (when the VIN is in FLEET). */
export const compareVin = internalAction({
  args: { vin: v.string() },
  handler: async (_ctx, args): Promise<any> => {
    const decoded = await decodeVehicle({ vin: args.vin });
    const fleet = fleetByVin(args.vin);
    const decodedLabel =
      [decoded.ymmt?.year, decoded.ymmt?.make, decoded.ymmt?.model]
        .filter(Boolean)
        .join(" ") || args.vin;
    const label = fleet?.label ?? decodedLabel;

    const byProvider: any = {};
    for (const [prov, out] of Object.entries(decoded.providers)) {
      byProvider[prov] = { ok: out.ok, applicable: out.applicable, reason: out.reason, canonical: out.canonical };
    }
    const { perProvider, disagreements } = scoreCanonical(byProvider, {
      engine_code_one_of: fleet?.expected.engine_code_one_of,
    });

    // Slim the payload: full raw from four providers can exceed 18 MB per VIN,
    // which corrupts CLI stdout capture. Keep canonical + a truncated raw
    // sample (enough to eyeball provider shape); use decodeAll for full raw.
    const RAW_CAP = 12_000;
    const slimProviders: any = {};
    for (const [prov, out] of Object.entries(decoded.providers)) {
      let rawSample: string | null = null;
      try {
        const s = JSON.stringify(out.raw);
        rawSample = s == null ? null : s.length > RAW_CAP ? s.slice(0, RAW_CAP) + "…[truncated]" : s;
      } catch {
        rawSample = null;
      }
      slimProviders[prov] = {
        ok: out.ok,
        applicable: out.applicable,
        httpStatus: out.httpStatus,
        reason: out.reason,
        canonical: out.canonical,
        rawSample,
      };
    }

    return {
      vin: args.vin,
      label,
      year: fleet ? fleetYear(fleet.label) : decoded.ymmt?.year ?? null,
      inFleet: !!fleet,
      carApiInRange: carApiYearInFreeRange(
        fleet ? fleetYear(fleet.label) : decoded.ymmt?.year ?? null,
      ),
      providers: slimProviders,
      score: { perProvider, disagreements },
    };
  },
});

/**
 * Trims/YMMT parity probe. VDB's "trims options" we use come embedded in the
 * per-VIN advanced decode (there is no YMMT trims endpoint in our plan —
 * ymm-specs 400s even on its doc example). This measures whether the candidates
 * offer a real YMMT trims catalog:
 *   - CarAPI  → /trims/v2 + /engines/v2 + /bodies/v2 (OEM catalog, free 2015–2020)
 *   - MarketCheck → live-inventory trim facets (market, not OEM) + per-VIN NeoVIN options
 *   - VDB     → per-VIN only (no YMMT enumeration in plan)
 */
export const trimsParity = internalAction({
  args: { year: v.number(), make: v.string(), model: v.string() },
  handler: async (_ctx, args): Promise<any> => {
    const { year, make, model } = args;

    // CarAPI OEM catalog (v2).
    const cat = await carApiYmmtCatalog({ year, make, model });
    const caTrims: any[] = Array.isArray(cat.trims?.data) ? cat.trims.data : [];
    const caEngines: any[] = Array.isArray(cat.engines?.data) ? cat.engines.data : [];
    const caBodies: any[] = Array.isArray(cat.bodies?.data) ? cat.bodies.data : [];
    const eng0 = caEngines[0] ?? {};
    const engineSpecFields = [
      "size", "cylinders", "horsepower_hp", "engine_type", "cam_type",
      "valves", "fuel_type", "drive_type", "transmission",
    ].filter((k) => eng0[k] != null && String(eng0[k]).trim() !== "");
    const carapi = {
      ok: caTrims.length > 0 || caEngines.length > 0,
      trimsCount: cat.trims?.collection?.count ?? caTrims.length,
      sampleTrims: caTrims.slice(0, 6).map((t) => t.description ?? t.name ?? t.trim).filter(Boolean),
      enginesCount: cat.engines?.collection?.count ?? caEngines.length,
      bodiesCount: cat.bodies?.collection?.count ?? caBodies.length,
      engineSpecFields,
      note: "OEM YMMT catalog: /trims/v2 + /engines/v2 + /bodies/v2 (free, 2015–2020)",
    };

    // MarketCheck live-inventory trim facets.
    const mc = await marketCheckTrimFacets({ year, make, model });
    const marketcheck = {
      ok: mc.ok && !!mc.trims?.length,
      trimsCount: mc.trims?.length ?? 0,
      sampleTrims: (mc.trims ?? []).slice(0, 8).map((t) => `${t.item} (${t.count})`),
      enginesCount: 0,
      bodiesCount: 0,
      engineSpecFields: [],
      note: "trims from live-inventory facets (market, not OEM); engine specs + options only per-VIN via NeoVIN",
    };

    // VDB — no YMMT catalog in our plan.
    const vdb = {
      ok: false,
      trimsCount: 0,
      sampleTrims: [] as string[],
      enginesCount: 0,
      bodiesCount: 0,
      engineSpecFields: [] as string[],
      note: "no YMMT trims/ymm-specs endpoint in our plan (400 record-not-found on doc example); trim + options only per-VIN via advanced-vin-decode",
    };

    return { year, make, model, providers: { vdb, carapi, marketcheck } };
  },
});

/** Canonical YMMs for the trims-parity probe (2015–2020 so CarAPI free applies). */
export const listTrimsTargets = internalQuery({
  args: {},
  handler: async () => [
    { year: 2019, make: "Chevrolet", model: "Silverado 1500" },
    { year: 2020, make: "Toyota", model: "Camry" },
    { year: 2019, make: "Honda", model: "Accord" },
    { year: 2018, make: "Ford", model: "F-150" },
    { year: 2016, make: "BMW", model: "3 Series" },
  ],
});

/** The FLEET fixtures (VIN + label + parsed year + engine-code ground truth). */
export const listFleet = internalQuery({
  args: { wave: v.optional(v.number()) },
  handler: async (_ctx, args) => {
    return FLEET.filter((f) => (args.wave ? f.wave === args.wave : true)).map((f) => ({
      vin: f.vin,
      label: f.label,
      year: fleetYear(f.label),
      wave: f.wave,
      engine_code_one_of: f.expected.engine_code_one_of ?? null,
    }));
  },
});

/**
 * Read-only sample of REAL VINs from the vehicles table (skips synthetic FLEET
 * VINs). Prefers model years 2015–2020 so CarAPI columns populate. Also yields
 * a YMMT tuple per VIN so the YMMT-only path can be exercised.
 */
export const _sampleRealVins = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 5;
    const rows = await ctx.db.query("vehicles").order("desc").take(500);
    const seen = new Set<string>();
    const inRange: any[] = [];
    const outRange: any[] = [];

    for (const veh of rows) {
      const vin = veh.vin?.trim();
      if (!vin || vin.length < 11) continue;
      if (vin.toUpperCase().endsWith("00001")) continue; // synthetic FLEET VIN
      if (seen.has(vin)) continue;
      seen.add(vin);

      let year: number | null = veh.year ?? null;
      let make: string | null = null;
      let model: string | null = null;
      let trim: string | null = null;

      if (veh.vehicle_config_id) {
        const cfg = await ctx.db.get(veh.vehicle_config_id);
        if (cfg) {
          year = cfg.year ?? year;
          trim = cfg.trim_name ?? null;
          const mk = cfg.make_id ? await ctx.db.get(cfg.make_id) : null;
          const md = cfg.model_id ? await ctx.db.get(cfg.model_id) : null;
          make = (mk as any)?.name ?? null;
          model = (md as any)?.name ?? null;
        }
      }

      const entry = { vin, year, ymmt: { year, make, model, trim } };
      (carApiYearInFreeRange(year) ? inRange : outRange).push(entry);
      if (inRange.length >= limit) break;
    }

    // Prefer in-range; top up with out-of-range to reach the limit if needed.
    return [...inRange, ...outRange].slice(0, limit);
  },
});
