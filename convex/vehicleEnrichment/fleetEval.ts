/**
 * vehicleEnrichment/fleetEval.ts — adversarial stress-fleet evaluator.
 *
 * Companion to ENRICHMENT_STRESS_FLEET.md. Each FLEET vehicle attacks one
 * known-weak mechanism (HD capacities vs bands, cross-brand platform parts,
 * sibling-engine disambiguation, per-make fluid SKU patterns, EV/hybrid
 * applicability, marketing engine names, sparse-data pricing). Expected
 * values are ground truth verified against owner's manuals / OEM docs —
 * sources cited inline.
 *
 * Run one:   npx convex run vehicleEnrichment/fleetEval:evaluateConfig '{"vin":"…"}'
 * Run all:   npx convex run vehicleEnrichment/fleetEval:evaluateFleet
 *
 * The core invariant asserted everywhere: the pipeline may be IGNORANT
 * (null / flagged / ledgered) but never CONFIDENTLY WRONG.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import {
  matchesForeignBrandSignature,
  makesSameFamily,
} from "./contentSanitization";
import { isMarketplaceDomain } from "./sourceRegistry";
import { isSyntheticEngineCode } from "./utils/engineLookup";
import { isPoisonPriceType, isNonPooledPriceType } from "../lib/priceTypes";
import { computeQuotability, type QuotabilityFitmentInput } from "./quotability";

// ─── Fleet definition ────────────────────────────────────────────

interface Range {
  min: number;
  max: number;
}

export interface FleetExpectation {
  /** Ground-truth oil capacity band (qts, with filter). */
  oil_qts?: Range;
  /** Ground-truth TOTAL coolant capacity band (qts). */
  coolant_qts?: Range;
  oil_viscosity_one_of?: string[];
  /** Accept any of these engine codes (families/variants). Omit → only
   *  assert the stored code is not synthetic. */
  engine_code_one_of?: string[];
  /** Services that MUST carry at least one fluid-category fitment. */
  fluid_services?: string[];
  /** Services that must NOT exist for this vehicle (EV/hybrid honesty). */
  na_services?: string[];
  /** Minimum acceptable run quotability (default 0.5 — adversarial fleet). */
  min_quotability?: number;
  /** EVs have no engine — the placeholder synthetic code is the honest state. */
  allow_synthetic_engine_code?: boolean;
}

export interface FleetVehicle {
  key: string;
  label: string;
  vin: string;
  wave: 1 | 2;
  attack: string;
  expected: FleetExpectation;
}

export const FLEET: FleetVehicle[] = [
  // ── Wave 1 — expected failures ──
  {
    key: "f350_67_diesel",
    label: "2020 Ford F-350 6.7L Power Stroke (HD diesel capacities)",
    vin: "1FT8W3BT8LED00001",
    wave: 1,
    attack:
      "Coolant total 31.7–35.1 qt exceeds the hard reject band (24); oil 13 qt. " +
      "Hypothesis: correct coolant REJECTED by getCapacityBand.",
    expected: {
      // 2020 owner's manual: oil 13.0 qt w/ filter (hotshotsecret.com 6.7L
      // capacities; ford-trucks.com owner-manual thread). Coolant total
      // 31.7–35.1 qt across primary+secondary systems (hotshotsecret.com).
      oil_qts: { min: 12.0, max: 14.0 },
      coolant_qts: { min: 29.0, max: 36.5 },
      // Ford approves 10W-30 (normal) AND 5W-40 (severe duty / biodiesel).
      oil_viscosity_one_of: ["10W-30", "5W-40"],
      fluid_services: ["oil_change"],
      min_quotability: 0.4,
    },
  },
  {
    key: "supra_b58",
    label: "2020 Toyota GR Supra 3.0 (BMW B58 — cross-brand platform)",
    vin: "WZ1DB4C05LW030001",
    wave: 1,
    attack:
      "BMW-built car sold as Toyota: BMW-format OEM part numbers on a Toyota " +
      "config trip matchesForeignBrandSignature (Toyota↔BMW is not a corporate " +
      "family). NHTSA returns a BLANK engine model → engine-code fallback test.",
    expected: {
      // Oil 6.9 qt (6.5 L) w/ filter, 0W-20 — amsoil.com lookup (engine
      // B58B30M), blauparts.com Supra oil kit.
      oil_qts: { min: 6.4, max: 7.4 },
      oil_viscosity_one_of: ["0W-20"],
      engine_code_one_of: ["B58", "B58B30M", "B58B30M1", "B58B30"],
      fluid_services: ["oil_change"],
      min_quotability: 0.4,
    },
  },
  {
    key: "silverado_l84",
    label: "2019 Chevy Silverado 1500 5.3L L84 (sibling-engine poison)",
    vin: "1GCUYDED2KZ100001",
    wave: 1,
    attack:
      "The original 16.9-qt forum-poison vehicle class. Three sibling engines " +
      "(L82/L84/L87 + HD trucks) share model-level capacity tables; correct " +
      "coolant 16.6 qt ALSO sits just above the V8 typical ceiling (16).",
    expected: {
      // Oil 8.0 qt 0W-20 (GM TechLink 2019-2020 oil capacities PDF).
      // Coolant ~16.6 qt total (garage.wiki 2019 Silverado cooling capacity;
      // drain/fill ~14 qt — do NOT accept 5.3 HD/6.2 figures).
      oil_qts: { min: 7.5, max: 8.5 },
      coolant_qts: { min: 15.0, max: 18.0 },
      oil_viscosity_one_of: ["0W-20"],
      engine_code_one_of: ["L84"],
      fluid_services: ["oil_change", "coolant_flush"],
      min_quotability: 0.5,
    },
  },
  {
    key: "altima_cvt",
    label: "2019 Nissan Altima 2.5 S (CVT + Nissan chemical SKUs)",
    vin: "1N4BL4BV3KC110001",
    wave: 1,
    attack:
      "NS-3 CVT fluid (KE909-99943-class SKU) exercises the new Nissan " +
      "chemical pattern live; CVT drain/fill vs total confusion; NHTSA " +
      "returns blank cylinders.",
    expected: {
      // Oil 5.4 qt (5.1 L) w/ filter, 0W-20 — noln.net 2019 Altima tech spec,
      // automobile-catalog.com. Engine PR25DD.
      oil_qts: { min: 5.0, max: 5.9 },
      oil_viscosity_one_of: ["0W-20"],
      engine_code_one_of: ["PR25DD", "PR25"],
      fluid_services: ["oil_change", "transmission_service"],
      min_quotability: 0.5,
    },
  },

  // ── Wave 2 — after wave-1 fixes ──
  {
    key: "tesla_model3",
    label: "2021 Tesla Model 3 (EV honesty)",
    vin: "5YJ3E1EA4MF000001",
    wave: 2,
    attack:
      "No engine oil / spark plugs / transmission service exist. Pipeline " +
      "must return not_applicable, not hallucinated specs. battery_replacement " +
      "must resolve to the 12V battery.",
    expected: {
      na_services: ["oil_change", "spark_plugs", "transmission_service"],
      min_quotability: 0.2,
      allow_synthetic_engine_code: true,
    },
  },
  {
    key: "prius_hybrid",
    label: "2021 Toyota Prius (hybrid, 0W-16, eCVT)",
    vin: "JTDKAMFU6M3000001",
    wave: 2,
    attack:
      "0W-16 viscosity (rare) must survive normalization; eCVT has no " +
      "conventional drain/fill service; 2ZR-FXE engine code.",
    expected: {
      // Oil 4.4 qt (4.2 L) w/ filter, 0W-16 — Toyota owner's manual (verify
      // at wave-2 execution).
      oil_qts: { min: 4.0, max: 4.8 },
      oil_viscosity_one_of: ["0W-16"],
      engine_code_one_of: ["2ZR-FXE", "2ZRFXE", "2ZR"],
      min_quotability: 0.4,
    },
  },
  {
    key: "mercedes_c300",
    label: "2016 Mercedes C300 W205 (MB A-number fluid SKUs)",
    vin: "55SWF4JB4GU100001",
    wave: 2,
    attack:
      "MB 229.5 oil SKU (A000989…) and long-suffix A-numbers stress the " +
      "mercedes pattern's suffix block; M274 engine code.",
    expected: {
      // Oil ~6.1 qt (5.8 L) w/ filter 0W-40/5W-40 MB 229.5 (verify at wave-2).
      oil_qts: { min: 5.5, max: 6.9 },
      engine_code_one_of: ["M274", "M274DE20AL", "274.920"],
      min_quotability: 0.5,
    },
  },
  {
    key: "odyssey_2005",
    label: "2005 Honda Odyssey EX-L J35A7 (sparse data + timing belt)",
    vin: "5FNRL38745B100001",
    wave: 2,
    attack:
      "20-year-old car: price discovery likely finds only marketplaces → " +
      "mass zero-price must be LEDGERED, never silent. Timing BELT via " +
      "knownEngineFacts (J35 family).",
    expected: {
      // Oil 4.5 qt w/ filter 5W-20 (verify at wave-2). VCM J35A7.
      oil_qts: { min: 4.0, max: 5.0 },
      engine_code_one_of: ["J35A7", "J35A", "J35"],
      min_quotability: 0.3,
    },
  },
  {
    key: "equinox_ltg",
    label: "2019 Chevy Equinox 2.0T LTG (GM dash-code fluids)",
    vin: "2GNAXVEX1K6100001",
    wave: 2,
    attack:
      "ACDelco dash-code fluid SKUs (10-9243 Dex-Cool) exercise the new GM " +
      "pattern live.",
    expected: {
      // Oil 5.0 qt 5W-30 (verify at wave-2). LTG 2.0T.
      oil_qts: { min: 4.5, max: 5.7 },
      engine_code_one_of: ["LTG"],
      fluid_services: ["oil_change", "coolant_flush"],
      min_quotability: 0.5,
    },
  },
  {
    key: "golf_gti_ea888",
    label: "2015 VW Golf GTI (VAG family sharing with Audi parts)",
    vin: "3VW4T7AU3FM000001",
    wave: 2,
    attack:
      "MQB EA888 Gen3 shares parts with the enriched Audi A4. Family-shared " +
      "parts stamped with Audi make_id must pass VW write/read guards; " +
      "G/N-number fluids on the VW OLP subdomain.",
    expected: {
      // Oil 6.1 qt (5.8 L) w/ filter 5W-40/0W-40 VW 502 00 (verify at wave-2).
      oil_qts: { min: 5.5, max: 6.6 },
      engine_code_one_of: ["CXCA", "CXCB", "EA888", "CHHX", "CHHA"],
      min_quotability: 0.5,
    },
  },
  {
    key: "stelvio_ti",
    label: "2018 Alfa Romeo Stelvio Ti (cross-make contamination history)",
    vin: "ZASPAKBN3J7C00001",
    wave: 2,
    attack:
      "The historic Motorcraft-battery contamination case: retailer 'fits " +
      "your car' pages feed wrong-make numbers; sparse Mopar-family patterns.",
    expected: {
      // Oil 5.5 qt (5.2 L) 0W-30 — verified wave-2 (vehiclehistory.com,
      // alfa-romeo.oilsr.us). The initial 4.8 guess was the WRONG truth; the
      // pipeline's 5.5 was correct.
      oil_qts: { min: 5.0, max: 6.0 },
      fluid_services: ["oil_change"],
      min_quotability: 0.4,
    },
  },
  {
    key: "sonata_smartstream",
    label: "2020 Hyundai Sonata SEL 2.5 (marketing engine names)",
    vin: "5NPEL4JA7LH000001",
    wave: 2,
    attack:
      "NHTSA returns 'GDI THETA III' — a family/marketing name. " +
      "isSyntheticEngineCode was only ever exercised on 'TFSI'; the real " +
      "code is G4KN (Smartstream G2.5).",
    expected: {
      // Book values conflict: 5.5 qt w/ filter (amsoil.com) vs ~5.8-5.9
      // owner-manual claims (hyundai-forums capacity thread) — verified
      // wave-2; range covers the legitimate spread, still catches 4.x/6.5+.
      oil_qts: { min: 5.2, max: 6.2 },
      engine_code_one_of: ["G4KN"],
      min_quotability: 0.5,
    },
  },
];

// ─── Evaluation ──────────────────────────────────────────────────

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

function assertRange(
  name: string,
  value: number | null | undefined,
  range: Range | undefined,
  out: Assertion[],
) {
  if (!range) return;
  if (value == null) {
    // Ignorance is acceptable (null → gap ledger / resolver review), never
    // penalized by this suite. Confident wrongness is the failure.
    out.push({ name, pass: true, detail: "null (honest ignorance — check gap ledger)" });
    return;
  }
  const ok = value >= range.min && value <= range.max;
  out.push({
    name,
    pass: ok,
    detail: `${value} vs expected [${range.min}, ${range.max}]${ok ? "" : " — CONFIDENTLY WRONG"}`,
  });
}

async function evaluateOne(ctx: any, fleetVehicle: FleetVehicle) {
  const { vin, expected } = fleetVehicle;
  const assertions: Assertion[] = [];

  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();
  if (!vehicle?.vehicle_config_id) {
    return { key: fleetVehicle.key, vin, status: "not_enriched", assertions };
  }
  const config = await ctx.db.get(vehicle.vehicle_config_id);
  if (!config) {
    return { key: fleetVehicle.key, vin, status: "config_missing", assertions };
  }
  const engine = config.engine_id ? await ctx.db.get(config.engine_id) : null;
  const make = config.make_id ? await ctx.db.get(config.make_id) : null;
  const makeName: string | null = make?.name ?? null;

  const runs = await ctx.db
    .query("enrichment_runs")
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", config._id))
    .collect();
  const run = runs.sort((a: any, b: any) => (b.started_at ?? 0) - (a.started_at ?? 0))[0] ?? null;

  // 1. Run terminality — a stuck run is an automatic failure.
  assertions.push({
    name: "run_terminal",
    pass: run != null && ["complete", "timeout", "failed"].includes(run.status),
    detail: `status=${run?.status ?? "no run"}`,
  });

  // 2. Capacity honesty.
  assertRange("oil_capacity", engine?.oil_capacity_qts, expected.oil_qts, assertions);
  assertRange("coolant_capacity", engine?.coolant_capacity_qts, expected.coolant_qts, assertions);
  if (expected.oil_viscosity_one_of && engine?.oil_viscosity != null) {
    assertions.push({
      name: "oil_viscosity",
      pass: expected.oil_viscosity_one_of.includes(engine.oil_viscosity),
      detail: `${engine.oil_viscosity} vs one of [${expected.oil_viscosity_one_of.join(", ")}]`,
    });
  }

  // 3. Engine code: never synthetic; matches expectation when given.
  const code: string | null = engine?.engine_code ?? null;
  if (code != null && !expected.allow_synthetic_engine_code) {
    assertions.push({
      name: "engine_code_not_synthetic",
      pass: !isSyntheticEngineCode(code),
      detail: code,
    });
  }
  if (expected.engine_code_one_of && code != null) {
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    assertions.push({
      name: "engine_code_match",
      pass: expected.engine_code_one_of.some(
        (c) => norm(code) === norm(c) || norm(code).startsWith(norm(c)),
      ),
      detail: `${code} vs one of [${expected.engine_code_one_of.join(", ")}]`,
    });
  }

  // 4. Fitment sweep: foreign-brand contamination + marketplace prices +
  //    fluid coverage + N/A honesty, in one pass.
  const fitments = await ctx.db
    .query("part_fitments")
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", config._id))
    .collect();

  const foreign: string[] = [];
  const marketplace: string[] = [];
  const fluidServicesSeen = new Set<string>();
  const naViolations: string[] = [];
  const naSet = new Set(expected.na_services ?? []);
  // Live quotability inputs — the run's persisted quotability is a snapshot
  // taken at finalize, BEFORE the scheduled follow-up price backfill lands
  // (wave-1 finding: the F-350 backfill wrote 21 price rows minutes after the
  // run closed). The evaluator must measure the data as it stands NOW.
  const liveFitments: QuotabilityFitmentInput[] = [];

  for (const f of fitments) {
    const part = await ctx.db.get(f.part_id);
    if (!part) continue;
    const partMake = part.make_id ? await ctx.db.get(part.make_id) : null;
    const sig = matchesForeignBrandSignature(part.oem_part_number ?? "", makeName ?? "");
    if (sig && !makesSameFamily(makeName, partMake?.name ?? makeName)) {
      foreign.push(`${part.oem_part_number} (${sig}) on ${f.service_type}`);
    }
    if (part.category === "fluid" || part.subcategory === "coolant") {
      fluidServicesSeen.add(f.service_type);
    }
    if (naSet.has(f.service_type)) {
      naViolations.push(`${f.service_type}: ${part.oem_part_number}`);
    }
    const prices = await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q: any) => q.eq("part_id", f.part_id))
      .collect();
    let trusted = false;
    for (const p of prices) {
      if (isMarketplaceDomain(p.source_domain)) {
        marketplace.push(`${part.oem_part_number} @ ${p.source_domain}`);
      }
      if (!isPoisonPriceType(p.price_type) && !isNonPooledPriceType(p.price_type)) {
        trusted = true;
      }
    }
    liveFitments.push({
      service_type: f.service_type,
      subcategory: part.subcategory ?? null,
      has_trusted_price: trusted,
    });
  }

  assertions.push({
    name: "no_foreign_brand_parts",
    pass: foreign.length === 0,
    detail: foreign.length ? foreign.join("; ") : "clean",
  });
  assertions.push({
    name: "no_marketplace_prices",
    pass: marketplace.length === 0,
    detail: marketplace.length ? marketplace.join("; ") : "clean",
  });
  for (const svc of expected.fluid_services ?? []) {
    assertions.push({
      name: `fluid_fitment:${svc}`,
      pass: fluidServicesSeen.has(svc),
      detail: fluidServicesSeen.has(svc) ? "present" : "MISSING fluid fitment",
    });
  }
  if (naSet.size > 0) {
    assertions.push({
      name: "na_services_honest",
      pass: naViolations.length === 0,
      detail: naViolations.length ? naViolations.join("; ") : "clean",
    });
  }

  // 5. Quotability + non-silence: computed LIVE from the current fitment +
  //    price state (the run's persisted quotability predates the follow-up
  //    backfill). Applicable services come from the run snapshot when present
  //    (it knew is_applicable) — coverage numbers are recomputed fresh.
  const minQ = expected.min_quotability ?? 0.5;
  const applicableSlugs: string[] =
    run?.quotability?.services?.map((s: any) => s.slug) ??
    [...new Set(fitments.map((f: any) => f.service_type))];
  const live = computeQuotability(liveFitments, applicableSlugs);
  assertions.push({
    name: "quotability_live",
    pass: live.pct >= minQ,
    detail: `live ${live.pct} (run snapshot ${run?.quotability?.pct ?? "n/a"}) vs min ${minQ} — ${live.services
      .filter((s) => s.core_with_price < s.core_total)
      .map((s) => `${s.slug}:${s.core_with_price}/${s.core_total}`)
      .join(" ") || "all quotable"}`,
  });
  const unpricedCoreRoles = live.services.reduce(
    (n, s) => n + (s.core_total - s.core_with_price),
    0,
  );
  const explanatoryGaps = (run?.field_gaps ?? []).filter(
    (g: any) =>
      g.field.startsWith("part_price:") ||
      g.reason.startsWith("validation_dropped") ||
      g.reason === "llm_null",
  ).length;
  assertions.push({
    name: "gaps_not_silent",
    pass: unpricedCoreRoles === 0 || explanatoryGaps > 0,
    detail: `${unpricedCoreRoles} unpriced core roles, ${explanatoryGaps} explanatory gap entries`,
  });

  const failed = assertions.filter((a) => !a.pass);
  return {
    key: fleetVehicle.key,
    label: fleetVehicle.label,
    vin,
    config_key: config.config_key,
    status: failed.length === 0 ? "PASS" : "FAIL",
    failed: failed.length,
    total: assertions.length,
    assertions,
  };
}

export const evaluateConfig = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const fleetVehicle = FLEET.find((f) => f.vin === args.vin);
    if (!fleetVehicle) return { error: `VIN not in FLEET: ${args.vin}` };
    return await evaluateOne(ctx, fleetVehicle);
  },
});

export const evaluateFleet = internalQuery({
  args: { wave: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const targets = FLEET.filter((f) => args.wave == null || f.wave === args.wave);
    const results = [];
    for (const t of targets) {
      results.push(await evaluateOne(ctx, t));
    }
    return {
      summary: results.map((r: any) => `${r.status ?? "?"} ${r.key} (${r.failed ?? "-"}/${r.total ?? "-"} failed)`),
      results,
    };
  },
});
