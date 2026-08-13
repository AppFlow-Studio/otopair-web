// =============================================================================
// Oto AI — Reliability observability substrate (Wave 7.2 sibling)
// =============================================================================
//
// Sprint 2 Day 9 (2026-05-17). Authority: Doc 3 §10 (Failure modes and
// graceful degradation); Day 8 EOD ReturnsValidationError post-mortem
// (every static check passed but the chat-turn cross-conv read was broken
// silently for ~12 hrs); Day 6 cross-mandate consultation flag ("21 swallow
// points silent to ops"). Owner: LLM Reliability Engineer.
//
// THIS FILE IS THE ONLY SANCTIONED WRITE PATH FOR reliability_events.
//
// What this file IS:
//   - recordReliabilityEvent: internalMutation that fire-and-forget callers
//     in chat.ts invoke from their catch blocks. Inserts ONE row into
//     reliability_events, truncating error_message at 200 chars.
//   - getRecentEventsBySurface: small internalQuery the future Wave 7.2
//     ladder-state-decision logic (Day 10+) consumes. Indexed trailing-
//     window scan; no aggregation in v1.
//
// What this file IS NOT (yet):
//   - The ladder state machine. See docs/SPRINT_2/WAVE_7_2_DEGRADATION_LADDER.md
//     for the contract; the state machine lives in a future
//     getCurrentDegradationState internalQuery (Day 10+).
//   - A cron-driven GC. The table grows unboundedly today; Day 11+ adds
//     a cron that deletes rows > 7 days old.
//   - Aggregated metrics. v1 returns raw rows; consumers aggregate.
//
// Fire-and-forget pattern (critical):
//   Every caller in chat.ts uses .catch() on the recordReliabilityEvent
//   promise to swallow its own failure. This is the bottom of the
//   reliability stack: observability failure must NEVER break the chat turn.
//   If the table itself becomes unavailable, the chat path continues
//   degraded as today (with stdout warns); we just lose the metric/alert
//   substrate for the duration.
//
// Surface + kind enums (canonical list — keep in sync with schema.ts header):
//   See `KNOWN_SURFACES` and `KNOWN_KINDS` below. New surfaces are added
//   here when a new swallow site is introduced; new kinds when a new
//   failure mode is discovered. Both are documented constants rather than
//   enforced unions so we can extend without schema migration.
//
// PII rules:
//   error_message is truncated to 200 chars. user_id and conversation_id
//   are Convex ids (opaque) — no email / VIN / clerk_user_id ever in this
//   table. metadata is a v.any() bag; callers MUST NOT include PII fields.
//   Day 11+ CI rule will defend the metadata bag.
//
// =============================================================================

import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Canonical surface + kind enums. Documented constants rather than schema
// unions; extending = adding a string here. The schema's v.string validator
// accepts any string but consumers (the Wave 7.2 ladder, future alerts)
// only know about these.
// ---------------------------------------------------------------------------

export const KNOWN_SURFACES = [
  // Anthropic call paths
  "anthropic_call_main",
  "anthropic_call_forced",
  "anthropic_retry_exhausted",
  // Wave 3 wire-ins (one per swallow site in chat.ts)
  "wave3_record_turn",
  "wave3_record_conversation_fact",
  "wave3_commit_episodic",
  "wave3_commit_control_sonnet",
  "wave3_commit_control_haiku",
  "wave3_record_selection_fact",
  "wave3_get_cross_conv_memory",
  "wave3_record_semantic_fact",
  "wave3_record_semantic_fact_reinforce",
  "wave3_retract_semantic_fact",
  "wave3_retract_conversation_fact",
  // Sprint 2 strangler + control-class
  "cascade_strangler_full_cascade",
  "setCurrentModel_sonnet_handoff",
  "setCurrentModel_haiku_handback",
  // Outer boundaries
  "chat_action_uncaught",
  // The self-monitor (bottom of the stack — recorded when the recorder
  // itself fails; we ALSO console.error in chat.ts so this is doubled, but
  // the row is the structured signal)
  "recordReliabilityEvent_itself",
] as const;

export const KNOWN_KINDS = [
  "success",
  "transient_error",
  "validation_error",
  "auth_error",
  "rate_limited",
  "fallback_fired",
  "swallowed",
] as const;

// Max length for the error_message column. 200 chars is enough to identify
// the failure class (the typical Convex error message starts with the
// helper name + a short reason). Longer is wasted bytes; consumers should
// rely on `surface` + `kind` for classification, not free text parsing.
const ERROR_MESSAGE_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// recordReliabilityEvent — the canonical write path.
//
// Called from chat.ts swallow sites inside `.catch()` so the recorder's own
// failure mode (e.g., Convex transport hiccup the moment we try to record
// an Anthropic transport hiccup) does NOT propagate. The caller's .catch()
// wraps THIS .catch() — defense-in-depth.
//
// Args mirror the schema 1:1 except error_message which we truncate here.
// The chat.ts caller does not need to pre-truncate; centralizing the rule
// keeps it consistent across all swallow sites.
// ---------------------------------------------------------------------------

export const recordReliabilityEvent = internalMutation({
  args: {
    surface: v.string(),
    kind: v.string(),
    error_message: v.optional(v.string()),
    latency_ms: v.optional(v.number()),
    user_id: v.optional(v.id("users")),
    conversation_id: v.optional(v.id("ai_conversations")),
    metadata: v.optional(v.any()),
  },
  returns: v.id("reliability_events"),
  handler: async (ctx, args) => {
    // Truncate error_message at 200 chars to keep rows compact. Empty-after-
    // truncation stays as empty string (caller may have passed ""); only
    // strip the field entirely when the caller didn't pass it at all.
    const truncatedMessage =
      typeof args.error_message === "string"
        ? args.error_message.slice(0, ERROR_MESSAGE_MAX_CHARS)
        : undefined;

    return await ctx.db.insert("reliability_events", {
      surface: args.surface,
      kind: args.kind,
      ...(truncatedMessage !== undefined
        ? { error_message: truncatedMessage }
        : {}),
      ...(args.latency_ms !== undefined ? { latency_ms: args.latency_ms } : {}),
      ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
      ...(args.conversation_id !== undefined
        ? { conversation_id: args.conversation_id }
        : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// getRecentEventsBySurface — Wave 7.2 ladder-state-decision read helper.
//
// Indexed trailing-window scan: "give me all events of (surface, kind) at or
// after timestamp T." The state-decision logic (Day 10+) calls this once
// per ladder-state check (~once per turn) for each surface/kind combo it
// cares about. With < 100 rows per 5-minute window in normal load, the
// scan is cheap.
//
// Bounded read: defensively cap at 200 results. The state machine reads
// COUNTS not contents; if the window has > 200 events of one (surface, kind)
// we're already in heavy-degradation territory and the count alone tells us.
// ---------------------------------------------------------------------------

const RECENT_EVENTS_MAX_RESULTS = 200;

export const getRecentEventsBySurface = internalQuery({
  args: {
    surface: v.string(),
    kind: v.string(),
    // Trailing-window floor (timestamp in ms). Caller computes
    // `Date.now() - windowMs`.
    since_ms: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id("reliability_events"),
      _creationTime: v.number(),
      surface: v.string(),
      kind: v.string(),
      error_message: v.optional(v.string()),
      latency_ms: v.optional(v.number()),
      user_id: v.optional(v.id("users")),
      conversation_id: v.optional(v.id("ai_conversations")),
      metadata: v.optional(v.any()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reliability_events")
      .withIndex("by_surface_kind_time", (q) =>
        q
          .eq("surface", args.surface)
          .eq("kind", args.kind)
          .gte("_creationTime", args.since_ms),
      )
      .order("desc")
      .take(RECENT_EVENTS_MAX_RESULTS);
    return rows;
  },
});

// =============================================================================
// Wave 7.2 — degradation-ladder state decision (Sprint 2 Day 10).
// =============================================================================
//
// Authority: docs/SPRINT_2/WAVE_7_2_DEGRADATION_LADDER.md (Day 9 design doc).
// Owner: LLM Reliability Engineer.
//
// This is the runtime consumer of the Day 9 observability substrate. Chat.ts
// reads `getCurrentDegradationState` ONCE per turn at the entrance of
// `sendMessageHandlerCore` and branches behavior per the table in §4.2 of the
// design doc.
//
// V1 (this dispatch) — STATELESS computation:
//   The state machine is "pure-function-of-recent-events": no persisted ladder
//   row, no cached state, no admin override. Every call scans a bounded
//   trailing window of `reliability_events`, counts failure events per
//   (surface, kind) tuple, and returns the most-degraded state whose threshold
//   is met. This is inherently anti-oscillation: a 5-minute window damps
//   transitions naturally (a wave of demote-triggering events must age out of
//   the window before the state can promote back).
//
// V1 deviation from design §2.2 (promotion paths):
//   The design doc envisions explicit "promote on N consecutive successes"
//   logic. The v1 implementation here is simpler: because we ONLY consume
//   failure events (no success events are wired in chat.ts yet — that would
//   require touching the 20 swallow sites Day 9 already wired), the ladder
//   auto-promotes by virtue of the failure events aging out of the 5-minute
//   window. A 5-min-cooldown promotion path is functionally equivalent and
//   structurally simpler than tracking consecutive-success runs in v1.
//   V2 (Day 11+) can add success-event recording at chat.ts call sites and
//   layer in the explicit consecutive-success promotion logic on top.
//
// V1 deviation from design §3.1 (read pattern):
//   The pseudocode in §3.1 reads ALL events in the window then aggregates in
//   memory. v1 here does the same (single indexed scan, in-memory tally) but
//   caps the result at 500 rows to bound the worst-case scan cost. At a 5-min
//   window with the design's failure-rate assumption (~21 surfaces × per-turn
//   trigger × ~1% per-surface failure rate × 100 turns/min = ~21 events/min =
//   ~105 events per 5-min window in steady-state), 500 is ~5× headroom. If
//   we ever cross 500 events in a 5-min window the system is in heavy
//   degradation anyway and DOWN is the correct answer.
//
// Latency budget per design §4.3: ≤50ms p99 for the indexed scan. The single
// indexed query + in-memory tally is well inside that budget at realistic
// event volumes.
//
// Failure-isolation: this query CANNOT throw a state that breaks the chat
// turn. Caller (chat.ts) wraps the read in try/catch and defaults to FULL
// on any read failure (defense-in-depth: a slow / broken observability layer
// must NEVER break the chat path — see design §4.3 closing sentence).
// =============================================================================

// Trailing window for the ladder scan. 5 minutes per design §2.1 rationale
// ("covers normal load-balancer hiccup waves without locking in degradation
// for >5 minutes of recovery time"). Anti-oscillation is naturally damped
// by this window length per design §2.3.
const LADDER_WINDOW_MS = 5 * 60 * 1000;

// Cap on the trailing-window scan. See V1 deviation note above for sizing.
const LADDER_SCAN_MAX_ROWS = 500;

// Demote thresholds per design §2.1 + §9 checkbox defaults.
// FULL → DEGRADED: ≥3 web_search-tagged failures in trailing window.
// DEGRADED → MINIMAL: ≥2 anthropic_retry_exhausted events in trailing window.
//   (Brief specifies 2 here; design §2.1 specifies 3. Brief takes precedence
//   as the implementation contract for this dispatch.)
// MINIMAL → DOWN: ≥4 anthropic_retry_exhausted events in trailing window.
//   (Brief specifies 4 consecutive; design §2.1 specifies 5. Brief precedence
//   as above. "Consecutive" is approximated by "≥4 in the 5-min window"
//   given v1's stateless model; v2 with success-event recording can sharpen
//   this to true consecutive-failures.)
const DEGRADE_THRESHOLD_WEB_SEARCH = 3;
const DEGRADE_THRESHOLD_RETRY_EXHAUST_MINIMAL = 2;
const DEGRADE_THRESHOLD_RETRY_EXHAUST_DOWN = 4;

export type DegradationState = "FULL" | "DEGRADED" | "MINIMAL" | "DOWN";

export const getCurrentDegradationState = internalQuery({
  args: {
    // Optional now override (test/eval seam — pre-seed `reliability_events`
    // rows with synthetic timestamps then pass a matching `now_ms`). In
    // production this is omitted and Date.now() is used.
    now_ms: v.optional(v.number()),
  },
  returns: v.object({
    state: v.union(
      v.literal("FULL"),
      v.literal("DEGRADED"),
      v.literal("MINIMAL"),
      v.literal("DOWN"),
    ),
    // Human-readable transition cause. Logged by chat.ts when state !== FULL
    // for ops observability without requiring a separate alert pipeline.
    reason: v.string(),
    // The window the decision was computed over (for trace + debug).
    window_start_ms: v.number(),
    window_end_ms: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now_ms ?? Date.now();
    const windowStart = now - LADDER_WINDOW_MS;

    // Per-tuple indexed reads. We need to count three (surface, kind) tuples
    // that drive the ladder transitions:
    //   1. cascade_strangler_full_cascade / swallowed   (web_search proxy A)
    //   2. anthropic_call_main / transient_error        (web_search proxy B)
    //   3. anthropic_retry_exhausted / transient_error  (Anthropic exhaust)
    //
    // Each lookup uses the `by_surface_kind_time` index keyed on
    // (surface, kind, _creationTime auto-appended) for a tight bounded scan.
    // We `.take(LADDER_SCAN_MAX_ROWS)` each to cap worst-case cost. Three
    // small indexed reads at ~ tens of rows each beats one wide scan + in-
    // memory tally for typical event volumes.
    //
    // Per design §3.1 + §4.3: latency target ≤50ms p99. Three indexed reads
    // at typical event-volume sizes stay well inside this budget.

    const cascadeSwallows = await ctx.db
      .query("reliability_events")
      .withIndex("by_surface_kind_time", (q) =>
        q
          .eq("surface", "cascade_strangler_full_cascade")
          .eq("kind", "swallowed")
          .gte("_creationTime", windowStart),
      )
      .take(LADDER_SCAN_MAX_ROWS);

    const anthropicMainErrors = await ctx.db
      .query("reliability_events")
      .withIndex("by_surface_kind_time", (q) =>
        q
          .eq("surface", "anthropic_call_main")
          .eq("kind", "transient_error")
          .gte("_creationTime", windowStart),
      )
      .take(LADDER_SCAN_MAX_ROWS);

    const retryExhausts = await ctx.db
      .query("reliability_events")
      .withIndex("by_surface_kind_time", (q) =>
        q
          .eq("surface", "anthropic_retry_exhausted")
          .eq("kind", "transient_error")
          .gte("_creationTime", windowStart),
      )
      .take(LADDER_SCAN_MAX_ROWS);

    // Tally web_search failures: cascade swallows (proxy A) + anthropic_main
    // events with a message that smells like a web_search server-tool error
    // (proxy B; per design §2.1 — web_search errors return through the main
    // call path and are substring-detected on `error_message`).
    let webSearchFailureCount = cascadeSwallows.length;
    for (const row of anthropicMainErrors) {
      if (
        typeof row.error_message === "string" &&
        /web_search/i.test(row.error_message)
      ) {
        webSearchFailureCount++;
      }
    }

    // Retry-exhaust count feeds both DEGRADED→MINIMAL and MINIMAL→DOWN
    // demote paths per design §2.1.
    const retryExhaustCount = retryExhausts.length;

    const windowEnd = now;

    // Apply demotion logic from MOST-degraded to LEAST-degraded. Order is
    // load-bearing: a 5-event retry-exhaust storm should classify as DOWN,
    // not get filtered down to MINIMAL.
    if (retryExhaustCount >= DEGRADE_THRESHOLD_RETRY_EXHAUST_DOWN) {
      return {
        state: "DOWN" as const,
        reason: `anthropic_retry_exhausted x${retryExhaustCount} in trailing ${LADDER_WINDOW_MS / 1000}s window (>=${DEGRADE_THRESHOLD_RETRY_EXHAUST_DOWN})`,
        window_start_ms: windowStart,
        window_end_ms: windowEnd,
      };
    }
    if (retryExhaustCount >= DEGRADE_THRESHOLD_RETRY_EXHAUST_MINIMAL) {
      return {
        state: "MINIMAL" as const,
        reason: `anthropic_retry_exhausted x${retryExhaustCount} in trailing ${LADDER_WINDOW_MS / 1000}s window (>=${DEGRADE_THRESHOLD_RETRY_EXHAUST_MINIMAL})`,
        window_start_ms: windowStart,
        window_end_ms: windowEnd,
      };
    }
    if (webSearchFailureCount >= DEGRADE_THRESHOLD_WEB_SEARCH) {
      return {
        state: "DEGRADED" as const,
        reason: `web_search failures x${webSearchFailureCount} in trailing ${LADDER_WINDOW_MS / 1000}s window (>=${DEGRADE_THRESHOLD_WEB_SEARCH})`,
        window_start_ms: windowStart,
        window_end_ms: windowEnd,
      };
    }
    return {
      state: "FULL" as const,
      reason: "no demote triggers in window",
      window_start_ms: windowStart,
      window_end_ms: windowEnd,
    };
  },
});
