// =============================================================================
// Oto AI — prompt_changelog mutations (Wave 1.5)
// =============================================================================
//
// Sprint 1 Day 5 addition (2026-05-16). Authority: Doc 3 §1 + Doc 4 Wave 1.5.
// Owner: Principal Prompt Engineer.
//
// Companion to `docs/SPRINT_1/WAVE_1_5_PROMPT_CHANGE_PROTOCOL.md`. This file
// exports the mutations the CI/rollout flow calls to write `prompt_changelog`
// rows. The CI workflow (post-merge step) calls `recordPromptChange` with the
// merge metadata. The rollout layer calls `markRolloutStarted` /
// `markRolloutOutcome` as the A/B observation window progresses. The
// `setActivePromptVersion` mutation is what `scripts/eval/rollback_prompt.sh`
// drives to flip the live prompt back when production misbehaves.
//
// Append-only by convention. The protocol doc says so (§1 step 5). There is
// no patch/replace surface on this module: the only write paths are inserts +
// the rollout-state inserts (which are also fresh rows, never edits). The
// rollout-outcome update on an EXISTING row IS a patch; we accept that one
// patch path because the row is the row that represents the rollout itself
// and amending its `ab_window_completed_at` is part of its lifecycle, not an
// audit edit. The protocol calls this out explicitly.
//
// Why this file is tiny: the heavy lifting lives in the protocol doc and the
// `scripts/eval/wave_1_5_compare.ts` CLI. This module is just the Convex
// surface those tools call.
// =============================================================================

import { internalMutation, mutation, query } from "../_generated/server";
import { v } from "convex/values";

// -----------------------------------------------------------------------------
// recordPromptChange — write the changelog row at merge time.
//
// Called by the CI post-merge step. Auth: the CI principal (a Clerk-synthetic
// service identity; the eval principal is reused here for simplicity in v1).
// In v1 we make it an internal mutation called from a deploy action; if
// external GitHub Actions need to call it directly, swap to a public
// mutation guarded by a service token check.
// -----------------------------------------------------------------------------

export const recordPromptChange = internalMutation({
  args: {
    prompt_version: v.string(),
    prev_version: v.string(),
    diff_summary: v.string(),
    rationale: v.string(),
    expected_eval_delta: v.optional(v.string()),
    actual_eval_delta: v.optional(v.string()),
    author: v.string(),
  },
  handler: async (ctx, args) => {
    const merged_at = Date.now();
    return await ctx.db.insert("prompt_changelog", {
      prompt_version: args.prompt_version,
      prev_version: args.prev_version,
      diff_summary: args.diff_summary,
      rationale: args.rationale,
      expected_eval_delta: args.expected_eval_delta,
      actual_eval_delta: args.actual_eval_delta,
      author: args.author,
      merged_at,
      // A/B fields are set later by the rollout layer.
      ab_window_started_at: undefined,
      ab_window_completed_at: undefined,
      ab_window_outcome: undefined,
      rollback_reason: undefined,
    });
  },
});

// -----------------------------------------------------------------------------
// markRolloutStarted — rollout layer flips the new version to 5% (or 25% for
// stable changes). Sets `ab_window_started_at` on the existing row.
// -----------------------------------------------------------------------------

export const markRolloutStarted = internalMutation({
  args: {
    prompt_version: v.string(),
    started_at: v.optional(v.number()), // defaults to Date.now()
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("prompt_changelog")
      .withIndex("by_version", (q) => q.eq("prompt_version", args.prompt_version))
      .order("desc")
      .first();
    if (!row) {
      throw new Error(
        `prompt_changelog row not found for version ${args.prompt_version}. recordPromptChange must run first.`,
      );
    }
    await ctx.db.patch(row._id, {
      ab_window_started_at: args.started_at ?? Date.now(),
    });
    return row._id;
  },
});

// -----------------------------------------------------------------------------
// markRolloutOutcome — rollout layer promotes to 100% (outcome="promoted") or
// the rollback script runs (outcome="rolled_back"). Sets the trailing fields
// on the row that owns this rollout.
// -----------------------------------------------------------------------------

export const markRolloutOutcome = internalMutation({
  args: {
    prompt_version: v.string(),
    outcome: v.union(v.literal("promoted"), v.literal("rolled_back")),
    rollback_reason: v.optional(v.string()),
    completed_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("prompt_changelog")
      .withIndex("by_version", (q) => q.eq("prompt_version", args.prompt_version))
      .order("desc")
      .first();
    if (!row) {
      throw new Error(
        `prompt_changelog row not found for version ${args.prompt_version}.`,
      );
    }
    if (args.outcome === "rolled_back" && !args.rollback_reason) {
      throw new Error("rollback_reason is required when outcome=rolled_back");
    }
    await ctx.db.patch(row._id, {
      ab_window_completed_at: args.completed_at ?? Date.now(),
      ab_window_outcome: args.outcome,
      rollback_reason: args.rollback_reason,
    });
    return row._id;
  },
});

// -----------------------------------------------------------------------------
// setActivePromptVersion — flip the live prompt back to a prior version.
// Used by scripts/eval/rollback_prompt.sh AND by auto-rollback in the
// rollout layer. The actual "active version" pointer lives in a separate
// config (not Wave 1.5's surface); this mutation writes a marker row to
// `prompt_changelog` with outcome="rolled_back" on the version being
// rolled OFF, so the audit trail is complete.
//
// In v1 the rollout-layer pointer is read from environment/config, not from
// `prompt_changelog`. This mutation's job is the AUDIT side; the actual
// version-flip is the caller's responsibility (e.g., `convex env set
// OTO_ACTIVE_PROMPT_VERSION`). The script chains the env-set + this
// mutation.
// -----------------------------------------------------------------------------

export const setActivePromptVersion = mutation({
  args: {
    version: v.string(),
    rolled_back_from: v.string(),
    rollback_reason: v.string(),
    actor: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.rollback_reason || args.rollback_reason.trim().length === 0) {
      throw new Error("rollback_reason cannot be empty");
    }
    // Mark the rolled-OFF version's row.
    const rolledOff = await ctx.db
      .query("prompt_changelog")
      .withIndex("by_version", (q) =>
        q.eq("prompt_version", args.rolled_back_from),
      )
      .order("desc")
      .first();
    if (rolledOff) {
      await ctx.db.patch(rolledOff._id, {
        ab_window_completed_at: Date.now(),
        ab_window_outcome: "rolled_back",
        rollback_reason: args.rollback_reason,
      });
    }
    // Write a fresh row noting the manual revert action. This is appended,
    // not an edit, so it preserves the append-only-by-convention story.
    return await ctx.db.insert("prompt_changelog", {
      prompt_version: args.version,
      prev_version: args.rolled_back_from,
      diff_summary: `MANUAL REVERT: restored ${args.version} after rollback of ${args.rolled_back_from}`,
      rationale: `Emergency rollback. Reason: ${args.rollback_reason}`,
      expected_eval_delta: undefined,
      actual_eval_delta: undefined,
      author: args.actor,
      merged_at: Date.now(),
      ab_window_started_at: Date.now(),
      ab_window_completed_at: Date.now(),
      ab_window_outcome: "promoted", // the restored version is now active
      rollback_reason: undefined,
    });
  },
});

// -----------------------------------------------------------------------------
// listRecentChanges — read-side helper used by the rollback script to find
// the second-newest version. Public query: any user can read the changelog
// (it's an audit-style log, not secret).
// -----------------------------------------------------------------------------

export const listRecentChanges = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 200);
    const rows = await ctx.db
      .query("prompt_changelog")
      .withIndex("by_merged_at")
      .order("desc")
      .take(limit);
    return rows.map((r) => ({
      _id: r._id,
      prompt_version: r.prompt_version,
      prev_version: r.prev_version,
      author: r.author,
      merged_at: r.merged_at,
      diff_summary: r.diff_summary,
      ab_window_outcome: r.ab_window_outcome,
      rollback_reason: r.rollback_reason,
    }));
  },
});
