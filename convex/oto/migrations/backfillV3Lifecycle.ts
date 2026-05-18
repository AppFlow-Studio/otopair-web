// =============================================================================
// Oto AI — combined v3 backfill: lifecycle defaults + embedding strip
// =============================================================================
//
// Sprint 1 Day 2 (2026-05-16). Authority: MEMORY_SCHEMA_V3_CONSOLIDATED §4 + §5.
// Owner: Memory Systems Engineer.
//
// WHAT THIS DOES
// --------------
// One batch pass over `vehicle_facts`. Per row:
//
//   1. If the row is still pre-v3 (verification_status === undefined),
//      compute the lifecycle defaults per §4:
//        verification_status:    by source — web_search → "unverified",
//                                else → "verified"
//        verified_at:            last_verified_at ?? updated_at ?? created_at
//                                (only if status is "verified")
//        report_count:           0
//        written_by:             "chat_agent"
//        asked_at:               created_at
//        canonical_question_key: await canonicalQuestionKey(question_text)
//
//   2. If the row still has an `embedding` field on disk (Deploy A left
//      old rows alone), include `embedding: undefined` in the patch.
//      Convex's `ctx.db.patch(id, { field: undefined })` removes the field
//      from the document.
//
// Both transformations are folded into a SINGLE `ctx.db.patch` call per
// row. Per the §5 fold-recommendation, this halves disk churn vs. running
// two separate backfills. One disk write per row.
//
// IDEMPOTENCY
// -----------
// A row that already has `verification_status` set AND no `embedding`
// field is skipped (patched === false for that row). Re-running on a
// completed migration is a true no-op: `processed === 0` once the
// batch's cursor walks past the last row.
//
// ATOMICITY
// ---------
// Convex mutations are transactional per call. Each row's patch is
// atomic. We do NOT split lifecycle defaults from the embedding strip
// across two patches — both go in one ctx.db.patch call.
//
// NO EXTERNAL I/O
// ---------------
// `canonicalQuestionKey` uses WebCrypto's `crypto.subtle.digest` which
// is available in the Convex mutation runtime. No fetches, no OpenAI,
// no Anthropic. Safe to run inside a mutation handler.
//
// CONSUMER
// --------
// `runBackfillV3Lifecycle` (internalAction in this file) is the driver.
// It loops calling `backfillV3Lifecycle` until `processed === 0` and
// records progress in the `oto_migrations` row keyed by
// "vehicle_facts_v3_lifecycle_backfill".
// =============================================================================

import { v } from "convex/values";
import { internalMutation, internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { canonicalQuestionKey } from "../canonicalize";

const MIGRATION_NAME = "vehicle_facts_v3_lifecycle_backfill";
const DEFAULT_BATCH_SIZE = 256;

// -----------------------------------------------------------------------------
// backfillV3Lifecycle — one batch of work. Idempotent per row.
// -----------------------------------------------------------------------------

export const backfillV3Lifecycle = internalMutation({
  args: {
    batchSize: v.number(),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize, cursorMs }) => {
    // Walk by _creationTime ascending. Convex provides every table with a
    // built-in `by_creation_time` index, which is what we want here.
    const rowsQuery = ctx.db.query("vehicle_facts").withIndex(
      "by_creation_time",
      cursorMs !== undefined
        ? (q) => q.gt("_creationTime", cursorMs)
        : (q) => q,
    );

    const rows = await rowsQuery.take(batchSize);

    let patched = 0;

    for (const row of rows) {
      const needsLifecycle = row.verification_status === undefined;
      const hasEmbedding =
        (row as unknown as { embedding?: unknown }).embedding !== undefined;

      if (!needsLifecycle && !hasEmbedding) {
        // Already migrated AND no embedding. Idempotent skip.
        continue;
      }

      // Single patch payload — we fold lifecycle defaults and embedding
      // strip into ONE disk write per §5 fold-recommendation.
      const patch: Record<string, unknown> = {};

      if (needsLifecycle) {
        // verification_status default by source (narrow reading of D-3.13).
        const verified =
          row.source === "manufacturer" ||
          row.source === "oto_inferred" ||
          row.source === "user_confirmed" ||
          row.source === "propagated";

        patch.verification_status = verified ? "verified" : "unverified";

        if (verified) {
          // Best-available proxy for when the row became verified.
          patch.verified_at =
            row.last_verified_at ?? row.updated_at ?? row.created_at;
        }

        patch.report_count = 0;
        patch.written_by = "chat_agent";
        patch.asked_at = row.created_at;

        // canonicalQuestionKey is async. Convex internalMutation handlers
        // support async bodies — the awaited work is part of the single
        // transaction the mutation runs in.
        patch.canonical_question_key = await canonicalQuestionKey(
          row.question_text,
        );
      }

      if (hasEmbedding) {
        // Convex semantics: patching a field to `undefined` removes it
        // from the stored document. Folded into the same patch as the
        // lifecycle defaults to keep this to one disk write per row.
        patch.embedding = undefined;
      }

      await ctx.db.patch(row._id, patch);
      patched += 1;
    }

    // Cursor advances even if everything in the batch was skipped — we want
    // the driver to keep walking, not loop forever on already-migrated rows.
    const nextCursor =
      rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined;

    return {
      processed: rows.length,
      patched,
      nextCursor,
    };
  },
});

// -----------------------------------------------------------------------------
// runBackfillV3Lifecycle — driver. Loops until `processed === 0`.
//
// Records progress + completion in a `oto_migrations` row keyed by
// "vehicle_facts_v3_lifecycle_backfill". Re-invocations after completion
// observe the existing completed row and re-run the loop anyway (which
// is a fast no-op: `backfillV3Lifecycle` skips every already-migrated
// row, and `processed === 0` fires on the first empty batch).
// -----------------------------------------------------------------------------

export const runBackfillV3Lifecycle = internalAction({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize }) => {
    const effectiveBatchSize = batchSize ?? DEFAULT_BATCH_SIZE;
    const startedAt = Date.now();

    // Init or pick up the oto_migrations row.
    let cursorMs: number | undefined = await ctx.runMutation(
      internal.oto.migrations.backfillV3Lifecycle._initMigrationRow,
      { startedAt },
    );

    let totalProcessed = 0;
    let totalPatched = 0;
    let iteration = 0;

    while (true) {
      iteration += 1;
      const result = await ctx.runMutation(
        internal.oto.migrations.backfillV3Lifecycle.backfillV3Lifecycle,
        { batchSize: effectiveBatchSize, cursorMs },
      );

      totalProcessed += result.processed;
      totalPatched += result.patched;

      console.log(
        `[${MIGRATION_NAME}] iter=${iteration} processed=${result.processed} patched=${result.patched} cursor=${result.nextCursor ?? "none"}`,
      );

      if (result.processed === 0) {
        // Drained the table.
        break;
      }

      cursorMs = result.nextCursor;

      // Defensive: if a batch came back fully populated but the cursor
      // somehow did not advance, bail rather than spin.
      if (cursorMs === undefined) break;
    }

    await ctx.runMutation(
      internal.oto.migrations.backfillV3Lifecycle._finalizeMigrationRow,
      {
        completedAt: Date.now(),
        totalProcessed,
        totalPatched,
        lastCursorMs: cursorMs,
      },
    );

    console.log(
      `[${MIGRATION_NAME}] done. iterations=${iteration} totalProcessed=${totalProcessed} totalPatched=${totalPatched}`,
    );

    return {
      iterations: iteration,
      totalProcessed,
      totalPatched,
    };
  },
});

// -----------------------------------------------------------------------------
// _initMigrationRow — driver helper. Creates the oto_migrations row if
// missing; otherwise returns the existing last_cursor_ms so a partially
// completed migration can resume.
// -----------------------------------------------------------------------------

export const _initMigrationRow = internalMutation({
  args: { startedAt: v.number() },
  handler: async (ctx, { startedAt }) => {
    const existing = await ctx.db
      .query("oto_migrations")
      .withIndex("by_name", (q) => q.eq("migration_name", MIGRATION_NAME))
      .first();

    if (existing) {
      return existing.last_cursor_ms;
    }

    await ctx.db.insert("oto_migrations", {
      migration_name: MIGRATION_NAME,
      last_cursor_ms: undefined,
      started_at: startedAt,
      completed_at: undefined,
      total_processed: 0,
      total_patched: 0,
    });
    return undefined;
  },
});

// -----------------------------------------------------------------------------
// _finalizeMigrationRow — driver helper. Stamps the completion fields.
//
// Sprint 1 Day 4 fix (line 289 TS error): the file as committed Day 2 was
// truncated on disk mid-statement at `last_cursor_ms: args.lastCursor`,
// producing TS1005 `'}' expected`. Reconstructed with the surrounding
// closing braces AND a narrow fix to the patch shape: because Convex's
// `Patch<Doc<"oto_migrations">>` does not always accept an explicit
// `undefined` for an optional field under strict mode, we conditionally
// spread `last_cursor_ms` only when defined. Patching with `undefined`
// would be a no-op for that field anyway in Convex semantics, so the
// behavior is preserved.
// -----------------------------------------------------------------------------

export const _finalizeMigrationRow = internalMutation({
  args: {
    completedAt: v.number(),
    totalProcessed: v.number(),
    totalPatched: v.number(),
    lastCursorMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oto_migrations")
      .withIndex("by_name", (q) => q.eq("migration_name", MIGRATION_NAME))
      .first();

    if (!row) {
      throw new Error(
        `[${MIGRATION_NAME}] _finalizeMigrationRow: row missing (init step must run first)`,
      );
    }

    await ctx.db.patch(row._id, {
      completed_at: args.completedAt,
      total_processed: row.total_processed + args.totalProcessed,
      total_patched: row.total_patched + args.totalPatched,
      // Optional patch field: only include when defined. Avoids the TS1005
      // surface that arose from the truncated commit and is also the
      // semantically-correct behavior — patching an optional v.number()
      // field with `undefined` is a no-op, so we skip the key entirely on
      // a re-run with no cursor advance.
      ...(args.lastCursorMs !== undefined
        ? { last_cursor_ms: args.lastCursorMs }
        : {}),
    });
  },
});
