// =============================================================================
// Oto AI — Full cascade entry point for the Wave 5.1 eval harness
// =============================================================================
//
// Sprint 1 Day 4 (2026-05-16). Authority: RAG_WAVE_5_1_V3_CONSOLIDATED §2-§5
// (cascade order, source tiers, metrics), ARCHITECTURE_v3_AMENDMENTS §F.5
// (locked render_disclaim_tag predicate), MEMORY_SCHEMA_V3_CONSOLIDATED §1
// (vehicle_facts shape).
// Owner: RAG Optimization Specialist.
//
// PURPOSE
// -------
// Expose ONE action — `runFullCascade` — that walks Tier 1 → Tier 2 → Tier 3
// in order and returns which tier hit (T1, T2_HASH, T2_STRUCT, T2_TEXT, T3,
// REFUSE, or null) plus the facts. This is what the Wave 5.1 eval harness in
// `scripts/eval/` calls in `--live` mode to measure:
//   • tier-misclassification rate (the harness has expected_tier on each
//     labeled case)
//   • disclaim-tag-correctness (every fact row carries render_disclaim_tag;
//     the harness asserts T1/T2 rows are tag=false unless the underlying row
//     is web-sourced + unverified, and T3 rows are tag=true by definition)
//
// CONTRACT (locked at the cascade boundary)
// -----------------------------------------
//   T1   — render_disclaim_tag = false  (enrichment-owned; verified by definition)
//   T2   — render_disclaim_tag = whatever cascadeTier2 computed (predicate F.5)
//   T3   — render_disclaim_tag = true   (web_search → unverified by definition)
//   REFUSE — facts = []; out-of-scope question; caller decides what to do
//   null — all tiers missed; facts = []
//
// DAY 4 SCOPE
// -----------
//   • Tier 1 — implemented for the common reference-spec questions (oil,
//     tires, coolant, transmission fluid, engine specs). Reads enrichment-
//     owned tables directly. Read-only.
//   • Tier 2 — delegated to `cascadeTier2` from convex/oto/vehicleFactsKB.ts.
//   • Tier 3 — STUBBED. Returns `{ tier: "T3", facts: [] }` when Tier 1/2
//     missed and the caller did NOT pass `no_web_search: true`. Real
//     web_search wiring is Day 5+ work (variable latency + cost — should not
//     ride in the baseline measurement). The eval harness defaults
//     `no_web_search: true` for baseline runs.
//   • REFUSE — placeholder. Day 4 always returns null (or T3 stub) on
//     all-tier-miss. Out-of-scope detection is a separate upstream concern;
//     hook lands here later as another branch above Tier 1.
//
// HARD CONSTRAINTS
// ----------------
// READ-ONLY everywhere. No ctx.db.patch / ctx.db.replace / ctx.db.insert on
// `vehicle_facts`. No mutations to enrichment-owned tables (vehicle_configs,
// engines, transmissions, trim_specs, etc.). CI grep rules 1-3 must stay
// clean — this file holds zero patches, zero replaces, zero inserts.
// =============================================================================

import { action, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";

// ---------------------------------------------------------------------------
// FullCascadeFactRow — the union shape across all three tiers.
// ---------------------------------------------------------------------------
//
// Strict superset of `Tier2FactRow` from vehicleFactsKB.ts: every field that
// matters at the cascade boundary survives. The eval harness can iterate
// `result.facts` without branching on tier and trust that every row has
// the same field set.
//
// Tier 1 rows are synthesized from enrichment-owned table reads (no
// `vehicle_facts` row exists for them) — `fact_id` is a synthetic
// `t1:<table>:<id>:<field>` string, never a real `vehicle_facts._id`. The
// eval harness asserts `fact_id.startsWith("t1:")` for T1 rows.
//
// Tier 3 rows (when implemented) come from web_search → `recordVehicleFact`
// on the NEXT turn; on the in-band T3 path, the stub returns an empty
// array. Either way, T3 rows arriving here always carry tag=true.

export interface FullCascadeFactRow {
  fact_id: string;
  fact_text: string;
  topic: string;
  topic_axis: "vehicle" | "trim" | "chassis" | "engine" | "model_year";
  source:
    | "manufacturer"
    | "oto_inferred"
    | "web_search"
    | "user_confirmed"
    | "propagated"
    | "enrichment"; // synthetic source for Tier 1 rows
  verification_status: "unverified" | "verified";
  confidence: number;
  cited_url: string | null;
  canonical_question_key: string | null;
  /**
   * LOCKED predicate from ARCHITECTURE_v3_AMENDMENTS §F.5 — extended to T1/T3:
   *   T1: false  (enrichment-owned; verified by definition)
   *   T2: computed by cascadeTier2 (web_search + unverified → true; else false)
   *   T3: true   (web_search → unverified by definition)
   * Consumers (eval harness, mobile renderer) READ this. Do NOT re-derive.
   */
  render_disclaim_tag: boolean;
  /**
   * For T1 rows: which structural source produced the row (e.g., "engines",
   * "trim_specs"). For T2 rows: passed through from cascadeTier2. For T3
   * rows: "web_search".
   */
  match_kind:
    | "exact"
    | "chassis"
    | "engine"
    | "model_year"
    | "semantic"
    | "hash"
    | "text"
    | "t1_engine"
    | "t1_transmission"
    | "t1_trim_spec"
    | "t1_vehicle_config"
    | "web_search";
}

export type CascadeTier =
  | "T1"
  | "T2_HASH"
  | "T2_STRUCT"
  | "T2_TEXT"
  | "T3"
  | "REFUSE"
  | null;

export interface FullCascadeResult {
  tier: CascadeTier;
  facts: FullCascadeFactRow[];
  /**
   * Telemetry: which tiers were attempted (in order). Useful for the eval
   * harness to confirm cascade walk order without re-instrumenting.
   * Example: ["T1", "T2_HASH", "T2_STRUCT", "T2_TEXT"] when everything
   * fell through to a miss; ["T1"] when T1 hit immediately.
   */
  attempted_tiers: Array<"T1" | "T2_HASH" | "T2_STRUCT" | "T2_TEXT" | "T3">;
}

// ---------------------------------------------------------------------------
// T1 — topic → enrichment-column mapping
// ---------------------------------------------------------------------------
//
// The eval harness's labeled set covers the common reference questions. Each
// entry below maps a `topic` to the enrichment table + column that answers it
// and a human-readable answer template. If a topic isn't in this map, T1
// returns no rows and the cascade falls through to T2.
//
// Adding a new T1 topic: extend this list + add a case to renderT1Fact.
// Topics here MUST match the topic strings the agent emits on writes.

interface T1TopicSpec {
  topic: string;
  topic_axis: FullCascadeFactRow["topic_axis"];
  sourceTable: "engines" | "transmissions" | "trim_specs" | "vehicle_configs";
  fieldsRequired: ReadonlyArray<string>;
  match_kind: FullCascadeFactRow["match_kind"];
}

const T1_TOPIC_MAP: ReadonlyArray<T1TopicSpec> = [
  // Engine-axis topics (joined from engines table)
  {
    topic: "oil_capacity",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["oil_capacity_qts"],
    match_kind: "t1_engine",
  },
  {
    topic: "oil_viscosity",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["oil_viscosity"],
    match_kind: "t1_engine",
  },
  {
    topic: "oil_spec",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["oil_spec_standard"],
    match_kind: "t1_engine",
  },
  {
    topic: "coolant_type",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["coolant_type"],
    match_kind: "t1_engine",
  },
  {
    topic: "coolant_capacity",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["coolant_capacity_qts"],
    match_kind: "t1_engine",
  },
  {
    topic: "spark_plug_count",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["spark_plug_quantity"],
    match_kind: "t1_engine",
  },
  {
    topic: "engine_displacement",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["displacement_l"],
    match_kind: "t1_engine",
  },
  {
    topic: "engine_cylinders",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["cylinders"],
    match_kind: "t1_engine",
  },
  {
    topic: "engine_aspiration",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["aspiration"],
    match_kind: "t1_engine",
  },
  {
    topic: "fuel_type",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["fuel_type"],
    match_kind: "t1_engine",
  },
  {
    topic: "timing_type",
    topic_axis: "engine",
    sourceTable: "engines",
    fieldsRequired: ["timing_type"],
    match_kind: "t1_engine",
  },
  // Transmission-axis topics
  {
    topic: "transmission_type",
    topic_axis: "trim",
    sourceTable: "transmissions",
    fieldsRequired: ["type"],
    match_kind: "t1_transmission",
  },
  {
    topic: "transmission_fluid_type",
    topic_axis: "trim",
    sourceTable: "transmissions",
    fieldsRequired: ["fluid_type"],
    match_kind: "t1_transmission",
  },
  {
    topic: "transmission_fluid_capacity",
    topic_axis: "trim",
    sourceTable: "transmissions",
    fieldsRequired: ["fluid_capacity_drain_fill_qts"],
    match_kind: "t1_transmission",
  },
  // Trim-spec-axis topics (joined from trim_specs)
  {
    topic: "tire_size_front",
    topic_axis: "trim",
    sourceTable: "trim_specs",
    fieldsRequired: ["tire_size_front"],
    match_kind: "t1_trim_spec",
  },
  {
    topic: "tire_size_rear",
    topic_axis: "trim",
    sourceTable: "trim_specs",
    fieldsRequired: ["tire_size_rear"],
    match_kind: "t1_trim_spec",
  },
  {
    topic: "tire_pressure_front",
    topic_axis: "trim",
    sourceTable: "trim_specs",
    fieldsRequired: ["recommended_tire_pressure_front_psi"],
    match_kind: "t1_trim_spec",
  },
  {
    topic: "tire_pressure_rear",
    topic_axis: "trim",
    sourceTable: "trim_specs",
    fieldsRequired: ["recommended_tire_pressure_rear_psi"],
    match_kind: "t1_trim_spec",
  },
  // Vehicle-config-axis topics
  {
    topic: "drivetrain",
    topic_axis: "trim",
    sourceTable: "vehicle_configs",
    fieldsRequired: ["drivetrain"],
    match_kind: "t1_vehicle_config",
  },
  {
    topic: "brake_fluid_type",
    topic_axis: "trim",
    sourceTable: "vehicle_configs",
    fieldsRequired: ["brake_fluid_type"],
    match_kind: "t1_vehicle_config",
  },
  {
    topic: "ps_fluid_type",
    topic_axis: "trim",
    sourceTable: "vehicle_configs",
    fieldsRequired: ["ps_fluid_type"],
    match_kind: "t1_vehicle_config",
  },
];

function findT1Spec(topic: string): T1TopicSpec | undefined {
  return T1_TOPIC_MAP.find((s) => s.topic === topic);
}

/**
 * Render a T1 fact row from a raw enrichment-table doc + the column value.
 * Synthetic `fact_id` of the form `t1:<table>:<docId>:<field>` — never a
 * real `vehicle_facts._id`. The eval harness can detect T1 rows by
 * `fact_id.startsWith("t1:")`.
 *
 * `render_disclaim_tag` is hard-coded `false` here per the locked F.5
 * extension: T1 rows are enrichment-owned and verified by definition.
 */
function renderT1Fact(
  spec: T1TopicSpec,
  docId: string,
  fieldName: string,
  fieldValue: unknown,
  factText: string,
  citedUrl: string | null,
): FullCascadeFactRow {
  return {
    fact_id: `t1:${spec.sourceTable}:${docId}:${fieldName}`,
    fact_text: factText,
    topic: spec.topic,
    topic_axis: spec.topic_axis,
    source: "enrichment",
    verification_status: "verified",
    confidence: 1.0,
    cited_url: citedUrl,
    canonical_question_key: null,
    render_disclaim_tag: false,
    match_kind: spec.match_kind,
  };
}

// ---------------------------------------------------------------------------
// internalQuery: T1 lookup
// ---------------------------------------------------------------------------
//
// Given a topic + vehicle_config_id (or chassis_code/engine_code), walk the
// enrichment-owned tables and return the matching column value as a
// FullCascadeFactRow. Read-only — no patches, no inserts.
//
// Resolution order:
//   1. If `vehicle_config_id` provided: get config → engine_id → engine doc.
//   2. Else if `engine_code` provided: query `engines` by engine_code.
//   3. Else if `chassis_code` provided: query `vehicle_configs` by chassis_code → engine.
//   4. Else: T1 cannot resolve a scope; return [].
//
// The eval harness's labeled cases provide vehicle_config_id directly so the
// happy path is (1). Code paths (2) and (3) cover synthetic eval cases.

export const lookupT1 = internalQuery({
  args: {
    topic: v.string(),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    chassis_code: v.optional(v.string()),
    engine_code: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<FullCascadeFactRow[]> => {
    const spec = findT1Spec(args.topic);
    if (!spec) return [];

    // Resolve the scoping vehicle_config doc first. Most T1 paths go
    // through it.
    let config: Doc<"vehicle_configs"> | null = null;
    if (args.vehicle_config_id) {
      config = await ctx.db.get(args.vehicle_config_id);
    } else if (args.chassis_code) {
      // vehicle_configs has no `by_chassis` index advertised here; do a
      // narrow filter+take(1) instead of a full scan. The eval harness path
      // typically passes vehicle_config_id directly, so this branch is
      // a low-frequency fallback.
      const configs = await ctx.db
        .query("vehicle_configs")
        .filter((q: any) => q.eq(q.field("chassis_code"), args.chassis_code))
        .take(1);
      config = configs[0] ?? null;
    }

    // Branch per source table.
    if (spec.sourceTable === "engines") {
      // Resolve engine doc.
      let engine: Doc<"engines"> | null = null;
      const engineIdFromConfig = config?.engine_id as
        | Id<"engines">
        | undefined;
      if (engineIdFromConfig) {
        engine = await ctx.db.get(engineIdFromConfig);
      } else if (args.engine_code) {
        const rows = await ctx.db
          .query("engines")
          .filter((q: any) => q.eq(q.field("engine_code"), args.engine_code))
          .take(1);
        engine = rows[0] ?? null;
      }
      if (!engine) return [];
      const fieldName = spec.fieldsRequired[0];
      const value = (engine as unknown as Record<string, unknown>)[fieldName];
      if (value === undefined || value === null) return [];
      const factText = formatT1FactText(spec.topic, value);
      return [
        renderT1Fact(
          spec,
          engine._id as unknown as string,
          fieldName,
          value,
          factText,
          null,
        ),
      ];
    }

    if (spec.sourceTable === "transmissions") {
      const txId = config?.transmission_id as Id<"transmissions"> | undefined;
      if (!txId) return [];
      const tx = await ctx.db.get(txId);
      if (!tx) return [];
      const fieldName = spec.fieldsRequired[0];
      const value = (tx as unknown as Record<string, unknown>)[fieldName];
      if (value === undefined || value === null) return [];
      const factText = formatT1FactText(spec.topic, value);
      return [
        renderT1Fact(
          spec,
          tx._id as unknown as string,
          fieldName,
          value,
          factText,
          null,
        ),
      ];
    }

    if (spec.sourceTable === "trim_specs") {
      // trim_specs is keyed by vehicle_config_id (preferred) or trim_id.
      if (!config?._id) return [];
      let trimSpec: Doc<"trim_specs"> | null = await ctx.db
        .query("trim_specs")
        .withIndex("by_vehicle_config", (q: any) =>
          q.eq("vehicle_config_id", config!._id),
        )
        .first();
      if (!trimSpec) {
        const trimId = (config as any).trim_id as Id<"trims"> | undefined;
        if (trimId) {
          trimSpec = await ctx.db
            .query("trim_specs")
            .withIndex("by_trim", (q: any) => q.eq("trim_id", trimId))
            .first();
        }
      }
      if (!trimSpec) return [];
      const fieldName = spec.fieldsRequired[0];
      const value = (trimSpec as unknown as Record<string, unknown>)[fieldName];
      if (value === undefined || value === null) return [];
      const factText = formatT1FactText(spec.topic, value);
      return [
        renderT1Fact(
          spec,
          trimSpec._id as unknown as string,
          fieldName,
          value,
          factText,
          null,
        ),
      ];
    }

    if (spec.sourceTable === "vehicle_configs") {
      if (!config) return [];
      const fieldName = spec.fieldsRequired[0];
      const value = (config as unknown as Record<string, unknown>)[fieldName];
      if (value === undefined || value === null) return [];
      const factText = formatT1FactText(spec.topic, value);
      return [
        renderT1Fact(
          spec,
          config._id as unknown as string,
          fieldName,
          value,
          factText,
          null,
        ),
      ];
    }

    return [];
  },
});

/**
 * Plain-prose template for T1 fact text. Eval harness fuzzy-matches against
 * this so phrasing is best kept stable. Format: short sentence with the
 * data point in it; no markdown, no leading/trailing whitespace.
 */
function formatT1FactText(topic: string, value: unknown): string {
  const v = String(value);
  switch (topic) {
    case "oil_capacity":
      return `Engine oil capacity is ${v} quarts.`;
    case "oil_viscosity":
      return `Recommended engine oil viscosity is ${v}.`;
    case "oil_spec":
      return `Engine oil specification standard is ${v}.`;
    case "coolant_type":
      return `Coolant type is ${v}.`;
    case "coolant_capacity":
      return `Coolant capacity is ${v} quarts.`;
    case "spark_plug_count":
      return `This engine takes ${v} spark plugs.`;
    case "engine_displacement":
      return `Engine displacement is ${v} liters.`;
    case "engine_cylinders":
      return `This engine has ${v} cylinders.`;
    case "engine_aspiration":
      return `Engine aspiration is ${v}.`;
    case "fuel_type":
      return `Fuel type is ${v}.`;
    case "timing_type":
      return `Timing type is ${v}.`;
    case "transmission_type":
      return `Transmission type is ${v}.`;
    case "transmission_fluid_type":
      return `Transmission fluid type is ${v}.`;
    case "transmission_fluid_capacity":
      return `Transmission fluid drain-and-fill capacity is ${v} quarts.`;
    case "tire_size_front":
      return `Front tire size is ${v}.`;
    case "tire_size_rear":
      return `Rear tire size is ${v}.`;
    case "tire_pressure_front":
      return `Recommended front tire pressure is ${v} psi.`;
    case "tire_pressure_rear":
      return `Recommended rear tire pressure is ${v} psi.`;
    case "drivetrain":
      return `Drivetrain is ${v}.`;
    case "brake_fluid_type":
      return `Brake fluid type is ${v}.`;
    case "ps_fluid_type":
      return `Power steering fluid type is ${v}.`;
    default:
      return `${topic}: ${v}`;
  }
}

// ---------------------------------------------------------------------------
// ACTION: runFullCascade — the eval harness's read entry point.
// ---------------------------------------------------------------------------
//
// Walks T1 → T2 → (T3 stub) in order. Returns on the FIRST tier that
// produces a non-empty fact list. Tier 3 is stubbed for Day 4 — the
// harness passes `no_web_search: true` for baseline runs.
//
// Action (not query) because Step B awaits `cascadeTier2` which itself is
// an action (canonicalQuestionKey is async). Internal-flavored: callable
// from the eval harness via `api.oto.evalHarness.runFullCascade`.
//
// `eval_user_id` is accepted for telemetry / future per-user T3 attribution
// but is NOT used to gate access. The eval harness is internal — there's
// no Clerk-auth check here. Production reads continue to go through
// chat.ts → retrieve_vehicle_facts which uses cascadeTier2 directly.

export const runFullCascade = action({
  args: {
    question_text: v.string(),
    topic: v.string(),
    topic_axis: v.string(),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    chassis_code: v.optional(v.string()),
    engine_code: v.optional(v.string()),
    limit: v.optional(v.number()),
    /**
     * When true (eval baseline default), skip Tier 3. Variable latency +
     * cost of real web_search shouldn't ride in baseline measurement.
     * Hooking the actual web_search tool is Day 5+ work.
     */
    no_web_search: v.optional(v.boolean()),
    eval_user_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<FullCascadeResult> => {
    const attempted: FullCascadeResult["attempted_tiers"] = [];

    // ---- Step A — Tier 1 ----------------------------------------------------
    // Topic-routed lookup against enrichment-owned tables. Read-only.
    attempted.push("T1");
    const t1Rows: FullCascadeFactRow[] = await ctx.runQuery(
      internal.oto.evalHarness.lookupT1,
      {
        topic: args.topic,
        ...(args.vehicle_config_id !== undefined
          ? { vehicle_config_id: args.vehicle_config_id }
          : {}),
        ...(args.chassis_code !== undefined
          ? { chassis_code: args.chassis_code }
          : {}),
        ...(args.engine_code !== undefined
          ? { engine_code: args.engine_code }
          : {}),
      },
    );
    if (t1Rows.length > 0) {
      return { tier: "T1", facts: t1Rows, attempted_tiers: attempted };
    }

    // ---- Step B — Tier 2 (cascadeTier2: HASH → STRUCT → TEXT) ----------------
    attempted.push("T2_HASH"); // attempt marker; cascadeTier2 short-circuits internally
    const t2: {
      tier: "T2_HASH" | "T2_STRUCT" | "T2_TEXT" | null;
      facts: Array<{
        fact_id: string;
        fact_text: string;
        topic: string;
        topic_axis: string;
        source:
          | "manufacturer"
          | "oto_inferred"
          | "web_search"
          | "user_confirmed"
          | "propagated";
        verification_status: "unverified" | "verified";
        confidence: number;
        cited_url: string | null;
        canonical_question_key: string | null;
        render_disclaim_tag: boolean;
        match_kind:
          | "exact"
          | "chassis"
          | "engine"
          | "model_year"
          | "semantic"
          | "hash"
          | "text";
      }>;
    } = await ctx.runAction(api.oto.vehicleFactsKB.cascadeTier2, {
      question_text: args.question_text,
      topic: args.topic,
      topic_axis: args.topic_axis,
      ...(args.vehicle_config_id !== undefined
        ? { vehicle_config_id: args.vehicle_config_id }
        : {}),
      ...(args.chassis_code !== undefined
        ? { chassis_code: args.chassis_code }
        : {}),
      ...(args.engine_code !== undefined
        ? { engine_code: args.engine_code }
        : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });

    if (t2.tier !== null) {
      // Fill out the attempted_tiers list to reflect what cascadeTier2 did
      // internally. We don't have direct visibility into which sub-strategies
      // it tried; conservative reconstruction: if it returned T2_STRUCT, the
      // HASH probe missed too; if T2_TEXT, HASH + STRUCT both missed.
      if (t2.tier === "T2_STRUCT") attempted.push("T2_STRUCT");
      else if (t2.tier === "T2_TEXT") {
        attempted.push("T2_STRUCT");
        attempted.push("T2_TEXT");
      }
      // Pass-through; the cascade already widened the row to include the
      // locked render_disclaim_tag. Narrow source → FullCascadeFactRow.source
      // (which is a superset including "enrichment" — fine for assignment).
      const facts: FullCascadeFactRow[] = t2.facts.map((r) => ({
        fact_id: r.fact_id,
        fact_text: r.fact_text,
        topic: r.topic,
        topic_axis: r.topic_axis as FullCascadeFactRow["topic_axis"],
        source: r.source,
        verification_status: r.verification_status,
        confidence: r.confidence,
        cited_url: r.cited_url,
        canonical_question_key: r.canonical_question_key,
        render_disclaim_tag: r.render_disclaim_tag,
        match_kind: r.match_kind,
      }));
      return { tier: t2.tier, facts, attempted_tiers: attempted };
    }
    // T2 fully missed → record HASH+STRUCT+TEXT as attempted.
    attempted.push("T2_STRUCT");
    attempted.push("T2_TEXT");

    // ---- Step C — Tier 3 STUB ----------------------------------------------
    // TODO(Day 5): wire real web_search here. Until then, return T3 with
    // empty facts so the eval harness can observe the all-tier-miss path
    // without paying web_search latency. Caller can pass `no_web_search:
    // true` (eval-baseline default) to skip even the stub annotation.
    if (args.no_web_search === true) {
      // Pure "all-tier-miss" — distinct from T3 attempted in the result.
      return { tier: null, facts: [], attempted_tiers: attempted };
    }
    attempted.push("T3");
    return { tier: "T3", facts: [], attempted_tiers: attempted };

    // ---- REFUSE branch ------------------------------------------------------
    // Not reachable on the Day 4 happy path; the upstream out-of-scope
    // refusal logic (when it lands) should short-circuit BEFORE this action
    // is called. If a future caller needs to surface a refusal through this
    // entry point, return:
    //   return { tier: "REFUSE", facts: [], attempted_tiers: attempted };
    // The caller decides what to do with it.
  },
});
