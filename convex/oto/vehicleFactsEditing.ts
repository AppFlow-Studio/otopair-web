// =============================================================================
// Oto AI — vehicle_facts mutation helpers (consolidated v3)
// =============================================================================
//
// Sprint 1 Day 1 correction (2026-05-16). Authority: MEMORY_SCHEMA_V3_CONSOLIDATED
// §6, PM Ruling v3, Architecture v3 Amendments D-3.11.
// Subagent consensus: Memory Engineer + RAG Specialist + Security Analyst.
//
// THIS FILE IS THE ONLY SANCTIONED PATH TO MUTATE vehicle_facts.
//
// Background: an earlier pass created a parallel `vehicle_searched_facts` table
// + a `searchedFacts.ts` helper. Waleed ruled the two tables were the same
// thing; consolidation collapsed them into the single `vehicle_facts` table
// (which already had `source: "web_search"` as one of its enum values). This
// file is the helper for the consolidated table. The old `searchedFacts.ts`
// is a deprecation stub.
//
// The invariant: every mutation to vehicle_facts writes a paired row to
// vehicle_facts_audit in the SAME Convex mutation (atomic per Convex's
// serialization guarantee). Direct ctx.db.patch / ctx.db.replace against
// vehicle_facts is FORBIDDEN outside this file. Direct ctx.db.insert into
// vehicle_facts_audit is FORBIDDEN outside this file. Both are enforced by
// CI grep rules in scripts/ci/vehicle-facts-grep.sh.
//
// Four exported mutations:
//   - recordVehicleFact:  write a new fact (NO audit row; creation is its
//                         own record). Replaces the legacy record_vehicle_fact
//                         path; web_search-sourced rows land at status
//                         "unverified", enrichment-sourced rows at "verified"
//                         (narrow reading of D-3.13 per Waleed's ruling).
//   - editVehicleFact:    mutate an existing row + write paired audit row.
//                         Atomic.
//   - reportVehicleFact:  user reports a message; insert fact_reports row +
//                         denormalized counter bump on the fact row. NO audit
//                         row (fact_reports IS the audit trail for reports).
//   - resolveFactReport:  admin disposition close on an open report. No
//                         mutation of vehicle_facts; reviewer calls
//                         editVehicleFact separately if a fact-edit is part
//                         of the resolution (two-call pattern keeps each
//                         table's invariant local).
//
// Lifecycle for vehicle_facts.verification_status (narrow reading of D-3.13):
//   - source == "web_search"   → starts "unverified"
//   - source != "web_search"   → starts "verified" (enrichment-quality)
//   - unverified → verified    via editVehicleFact action="verify"
//                              (Waleed or Temur only; no auto-promotion)
//   - any → retracted          via editVehicleFact action="retract"
//                              (Waleed or Temur only)
// =============================================================================

import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { queryMoat } from "./queryMoat";

// recordVehicleFact's canonical-key dedupe over-fetches by this much so that
// retracted rows sharing the key don't crowd out a live one. A point read on
// an indexed sha256 key stays cheap; in practice the depth is 1-2.
const DEDUPE_SCAN_LIMIT = 10;

// -----------------------------------------------------------------------------
// Shared validators — mirror the schema unions so a typo here surfaces at
// codegen rather than at runtime.
// -----------------------------------------------------------------------------

const topicAxisValidator = v.union(
  v.literal("vehicle"),
  v.literal("trim"),
  v.literal("chassis"),
  v.literal("engine"),
  v.literal("model_year"),
);

const sourceValidator = v.union(
  v.literal("manufacturer"),
  v.literal("oto_inferred"),
  v.literal("web_search"),
  v.literal("user_confirmed"),
  v.literal("propagated"),
);

const verificationStatusValidator = v.union(
  v.literal("unverified"),
  v.literal("verified"),
  v.literal("retracted"),
);

const writtenByValidator = v.union(
  v.literal("chat_agent"),
  v.literal("health_monitor"),
  v.literal("admin_edit"),
  v.literal("system"),
);

const auditActionValidator = v.union(
  v.literal("verify"),
  v.literal("retract"),
  v.literal("edit_text"),
  v.literal("edit_meta"),
);

// -----------------------------------------------------------------------------
// recordVehicleFact — creation path.
//
// Lands a new vehicle_facts row. Used by:
//   - chat_agent (after a Tier-3 web_search hit) — source: "web_search"
//   - enrichment pipeline (via system writes) — source: manufacturer / oto_inferred
//   - mechanic confirmation flows — source: user_confirmed
//
// NO audit row on creation. The inserted row IS its own creation record.
//
// Dedupe: if a row already exists for the same canonical_question_key,
// the existing id is returned and asked_at is bumped. No double-insert.
//
// Confidence floor for source == "web_search": <= 0.7. Enforced server-side.
// Other sources may use any confidence value in [0, 1].
//
// Default verification_status (narrow reading of D-3.13):
//   source == "web_search" → "unverified"
//   else                   → "verified"
// -----------------------------------------------------------------------------

export const recordVehicleFact = internalMutation({
  args: {
    topic: v.string(),
    topic_axis: topicAxisValidator,
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    chassis_code: v.optional(v.string()),
    engine_code: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim_name: v.optional(v.string()),
    year_min: v.optional(v.number()),
    year_max: v.optional(v.number()),

    fact_text: v.string(),
    question_text: v.string(),
    answer_format: v.optional(v.string()),
    canonical_question_key: v.string(),

    source: sourceValidator,
    cited_url: v.optional(v.string()),
    written_by: writtenByValidator,
    confidence: v.number(),
    propagated_from_id: v.optional(v.id("vehicle_facts")),

    asked_by_user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    if (args.confidence < 0 || args.confidence > 1) {
      throw new Error("recordVehicleFact: confidence must be in [0, 1]");
    }
    if (args.source === "web_search" && args.confidence > 0.7) {
      throw new Error(
        `recordVehicleFact: web_search source has confidence floor of 0.7; got ${args.confidence}.`,
      );
    }
    if (!args.fact_text.trim()) {
      throw new Error("recordVehicleFact: fact_text required");
    }
    if (!args.canonical_question_key.trim()) {
      throw new Error("recordVehicleFact: canonical_question_key required");
    }

    // Dedupe on canonical_question_key.
    // Wave 7.3 Option B (Sprint 2 Day 3): migrated through queryMoat after
    // the build-callback typing was tightened to `QueryInitializer<NamedTableInfo<...>>`,
    // which preserves the table-scoped index/field names through the helper
    // boundary. Counter bump applies in mutation context per the helper's
    // contract; this is the canonical KB (Group G) write-side read path.
    const existingRows = await queryMoat(
      ctx,
      "vehicle_facts",
      (q) =>
        q
          .withIndex("by_canonical_question", (q2) =>
            q2.eq("canonical_question_key", args.canonical_question_key),
          )
          .take(DEDUPE_SCAN_LIMIT),
    );
    // A retracted row must NOT satisfy the dedupe. Retracted means the answer
    // was withdrawn; counting it as "already recorded" telemetry-patches a dead
    // row and silently drops the incoming fact, so a question that was ever
    // retracted could never be answered again. Over-fetch and skip them —
    // same attrition-absorbing read as vehicleFactsKB's canonical-hash lookup.
    const existing =
      existingRows.find(
        (r) => (r.verification_status ?? "unverified") !== "retracted",
      ) ?? null;

    const now = Date.now();

    if (existing) {
      // Same canonical question asked again — touch asked_at only. Do NOT
      // overwrite fact_text, status, or any semantic field. Pure telemetry
      // patch, no audit row required (see CI grep rule 1 — telemetry patches
      // are exempt by virtue of not touching semantic fields).
      await ctx.db.patch(existing._id, {
        asked_at: now,
        updated_at: now,
      });
      return existing._id;
    }

    // Narrow reading of D-3.13 — verification_status default by source.
    const defaultStatus: "unverified" | "verified" =
      args.source === "web_search" ? "unverified" : "verified";

    const factId = await ctx.db.insert("vehicle_facts", {
      topic: args.topic,
      topic_axis: args.topic_axis,
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
      answer_format: args.answer_format,
      canonical_question_key: args.canonical_question_key,

      source: args.source,
      cited_url: args.cited_url,
      confidence: args.confidence,
      propagated_from_id: args.propagated_from_id,

      written_by: args.written_by,
      verification_status: defaultStatus,
      verified_at: defaultStatus === "verified" ? now : undefined,
      report_count: 0,

      asked_by_user_id: args.asked_by_user_id,
      asked_at: now,

      created_at: now,
    });

    return factId;
  },
});

// -----------------------------------------------------------------------------
// editVehicleFact — THE ONLY SANCTIONED PATH to mutate an existing row.
//
// Atomic: read current → compute previous_values diff over changing fields
// only → patch row → insert audit row. All in one mutation = one Convex
// transaction. Atomicity is what makes the audit invariant unbypassable
// from this side.
//
// Action enum mirrors the audit table's action union:
//   - "verify"    flips verification_status to "verified", sets verified_at.
//                 Pre-condition: current status is "unverified".
//   - "retract"   flips verification_status to "retracted", sets retracted_at.
//                 Pre-condition: current status is not "retracted".
//   - "edit_text" mutates fact_text. Cannot accompany a status change.
//   - "edit_meta" mutates topic / topic_axis / confidence / cited_url /
//                 source / answer_format / scoping ids.
//
// reason is required and non-empty.
// -----------------------------------------------------------------------------

export const editVehicleFact = internalMutation({
  args: {
    fact_id: v.id("vehicle_facts"),
    action: auditActionValidator,
    editor_id: v.id("users"),
    reason: v.string(),

    changes: v.object({
      fact_text: v.optional(v.string()),
      verification_status: v.optional(verificationStatusValidator),
      confidence: v.optional(v.number()),
      topic: v.optional(v.string()),
      topic_axis: v.optional(topicAxisValidator),
      cited_url: v.optional(v.string()),
      source: v.optional(sourceValidator),
      answer_format: v.optional(v.string()),
      vehicle_config_id: v.optional(v.id("vehicle_configs")),
      chassis_code: v.optional(v.string()),
      engine_code: v.optional(v.string()),
      make: v.optional(v.string()),
      model: v.optional(v.string()),
      trim_name: v.optional(v.string()),
      year_min: v.optional(v.number()),
      year_max: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { fact_id, action, editor_id, reason, changes }) => {
    if (!reason.trim()) {
      throw new Error("editVehicleFact: reason is required");
    }

    const current = (await ctx.db.get(fact_id)) as Doc<"vehicle_facts"> | null;
    if (!current) {
      throw new Error(`editVehicleFact: fact ${fact_id} not found`);
    }

    // Pre-condition checks per action.
    if (action === "verify") {
      if (current.verification_status !== "unverified") {
        throw new Error(
          `editVehicleFact: cannot verify; current status is "${current.verification_status}"`,
        );
      }
      if (changes.verification_status === undefined) {
        changes.verification_status = "verified";
      } else if (changes.verification_status !== "verified") {
        throw new Error(
          `editVehicleFact: action="verify" requires changes.verification_status="verified"`,
        );
      }
    } else if (action === "retract") {
      if (current.verification_status === "retracted") {
        throw new Error("editVehicleFact: already retracted (idempotent guard)");
      }
      if (changes.verification_status === undefined) {
        changes.verification_status = "retracted";
      } else if (changes.verification_status !== "retracted") {
        throw new Error(
          `editVehicleFact: action="retract" requires changes.verification_status="retracted"`,
        );
      }
    } else if (action === "edit_text") {
      if (changes.fact_text === undefined) {
        throw new Error(`editVehicleFact: action="edit_text" requires changes.fact_text`);
      }
      if (changes.verification_status !== undefined) {
        throw new Error(
          `editVehicleFact: action="edit_text" cannot change verification_status; use a separate verify/retract call`,
        );
      }
    } else if (action === "edit_meta") {
      if (changes.fact_text !== undefined) {
        throw new Error(`editVehicleFact: action="edit_meta" cannot change fact_text`);
      }
      if (changes.verification_status !== undefined) {
        throw new Error(
          `editVehicleFact: action="edit_meta" cannot change verification_status; use a separate verify/retract call`,
        );
      }
    }

    if (changes.confidence !== undefined) {
      if (changes.confidence < 0 || changes.confidence > 1) {
        throw new Error("editVehicleFact: confidence out of [0,1]");
      }
    }

    // Build previous_values snapshot of ONLY fields actually changing.
    const previous_values: Record<string, unknown> = {};
    let hasRealChange = false;
    for (const k of Object.keys(changes) as string[]) {
      const newVal = (changes as Record<string, unknown>)[k];
      if (newVal === undefined) continue;
      const curVal = (current as unknown as Record<string, unknown>)[k];
      if (newVal !== curVal) {
        previous_values[k] = curVal;
        hasRealChange = true;
      }
    }

    if (!hasRealChange) {
      // No-op edit. Do not write an audit row.
      return;
    }

    const now = Date.now();

    const patch: Record<string, unknown> = { ...changes, updated_at: now };
    if (action === "verify") {
      patch.verified_at = now;
    } else if (action === "retract") {
      patch.retracted_at = now;
    }

    // Atomic: patch + audit-insert in one mutation.
    await ctx.db.patch(fact_id, patch);
    await ctx.db.insert("vehicle_facts_audit", {
      fact_id,
      edited_by: editor_id,
      edited_at: now,
      action,
      previous_values: previous_values as Doc<"vehicle_facts_audit">["previous_values"],
      reason,
    });
  },
});

// -----------------------------------------------------------------------------
// reportVehicleFact — user-submitted "this looks wrong" report.
//
// Inserts a fact_reports row + bumps report_count and last_reported_at on
// the underlying vehicle_facts row in the same mutation. NO audit row —
// fact_reports IS the audit trail for reports. The audit table is reserved
// for editor mutations on the fact's content/status.
// -----------------------------------------------------------------------------

export const reportVehicleFact = internalMutation({
  args: {
    fact_id: v.id("vehicle_facts"),
    conversation_id: v.id("ai_conversations"),
    message_id: v.id("ai_messages"),
    reporter_id: v.id("users"),
    user_note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const fact = (await ctx.db.get(args.fact_id)) as Doc<"vehicle_facts"> | null;
    if (!fact) {
      throw new Error(`reportVehicleFact: fact ${args.fact_id} not found`);
    }

    const now = Date.now();

    const reportId = await ctx.db.insert("fact_reports", {
      fact_id: args.fact_id,
      conversation_id: args.conversation_id,
      message_id: args.message_id,
      reported_by: args.reporter_id,
      reported_at: now,
      user_note: args.user_note,
      disposition: "open" as const,
    });

    // Denormalize: bump report_count + last_reported_at on the fact row.
    // Pure telemetry — no audit row required.
    // CI grep rule 1 excludes telemetry patches by allowing only the
    // editVehicleFact / reportVehicleFact / recordVehicleFact paths.
    await ctx.db.patch(args.fact_id, {
      report_count: (fact.report_count ?? 0) + 1,
      last_reported_at: now,
    });

    return reportId;
  },
});

// -----------------------------------------------------------------------------
// resolveFactReport — admin closes out a report by setting its disposition.
//
// Pure update on fact_reports; no mutation to vehicle_facts. If the
// reviewer's resolution involved editing or retracting the underlying fact,
// they call editVehicleFact separately (two-call pattern; each table's
// invariant is local).
// -----------------------------------------------------------------------------

export const resolveFactReport = internalMutation({
  args: {
    report_id: v.id("fact_reports"),
    resolver_id: v.id("users"),
    disposition: v.union(
      v.literal("edited"),
      v.literal("retracted"),
      v.literal("answer_quality"),
      v.literal("no_action"),
    ),
    resolution_note: v.optional(v.string()),
  },
  handler: async (ctx, { report_id, resolver_id, disposition, resolution_note }) => {
    const report = (await ctx.db.get(report_id)) as Doc<"fact_reports"> | null;
    if (!report) {
      throw new Error(`resolveFactReport: report ${report_id} not found`);
    }
    if (report.disposition !== "open") {
      throw new Error(
        `resolveFactReport: report already dispositioned as "${report.disposition}"`,
      );
    }

    await ctx.db.patch(report_id, {
      disposition,
      resolved_by: resolver_id,
      resolved_at: Date.now(),
      resolution_note,
    });
  },
});
