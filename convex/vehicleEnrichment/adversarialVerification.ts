/**
 * vehicleEnrichment/adversarialVerification.ts — Task 26: Adversarial Self-Verification
 *
 * Second-pass challenge on enriched data. After Tier 1 enrichment fills a vehicle
 * config, this action:
 *   1. Gathers the config's engine, trim, and interval data
 *   2. Pre-screens values using physical plausibility checks and Z-scores
 *   3. Challenges suspicious values with a focused Haiku call
 *   4. Corrects or confirms values, updating confidence in enrichment_evidence
 *
 * Catches hallucinations like "12 quarts oil capacity for a 2.0L 4-cylinder"
 * before they become trusted data at scale.
 *
 * Cost: ~$0.01 per config (single Haiku call, no web search needed)
 * Triggered: As Hook 5 in _pollBatch2V3, scheduled async via ctx.scheduler.runAfter
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./utils/batchClient";

// ─── Suspicion Thresholds ────────────────────────────────────────

/** Z-score threshold for statistical suspicion (lower than anomaly detection's 2.5) */
const Z_SUSPECT_THRESHOLD = 2.0;
const MIN_SAMPLE_SIZE = 3;

/**
 * Physical plausibility ranges for engine/trim fields.
 * Values outside these ranges are ALWAYS challenged, regardless of Z-score.
 * Derived from real-world automotive data across all common vehicle classes.
 */
const PLAUSIBILITY_RANGES: Record<string, { min: number; max: number; unit: string }> = {
  // Engine specs
  oil_capacity_qts: { min: 2.5, max: 16, unit: "quarts" },
  coolant_capacity_qts: { min: 4, max: 32, unit: "quarts" },
  spark_plug_quantity: { min: 2, max: 16, unit: "plugs" },
  spark_plug_gap_mm: { min: 0.5, max: 1.8, unit: "mm" },
  // Trim specs
  recommended_tire_pressure_front_psi: { min: 26, max: 50, unit: "psi" },
  recommended_tire_pressure_rear_psi: { min: 26, max: 50, unit: "psi" },
  lug_nut_torque_ft_lbs: { min: 65, max: 180, unit: "ft-lbs" },
  battery_cca: { min: 300, max: 1200, unit: "CCA" },
  // Service intervals
  interval_miles_oil_change: { min: 3000, max: 20000, unit: "miles" },
  interval_miles_brake_pads: { min: 15000, max: 80000, unit: "miles" },
  interval_miles_tire_rotation: { min: 3000, max: 10000, unit: "miles" },
  interval_miles_air_filter: { min: 10000, max: 50000, unit: "miles" },
};

/**
 * Displacement-based oil capacity expectations.
 * A 2.0L engine having 12 quarts of oil is physically wrong.
 */
const OIL_CAP_BY_DISPLACEMENT: Array<{ maxDisplacement: number; maxOilQts: number }> = [
  { maxDisplacement: 2.0, maxOilQts: 6 },
  { maxDisplacement: 3.0, maxOilQts: 8 },
  { maxDisplacement: 4.0, maxOilQts: 10 },
  { maxDisplacement: 5.0, maxOilQts: 12 },
  { maxDisplacement: 7.0, maxOilQts: 16 },
];

/**
 * Cylinder count to spark plug quantity check.
 * Most engines have 1 plug per cylinder (some HEMI have 2).
 */
const SPARK_PLUGS_BY_CYLINDERS: Record<number, { min: number; max: number }> = {
  3: { min: 3, max: 3 },
  4: { min: 4, max: 4 },
  5: { min: 5, max: 5 },
  6: { min: 6, max: 6 },
  8: { min: 8, max: 16 }, // HEMI has 2 per cylinder
  10: { min: 10, max: 10 },
  12: { min: 12, max: 12 },
};

// ─── Types ───────────────────────────────────────────────────────

interface SuspiciousValue {
  field: string;
  table: "engine" | "trim_spec" | "interval";
  currentValue: number | string;
  reason: string;
  serviceSlug?: string;
  /** If we have population stats, include them */
  populationMean?: number;
  populationStdDev?: number;
  zScore?: number;
}

interface VerificationResult {
  field: string;
  table: "engine" | "trim_spec" | "interval";
  originalValue: number | string;
  verifiedValue: number | string | null;
  action: "confirmed" | "corrected" | "nullified";
  confidence: number;
  reasoning: string;
  serviceSlug?: string;
}

// ─── Suspicion Detection ─────────────────────────────────────────

function calcStats(values: number[]): { mean: number; stdDev: number } | null {
  if (values.length < MIN_SAMPLE_SIZE) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  return { mean, stdDev };
}

// ─── Queries ─────────────────────────────────────────────────────

/**
 * Gather all data needed for adversarial verification of a single config.
 * Pulls the config's own data plus population data for Z-score comparison.
 */
export const gatherVerificationData = internalQuery({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicle_config_id);
    if (!config) return null;

    const engine = (config as any).engine_id ? await ctx.db.get((config as any).engine_id as Id<"engines">) : null;

    const trimSpec = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .first();

    const intervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();

    const services = await ctx.db.query("services").collect();

    // Population data for Z-scores
    const allEngines = await ctx.db.query("engines").collect();
    const allIntervals = await ctx.db.query("service_intervals").collect();

    return { config, engine, trimSpec, intervals, services, allEngines, allIntervals };
  },
});

// ─── Mutations ───────────────────────────────────────────────────

/**
 * Write verification results to enrichment_evidence and optionally correct values.
 */
export const writeVerificationResults = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    engine_id: v.optional(v.id("engines")),
    results: v.array(v.object({
      field: v.string(),
      table: v.string(),
      originalValue: v.string(),
      verifiedValue: v.optional(v.string()),
      action: v.string(),
      confidence: v.float64(),
      reasoning: v.string(),
      serviceSlug: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let corrections = 0;
    let confirmations = 0;
    let nullifications = 0;

    for (const result of args.results) {
      // Write evidence record for the verification
      await ctx.db.insert("enrichment_evidence", {
        entity_type: result.table === "engine" ? "engine" : "vehicle_config",
        entity_id: String(
          result.table === "engine" && args.engine_id
            ? args.engine_id
            : args.vehicle_config_id
        ),
        field_name: `verified:${result.field}${result.serviceSlug ? `:${result.serviceSlug}` : ""}`,
        observed_value: result.verifiedValue ?? String(result.originalValue),
        observed_type: typeof result.originalValue === "string" && isNaN(Number(result.originalValue))
          ? "string"
          : "number",
        source_type: "adversarial_verification",
        confidence: result.confidence,
        source_url: `action=${result.action}, reason=${result.reasoning}`,
        observed_at: now,
        is_latest: true,
        created_at: now,
      });

      // Apply corrections to actual data tables
      if (result.action === "corrected" && result.verifiedValue != null) {
        const numVal = Number(result.verifiedValue);
        const isNumeric = !isNaN(numVal);

        if (result.table === "engine" && args.engine_id) {
          const enginePatchFields: Record<string, number | string | undefined> = {};
          if (isNumeric) {
            enginePatchFields[result.field] = numVal;
          } else {
            enginePatchFields[result.field] = result.verifiedValue;
          }
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchEngine, {
            engine_id: args.engine_id,
            ...enginePatchFields,
          } as any);
        } else if (result.table === "trim_spec") {
          const trimPatchFields: Record<string, number | string | undefined> = {};
          if (isNumeric) {
            trimPatchFields[result.field] = numVal;
          } else {
            trimPatchFields[result.field] = result.verifiedValue;
          }
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.patchTrimSpecs, {
            vehicle_config_id: args.vehicle_config_id,
            ...trimPatchFields,
          } as any);
        }
        // Service interval corrections would need a dedicated mutation — skip for now
        corrections++;
      } else if (result.action === "nullified" && result.table === "engine" && args.engine_id) {
        // Null out the bad value
        await ctx.db.patch(args.engine_id, { [result.field]: undefined } as any);
        nullifications++;
      } else {
        confirmations++;
      }
    }

    console.log(
      `[adversarial] Wrote ${args.results.length} verification results: ` +
      `${confirmations} confirmed, ${corrections} corrected, ${nullifications} nullified`
    );

    return { confirmations, corrections, nullifications };
  },
});

// ─── Prompt ──────────────────────────────────────────────────────

const VERIFICATION_SYSTEM = `You are an automotive data quality auditor. You will receive a vehicle description and a list of data values that look suspicious.

For each suspicious value, determine ONE of:
- "confirmed": The value is actually correct despite looking unusual (provide reasoning)
- "corrected": The value is wrong. Provide the correct value based on your knowledge
- "nullified": The value is definitely wrong but you don't know the correct value

IMPORTANT RULES:
- Be conservative: only correct values you are CONFIDENT are wrong
- "confirmed" is valid — some vehicles genuinely have unusual specs (AMG, diesel, rotary)
- For "corrected", provide the exact correct value, not a range
- For service intervals, consider the OEM recommendation, not aftermarket advice
- Never guess — if unsure, use "confirmed" (benefit of the doubt)

Return ONLY valid JSON array. No explanation, no markdown fences, just the JSON array.`;

function buildVerificationPrompt(
  vehicleDesc: string,
  suspects: SuspiciousValue[],
): string {
  const suspectLines = suspects.map((s, i) => {
    let line = `${i + 1}. Field: "${s.field}" (${s.table})`;
    line += `\n   Current value: ${s.currentValue}`;
    line += `\n   Flagged because: ${s.reason}`;
    if (s.populationMean != null && s.populationStdDev != null) {
      line += `\n   Population: mean=${s.populationMean.toFixed(2)}, stdDev=${s.populationStdDev.toFixed(2)}, Z=${s.zScore?.toFixed(2) ?? "?"}`;
    }
    if (s.serviceSlug) {
      line += `\n   Service: ${s.serviceSlug}`;
    }
    return line;
  }).join("\n\n");

  return `Vehicle: ${vehicleDesc}

The following ${suspects.length} value(s) were flagged as potentially incorrect during quality review:

${suspectLines}

For each flagged value, return a JSON array with objects matching this schema:
[
  {
    "field": "field_name",
    "action": "confirmed" | "corrected" | "nullified",
    "verified_value": <correct value if "corrected", else original value>,
    "confidence": <0.0-1.0>,
    "reasoning": "brief explanation"
  }
]

Return exactly ${suspects.length} objects, one per flagged value, in the same order.`;
}

// ─── Main Action ─────────────────────────────────────────────────

export const runAdversarialVerification = internalAction({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    // 1. Gather data
    const data = await ctx.runQuery(
      internal.vehicleEnrichment.adversarialVerification.gatherVerificationData,
      { vehicle_config_id: args.vehicle_config_id },
    );

    if (!data) {
      console.log("[adversarial] Config not found");
      return { status: "error", reason: "config_not_found" };
    }

    const { config, engine, trimSpec, intervals, services, allEngines, allIntervals } = data as any;

    const vehicleDesc = `${config.year} ${config.trim_name ?? "Unknown"} (${
      engine?.displacement_l ?? "?"
    }L ${engine?.cylinders ?? "?"}cyl, ${engine?.engine_code ?? "?"}, ${config.drivetrain ?? "?"})`;

    // 2. Pre-screen for suspicious values
    const suspects: SuspiciousValue[] = [];
    const serviceMap = new Map<string, string>(services.map((s: any) => [String(s._id), s.slug]));

    // --- Engine checks ---
    if (engine) {
      // Oil capacity vs displacement
      if (engine.oil_capacity_qts != null && engine.displacement_l != null) {
        const displacementRule = OIL_CAP_BY_DISPLACEMENT.find(
          (r) => engine.displacement_l <= r.maxDisplacement
        );
        if (displacementRule && engine.oil_capacity_qts > displacementRule.maxOilQts) {
          suspects.push({
            field: "oil_capacity_qts",
            table: "engine",
            currentValue: engine.oil_capacity_qts,
            reason: `Oil capacity ${engine.oil_capacity_qts} qts exceeds expected max ${displacementRule.maxOilQts} qts for a ${engine.displacement_l}L engine`,
          });
        }
      }

      // Spark plugs vs cylinder count
      if (engine.spark_plug_quantity != null && engine.cylinders != null) {
        const plugRange = SPARK_PLUGS_BY_CYLINDERS[engine.cylinders as number];
        if (plugRange) {
          if (engine.spark_plug_quantity < plugRange.min || engine.spark_plug_quantity > plugRange.max) {
            suspects.push({
              field: "spark_plug_quantity",
              table: "engine",
              currentValue: engine.spark_plug_quantity,
              reason: `${engine.spark_plug_quantity} spark plugs for a ${engine.cylinders}-cylinder engine (expected ${plugRange.min}-${plugRange.max})`,
            });
          }
        }
      }

      // General plausibility checks for numeric engine fields
      const engineNumericFields = [
        "oil_capacity_qts", "coolant_capacity_qts", "spark_plug_quantity", "spark_plug_gap_mm",
      ];
      for (const field of engineNumericFields) {
        const val = (engine as any)[field];
        if (val == null) continue;

        // Skip if already flagged by a more specific check above
        if (suspects.some((s) => s.field === field && s.table === "engine")) continue;

        const range = PLAUSIBILITY_RANGES[field];
        if (range && (val < range.min || val > range.max)) {
          suspects.push({
            field,
            table: "engine",
            currentValue: val,
            reason: `Value ${val} ${range.unit} is outside plausible range [${range.min}-${range.max}]`,
          });
        }
      }

      // Z-score checks against population of engines
      const engineZFields = ["oil_capacity_qts", "coolant_capacity_qts", "spark_plug_quantity"];
      for (const field of engineZFields) {
        const val = (engine as any)[field];
        if (val == null) continue;
        if (suspects.some((s) => s.field === field && s.table === "engine")) continue;

        const populationValues = allEngines
          .map((e: any) => e[field])
          .filter((v: any) => v != null) as number[];
        const stats = calcStats(populationValues);
        if (!stats) continue;

        const z = (val - stats.mean) / stats.stdDev;
        if (Math.abs(z) > Z_SUSPECT_THRESHOLD) {
          suspects.push({
            field,
            table: "engine",
            currentValue: val,
            reason: `Statistical outlier: Z-score ${z.toFixed(2)} (threshold: ${Z_SUSPECT_THRESHOLD})`,
            populationMean: stats.mean,
            populationStdDev: stats.stdDev,
            zScore: z,
          });
        }
      }
    }

    // --- Trim spec checks ---
    if (trimSpec) {
      const trimNumericFields = [
        "recommended_tire_pressure_front_psi",
        "recommended_tire_pressure_rear_psi",
        "lug_nut_torque_ft_lbs",
        "battery_cca",
      ];
      for (const field of trimNumericFields) {
        const val = (trimSpec as any)[field];
        if (val == null) continue;

        const range = PLAUSIBILITY_RANGES[field];
        if (range && (val < range.min || val > range.max)) {
          suspects.push({
            field,
            table: "trim_spec",
            currentValue: val,
            reason: `Value ${val} ${range.unit} is outside plausible range [${range.min}-${range.max}]`,
          });
        }
      }
    }

    // --- Service interval checks ---
    for (const si of intervals) {
      if (si.interval_miles == null || si.data_quality === "default_fallback") continue;
      const slug = serviceMap.get(String(si.service_id));
      if (!slug) continue;

      const rangeKey = `interval_miles_${slug}`;
      const range = PLAUSIBILITY_RANGES[rangeKey];
      if (range && (si.interval_miles < range.min || si.interval_miles > range.max)) {
        suspects.push({
          field: "interval_miles",
          table: "interval",
          currentValue: si.interval_miles,
          reason: `${slug}: ${si.interval_miles} miles is outside plausible range [${range.min}-${range.max}]`,
          serviceSlug: slug,
        });
      }

      // Z-score check for this service across all configs
      const sameServiceIntervals = allIntervals
        .filter((i: any) => String(i.service_id) === String(si.service_id) && i.interval_miles != null && i.data_quality !== "default_fallback")
        .map((i: any) => i.interval_miles) as number[];
      const stats = calcStats(sameServiceIntervals);
      if (!stats) continue;

      // Skip if already flagged by plausibility
      if (suspects.some((s) => s.field === "interval_miles" && s.serviceSlug === slug)) continue;

      const z = (si.interval_miles - stats.mean) / stats.stdDev;
      if (Math.abs(z) > Z_SUSPECT_THRESHOLD) {
        suspects.push({
          field: "interval_miles",
          table: "interval",
          currentValue: si.interval_miles,
          reason: `${slug}: Statistical outlier Z=${z.toFixed(2)} (mean=${stats.mean.toFixed(0)} miles)`,
          serviceSlug: slug,
          populationMean: stats.mean,
          populationStdDev: stats.stdDev,
          zScore: z,
        });
      }
    }

    // 3. If nothing suspicious, log and exit
    if (suspects.length === 0) {
      console.log(`[adversarial] ${vehicleDesc} — all values within expected ranges, no challenge needed`);
      return { status: "clean", vehicle: vehicleDesc, suspects_found: 0 };
    }

    console.log(`[adversarial] ${vehicleDesc} — ${suspects.length} suspicious value(s) found, challenging with Haiku`);

    // 4. Challenge with Haiku
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: "error", reason: "no_api_key" };

    const client = new Anthropic({ apiKey });

    try {
      const message = await client.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 4096,
        temperature: 0,
        system: VERIFICATION_SYSTEM,
        messages: [{ role: "user", content: buildVerificationPrompt(vehicleDesc, suspects) }],
      });

      // Extract text
      let rawText = "";
      for (const block of message.content ?? []) {
        if (block.type === "text") rawText += block.text;
      }

      const tokensIn = (message as any).usage?.input_tokens ?? 0;
      const tokensOut = (message as any).usage?.output_tokens ?? 0;
      console.log(`[adversarial] Haiku response: ${tokensIn} in / ${tokensOut} out`);

      // 5. Parse response
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn("[adversarial] Could not extract JSON array from response");
        return { status: "error", reason: "no_json_in_response", raw: rawText.substring(0, 200) };
      }

      let verdicts: Array<{
        field: string;
        action: "confirmed" | "corrected" | "nullified";
        verified_value: number | string | null;
        confidence: number;
        reasoning: string;
      }>;
      try {
        verdicts = JSON.parse(jsonMatch[0]);
      } catch {
        console.warn("[adversarial] Invalid JSON in response");
        return { status: "error", reason: "invalid_json" };
      }

      // 6. Map verdicts back to suspects and build results
      const results: Array<{
        field: string;
        table: string;
        originalValue: string;
        verifiedValue?: string;
        action: string;
        confidence: number;
        reasoning: string;
        serviceSlug?: string;
      }> = [];

      for (let i = 0; i < suspects.length; i++) {
        const suspect = suspects[i];
        const verdict = verdicts[i];
        if (!verdict) continue;

        // Validate action
        const action = ["confirmed", "corrected", "nullified"].includes(verdict.action)
          ? verdict.action
          : "confirmed";

        // Clamp confidence
        const confidence = Math.max(0, Math.min(1, verdict.confidence ?? 0.5));

        results.push({
          field: suspect.field,
          table: suspect.table,
          originalValue: String(suspect.currentValue),
          verifiedValue: verdict.action === "corrected" && verdict.verified_value != null
            ? String(verdict.verified_value)
            : undefined,
          action,
          confidence,
          reasoning: verdict.reasoning ?? "No reasoning provided",
          serviceSlug: suspect.serviceSlug,
        });
      }

      // 7. Write results and apply corrections
      if (results.length > 0) {
        const writeResult = await ctx.runMutation(
          internal.vehicleEnrichment.adversarialVerification.writeVerificationResults,
          {
            vehicle_config_id: args.vehicle_config_id,
            engine_id: engine?._id,
            results,
          },
        );

        console.log(
          `[adversarial] COMPLETE: ${vehicleDesc} — ${results.length} values checked, ` +
          `${(writeResult as any).corrections} corrected, ${(writeResult as any).nullifications} nullified, ` +
          `${(writeResult as any).confirmations} confirmed`
        );

        return {
          status: "ok",
          vehicle: vehicleDesc,
          suspects_found: suspects.length,
          results: results.map((r) => ({
            field: r.field,
            action: r.action,
            original: r.originalValue,
            verified: r.verifiedValue ?? r.originalValue,
          })),
          tokens_in: tokensIn,
          tokens_out: tokensOut,
        };
      }

      return { status: "ok", vehicle: vehicleDesc, suspects_found: 0 };
    } catch (e: any) {
      console.error("[adversarial] Haiku call failed:", e);
      return { status: "error", reason: e.message };
    }
  },
});
