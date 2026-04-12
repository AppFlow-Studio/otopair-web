/**
 * vehicleEnrichment/testHarness.ts — Lightweight test runner for Tasks 21, 25, 27, 29.
 *
 * Wraps internal mutations/queries into actions so they can be invoked via MCP run_action.
 * DELETE THIS FILE after testing is complete.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

// ─── Task 21: ensureAllServiceIntervals ─────────────────────────

export const testTask21 = internalAction({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    console.log("[test] Running Task 21: ensureAllServiceIntervals...");

    // Count intervals before
    const before = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getServiceIntervals,
      { vehicleConfigId: args.vehicle_config_id }
    );

    const result = await ctx.runMutation(
      internal.vehicleEnrichment.v3mutations.ensureAllServiceIntervals,
      { vehicle_config_id: args.vehicle_config_id }
    );

    // Count intervals after
    const after = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getServiceIntervals,
      { vehicleConfigId: args.vehicle_config_id }
    );

    console.log(`[test] Task 21 result: ${JSON.stringify(result)}`);
    console.log(`[test] Intervals: ${(before as any[]).length} before → ${(after as any[]).length} after`);

    return {
      task: "Task 21: ensureAllServiceIntervals",
      result,
      intervals_before: (before as any[]).length,
      intervals_after: (after as any[]).length,
    };
  },
});

// ─── Task 25: diagnoseFillGaps ──────────────────────────────────

export const testTask25 = internalAction({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    console.log("[test] Running Task 25: diagnoseFillGaps...");

    const gaps = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.diagnoseFillGaps,
      { vehicle_config_id: args.vehicle_config_id }
    );

    console.log(`[test] Task 25 gaps: ${JSON.stringify(gaps)}`);

    return {
      task: "Task 25: diagnoseFillGaps",
      gaps,
    };
  },
});

// ─── Task 27: runAnomalyDetection ───────────────────────────────

export const testTask27 = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("[test] Running Task 27: runAnomalyDetection...");

    const result = await ctx.runAction(
      internal.vehicleEnrichment.anomalyDetection.runAnomalyDetection,
      {}
    );

    console.log(`[test] Task 27 result: ${JSON.stringify(result)}`);

    return {
      task: "Task 27: runAnomalyDetection",
      result,
    };
  },
});

// ─── Task 29: runBatchConsensus ─────────────────────────────────

export const testTask29 = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("[test] Running Task 29: runBatchConsensus...");

    const result = await ctx.runAction(
      internal.vehicleEnrichment.evidenceConsensus.runBatchConsensus,
      {}
    );

    console.log(`[test] Task 29 result: ${JSON.stringify(result)}`);

    return {
      task: "Task 29: runBatchConsensus",
      result,
    };
  },
});
