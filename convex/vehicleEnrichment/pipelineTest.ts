/**
 * vehicleEnrichment/pipelineTest.ts — v3 Pipeline Test Harness
 *
 * Runs the v3 hybrid pipeline against test vehicles and outputs
 * a full markdown comparison report to console (paste into docs/).
 *
 * Usage: Deploy with `npx convex dev`, then trigger from Convex dashboard:
 *   internal.vehicleEnrichment.pipelineTest.runV3Test({})
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { FieldResult } from "./helpers";
import { ENRICHMENT_FIELD_KEYS } from "./helpers";
import { V4_FIELD_KEYS, buildEngineKey as buildV4EngineKey } from "./types";

// ─── Test Vehicle Data ──────────────────────────────────────────────

const BMW_M550I = {
  vin: "WBAJS7C01LBN96146",
  year: 2020,
  make: "BMW",
  model: "5 Series",
  trim: "M550i xDrive",
  engineCode: "N63B44O2",
  displacement: "4.4",
  engineKey: "2020_bmw_5_series_n63b44o2",
};

const TEST_VEHICLES = [
  {
    name: "BMW M550i",
    vin: "WBAJS7C01LBN96146",
    year: 2020,
    make: "BMW",
    model: "5 Series",
    trim: "M550i xDrive",
    engineCode: "N63B44O2",
    displacement: "4.4",
  },
  {
    name: "Mercedes C300",
    vin: "W1KWF8DB1NR000001",
    year: 2022,
    make: "Mercedes-Benz",
    model: "C-Class",
    trim: "C300 4MATIC",
    engineCode: "M264",
    displacement: "2.0",
  },
  {
    name: "Toyota Camry",
    vin: "4T1C11AK3NU000001",
    year: 2022,
    make: "Toyota",
    model: "Camry",
    trim: "SE",
    engineCode: "A25AFKS",
    displacement: "2.5",
  },
];

// ─── Field Category Definitions ─────────────────────────────────────

const FLUIDS_FIELDS = [
  "oil_viscosity", "oil_capacity_qts", "coolant_type",
  "coolant_capacity_qts", "power_steering_type", "brake_fluid_type",
];

const INTERVALS_FIELDS = [
  "oil_change_miles", "oil_change_months",
  "spark_plug_miles", "spark_plug_months",
  "transmission_service_miles", "transmission_service_months",
  "coolant_flush_miles", "coolant_flush_months",
  "air_filter_miles", "air_filter_months",
  "cabin_filter_miles", "cabin_filter_months",
];

const ATTRIBUTES_FIELDS = ["timing_system", "drivetrain", "turbo"];

const PARTS_FIELDS = [
  "oil_filter_oem", "air_filter_oem", "cabin_filter_oem", "spark_plug_oem",
  "front_brake_pad_oem", "rear_brake_pad_oem", "drain_plug_gasket_oem",
  "battery_group", "battery_cca", "parking_brake_type",
];

const PRICING_FIELDS = [
  "oil_change_price", "brake_pad_front_price", "brake_pad_rear_price",
  "spark_plug_price", "air_filter_price", "cabin_filter_price",
];

const LABOR_FIELDS = [
  "estimated_labor_oil_change_hrs", "estimated_labor_brake_front_hrs",
  "estimated_labor_brake_rear_hrs", "estimated_labor_spark_plug_hrs",
];

// Known v2 values for head-to-head field comparison
const V2_KNOWN_VALUES: Record<string, string> = {
  oil_viscosity: "0W-30",
  oil_capacity_qts: "11.1",
  coolant_type: "BMW HT-12 (Green)",
  coolant_capacity_qts: "9.25",
  brake_fluid_type: "DOT 4",
  power_steering_type: "Electric Power Steering",
  oil_change_miles: "10000",
  oil_change_months: "12",
  spark_plug_miles: "60000",
  transmission_service_miles: "60000",
  coolant_flush_miles: "60000",
  coolant_flush_months: "48",
  air_filter_miles: "60000",
  cabin_filter_miles: "12000",
  cabin_filter_months: "12",
  timing_system: "chain",
  drivetrain: "AWD",
  turbo: "true",
  oil_filter_oem: "11427583220",
  rear_brake_pad_oem: "34216896975",
  battery_group: "H8/Group 49",
  battery_cca: "850",
};

const FIRECRAWL_KNOWN_VALUES: Record<string, string> = {
  oil_viscosity: "5W-30",
  oil_capacity_qts: "11",
  oil_change_miles: "10000",
  air_filter_miles: "60000",
  spark_plug_miles: "60000",
  cabin_filter_oem: "64316835405",
  cabin_filter_price: "97.38",
};

// ─── Helper Mutations & Queries ─────────────────────────────────────

export const findVehicleByVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
  },
});

export const clearCacheByEngineKey = internalMutation({
  args: { engineKey: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.engineKey))
      .first();

    if (!existing) return { deleted: false, id: null };

    const linked = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", existing._id),
      )
      .collect();

    for (const v of linked) {
      await ctx.db.patch(v._id, {
        vehicle_config_id: undefined,
        enriched_engine_config_id: undefined,
      });
    }

    await ctx.db.delete(existing._id);
    return { deleted: true, id: existing._id };
  },
});

export const createTestVehicle = internalMutation({
  args: { vin: v.string(), year: v.float64() },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("vehicles", {
      vin: args.vin,
      year: args.year,
      created_at: now,
      updated_at: now,
    });
  },
});

// ─── Main Test Action ───────────────────────────────────────────────

export const runV3Test = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("[TEST] Starting v3 pipeline test for BMW M550i...");

    // Step 1: Find or create test vehicle
    let vehicle = await ctx.runQuery(
      internal.vehicleEnrichment.pipelineTest.findVehicleByVin,
      { vin: BMW_M550I.vin },
    );

    if (!vehicle) {
      const vehicleId = await ctx.runMutation(
        internal.vehicleEnrichment.pipelineTest.createTestVehicle,
        { vin: BMW_M550I.vin, year: BMW_M550I.year },
      );
      vehicle = { _id: vehicleId } as any;
      console.log(`[TEST] Created test vehicle: ${vehicleId}`);
    } else {
      console.log(`[TEST] Found existing vehicle: ${vehicle._id}`);
    }

    // Step 2: Clear enrichment cache
    const cacheResult = await ctx.runMutation(
      internal.vehicleEnrichment.pipelineTest.clearCacheByEngineKey,
      { engineKey: BMW_M550I.engineKey },
    );
    console.log(`[TEST] Cache cleared: ${cacheResult.deleted ? "deleted " + cacheResult.id : "none found"}`);

    // Step 3: Run v3 pipeline with timing
    console.log("[TEST] Running v3 pipeline...");
    const startMs = Date.now();

    let pipelineResult: any;
    let pipelineError: string | null = null;
    try {
      pipelineResult = await ctx.runAction(
        internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
        {
          vehicleId: vehicle._id,
          year: BMW_M550I.year,
          make: BMW_M550I.make,
          model: BMW_M550I.model,
          trim: BMW_M550I.trim,
          engineCode: BMW_M550I.engineCode,
          displacement: BMW_M550I.displacement,
        },
      );
    } catch (error) {
      pipelineError = String(error);
      pipelineResult = { status: "error" };
      console.error("[TEST] Pipeline error:", pipelineError);
    }

    const totalTimeMs = Date.now() - startMs;
    console.log(`[TEST] Pipeline finished in ${(totalTimeMs / 1000).toFixed(1)}s`);

    // Step 4: Query stored enrichment
    const enrichment = await ctx.runQuery(
      internal.vehicleEnrichment.queries.getByEngineKey,
      { engineKey: BMW_M550I.engineKey },
    );

    if (!enrichment) {
      console.error("[TEST] No enrichment data found!");
      return { status: "error", message: "No enrichment stored" };
    }

    // Step 5: Generate markdown report
    const report = generateMarkdownReport(enrichment, totalTimeMs, pipelineError);

    // Log the full report — copy from Convex logs into docs/V3_PIPELINE_TEST_REPORT.md
    console.log("\n\n========== MARKDOWN REPORT START ==========");
    console.log(report);
    console.log("========== MARKDOWN REPORT END ==========\n");

    const metrics = calculateMetrics(enrichment);
    return {
      status: pipelineResult.status,
      totalTimeMs,
      fillRate: metrics.overallFillRate,
      avgConfidence: metrics.avgConfidence,
      filledCount: metrics.totalFilled,
    };
  },
});

// ─── Call 1B Diagnostic ────────────────────────────────────────────

export const diagnoseCall1B = internalAction({
  args: {},
  handler: async (ctx) => {
    const { callClaudeWithWebSearch } = await import("./claudeExtractor");
    const { SYSTEM_PROMPT, buildCall1BPrompt } = await import("./extractionPrompts");
    const { preGatherSources } = await import("./searchPreGather");
    const { filterByConfidence } = await import("./sourceVerifier");

    const vehicle = {
      vehicleId: "test",
      year: BMW_M550I.year,
      make: BMW_M550I.make,
      model: BMW_M550I.model,
      trim: BMW_M550I.trim,
      engineCode: BMW_M550I.engineCode,
      displacement: BMW_M550I.displacement,
    };

    console.log("[DIAG] Step 1: Pre-gather sources for parts...");
    const preGather = await preGatherSources(vehicle);
    console.log(`[DIAG] Got ${preGather.partsResults.length} parts sources`);
    for (const s of preGather.partsResults) {
      console.log(`[DIAG] Parts source: ${s.url} (${s.markdown.length} chars)`);
    }

    console.log("[DIAG] Step 2: Running Call 1B with web_search...");
    const prompt = buildCall1BPrompt(vehicle, preGather.partsResults);
    console.log(`[DIAG] Call 1B prompt length: ${prompt.length} chars`);

    const raw1B = await callClaudeWithWebSearch(SYSTEM_PROMPT, prompt, 10, 8000);

    console.log("[DIAG] Step 3: Raw Call 1B output:");
    console.log(JSON.stringify(raw1B, null, 2));

    console.log("[DIAG] Step 4: After filterByConfidence:");
    const filtered = filterByConfidence(raw1B, "BMW");
    for (const [key, val] of Object.entries(filtered)) {
      const hasValue = val && val.value != null;
      console.log(`[DIAG] ${key}: ${hasValue ? `"${val.value}" (conf=${val.confidence})` : "NULL"}`);
    }

    return {
      rawFieldCount: Object.keys(raw1B).length,
      rawNonNull: Object.entries(raw1B).filter(([_, v]) => v?.value != null).length,
      filteredNonNull: Object.entries(filtered).filter(([_, v]) => v?.value != null).length,
      raw: raw1B,
      filtered: Object.fromEntries(
        Object.entries(filtered).map(([k, v]) => [k, { value: v.value, confidence: v.confidence }]),
      ),
    };
  },
});

// ─── Multi-Vehicle Test ──────────────────────────────────────────────

export const runMultiTest = internalAction({
  args: {},
  handler: async (ctx) => {
    const results: {
      name: string;
      engineKey: string;
      fillRate: number;
      filled: number;
      avgConf: number;
      fluids: string;
      intervals: string;
      attributes: string;
      parts: string;
      pricing: string;
      labor: string;
      timeS: number;
      error: string | null;
    }[] = [];

    for (const tv of TEST_VEHICLES) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`[MULTI] Starting: ${tv.name} (${tv.year} ${tv.make} ${tv.model})`);
      console.log(`${"=".repeat(60)}`);

      // Build engine key the same way pipeline does
      const engineKey = `${tv.year}_${tv.make}_${tv.model}_${tv.engineCode}`
        .toLowerCase()
        .replace(/\s+/g, "_");

      // Find or create vehicle
      let vehicle = await ctx.runQuery(
        internal.vehicleEnrichment.pipelineTest.findVehicleByVin,
        { vin: tv.vin },
      );
      if (!vehicle) {
        const vehicleId = await ctx.runMutation(
          internal.vehicleEnrichment.pipelineTest.createTestVehicle,
          { vin: tv.vin, year: tv.year },
        );
        vehicle = { _id: vehicleId } as any;
        console.log(`[MULTI] Created vehicle: ${vehicleId}`);
      } else {
        console.log(`[MULTI] Found vehicle: ${vehicle._id}`);
      }

      // Clear cache
      await ctx.runMutation(
        internal.vehicleEnrichment.pipelineTest.clearCacheByEngineKey,
        { engineKey },
      );

      // Run pipeline
      const startMs = Date.now();
      let error: string | null = null;
      try {
        await ctx.runAction(
          internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
          {
            vehicleId: vehicle._id,
            year: tv.year,
            make: tv.make,
            model: tv.model,
            trim: tv.trim,
            engineCode: tv.engineCode,
            displacement: tv.displacement,
          },
        );
      } catch (e) {
        error = String(e);
        console.error(`[MULTI] Pipeline error for ${tv.name}:`, error);
      }
      const timeS = Math.round((Date.now() - startMs) / 1000);

      // Query result
      const enrichment = await ctx.runQuery(
        internal.vehicleEnrichment.queries.getByEngineKey,
        { engineKey },
      );

      if (!enrichment) {
        results.push({
          name: tv.name, engineKey, fillRate: 0, filled: 0, avgConf: 0,
          fluids: "0/6", intervals: "0/12", attributes: "0/3",
          parts: "0/10", pricing: "0/6", labor: "0/4",
          timeS, error: error || "No data stored",
        });
        continue;
      }

      // Calculate metrics
      const m = calculateMetrics(enrichment);
      results.push({
        name: tv.name,
        engineKey,
        fillRate: m.overallFillRate,
        filled: m.totalFilled,
        avgConf: m.avgConfidence,
        fluids: `${m.fluids.filled}/${m.fluids.total}`,
        intervals: `${m.intervals.filled}/${m.intervals.total}`,
        attributes: `${m.attributes.filled}/${m.attributes.total}`,
        parts: `${m.parts.filled}/${m.parts.total}`,
        pricing: `${m.pricing.filled}/${m.pricing.total}`,
        labor: `${m.labor.filled}/${m.labor.total}`,
        timeS,
        error,
      });

      // Log per-vehicle field details
      console.log(`[MULTI] ${tv.name}: ${m.overallFillRate}% (${m.totalFilled}/41) in ${timeS}s`);
      for (const key of ENRICHMENT_FIELD_KEYS) {
        const f = enrichment[key as string];
        if (f?.value != null) {
          console.log(`  ${key}: ${JSON.stringify(f.value)} (conf:${f.confidence})`);
        }
      }
    }

    // ── Print comparison table ──
    console.log(`\n\n${"=".repeat(80)}`);
    console.log("MULTI-VEHICLE BENCHMARK RESULTS");
    console.log(`${"=".repeat(80)}`);
    console.log("");
    console.log("| Vehicle | Fill Rate | Fluids | Intervals | Attrs | Parts | Pricing | Labor | Time |");
    console.log("|---------|-----------|--------|-----------|-------|-------|---------|-------|------|");
    for (const r of results) {
      console.log(
        `| ${r.name} | **${r.fillRate}%** (${r.filled}/41) | ${r.fluids} | ${r.intervals} | ${r.attributes} | ${r.parts} | ${r.pricing} | ${r.labor} | ${r.timeS}s |`,
      );
    }

    // Averages
    const avgFill = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.fillRate, 0) / results.length)
      : 0;
    const avgConf = results.length > 0
      ? (results.reduce((s, r) => s + r.avgConf, 0) / results.length).toFixed(2)
      : "0";
    const avgTime = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.timeS, 0) / results.length)
      : 0;
    console.log(`| **AVERAGE** | **${avgFill}%** | — | — | — | — | — | — | ${avgTime}s |`);
    console.log("");

    // Errors
    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      console.log("ERRORS:");
      for (const r of errors) {
        console.log(`  ${r.name}: ${r.error}`);
      }
    }

    return { results, avgFillRate: avgFill, avgConfidence: avgConf, avgTimeS: avgTime };
  },
});

// ─── Metrics ────────────────────────────────────────────────────────

interface CategoryMetrics {
  filled: number;
  total: number;
  details: { key: string; value: any; confidence: number | null; source: string | null; verified: boolean }[];
}

interface AllMetrics {
  overallFillRate: number;
  totalFilled: number;
  avgConfidence: number;
  partsConfidence: number;
  fluids: CategoryMetrics;
  intervals: CategoryMetrics;
  attributes: CategoryMetrics;
  parts: CategoryMetrics;
  pricing: CategoryMetrics;
  labor: CategoryMetrics;
}

function getField(enrichment: any, key: string): FieldResult | null {
  const field = enrichment[key];
  if (!field || typeof field !== "object") return null;
  return field as FieldResult;
}

function categoryMetrics(enrichment: any, fieldKeys: string[]): CategoryMetrics {
  const details: CategoryMetrics["details"] = [];
  let filled = 0;
  for (const key of fieldKeys) {
    const field = getField(enrichment, key);
    const hasValue = field && field.value != null;
    if (hasValue) filled++;
    details.push({
      key,
      value: field?.value ?? null,
      confidence: field?.confidence ?? null,
      source: field?.source ?? null,
      verified: field?.verified ?? false,
    });
  }
  return { filled, total: fieldKeys.length, details };
}

function calculateMetrics(enrichment: any): AllMetrics {
  const fluids = categoryMetrics(enrichment, FLUIDS_FIELDS);
  const intervals = categoryMetrics(enrichment, INTERVALS_FIELDS);
  const attributes = categoryMetrics(enrichment, ATTRIBUTES_FIELDS);
  const parts = categoryMetrics(enrichment, PARTS_FIELDS);
  const pricing = categoryMetrics(enrichment, PRICING_FIELDS);
  const labor = categoryMetrics(enrichment, LABOR_FIELDS);

  const totalFilled = fluids.filled + intervals.filled + attributes.filled +
    parts.filled + pricing.filled + labor.filled;
  const overallFillRate = Math.round((totalFilled / ENRICHMENT_FIELD_KEYS.length) * 100);

  let confSum = 0, confCount = 0, partsConfSum = 0, partsConfCount = 0;
  for (const key of ENRICHMENT_FIELD_KEYS) {
    const field = getField(enrichment, key as string);
    if (field?.value != null && typeof field.confidence === "number") {
      confSum += field.confidence;
      confCount++;
      if (PARTS_FIELDS.includes(key as string)) {
        partsConfSum += field.confidence;
        partsConfCount++;
      }
    }
  }

  return {
    overallFillRate,
    totalFilled,
    avgConfidence: confCount > 0 ? Number((confSum / confCount).toFixed(2)) : 0,
    partsConfidence: partsConfCount > 0 ? Number((partsConfSum / partsConfCount).toFixed(2)) : 0,
    fluids, intervals, attributes, parts, pricing, labor,
  };
}

// ─── Markdown Report Generator ──────────────────────────────────────

function generateMarkdownReport(enrichment: any, totalTimeMs: number, error: string | null): string {
  const m = calculateMetrics(enrichment);
  const now = new Date().toISOString().split("T")[0];
  const timeStr = totalTimeMs < 120000
    ? `${(totalTimeMs / 1000).toFixed(0)}s`
    : `${(totalTimeMs / 60000).toFixed(1)} min`;
  const sourceUrls: string[] = enrichment.sourceUrls ?? [];

  const lines: string[] = [];
  const L = (s: string) => lines.push(s);

  L(`# v3 Hybrid Pipeline — Test Report`);
  L(``);
  L(`**Date**: ${now}`);
  L(`**Vehicle**: 2020 BMW M550i xDrive`);
  L(`**VIN**: WBAJS7C01LBN96146`);
  L(`**Engine**: N63B44O2 (4.4L V8 Twin-Turbo)`);
  L(`**Engine Config Key**: \`${BMW_M550I.engineKey}\``);
  L(`**Pipeline**: v3 Hybrid (Firecrawl pre-gather + Claude web_search + confidence filter)`);
  if (error) { L(`**Error**: ${error}`); }
  L(``);
  L(`---`);
  L(``);

  // ── Executive Summary
  L(`## 1. Executive Summary`);
  L(``);
  L(`| Metric | v2 (Claude) | Firecrawl-Only | v3 Hybrid | Winner |`);
  L(`|--------|------------|----------------|-----------|--------|`);
  L(`| **Overall Fill Rate** | **82.8%** (33/40) | **17%** (7/40) | **${m.overallFillRate}%** (${m.totalFilled}/40) | ${m.overallFillRate > 82.8 ? "v3" : m.overallFillRate > 17 ? "v2 (v3 improved)" : "v2"} |`);
  L(`| Avg Confidence | 0.88 | 0.91* | ${m.avgConfidence} | ${m.avgConfidence > 0.88 ? "v3" : "v2"} |`);
  L(`| Parts Confidence | ~0.74 | N/A | ${m.partsConfidence || "N/A"} | ${m.partsConfidence > 0.74 ? "v3" : "v2"} |`);
  L(`| Execution Time | ~6 min | ~15s | ${timeStr} | Firecrawl |`);
  L(`| Source Citations | None | Every field | Every field | v3/FC |`);
  L(`| Web Searches | 23+ | 0 | ~23 (8+10+5) | v2=v3 |`);
  L(`| Source URLs | ~20 | 14 | ${sourceUrls.length} | — |`);
  L(``);
  L(`*Firecrawl avg is across only 7 filled fields.`);
  L(``);
  L(`---`);
  L(``);

  // ── Fill Rate by Category
  L(`## 2. Fill Rate by Category`);
  L(``);
  L(`| Category | v2 | Firecrawl | v3 | v3 vs v2 |`);
  L(`|----------|-----|-----------|-----|----------|`);
  L(`| Fluids (${m.fluids.total}) | 6/6 (100%) | 2/6 (33%) | ${m.fluids.filled}/${m.fluids.total} (${pct(m.fluids)}) | ${delta(m.fluids.filled, 6)} |`);
  L(`| Intervals (${m.intervals.total}) | 9/12 (75%) | 3/12 (25%) | ${m.intervals.filled}/${m.intervals.total} (${pct(m.intervals)}) | ${delta(m.intervals.filled, 9)} |`);
  L(`| Attributes (${m.attributes.total}) | 3/3 (100%) | 0/3 (0%) | ${m.attributes.filled}/${m.attributes.total} (${pct(m.attributes)}) | ${delta(m.attributes.filled, 3)} |`);
  L(`| Parts (${m.parts.total}) | 9/10 (90%) | 1/10 (10%) | ${m.parts.filled}/${m.parts.total} (${pct(m.parts)}) | ${delta(m.parts.filled, 9)} |`);
  L(`| Pricing (${m.pricing.total}) | 4/6 (67%) | 1/6 (17%) | ${m.pricing.filled}/${m.pricing.total} (${pct(m.pricing)}) | ${delta(m.pricing.filled, 4)} |`);
  L(`| Labor (${m.labor.total}) | 2/4 (50%) | 0/4 (0%) | ${m.labor.filled}/${m.labor.total} (${pct(m.labor)}) | ${delta(m.labor.filled, 2)} |`);
  L(`| **TOTAL** | **33/40 (82.8%)** | **7/40 (17%)** | **${m.totalFilled}/40 (${m.overallFillRate}%)** | **${delta(m.totalFilled, 33)}** |`);
  L(``);
  L(`---`);
  L(``);

  // ── Field-by-Field Comparison
  L(`## 3. Field-by-Field: v3 vs v2 vs Firecrawl`);
  L(``);
  L(`### 3.1 Fluids`);
  L(``);
  L(`| Field | v2 Value | Firecrawl Value | v3 Value | v3 Confidence | v3 Source |`);
  L(`|-------|----------|----------------|----------|---------------|-----------|`);
  for (const d of m.fluids.details) {
    L(`| ${d.key} | ${V2_KNOWN_VALUES[d.key] ?? "—"} | ${FIRECRAWL_KNOWN_VALUES[d.key] ?? "null"} | ${fmtVal(d.value)} | ${fmtConf(d.confidence)} | ${fmtSrc(d.source)} |`);
  }
  L(``);

  L(`### 3.2 Service Intervals`);
  L(``);
  L(`| Field | v2 Value | Firecrawl Value | v3 Value | v3 Confidence | v3 Source |`);
  L(`|-------|----------|----------------|----------|---------------|-----------|`);
  for (const d of m.intervals.details) {
    L(`| ${d.key} | ${V2_KNOWN_VALUES[d.key] ?? "—"} | ${FIRECRAWL_KNOWN_VALUES[d.key] ?? "null"} | ${fmtVal(d.value)} | ${fmtConf(d.confidence)} | ${fmtSrc(d.source)} |`);
  }
  L(``);

  L(`### 3.3 Vehicle Attributes`);
  L(``);
  L(`| Field | v2 Value | Firecrawl Value | v3 Value | v3 Confidence | v3 Source |`);
  L(`|-------|----------|----------------|----------|---------------|-----------|`);
  for (const d of m.attributes.details) {
    L(`| ${d.key} | ${V2_KNOWN_VALUES[d.key] ?? "—"} | null | ${fmtVal(d.value)} | ${fmtConf(d.confidence)} | ${fmtSrc(d.source)} |`);
  }
  L(``);

  L(`### 3.4 OEM Part Numbers`);
  L(``);
  L(`| Field | v2 Value | Firecrawl Value | v3 Value | v3 Confidence | Verified | v3 Source |`);
  L(`|-------|----------|----------------|----------|---------------|----------|-----------|`);
  for (const d of m.parts.details) {
    L(`| ${d.key} | ${V2_KNOWN_VALUES[d.key] ?? "N/A"} | ${FIRECRAWL_KNOWN_VALUES[d.key] ?? "null"} | ${fmtVal(d.value)} | ${fmtConf(d.confidence)} | ${d.verified ? "YES" : "no"} | ${fmtSrc(d.source)} |`);
  }
  L(``);

  L(`### 3.5 Pricing`);
  L(``);
  L(`| Field | v3 Value | v3 Confidence | v3 Source |`);
  L(`|-------|----------|---------------|-----------|`);
  for (const d of m.pricing.details) {
    L(`| ${d.key} | ${fmtVal(d.value)} | ${fmtConf(d.confidence)} | ${fmtSrc(d.source)} |`);
  }
  L(``);

  L(`### 3.6 Labor Estimates`);
  L(``);
  L(`| Field | v3 Value | v3 Confidence | v3 Source |`);
  L(`|-------|----------|---------------|-----------|`);
  for (const d of m.labor.details) {
    L(`| ${d.key} | ${fmtVal(d.value)} | ${fmtConf(d.confidence)} | ${fmtSrc(d.source)} |`);
  }
  L(``);
  L(`---`);
  L(``);

  // ── Confidence Distribution
  L(`## 4. Confidence Distribution`);
  L(``);
  let c10 = 0, c09 = 0, c08 = 0, c07 = 0, c06 = 0, cNull = 0;
  for (const key of ENRICHMENT_FIELD_KEYS) {
    const f = getField(enrichment, key as string);
    if (!f || f.value == null) { cNull++; continue; }
    const c = f.confidence ?? 0;
    if (c >= 0.95) c10++;
    else if (c >= 0.85) c09++;
    else if (c >= 0.75) c08++;
    else if (c >= 0.65) c07++;
    else c06++;
  }
  L(`| Confidence Range | Count | Meaning |`);
  L(`|-----------------|-------|---------|`);
  L(`| >= 0.95 (OEM source) | ${c10} | Exact value from manufacturer documentation |`);
  L(`| 0.85 - 0.94 (reputable) | ${c09} | From Edmunds, Car and Driver, official retailers |`);
  L(`| 0.75 - 0.84 (corroborated) | ${c08} | Forum/third-party with 2+ source agreement |`);
  L(`| 0.65 - 0.74 (training data) | ${c07} | Well-known spec from Claude training |`);
  L(`| 0.60 - 0.64 (uncertain) | ${c06} | Less certain, applies to model range |`);
  L(`| null (empty) | ${cNull} | Field not populated |`);
  L(``);
  L(`---`);
  L(``);

  // ── Performance
  L(`## 5. Performance`);
  L(``);
  L(`| Metric | v2 | Firecrawl | v3 |`);
  L(`|--------|-----|-----------|-----|`);
  L(`| Total Time | ~6 min | ~15s | ${timeStr} |`);
  L(`| Claude Calls | 4 | 3-5 | 3-5 |`);
  L(`| Web Searches (Claude) | 23+ | 0 | ~23 (max 8+10+5) |`);
  L(`| Firecrawl Searches | 0 | 10 | 2-3 pre-gather |`);
  L(`| Source URLs Collected | ~20 | 14 | ${sourceUrls.length} |`);
  L(`| Rate Limit Hits | 0 | 5+ | TBD (check logs) |`);
  L(``);
  L(`---`);
  L(``);

  // ── Source URLs
  L(`## 6. Source URLs (${sourceUrls.length} total)`);
  L(``);
  for (const [i, url] of sourceUrls.entries()) {
    L(`${i + 1}. ${url}`);
  }
  L(``);
  L(`---`);
  L(``);

  // ── Architecture Comparison
  L(`## 7. Architecture Comparison`);
  L(``);
  L(`| Aspect | v2 | Firecrawl-Only | v3 Hybrid |`);
  L(`|--------|-----|----------------|-----------|`);
  L(`| Data sourcing | Claude web_search (native) | Firecrawl /search → Claude extraction | Firecrawl pre-gather → Claude web_search |`);
  L(`| Training data | Allowed (no restriction) | Forbidden ("extract ONLY from sources") | Allowed with tiered confidence |`);
  L(`| Verification | Part number format regex | Strict string-match against source | Confidence threshold (>=0.6) + OEM format regex |`);
  L(`| Source truncation | None (Claude reads full pages) | 3,000 chars per source | 20,000 chars total budget |`);
  L(`| Gap fill | Sibling cross-ref + Claude retry | Sibling cross-ref + per-field retry | Sibling cross-ref + batch Claude retry |`);
  L(`| Storage | 5 normalized tables | 1 denormalized table | 1 denormalized table |`);
  L(`| Caching | None | Engine config key | Engine config key |`);
  L(`| Per-field metadata | No | Yes (source, confidence, verified) | Yes (source, confidence, verified, apiConfirmed) |`);
  L(``);
  L(`---`);
  L(``);

  // ── Verdict
  L(`## 8. Verdict`);
  L(``);
  const fillDiffV2 = m.overallFillRate - 82.8;
  const fillDiffFC = m.overallFillRate - 17;
  const confDiffV2 = m.avgConfidence - 0.88;

  L(`| Comparison | Result |`);
  L(`|-----------|--------|`);
  L(`| Fill rate vs v2 | ${fillDiffV2 >= 0 ? "HIGHER" : "LOWER"} (${fillDiffV2 >= 0 ? "+" : ""}${fillDiffV2.toFixed(1)}pp: ${m.overallFillRate}% vs 82.8%) |`);
  L(`| Fill rate vs Firecrawl | ${fillDiffFC >= 0 ? "HIGHER" : "LOWER"} (+${fillDiffFC.toFixed(1)}pp: ${m.overallFillRate}% vs 17%) |`);
  L(`| Confidence vs v2 | ${confDiffV2 >= 0 ? "HIGHER" : "LOWER"} (${confDiffV2 >= 0 ? "+" : ""}${confDiffV2.toFixed(2)}: ${m.avgConfidence} vs 0.88) |`);
  L(`| Parts found vs v2 | ${m.parts.filled}/10 vs 9/10 |`);
  L(`| Time vs v2 | ${timeStr} vs ~6 min |`);
  L(``);

  if (m.overallFillRate > 82.8) {
    L(`**v3 EXCEEDS v2 on fill rate.** The hybrid approach of pre-gathering sources + Claude web_search + confidence filtering outperforms both previous pipelines.`);
  } else if (m.overallFillRate >= 74) {
    L(`**v3 within striking distance of v2.** The hybrid approach significantly improved over Firecrawl-only (${fillDiffFC.toFixed(0)}pp gain) and approaches v2 quality while adding source citations and per-field confidence.`);
  } else if (m.overallFillRate > 17) {
    L(`**v3 improved over Firecrawl-only** (+${fillDiffFC.toFixed(0)}pp) but still below v2 (-${Math.abs(fillDiffV2).toFixed(0)}pp). Further tuning needed on prompts, confidence thresholds, or source gathering.`);
  } else {
    L(`**v3 did not improve over Firecrawl-only.** Investigate: did Claude web_search fire? Did confidence filtering reject too many fields? Check Convex logs for details.`);
  }
  L(``);

  // ── Raw JSON
  L(`---`);
  L(``);
  L(`## 9. Raw Enrichment Data`);
  L(``);
  L("```json");
  L(JSON.stringify(enrichment, null, 2));
  L("```");

  return lines.join("\n");
}

// ─── Formatting Helpers ─────────────────────────────────────────────

function fmtVal(v: any): string {
  if (v == null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function fmtConf(c: number | null): string {
  if (c == null) return "—";
  return c.toFixed(2);
}

function fmtSrc(s: string | null): string {
  if (!s) return "—";
  return s.replace(/^https?:\/\/(www\.)?/, "").split("/").slice(0, 2).join("/") || s;
}

function pct(cat: CategoryMetrics): string {
  return cat.total > 0 ? `${Math.round((cat.filled / cat.total) * 100)}%` : "0%";
}

function delta(v3: number, v2: number): string {
  const diff = v3 - v2;
  if (diff > 0) return `+${diff}`;
  if (diff < 0) return `${diff}`;
  return "=";
}

// ─── v4 Pipeline Test ───────────────────────────────────────────────

// v4 field category definitions (expanded from v3)
const V4_FLUIDS = [
  "oil_viscosity", "oil_capacity_qts", "coolant_type",
  "coolant_capacity_qts", "brake_fluid_type", "power_steering_type",
];
const V4_INTERVALS = [
  "oil_change_miles", "oil_change_months",
  "spark_plug_miles", "spark_plug_months",
  "transmission_service_miles", "transmission_service_months",
  "coolant_flush_miles", "coolant_flush_months",
  "air_filter_miles", "air_filter_months",
  "cabin_filter_miles", "cabin_filter_months",
  "brake_fluid_flush_miles", "brake_fluid_flush_months",
  "serpentine_belt_miles", "serpentine_belt_months",
  "timing_service_miles", "timing_service_months",
];
const V4_ATTRIBUTES = [
  "timing_system", "drivetrain", "turbo",
  "fuel_injection_type", "transmission_type", "power_steering_system",
];
const V4_PARTS = [
  "oil_filter_oem", "air_filter_oem", "cabin_filter_oem", "spark_plug_oem",
  "front_brake_pad_oem", "rear_brake_pad_oem", "drain_plug_gasket_oem",
  "serpentine_belt_oem", "timing_belt_oem", "wiper_blade_set_oem",
];
const V4_BATTERY = [
  "battery_group", "battery_cca", "spark_plug_quantity",
  "spark_plug_gap", "parking_brake_type",
];
const V4_TRIM = [
  "front_tire_size", "rear_tire_size",
  "tire_pressure_front_psi", "tire_pressure_rear_psi",
  "lug_nut_torque_ft_lbs", "front_wiper_size", "rear_wiper_size",
];
const V4_PRICING = [
  "oil_change_price", "brake_pad_front_price", "brake_pad_rear_price",
  "spark_plug_price", "air_filter_price", "cabin_filter_price",
];
const V4_LABOR = [
  "estimated_labor_oil_change_hrs", "estimated_labor_brake_front_hrs",
  "estimated_labor_brake_rear_hrs", "estimated_labor_spark_plug_hrs",
];

export const runV4Test = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("[V4-TEST] Starting v4 pipeline test for BMW M550i...");

    // Build the v4 engine key (includes trim)
    const v4EngineKey = buildV4EngineKey({
      vehicleId: "test",
      year: BMW_M550I.year,
      make: BMW_M550I.make,
      model: BMW_M550I.model,
      trim: BMW_M550I.trim,
      engineCode: BMW_M550I.engineCode,
      displacement: BMW_M550I.displacement,
    });
    console.log(`[V4-TEST] v4 engine key: ${v4EngineKey}`);

    // Step 1: Find or create test vehicle
    let vehicle = await ctx.runQuery(
      internal.vehicleEnrichment.pipelineTest.findVehicleByVin,
      { vin: BMW_M550I.vin },
    );
    if (!vehicle) {
      const vehicleId = await ctx.runMutation(
        internal.vehicleEnrichment.pipelineTest.createTestVehicle,
        { vin: BMW_M550I.vin, year: BMW_M550I.year },
      );
      vehicle = { _id: vehicleId } as any;
      console.log(`[V4-TEST] Created test vehicle: ${vehicleId}`);
    } else {
      console.log(`[V4-TEST] Found existing vehicle: ${vehicle._id}`);
    }

    // Step 2: Clear cache (both v3 and v4 keys)
    const v3Clear = await ctx.runMutation(
      internal.vehicleEnrichment.pipelineTest.clearCacheByEngineKey,
      { engineKey: BMW_M550I.engineKey },
    );
    const v4Clear = await ctx.runMutation(
      internal.vehicleEnrichment.pipelineTest.clearCacheByEngineKey,
      { engineKey: v4EngineKey },
    );
    console.log(`[V4-TEST] Cache cleared: v3=${v3Clear.deleted}, v4=${v4Clear.deleted}`);

    // Step 3: Run v4 pipeline
    console.log("[V4-TEST] Running v4 pipeline...");
    const startMs = Date.now();
    let pipelineResult: any;
    let pipelineError: string | null = null;

    try {
      pipelineResult = await ctx.runAction(
        internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
        {
          vehicleId: vehicle._id,
          year: BMW_M550I.year,
          make: BMW_M550I.make,
          model: BMW_M550I.model,
          trim: BMW_M550I.trim,
          engineCode: BMW_M550I.engineCode,
          displacement: BMW_M550I.displacement,
        },
      );
    } catch (error) {
      pipelineError = String(error);
      pipelineResult = { status: "error" };
      console.error("[V4-TEST] Pipeline error:", pipelineError);
    }

    const totalTimeMs = Date.now() - startMs;
    console.log(`[V4-TEST] Pipeline finished in ${(totalTimeMs / 1000).toFixed(1)}s`);
    console.log(`[V4-TEST] Pipeline result:`, JSON.stringify(pipelineResult));

    // Step 4: Query stored enrichment by v4 key
    const enrichment = await ctx.runQuery(
      internal.vehicleEnrichment.queries.getByEngineKey,
      { engineKey: v4EngineKey },
    );

    if (!enrichment) {
      console.error("[V4-TEST] No enrichment data found for key:", v4EngineKey);
      return { status: "error", message: "No enrichment stored", v4EngineKey };
    }

    // Step 5: Log comprehensive field-by-field results
    console.log(`\n${"=".repeat(80)}`);
    console.log("V4 PIPELINE RESULTS — BMW M550i");
    console.log(`${"=".repeat(80)}\n`);

    const logCategory = (name: string, keys: string[]) => {
      let filled = 0;
      console.log(`\n── ${name} ──`);
      for (const key of keys) {
        const f = enrichment[key];
        const hasValue = f && f.value != null;
        if (hasValue) filled++;
        const v2Val = V2_KNOWN_VALUES[key] ?? "—";
        const v4Val = hasValue ? JSON.stringify(f.value) : "null";
        const conf = f?.confidence != null ? f.confidence.toFixed(2) : "—";
        const src = f?.source ? fmtSrc(f.source) : "—";
        console.log(`  ${key}: ${v4Val} (conf:${conf}) [v2:${v2Val}] src:${src}`);
      }
      console.log(`  → ${filled}/${keys.length} filled`);
      return { filled, total: keys.length };
    };

    const fluids = logCategory("FLUIDS", V4_FLUIDS);
    const intervals = logCategory("INTERVALS", V4_INTERVALS);
    const attrs = logCategory("ATTRIBUTES", V4_ATTRIBUTES);
    const parts = logCategory("OEM PARTS", V4_PARTS);
    const battery = logCategory("BATTERY & ELECTRICAL", V4_BATTERY);
    const trim = logCategory("TRIM SPECS", V4_TRIM);
    const pricing = logCategory("PRICING", V4_PRICING);
    const labor = logCategory("LABOR", V4_LABOR);

    const totalFilled = fluids.filled + intervals.filled + attrs.filled +
      parts.filled + battery.filled + trim.filled + pricing.filled + labor.filled;
    const totalFields = V4_FIELD_KEYS.length;
    const fillRate = Math.round((totalFilled / totalFields) * 100);

    // Confidence distribution
    let confSum = 0, confCount = 0;
    let confBuckets = { high: 0, medium: 0, low: 0, empty: 0 };
    for (const key of V4_FIELD_KEYS) {
      const f = enrichment[key as string];
      if (!f || f.value == null) { confBuckets.empty++; continue; }
      const c = f.confidence ?? 0;
      confSum += c;
      confCount++;
      if (c >= 0.85) confBuckets.high++;
      else if (c >= 0.7) confBuckets.medium++;
      else confBuckets.low++;
    }
    const avgConf = confCount > 0 ? (confSum / confCount).toFixed(2) : "0";

    // Call log
    const callLog = enrichment.callLog ?? [];
    console.log(`\n── CALL LOG ──`);
    for (const call of callLog) {
      console.log(`  ${call.call}: ${call.tokensIn}in/${call.tokensOut}out, ${call.webSearches} searches, ${(call.durationMs / 1000).toFixed(1)}s`);
    }

    // Summary
    console.log(`\n${"=".repeat(80)}`);
    console.log(`SUMMARY`);
    console.log(`${"=".repeat(80)}`);
    console.log(`  Fill Rate: ${fillRate}% (${totalFilled}/${totalFields})`);
    console.log(`  Avg Confidence: ${avgConf}`);
    console.log(`  Confidence Distribution: high(>=0.85)=${confBuckets.high} medium(0.7-0.84)=${confBuckets.medium} low(<0.7)=${confBuckets.low} empty=${confBuckets.empty}`);
    console.log(`  Total Time: ${(totalTimeMs / 1000).toFixed(0)}s`);
    console.log(`  Source URLs: ${(enrichment.sourceUrls ?? []).length}`);
    console.log(`  Enrichment Version: ${enrichment.enrichmentVersion ?? "unknown"}`);
    console.log(`  Sanity Flags: ${pipelineResult?.sanityFlags ?? "N/A"}`);

    // Category breakdown for comparison table
    console.log(`\n  BY CATEGORY:`);
    console.log(`  Fluids: ${fluids.filled}/${fluids.total}`);
    console.log(`  Intervals: ${intervals.filled}/${intervals.total}`);
    console.log(`  Attributes: ${attrs.filled}/${attrs.total}`);
    console.log(`  OEM Parts: ${parts.filled}/${parts.total}`);
    console.log(`  Battery/Elec: ${battery.filled}/${battery.total}`);
    console.log(`  Trim Specs: ${trim.filled}/${trim.total}`);
    console.log(`  Pricing: ${pricing.filled}/${pricing.total}`);
    console.log(`  Labor: ${labor.filled}/${labor.total}`);

    return {
      status: pipelineResult?.status ?? "unknown",
      v4EngineKey,
      fillRate,
      totalFilled,
      totalFields,
      avgConfidence: Number(avgConf),
      totalTimeMs,
      categories: {
        fluids: `${fluids.filled}/${fluids.total}`,
        intervals: `${intervals.filled}/${intervals.total}`,
        attributes: `${attrs.filled}/${attrs.total}`,
        parts: `${parts.filled}/${parts.total}`,
        battery: `${battery.filled}/${battery.total}`,
        trim: `${trim.filled}/${trim.total}`,
        pricing: `${pricing.filled}/${pricing.total}`,
        labor: `${labor.filled}/${labor.total}`,
      },
      sanityFlags: pipelineResult?.sanityFlags ?? 0,
      error: pipelineError,
    };
  },
});
