// =============================================================================
// Oto AI -- Vehicle Facts Knowledge Base (post-v3 consolidation)
// =============================================================================
//
// Tier 2 read surface for the consolidated `vehicle_facts` table.
//
// This file is the home of the Tier 2 cascade for chat-time KB retrieval as
// of Wave 5.4. The cascade has three sub-strategies, executed in order, each
// returning the SAME shape so consumers don't branch on tier semantics:
//
//   1. T2_HASH   -- canonical-hash exact match.
//                  `canonicalQuestionKey(question)` -> `vehicle_facts.by_canonical_question`
//                  index point lookup. O(log n). The hot path for repeat asks.
//   2. T2_STRUCT -- structural lookup. `vehicle_config_id -> chassis_code -> engine_code`
//                  walk against `vehicle_facts`. Same fallback ladder as pre-v3.
//   3. T2_TEXT   -- searchIndex BM25-like fuzzy fallback. `vehicle_facts.by_text`
//                  with `fact_text` as the search field and optional `topic_axis`
//                  + `topic` filters. Last resort before falling through to
//                  Tier 3 (web_search), which lives at the chat.ts level.
//
// All three filter out `verification_status === "retracted"` rows BEFORE
// returning to the consumer. Retracted rows are never served to chat.
//
// Authority:
//   * MEMORY_SCHEMA_V3_CONSOLIDATED section 1            (vehicle_facts shape)
//   * RAG_WAVE_5_1_V3_CONSOLIDATED sections 2-5          (cascade order, source tiers,
//                                                  metrics, labeled-set spec)
//   * ARCHITECTURE_v3_AMENDMENTS section F.5             (render_disclaim_tag predicate
//                                                  -- locked here, computed in
//                                                  the cascade helper, consumed
//                                                  as a plain boolean elsewhere)
//
// NOT here:
//   * Tier 1 -- enrichment-owned tables (vehicle_configs, engines, etc.).
//              Surfaced by `get_vehicle_facts` tool in api.oto.vehicleFacts.
//   * Tier 3 -- web_search. Anthropic server-managed tool, dispatched at the
//              chat.ts level. Anything web_search inserts into `vehicle_facts`
//              comes back through Tier 2 on the NEXT turn (source=web_search,
//              verification_status=unverified, render_disclaim_tag=true).
//   * lookupFactsSemantic / embedText / patchEmbedding -- deleted with the
//              vectorIndex in D-3.12. T2_TEXT (BM25 via searchIndex) is the
//              non-vector replacement.
//
// Exports (full inventory after Wave 5.4):
//   * lookupFactsByCanonicalHash -- query. T2_HASH.
//   * lookupFactsStructural      -- query. T2_STRUCT. Pre-v3 surface;
//                                  extended in Wave 5.4 to return the
//                                  v3 fields (verification_status,
//                                  canonical_question_key, render_disclaim_tag)
//                                  in addition to its original shape.
//   * lookupFactsByText          -- query. T2_TEXT.
//   * cascadeTier2               -- action. Runs T2_HASH -> T2_STRUCT -> T2_TEXT
//                                  in order; returns the first hit (or null).
//                                  This is what chat.ts's `retrieve_vehicle_facts`
//                                  callable invokes.
//   * getFactById                -- internal helper.
//   * insertFact                 -- legacy creation mutation. Kept for back-compat;
//                                  new code should prefer `recordVehicleFact`
//                                  in convex/oto/vehicleFactsEditing.ts.
//   * recordFact                 -- action wrapper around insertFact (no
//                                  embedding side-effects).
//
// Heavy KB (Locked Principle #5 -- the moat) -- facts learned for one car
// propagate to similar cars by chassis/engine without re-asking Haiku.
// =============================================================================

import { v } from "convex/values";
import { query, mutation, action, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { api } from "../_generated/api";
import { canonicalQuestionKey } from "./canonicalize";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Original pre-v3 row shape returned by `lookupFactsStructural`. Retained as
 * an additive subset of `Tier2FactRow` for back-compat with any caller that
 * destructures only the legacy fields. Extension is non-breaking.
 */
export interface KBFactRow {
  topic: string;
  topic_axis: string;
  fact_text: string;
  source: string;
  cited_url: string | null;
  confidence: number;
  match_kind: "exact" | "chassis" | "engine" | "model_year" | "semantic";
  fact_id: string;
}

/**
 * Wave 5.4 cascade row shape. Strict superset of `KBFactRow` plus the v3
 * lifecycle fields and the locked `render_disclaim_tag` boolean (computed by
 * `computeRenderDisclaimTag` below -- ONE source of truth for the predicate).
 *
 * NOTE: `verification_status` here is narrowed: rows with `"retracted"` are
 * filtered out before they reach this shape, so consumers see only
 * `"unverified" | "verified"`.
 */
export interface Tier2FactRow {
  fact_id: string;
  fact_text: string;
  topic: string;
  topic_axis: string;
  source: "manufacturer" | "oto_inferred" | "web_search" | "user_confirmed" | "propagated";
  verification_status: "unverified" | "verified";
  confidence: number;
  cited_url: string | null;
  canonical_question_key: string | null;
  /**
   * ARCHITECTURE_v3_AMENDMENTS section F.5 -- locked predicate.
   *   render_disclaim_tag === (source === "web_search" && verification_status === "unverified")
   * Computed exactly once, at the cascade-result level, by `computeRenderDisclaimTag`.
   * Consumers (chat.ts envelope, eval harness, mobile message renderer) READ
   * this boolean and trust it. Do NOT re-derive at the consumer.
   */
  render_disclaim_tag: boolean;
  /**
   * Surfaced for back-compat with pre-v3 callers and for telemetry. Tells
   * the caller which structural step (or hash / text) produced this row.
   */
  match_kind: "exact" | "chassis" | "engine" | "model_year" | "semantic" | "hash" | "text";
}

/**
 * Strict return shape for the Tier 2 cascade. `tier` is `null` ONLY when
 * all three sub-strategies missed; in that case `facts` is the empty array.
 */
export interface Tier2Result {
  tier: "T2_HASH" | "T2_STRUCT" | "T2_TEXT" | null;
  facts: Tier2FactRow[];
}

// ---------------------------------------------------------------------------
// Locked disclaim-tag predicate (one source of truth -- F.5)
// ---------------------------------------------------------------------------

/**
 * THE locked predicate from ARCHITECTURE_v3_AMENDMENTS section F.5. Every Tier 2
 * row that exits this file passes through this function. The mobile renderer
 * and the eval harness consume the boolean -- they MUST NOT re-derive.
 *
 * Returns true iff the row is BOTH web-sourced AND not (yet) verified.
 * Pre-v3 rows whose `verification_status` is still undefined are treated as
 * `"unverified"` here -- same effective behavior as the broader F.6 default
 * rule (web_search defaults to unverified), so the predicate is consistent
 * with the F.6 defaulting that the v3 lifecycle backfill performs.
 */
function computeRenderDisclaimTag(
  source: string,
  verification_status: string | undefined,
): boolean {
  const status = verification_status ?? "unverified";
  return source === "web_search" && status === "unverified";
}

/**
 * Map a raw `vehicle_facts` document (or hand-built equivalent from
 * lookupFactsStructural) into the Tier2FactRow shape, applying the locked
 * disclaim-tag predicate. Filters retracted rows BEFORE this is called --
 * by contract, never invoke this on a retracted row.
 */
function toTier2FactRow(
  row: Doc<"vehicle_facts">,
  match_kind: Tier2FactRow["match_kind"],
): Tier2FactRow {
  const status = (row.verification_status ?? "unverified") as
    | "unverified"
    | "verified"
    | "retracted";
  if (status === "retracted") {
    // Defensive -- callers must filter before mapping. If this fires, it's a
    // bug in the caller, not a data issue.
    throw new Error("toTier2FactRow called on retracted row -- caller bug");
  }
  return {
    fact_id: row._id as unknown as string,
    fact_text: row.fact_text,
    topic: row.topic,
    topic_axis: row.topic_axis,
    source: row.source,
    verification_status: status,
    confidence: row.confidence,
    cited_url: row.cited_url ?? null,
    canonical_question_key: row.canonical_question_key ?? null,
    render_disclaim_tag: computeRenderDisclaimTag(row.source, row.verification_status),
    match_kind,
  };
}

// ---------------------------------------------------------------------------
// QUERY: T2_HASH -- canonical-hash point lookup.
// ---------------------------------------------------------------------------
//
// Hot read path per MEMORY_SCHEMA_V3_CONSOLIDATED section 4 / schema.ts:1792.
// O(log n) on `by_canonical_question`. The caller (cascadeTier2) computes
// the hash; this query only knows the key.

export const lookupFactsByCanonicalHash = query({
  args: {
    canonical_question_key: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Tier2FactRow[]> => {
    const cap = Math.min(20, args.limit ?? 5);
    const rows = await ctx.db
      .query("vehicle_facts")
      .withIndex("by_canonical_question", (q: any) =>
        q.eq("canonical_question_key", args.canonical_question_key),
      )
      .take(cap * 4); // Over-fetch to absorb retracted-row attrition.

    const out: Tier2FactRow[] = [];
    for (const r of rows) {
      if ((r.verification_status ?? "unverified") === "retracted") continue;
      out.push(toTier2FactRow(r, "hash"));
      if (out.length >= cap) break;
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// QUERY: T2_STRUCT -- structural lookup (vehicle_config -> chassis -> engine).
// ---------------------------------------------------------------------------
//
// Wave 5.4: original three-axis fallback preserved. Return shape EXTENDED
// (additive) to include `verification_status`, `canonical_question_key`, and
// the locked `render_disclaim_tag` boolean so chat.ts and the cascade wrapper
// don't need to re-fetch the full Doc. Existing callers that only destructure
// `topic / fact_text / source / ...` keep working unchanged.

type StructuralRow = KBFactRow & {
  verification_status: "unverified" | "verified";
  canonical_question_key: string | null;
  render_disclaim_tag: boolean;
};

export const lookupFactsStructural = query({
  args: {
    topic: v.string(),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    chassis_code: v.optional(v.string()),
    engine_code: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<StructuralRow[]> => {
    const cap = Math.min(20, args.limit ?? 5);
    const seen = new Set<string>();
    const results: StructuralRow[] = [];

    const push = (row: Doc<"vehicle_facts">, match_kind: KBFactRow["match_kind"]) => {
      if (results.length >= cap) return;
      if (seen.has(row._id as unknown as string)) return;
      // Filter retracted rows BEFORE they reach the result set.
      if ((row.verification_status ?? "unverified") === "retracted") return;
      seen.add(row._id as unknown as string);
      const status = (row.verification_status ?? "unverified") as
        | "unverified"
        | "verified";
      results.push({
        topic: row.topic,
        topic_axis: row.topic_axis,
        fact_text: row.fact_text,
        source: row.source,
        cited_url: row.cited_url ?? null,
        confidence: row.confidence,
        match_kind,
        fact_id: row._id as unknown as string,
        verification_status: status,
        canonical_question_key: row.canonical_question_key ?? null,
        render_disclaim_tag: computeRenderDisclaimTag(
          row.source,
          row.verification_status,
        ),
      });
    };

    // 1. Exact vehicle_config match.
    if (args.vehicle_config_id) {
      const rows = await ctx.db
        .query("vehicle_facts")
        .withIndex("by_vehicle_config", (q: any) =>
          q.eq("vehicle_config_id", args.vehicle_config_id).eq("topic", args.topic),
        )
        .take(cap * 2);
      for (const r of rows) push(r, "exact");
    }

    // 2. Chassis fallback.
    if (results.length < cap && args.chassis_code) {
      const rows = await ctx.db
        .query("vehicle_facts")
        .withIndex("by_chassis", (q: any) =>
          q.eq("chassis_code", args.chassis_code).eq("topic", args.topic),
        )
        .take((cap - results.length) * 2);
      for (const r of rows) push(r, "chassis");
    }

    // 3. Engine fallback (engine-axis facts only).
    if (results.length < cap && args.engine_code) {
      const rows = await ctx.db
        .query("vehicle_facts")
        .withIndex("by_engine", (q: any) =>
          q.eq("engine_code", args.engine_code).eq("topic", args.topic),
        )
        .take((cap - results.length) * 2);
      for (const r of rows) push(r, "engine");
    }

    return results;
  },
});

// ---------------------------------------------------------------------------
// QUERY: T2_TEXT -- Convex searchIndex BM25 fallback.
// ---------------------------------------------------------------------------

export const lookupFactsByText = query({
  args: {
    query_text: v.string(),
    topic_axis: v.optional(v.string()),
    topic: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Tier2FactRow[]> => {
    const cap = Math.min(20, args.limit ?? 5);

    const rows = await ctx.db
      .query("vehicle_facts")
      .withSearchIndex("by_text", (q: any) => {
        let builder = q.search("fact_text", args.query_text);
        if (typeof args.topic_axis === "string" && args.topic_axis.length > 0) {
          builder = builder.eq("topic_axis", args.topic_axis);
        }
        if (typeof args.topic === "string" && args.topic.length > 0) {
          builder = builder.eq("topic", args.topic);
        }
        return builder;
      })
      .take(cap * 4);

    const out: Tier2FactRow[] = [];
    for (const r of rows) {
      if ((r.verification_status ?? "unverified") === "retracted") continue;
      out.push(toTier2FactRow(r, "text"));
      if (out.length >= cap) break;
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// ACTION: cascadeTier2 -- the Wave 5.4 read entry point.
// ---------------------------------------------------------------------------

export const cascadeTier2 = action({
  args: {
    question_text: v.string(),
    topic: v.string(),
    topic_axis: v.string(),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    chassis_code: v.optional(v.string()),
    engine_code: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Tier2Result> => {
    const limit = args.limit ?? 5;

    const key = await canonicalQuestionKey(args.question_text);
    const hashHits: Tier2FactRow[] = await ctx.runQuery(
      api.oto.vehicleFactsKB.lookupFactsByCanonicalHash,
      { canonical_question_key: key, limit },
    );
    if (hashHits.length > 0) {
      return { tier: "T2_HASH", facts: hashHits };
    }

    const structRows: StructuralRow[] = await ctx.runQuery(
      api.oto.vehicleFactsKB.lookupFactsStructural,
      {
        topic: args.topic,
        ...(args.vehicle_config_id !== undefined
          ? { vehicle_config_id: args.vehicle_config_id }
          : {}),
        ...(args.chassis_code !== undefined ? { chassis_code: args.chassis_code } : {}),
        ...(args.engine_code !== undefined ? { engine_code: args.engine_code } : {}),
        limit,
      },
    );
    if (structRows.length > 0) {
      const facts: Tier2FactRow[] = structRows.map((r) => ({
        fact_id: r.fact_id,
        fact_text: r.fact_text,
        topic: r.topic,
        topic_axis: r.topic_axis,
        source: r.source as Tier2FactRow["source"],
        verification_status: r.verification_status,
        confidence: r.confidence,
        cited_url: r.cited_url,
        canonical_question_key: r.canonical_question_key,
        render_disclaim_tag: r.render_disclaim_tag,
        match_kind: r.match_kind,
      }));
      return { tier: "T2_STRUCT", facts };
    }

    const textHits: Tier2FactRow[] = await ctx.runQuery(
      api.oto.vehicleFactsKB.lookupFactsByText,
      {
        query_text: args.question_text,
        topic_axis: args.topic_axis,
        topic: args.topic,
        limit,
      },
    );
    if (textHits.length > 0) {
      return { tier: "T2_TEXT", facts: textHits };
    }

    return { tier: null, facts: [] };
  },
});

// ---------------------------------------------------------------------------
// internalQuery: getFactById -- unchanged helper.
// ---------------------------------------------------------------------------

export const getFactById = internalQuery({
  args: { id: v.id("vehicle_facts") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

// ---------------------------------------------------------------------------
// MUTATION: legacy insertFact. New code should prefer recordVehicleFact in
// convex/oto/vehicleFactsEditing.ts.
// ---------------------------------------------------------------------------

export const insertFact = mutation({
  args: {
    topic: v.string(),
    topic_axis: v.union(
      v.literal("vehicle"),
      v.literal("trim"),
      v.literal("chassis"),
      v.literal("engine"),
      v.literal("model_year"),
    ),
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
    source: v.union(
      v.literal("manufacturer"),
      v.literal("oto_inferred"),
      v.literal("web_search"),
      v.literal("user_confirmed"),
      v.literal("propagated"),
    ),
    cited_url: v.optional(v.string()),
    confidence: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const id = await ctx.db.insert("vehicle_facts", {
      ...args,
      created_at: Date.now(),
    });
    return id;
  },
});

// ---------------------------------------------------------------------------
// ACTION: recordFact -- legacy thin wrapper around insertFact.
// ---------------------------------------------------------------------------

export const recordFact = action({
  args: {
    topic: v.string(),
    topic_axis: v.union(
      v.literal("vehicle"),
      v.literal("trim"),
      v.literal("chassis"),
      v.literal("engine"),
      v.literal("model_year"),
    ),
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
    source: v.union(
      v.literal("manufacturer"),
      v.literal("oto_inferred"),
      v.literal("web_search"),
      v.literal("user_confirmed"),
      v.literal("propagated"),
    ),
    cited_url: v.optional(v.string()),
    confidence: v.number(),
  },
  handler: async (ctx, args): Promise<{ id: string }> => {
    const insertArgs = { ...args };
    const id: Id<"vehicle_facts"> = await ctx.runMutation(
      api.oto.vehicleFactsKB.insertFact,
      insertArgs,
    );
    return { id: id as unknown as string };
  },
});
