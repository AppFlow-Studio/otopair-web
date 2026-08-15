/**
 * convex/healthScoreWeights.ts — Director-adjustable outer health-score
 * weights (Upkeep vs. Warning Lights, plus the Open-recs cap).
 *
 * Single global row on `health_score_weights` (absent row → hardcoded
 * defaults, byte-identical to the score before this table existed). Bigger
 * blast radius than per-item severity tuning (inspection_health_config) —
 * this reshapes every vehicle's score the instant it's saved — so writes
 * require an explicit confirmation flag and always leave an audit_log entry.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { HealthScoreWeights } from "../utils/healthScore";

export const DEFAULT_UPKEEP_WEIGHT = 85;
export const DEFAULT_OPEN_ISSUE_PENALTY_MAX = 15;

/** Plain read helper (not a query) so server-side callers — Oto's score,
 *  the deferred-write scheduler job — can await it directly without an
 *  extra Convex round trip. Always returns fully-populated defaults. */
export async function loadHealthScoreWeights(ctx: {
  db: { query: (table: "health_score_weights") => any };
}): Promise<Required<HealthScoreWeights>> {
  const row = await ctx.db.query("health_score_weights").first();
  return {
    upkeepWeight: row?.upkeep_weight ?? DEFAULT_UPKEEP_WEIGHT,
    openIssuePenaltyMax: row?.open_issue_penalty_max ?? DEFAULT_OPEN_ISSUE_PENALTY_MAX,
  };
}

/** Reactive query for the client-side ring hook — a director's change is
 *  picked up live, automatically, no extra plumbing. */
export const getWeights = query({
  args: {},
  handler: async (ctx) => {
    const weights = await loadHealthScoreWeights(ctx);
    return {
      upkeepWeight: weights.upkeepWeight,
      warningLightsWeight: 100 - weights.upkeepWeight,
      openIssuePenaltyMax: weights.openIssuePenaltyMax,
    };
  },
});

function clampWeight(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const setWeights = mutation({
  args: {
    upkeepWeight: v.number(),
    openIssuePenaltyMax: v.number(),
    /** The director UI must set this explicitly — no bare, unguarded
     *  slider. A platform-wide, instant formula change should never be a
     *  single misclick. */
    confirmed: v.boolean(),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    if (!args.confirmed) {
      throw new Error("Score-weight changes require explicit confirmation.");
    }
    const upkeepWeight = clampWeight(args.upkeepWeight, 0, 100);
    const openIssuePenaltyMax = clampWeight(args.openIssuePenaltyMax, 0, 100);

    const now = Date.now();
    const existing = await ctx.db.query("health_score_weights").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        upkeep_weight: upkeepWeight,
        open_issue_penalty_max: openIssuePenaltyMax,
        updated_at: now,
        updated_by: args.actorId,
      });
    } else {
      await ctx.db.insert("health_score_weights", {
        upkeep_weight: upkeepWeight,
        open_issue_penalty_max: openIssuePenaltyMax,
        updated_at: now,
        updated_by: args.actorId,
      });
    }
    await ctx.db.insert("audit_log", {
      entity_type: "health_score_weights",
      entity_id: "global",
      action: "field_edit",
      actor: args.actorName ?? "Director",
      actor_id: args.actorId,
      detail: `Upkeep weight set to ${upkeepWeight} (Warning Lights ${100 - upkeepWeight}), Open-recs cap set to ${openIssuePenaltyMax}`,
      created_at: now,
    });
  },
});
