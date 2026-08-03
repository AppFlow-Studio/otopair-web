/**
 * devOnly/estimatorMinutesSpread.ts — THROWAWAY diagnostic probe (design spike, NOT a feature).
 *
 * For a curated set of vehicles × services, resolves Estimator numeric IDs via the
 * public estimator-flow JSON endpoints, fetches the estimate payload, and returns a
 * FAITHFUL, LOSSLESS capture of every labor field (minutes, unrounded $, parts,
 * footnotes, totals, ranged_estimate, calculation_context) plus derived trust signals
 * (implied $/hr, variant spread, rate-consistency CV). Read-only — writes nothing.
 *
 * Feeds the decision: promote Estimator from a $0.4 dollar-guesstimate corroborator to
 * a real, exact labor-time source? See
 * docs/superpowers/specs/2026-06-15-repairpal-minutes-spread-spike-design.md
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
import { estimatorApiBase } from "../lib/estimatorApi";

// ───────────────────────── constants ─────────────────────────

/** Provider host comes from the deployment env, never from source. This is a
 *  manually-run devOnly probe, so an unset var should fail loudly rather than
 *  silently produce malformed URLs. */
function estimatorBase(): string {
  const base = estimatorApiBase();
  if (!base) {
    throw new Error(
      "ESTIMATOR_API_BASE is not set on this deployment — set it before running the minutes-spread probe.",
    );
  }
  return base;
}

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

/** Static service-slug → Estimator global serviceId map (resolved 2026-06-15 from the
 *  repair-services catalog). rotor_replacement has NO standalone Estimator service —
 *  the nearest is the composite "Brake Pad and Rotor Replacement" (4453439), whose
 *  minutes cover pads+rotors and are NOT comparable to standalone rotor labor. */
export const ESTIMATOR_SERVICE_IDS: Record<string, number | null> = {
  oil_change: 107,
  spark_plugs: 128,
  timing_belt: 144,
  brake_pad_replacement: 30,
  battery_replacement: 590,
  wheel_alignment: 169,
  rotor_replacement: null,
};
export const COMPOSITE_PAD_ROTOR_SERVICE_ID = 4453439;

/** High-spread flag threshold: a (vehicle×service) pair is "high spread" when its
 *  distinct minutes vary and max/min ≥ this ratio — i.e. picking the wrong variant hurts. */
const HIGH_SPREAD_RATIO = 1.25;

const DEFAULT_PROBE_SERVICES = [
  "oil_change",
  "spark_plugs",
  "timing_belt",
  "brake_pad_replacement",
  "rotor_replacement",
  "battery_replacement",
  "wheel_alignment",
];

const DEFAULT_PROBE_VEHICLES = [
  { year: 2015, make: "Honda", model: "Civic" },
  { year: 2017, make: "Toyota", model: "Camry" },
  { year: 2018, make: "Ford", model: "F-150" },
  { year: 2018, make: "Porsche", model: "911" },
  { year: 2019, make: "BMW", model: "3 Series" },
  { year: 2018, make: "Subaru", model: "Outback" },
  { year: 2020, make: "Tesla", model: "Model 3" }, // deliberate coverage-gap probe
];

// ───────────────────────── types ─────────────────────────

export type MoneyBand = {
  low: number; high: number;
  independent: { low: number; high: number };
  dealer: { low: number; high: number };
};

export type EstimatorVariant = {
  key: string;
  position: string | null;
  labor: { low: number; high: number; minutes: number; notes: string[] };
  hours: number;
  implied_rate_low: number;
  implied_rate_high: number;
  total: MoneyBand;
  parts: Array<{
    part: string; position: string;
    total_price: { low: number; high: number };
    quantity: number;
  }>;
  footnotes: string[];
};

// ───────────────────────── pure helpers ─────────────────────────

/** Lowercase, replace any run of non-alphanumerics with a single space, trim. */
export function normalizeName(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** Find a make by normalized-name equality → its numeric id, or null. */
export function matchMake(makes: any[], make: string): number | null {
  const want = normalizeName(make);
  for (const m of makes) {
    if (normalizeName(String(m?.name ?? "")) === want) return Number(m.id);
  }
  return null;
}

/** Find a base-vehicle by normalized modelName equality → its id record, or null. */
export function matchBaseVehicle(
  list: any[],
  model: string,
): { base_vehicle_id: number; slug: string; model_name: string; model_id: number } | null {
  const want = normalizeName(model);
  for (const bv of list) {
    if (normalizeName(String(bv?.modelName ?? "")) === want) {
      return {
        base_vehicle_id: Number(bv.id),
        slug: String(bv.slug ?? ""),
        model_name: String(bv.modelName ?? ""),
        model_id: Number(bv.modelId ?? 0),
      };
    }
  }
  return null;
}

/** labor dollars ÷ (minutes/60). 0 when minutes ≤ 0. */
export function impliedRate(laborDollars: number, minutes: number): number {
  if (!(minutes > 0)) return 0;
  return laborDollars / (minutes / 60);
}

/** Population coefficient of variation (stddev / mean). 0 for empty or zero-mean. */
export function cv(nums: number[]): number {
  if (nums.length === 0) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return 0;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

/** CV of implied low/high $/hr across a variant set. null if no variants. */
export function rateConsistency(
  variants: Array<{ implied_rate_low: number; implied_rate_high: number }>,
): { low_cv: number; high_cv: number } | null {
  if (variants.length < 1) return null;
  return {
    low_cv: cv(variants.map((v) => v.implied_rate_low)),
    high_cv: cv(variants.map((v) => v.implied_rate_high)),
  };
}

function coerceMoneyBand(t: any): MoneyBand {
  const n = (x: any) => (typeof x === "number" ? x : 0);
  return {
    low: n(t?.low), high: n(t?.high),
    independent: { low: n(t?.independent?.low), high: n(t?.independent?.high) },
    dealer: { low: n(t?.dealer?.low), high: n(t?.dealer?.high) },
  };
}

/** Build one variant from a payload `estimate` object. null if labor.minutes is non-numeric. */
function variantFromEstimate(key: string, position: string | null, est: any): EstimatorVariant | null {
  const labor = est?.labor;
  if (!labor || typeof labor.minutes !== "number") return null;
  const minutes = labor.minutes;
  const low = typeof labor.low === "number" ? labor.low : 0;
  const high = typeof labor.high === "number" ? labor.high : 0;
  return {
    key, position,
    labor: { low, high, minutes, notes: Array.isArray(labor.notes) ? labor.notes : [] },
    hours: minutes / 60,
    implied_rate_low: impliedRate(low, minutes),
    implied_rate_high: impliedRate(high, minutes),
    total: coerceMoneyBand(est.total),
    parts: Array.isArray(est.parts)
      ? est.parts.map((p: any) => ({
          part: String(p?.part ?? ""),
          position: String(p?.position ?? ""),
          total_price: { low: Number(p?.total_price?.low ?? 0), high: Number(p?.total_price?.high ?? 0) },
          quantity: Number(p?.quantity ?? 0),
        }))
      : [],
    footnotes: Array.isArray(est.footnotes) ? est.footnotes : [],
  };
}

/** Locate the variant map (submodel | engine_base) and extract every variant,
 *  descending into position_count splits. Variants lacking numeric minutes are dropped. */
export function extractVariants(estimateJson: any): {
  dimension: "submodel" | "engine_base" | null;
  variants: EstimatorVariant[];
} {
  const e = estimateJson?.estimates ?? {};
  const dimension: "submodel" | "engine_base" | null = e.submodel
    ? "submodel"
    : e.engine_base
      ? "engine_base"
      : null;
  if (!dimension) return { dimension: null, variants: [] };
  const map = e[dimension] ?? {};
  const variants: EstimatorVariant[] = [];
  for (const [key, node] of Object.entries<any>(map)) {
    if (node?.estimate) {
      const variant = variantFromEstimate(key, null, node.estimate);
      if (variant) variants.push(variant);
    } else if (node?.position_count) {
      for (const [pos, p] of Object.entries<any>(node.position_count)) {
        const variant = variantFromEstimate(key, pos, p?.estimate);
        if (variant) variants.push(variant);
      }
    }
  }
  return { dimension, variants };
}

/** min/max/distinct of variant minutes. null if no variants. */
export function minutesSpread(
  variants: Array<{ labor: { minutes: number } }>,
): { min: number; max: number; distinct: number } | null {
  if (variants.length === 0) return null;
  const mins = variants.map((v) => v.labor.minutes);
  return { min: Math.min(...mins), max: Math.max(...mins), distinct: new Set(mins).size };
}

/** Faithful echo of the payload's top-level non-variant fields. */
export function extractPayloadEcho(j: any): {
  vehicle: string; operation: string;
  calculation_context: { vehicle_brand_price_impact_percent: number; geographic_area_price_impact_percent: number } | null;
  ranged_estimate: { total: MoneyBand; labor: { low: number; high: number }; parts: { low: number; high: number; names: string[] } } | null;
} {
  const re = j?.estimates?.ranged_estimate;
  const cc = j?.calculation_context;
  return {
    vehicle: String(j?.vehicle ?? ""),
    operation: String(j?.operation ?? ""),
    calculation_context: cc
      ? {
          vehicle_brand_price_impact_percent: Number(cc.vehicle_brand_price_impact_percent ?? 0),
          geographic_area_price_impact_percent: Number(cc.geographic_area_price_impact_percent ?? 0),
        }
      : null,
    ranged_estimate: re
      ? {
          total: coerceMoneyBand(re.total),
          labor: { low: Number(re.labor?.low ?? 0), high: Number(re.labor?.high ?? 0) },
          parts: { low: Number(re.parts?.low ?? 0), high: Number(re.parts?.high ?? 0), names: Array.isArray(re.parts?.names) ? re.parts.names : [] },
        }
      : null,
  };
}

/** Plain median. null for empty. */
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Roll up per-row variants into the report summary. */
export function summarizeRows(rows: any[]): {
  median_implied_rate_low: number | null;
  median_implied_rate_high: number | null;
  rate_consistency: { low_cv: number | null; high_cv: number | null };
  high_spread_pairs: Array<{ vehicle: string; service: string; minutes_min: number; minutes_max: number; distinct_minutes: number }>;
  book_hours_deltas: Array<{ vehicle: string; service: string; estimator_hours: number; book_hours: number; delta_hours: number; delta_pct: number }>;
} {
  const allLow: number[] = [];
  const allHigh: number[] = [];
  const high_spread_pairs: any[] = [];
  for (const r of rows) {
    for (const v of r.variants ?? []) {
      allLow.push(v.implied_rate_low);
      allHigh.push(v.implied_rate_high);
    }
    const ms = r.minutes_spread;
    if (ms && ms.distinct > 1 && ms.min > 0 && ms.max / ms.min >= HIGH_SPREAD_RATIO) {
      high_spread_pairs.push({
        vehicle: r.payload?.vehicle || `${r.vehicle_input.year} ${r.vehicle_input.make} ${r.vehicle_input.model}`,
        service: r.service.slug,
        minutes_min: ms.min, minutes_max: ms.max, distinct_minutes: ms.distinct,
      });
    }
  }
  return {
    median_implied_rate_low: median(allLow),
    median_implied_rate_high: median(allHigh),
    rate_consistency: { low_cv: allLow.length ? cv(allLow) : null, high_cv: allHigh.length ? cv(allHigh) : null },
    high_spread_pairs,
    book_hours_deltas: [], // best-effort lookup deferred (curated set; see spec §9)
  };
}

// ───────────────────────── network helpers (untested glue) ─────────────────────────

type FetchResult = { json: any | null; via: "direct" | "firecrawl" | "failed"; status: number };

/** Firecrawl raw-body scrape of a JSON endpoint (NOT the LLM json-extract mode).
 *  Strips any HTML wrapper Firecrawl adds and JSON.parses the first {...}/[...] body. */
async function firecrawlRawJson(url: string): Promise<{ json: any | null; status: number }> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    console.warn("firecrawlRawJson: FIRECRAWL_API_KEY not set; cannot use proxy fallback");
    return { json: null, status: 0 };
  }
  try {
    const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["rawHtml"], timeout: 30000 }),
      signal: AbortSignal.timeout(35000),
    });
    if (!resp.ok) return { json: null, status: resp.status };
    const data = await resp.json();
    const d = data.data ?? data;
    const raw: string = d?.rawHtml ?? d?.html ?? d?.markdown ?? "";
    const text = raw.replace(/<[^>]+>/g, "").trim();
    const start = text.search(/[\[{]/);
    if (start < 0) return { json: null, status: resp.status };
    try {
      return { json: JSON.parse(text.slice(start)), status: resp.status };
    } catch {
      return { json: null, status: resp.status };
    }
  } catch (e) {
    console.error("firecrawlRawJson error:", e);
    return { json: null, status: 0 };
  }
}

/** Direct GET first (accept: application/json); on non-200 / non-JSON / parse-fail,
 *  fall back to the firecrawl raw scrape. Records which path produced the JSON. */
async function fetchEstimatorJson(url: string): Promise<FetchResult> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const ct = r.headers.get("content-type") ?? "";
    if (r.ok && ct.includes("json")) {
      try {
        return { json: await r.json(), via: "direct", status: r.status };
      } catch {
        /* fall through */
      }
    }
    const fc = await firecrawlRawJson(url);
    if (fc.json) return { json: fc.json, via: "firecrawl", status: fc.status || r.status };
    return { json: null, via: "failed", status: r.status };
  } catch {
    const fc = await firecrawlRawJson(url);
    if (fc.json) return { json: fc.json, via: "firecrawl", status: fc.status };
    return { json: null, via: "failed", status: 0 };
  }
}

type ResolveResult =
  | { ok: true; make_id: number; base_vehicle_id: number; slug: string; model_name: string; model_id: number }
  | { ok: false; stage: "make" | "base_vehicle"; make_id: number | null };

/** year → makes → base-vehicles, matched by name. Caches makes-per-year and
 *  base-vehicles-per-(year,makeId) in the passed Map. `fetchJson` is injected so the
 *  caller can tally direct/firecrawl/failed access counts. */
async function resolveBaseVehicleId(
  year: number, make: string, model: string,
  cache: Map<string, any[]>,
  fetchJson: (url: string) => Promise<FetchResult>,
): Promise<ResolveResult> {
  const makesKey = `makes:${year}`;
  let makes = cache.get(makesKey);
  if (makes === undefined) {
    const { json } = await fetchJson(`${estimatorBase()}/makes?year=${year}`);
    makes = Array.isArray(json) ? json : [];
    cache.set(makesKey, makes);
  }
  const makeId = matchMake(makes, make);
  if (makeId == null) return { ok: false, stage: "make", make_id: null };

  const bvKey = `bv:${year}:${makeId}`;
  let bvs = cache.get(bvKey);
  if (bvs === undefined) {
    const { json } = await fetchJson(`${estimatorBase()}/base-vehicles?year=${year}&makeId=${makeId}`);
    bvs = Array.isArray(json) ? json : [];
    cache.set(bvKey, bvs);
  }
  const bv = matchBaseVehicle(bvs, model);
  if (!bv) return { ok: false, stage: "base_vehicle", make_id: makeId };
  return { ok: true, make_id: makeId, ...bv };
}

// ───────────────────────── the probe ─────────────────────────

export const probe = internalAction({
  args: {
    zipCode: v.optional(v.string()),
    asOf: v.optional(v.string()),
    vehicles: v.optional(v.array(v.object({ year: v.number(), make: v.string(), model: v.string() }))),
    services: v.optional(v.array(v.string())),
    includeComposite: v.optional(v.boolean()),
  },
  handler: async (_ctx, args): Promise<any> => {
    const zipCode = args.zipCode ?? "10001";
    const vehicles = args.vehicles ?? DEFAULT_PROBE_VEHICLES;
    const serviceSlugs = args.services ?? DEFAULT_PROBE_SERVICES;
    const includeComposite = args.includeComposite ?? false;

    const cache = new Map<string, any[]>();
    const rows: any[] = [];
    const coverage_gaps: any[] = [];
    const by_request: Array<{ url: string; via: string; status: number }> = [];
    let direct_ok = 0, firecrawl_used = 0, failed = 0;

    const track = async (url: string): Promise<FetchResult> => {
      const res = await fetchEstimatorJson(url);
      by_request.push({ url, via: res.via, status: res.status });
      if (res.via === "direct") direct_ok++;
      else if (res.via === "firecrawl") firecrawl_used++;
      else failed++;
      return res;
    };

    for (const veh of vehicles) {
      const vlabel = `${veh.year} ${veh.make} ${veh.model}`;
      const rv = await resolveBaseVehicleId(veh.year, veh.make, veh.model, cache, track);
      if (!rv.ok) {
        for (const slug of serviceSlugs) {
          coverage_gaps.push({ vehicle: vlabel, service: slug, stage: rv.stage, detail: `${rv.stage} not found on Estimator` });
        }
        continue;
      }
      const resolved = {
        make_id: rv.make_id, base_vehicle_id: rv.base_vehicle_id,
        base_vehicle_slug: rv.slug, model_name: rv.model_name, model_id: rv.model_id,
      };

      for (const slug of serviceSlugs) {
        const cfg = LABOR_SERVICE_CONFIG[slug];
        const notes: string[] = [];
        let serviceId = ESTIMATOR_SERVICE_IDS[slug] ?? null;

        if (serviceId == null) {
          if (slug === "rotor_replacement" && includeComposite) {
            serviceId = COMPOSITE_PAD_ROTOR_SERVICE_ID;
            notes.push("composite pad+rotor — not comparable to standalone rotor");
          } else {
            coverage_gaps.push({
              vehicle: vlabel, service: slug, stage: "service_id",
              detail: slug === "rotor_replacement" ? "no standalone Estimator rotor service" : "no serviceId mapped",
            });
            continue;
          }
        }

        const url =
          `${estimatorBase()}/estimate?baseVehicleId=${rv.base_vehicle_id}` +
          `&scheduled=0&serviceId=${serviceId}&zipCode=${encodeURIComponent(zipCode)}`;
        const { json, via, status } = await track(url);

        if (!json) {
          coverage_gaps.push({ vehicle: vlabel, service: slug, stage: "estimate_empty", detail: `fetch ${via} status ${status}` });
          rows.push({
            vehicle_input: veh,
            service: { slug, estimator_slug: cfg?.estimator_slug ?? null, service_id: serviceId },
            resolved, fetch: { via, status, url },
            payload: { vehicle: "", operation: "", calculation_context: null, ranged_estimate: null },
            dimension: null, variant_count: 0, variants: [],
            minutes_spread: null, implied_rate_consistency: null,
            book_hours: null, book_hours_delta: null,
            notes: [...notes, "fetch failed / empty"],
          });
          continue;
        }

        const payload = extractPayloadEcho(json);
        const { dimension, variants } = extractVariants(json);
        const ms = minutesSpread(variants);
        const rc = rateConsistency(variants);
        if (variants.length === 0) notes.push("empty estimate");
        if (dimension === "engine_base") notes.push("engine_base dimension");
        if (variants.some((vv) => vv.position)) notes.push("position_count split");

        rows.push({
          vehicle_input: veh,
          service: { slug, estimator_slug: cfg?.estimator_slug ?? null, service_id: serviceId },
          resolved, fetch: { via, status, url },
          payload,
          dimension, variant_count: variants.length, variants,
          minutes_spread: ms, implied_rate_consistency: rc,
          book_hours: null, book_hours_delta: null,
          notes,
        });
      }
    }

    return {
      meta: { zipCode, scheduled: 0, asOf: args.asOf ?? null, vehicles_probed: vehicles.length, services_probed: serviceSlugs.length },
      access: { direct_ok, firecrawl_used, failed, by_request },
      resolution: { resolved_pairs: rows.filter((r) => r.variant_count > 0).length, coverage_gaps },
      summary: summarizeRows(rows),
      rows,
    };
  },
});
