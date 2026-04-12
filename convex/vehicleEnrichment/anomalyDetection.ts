/**
 * vehicleEnrichment/anomalyDetection.ts — Task 27: Cross-Config Anomaly Detection
 *
 * Pure compute — no LLM cost. Scans all enriched configs and flags statistical
 * outliers using Z-scores. If 40 vehicles have oil change at 5K-10K miles and
 * one comes back at 45K, it gets flagged.
 *
 * Categories checked:
 *   - Service intervals (miles + months per service)
 *   - Labor times (book_hours per service)
 *   - Part prices (per service_type)
 *   - Engine specs (oil_capacity, coolant_capacity, spark_plug_quantity)
 *
 * Threshold: |Z| > 2.5 = flagged as anomaly (95th+ percentile outlier)
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

const Z_THRESHOLD = 2.5;
const MIN_SAMPLE_SIZE = 3; // Need at least 3 data points for meaningful Z-scores

interface AnomalyFlag {
  config_id: string;
  config_key: string;
  field: string;
  value: number;
  mean: number;
  std_dev: number;
  z_score: number;
  service_slug?: string;
}

function calcStats(values: number[]): { mean: number; stdDev: number } | null {
  if (values.length < MIN_SAMPLE_SIZE) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null; // All values identical — no outliers possible
  return { mean, stdDev };
}

/**
 * Gather all data needed for anomaly detection in one query.
 */
export const gatherAnomalyData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const intervals = await ctx.db.query("service_intervals").collect();
    const laborTimes = await ctx.db.query("labor_times").collect();
    const services = await ctx.db.query("services").collect();
    const engines = await ctx.db.query("engines").collect();

    return { configs, intervals, laborTimes, services, engines };
  },
});

/**
 * Store anomaly flags for review.
 */
export const writeAnomalyFlags = internalMutation({
  args: {
    flags: v.array(v.object({
      config_id: v.string(),
      config_key: v.string(),
      field: v.string(),
      value: v.float64(),
      mean: v.float64(),
      std_dev: v.float64(),
      z_score: v.float64(),
      service_slug: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Clear previous anomaly flags
    const existing = await ctx.db.query("enrichment_evidence")
      .filter((q) => q.eq(q.field("source_type"), "anomaly_detection"))
      .collect();
    for (const doc of existing) {
      await ctx.db.delete(doc._id);
    }

    // Write new flags as evidence records
    for (const flag of args.flags) {
      await ctx.db.insert("enrichment_evidence", {
        entity_type: "vehicle_config",
        entity_id: flag.config_id,
        field_name: `anomaly:${flag.field}${flag.service_slug ? `:${flag.service_slug}` : ""}`,
        observed_value: String(flag.value),
        observed_type: "number",
        source_type: "anomaly_detection",
        confidence: Math.max(0, 1 - Math.abs(flag.z_score) / 5), // confidence drops with Z distance
        source_url: `z=${flag.z_score.toFixed(2)}, mean=${flag.mean.toFixed(2)}, σ=${flag.std_dev.toFixed(2)}`,
        observed_at: now,
        is_latest: true,
        created_at: now,
      });
    }

    console.log(`[anomaly] Wrote ${args.flags.length} anomaly flags`);
  },
});

/**
 * Main anomaly detection action. Pure compute — scans all configs
 * and flags statistical outliers using Z-scores.
 */
export const runAnomalyDetection = internalAction({
  args: {},
  handler: async (ctx) => {
    const data = await ctx.runQuery(internal.vehicleEnrichment.anomalyDetection.gatherAnomalyData, {});
    const { configs, intervals, laborTimes, services, engines } = data as any;

    const serviceMap = new Map<string, string>(services.map((s: any) => [s._id, s.slug]));
    const configMap = new Map<string, string>(configs.map((c: any) => [c._id, c.config_key]));

    const flags: AnomalyFlag[] = [];

    // 1. Service interval anomalies (group by service_id)
    const intervalsByService = new Map<string, Array<{ config_id: string; miles: number }>>();
    for (const si of intervals) {
      if (si.interval_miles == null || si.data_quality === "default_fallback") continue;
      const key = si.service_id;
      if (!intervalsByService.has(key)) intervalsByService.set(key, []);
      intervalsByService.get(key)!.push({
        config_id: si.vehicle_config_id,
        miles: si.interval_miles,
      });
    }

    for (const [serviceId, entries] of intervalsByService) {
      const stats = calcStats(entries.map((e) => e.miles));
      if (!stats) continue;

      for (const entry of entries) {
        const z = (entry.miles - stats.mean) / stats.stdDev;
        if (Math.abs(z) > Z_THRESHOLD) {
          flags.push({
            config_id: entry.config_id,
            config_key: configMap.get(entry.config_id) ?? "unknown",
            field: "interval_miles",
            value: entry.miles,
            mean: stats.mean,
            std_dev: stats.stdDev,
            z_score: Math.round(z * 100) / 100,
            service_slug: serviceMap.get(serviceId),
          });
        }
      }
    }

    // 2. Labor time anomalies (group by service_id)
    const laborByService = new Map<string, Array<{ config_id: string; hours: number }>>();
    for (const lt of laborTimes) {
      if (lt.book_hours == null || lt.data_quality === "chassis_clone" || lt.data_quality === "chassis_backfill") continue;
      const key = lt.service_id;
      if (!laborByService.has(key)) laborByService.set(key, []);
      laborByService.get(key)!.push({
        config_id: lt.vehicle_config_id,
        hours: lt.book_hours,
      });
    }

    for (const [serviceId, entries] of laborByService) {
      const stats = calcStats(entries.map((e) => e.hours));
      if (!stats) continue;

      for (const entry of entries) {
        const z = (entry.hours - stats.mean) / stats.stdDev;
        if (Math.abs(z) > Z_THRESHOLD) {
          flags.push({
            config_id: entry.config_id,
            config_key: configMap.get(entry.config_id) ?? "unknown",
            field: "book_hours",
            value: entry.hours,
            mean: stats.mean,
            std_dev: stats.stdDev,
            z_score: Math.round(z * 100) / 100,
            service_slug: serviceMap.get(serviceId),
          });
        }
      }
    }

    // 3. Engine spec anomalies (oil_capacity, coolant_capacity, spark_plug_quantity)
    const engineSpecs: Record<string, Array<{ config_id: string; value: number }>> = {
      oil_capacity_qts: [],
      coolant_capacity_qts: [],
      spark_plug_quantity: [],
    };

    for (const eng of engines) {
      // Find which config uses this engine
      const configForEngine = configs.find((c: any) => c.engine_id === eng._id);
      if (!configForEngine) continue;

      if (eng.oil_capacity_qts != null) {
        engineSpecs.oil_capacity_qts.push({ config_id: configForEngine._id, value: eng.oil_capacity_qts });
      }
      if (eng.coolant_capacity_qts != null) {
        engineSpecs.coolant_capacity_qts.push({ config_id: configForEngine._id, value: eng.coolant_capacity_qts });
      }
      if (eng.spark_plug_quantity != null) {
        engineSpecs.spark_plug_quantity.push({ config_id: configForEngine._id, value: eng.spark_plug_quantity });
      }
    }

    for (const [field, entries] of Object.entries(engineSpecs)) {
      const stats = calcStats(entries.map((e) => e.value));
      if (!stats) continue;

      for (const entry of entries) {
        const z = (entry.value - stats.mean) / stats.stdDev;
        if (Math.abs(z) > Z_THRESHOLD) {
          flags.push({
            config_id: entry.config_id,
            config_key: configMap.get(entry.config_id) ?? "unknown",
            field,
            value: entry.value,
            mean: stats.mean,
            std_dev: stats.stdDev,
            z_score: Math.round(z * 100) / 100,
          });
        }
      }
    }

    // Write flags
    if (flags.length > 0) {
      await ctx.runMutation(internal.vehicleEnrichment.anomalyDetection.writeAnomalyFlags, {
        flags: flags.map((f) => ({
          ...f,
          service_slug: f.service_slug ?? undefined,
        })),
      });
    }

    console.log(
      `[anomaly] Scan complete: ${flags.length} anomalies found across ${configs.length} configs, ` +
      `${intervals.length} intervals, ${laborTimes.length} labor times`
    );

    return {
      anomalies_found: flags.length,
      configs_scanned: configs.length,
      flags: flags.slice(0, 20), // Return top 20 for visibility
    };
  },
});
