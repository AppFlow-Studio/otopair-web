// ============================================================================
// vehicleEnrichment/utils/decisionLog.ts — the pipeline's decision stream.
//
// One writer for `enrichment_decisions` (schema.ts): actions collect
// DecisionEvent objects locally and hand them to recordDecisions(ctx, …) at a
// stage boundary. Best-effort by LAW: instrumentation must never fail a run,
// so every failure path here swallows with a console.warn — exactly the
// traceStep contract. Caps keep rows small (the 200K response_text lesson);
// batches cap at 50 per mutation like the claim-ledger writer.
// ============================================================================

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";

export type DecisionEvent = {
  vehicleConfigId?: string | null;
  runId?: string | null;
  stage: string;
  decisionKey: string;
  chosen: string;
  alternatives?: string[];
  reason: string;
  evidence?: string[];
  outcome?: string;
  cost?: { tokens_in?: number; tokens_out?: number; web_searches?: number; ms?: number };
  flags?: string;
};

const REASON_CAP = 600;
const STR_CAP = 200;
const LIST_CAP = 10;
const BATCH_CAP = 50;

const cap = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const capList = (xs: unknown): string[] | undefined => {
  if (!Array.isArray(xs) || xs.length === 0) return undefined;
  return xs.slice(0, LIST_CAP).map((x) => cap(x, STR_CAP));
};

export const record = internalMutation({
  args: {
    events: v.array(
      v.object({
        vehicle_config_id: v.optional(v.union(v.id("vehicle_configs"), v.null())),
        enrichment_run_id: v.optional(v.union(v.id("enrichment_runs"), v.null())),
        stage: v.string(),
        decision_key: v.string(),
        chosen: v.string(),
        alternatives: v.optional(v.array(v.string())),
        reason: v.string(),
        evidence: v.optional(v.array(v.string())),
        outcome: v.optional(v.string()),
        cost: v.optional(
          v.object({
            tokens_in: v.optional(v.number()),
            tokens_out: v.optional(v.number()),
            web_searches: v.optional(v.number()),
            ms: v.optional(v.number()),
          }),
        ),
        flags: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const e of args.events.slice(0, BATCH_CAP)) {
      await ctx.db.insert("enrichment_decisions", {
        vehicle_config_id: e.vehicle_config_id ?? undefined,
        enrichment_run_id: e.enrichment_run_id ?? undefined,
        stage: e.stage,
        decision_key: e.decision_key,
        chosen: e.chosen,
        alternatives: e.alternatives,
        reason: e.reason,
        evidence: e.evidence,
        outcome: e.outcome,
        cost: e.cost,
        flags: e.flags,
        created_at: now,
      });
    }
    return { inserted: Math.min(args.events.length, BATCH_CAP) };
  },
});

/** Best-effort batched write from any ACTION context. Never throws. */
export async function recordDecisions(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  events: DecisionEvent[],
): Promise<void> {
  if (!events.length) return;
  try {
    const payload = events.slice(0, BATCH_CAP).map((e) => ({
      vehicle_config_id: (e.vehicleConfigId ?? null) as any,
      enrichment_run_id: (e.runId ?? null) as any,
      stage: cap(e.stage, 40),
      decision_key: cap(e.decisionKey, 80),
      chosen: cap(e.chosen, STR_CAP),
      alternatives: capList(e.alternatives),
      reason: cap(e.reason, REASON_CAP),
      evidence: capList(e.evidence),
      outcome: e.outcome ? cap(e.outcome, 40) : undefined,
      cost: e.cost,
      flags: e.flags ? cap(e.flags, STR_CAP) : undefined,
    }));
    await ctx.runMutation(
      (internal as any).vehicleEnrichment.utils.decisionLog.record,
      { events: payload },
    );
  } catch (e) {
    console.warn("[decision-log] write failed (non-fatal):", e);
  }
}
