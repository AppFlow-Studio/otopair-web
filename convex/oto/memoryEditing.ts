// =============================================================================
// Oto AI — Wave 3 memory mutation helpers (consolidated)
// =============================================================================
//
// Sprint 2 Day 1 (2026-05-16). Authority: docs/SPRINT_2/WAVE_3_DESIGN.md §2,
// PM Ruling v3 §4, Decision Log D-2.1 / D-3.2 / D-3.4 / D-3.5 / D-3.6,
// North Star §3.3 / §3.4 / §3.6 / §3.8 / §3.9.
// Owner: Memory Systems Engineer. Mirrors Sprint 1's vehicleFactsEditing.ts
// pattern (audit-row-atomic mutations, written_by validation, EXEMPT-pattern
// adherence, narrow contract enforcement at the helper boundary).
//
// THIS FILE IS THE ONLY SANCTIONED PATH TO MUTATE THE FIVE WAVE 3 TABLES.
//   - conversation_facts            (append-only + soft-retract triple)
//   - user_semantic_facts           (append-only + reinforcement triple + retract triple)
//   - conversation_episodic_control (mutable-in-place with field-class split)
//   - conversation_audit            (STRICTLY append-only — insert only)
//   - kb_topics                     (admin-gated append + write-once deprecate pair)
//
// Day 1 scope: SKELETON ONLY. Each helper has its signature + validators
// committed (the API surface), but the body throws "not yet implemented".
// Day 2 fills the bodies. Day 3 adds CI Rules 12-17 (which reference this
// file path as the canonical mutation surface).
//
// Helper file consolidation (§7 D6): all five tables' mutations in ONE file
// per the Day 1 dispatch ruling. The design doc's split-file recommendation
// (§7 D6) is overridden — one file is easier to grep against in CI and
// matches the dispatch's "canonical mutation surface" framing. Reversibility:
// extract per-table helpers into separate files; ~1hr refactor; CI rule
// patterns update.
//
// CI defense (Day 3): Rules 12-15 will be added to scripts/ci/vehicle-facts-grep.sh.
//   12. conversation_audit is strictly append-only (no patch/replace/delete anywhere)
//   13. conversation_facts mutation gates (ctx.db.patch/replace/delete restricted to this file)
//   14. user_semantic_facts mutation gates (same pattern)
//   15. written_by enum integrity (every insert with the field passes a value)
//   (16. conversation_episodic_control field-class write boundary)
//   (17. kb_topics admin-gated insert)
//
// Mutation surface (12 helpers per the design doc §2):
//
//   --- conversation_facts (§2.1) -----------------------------------------
//   - recordConversationFact     — chat-agent / health-monitor / system append
//   - recordSelectionFact        — mobile-tap (written_by: "user_selection")
//   - retractConversationFact    — soft-retract; sets retract triple atomically
//
//   --- user_semantic_facts (§2.2) ----------------------------------------
//   - recordUserSemanticFact     — initial insert (confidence: 1.0, count: 1)
//   - reinforceUserSemanticFact  — asymptotic bump (1 - (1 - c) * 0.5) + count++
//   - retractUserSemanticFact    — soft-retract; sets retract triple atomically
//
//   --- conversation_episodic_control (§2.3) ------------------------------
//   - commitEpisodic             — model-influenced fields only; expected_turn gate
//   - commitControl              — system-only fields; expected_turn gate
//
//   --- conversation_audit (§2.4) -----------------------------------------
//   - recordTurn                 — THE only legal write path (strict append-only)
//
//   --- kb_topics (§2.5) --------------------------------------------------
//   - registerKbTopic            — admin-gated insert; throws on duplicate key
//   - deprecateKbTopic           — write-once deprecation pair
//
// =============================================================================

import {
  mutation,
  internalMutation,
  query,
  internalQuery,
} from "../_generated/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
// Sprint 2 Day 8 (Wave 3 personalization-in-envelope) — decay-on-read for
// user_semantic_facts. Pure-function module; zero Convex-runtime deps so
// import is cheap and harness-safe. See memoryDecay.ts header for contract.
import { decayConfidence } from "./memoryDecay";
// Sprint 2 Day 9 (Wave 7.3) — PII read-rate-limit primitive. The wrap sites
// in getCrossConversationMemory + getActiveUserSemanticFactsForUser call
// checkPIIRead before the existing read logic; hard-block returns the empty
// array (degraded mode) rather than throwing. See queryMoat.ts PII_TABLES.
import { checkPIIRead } from "./queryMoat";
// Sprint 2 Day 10 (Wave 3 equivalence v2) — paraphrase-tolerant fact matching
// for reinforce + retract paths. Pure-function module; replaces the Day 6
// byte-exact normalize and the Day 7 substring match (both fragile under
// Haiku's third-person paraphrase variance). Adversarial guard preserved;
// see memoryEquivalence.ts header for algorithm + threshold rationale.
import { isEquivalent } from "./memoryEquivalence";

// -----------------------------------------------------------------------------
// Shared validators — mirror the schema unions so a typo here surfaces at
// codegen rather than at runtime. One validator per enum used by the helpers.
// -----------------------------------------------------------------------------

// conversation_facts.fact_type
const conversationFactTypeValidator = v.union(
  v.literal("id_reference"),
  v.literal("preference"),
  v.literal("observation"),
  v.literal("hypothesis"),
  v.literal("user_quote"),
);

// conversation_facts.payload — discriminated union; kind tag matches fact_type.
const conversationFactPayloadValidator = v.union(
  v.object({
    kind: v.literal("id_reference"),
    entity_type: v.string(),
    entity_id: v.string(),
  }),
  v.object({
    kind: v.literal("preference"),
    dimension: v.string(),
    value: v.string(),
  }),
  v.object({
    kind: v.literal("observation"),
    text: v.string(),
  }),
  v.object({
    kind: v.literal("hypothesis"),
    text: v.string(),
    confidence: v.number(),
  }),
  v.object({
    kind: v.literal("user_quote"),
    text: v.string(),
  }),
);

// conversation_facts.written_by
const conversationFactWrittenByValidator = v.union(
  v.literal("chat_agent"),
  v.literal("user_selection"),
  v.literal("health_monitor"),
  v.literal("system"),
);

// user_semantic_facts.fact_type
const userSemanticFactTypeValidator = v.union(
  v.literal("mechanic_preference"),
  v.literal("service_preference"),
  v.literal("communication_style"),
  v.literal("vehicle_quirk"),
  v.literal("history_anchor"),
);

// user_semantic_facts.source
const userSemanticSourceValidator = v.union(
  v.literal("user_stated"),
  v.literal("inferred_behavior"),
  v.literal("mechanic_confirmed"),
);

// user_semantic_facts.written_by
const userSemanticWrittenByValidator = v.union(
  v.literal("chat_agent"),
  v.literal("health_monitor"),
  v.literal("admin_edit"),
  v.literal("system"),
);

// conversation_episodic_control.mood
const moodValidator = v.union(
  v.literal("neutral"),
  v.literal("curious"),
  v.literal("concerned"),
  v.literal("frustrated"),
  v.literal("satisfied"),
);

// conversation_episodic_control.current_flow
const flowValidator = v.union(
  v.literal("diagnostic"),
  v.literal("booking"),
  v.literal("maintenance"),
  v.literal("education"),
  v.literal("status_check"),
  v.literal("off_topic"),
  v.literal("none"),
);

// conversation_episodic_control.current_model
const modelValidator = v.union(
  v.literal("haiku"),
  v.literal("sonnet"),
  v.literal("human_handoff"),
);

// conversation_episodic_control.escalation_state
const escalationStateValidator = v.union(
  v.literal("none"),
  v.literal("requested"),
  v.literal("active"),
  v.literal("human"),
);

// conversation_audit.role
const auditRoleValidator = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("tool"),
);

// conversation_audit.model_used
const auditModelValidator = v.union(
  v.literal("haiku"),
  v.literal("sonnet"),
);

// kb_topics.category
const kbTopicCategoryValidator = v.union(
  v.literal("fluids"),
  v.literal("brakes"),
  v.literal("battery"),
  v.literal("tires"),
  v.literal("filters"),
  v.literal("intervals"),
  v.literal("torque_specs"),
  v.literal("general"),
);

// =============================================================================
// conversation_facts mutations (§2.1)
// =============================================================================

// -----------------------------------------------------------------------------
// recordConversationFact — chat-agent / health-monitor / system append path.
//
// Inserts a new conversation_facts row. NO audit table — the row IS its own
// creation record (append-only discipline IS the audit log).
//
// Caller contract:
//   - fact_type and payload.kind MUST match (helper validates Day 2)
//   - written_by MUST be one of the four legal values (validator-enforced)
//   - "user_selection" is reserved for recordSelectionFact; recordConversationFact
//     rejects written_by: "user_selection" at the body level (Day 2)
//   - source_turn must be >= 0
//
// Day 2 TODO: validate payload.kind matches fact_type, write the row.
// -----------------------------------------------------------------------------
export const recordConversationFact = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    fact_type: conversationFactTypeValidator,
    payload: conversationFactPayloadValidator,
    source_turn: v.number(),
    written_by: conversationFactWrittenByValidator,
  },
  handler: async (
    ctx: MutationCtx,
    args,
  ): Promise<Id<"conversation_facts">> => {
    // Discriminator integrity — payload.kind MUST equal fact_type.
    if (args.payload.kind !== args.fact_type) {
      throw new Error(
        `recordConversationFact: payload.kind="${args.payload.kind}" must match fact_type="${args.fact_type}"`,
      );
    }
    // user_selection is reserved for recordSelectionFact (mobile-tap).
    if (args.written_by === "user_selection") {
      throw new Error(
        `recordConversationFact: written_by="user_selection" is reserved for recordSelectionFact; use that helper for mobile-tap appends.`,
      );
    }
    if (args.source_turn < 0) {
      throw new Error(
        `recordConversationFact: source_turn must be >= 0; got ${args.source_turn}`,
      );
    }

    const now = Date.now();
    const factId = await ctx.db.insert("conversation_facts", {
      conversation_id: args.conversation_id,
      fact_type: args.fact_type,
      payload: args.payload,
      source_turn: args.source_turn,
      created_at: now,
      written_by: args.written_by,
      // retract triple intentionally unset (undefined) on insert.
    });
    return factId;
  },
});

// -----------------------------------------------------------------------------
// recordSelectionFact — mobile-tap path.
//
// Specialization of recordConversationFact for user-selection events.
// Forces written_by: "user_selection" and fact_type: "id_reference".
// Distinguishing user-selection from chat-agent appends is the entire point
// of the established_facts race fix (Doc 1 §3.3).
//
// Day 2 TODO: build the payload from (entity_type, entity_id), insert.
// -----------------------------------------------------------------------------
export const recordSelectionFact = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    entity_type: v.string(),    // "mechanic" | "shop" | "vehicle" | "service"
    entity_id: v.string(),
    source_turn: v.number(),
  },
  handler: async (
    ctx: MutationCtx,
    args,
  ): Promise<Id<"conversation_facts">> => {
    if (!args.entity_type.trim()) {
      throw new Error("recordSelectionFact: entity_type required");
    }
    if (!args.entity_id.trim()) {
      throw new Error("recordSelectionFact: entity_id required");
    }
    if (args.source_turn < 0) {
      throw new Error(
        `recordSelectionFact: source_turn must be >= 0; got ${args.source_turn}`,
      );
    }

    const now = Date.now();
    const factId = await ctx.db.insert("conversation_facts", {
      conversation_id: args.conversation_id,
      fact_type: "id_reference",
      payload: {
        kind: "id_reference",
        entity_type: args.entity_type,
        entity_id: args.entity_id,
      },
      source_turn: args.source_turn,
      created_at: now,
      written_by: "user_selection",
    });
    return factId;
  },
});

// -----------------------------------------------------------------------------
// retractConversationFact — soft-retract.
//
// Sets the three retract fields atomically:
//   retracted_at, retracted_reason, retracted_by_turn
// A row whose retracted_at is already set CANNOT be re-retracted (idempotent
// guard rejects). The row body itself is immutable — retract is a flag, not
// an edit. D-3.2 hill enforced here.
//
// Day 2 TODO: read row, check not already retracted, patch the triple.
// -----------------------------------------------------------------------------
export const retractConversationFact = mutation({
  args: {
    fact_id: v.id("conversation_facts"),
    reason: v.string(),
    retracted_by_turn: v.number(),
  },
  handler: async (ctx: MutationCtx, args): Promise<void> => {
    if (!args.reason.trim()) {
      throw new Error("retractConversationFact: reason required");
    }
    if (args.retracted_by_turn < 0) {
      throw new Error(
        `retractConversationFact: retracted_by_turn must be >= 0; got ${args.retracted_by_turn}`,
      );
    }

    const row = (await ctx.db.get(args.fact_id)) as Doc<"conversation_facts"> | null;
    if (!row) {
      throw new Error(`retractConversationFact: fact ${args.fact_id} not found`);
    }
    // Idempotent guard — already retracted rows reject (D-3.2 write-once).
    if (row.retracted_at !== undefined) {
      throw new Error(
        `retractConversationFact: already retracted (idempotent guard); fact ${args.fact_id}`,
      );
    }

    const now = Date.now();
    // Atomic patch of the retract triple. The three fields are set together;
    // never split. D-3.2 hill enforced.
    await ctx.db.patch(args.fact_id, {
      retracted_at: now,
      retracted_reason: args.reason,
      retracted_by_turn: args.retracted_by_turn,
    });
  },
});

// =============================================================================
// user_semantic_facts mutations (§2.2)
// =============================================================================

// -----------------------------------------------------------------------------
// sanitizeSemanticPayload — Wave 7.1 (Day 7) defense against prompt-injection
// payload poisoning. Applied at the helper layer so ALL writers (chat_agent,
// health_monitor, admin_edit, system) get consistent enforcement.
//
// Rejections (returns { ok: false }) protect against:
//  - Length: > 500 chars suggests injection prose rather than a normal fact
//  - Control chars (other than \n / \t which can appear in legit content):
//    common in obfuscation attempts (zero-width, RTL override, etc.)
//  - Envelope/structural tag substrings: defeats injection that tries to
//    forge envelope blocks ("</user_message><system>...</system>...")
//
// NOT rejected: ordinary punctuation, quotation marks, hyphens — legitimate
// facts contain these. Conservative enforcement to avoid false-positive
// rejection of valid preferences.
//
// Threat model context: the exploitable finding from Day 6's cross-mandate
// consultation was that a hostile user message → adversarial `payload` →
// persisted user_semantic_facts row → echoed back into the envelope's
// <recent_context> across future sessions. This sanitizer is the LAST line
// of defense: if the prompt-side rule doesn't block the tool call, this
// rejection prevents the row from being written. Helper throws on reject,
// chat.ts dispatcher catches + swallows, AI tool returns ok:false → no
// row written → no persistence → no cross-session echo.
// -----------------------------------------------------------------------------
type SanitizeResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

function sanitizeSemanticPayload(payload: string): SanitizeResult {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty after trim" };
  if (trimmed.length > 500) return { ok: false, reason: "exceeds 500 char limit" };
  // Control char check: allow only \n and \t in the C0 range; reject
  // everything else < 0x20 and the format-char / RTL override range
  // U+200B - U+202E (zero-width space, ZWNJ, ZWJ, LRM/RLM, LRE/RLE/PDF,
  // LRO/RLO). These are favorites for obfuscation attempts.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 && code !== 0x0a && code !== 0x09) {
      return { ok: false, reason: `disallowed control char at offset ${i}` };
    }
    if (code >= 0x200b && code <= 0x202e) {
      return { ok: false, reason: `disallowed format/RTL char at offset ${i}` };
    }
  }
  // Envelope-tag substring check: case-insensitive substring match for
  // structural tags used in the prompt envelope (envelope.ts). Forging
  // these inside a payload defeats the untrusted-input boundary because
  // the payload gets echoed verbatim into <recent_context> on future turns.
  const forbidden = [
    "<untrusted_user_input>",
    "</untrusted_user_input>",
    "<conversation_state>",
    "</conversation_state>",
    "<recent_context>",
    "</recent_context>",
    "<system>",
    "</system>",
    "<vehicle_facts>",
    "</vehicle_facts>",
  ];
  const lower = trimmed.toLowerCase();
  for (const tag of forbidden) {
    if (lower.includes(tag)) {
      return { ok: false, reason: `disallowed envelope tag substring "${tag}"` };
    }
  }
  return { ok: true, value: trimmed };
}

// -----------------------------------------------------------------------------
// recordUserSemanticFact — initial append.
//
// Inserts a new user_semantic_facts row at confidence 1.0, observation_count
// 1, first_observed == last_reinforced == now.
//
// (source, written_by) legality matrix (§7 D3, helper-enforced Day 2):
//   - health_monitor MUST NOT write source: "mechanic_confirmed"
//   - system        MUST NOT write source: "mechanic_confirmed"
//   - admin_edit    MAY write any combination
//   - chat_agent    MAY write any source observed in chat
//
// Day 2 TODO: validate the (source, written_by) matrix, insert row.
// -----------------------------------------------------------------------------
export const recordUserSemanticFact = mutation({
  args: {
    user_id: v.id("users"),
    vehicle_id: v.optional(v.id("vehicles")),
    fact_type: userSemanticFactTypeValidator,
    payload: v.string(),
    source: userSemanticSourceValidator,
    written_by: userSemanticWrittenByValidator,
  },
  handler: async (
    ctx: MutationCtx,
    args,
  ): Promise<Id<"user_semantic_facts">> => {
    // Wave 7.1 (Day 7) — payload sanitization MUST run BEFORE the legality
    // matrix. The sanitizer is non-negotiable for every writer; the
    // (source, written_by) gate below is a writer-class invariant. Order
    // matters: an adversarial payload from chat_agent should reject on
    // sanitize, not slip through because the writer-class is "legal".
    const sanitized = sanitizeSemanticPayload(args.payload);
    if (!sanitized.ok) {
      throw new Error(
        `recordUserSemanticFact: payload rejected (${sanitized.reason})`,
      );
    }

    // (source, written_by) legality matrix per design doc §2.2 + §7 D3.
    // Non-chat / non-admin agents MUST NOT write source: "mechanic_confirmed"
    // (deception vector — a background agent forging a verified service
    // record is the threat we're closing).
    if (args.source === "mechanic_confirmed") {
      if (args.written_by === "health_monitor" || args.written_by === "system") {
        throw new Error(
          `recordUserSemanticFact: (source="mechanic_confirmed", written_by="${args.written_by}") is illegal; only chat_agent and admin_edit may write mechanic_confirmed facts.`,
        );
      }
    }

    const now = Date.now();
    const factId = await ctx.db.insert("user_semantic_facts", {
      user_id: args.user_id,
      vehicle_id: args.vehicle_id,
      fact_type: args.fact_type,
      payload: sanitized.value,
      // Initial insert: stored confidence at 1.0 (the asymptote ceiling).
      // Decay is computed at read time by the retrieval layer (Wave 5).
      confidence: 1.0,
      source: args.source,
      written_by: args.written_by,
      first_observed: now,
      last_reinforced: now,
      observation_count: 1,
      // retract triple intentionally unset (undefined) on initial insert.
    });
    return factId;
  },
});

// -----------------------------------------------------------------------------
// reinforceUserSemanticFact — asymptotic confidence bump.
//
// Patches three fields atomically:
//   confidence       = 1 - (1 - confidence) * 0.5    (asymptotes toward 1.0)
//   observation_count = observation_count + 1
//   last_reinforced  = now
//
// All three writes are monotonic (confidence only increases toward 1.0;
// observation_count only increments; last_reinforced only advances), so the
// D-3.2 safety property is preserved structurally. Reinforcing a retracted
// row is illegal and rejected at the helper layer (Day 2).
//
// Day 2 TODO: read row, validate not retracted, compute new confidence,
// patch the triple.
// -----------------------------------------------------------------------------
export const reinforceUserSemanticFact = mutation({
  args: {
    fact_id: v.id("user_semantic_facts"),
  },
  handler: async (ctx: MutationCtx, args): Promise<void> => {
    const row = (await ctx.db.get(args.fact_id)) as Doc<"user_semantic_facts"> | null;
    if (!row) {
      throw new Error(
        `reinforceUserSemanticFact: fact ${args.fact_id} not found`,
      );
    }
    if (row.retracted_at !== undefined) {
      throw new Error(
        `reinforceUserSemanticFact: cannot reinforce retracted fact ${args.fact_id}`,
      );
    }

    // Asymptotic confidence formula per design doc §2.2:
    //   new_confidence = 1 - (1 - old_confidence) * 0.5
    // The factor 0.5 halves the remaining gap to 1.0 on each reinforcement.
    // Asymptotes toward 1.0; never reaches it. Monotonic increase preserves
    // the D-3.2 safety property structurally.
    const current = row.confidence;
    const next = 1 - (1 - current) * 0.5;
    // Defense in depth: clamp at the [0, 1] interval. The formula never
    // exceeds 1.0 for any input in [0, 1], but the row's stored value could
    // in theory have been written outside that range by an earlier bug or
    // an admin_edit bypass. Clamping is cheap and the invariant is hard.
    const clamped = Math.max(0, Math.min(1, next));

    const now = Date.now();
    await ctx.db.patch(args.fact_id, {
      confidence: clamped,
      observation_count: row.observation_count + 1,
      last_reinforced: now,
    });
  },
});

// -----------------------------------------------------------------------------
// retractUserSemanticFact — soft-retract.
//
// Sets the three retract fields atomically:
//   retracted_at, retracted_reason, retracted_at_floor_ms
// Per-user-cap pagination handled at the read layer (§7 D2: 500-row read-
// time pagination, NOT a write-time deletion threshold).
//
// retracted_at_floor_ms is the GC clock for the 365-day cold-cleanup cron
// (Day 5+). Set to retracted_at here.
//
// Day 2 TODO: read row, validate not already retracted, patch the triple.
// -----------------------------------------------------------------------------
export const retractUserSemanticFact = mutation({
  args: {
    fact_id: v.id("user_semantic_facts"),
    reason: v.string(),
  },
  handler: async (ctx: MutationCtx, args): Promise<void> => {
    if (!args.reason.trim()) {
      throw new Error("retractUserSemanticFact: reason required");
    }
    const row = (await ctx.db.get(args.fact_id)) as Doc<"user_semantic_facts"> | null;
    if (!row) {
      throw new Error(
        `retractUserSemanticFact: fact ${args.fact_id} not found`,
      );
    }
    if (row.retracted_at !== undefined) {
      throw new Error(
        `retractUserSemanticFact: already retracted (idempotent guard); fact ${args.fact_id}`,
      );
    }

    const now = Date.now();
    // Set the three retract fields atomically. retracted_at_floor_ms is the
    // GC clock for the 365-day cold-cleanup cron (Day 5+); we initialize it
    // to the same value as retracted_at so the cron can scan by
    // by_retracted_floor and hard-delete rows past the floor.
    await ctx.db.patch(args.fact_id, {
      retracted_at: now,
      retracted_reason: args.reason,
      retracted_at_floor_ms: now,
    });
  },
});

// -----------------------------------------------------------------------------
// findUserSemanticFactByPayload — equivalence lookup for the reinforce wire-in.
//
// Sprint 2 Day 6 (2026-05-17). Wave 3 wire-in primitive (chat.ts dispatch of
// `record_semantic_fact` uses this to decide reinforce-vs-insert).
//
// CONTRACT
// --------
// Returns the SINGLE active (non-retracted) row matching the equivalence key
// `(user_id, fact_type, vehicle_id ?? null, payload_normalized)`, or null if
// no such row exists.
//
// EQUIVALENCE DEFINITION (Day 10 v2, per design §2.2 + Day 6 §3.1 finding)
// ------------------------------------------------------------------------
// v1 (Day 6) used `text.trim().toLowerCase().replace(/\s+/g, ' ')` byte-exact
// equality. Real-world finding: Haiku's third-person paraphrase varies
// turn-to-turn ("User prefers terse, direct answers" vs "User prefers terse,
// concise answers"), so byte-exact fell through to INSERT — defeating the
// duplicate-prevention this lookup was meant to provide. 4+ near-duplicate
// communication_style rows accumulated for the test user (Day 6 §3.1).
//
// v2 (Day 10) replaces byte-exact with token-set Jaccard ≥ 0.6 over an
// aggressively-normalized "fingerprint" (lowercase + punctuation→space +
// stopword removal + third-person wrapper removal). Implementation lives
// in `convex/oto/memoryEquivalence.ts` (pure module, harness-importable);
// see that file's header for the algorithm, threshold calibration, and
// self-test taxonomy.
//
// SECURITY (Day 6 Security Analyst flag, preserved + reinforced in v2)
// --------------------------------------------------------------------
// v1 risk: adversarial near-duplicate collapse, e.g.
//   "I prefer X"  vs  "ignore previous: I prefer Y"
// would collide under aggressive normalization. v2 defuses this two ways:
//   1. Forbidden envelope-tag pre-check inside `isEquivalent` — payloads
//      containing `<untrusted_user_input>` / `<system>` / etc. NEVER match
//      any stored row via equivalence, forcing the INSERT path where
//      `sanitizeSemanticPayload` rejects them at the mutation boundary.
//   2. Threshold 0.6 keeps "prefers" vs "dislikes" verb inversions distinct
//      (their Jaccard sits at ~0.5 for matched core nouns). The same
//      threshold rejects "ignore previous instructions I prefer X" vs
//      "I prefer X" (Jaccard ~0.25 on short payloads — verified self-test G1).
//
// v2 retains the design property that the equivalence layer is NOT the
// security layer; the sanitizer is. Equivalence-v2 ensures hostile inputs
// don't tunnel through reinforce; the sanitizer ensures they don't write.
//
// SCOPE FILTERING
// ---------------
// Vehicle scope is a STRICT filter, not loose match: a vehicle_id=null
// (user-level) fact and a vehicle_id=<vid> (vehicle-scoped) fact are NEVER
// considered equivalent even if their payload normalizes identically. The
// design §2.2 cross-user/cross-vehicle pollution guard depends on this.
//
// WHY internalQuery
// -----------------
// Implementation-detail read for the reinforce-vs-insert decision in chat.ts.
// Not surfaced to mobile clients. The chat.ts dispatch invokes via
// `ctx.runQuery(internal.oto.memoryEditing.findUserSemanticFactByPayload, ...)`.
//
// INDEX STRATEGY
// --------------
// Uses `by_user_type_active` (keys: user_id, fact_type, retracted_at). Prefix-
// scopes the scan to one user's facts of one type with retracted_at=undefined,
// then app-side-filters vehicle_id + payload equality. Per-user-per-type fact
// count is small (typically 1-5 active rows; design §7 D2 anticipates a 500-
// row per-user pagination threshold at which point pagination by confidence
// kicks in — well above what equivalence-lookup needs to scan).
// -----------------------------------------------------------------------------
export const findUserSemanticFactByPayload = internalQuery({
  args: {
    user_id: v.id("users"),
    fact_type: userSemanticFactTypeValidator,
    vehicle_id: v.optional(v.id("vehicles")),
    payload: v.string(),
  },
  returns: v.union(v.id("user_semantic_facts"), v.null()),
  handler: async (
    ctx: QueryCtx,
    args,
  ): Promise<Id<"user_semantic_facts"> | null> => {
    // Cheap fast-fail before scanning rows: an empty/whitespace candidate
    // has no fingerprint and would never match anything. isEquivalent
    // already encodes this but pre-checking avoids the index scan.
    if (args.payload.trim().length === 0) return null;

    // Scan one user's facts of this type that are NOT retracted. The third
    // index key (retracted_at) lets us scope `eq(retracted_at, undefined)`
    // so the cursor walks only the active subset.
    const rows = await ctx.db
      .query("user_semantic_facts")
      .withIndex("by_user_type_active", (q) =>
        q
          .eq("user_id", args.user_id)
          .eq("fact_type", args.fact_type)
          .eq("retracted_at", undefined),
      )
      .collect();

    const targetVehicleId = args.vehicle_id ?? null;
    // v2: collect ALL matching rows, then choose the most-recently-reinforced.
    // Under paraphrase-tolerant matching it is possible (though unusual at
    // typical 1-5 active rows per user-per-type) for the candidate to match
    // multiple stored rows. The most-recently-reinforced wins because that's
    // the row whose stored phrasing is closest to the model's current canon.
    let bestId: Id<"user_semantic_facts"> | null = null;
    let bestTs = -Infinity;
    for (const row of rows) {
      const rowVehicleId = row.vehicle_id ?? null;
      // Strict vehicle-scope match — user-level (null) and vehicle-scoped
      // (<vid>) facts are NEVER equivalent (cross-user pollution guard).
      if (rowVehicleId !== targetVehicleId) continue;
      if (!isEquivalent(args.payload, row.payload)) continue;
      // Prefer the row with the freshest last_reinforced. Reinforce-on-this
      // row keeps the canonical stored phrasing aligned with the current
      // paraphrase, instead of locking onto the oldest stale one.
      if (row.last_reinforced > bestTs) {
        bestTs = row.last_reinforced;
        bestId = row._id;
      }
    }
    return bestId;
  },
});

// =============================================================================
// conversation_episodic_control mutations (§2.3)
// =============================================================================

// -----------------------------------------------------------------------------
// getEpisodicControl — read helper for the wire-in surfaces.
//
// commitEpisodic and commitControl require expected_turn == row.updated_by_turn
// for concurrency-detection (§7 D8 fail-loud). Callers must read the row to
// learn the current updated_by_turn BEFORE invoking the commit. This helper
// is the sanctioned read path so the wire-in lives entirely inside the
// memoryEditing surface area (no callers reach into the table directly).
//
// Returns null when no row exists (pre-init). Wire-in code paths follow the
// pattern: initEpisodicControl -> getEpisodicControl -> commit{Episodic,Control}.
// -----------------------------------------------------------------------------
export const getEpisodicControl = query({
  args: {
    conversation_id: v.id("ai_conversations"),
  },
  handler: async (
    ctx: QueryCtx,
    args,
  ): Promise<Doc<"conversation_episodic_control"> | null> => {
    const row = await ctx.db
      .query("conversation_episodic_control")
      .withIndex("by_conversation", (q) =>
        q.eq("conversation_id", args.conversation_id),
      )
      .first();
    return row;
  },
});

// -----------------------------------------------------------------------------
// initEpisodicControl — idempotent row bootstrap.
//
// Wave 3 Day 6 wire-in (chat.ts integration step 3): the schema is mutable-
// in-place, so `commitEpisodic` and `commitControl` both throw when no row
// exists for the conversation. They cannot lazily insert because the field-
// class split forbids them from touching the OTHER class's fields, and a
// schema-valid initial row needs values for BOTH classes (every field is
// non-optional except the two compression fields). This bootstrap helper
// fills that gap with defaults that mirror today's ai_conversations
// equivalents (mood/current_flow/arc unset → safe neutral seed; current_model
// → "haiku" matches the Sonnet-cascade default; counters → 0; budget_cap →
// 0 since no cost-management policy is wired yet — Wave 5 dispatch sets it).
//
// Idempotent: if a row already exists for conversation_id, returns its _id
// without modification. Multiple wire-in callers (commitEpisodic + commitControl
// landings in chat.ts) call this on every turn; only the FIRST observes an
// insert. Concurrent-call safety relies on Convex's single-mutation-at-a-time
// guarantee per document (the `by_conversation` index is queried first; a
// concurrent insert would surface as a second row, which we then prune is
// out of scope — Wave 3 §7 D8 fail-loud discipline says we'd rather see two
// rows in dev telemetry than silently merge).
//
// Field-class purity: this helper is the ONE legal place that writes BOTH
// classes in a single insert. After the row exists, the field-class split
// is enforced by the separate commit helpers as designed.
// -----------------------------------------------------------------------------
export const initEpisodicControl = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
  },
  handler: async (
    ctx: MutationCtx,
    args,
  ): Promise<Id<"conversation_episodic_control">> => {
    const existing = await ctx.db
      .query("conversation_episodic_control")
      .withIndex("by_conversation", (q) =>
        q.eq("conversation_id", args.conversation_id),
      )
      .first();
    if (existing) {
      return existing._id;
    }
    const now = Date.now();
    const rowId = await ctx.db.insert("conversation_episodic_control", {
      conversation_id: args.conversation_id,
      // Episodic-class defaults — safe-neutral seed; mood "neutral" / flow
      // "none" / arc_summary "" mirror the convention used by the envelope
      // builder when the legacy ai_conversations fields are unset.
      mood: "neutral",
      current_flow: "none",
      flow_turn_count: 0,
      arc_summary: "",
      // compression fields intentionally unset (undefined) — Wave 3.9 / D-3.4
      // populates them when compression actually runs.
      // Control-class defaults — current_model "haiku" matches the Sonnet-
      // cascade default (Locked Principle #2: HAIKU_MODEL is the chat origin);
      // counters zero; budget_cap 0 because no cost-management policy is wired
      // until Wave 5 dispatch sets a real ceiling.
      current_model: "haiku",
      budget_spent_usd: 0,
      budget_cap_usd: 0,
      escalation_count: 0,
      escalation_state: "none",
      sonnet_turns_used: 0,
      sonnet_turn_budget: 0,
      // Concurrency-detection envelope — turn 0 is the seed; the first commit
      // expects updated_by_turn=0.
      updated_at: now,
      updated_by_turn: 0,
    });
    return rowId;
  },
});

// -----------------------------------------------------------------------------
// commitEpisodic — model-influenced fields only.
//
// Patches ONLY episodic fields (mood, current_flow, flow_turn_count,
// arc_summary, compressed_history_summary, compressed_through_turn).
// MUST NOT touch control fields — that's commitControl's exclusive surface.
// Field-class write-authority enforced by separate helpers (D-2.1 LOCKED).
//
// Concurrency: expected_turn must equal the stored updated_by_turn. Mismatch
// triggers reconciliation per §7 D8 policy (throw in v1; fail-loud; soften
// to deterministic-merge only if production telemetry shows races are real).
//
// Day 2 TODO: read row, validate expected_turn == updated_by_turn, patch
// episodic delta + bump updated_at + updated_by_turn.
// -----------------------------------------------------------------------------
export const commitEpisodic = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    expected_turn: v.number(),
    delta: v.object({
      mood: v.optional(moodValidator),
      current_flow: v.optional(flowValidator),
      flow_turn_count: v.optional(v.number()),
      arc_summary: v.optional(v.string()),
      compressed_history_summary: v.optional(v.string()),
      compressed_through_turn: v.optional(v.number()),
    }),
    next_turn: v.number(),
  },
  handler: async (ctx: MutationCtx, args): Promise<void> => {
    const row = await ctx.db
      .query("conversation_episodic_control")
      .withIndex("by_conversation", (q) =>
        q.eq("conversation_id", args.conversation_id),
      )
      .first();
    if (!row) {
      throw new Error(
        `commitEpisodic: no conversation_episodic_control row for conversation ${args.conversation_id}`,
      );
    }
    // Concurrency-detection envelope. expected_turn MUST equal the stored
    // updated_by_turn — a mismatch means a concurrent write happened, which
    // we treat as a hard error per §7 D8 (fail-loud in v1; soften to
    // deterministic-merge only if production telemetry shows races are real).
    if (row.updated_by_turn !== args.expected_turn) {
      throw new Error(
        `commitEpisodic: turn mismatch on conversation ${args.conversation_id}; ` +
          `expected_turn=${args.expected_turn} but stored updated_by_turn=${row.updated_by_turn}`,
      );
    }
    // Monotonic guard on next_turn — turn counters never decrease.
    if (args.next_turn < row.updated_by_turn) {
      throw new Error(
        `commitEpisodic: next_turn (${args.next_turn}) must be >= updated_by_turn (${row.updated_by_turn})`,
      );
    }

    // Build the patch payload using conditional spread to avoid setting
    // optional fields to `undefined` (the Convex strict-mode idiom called
    // out in the role spec's "Convex idiosyncrasies").
    const patch: Record<string, unknown> = {
      updated_at: Date.now(),
      updated_by_turn: args.next_turn,
      ...(args.delta.mood !== undefined ? { mood: args.delta.mood } : {}),
      ...(args.delta.current_flow !== undefined
        ? { current_flow: args.delta.current_flow }
        : {}),
      ...(args.delta.flow_turn_count !== undefined
        ? { flow_turn_count: args.delta.flow_turn_count }
        : {}),
      ...(args.delta.arc_summary !== undefined
        ? { arc_summary: args.delta.arc_summary }
        : {}),
      ...(args.delta.compressed_history_summary !== undefined
        ? { compressed_history_summary: args.delta.compressed_history_summary }
        : {}),
      ...(args.delta.compressed_through_turn !== undefined
        ? { compressed_through_turn: args.delta.compressed_through_turn }
        : {}),
    };
    await ctx.db.patch(row._id, patch);
  },
});

// -----------------------------------------------------------------------------
// commitControl — system-only fields.
//
// Patches ONLY control fields (current_model, budget_spent_usd,
// budget_cap_usd, escalation_count, escalation_state, sonnet_turns_used,
// sonnet_turn_budget). MUST NOT touch episodic fields. The model NEVER
// reaches this helper — CI Rule 16 (Day 3) defends statically.
//
// Day 2 TODO: read row, validate expected_turn, patch control delta + bump
// updated_at + updated_by_turn.
// -----------------------------------------------------------------------------
export const commitControl = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    expected_turn: v.number(),
    delta: v.object({
      current_model: v.optional(modelValidator),
      budget_spent_usd: v.optional(v.number()),
      budget_cap_usd: v.optional(v.number()),
      escalation_count: v.optional(v.number()),
      escalation_state: v.optional(escalationStateValidator),
      sonnet_turns_used: v.optional(v.number()),
      sonnet_turn_budget: v.optional(v.number()),
    }),
    next_turn: v.number(),
  },
  handler: async (ctx: MutationCtx, args): Promise<void> => {
    const row = await ctx.db
      .query("conversation_episodic_control")
      .withIndex("by_conversation", (q) =>
        q.eq("conversation_id", args.conversation_id),
      )
      .first();
    if (!row) {
      throw new Error(
        `commitControl: no conversation_episodic_control row for conversation ${args.conversation_id}`,
      );
    }
    if (row.updated_by_turn !== args.expected_turn) {
      throw new Error(
        `commitControl: turn mismatch on conversation ${args.conversation_id}; ` +
          `expected_turn=${args.expected_turn} but stored updated_by_turn=${row.updated_by_turn}`,
      );
    }
    if (args.next_turn < row.updated_by_turn) {
      throw new Error(
        `commitControl: next_turn (${args.next_turn}) must be >= updated_by_turn (${row.updated_by_turn})`,
      );
    }
    // Monotonic-on-counters discipline (§7 D8). Counters never decrease.
    if (
      args.delta.budget_spent_usd !== undefined &&
      args.delta.budget_spent_usd < row.budget_spent_usd
    ) {
      throw new Error(
        `commitControl: budget_spent_usd monotonic violation; ` +
          `delta=${args.delta.budget_spent_usd} < stored=${row.budget_spent_usd}`,
      );
    }
    if (
      args.delta.escalation_count !== undefined &&
      args.delta.escalation_count < row.escalation_count
    ) {
      throw new Error(
        `commitControl: escalation_count monotonic violation; ` +
          `delta=${args.delta.escalation_count} < stored=${row.escalation_count}`,
      );
    }
    if (
      args.delta.sonnet_turns_used !== undefined &&
      args.delta.sonnet_turns_used < row.sonnet_turns_used
    ) {
      throw new Error(
        `commitControl: sonnet_turns_used monotonic violation; ` +
          `delta=${args.delta.sonnet_turns_used} < stored=${row.sonnet_turns_used}`,
      );
    }

    const patch: Record<string, unknown> = {
      updated_at: Date.now(),
      updated_by_turn: args.next_turn,
      ...(args.delta.current_model !== undefined
        ? { current_model: args.delta.current_model }
        : {}),
      ...(args.delta.budget_spent_usd !== undefined
        ? { budget_spent_usd: args.delta.budget_spent_usd }
        : {}),
      ...(args.delta.budget_cap_usd !== undefined
        ? { budget_cap_usd: args.delta.budget_cap_usd }
        : {}),
      ...(args.delta.escalation_count !== undefined
        ? { escalation_count: args.delta.escalation_count }
        : {}),
      ...(args.delta.escalation_state !== undefined
        ? { escalation_state: args.delta.escalation_state }
        : {}),
      ...(args.delta.sonnet_turns_used !== undefined
        ? { sonnet_turns_used: args.delta.sonnet_turns_used }
        : {}),
      ...(args.delta.sonnet_turn_budget !== undefined
        ? { sonnet_turn_budget: args.delta.sonnet_turn_budget }
        : {}),
    };
    await ctx.db.patch(row._id, patch);
  },
});

// =============================================================================
// conversation_audit mutations (§2.4)
// =============================================================================

// -----------------------------------------------------------------------------
// recordTurn — THE only legal write path for conversation_audit.
//
// STRICT APPEND-ONLY. No patch, no replace, no delete anywhere — CI Rule 12
// (Day 3) enforces. Same logic as vehicle_facts_audit (Sprint 1): if the
// forensic spine becomes mutable, the safety property collapses.
//
// Stamping discipline: prompt_version MUST be passed on every assistant
// turn (Doc 1 §3.1 gap closed). model_used MUST be passed on every
// assistant turn. tool_calls captures the full tool-use payload so Wave 5
// retrieval debugging has a complete trace. Empty content allowed (e.g.,
// an assistant turn that is pure tool_calls).
//
// Coexistence: ai_messages is the mobile-render substrate (chat list);
// conversation_audit is the forensic record. Both written together in the
// same Convex mutation per turn (atomic). Day 2 wires this into the
// chat-loop dispatch so the writes happen together.
//
// Day 2 TODO: enforce role-conditional invariants (prompt_version /
// model_used required for assistant), insert.
// -----------------------------------------------------------------------------
export const recordTurn = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    turn_number: v.number(),
    role: auditRoleValidator,
    content: v.string(),
    tool_calls: v.optional(
      v.array(
        v.object({
          name: v.string(),
          input: v.any(),
          output: v.optional(v.any()),
        }),
      ),
    ),
    model_used: v.optional(auditModelValidator),
    prompt_version: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args,
  ): Promise<Id<"conversation_audit">> => {
    if (args.turn_number < 0) {
      throw new Error(
        `recordTurn: turn_number must be >= 0; got ${args.turn_number}`,
      );
    }

    // Role-conditional invariants per the TODO contract.
    if (args.role === "assistant") {
      if (args.model_used === undefined) {
        throw new Error(
          "recordTurn: role=assistant requires model_used (Doc 1 §3.1 gap closed)",
        );
      }
      if (args.prompt_version === undefined || !args.prompt_version.trim()) {
        throw new Error(
          "recordTurn: role=assistant requires prompt_version (Wave 1.5 protocol)",
        );
      }
    } else if (args.role === "user") {
      // User turns are pure input; model/prompt/tool fields MUST be absent.
      if (args.model_used !== undefined) {
        throw new Error(
          "recordTurn: role=user must not carry model_used",
        );
      }
      if (args.prompt_version !== undefined) {
        throw new Error(
          "recordTurn: role=user must not carry prompt_version",
        );
      }
      if (args.tool_calls !== undefined) {
        throw new Error(
          "recordTurn: role=user must not carry tool_calls",
        );
      }
    } // role === "tool": prompt_version optional; model_used optional.

    // Uniqueness on (conversation_id, turn_number, role) — strict
    // append-only and Doc 1 §3.1's "no double-write" invariant. Convex has
    // no native unique constraint; the helper checks via the
    // by_conversation_turn index scan.
    const existingRows = await ctx.db
      .query("conversation_audit")
      .withIndex("by_conversation_turn", (q) =>
        q
          .eq("conversation_id", args.conversation_id)
          .eq("turn_number", args.turn_number),
      )
      .collect();
    for (const r of existingRows) {
      if (r.role === args.role) {
        throw new Error(
          `recordTurn: duplicate (conversation_id=${args.conversation_id}, turn_number=${args.turn_number}, role="${args.role}") — append-only invariant violation`,
        );
      }
    }

    const now = Date.now();
    const auditId = await ctx.db.insert("conversation_audit", {
      conversation_id: args.conversation_id,
      turn_number: args.turn_number,
      role: args.role,
      content: args.content,
      // Optional fields routed via conditional spread to avoid Convex's
      // optional-with-explicit-undefined edge case.
      ...(args.tool_calls !== undefined ? { tool_calls: args.tool_calls } : {}),
      ...(args.model_used !== undefined ? { model_used: args.model_used } : {}),
      ...(args.prompt_version !== undefined
        ? { prompt_version: args.prompt_version }
        : {}),
      timestamp: now,
    });
    return auditId;
  },
});

// =============================================================================
// kb_topics mutations (§2.5)
// =============================================================================

// -----------------------------------------------------------------------------
// registerKbTopic — admin-gated topic registration.
//
// Inserts a new kb_topics row. Throws on duplicate topic_key (Convex lacks
// native unique indexes; helper enforces by reading by_topic_key first).
// Admin-only: created_by must be Waleed or Temur (enforced via the user_id
// allowlist at the helper layer, Day 2).
//
// retrieval_priority range: agreed with RAG Specialist as a 0..1 ranking
// weight (final coordination in Wave 5 dispatch). Helper validates [0, 1]
// at insert time (Day 2).
//
// Day 2 TODO: check admin allowlist, check duplicate key, insert.
// -----------------------------------------------------------------------------
export const registerKbTopic = mutation({
  args: {
    topic_key: v.string(),
    display_name: v.string(),
    category: kbTopicCategoryValidator,
    expected_unit: v.optional(v.string()),
    retrieval_priority: v.number(),
    created_by: v.id("users"),
  },
  handler: async (
    ctx: MutationCtx,
    args,
  ): Promise<Id<"kb_topics">> => {
    if (!args.topic_key.trim()) {
      throw new Error("registerKbTopic: topic_key required");
    }
    if (!args.display_name.trim()) {
      throw new Error("registerKbTopic: display_name required");
    }
    if (args.retrieval_priority < 0 || args.retrieval_priority > 1) {
      throw new Error(
        `registerKbTopic: retrieval_priority must be in [0, 1]; got ${args.retrieval_priority}`,
      );
    }

    // Idempotent guard — return existing id if (topic_key) already registered.
    // Convex has no native unique index; helper enforces by reading
    // by_topic_key first. Migration backfills depend on this idempotent
    // shape so re-runs are safe (the migration calls this helper per seed).
    const existing = await ctx.db
      .query("kb_topics")
      .withIndex("by_topic_key", (q) => q.eq("topic_key", args.topic_key))
      .first();
    if (existing) {
      return existing._id;
    }

    const now = Date.now();
    const topicId = await ctx.db.insert("kb_topics", {
      topic_key: args.topic_key,
      display_name: args.display_name,
      category: args.category,
      ...(args.expected_unit !== undefined
        ? { expected_unit: args.expected_unit }
        : {}),
      retrieval_priority: args.retrieval_priority,
      created_by: args.created_by,
      created_at: now,
    });
    return topicId;
  },
});

// -----------------------------------------------------------------------------
// deprecateKbTopic — write-once deprecation pair.
//
// Patches deprecated_at + deprecated_reason. Idempotent guard: a row whose
// deprecated_at is already set rejects. topic_key / display_name / category
// / created_by / created_at are NEVER patched after insert — only the
// deprecation pair is mutable. CI Rule 17 (Day 3) defends statically.
//
// Day 2 TODO: read row, validate not already deprecated, patch the pair.
// -----------------------------------------------------------------------------
export const deprecateKbTopic = mutation({
  args: {
    topic_id: v.id("kb_topics"),
    reason: v.string(),
  },
  handler: async (ctx: MutationCtx, args): Promise<void> => {
    if (!args.reason.trim()) {
      throw new Error("deprecateKbTopic: reason required");
    }
    const row = (await ctx.db.get(args.topic_id)) as Doc<"kb_topics"> | null;
    if (!row) {
      throw new Error(`deprecateKbTopic: topic ${args.topic_id} not found`);
    }
    if (row.deprecated_at !== undefined) {
      throw new Error(
        `deprecateKbTopic: already deprecated (idempotent guard); topic ${args.topic_id}`,
      );
    }
    // Write-once deprecation pair. topic_key / display_name / category /
    // created_by / created_at are NEVER patched — only the deprecation pair
    // is mutable. (CI Rule 17 — Day 3 — will defend statically.)
    const now = Date.now();
    await ctx.db.patch(args.topic_id, {
      deprecated_at: now,
      deprecated_reason: args.reason,
    });
  },
});

// =============================================================================
// Cross-conversation memory read path (Wave 3 integration step 4 — §3.4)
// =============================================================================
//
// getCrossConversationMemory — read top-K most-recent conversation_facts rows
// from the user's OTHER conversations (excluding the CURRENT conversation).
//
// Purpose: cross-conversation memory. The legacy envelope's <conversation_state>
// block already shows facts from the CURRENT conversation (ai_conversations.
// established_facts mirror); this query is the SECOND retrieval pipeline beside
// the cascade, surfacing what was established earlier with this user so the AI
// sees prior context across sessions. See WAVE_3_REVIEW_RAG §3 for the cascade-
// boundary synthesis. The block this populates is `<recent_context>` injected
// by envelope.ts.
//
// Index strategy:
//   1. `ai_conversations.by_user_id` — collect this user's conversation_ids,
//      filter out the current one. Bounded by per-user conversation count
//      (small in practice).
//   2. `conversation_facts.by_conversation_active` — for each prior
//      conversation, scan the prefix (conversation_id, retracted_at=undefined)
//      using `.order("desc")` to get newest first, then take(top_K) per
//      conversation. Cap the total at top_K across all conversations.
//
// We do NOT load all conversation_facts and filter in TS — that would be a
// full-table scan. Per-conversation indexed reads are O(top_K * conversations)
// at worst; in practice early-termination once we have top_K total facts keeps
// the scan tight.
//
// Return-shape simplification: the discriminated payload is flattened to a
// single `payload_text` string so the envelope builder can render a one-liner
// per fact without re-doing the discriminator switch.
//
// Why internalQuery: this is an implementation-detail read; not surfaced to
// mobile clients. chat.ts calls it via internal.oto.memoryEditing.* per the
// dispatch contract.
//
// queryMoat routing: conversation_facts is NOT in MOAT_TABLES (it's per-user
// state, not the shared vehicle moat). Direct ctx.db reads are correct here.
// -----------------------------------------------------------------------------

// Truncate fact text at this length to keep the envelope block under ~1KB
// total when 5 facts are listed. Helps stay inside the cached zone's budget.
const PRIOR_FACT_TEXT_TRUNCATE = 500;

// Confidence floor for user_semantic_facts at retrieval time. Per design
// §2.2 retrieval-layer floor: facts whose DECAYED effective_confidence falls
// below 0.1 are dropped from the envelope (still live in the DB; never auto-
// retracted on decay alone). The floor lives HERE, not in `decayConfidence`,
// to keep the decay math pure and composable (the reranker may pick a
// different floor for other consumers; this is the envelope's policy).
//
// Sprint 2 Day 8 (Wave 3 personalization-in-envelope).
const SEMANTIC_FACT_RETRIEVAL_FLOOR = 0.1;

// Reranker score for conversation_facts. Per design §2.2 + RAG review:
// conversation_facts are short-lived and recent (this conversation's siblings),
// so no decay is applied — they enter the score-merge at a fixed weight.
// Slightly above the 0.5-ish midpoint so that a strongly-confident decayed
// semantic fact can outrank a stale conversation fact, but a fresh
// (recently-reinforced) semantic fact still naturally outranks. Adjust in
// follow-up dispatch if the labeled retrieval eval set shows the weighting is
// off.
const CONVERSATION_FACT_BASE_SCORE = 0.7;

export const getCrossConversationMemory = internalQuery({
  args: {
    user_id: v.id("users"),
    current_conversation_id: v.id("ai_conversations"),
    top_K: v.number(),
  },
  // Sprint 2 Day 8 — return shape extended for two-pool merge:
  //   - `source` discriminates "conversation" (conversation_facts) vs
  //     "user_semantic" (user_semantic_facts) for envelope/trace clarity.
  //   - `conversation_id` is OPTIONAL: user_semantic_facts have no
  //     conversation scope (they're user-level facts). Envelope renderer
  //     consumes `fact_type` + `payload_text` + `created_at` only; this
  //     field is for trace/audit consumers.
  //   - `effective_confidence` is OPTIONAL: only populated for user_semantic
  //     rows where decay was applied. Conversation rows omit it. Future
  //     envelope work (Day 8+ flagged) can render this annotation.
  returns: v.array(
    v.object({
      source: v.union(v.literal("conversation"), v.literal("user_semantic")),
      conversation_id: v.optional(v.id("ai_conversations")),
      fact_type: v.string(),
      payload_text: v.string(),
      written_by: v.string(),
      created_at: v.number(),
      effective_confidence: v.optional(v.number()),
    }),
  ),
  handler: async (
    ctx: QueryCtx,
    args,
  ): Promise<
    Array<{
      source: "conversation" | "user_semantic";
      conversation_id?: Id<"ai_conversations">;
      fact_type: string;
      payload_text: string;
      written_by: string;
      created_at: number;
      effective_confidence?: number;
    }>
  > => {
    // Wave 7.3 (Day 9) — PII read-rate-limit per design §2.2 + §2.4.
    // Defense-in-depth: hard-block returns empty array (degraded mode);
    // NEVER throws (would break the chat turn). Counter read is best-effort
    // — any infrastructure fault inside checkPIIRead returns ok=true
    // (fail-open on infra), fail-closed only on actual abuse.
    //
    // Scope decision: the check is applied to `user_semantic_facts` ONLY.
    // Pool A reads `conversation_facts` (this user's prior conversations,
    // conversation-scoped — not user-PII-aggregable in the same way; a
    // single conversation's facts are short-lived and not a privacy
    // exfiltration target on the same axis). Pool B reads
    // `user_semantic_facts` (long-lived user PII — preferences, profile
    // attributes — the privacy target). Hard-block on the user-semantic
    // surface returns [] from the WHOLE query (both pools), because the
    // envelope contract treats this query's result as one merged stream;
    // emitting just Pool A would surface a partial result the caller has
    // no signal to differentiate from "no facts". Defensible: the rate-
    // limit fires only at 5x normal pull rate, so degraded-to-empty for
    // the rest of the 10-min window is the correct conservative posture.
    try {
      const piiCheck = await checkPIIRead(ctx, {
        user_id: args.user_id,
        table_name: "user_semantic_facts",
      });
      if (!piiCheck.ok) {
        console.warn(
          `[oto/memoryEditing.getCrossConversationMemory] PII rate-limit ` +
            `hard-block: reason=${piiCheck.reason} user=${args.user_id} ` +
            `table=user_semantic_facts remaining_s=${piiCheck.remaining_seconds}`,
        );
        return [];
      }
    } catch (err) {
      // Fail-open on the check itself (infra fault). The rate-limit is
      // defense-in-depth, not a hard gate; never break a chat turn here.
      console.warn(
        `[oto/memoryEditing.getCrossConversationMemory] PII check fault ` +
          `(fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (args.top_K <= 0) return [];

    // Two-pool reranker. Each pool produces a sequence of candidate rows
    // tagged with a unified scoring tuple: {score, created_at}. Score is the
    // primary sort key; created_at is the recency tie-breaker.
    type ScoredRow = {
      source: "conversation" | "user_semantic";
      conversation_id?: Id<"ai_conversations">;
      fact_type: string;
      payload_text: string;
      written_by: string;
      created_at: number;
      effective_confidence?: number;
      score: number;
    };
    const candidates: ScoredRow[] = [];

    // -------------------------------------------------------------------------
    // POOL A — conversation_facts from this user's PRIOR conversations.
    // -------------------------------------------------------------------------
    // Step 1 — enumerate this user's conversations, excluding the current.
    const userConversations = await ctx.db
      .query("ai_conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .collect();

    const priorConversationIds: Id<"ai_conversations">[] = [];
    for (const c of userConversations) {
      if (c._id !== args.current_conversation_id) {
        priorConversationIds.push(c._id);
      }
    }

    if (priorConversationIds.length > 0) {
      // Step 2 — per-conversation indexed scan, newest-first, of active
      // (non-retracted) facts. Take up to top_K per conversation; cap overall
      // at top_K across all conversations after a final sort.
      //
      // The `by_conversation_active` index keys are (conversation_id,
      // retracted_at, created_at). We restrict the prefix to
      // conversation_id+retracted_at=undefined so the scan only walks the
      // active subset; .order("desc") returns newest first per the
      // created_at suffix.
      for (const cid of priorConversationIds) {
        const rows = await ctx.db
          .query("conversation_facts")
          .withIndex("by_conversation_active", (q) =>
            q.eq("conversation_id", cid).eq("retracted_at", undefined),
          )
          .order("desc")
          .take(args.top_K);
        for (const r of rows) {
          candidates.push({
            source: "conversation",
            conversation_id: r.conversation_id,
            fact_type: r.fact_type,
            payload_text: extractPayloadText(r.payload),
            written_by: r.written_by,
            created_at: r.created_at,
            // Per design §2.2 + RAG review: conversation_facts get a fixed
            // base score (no decay applied — they're conversation-scoped and
            // intrinsically fresh on the multi-day horizon decay measures).
            score: CONVERSATION_FACT_BASE_SCORE,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // POOL B — user_semantic_facts for this user (active subset, ALL types).
    // -------------------------------------------------------------------------
    // Step 3 — pull active facts via `by_user_active` index (keys: user_id,
    // retracted_at, last_reinforced). Prefix to user_id + retracted_at=undefined
    // so the cursor walks only the live subset; `.order("desc")` sorts by
    // last_reinforced desc (most-recently-reinforced first). Cap at 4×top_K to
    // give the reranker enough headroom while keeping the read bounded —
    // per-user live fact count is typically 1-50 per design §7 D2.
    //
    // No type filter here — the envelope renders ALL fact_types (preferences,
    // mechanic anchors, vehicle quirks) under <recent_context>. Type-specific
    // weighting (communication_style × 1.2, etc.) is deferred per dispatch
    // brief — see "Optional fact_type weighting" follow-up below.
    const semanticRows: Doc<"user_semantic_facts">[] = await ctx.db
      .query("user_semantic_facts")
      .withIndex("by_user_active", (q) =>
        q.eq("user_id", args.user_id).eq("retracted_at", undefined),
      )
      .order("desc")
      .take(args.top_K * 4);

    const nowMs = Date.now();
    for (const r of semanticRows) {
      // Decay-on-read per design §2.2 + D-3.5: effective_confidence =
      // stored * 2^(-elapsed_days / 120). Pure function; safe to call with
      // any stored value (clamped to [0, 1] internally).
      const effective = decayConfidence(
        r.confidence,
        r.last_reinforced,
        nowMs,
      );
      // Floor at 0.1 per design §2.2 retrieval-layer floor. Drop AFTER decay,
      // in the consumer (here), NOT in decayConfidence (which stays pure).
      // Live rows below the floor are still in the DB; never auto-retracted.
      if (effective < SEMANTIC_FACT_RETRIEVAL_FLOOR) continue;
      candidates.push({
        source: "user_semantic",
        // No conversation_id — user_semantic_facts are user-scoped, not
        // conversation-scoped.
        fact_type: r.fact_type,
        payload_text: r.payload,
        written_by: r.written_by,
        // Use last_reinforced as the "recency" timestamp for sort ties —
        // matches the design intent that recently-reinforced facts feel
        // fresher than stale ones in the envelope.
        created_at: r.last_reinforced,
        effective_confidence: effective,
        // Reranker score for user_semantic_facts: post-decay effective
        // confidence. A fact with stored=1.0 freshly reinforced scores ~1.0;
        // a fact at 240d (two half-lives, no reinforcement) scores ~0.25.
        score: effective,
      });
    }

    // -------------------------------------------------------------------------
    // MERGE + RERANK — sort by score DESC, recency DESC as tie-breaker.
    // -------------------------------------------------------------------------
    // The reranker contract per design §2.2: highest-score-wins, with recency
    // as a deterministic tie-breaker so equal-score rows surface in a
    // predictable order (newest first). Top_K=5 by default (chat.ts dispatch
    // — tunable).
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.created_at - a.created_at;
    });
    const capped = candidates.slice(0, args.top_K);

    // Truncate over-long payload_text to keep the envelope block bounded.
    // Truncation is at the query layer (closer to the source) so the
    // envelope builder receives ready-to-render strings.
    for (const r of capped) {
      if (r.payload_text.length > PRIOR_FACT_TEXT_TRUNCATE) {
        r.payload_text =
          r.payload_text.slice(0, PRIOR_FACT_TEXT_TRUNCATE) + "...";
      }
    }
    // Project out the internal `score` field — it's a reranker-internal
    // tuple key not in the returns validator. Without this projection,
    // Convex throws ReturnsValidationError on every successful query and
    // the chat.ts caller's try/catch swallows the error, surfacing an
    // empty envelope (Sprint 2 Day 8 EOD bug, post-Day-8 fix).
    return capped.map(({ score: _score, ...rest }) => rest);
  },
});

// -----------------------------------------------------------------------------
// Discriminated-payload flattener. Each conversation_facts.payload variant
// has a different natural-language carrier; this picks the one that best
// serves a one-line envelope render. Centralised here so the envelope builder
// stays free of payload-shape knowledge.
// -----------------------------------------------------------------------------
function extractPayloadText(
  payload: Doc<"conversation_facts">["payload"],
): string {
  switch (payload.kind) {
    case "observation":
      return payload.text;
    case "user_quote":
      return payload.text;
    case "hypothesis":
      return payload.text;
    case "preference":
      return `${payload.dimension}: ${payload.value}`;
    case "id_reference":
      return `${payload.entity_type}: ${payload.entity_id}`;
  }
}

// =============================================================================
// Retract-lookup helpers (Sprint 2 Day 7 — Wave 3 retract pair wire-in)
// =============================================================================
//
// findActiveUserSemanticFactForRetract + findActiveConversationFactForRetract
// are internalQuery helpers consumed by chat.ts's new `retract_semantic_fact`
// and `retract_conversation_fact` AI tools. They locate the active row a
// model-supplied descriptor refers to so the dispatcher can call the existing
// retractUserSemanticFact / retractConversationFact mutations with a real
// fact_id.
//
// EQUIVALENCE DEFINITION (Day 10 v2 — unified with reinforce path)
// ----------------------------------------------------------------
// Day 7 v1 used `row.payload.toLowerCase().includes(needle)`, which was the
// loosest match that still rejected obvious injection prose. Real-world
// finding: Haiku's `payload_substring` rarely byte-matches a stored row
// because the stored row was itself a third-person paraphrase. Substring
// is fragile in exactly the same way byte-exact reinforce was.
//
// Day 10 v2 unifies both helpers on `isEquivalent` (see
// `convex/oto/memoryEquivalence.ts`). The retract descriptor is treated as
// candidate-payload-A; each stored row is candidate-payload-B; both are
// fingerprinted and Jaccard-compared at threshold 0.6. This is the SAME
// algorithm as reinforce — retract no longer has weaker matching than the
// path that decided whether to insert the row in the first place.
//
// CONFLICT POLICY (unchanged from v1): if MULTIPLE active rows match,
// retract the MOST RECENT row by `_creationTime`. The model is referring
// to the freshest thing it told the user about.
//
// FAILURE-MODE (unchanged from v1): returns null when no match. The
// chat.ts dispatcher logs a warn + returns `{ ok: false, reason: "no
// matching active fact found" }` rather than inserting a compensating row.
//
// SECURITY (unchanged from v1, reinforced by v2 algorithm):
// `isEquivalent` rejects forbidden envelope-tag substrings (mirror of the
// sanitizer's list) so adversarial retract descriptors can never bind to
// a legitimate stored row. Untrusted-input wrapping (Wave 7.1) is still
// envelope.ts's surface; this helper just refuses to act on hostile descriptors.
//
// CROSS-MANDATE NOTE (Day 8 retract case 1 failure):
// The "Actually scratch that — give me terse one-liners" case where Haiku
// fired `record_semantic_fact` instead of `retract_semantic_fact` is
// MODEL-side judgment (refinement vs reversal). v2 equivalence does NOT
// fix it; the model never invoked the retract tool, so this code never ran.
// Day 11+ prompt-side sharpening addresses that gap.
// -----------------------------------------------------------------------------

export const findActiveUserSemanticFactForRetract = internalQuery({
  args: {
    user_id: v.id("users"),
    fact_type: userSemanticFactTypeValidator,
    vehicle_id: v.optional(v.id("vehicles")),
    payload_substring: v.string(),
  },
  returns: v.union(v.id("user_semantic_facts"), v.null()),
  handler: async (
    ctx: QueryCtx,
    args,
  ): Promise<Id<"user_semantic_facts"> | null> => {
    // Cheap fast-fail. v2 isEquivalent already rejects empty fingerprints
    // but we skip the index scan when the descriptor is whitespace-only.
    if (args.payload_substring.trim().length === 0) return null;

    // Scan one user's facts of this type that are NOT retracted. Index keys
    // (user_id, fact_type, retracted_at) let `eq(retracted_at, undefined)`
    // scope the cursor to the active subset before app-side equivalence +
    // vehicle matching. Per-user-per-type live count is small (1-5 typically).
    const rows = await ctx.db
      .query("user_semantic_facts")
      .withIndex("by_user_type_active", (q) =>
        q
          .eq("user_id", args.user_id)
          .eq("fact_type", args.fact_type)
          .eq("retracted_at", undefined),
      )
      .collect();

    const targetVehicleId = args.vehicle_id ?? null;
    // Most-recent-wins per design comment above: sort by _creationTime desc
    // and return the FIRST match. Convex's Doc<> exposes _creationTime on every
    // row so we don't need a secondary index.
    //
    // v2: substring is replaced by `isEquivalent(args.payload_substring,
    // row.payload)`. The arg name `payload_substring` is preserved for caller
    // compatibility; the field is now treated as a paraphrase descriptor
    // rather than a literal substring.
    const matches: Doc<"user_semantic_facts">[] = [];
    for (const row of rows) {
      const rowVehicleId = row.vehicle_id ?? null;
      // Strict vehicle-scope match — user-level (null) and vehicle-scoped
      // (<vid>) facts are distinct even on overlapping content.
      if (rowVehicleId !== targetVehicleId) continue;
      if (isEquivalent(args.payload_substring, row.payload)) {
        matches.push(row);
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b._creationTime - a._creationTime);
    return matches[0]._id;
  },
});

// -----------------------------------------------------------------------------
// findActiveConversationFactForRetract — equivalence lookup for the AI
// `retract_conversation_fact` tool dispatch.
//
// The `conversation_facts` schema (convex/schema.ts §2.1) already carries the
// retract triple (retracted_at + retracted_reason + retracted_by_turn) and the
// existing retractConversationFact mutation patches it atomically. This helper
// only needs to locate the right fact_id for a model-supplied descriptor.
//
// Active filter: `retracted_at === undefined` via the `by_conversation_active`
// index. Equivalence on the row's textual form (via extractPayloadText — same
// flattener the cross-conv memory builder uses, so the descriptor is compared
// against the same one-line representation Haiku saw in <recent_context>).
//
// Day 10 v2: substring → `isEquivalent` (paraphrase-tolerant Jaccard at
// threshold 0.6). The arg name `fact_substring` is preserved for caller
// compatibility but is now interpreted as a paraphrase descriptor.
//
// Most-recent-wins on the rare multi-match case.
// -----------------------------------------------------------------------------

export const findActiveConversationFactForRetract = internalQuery({
  args: {
    conversation_id: v.id("ai_conversations"),
    fact_substring: v.string(),
  },
  returns: v.union(v.id("conversation_facts"), v.null()),
  handler: async (
    ctx: QueryCtx,
    args,
  ): Promise<Id<"conversation_facts"> | null> => {
    // Cheap fast-fail before the index scan; isEquivalent handles empty
    // inputs internally but we save the round-trip.
    if (args.fact_substring.trim().length === 0) return null;

    // by_conversation_active is keyed (conversation_id, retracted_at, created_at).
    // Scope to one conversation's active rows; the index returns them in the
    // schema-default ascending order which we sort below.
    const rows = await ctx.db
      .query("conversation_facts")
      .withIndex("by_conversation_active", (q) =>
        q
          .eq("conversation_id", args.conversation_id)
          .eq("retracted_at", undefined),
      )
      .collect();

    const matches: Doc<"conversation_facts">[] = [];
    for (const row of rows) {
      // Flatten the discriminated payload to the same one-line string the
      // envelope builder shows the model in <recent_context>. The descriptor
      // is matched against THAT representation, not the structured payload.
      const text = extractPayloadText(row.payload);
      if (isEquivalent(args.fact_substring, text)) {
        matches.push(row);
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b._creationTime - a._creationTime);
    return matches[0]._id;
  },
});

// =============================================================================
// Internal mutation surface (migrations + reconciliation only)
// =============================================================================
//
// Migrations (convex/oto/migrations/wave3Backfill.ts) call the public
// helpers above via ctx.runMutation(api.oto.memoryEditing.*). The
// `internalMutation` symbol is pre-imported for future internal-only
// helpers (e.g., reconciliation-driven retractions); Day 2 does not add
// any. The `Doc` type is referenced inline by helper handlers via
// ctx.db.get<...> return inference.
// =============================================================================

void internalMutation;
void (undefined as unknown as Doc<"conversation_facts">);

// =============================================================================
// getActiveUserSemanticFactsForUser — diagnostic / future-consumer surface
// =============================================================================
//
// Sprint 2 Day 8 (Wave 3 personalization-in-envelope). RAG Specialist.
//
// PURPOSE
// -------
// Companion to `getCrossConversationMemory`'s in-line user_semantic_facts
// scan. Exposes the SAME pool as a standalone internalQuery so:
//   1. QA can write cross-conversation READ-path eval cases that assert which
//      semantic facts entered the envelope (without re-deriving the scan).
//   2. Future consumers (Wave 5 reranker, observability cron, admin debug
//      tooling) can reuse one canonical query instead of duplicating the
//      "active user facts, decay-aware, floored at 0.1" walk.
//
// CONTRACT
// --------
// Returns active (non-retracted) user_semantic_facts for one user, decay-
// applied at the supplied `now_ms`, dropped below 0.1, sorted by post-decay
// effective_confidence DESC with last_reinforced DESC as tie-breaker.
// `top_K=0` returns []; negative top_K rejects.
//
// SCOPE
// -----
// User-level only (vehicle_id filter not applied; envelope shows all). A
// future vehicle-scoped variant can be added when an envelope rule needs it.
//
// WHY internalQuery
// -----------------
// Diagnostic / cross-internal use only. Not surfaced to mobile clients.
// Callers invoke via `ctx.runQuery(internal.oto.memoryEditing.getActiveUserSemanticFactsForUser, ...)`.
// -----------------------------------------------------------------------------

const SEMANTIC_FACT_FLOOR_PUBLIC = 0.1;

export const getActiveUserSemanticFactsForUser = internalQuery({
  args: {
    user_id: v.id("users"),
    top_K: v.number(),
    // Optional injectable clock for deterministic tests; defaults to
    // Date.now() at call time. memoryDecay is pure so the same value the
    // production envelope sees can be pinned by tests.
    now_ms: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      fact_id: v.id("user_semantic_facts"),
      fact_type: v.string(),
      payload: v.string(),
      vehicle_id: v.optional(v.id("vehicles")),
      stored_confidence: v.number(),
      effective_confidence: v.number(),
      last_reinforced: v.number(),
      observation_count: v.number(),
    }),
  ),
  handler: async (
    ctx: QueryCtx,
    args,
  ): Promise<
    Array<{
      fact_id: Id<"user_semantic_facts">;
      fact_type: string;
      payload: string;
      vehicle_id?: Id<"vehicles">;
      stored_confidence: number;
      effective_confidence: number;
      last_reinforced: number;
      observation_count: number;
    }>
  > => {
    // Wave 7.3 (Day 9) — PII read-rate-limit per design §2.2 + §2.4.
    // Defense-in-depth: hard-block returns empty array (degraded mode);
    // NEVER throws (would break the chat turn). Counter read is best-effort
    // — any infrastructure fault inside checkPIIRead returns ok=true
    // (fail-open on infra), fail-closed only on actual abuse.
    //
    // This query reads `user_semantic_facts` directly — the canonical PII
    // surface — so the check applies unambiguously here.
    try {
      const piiCheck = await checkPIIRead(ctx, {
        user_id: args.user_id,
        table_name: "user_semantic_facts",
      });
      if (!piiCheck.ok) {
        console.warn(
          `[oto/memoryEditing.getActiveUserSemanticFactsForUser] PII ` +
            `rate-limit hard-block: reason=${piiCheck.reason} ` +
            `user=${args.user_id} table=user_semantic_facts ` +
            `remaining_s=${piiCheck.remaining_seconds}`,
        );
        return [];
      }
    } catch (err) {
      // Fail-open on the check itself (infra fault).
      console.warn(
        `[oto/memoryEditing.getActiveUserSemanticFactsForUser] PII check ` +
          `fault (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (args.top_K <= 0) return [];

    const rows = await ctx.db
      .query("user_semantic_facts")
      .withIndex("by_user_active", (q) =>
        q.eq("user_id", args.user_id).eq("retracted_at", undefined),
      )
      .order("desc")
      .take(args.top_K * 4);

    const nowMs = args.now_ms ?? Date.now();
    const scored: Array<{
      fact_id: Id<"user_semantic_facts">;
      fact_type: string;
      payload: string;
      vehicle_id?: Id<"vehicles">;
      stored_confidence: number;
      effective_confidence: number;
      last_reinforced: number;
      observation_count: number;
    }> = [];
    for (const r of rows) {
      const effective = decayConfidence(r.confidence, r.last_reinforced, nowMs);
      if (effective < SEMANTIC_FACT_FLOOR_PUBLIC) continue;
      scored.push({
        fact_id: r._id,
        fact_type: r.fact_type,
        payload: r.payload,
        ...(r.vehicle_id !== undefined ? { vehicle_id: r.vehicle_id } : {}),
        stored_confidence: r.confidence,
        effective_confidence: effective,
        last_reinforced: r.last_reinforced,
        observation_count: r.observation_count,
      });
    }

    scored.sort((a, b) => {
      if (b.effective_confidence !== a.effective_confidence) {
        return b.effective_confidence - a.effective_confidence;
      }
      return b.last_reinforced - a.last_reinforced;
    });
    return scored.slice(0, args.top_K);
  },
});
