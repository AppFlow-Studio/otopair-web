// =============================================================================
// Oto AI — verified-fact seed + cleanup helpers (eval harness wiring)
// =============================================================================
//
// Sprint 2 Day 2 (2026-05-16). Owner: Memory Systems Engineer.
// Follow-up to Sprint 2 Day 1's PM-lean shipment of Wave 1.4 v3 case (d).
//
// CRITICAL EXCEPTION DOCUMENTATION
// --------------------------------
// These two internalMutations support the cross-tenant verified/unverified
// fact cases (crosstenant-d-002 / crosstenant-d-003) in the eval harness.
// They are bounded the same way as the sibling evalTenantsSeed.ts module:
//
//   1. CANONICAL HELPER ROUTING — the seed never touches the vehicle_facts
//      or vehicle_facts_audit table directly. Every write routes through
//      internal.oto.vehicleFactsEditing.recordVehicleFact and
//      internal.oto.vehicleFactsEditing.editVehicleFact via ctx.runMutation.
//      The audit-row-atomicity contract is preserved because the helper
//      itself writes the audit row in the same transaction. CI Rules 1
//      (no direct patch on vehicle_facts) and 3 (no direct insert into
//      vehicle_facts_audit) stay green.
//
//   2. CLEANUP DELETES BY FK ONLY — the teardown deletes fact_reports
//      rows by by_fact index, then vehicle_facts_audit rows by by_fact
//      index, then the vehicle_facts row itself, ALL scoped to the
//      fact_id being torn down. We never mutate audit rows for any other
//      fact. CI Rule 1 covers ctx.db.patch, Rule 2 covers ctx.db.replace,
//      Rule 3 covers ctx.db.insert into the audit table; ctx.db.delete
//      is not a forgery vector under the v3 model and is the only
//      legitimate way to release the fixture row.
//
//   3. IDEMPOTENT — seedEvalVerifiedFact dedupes on canonical_question_key
//      via the existing recordVehicleFact dedupe path; the verify call is
//      gated by the editVehicleFact "verify" pre-condition. If the row is
//      already verified, the helper throws a specific pre-condition error
//      which we catch and treat as the idempotent success path.
//      cleanupEvalVerifiedFact skips missing rows at every stage.
//
//   4. SOURCE LOCKED TO web_search — per the schema's source-typed-trust
//      lifecycle. Other sources land at verification_status="verified" on
//      creation and would not need the second verify step. Constraining
//      the helper to web_search keeps the verify-after-record flow
//      meaningful and the helper surface narrow.
//
//   5. INTERNAL ONLY — both mutations are internalMutation. They are
//      invoked exclusively from scripts/eval/lib/multiTenantSetup.ts via
//      the standard HTTP-API + deploy-key bearer mechanism the harness
//      already uses.
//
// USAGE
// -----
// The TypeScript wrapper in scripts/eval/lib/multiTenantSetup.ts exposes
// seedVerifiedFact and cleanupVerifiedFact, which dispatch:
//   - internal.oto.migrations.verifiedFactsSeed.seedEvalVerifiedFact
//   - internal.oto.migrations.verifiedFactsSeed.cleanupEvalVerifiedFact
//
// Do not call from chat code paths, from production tools, or from any
// runtime code that could ever serve a real user.
// =============================================================================

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { canonicalQuestionKey } from "../canonicalize";

// -----------------------------------------------------------------------------
// NOTE on TS2589 ("Type instantiation is excessively deep")
// ---------------------------------------------------------
// The internalMutation calls below trigger TS2589 in the current Convex/TS
// toolchain. This is a PRE-EXISTING baseline error pattern across all
// migration-folder files (evalTenantsSeed.ts, backfillV3Lifecycle.ts,
// vehicleFactsReconciliation.ts all emit the same warning). The TS-server
// recovers and emits a sound type for downstream callers; the convex CLI
// codegen completes cleanly; runtime is unaffected. Tracked at the
// toolchain-version level; do not solve here.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Scope enum — runtime-validated below (not a Convex v.union, to avoid the
// TS2589 deep-instantiation chain that the union+v.id+internalMutation+api
// combination triggers in the current toolchain version). source is locked
// to "web_search" because that is the only path where the seed's
// verify-after-record flow is meaningful (other sources start verified);
// also runtime-validated rather than v.literal-validated for the same
// reason.
// -----------------------------------------------------------------------------

const VALID_SCOPES = [
  "vehicle_config",
  "trim",
  "chassis",
  "engine",
  "model_year",
] as const;
type Scope = (typeof VALID_SCOPES)[number];

function assertScope(scope: string): asserts scope is Scope {
  if (!(VALID_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(
      `seedEvalVerifiedFact: scope must be one of ${VALID_SCOPES.join(", ")}; got "${scope}"`,
    );
  }
}

function assertSource(source: string): asserts source is "web_search" {
  if (source !== "web_search") {
    throw new Error(
      `seedEvalVerifiedFact: source is locked to "web_search"; got "${source}"`,
    );
  }
}

// -----------------------------------------------------------------------------
// seedEvalVerifiedFact — idempotent fixture write + optional auto-verify.
//
// Args mirror the harness authoring intent:
//   - scope / scope_key  — the topic-axis tuple the fact attaches to.
//                          Mapped to topic_axis + scoping ids
//                          (vehicle_config_id / chassis_code / engine_code /
//                          make+model+years).
//   - topic              — short topic label (e.g. "cabin_air_filter_pn").
//   - fact_text          — the answer body. Required.
//   - source             — locked to "web_search" by the validator.
//   - confidence         — must be in (0, 0.7] for source="web_search"; the
//                          recordVehicleFact helper enforces this floor.
//   - verify             — if true, the seed flips status to "verified" via
//                          a paired editVehicleFact("verify") call. Defaults
//                          to true so the verified case (d-002) is one call.
//                          d-003 passes false to keep the row "unverified".
//   - editor_user_id     — required when verify=true. The user-id stamped on
//                          the audit row. In the cross-tenant harness this
//                          is User A's seeded id (returned by seedEvalTenants).
//   - asked_by_user_id   — optional. Stamped on the vehicle_facts row.
//   - question_text      — the user-facing question. Used to derive
//                          canonical_question_key via canonicalize.ts. Re-asks
//                          of the same canonical key dedupe.
//
// Returns: { fact_id }.
// -----------------------------------------------------------------------------

export const seedEvalVerifiedFact = internalMutation({
  args: {
    scope: v.string(),
    scope_key: v.string(),
    topic: v.string(),
    fact_text: v.string(),
    question_text: v.string(),
    source: v.string(),
    confidence: v.number(),
    verify: v.optional(v.boolean()),
    editor_user_id: v.optional(v.id("users")),
    asked_by_user_id: v.optional(v.id("users")),

    // Scope detail args — pass exactly the subset that matches scope. The
    // handler validates that the subset is consistent below.
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    chassis_code: v.optional(v.string()),
    engine_code: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim_name: v.optional(v.string()),
    year_min: v.optional(v.number()),
    year_max: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // -- 0. Runtime-validate enum-shaped string args. ------------------------
    // (We use v.string() at the validator layer to dodge TS2589; the
    // semantic validation lives here.)
    assertScope(args.scope);
    assertSource(args.source);

    // -- 1. Validate scope consistency. --------------------------------------
    if (args.scope === "vehicle_config" && !args.vehicle_config_id) {
      throw new Error(
        "seedEvalVerifiedFact: scope='vehicle_config' requires vehicle_config_id",
      );
    }
    if (args.scope === "chassis" && !args.chassis_code) {
      throw new Error(
        "seedEvalVerifiedFact: scope='chassis' requires chassis_code",
      );
    }
    if (args.scope === "engine" && !args.engine_code) {
      throw new Error(
        "seedEvalVerifiedFact: scope='engine' requires engine_code",
      );
    }
    if (args.scope === "model_year") {
      if (!args.make || !args.model || args.year_min === undefined) {
        throw new Error(
          "seedEvalVerifiedFact: scope='model_year' requires make + model + year_min",
        );
      }
    }
    if (args.scope === "trim") {
      if (!args.make || !args.model || !args.trim_name) {
        throw new Error(
          "seedEvalVerifiedFact: scope='trim' requires make + model + trim_name",
        );
      }
    }

    const verify = args.verify ?? true;
    if (verify && !args.editor_user_id) {
      throw new Error(
        "seedEvalVerifiedFact: verify=true requires editor_user_id (stamped on audit row)",
      );
    }

    // -- 2. Map scope to topic_axis. -----------------------------------------
    // The seed accepts the PM-ruling-style scope enum (vehicle_config / trim /
    // chassis / engine / model_year) and translates to the
    // vehicle_facts.topic_axis union the schema expects. The two enums are
    // 1:1 except scope='vehicle_config' which maps to topic_axis='vehicle'.
    const topicAxis =
      args.scope === "vehicle_config"
        ? ("vehicle" as const)
        : (args.scope as "trim" | "chassis" | "engine" | "model_year");

    // -- 3. Compute the canonical_question_key via the pure helper. ----------
    const canonical = await canonicalQuestionKey(args.question_text);

    // -- 4. Record the fact via the canonical helper. ------------------------
    // Confidence floor / source validation / dedupe-on-canonical-key all
    // live inside recordVehicleFact. We just pass args through.
    const factId: Id<"vehicle_facts"> = await ctx.runMutation(
      internal.oto.vehicleFactsEditing.recordVehicleFact,
      {
        topic: args.topic,
        topic_axis: topicAxis,
        vehicle_config_id: args.vehicle_config_id,
        chassis_code: args.chassis_code,
        engine_code: args.engine_code,
        make: args.make,
        model: args.model,
        trim_name: args.trim_name,
        year_min: args.year_min,
        year_max: args.year_max,

        fact_text: args.fact_text,
        question_text: args.question_text,
        canonical_question_key: canonical,

        source: args.source,
        written_by: "system" as const,
        confidence: args.confidence,

        asked_by_user_id: args.asked_by_user_id,
      },
    );

    // -- 5. Optional: flip to verified via paired editVehicleFact call. ------
    // The helper's "verify" action pre-condition requires current status to
    // be "unverified". On a fresh insert with source="web_search" this is
    // the schema default. On an idempotent re-seed where the row was already
    // verified by a prior run, editVehicleFact throws a specific
    // pre-condition error which we catch and treat as the idempotent
    // success path. Any other error re-throws.
    if (verify && args.editor_user_id) {
      try {
        await ctx.runMutation(internal.oto.vehicleFactsEditing.editVehicleFact, {
          fact_id: factId,
          action: "verify" as const,
          editor_id: args.editor_user_id,
          reason: "Eval-harness fixture: cross-tenant verified-fact seed.",
          changes: {
            verification_status: "verified" as const,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // The verify pre-condition throws when the row is already verified.
        // Treat that as the idempotent success path. Any other error
        // re-throws.
        if (!msg.includes("cannot verify; current status is")) {
          throw err;
        }
      }
    }

    return { fact_id: factId };
  },
});

// -----------------------------------------------------------------------------
// cleanupEvalVerifiedFact — idempotent fact teardown.
//
// Deletes in reverse-FK order:
//   1. fact_reports rows whose fact_id == args.fact_id (by_fact index)
//   2. vehicle_facts_audit rows whose fact_id == args.fact_id (by_fact index)
//   3. the vehicle_facts row itself
//
// Missing rows at any stage are silently skipped — this mutation is safe
// to call any number of times, including against a fact_id that has
// already been cleaned up.
//
// SCOPING CONTRACT
// ----------------
// The audit-row deletes are scoped EXCLUSIVELY to the fact_id passed in.
// We never mutate or touch audit rows for any other fact. The append-only
// invariant on the audit table (CI Rule 3, post-creation) is preserved
// because no audit row is mutated; the rows for the torn-down fact are
// deleted as part of releasing the fixture row, which is the correct
// terminal operation when the fact itself is being released.
// -----------------------------------------------------------------------------

export const cleanupEvalVerifiedFact = internalMutation({
  args: { fact_id: v.id("vehicle_facts") },
  handler: async (ctx, { fact_id }) => {
    let reports_deleted = 0;
    let audit_deleted = 0;
    let fact_deleted = 0;

    // 1. Delete fact_reports pointing at this fact (by_fact index).
    const reports = await ctx.db
      .query("fact_reports")
      .withIndex("by_fact", (q) => q.eq("fact_id", fact_id))
      .collect();
    for (const r of reports) {
      await ctx.db.delete(r._id);
      reports_deleted += 1;
    }

    // 2. Delete vehicle_facts_audit rows pointing at this fact (by_fact index).
    // This is the ONLY legitimate place audit rows are deleted: the fact
    // they describe is being released. Scoped strictly to args.fact_id.
    const auditRows = await ctx.db
      .query("vehicle_facts_audit")
      .withIndex("by_fact", (q) => q.eq("fact_id", fact_id))
      .collect();
    for (const a of auditRows) {
      await ctx.db.delete(a._id);
      audit_deleted += 1;
    }

    // 3. Delete the vehicle_facts row itself.
    const fact = await ctx.db.get(fact_id);
    if (fact) {
      await ctx.db.delete(fact_id);
      fact_deleted = 1;
    }

    return { reports_deleted, audit_deleted, fact_deleted };
  },
});
