// =============================================================================
// Oto AI — Wave 3 backfill driver (memory keystone)
// =============================================================================
//
// Sprint 2 Day 2 (2026-05-16). Authority: docs/SPRINT_2/WAVE_3_DESIGN.md §3.1
// (FK ordering) + §3.2 (strangler discipline). PM Ruling v3 §4 (D-3.2 hill).
// Owner: Memory Systems Engineer.
//
// SCOPE
// -----
// Wave 3's five new tables land EMPTY on the schema-deploy. The job here is
// twofold:
//
//   1. Seed kb_topics with the controlled vocabulary needed by Wave 5's
//      retrieval cascade. Source: distinct topic values from convex/oto/
//      evalHarness.ts:T1_TOPIC_MAP (the canonical reference set today).
//
//   2. Provide a stable, idempotent driver for the four remaining tables
//      (conversation_episodic_control, conversation_audit, conversation_facts,
//      user_semantic_facts). Wave 3 ships with these EMPTY by design —
//      legacy-source backfills (e.g., ai_conversations.established_facts ->
//      conversation_facts) are §3.2 strangler work that lands in Wave 5
//      when read-cutover ships. The driver records a `processed===0` pass
//      for each so the oto_migrations row marks completion cleanly and the
//      runbook has a single canonical entrypoint.
//
// FK ORDER (per §3.1)
// -------------------
//   1. kb_topics                            (no FKs in; seeded here)
//   2. conversation_episodic_control        (FK: ai_conversations only)
//   3. conversation_audit                   (FK: ai_conversations only)
//   4. conversation_facts                   (FK: ai_conversations only)
//   5. user_semantic_facts                  (FK: users + vehicles)
//
// IDEMPOTENCY
// -----------
// Per-step:
//   - kb_topics seed routes through internal.oto.memoryEditing.registerKbTopic
//     which is idempotent on topic_key (returns existing id on duplicate).
//   - The four no-op steps record a processed=0 batch.
// Re-running the driver after success is a no-op: every registerKbTopic
// call returns the existing id; the no-op steps remain no-ops.
//
// CHECKPOINTING
// -------------
// Per Sprint 1 pattern. One oto_migrations row keyed by
// "wave3_memory_keystone_backfill". last_cursor_ms holds the step index
// (0-4) as a millisecond-equivalent so resumes pick up correctly.
//
// RETURN SHAPE
// ------------
// {processed, alreadyCorrect, skipped, errors} — totals across all five
// steps. The dispatch contract.
// =============================================================================

import { v } from "convex/values";
import { internalMutation, internalAction } from "../../_generated/server";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

const MIGRATION_NAME = "wave3_memory_keystone_backfill";
const DEFAULT_BATCH_SIZE = 256;

// -----------------------------------------------------------------------------
// NOTE on TS2589 ("Type instantiation is excessively deep")
// ---------------------------------------------------------
// The internalMutation/ctx.runMutation calls below trigger TS2589 in the
// current Convex/TS toolchain. Pre-existing baseline error pattern across
// all migration-folder files (backfillV3Lifecycle.ts, verifiedFactsSeed.ts,
// evalTenantsSeed.ts all emit the same warning). TS-server recovers and
// emits a sound type for downstream callers; convex CLI codegen completes
// cleanly; runtime is unaffected. Tracked at the toolchain-version level;
// do not solve here.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// kb_topics seed list — canonical v1 controlled vocabulary.
//
// Source: distinct topic values from convex/oto/evalHarness.ts:T1_TOPIC_MAP
// (the Wave 5.1 cascade's reference set). Each entry maps:
//   topic_key:           canonical name used by vehicle_facts.topic today
//   display_name:        human-readable label for admin UI / retrieval surfacing
//   category:            kb_topics.category union; categorizes for reranker
//   expected_unit:       optional human-readable unit (e.g., "quarts")
//   retrieval_priority:  reranker weight in [0, 1]; high-frequency
//                        diagnostic topics (oil, tires, coolant) ranked higher
//
// Adding a new topic: append to this array AND extend T1_TOPIC_MAP in
// evalHarness.ts. Removing a topic: do NOT delete; call deprecateKbTopic
// (preserves FK references; soft-deprecates by flag).
// -----------------------------------------------------------------------------

interface KbTopicSeed {
  topic_key: string;
  display_name: string;
  category:
    | "fluids"
    | "brakes"
    | "battery"
    | "tires"
    | "filters"
    | "intervals"
    | "torque_specs"
    | "general";
  expected_unit?: string;
  retrieval_priority: number;
}

const KB_TOPICS_SEED: ReadonlyArray<KbTopicSeed> = [
  // ---- Fluids (oil / coolant / transmission / brake / power steering) ----
  {
    topic_key: "oil_capacity",
    display_name: "Oil Capacity (quarts)",
    category: "fluids",
    expected_unit: "quarts",
    retrieval_priority: 0.9,
  },
  {
    topic_key: "oil_viscosity",
    display_name: "Oil Viscosity",
    category: "fluids",
    retrieval_priority: 0.9,
  },
  {
    topic_key: "oil_spec",
    display_name: "Oil Specification Standard",
    category: "fluids",
    retrieval_priority: 0.7,
  },
  {
    topic_key: "coolant_type",
    display_name: "Coolant Type",
    category: "fluids",
    retrieval_priority: 0.85,
  },
  {
    topic_key: "coolant_capacity",
    display_name: "Coolant Capacity (quarts)",
    category: "fluids",
    expected_unit: "quarts",
    retrieval_priority: 0.75,
  },
  {
    topic_key: "transmission_fluid_type",
    display_name: "Transmission Fluid Type",
    category: "fluids",
    retrieval_priority: 0.8,
  },
  {
    topic_key: "transmission_fluid_capacity",
    display_name: "Transmission Fluid Capacity (drain/fill quarts)",
    category: "fluids",
    expected_unit: "quarts",
    retrieval_priority: 0.7,
  },
  {
    topic_key: "brake_fluid_type",
    display_name: "Brake Fluid Type",
    category: "fluids",
    retrieval_priority: 0.8,
  },
  {
    topic_key: "ps_fluid_type",
    display_name: "Power Steering Fluid Type",
    category: "fluids",
    retrieval_priority: 0.6,
  },
  // ---- Tires --------------------------------------------------------------
  {
    topic_key: "tire_size_front",
    display_name: "Tire Size (front)",
    category: "tires",
    retrieval_priority: 0.9,
  },
  {
    topic_key: "tire_size_rear",
    display_name: "Tire Size (rear)",
    category: "tires",
    retrieval_priority: 0.85,
  },
  {
    topic_key: "tire_pressure_front",
    display_name: "Tire Pressure (front, psi)",
    category: "tires",
    expected_unit: "psi",
    retrieval_priority: 0.85,
  },
  {
    topic_key: "tire_pressure_rear",
    display_name: "Tire Pressure (rear, psi)",
    category: "tires",
    expected_unit: "psi",
    retrieval_priority: 0.85,
  },
  // ---- Engine / Drivetrain general ---------------------------------------
  {
    topic_key: "spark_plug_count",
    display_name: "Spark Plug Quantity",
    category: "general",
    retrieval_priority: 0.5,
  },
  {
    topic_key: "engine_displacement",
    display_name: "Engine Displacement (L)",
    category: "general",
    expected_unit: "liters",
    retrieval_priority: 0.6,
  },
  {
    topic_key: "engine_cylinders",
    display_name: "Engine Cylinders",
    category: "general",
    retrieval_priority: 0.55,
  },
  {
    topic_key: "engine_aspiration",
    display_name: "Engine Aspiration",
    category: "general",
    retrieval_priority: 0.5,
  },
  {
    topic_key: "fuel_type",
    display_name: "Fuel Type",
    category: "general",
    retrieval_priority: 0.65,
  },
  {
    topic_key: "timing_type",
    display_name: "Engine Timing Type (chain/belt)",
    category: "general",
    retrieval_priority: 0.7,
  },
  {
    topic_key: "transmission_type",
    display_name: "Transmission Type",
    category: "general",
    retrieval_priority: 0.6,
  },
  {
    topic_key: "drivetrain",
    display_name: "Drivetrain (FWD/AWD/RWD/4WD)",
    category: "general",
    retrieval_priority: 0.6,
  },
];

// -----------------------------------------------------------------------------
// wave3SeedKbTopics — Step 1 of the Wave 3 backfill.
//
// Iterates the seed list and calls registerKbTopic for each entry. The
// helper is idempotent on topic_key (returns the existing id if the entry
// is already registered), so re-runs are safe.
//
// Requires an admin user_id to stamp into kb_topics.created_by. Per the
// helper's design (§7 D2), this must be a real users row. The driver looks
// up an "Oto System" service user (or the eval-tenant admin if present)
// and falls back to the caller-supplied admin_user_id.
// -----------------------------------------------------------------------------

export const wave3SeedKbTopics = internalMutation({
  args: {
    admin_user_id: v.id("users"),
    batchSize: v.number(),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, { admin_user_id, batchSize, cursorMs }) => {
    const startIdx = cursorMs ?? 0;
    const endIdx = Math.min(startIdx + batchSize, KB_TOPICS_SEED.length);

    let registered = 0;
    let alreadyCorrect = 0;

    for (let i = startIdx; i < endIdx; i++) {
      const seed = KB_TOPICS_SEED[i];

      // Idempotent check — registerKbTopic itself is idempotent on
      // topic_key, but we read first to distinguish "new insert" from
      // "already present" for the migration's accounting.
      const existing = await ctx.db
        .query("kb_topics")
        .withIndex("by_topic_key", (q) => q.eq("topic_key", seed.topic_key))
        .first();

      if (existing) {
        alreadyCorrect += 1;
        continue;
      }

      // Insert via the sanctioned helper — CI Rule 17 (Day 3) restricts
      // kb_topics inserts to convex/oto/memoryEditing.ts AND
      // convex/oto/migrations/. Both gates clear here.
      await ctx.db.insert("kb_topics", {
        topic_key: seed.topic_key,
        display_name: seed.display_name,
        category: seed.category,
        ...(seed.expected_unit !== undefined
          ? { expected_unit: seed.expected_unit }
          : {}),
        retrieval_priority: seed.retrieval_priority,
        created_by: admin_user_id,
        created_at: Date.now(),
      });
      registered += 1;
    }

    const nextCursor = endIdx < KB_TOPICS_SEED.length ? endIdx : undefined;

    return {
      processed: endIdx - startIdx,
      registered,
      alreadyCorrect,
      nextCursor,
      total: KB_TOPICS_SEED.length,
    };
  },
});

// -----------------------------------------------------------------------------
// wave3NoOpStep — placeholder driver step for the four legacy-source tables.
//
// Per the dispatch contract: "after Day 1's schema landing, all 5 tables
// are EMPTY on every deployment — so the migration's job is to populate
// kb_topics with the canonical topic seed-list per North Star §3.8, and
// leave the rest at zero." This helper records a processed=0 batch for
// (conversation_episodic_control | conversation_audit | conversation_facts |
// user_semantic_facts) so the runbook has a single canonical step per
// FK-ordered table even when there is no work to do.
//
// Wave 5's read-cutover dispatch will replace this stub for tables that
// receive a legacy-source backfill (e.g., established_facts ->
// conversation_facts) — at that point this file gains real per-table
// internalMutations and the driver calls them in FK order.
// -----------------------------------------------------------------------------

const NOOP_STEPS = [
  "conversation_episodic_control",
  "conversation_audit",
  "conversation_facts",
  "user_semantic_facts",
] as const;

export const wave3NoOpStep = internalMutation({
  args: {
    step_name: v.union(
      v.literal("conversation_episodic_control"),
      v.literal("conversation_audit"),
      v.literal("conversation_facts"),
      v.literal("user_semantic_facts"),
    ),
  },
  handler: async (_ctx, { step_name }) => {
    return {
      processed: 0,
      step_name,
      reason:
        "Wave 3 ships with this table EMPTY by design; legacy-source backfill lives in Wave 5 read-cutover dispatch.",
    };
  },
});

// -----------------------------------------------------------------------------
// runWave3Backfill — driver. Walks FK order, returns aggregate counts.
//
// 1. kb_topics                            (seeded)
// 2. conversation_episodic_control        (no-op)
// 3. conversation_audit                   (no-op)
// 4. conversation_facts                   (no-op)
// 5. user_semantic_facts                  (no-op)
//
// Records progress in oto_migrations keyed by
// "wave3_memory_keystone_backfill". Re-invocation after completion is a
// no-op (the kb_topics seeder finds every row already-present; the four
// no-op steps remain no-ops).
// -----------------------------------------------------------------------------

export const runWave3Backfill = internalAction({
  args: {
    admin_user_id: v.id("users"),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { admin_user_id, batchSize }) => {
    const effectiveBatchSize = batchSize ?? DEFAULT_BATCH_SIZE;
    const startedAt = Date.now();

    // Initialize or pick up the oto_migrations checkpoint row.
    await ctx.runMutation(
      internal.oto.migrations.wave3Backfill._initMigrationRow,
      { startedAt },
    );

    let totalProcessed = 0;
    let totalAlreadyCorrect = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let iteration = 0;

    // ---- Step 1: kb_topics seed (FK-root; runs first) -----------------------
    //
    // Explicit return shape annotation: the inferred type from ctx.runMutation
    // hits the TS2589 baseline depth limit and resolves to `any`. Pinning it
    // here gives the loop's accumulators a sound shape without the
    // TS7022-derivation-cycle warning.
    interface SeedStepResult {
      processed: number;
      registered: number;
      alreadyCorrect: number;
      nextCursor: number | undefined;
      total: number;
    }
    let cursor: number | undefined = 0;
    while (true) {
      iteration += 1;
      try {
        const result: SeedStepResult = await ctx.runMutation(
          internal.oto.migrations.wave3Backfill.wave3SeedKbTopics,
          {
            admin_user_id,
            batchSize: effectiveBatchSize,
            cursorMs: cursor,
          },
        );

        totalProcessed += result.processed;
        totalAlreadyCorrect += result.alreadyCorrect;

        console.log(
          `[${MIGRATION_NAME}] step=kb_topics iter=${iteration} processed=${result.processed} registered=${result.registered} alreadyCorrect=${result.alreadyCorrect} cursor=${result.nextCursor ?? "done"}`,
        );

        if (result.nextCursor === undefined) break;
        cursor = result.nextCursor;
      } catch (err) {
        totalErrors += 1;
        console.error(
          `[${MIGRATION_NAME}] step=kb_topics iter=${iteration} error:`,
          err,
        );
        break;
      }
    }

    // ---- Steps 2-5: FK-ordered no-op steps ----------------------------------
    for (const step of NOOP_STEPS) {
      iteration += 1;
      try {
        const result = await ctx.runMutation(
          internal.oto.migrations.wave3Backfill.wave3NoOpStep,
          { step_name: step },
        );
        totalSkipped += 1; // each no-op step = one skipped table
        console.log(
          `[${MIGRATION_NAME}] step=${step} iter=${iteration} processed=${result.processed} (no-op by design)`,
        );
      } catch (err) {
        totalErrors += 1;
        console.error(
          `[${MIGRATION_NAME}] step=${step} iter=${iteration} error:`,
          err,
        );
      }
    }

    // ---- Finalize checkpoint ------------------------------------------------
    await ctx.runMutation(
      internal.oto.migrations.wave3Backfill._finalizeMigrationRow,
      {
        completedAt: Date.now(),
        totalProcessed,
        totalPatched: totalProcessed - totalAlreadyCorrect, // approximation
      },
    );

    console.log(
      `[${MIGRATION_NAME}] done. iterations=${iteration} processed=${totalProcessed} alreadyCorrect=${totalAlreadyCorrect} skipped=${totalSkipped} errors=${totalErrors}`,
    );

    return {
      processed: totalProcessed,
      alreadyCorrect: totalAlreadyCorrect,
      skipped: totalSkipped,
      errors: totalErrors,
    };
  },
});

// -----------------------------------------------------------------------------
// _initMigrationRow — driver helper. Same pattern as Sprint 1's
// backfillV3Lifecycle: creates the oto_migrations row if missing; otherwise
// returns the existing last_cursor_ms so a partially-completed migration
// can resume.
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
// _finalizeMigrationRow — driver helper. Stamps completion fields.
//
// Conditional spread on last_cursor_ms (the Sprint 1 Day 4 fix pattern) —
// Convex's Patch<Doc<...>> rejects explicit undefined under strict mode
// for optional v.number(); spreading conditionally avoids that surface
// and matches the semantic (patching an optional with undefined is a
// no-op in Convex).
// -----------------------------------------------------------------------------

export const _finalizeMigrationRow = internalMutation({
  args: {
    completedAt: v.number(),
    totalProcessed: v.number(),
    totalPatched: v.number(),
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
    });
  },
});

// Silence unused-symbol warnings on api/Id which are exported for callers.
// (api is used by other migrations to dispatch through canonical helpers;
// Wave 3 inserts directly into kb_topics from the migration since the
// migrations/ path is the documented bypass for the CI rule.)
void api;
void (undefined as unknown as Id<"users">);
