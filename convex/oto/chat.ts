// =============================================================================
// Oto AI — sendMessage action (uncached zone + tool-use loop)
// =============================================================================
//
// Phase 1 spike, slice 3: tool wiring.
// User message → envelope → Anthropic (with tools) → maybe tool_use → dispatch
//   → tool_result → Anthropic again → final text → persistence.
//
// What this IS:
//   • Auth-checked entry point for chat turns.
//   • Loads user + active-vehicle context and builds the uncached envelope.
//   • Sends three tools to Haiku for this slice:
//       list_services_for_vehicle — returns the full 23-service catalog
//                                    (compatibility filtering deferred)
//       get_service_details       — slug → full record
//       render_quick_replies      — packages quickReplies onto the message
//   • Runs the tool-use loop up to MAX_TOOL_ITERATIONS (5). If the cap is hit,
//     calls Anthropic one final time with `tools: []` so the model must emit
//     text and the conversation always terminates.
//   • Collects render directives across iterations and returns them alongside
//     the final text.
//   • Persists both turns to ai_messages unchanged.
//
// What this IS NOT (yet):
//   • No cache_control / prompt caching.
//   • No telemetry (cache hit, token counts, latency).
//   • No real system prompt (still the 1-line stub).
//   • No KB chunks, no due_soon.
//   • No streaming, no retries / backoff.
//   • No compatibility filtering on list_services_for_vehicle — Schema Gap 4
//     in tool-inventory.md. Returns all 23 unfiltered for this slice.
//
// PII rules (State Contract §5):
//   • Tool inputs and the AI's prompt see the user's first name only.
//   • Vehicle is referenced by Convex document id (opaque). NEVER by VIN.
//   • The AI does NOT receive userId / clerkUserId / email — chat.ts injects
//     identity into callables via closure, never via tool args.
// =============================================================================

import { action } from "../_generated/server";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { v } from "convex/values";
import {
  buildEnvelope,
  formatDisplayString,
  knowledgeLabel,
  pickActiveVehicleRow,
  type DisplayInfo,
  type OwnedVehicleRow,
  type ResolvedVehicle,
} from "./envelope";
import { OTO_TOOL_CATEGORY, OTO_TOOLS, OTOPAIR_SERVICE_SLUGS } from "./tools";
import {
  executeTool,
  mergeRenderDirectives,
  type ToolCallables,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./dispatcher";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } from "./system_prompt";
import { canonicalQuestionKey } from "./canonicalize";
import { internal } from "../_generated/api";
import {
  assembleTelemetryRow,
  shouldFlagStateSkip,
  type TurnSample,
} from "./telemetryAssembly";
import { mapToolMoodToEpisodic } from "./moodMap";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";
// Default model used when ai_conversations.current_model is unset/null.
// Per-turn selection happens in sendMessageHandler based on the conversation's
// current_model field — Sonnet cascade (Locked Principle #2).
const MODEL = HAIKU_MODEL;
const MAX_TOKENS = 1024;
const HISTORY_TURNS = 10;
const MAX_TOOL_ITERATIONS = 5;

// System prompt body lives in ./system-prompt.ts (versioned artifact). The
// SYSTEM_PROMPT_VERSION import is unused at runtime today but worth keeping
// in scope so the next slice (telemetry / caching) can log it per turn.
void SYSTEM_PROMPT_VERSION;

// Subset of OTO_TOOLS to surface in this slice. Add tool names here as later
// slices wire them; the dispatcher already covers the routing for the full
// inventory, so this list is the only place to extend.
const TOOL_NAMES_V1 = [
  // Data tools — vehicle / service / booking
  "list_services_for_vehicle",
  "get_service_details",
  "get_vehicle_health",
  "get_projected_health_score",
  "get_bookings",
  // Booking Status — Sprint 3 Day 5 §14.3
  "get_pending_bookings",
  "get_due_services",
  "get_vehicle_facts",
  // Data tools — knowledge base + lookups for general car questions
  "lookup_vehicle_spec",
  "retrieve_vehicle_facts",
  "record_vehicle_fact",
  // Data tools — Loyalty / rewards (Sprint 3 Day 3 §11 + §14.2)
  "get_rewards_summary",
  "get_loyalty_points_history",
  "get_available_redemptions",
  "get_loyalty_program_info",
  // State tools (side-effect; Oto-maintained conversation memory)
  "update_conversation_state",
  "record_semantic_fact",
  "retract_semantic_fact",
  "retract_conversation_fact",
  // Render tools — general-purpose chat UI affordances.
  "render_quick_replies",
  "render_record_confirmation",
  "render_vehicle_update",
  // Booking flow — Sprint 4 Day 1 Pass B consolidation. Single terminal
  // render replacing the prior 6-tool chain (render_service_picker /
  // render_diagnostic_form / render_shop_carousel / render_time_selector /
  // render_booking_confirmation / navigate_to_payment — all deprecated). The
  // mobile BookServiceComponent handles every sub-stage internally including
  // the pay-screen redirect; Oto fires this ONCE per booking cycle.
  "render_book_service",
  // Render tools — app-navigation redirects (§14.1, Sprint 3 Day 2 Pass A).
  // 8-destination enum; terminal render; dispatcher packages into
  // ChatMessage.linkButton.
  "render_link_button",
  // Booking Status — Sprint 3 Day 5 §14.3
  "render_booking_card",
  "render_bookings_list",
  // Model routing — Phase 2 Sonnet cascade (Locked Principle #2)
  "request_sonnet_handoff",
  "request_haiku_handback",
] as const;

// Server-managed Anthropic tools. The model invokes these directly; we do
// NOT dispatch them in our loop. Append them to the tools array in
// callAnthropic. web_search results come back as content blocks inside the
// assistant message; the model then uses them to compose its response.
//
// Note: the actual type string ("web_search_20250305") is set by Anthropic
// and may rotate. Keep this list narrow.
const SERVER_MANAGED_TOOLS: ReadonlyArray<unknown> = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 3,
  },
];
const SERVER_MANAGED_TOOL_NAMES = new Set(["web_search"]);
const TOOLS_FOR_HAIKU = OTO_TOOLS.filter((t) =>
  (TOOL_NAMES_V1 as readonly string[]).includes(t.name),
);

// Module-load invariant: every tool advertised to Haiku must have a handler.
// Data tools require a callable in buildCallables; render/navigation tools are
// handled by dispatcher.ts. Drift between TOOL_NAMES_V1, buildCallables, and
// OTO_TOOL_CATEGORY surfaces here loudly instead of as silent "not_implemented"
// tool_result errors that the model then narrates as "I don't have access."
//
// console.error (not throw) — a throw at module load would brick every chat
// request on misconfig; the error here is loud enough in Convex logs to catch.
{
  const DATA_TOOL_CALLABLE_NAMES = new Set([
    "list_services_for_vehicle",
    "get_service_details",
    "get_vehicle_health",
    "get_projected_health_score",
    "get_bookings",
    // Booking Status — Sprint 3 Day 5 §14.3
    "get_pending_bookings",
    "get_due_services",
    "get_vehicle_facts",
    "lookup_vehicle_spec",
    "retrieve_vehicle_facts",
    // Loyalty Tier 2 expansion (Sprint 3 Day 3 §11 + §14.2).
    "get_rewards_summary",
    "get_loyalty_points_history",
    "get_available_redemptions",
    "get_loyalty_program_info",
  ]);
  const STATE_TOOL_CALLABLE_NAMES = new Set([
    "update_conversation_state",
    "record_vehicle_fact",
    "record_semantic_fact",
    "retract_semantic_fact",
    "retract_conversation_fact",
    "request_sonnet_handoff",
    "request_haiku_handback",
  ]);
  const renderToolNames = new Set(
    Object.entries(OTO_TOOL_CATEGORY)
      .filter(([, cat]) => cat === "render")
      .map(([name]) => name),
  );
  const navToolNames = new Set(
    Object.entries(OTO_TOOL_CATEGORY)
      .filter(([, cat]) => cat === "navigation")
      .map(([name]) => name),
  );
  for (const name of TOOL_NAMES_V1) {
    const wired =
      DATA_TOOL_CALLABLE_NAMES.has(name) ||
      STATE_TOOL_CALLABLE_NAMES.has(name) ||
      renderToolNames.has(name) ||
      navToolNames.has(name);
    if (!wired) {
      console.error(
        `[oto/chat] CONFIG ERROR: tool "${name}" is in TOOL_NAMES_V1 but has no handler. ` +
          `Data/state tools need a callable in buildCallables; render/nav tools need an entry in OTO_TOOL_CATEGORY.`,
      );
    }
  }

  // Block 4 — second-half invariant: every tool name the SYSTEM PROMPT
  // references must be in TOOL_NAMES_V1. Closes the v0.5/v0.6 drift footgun
  // where the prompt advertised tools the chat action wasn't surfacing to
  // Haiku — Anthropic returns tool_use blocks for tool names the request
  // didn't actually list, but the dispatcher then fails silently with
  // not_implemented, which Haiku narrates as "I don't have access to that
  // right now." Scan the prompt for `name` pattern matches against the full
  // OTO_TOOL_NAMES list; anything mentioned in the prompt that's NOT wired
  // gets logged loudly.
  {
    const promptRefs = new Set<string>();
    for (const candidate of Object.keys(OTO_TOOL_CATEGORY)) {
      // Match \`tool_name\` (backticked) anywhere in the prompt body — that's
      // the canonical reference style in system_prompt.ts. Avoids false
      // positives from incidental substring matches in prose.
      const re = new RegExp("`" + candidate + "`");
      if (re.test(SYSTEM_PROMPT)) promptRefs.add(candidate);
    }
    const wiredSet = new Set<string>(TOOL_NAMES_V1 as readonly string[]);
    for (const ref of promptRefs) {
      if (!wiredSet.has(ref) && !SERVER_MANAGED_TOOL_NAMES.has(ref)) {
        console.error(
          `[oto/chat] CONFIG ERROR: prompt references tool "${ref}" but it is NOT in TOOL_NAMES_V1. ` +
            `Haiku will hallucinate this tool's effect or report "I don't have access." Either wire it in TOOL_NAMES_V1 + buildCallables, or remove the prompt reference.`,
        );
      }
    }
  }
}

// Anthropic content-block shape — minimal for parsing the response.
interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicAnyBlock {
  type: string;
  [k: string]: unknown;
}
type AnthropicContentBlock = AnthropicTextBlock | ToolUseBlock | AnthropicAnyBlock;

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[] | ToolResultBlock[];
}

// The action declaration is intentionally a thin shell that hands its handler
// off to a separately-declared async function.
//
// The `@ts-expect-error TS2589` below silences a known Convex+TypeScript
// quirk: once this file is registered in api.d.ts as
// `api.oto.chat.sendMessage`, the `action({...})` generic signature has to
// resolve through an `api` type tree that contains its own output type. TS
// hits its depth limit and reports "Type instantiation is excessively deep."
//
// The runtime is unaffected — Convex doesn't go through tsc, the action
// registers and runs normally. The `expect-error` variant (vs `ts-ignore`)
// makes tsc complain if Convex ever ships a fix that eliminates the false
// positive, so we know to remove the suppression rather than leave it.
export const sendMessage = action({
  args: {
    conversationId: v.id("ai_conversations"),
    message: v.string(),
    // VIN of the vehicle the user has currently selected in the chat picker.
    // Optional — if omitted, the action falls back to most-recently-added.
    // Wins over the (forward-compat) conversation.vehicle_id rule.
    vehicleVin: v.optional(v.string()),
    // Dev-only: when true, the action returns a `trace` field capturing the
    // envelope, every Anthropic request/response, tool_use/tool_result blocks,
    // token usage, latency, and iteration accounting. Powers scripts/oto-harness.html.
    // Production callers MUST NOT pass this (extra payload, perf overhead).
    debug: v.optional(v.boolean()),
    // Dev-only: when true, skip persistence of both the user turn and the
    // assistant turn. Lets the harness iterate freely without polluting
    // ai_messages history. No effect unless `debug` is also true.
    debug_skip_persist: v.optional(v.boolean()),
  },
  // `quickReplies` typed loose (v.any()) so the shape can evolve as we add
  // render tools without churning the validator on every change.
  returns: v.object({
    text: v.string(),
    // Render directives — any of these may be present depending on which
    // render tool fired. The mobile app and harness pick the renderer based
    // on which fields are set. All are loose v.any() since their shapes
    // evolve with the render-tool inventory.
    quickReplies: v.optional(v.array(v.any())),
    showRecordConfirmation: v.optional(v.any()),
    // render_vehicle_update (vehicle-truth capture) — dispatcher produces
    // renderD("showVehicleUpdate", { mileage?, service_claims?, fault_lights? }).
    // Pulled through below so the mobile confirm card (and the director sim)
    // actually receive it; without this the directive dies after the merge.
    showVehicleUpdate: v.optional(v.any()),
    // Sprint 4 Day 1 Pass B — single terminal booking render. Replaces the
    // legacy 7 booking-flow fields (showServicePicker / pickerServices /
    // pickerPreSelectedId / showDiagnosticForm / shopCarousel / timeSelector /
    // bookingConfirmation), all removed Sprint 4 Day 1 Pass G. Dispatcher
    // produces this via renderD("bookService", ...). Mobile BookServiceComponent
    // drives every sub-stage internally (service select → options → notes →
    // mechanic → time → review → pay).
    bookService: v.optional(v.any()),
    // Sprint 3 Day 2 §14.1 — render_link_button (9 destinations). Dispatcher
    // produces via renderD("linkButton", { destination, label? }).
    linkButton: v.optional(v.any()),
    // Sprint 3 Day 5 §14.3 — render_booking_card / render_bookings_list. Card
    // is trigger-only (booking_id); list carries an array of ids. The mobile
    // component queries Convex for the actual booking row(s).
    bookingCard: v.optional(v.any()),
    bookingsList: v.optional(v.any()),
    reasoning: v.optional(v.any()),
    sources: v.optional(v.any()),
    // Trace blob — only populated when `debug: true`. Loose v.any() since
    // this is an inspection surface, not a production contract.
    trace: v.optional(v.any()),
    // Reliability surface (LLM Reliability Engineer): populated ONLY on the
    // retry-exhaust fallback path. `"overloaded"` = Anthropic 503/529 after
    // 3 attempts; `"transient"` = any other retryable 5xx/429 or network
    // failure after 3 attempts. Successful turns never set this. The mobile
    // UI can branch on its presence to surface a "try again" affordance
    // instead of treating the friendly text as a normal assistant reply.
    error_kind: v.optional(v.string()),
  }),
  handler: sendMessageHandler,
});

// Public-facing return shape — shared between the core handler and the
// retry-exhaust friendly-fallback wrapper. `error_kind` is set ONLY on the
// fallback path (retry-exhaust) or the Wave 7.2 ladder gate (MINIMAL / DOWN);
// successful turns omit it.
type SendMessageResult = {
  text: string;
  quickReplies?: unknown[];
  showRecordConfirmation?: { vehicle_id: string; maintenance_type: string };
  // render_vehicle_update — vehicle-truth confirm card (mileage / service
  // claims / fault lights the user stated this turn). All three optional.
  showVehicleUpdate?: {
    mileage?: number;
    service_claims?: Array<{ service_slug: string; kind: "due" | "light_on" }>;
    fault_lights?: string[];
  };
  bookService?: {
    service_slugs: string[];
    diagnostic_system?:
      | "brakes"
      | "tires_wheels"
      | "engine"
      | "battery_electrical"
      | "not_sure";
    customer_notes?: string;
    recommended_priority?: "closest" | "best_rated" | "best_price";
    recommended_mechanic_id?: string;
  };
  linkButton?: {
    destination:
      | "terms_of_service"
      | "privacy_policy"
      | "settings"
      | "profile"
      | "transaction_history"
      | "customer_support"
      | "feedback"
      | "bug_report"
      | "vehicle_onboarding";
    label?: string;
  };
  bookingCard?: { booking_id: string };
  bookingsList?: { booking_ids: string[] };
  reasoning?: unknown;
  sources?: unknown;
  trace?: unknown;
  // "overloaded" | "transient" come from AnthropicTransientError boundary
  // (existing). "minimal_mode" | "ladder_down" come from the Wave 7.2 pre-
  // turn ladder gate in sendMessageHandlerCore. Mobile UI branches on
  // presence/value to surface a retry affordance.
  error_kind?: "overloaded" | "transient" | "minimal_mode" | "ladder_down";
};

// Action entry point — thin error-boundary shell. Translates
// AnthropicTransientError (Anthropic retry-exhaust) into a user-friendly
// result so the mobile app + harness can render a graceful message instead
// of an "Uncaught Error" toast. Any OTHER throw propagates unchanged so
// programmer errors (auth, schema, 401/403/400) stay loud.
async function sendMessageHandler(
  ctx: any,
  args: {
    conversationId: Id<"ai_conversations">;
    message: string;
    vehicleVin?: string;
    debug?: boolean;
    debug_skip_persist?: boolean;
  },
): Promise<SendMessageResult> {
  try {
    return await sendMessageHandlerCore(ctx, args);
  } catch (e: unknown) {
    if (e instanceof AnthropicTransientError) {
      // Telemetry: a single warn at the boundary lets us count fallback rate
      // in production logs alongside the per-attempt warns from the retry
      // wrapper. Distinct prefix so log filters can split the two.
      console.warn(
        `[oto/chat] retry-exhaust friendly-fallback fired: kind=${e.kind}, lastStatus=${e.lastStatus ?? "network"}, attempts=${e.attempts}`,
      );
      // Sprint 2 Day 9 — observability: structured reliability event for the
      // Wave 7.2 ladder. The boundary warn above is for stdout filters; this
      // is the metric/alert substrate. anthropic_retry_exhausted is one of
      // the demotion triggers per docs/SPRINT_2/WAVE_7_2_DEGRADATION_LADDER.md
      // §2.1. Fire-and-forget — own .catch() so observability cannot fail
      // the chat turn (this IS the chat-turn-failure path; we're already in
      // the friendly-fallback).
      ctx
        .runMutation(internal.oto.reliability.recordReliabilityEvent, {
          surface: "anthropic_retry_exhausted",
          kind: "transient_error",
          error_message: e.message,
          metadata: {
            transient_kind: e.kind,
            last_status: e.lastStatus ?? null,
            attempts: e.attempts,
          },
        })
        .catch((reportErr: unknown) => {
          console.error(
            "[oto/chat] recordReliabilityEvent itself failed (silent):",
            (reportErr as { message?: string })?.message,
          );
        });
      // User-facing copy: short, non-technical, suggests a retry. The two
      // kinds get slightly different phrasing so users can tell repeated
      // overload waves apart from a one-off blip. Anthropic outages tend to
      // cluster in time so "in a moment" beats specifying minutes.
      const friendlyText =
        e.kind === "overloaded"
          ? "Sorry — Oto is experiencing high load right now. Please try again in a moment."
          : "Sorry — I had trouble reaching the model just now. Please try again.";
      return {
        text: friendlyText,
        error_kind: e.kind,
      };
    }
    // Anything else (auth failure, 4xx-non-429, programmer error): re-throw
    // so it surfaces as a real Uncaught Error and gets fixed.
    // Sprint 2 Day 9 — observability: record the uncaught-boundary swallow
    // BEFORE re-throwing. This catches programmer errors (the Day 8
    // ReturnsValidationError class of bug) that previously surfaced only
    // when a user complained — now metric/alert-able from the
    // chat_action_uncaught surface in reliability_events.
    const uncaughtMsg = e instanceof Error ? e.message : String(e);
    ctx
      .runMutation(internal.oto.reliability.recordReliabilityEvent, {
        surface: "chat_action_uncaught",
        kind: "validation_error",
        error_message: uncaughtMsg,
      })
      .catch((reportErr: unknown) => {
        console.error(
          "[oto/chat] recordReliabilityEvent itself failed (silent):",
          (reportErr as { message?: string })?.message,
        );
      });
    throw e;
  }
}

// Core handler — owns the full chat turn. Wrapped by sendMessageHandler
// above so retry-exhaust errors get translated to a friendly shape before
// hitting the action's return validator.
// Exported so the eval/simulation harness (convex/oto/simulate.ts) can drive a
// full authenticated turn with a fabricated identity — see that file. NOT a
// public API surface; the only public entry is the `sendMessage` action above.
export async function sendMessageHandlerCore(
  // `ctx` typed `any` so this function's body doesn't drag the api tree into
  // its inferred type. Doc<…> annotations on each call-site result restore
  // type safety where it matters.
  ctx: any,
  {
    conversationId,
    message,
    vehicleVin,
    debug,
    debug_skip_persist,
  }: {
    conversationId: Id<"ai_conversations">;
    message: string;
    vehicleVin?: string;
    debug?: boolean;
    debug_skip_persist?: boolean;
  },
): Promise<SendMessageResult> {
  // Trace accumulator — populated only when debug=true. `null` in production.
  // Each Anthropic round-trip pushes one entry into trace.iterations.
  const trace: any = debug ? { iterations: [] } : null;
  // ── 1. Auth ──────────────────────────────────────────────────────────
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");

  // Explicit `Doc<...>` annotations on each ctx.runQuery short-circuit
  // TypeScript's attempt to resolve through the full `api` type tree.
  const user: Doc<"users"> | null = await ctx.runQuery(
    api.users.getByClerkUserId,
    { clerkUserId: identity.subject },
  );
  if (!user) throw new Error("user not found in Convex");

  // ── 2. Load conversation + history, scoped by ownership ──────────────
  const conversation: Doc<"ai_conversations"> | null = await ctx.runQuery(
    internal.ai_conversations.getById,
    { id: conversationId },
  );
  if (!conversation) throw new Error("conversation not found");
  if (conversation.user_id !== user._id) throw new Error("not authorized");

  const allMessages: Array<Doc<"ai_messages">> = await ctx.runQuery(
    internal.ai_messages.getByConversationIdInternal,
    { conversationId },
  );
  const sortedMessages = [...allMessages].sort((a, b) => a.timestamp - b.timestamp);
  const history = sortedMessages.slice(-HISTORY_TURNS);

  // ── 2.5. Wave 7.2 pre-turn degradation-ladder gate ────────────────────
  //
  // Sprint 2 Day 10. Authority: docs/SPRINT_2/WAVE_7_2_DEGRADATION_LADDER.md
  // §4.2 (the per-turn gate API contract). Owner: LLM Reliability Engineer.
  //
  // Read the system-wide ladder state ONCE per turn from `reliability_events`
  // (the Day 9 observability substrate) and branch behavior per the design
  // doc's state table:
  //
  //   FULL     — proceed normally (current behavior).
  //   DEGRADED — proceed normally BUT pass `no_web_search: true` to the
  //              retrieve_vehicle_facts cascade dispatch (override of the
  //              production default of `false`). web_search server-tool is
  //              the failure-prone surface; strip it from the cascade this
  //              turn so Haiku stops trying.
  //   MINIMAL  — SKIP the Anthropic call entirely. Return a canned summary
  //              built from envelope context (user first name + history)
  //              with `error_kind: "minimal_mode"`. Memory wire-ins also
  //              skipped (they only fire after a successful Anthropic turn).
  //   DOWN     — SKIP everything. Return the same friendly-retry text the
  //              AnthropicTransientError boundary uses, with
  //              `error_kind: "ladder_down"`.
  //
  // Latency budget per design §4.3: < 50ms (single indexed query + decision).
  //
  // Failure-isolation: if `getCurrentDegradationState` itself fails, default
  // to FULL — defense-in-depth. A broken observability layer must NEVER
  // break the chat path. Caller wraps in try/catch; default state on throw.
  //
  // v1 limitations (per design §8 + the reliability.ts implementation
  // comments): the ladder is STATELESS — every turn computes state fresh
  // from the trailing-window scan. No per-user state (system-wide only).
  // No manual admin override.
  let ladderState: "FULL" | "DEGRADED" | "MINIMAL" | "DOWN" = "FULL";
  let ladderReason = "default";
  try {
    const ladderRead = (await ctx.runQuery(
      internal.oto.reliability.getCurrentDegradationState,
      {},
    )) as {
      state: "FULL" | "DEGRADED" | "MINIMAL" | "DOWN";
      reason: string;
      window_start_ms: number;
      window_end_ms: number;
    };
    ladderState = ladderRead.state;
    ladderReason = ladderRead.reason;
  } catch (e: any) {
    console.warn(
      "[oto/chat] getCurrentDegradationState failed (defaulting to FULL):",
      e?.message,
    );
  }

  if (ladderState !== "FULL") {
    console.warn(
      `[oto/chat] Wave 7.2 degradation-ladder state=${ladderState} reason="${ladderReason}"`,
    );
  }

  // MINIMAL / DOWN: short-circuit the chat turn entirely. The fire-and-forget
  // reliability event below provides symmetric observability so the ladder's
  // skips show up in metrics alongside the failures that triggered them.
  if (ladderState === "DOWN") {
    ctx
      .runMutation(internal.oto.reliability.recordReliabilityEvent, {
        surface: "ladder_gate_skipped_anthropic",
        kind: "fallback_fired",
        error_message: `state=DOWN reason="${ladderReason}"`,
        user_id: user._id,
        conversation_id: conversationId,
        metadata: { state: "DOWN", reason: ladderReason },
      })
      .catch((reportErr: unknown) => {
        console.error(
          "[oto/chat] recordReliabilityEvent itself failed (silent):",
          (reportErr as { message?: string })?.message,
        );
      });
    return {
      text: "Sorry — Oto is having trouble right now. Please try again in a moment.",
      error_kind: "ladder_down",
    };
  }

  if (ladderState === "MINIMAL") {
    ctx
      .runMutation(internal.oto.reliability.recordReliabilityEvent, {
        surface: "ladder_gate_skipped_anthropic",
        kind: "fallback_fired",
        error_message: `state=MINIMAL reason="${ladderReason}"`,
        user_id: user._id,
        conversation_id: conversationId,
        metadata: { state: "MINIMAL", reason: ladderReason },
      })
      .catch((reportErr: unknown) => {
        console.error(
          "[oto/chat] recordReliabilityEvent itself failed (silent):",
          (reportErr as { message?: string })?.message,
        );
      });
    // Canned summary from envelope context. We have user.first_name and
    // history at this point; we deliberately DO NOT load the active vehicle
    // here because the MINIMAL path's job is to fail fast on a degraded
    // backend — running extra runQueries to enrich the canned reply is the
    // exact pattern this state is designed to avoid. The mobile UI branches
    // on `error_kind === "minimal_mode"` to surface a retry affordance.
    const firstName =
      user.first_name && user.first_name.trim().length > 0
        ? user.first_name.trim()
        : null;
    const greeting = firstName ? `Hey ${firstName} — ` : "";
    const minimalText =
      `${greeting}Oto is experiencing high load right now, so I'm running in a limited mode for this turn. ` +
      `I don't have access to my full toolset, but please try again in a moment and I should be back.`;
    return {
      text: minimalText,
      error_kind: "minimal_mode",
    };
  }

  // FULL or DEGRADED fall through to the normal chat path below. The
  // DEGRADED case is plumbed through to buildCallables (line ~677) as the
  // `noWebSearch` flag — when true the `retrieve_vehicle_facts` callable
  // overrides the cascade dispatch's `no_web_search: false` default to
  // `true`, stripping T3 web_search for the duration of this turn.
  const noWebSearchOverride = ladderState === "DEGRADED";

  // ── 3. Resolve active vehicle ────────────────────────────────────────
  const conversationVehicleId = (conversation as Record<string, unknown>)
    .vehicle_id as string | undefined;

  // Resolve owned vehicles by the ALREADY-resolved user._id, not via the
  // request's auth identity. Behaviorally identical to getMyVehicles({}) for a
  // real authenticated turn (same user), but it also works under the
  // simulation harness (convex/oto/simulate.ts), where the fabricated identity
  // reaches this handler's auth check but NOT auth-scoped sub-queries — so
  // getMyVehicles({}) returned [] there, leaving Oto blind to the user's car.
  const ownedRaw: OwnedVehicleRow[] | null = await ctx.runQuery(
    api.vehicles.listVehiclesByUser,
    { userId: user._id },
  );
  const ownedVehicles = ownedRaw ?? [];
  const activeRow = pickActiveVehicleRow(
    ownedVehicles,
    conversationVehicleId,
    vehicleVin,
  );

  let activeVehicle: ResolvedVehicle | null = null;
  if (activeRow?.vin) {
    const info: DisplayInfo | null = await ctx.runQuery(
      api.vehicles.getDisplayInfoForVin,
      { vin: activeRow.vin },
    );
    const display = formatDisplayString(
      info ?? { year: null, make: null, model: null, trim: null },
      activeRow.ownership?.nickname ?? null,
    );
    if (activeRow.vehicle?._id) {
      activeVehicle = {
        id: activeRow.vehicle._id,
        display,
        vin: activeRow.vin ?? null,
      };
    }
  }

  // ── 4. Build the uncached-zone envelope ──────────────────────────────
  // conversation state (mood, arc, established facts, intent) — read back so
  // Haiku has cross-turn memory without re-deriving from raw history.
  const convoState = {
    mood: (conversation as any).mood ?? null,
    arc_summary: (conversation as any).arc_summary ?? null,
    established_facts: ((conversation as any).established_facts ?? []) as string[],
    last_user_intent: (conversation as any).last_user_intent ?? null,
    updated_at: (conversation as any).state_updated_at ?? null,
  };
  // Polite-exit counter snapshot (Locked Principle #6). At >= the envelope's
  // POLITE_EXIT_THRESHOLD (4 — lowered from 6 on beta feedback; see
  // envelope.ts) it emits a polite_exit_required block and the prompt rule
  // forces a not_sure diagnostic form on this turn.
  const diagnosticTurnCount = ((conversation as any).diagnostic_turn_count as number | undefined) ?? 0;

  // Wave 3 integration step 4 — cross-conversation memory READ path.
  // Fetch top_K most-recent conversation_facts from this user's OTHER
  // conversations (excluding the current one). Feeds the envelope's new
  // <recent_context> block so the AI sees what was established earlier
  // across sessions, not just within the current conversation.
  //
  // Sprint 2 Day 8 (Wave 3 personalization-in-envelope): the query now
  // merges TWO pools — conversation_facts (cross-session) PLUS
  // user_semantic_facts (decay-on-read, floored at 0.1). The `source`
  // discriminator distinguishes them; `conversation_id` is undefined for
  // user_semantic rows. Envelope renders both under <recent_context>;
  // type alignment here keeps chat.ts in lock-step with the validator.
  //
  // Failure-isolated try/catch + swallow per the existing Wave 3 wire-in
  // pattern (recordTurn / commitEpisodic / commitControl). A failed cross-
  // conversation read MUST NEVER fail the chat turn — degrade gracefully to
  // empty array and the envelope skips the block entirely.
  //
  // top_K=5 is the dispatch default. Tunable; the envelope truncates over-
  // long payload_text at the query layer to keep the block under ~1KB.
  let priorConversationFacts: Array<{
    source: "conversation" | "user_semantic";
    conversation_id?: Id<"ai_conversations">;
    fact_type: string;
    payload_text: string;
    written_by: string;
    created_at: number;
    effective_confidence?: number;
  }> = [];
  try {
    priorConversationFacts = await ctx.runQuery(
      internal.oto.memoryEditing.getCrossConversationMemory,
      {
        user_id: user._id,
        current_conversation_id: conversationId,
        top_K: 5,
      },
    );
    // Wave 7.3 (Day 10) — fire-and-forget PII-read counter bump. The check
    // at the top of getCrossConversationMemory (memoryEditing.ts) reads this
    // counter; without the bump here the count never advances and enforcement
    // is inert. Hard-block kicks in at 50 reads / 600s rolling per user
    // (per design §2.2 review note). Counter failure is swallowed silently —
    // observability fires it as a reliability event one level above.
    ctx
      .runMutation(internal.oto.queryMoat.bumpPIIReadCounter, {
        userId: user._id,
      })
      .catch((bumpErr: unknown) => {
        console.error(
          "[oto/chat] bumpPIIReadCounter failed (silent):",
          (bumpErr as { message?: string })?.message,
        );
      });
  } catch (e: any) {
    console.error(
      "[oto/chat] getCrossConversationMemory failed (swallowed):",
      e?.message,
    );
    // Sprint 2 Day 9 — observability: fire-and-forget reliability event so
    // silent degradation surfaces via metric/alert rather than waiting for
    // behavioral symptoms. The Day 8 EOD ReturnsValidationError on THIS
    // very call site was empty-envelope-for-12-hrs — exactly the failure
    // class this surface catches.
    ctx
      .runMutation(internal.oto.reliability.recordReliabilityEvent, {
        surface: "wave3_get_cross_conv_memory",
        kind: "swallowed",
        error_message: e?.message,
        user_id: user._id,
        conversation_id: conversationId,
      })
      .catch((reportErr: unknown) => {
        console.error(
          "[oto/chat] recordReliabilityEvent itself failed (silent):",
          (reportErr as { message?: string })?.message,
        );
      });
    priorConversationFacts = [];
  }

  // Sprint 2 Day 8 — adapt the two-pool query result back to the envelope's
  // PriorConversationFact shape (envelope.ts is structurally Security's Day 7
  // surface; we add no new fields to its render pipeline this round). The
  // envelope only reads fact_type / payload_text / created_at; conversation_id
  // is required by its TS interface but never rendered. For user_semantic
  // rows (no underlying conversation scope) we pass the empty string —
  // safe-cast since the field is never visited. The full expanded shape with
  // `source` + `effective_confidence` survives in `trace.prior_conversation_facts`
  // for QA inspection.
  const envelopePriorFacts = priorConversationFacts.map((f) => ({
    conversation_id: (f.conversation_id ?? "") as string,
    fact_type: f.fact_type,
    payload_text: f.payload_text,
    written_by: f.written_by,
    created_at: f.created_at,
  }));
  // Onboarding car-knowledge level → scale Oto's answer complexity. Read once
  // per turn; null when the user never answered (Oto stays at friendly
  // baseline). See knowledgeLabel + the prompt's "Knowledge-level adaptation".
  const rawKnowledgeLevel: number | string | null = await ctx.runQuery(
    api.onboarding_questions_answers.getCarKnowledgeLevelForUser,
    { user_id: user._id },
  );
  const envelope = buildEnvelope({
    userFirstName: user.first_name ?? null,
    vehicle: activeVehicle,
    history,
    userMessage: message,
    conversationState: convoState,
    diagnosticTurnCount,
    priorConversationFacts: envelopePriorFacts,
    knowledgeLevel: knowledgeLabel(rawKnowledgeLevel),
  });
  // B-P4: the envelope carries raw user PII (vehicle, history, message,
  // established facts) — only log it on debug/harness runs, not every
  // production turn (PII exposure + log volume).
  if (debug) console.log("[oto/chat] envelope sent to Haiku:\n" + envelope);

  if (trace) {
    trace.system_prompt_version = SYSTEM_PROMPT_VERSION;
    trace.system_prompt_chars = SYSTEM_PROMPT.length;
    trace.system_prompt = SYSTEM_PROMPT;
    trace.envelope = envelope;
    trace.tools_advertised = [...TOOL_NAMES_V1];
    trace.vehicle = activeVehicle;
    trace.user_first_name = user.first_name ?? null;
    trace.history_turns_included = history.length;
    trace.model = MODEL;
    // Wave 3 integration step 4 — expose the prior-conversation facts
    // pulled into <recent_context> for harness inspection. Production
    // callers never receive this (trace is debug-only).
    trace.prior_conversation_facts = priorConversationFacts;
  }

  // ── 5. Build the callable map ────────────────────────────────────────
  // chat.ts owns every `api.*` reference. Each callable is a closure that
  // captures ctx + api; dispatcher.ts never sees Convex types. The state
  // callable also captures conversationId so it can patch the right row.
  // user._id is captured so Wave 7.3 Option B counter-bumps after each
  // moat-reading runQuery can attribute the read delta to this user.
  //
  // Wave 3 wire-in (D-3.2): the state callable also captures the PREVIOUS
  // established_facts snapshot + the current turn_number so it can diff new
  // entries against the prior state and mirror each new entry to the
  // append-only conversation_facts table via recordConversationFact. The
  // turn_number convention matches the conversation_audit recordTurn
  // wire-in below (sortedMessages.length is the canonical 0-indexed turn
  // index for this user-row).
  //
  // Wave 3 wire-in step 3 (commitEpisodic — WAVE_3_DESIGN §2.3): the state
  // callable ALSO captures the PREVIOUS mood + arc_summary so it can diff
  // them against Haiku's new values and mirror changes into
  // conversation_episodic_control via commitEpisodic. The episodic field-
  // class (mood + arc + flow + compression) is exactly the design's
  // "model-influenced" surface; commitEpisodic enforces field-class purity
  // by accepting ONLY those fields in its delta. last_user_intent is NOT
  // mirrored — the §2.3 schema deliberately drops it (the polite-exit
  // counter still reads it from the legacy ai_conversations.last_user_intent
  // until Wave 5's read-cutover dispatch).
  const previousEstablishedFacts: string[] = Array.isArray(
    convoState.established_facts,
  )
    ? [...convoState.established_facts]
    : [];
  const conversationFactTurnNumber = sortedMessages.length;
  // Pre-turn snapshot for the commitEpisodic mirror. `null` here is the
  // legacy-unset sentinel; the diff logic in update_conversation_state
  // treats `null !== "neutral"` as a change (initEpisodicControl seeds the
  // row at mood="neutral" / arc="" so a first-turn Haiku writing
  // mood="curious" / arc="user opening question" generates a true delta).
  const previousMood: string | null = (conversation as any).mood ?? null;
  const previousArcSummary: string | null =
    (conversation as any).arc_summary ?? null;
  const callables = buildCallables(
    ctx,
    conversationId,
    user._id,
    previousEstablishedFacts,
    conversationFactTurnNumber,
    previousMood,
    previousArcSummary,
    // Wave 7.2 DEGRADED state: strip T3 web_search from the cascade for this
    // turn. Falls back to `false` (production default) on FULL.
    noWebSearchOverride,
  );

  // ── 6. Tool-use loop ─────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var not set");

  // Per-turn model selection — Sonnet cascade. ai_conversations.current_model
  // is set by Haiku's request_sonnet_handoff (or cleared by request_haiku_handback).
  const conversationCurrentModel = ((conversation as any).current_model ?? null) as
    | string
    | null;
  // `let`, not const: B-P2 same-turn Sonnet escalation re-points this mid-loop
  // when request_sonnet_handoff fires, so the hard turn that ASKED for Sonnet
  // is answered by Sonnet THIS turn (previously it finished on Haiku and
  // Sonnet only engaged the next turn).
  let turnModel =
    conversationCurrentModel === "sonnet" ? SONNET_MODEL : HAIKU_MODEL;
  if (trace) trace.model = turnModel;

  const messages: AnthropicMessage[] = [{ role: "user", content: envelope }];
  const accumulatedResults: ToolResultBlock[] = [];
  // Forensic tool-call trace for this turn's assistant conversation_audit row
  // (Wave 5 wire-in). Accumulates {name, input} across ALL iterations of the
  // loop for the non-data tools — the renders Oto surfaced and the state/memory
  // writes it made. Data-tool READS are intentionally excluded (they stay in
  // oto_telemetry.tools_called); this row is "what Oto DID". Readers (ops
  // /oto-ai, director debug) summarize this into a human action timeline.
  const accumulatedToolCalls: { name: string; input: unknown }[] = [];

  // B-P1: telemetry samples collected UNCONDITIONALLY (the debug trace only
  // exists on harness runs — production rows used to record 0 tokens).
  const turnSamples: TurnSample[] = [];

  let finalText = "";
  let iterations = 0;
  let hitCap = false;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    // Snapshot messages BEFORE the call so the trace captures what Haiku
    // actually saw on this iteration (not what's there after we mutate
    // messages with the assistant turn + tool_results).
    const requestMessagesSnapshot = trace
      ? JSON.parse(JSON.stringify(messages))
      : null;
    const t0 = Date.now();
    const resp = await callAnthropic({
      apiKey,
      messages,
      tools: TOOLS_FOR_HAIKU,
      model: turnModel,
    });
    const latencyMs = Date.now() - t0;

    // ── B-P3: stop_reason handling ───────────────────────────────────────
    // pause_turn: a server-side tool (web_search) hit its per-request limit
    // mid-turn. Anthropic returns a PARTIAL assistant turn; the protocol is
    // to echo that content back and continue so the search resumes. Before
    // this, a paused turn carried no client tool_use and no final text, so it
    // fell through to the empty-text fallback — the flagship "ask Oto
    // something it has to look up" path dead-ended into the generic apology.
    // Bounded by MAX_TOOL_ITERATIONS like every other continuation.
    if (resp.stop_reason === "pause_turn") {
      turnSamples.push({
        usage: resp.usage,
        latency_ms: latencyMs,
        tool_names: [],
        branch: "data_continue",
      });
      messages.push({ role: "assistant", content: resp.content });
      if (iterations === MAX_TOOL_ITERATIONS) hitCap = true;
      continue;
    }
    // max_tokens: the response was truncated mid-thought. Don't change flow
    // (use whatever content arrived), but surface it so truncation is visible
    // and tunable. Fire-and-forget.
    if (resp.stop_reason === "max_tokens") {
      ctx
        .runMutation(internal.oto.reliability.recordReliabilityEvent, {
          surface: "anthropic_max_tokens",
          kind: "truncated",
          user_id: user._id,
          conversation_id: conversationId,
          metadata: { iteration: iterations, model: turnModel },
        })
        .catch((e: unknown) =>
          console.error(
            "[oto/chat] max_tokens reliability event failed (silent):",
            (e as { message?: string })?.message,
          ),
        );
    }

    const toolUses: ToolUseBlock[] = resp.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    const textBlock = resp.content.find(
      (b): b is AnthropicTextBlock => b.type === "text",
    );

    // ── Categorize tool_use blocks ─────────────────────────────────────
    // Data tools are loop INPUTS — their results feed the next Anthropic
    // call so the model can compose a response. Render and navigation tools
    // are loop OUTPUTS — terminal directives the chat action packages for
    // the client. State tools are SIDE EFFECTS — they persist conversation
    // memory and never gate loop control flow. We dispatch them in parallel
    // with the rest; their tool_results are appended only when there's a
    // follow-up API call (data_continue branch).
    const dataToolUses: ToolUseBlock[] = [];
    const stateToolUses: ToolUseBlock[] = [];
    const terminalToolUses: ToolUseBlock[] = [];
    for (const tu of toolUses) {
      const cat = OTO_TOOL_CATEGORY[tu.name];
      if (cat === "data") dataToolUses.push(tu);
      else if (cat === "state" || cat === "model_routing") {
        // model_routing tools (request_sonnet_handoff / request_haiku_handback)
        // are side-effect writes to ai_conversations.current_model. Same
        // dispatch behavior as state tools — execute in parallel, return
        // trivial ack, don't gate the loop.
        stateToolUses.push(tu);
      } else terminalToolUses.push(tu); // render | navigation | unknown
      // Capture the action-bearing tool uses (renders + state/memory/routing
      // writes) for the assistant audit row. Data reads are excluded above.
      if (cat !== "data") {
        accumulatedToolCalls.push({ name: tu.name, input: tu.input });
      }
    }

    const iterBranch =
      terminalToolUses.length > 0
        ? ("terminal" as const)
        : dataToolUses.length === 0
          ? ("text_only" as const)
          : ("data_continue" as const);
    turnSamples.push({
      usage: resp.usage,
      latency_ms: latencyMs,
      tool_names: [
        ...dataToolUses.map((t) => t.name),
        ...stateToolUses.map((t) => t.name),
        ...terminalToolUses.map((t) => t.name),
      ],
      branch: iterBranch,
    });

    // Side-effect: dispatch state tools eagerly (before branching), so
    // persistence happens even if the rest of the response throws.
    const stateAckResults =
      stateToolUses.length > 0
        ? await Promise.all(stateToolUses.map((tu) => executeTool(tu, callables)))
        : [];

    // ── B-P2: same-turn Sonnet escalation ────────────────────────────────
    // The model-routing tools (request_sonnet_handoff / request_haiku_handback)
    // write ai_conversations.current_model, but turnModel was fixed at turn
    // start — so the hard turn that requested Sonnet used to be answered by
    // Haiku, with Sonnet engaging only the NEXT turn. After a routing tool
    // runs, re-read the persisted model (the SAME source of truth turn-start
    // selection uses) and apply it to the remaining iterations of THIS turn.
    // Only re-reads when a routing tool actually fired (rare — 15-25% of
    // diagnostic turns), and the routing callables swallow write failures, so
    // a failed handoff simply leaves current_model (and turnModel) unchanged.
    let escalatedToSonnetThisIteration = false;
    if (stateToolUses.some((tu) => OTO_TOOL_CATEGORY[tu.name] === "model_routing")) {
      try {
        const fresh = await ctx.runQuery(internal.ai_conversations.getById, {
          id: conversationId,
        });
        const freshModel = ((fresh as any)?.current_model ?? null) as string | null;
        // ESCALATE-UP ONLY. A handoff (→sonnet) takes effect immediately so
        // Sonnet answers the hard turn. A handback (→haiku) must NOT downgrade
        // mid-turn: Sonnet finishes THIS turn, and Haiku resumes next turn via
        // the turn-start read — preserving handback's original next-turn
        // semantics and keeping telemetry/audit labelled with the model that
        // actually answered.
        if (freshModel === "sonnet" && turnModel !== SONNET_MODEL) {
          escalatedToSonnetThisIteration = true;
          turnModel = SONNET_MODEL;
          if (trace) trace.model = turnModel;
        }
      } catch (e: any) {
        console.error(
          "[oto/chat] model-routing re-read failed (swallowed):",
          e?.message,
        );
      }
    }

    // One trace entry per Anthropic round-trip. Pushed here (before tool
    // dispatch) so even a thrown dispatch error still leaves the entry in
    // place — `tool_results` is filled in after dispatch below.
    const traceIter: any = trace
      ? {
          iteration: iterations,
          latency_ms: latencyMs,
          request: {
            message_count: requestMessagesSnapshot!.length,
            messages: requestMessagesSnapshot,
            tools_advertised_count: TOOLS_FOR_HAIKU.length,
          },
          response: {
            id: resp.id,
            model: resp.model,
            stop_reason: resp.stop_reason,
            usage: resp.usage,
            content: resp.content,
          },
          text_block: textBlock?.text ?? null,
          data_tool_uses: dataToolUses,
          state_tool_uses: stateToolUses,
          terminal_tool_uses: terminalToolUses,
          state_results: stateAckResults,
          tool_results: [] as ToolResultBlock[],
          branch: iterBranch,
        }
      : null;
    if (trace) trace.iterations.push(traceIter);

    // Terminal tools (render + nav) dispatch in-process and contribute to
    // the response payload. They do NOT participate in the API loop.
    if (terminalToolUses.length > 0) {
      console.log(
        `[oto/chat] iteration ${iterations}: terminal tool_use(s): ` +
          terminalToolUses.map((tu) => tu.name).join(", ") +
          (dataToolUses.length > 0
            ? ` (ignoring ${dataToolUses.length} data tool_use(s) in same turn — render is authoritative)`
            : ""),
      );
      const terminalResults = await Promise.all(
        terminalToolUses.map((tu) => executeTool(tu, callables)),
      );
      accumulatedResults.push(...terminalResults);
      if (traceIter) traceIter.tool_results = terminalResults;

      // ── Wave 3 wire-in step 5 — recordSelectionFact mirror ─────────────
      // When the AI fires `render_book_service`, that's the SELECTION MOMENT
      // for the entire booking flow (Sprint 4 Day 1 Pass B consolidation —
      // replaces the 4-tool prior chain: render_service_picker /
      // render_shop_carousel / render_time_selector /
      // render_booking_confirmation, all now deprecated). Per WAVE_3_DESIGN
      // §2.1 the fact captures what the AI OFFERED at this turn — not the
      // user's eventual choice (the chat path doesn't see that; the user
      // picks mechanic + slot inside the mobile BookServiceComponent). The
      // entity_type suffix ("_offer") preserves the distinction.
      //
      //   render_book_service → entity_type="booking_offer"
      //
      // Trigger-only render (dispatcher.ts §packageRender comments): Oto
      // passes the prefill bundle (service_slugs + optional diagnostic
      // system + customer notes + recommended priority/mechanic) and the
      // mobile component drives every sub-stage internally. The entity_id
      // encodes the prefill — the slug bundle is the primary key (what
      // services were offered), with optional diagnostic_system /
      // recommended_priority / recommended_mechanic_id appended when
      // supplied. Replay can recover what offer the user was looking at.
      //
      // Failure-isolation pattern: outer try/catch + per-fact inner
      // try/catch + console.error + swallow, mirroring the
      // recordConversationFact wire-in below. A broken mirror MUST NEVER
      // fail the chat turn — the user's render directive has already been
      // packaged into accumulatedResults and the chat response is
      // committed; the mirror is a write-side telemetry append.
      try {
        for (const tu of terminalToolUses) {
          const input = tu.input as Record<string, unknown>;
          // Compute (entity_type, entity_id) per render tool. Returning
          // null skips the mirror for that fire (e.g. an unrecognized
          // render tool, or a render tool that isn't a selection moment).
          let entityType: string | null = null;
          let entityId: string | null = null;
          switch (tu.name) {
            case "render_book_service": {
              entityType = "booking_offer";
              const slugs = Array.isArray(input.service_slugs)
                ? (input.service_slugs as unknown[]).filter(
                    (s): s is string => typeof s === "string",
                  )
                : [];
              if (slugs.length === 0) {
                entityType = null;
                break;
              }
              // Primary key: the bundle of services offered. Append the
              // optional prefill metadata when present so replay can tell
              // a diagnostic-scan offer apart from a routine-service offer
              // and a single from a bundled booking.
              const parts: string[] = [
                `service_slugs=${JSON.stringify(slugs)}`,
              ];
              if (typeof input.diagnostic_system === "string") {
                parts.push(`diagnostic_system=${input.diagnostic_system}`);
              }
              if (typeof input.recommended_priority === "string") {
                parts.push(`recommended_priority=${input.recommended_priority}`);
              }
              if (typeof input.recommended_mechanic_id === "string") {
                parts.push(
                  `recommended_mechanic_id=${input.recommended_mechanic_id}`,
                );
              }
              entityId = parts.join(";");
              break;
            }
            default:
              // Other render tools (render_record_confirmation,
              // render_quick_replies, render_reasoning, render_sources,
              // render_link_button, render_booking_card, render_bookings_list)
              // are NOT selection moments — they show forms, ask Yes/No,
              // decorate prose, redirect to screens, or surface existing
              // booking details. No offer fact to record.
              break;
          }
          if (entityType !== null && entityId !== null) {
            try {
              await ctx.runMutation(
                internal.oto.memoryEditing.recordSelectionFact,
                {
                  conversation_id: conversationId,
                  entity_type: entityType,
                  entity_id: entityId,
                  source_turn: conversationFactTurnNumber,
                },
              );
            } catch (innerErr: any) {
              // Per-render failure — log but keep processing the rest.
              // Same per-row failure-isolation as recordConversationFact.
              console.error(
                "[oto/chat] recordSelectionFact failed for one render " +
                  "(swallowed):",
                innerErr?.message,
                {
                  tool: tu.name,
                  entity_type: entityType,
                  entity_id: entityId,
                  turn: conversationFactTurnNumber,
                },
              );
              // Sprint 2 Day 9 — observability: per-render swallow signal.
              ctx
                .runMutation(
                  internal.oto.reliability.recordReliabilityEvent,
                  {
                    surface: "wave3_record_selection_fact",
                    kind: "swallowed",
                    error_message: innerErr?.message,
                    user_id: user._id,
                    conversation_id: conversationId,
                    metadata: {
                      tool: tu.name,
                      entity_type: entityType,
                      entity_id: entityId,
                      turn: conversationFactTurnNumber,
                      scope: "inner",
                    },
                  },
                )
                .catch((reportErr: unknown) => {
                  console.error(
                    "[oto/chat] recordReliabilityEvent itself failed (silent):",
                    (reportErr as { message?: string })?.message,
                  );
                });
            }
          }
        }
      } catch (e: any) {
        // Outer guard — matches the recordConversationFact wire-in below
        // and the conversation_audit recordTurn pattern. The mirror is
        // best-effort: a thrown read of input shape or a Convex transport
        // hiccup MUST NOT propagate and fail the chat turn.
        console.error(
          "[oto/chat] recordSelectionFact mirror failed (swallowed):",
          e?.message,
        );
        // Sprint 2 Day 9 — observability: outer-mirror swallow signal.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "wave3_record_selection_fact",
            kind: "swallowed",
            error_message: e?.message,
            user_id: user._id,
            conversation_id: conversationId,
            metadata: { scope: "outer_mirror" },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
      }

      // Whatever text accompanied the render call is the user-facing prose.
      finalText = textBlock?.text ?? "";
      break;
    }

    if (dataToolUses.length === 0) {
      // No data tools this iteration. Three sub-cases:
      //   (a) Text emitted → terminal text turn. Most common path.
      //   (b) State tool emitted alongside text → terminal (state is side
      //       effect, doesn't change the branch).
      //   (c) State tool emitted with NO text → broken response from Haiku.
      //       The loop must NOT terminate here; we'd return empty text and
      //       throw downstream. Feed the state ack back and let Haiku try
      //       again. This recovers the "state-only-no-text" failure mode.
      const hasText = !!textBlock?.text?.trim();
      // B-P2: if Haiku escalated to Sonnet THIS iteration, do NOT let Haiku's
      // (typically holding) text end the turn — feed the state ack back and
      // continue so Sonnet produces the real answer same-turn. Otherwise the
      // original state-only-no-text recovery (case c).
      if (escalatedToSonnetThisIteration || (!hasText && stateToolUses.length > 0)) {
        // Continuation path: persist messages with state ack tool_results
        // and let the loop iterate. The next call uses the (possibly
        // escalated) turnModel — Sonnet answers if Haiku just handed off.
        messages.push({ role: "assistant", content: resp.content });
        messages.push({ role: "user", content: stateAckResults });
        if (iterations === MAX_TOOL_ITERATIONS) hitCap = true;
        continue;
      }
      finalText = textBlock?.text ?? "";
      break;
    }

    console.log(
      `[oto/chat] iteration ${iterations}: dispatching ${dataToolUses.length} data tool_use(s): ` +
        dataToolUses.map((tu) => tu.name).join(", "),
    );

    // Standard data-tool continuation: append assistant turn, dispatch,
    // append tool_results as next user turn, loop. State tool acks ride
    // alongside data results so the Anthropic API contract (every tool_use
    // in the assistant turn matched by a tool_result in the next user turn)
    // holds.
    messages.push({ role: "assistant", content: resp.content });

    const dataResults = await Promise.all(
      dataToolUses.map((tu) => executeTool(tu, callables)),
    );
    accumulatedResults.push(...dataResults);
    if (traceIter) traceIter.tool_results = dataResults;

    messages.push({
      role: "user",
      content: [...stateAckResults, ...dataResults],
    });

    if (iterations === MAX_TOOL_ITERATIONS) {
      hitCap = true;
    }
  }

  // Forced-terminate: cap was hit with tool_use still firing. Call Anthropic
  // once more with NO tools at all (including server-managed web_search) so
  // the model has to emit text. We bypass callAnthropic's tool-merging path
  // entirely and hit Anthropic directly with tools: [].
  if (hitCap && !finalText) {
    console.warn(
      "[oto/chat] tool loop hit MAX_TOOL_ITERATIONS; forcing final response with ALL tools disabled.",
    );
    const t0 = Date.now();
    const forcedResp = await fetchAnthropicWithRetry(
      ANTHROPIC_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          // turnModel, not the MODEL constant: an escalated turn (B-P2) that
          // hits the iteration cap must force its final answer from Sonnet,
          // not silently drop back to Haiku.
          model: turnModel,
          max_tokens: MAX_TOKENS,
          // Plain system string, no cache_control, no tools — guarantees text.
          system: SYSTEM_PROMPT,
          messages,
        }),
      },
      "forced",
    );
    if (!forcedResp.ok) {
      // Non-retryable status; same caveat as the main callAnthropic path.
      const body = await forcedResp.text().catch(() => "<unreadable>");
      throw new Error(`Anthropic API (forced) ${forcedResp.status}: ${body}`);
    }
    const forced = (await forcedResp.json()) as AnthropicResponse;
    const forcedLatencyMs = Date.now() - t0;
    const forcedText = forced.content.find(
      (b): b is AnthropicTextBlock => b.type === "text",
    );
    finalText = forcedText?.text ?? "";
    turnSamples.push({
      usage: forced.usage,
      latency_ms: forcedLatencyMs,
      tool_names: [],
      branch: "forced_final",
    });
    if (trace) {
      trace.forced_final = {
        latency_ms: forcedLatencyMs,
        response: {
          id: forced.id,
          model: forced.model,
          stop_reason: forced.stop_reason,
          usage: forced.usage,
          content: forced.content,
        },
      };
    }
  }

  // ── 7. Merge render directives ───────────────────────────────────────
  const renderEnvelope = mergeRenderDirectives(accumulatedResults);
  const quickReplies = Array.isArray(renderEnvelope.quickReplies)
    ? (renderEnvelope.quickReplies as unknown[])
    : undefined;
  const showRecordConfirmation =
    renderEnvelope.showRecordConfirmation &&
    typeof renderEnvelope.showRecordConfirmation === "object"
      ? (renderEnvelope.showRecordConfirmation as {
          vehicle_id: string;
          maintenance_type: string;
        })
      : undefined;

  // Empty text is fine when ANY render directive carries the turn (quick
  // replies, record confirmation, book service, reasoning, sources). Only
  // fall back when text AND every render directive are empty — that's a real
  // "nothing to say" failure.
  const hasAnyRender =
    !!quickReplies ||
    !!showRecordConfirmation ||
    renderEnvelope.showVehicleUpdate !== undefined ||
    renderEnvelope.bookService !== undefined ||
    renderEnvelope.linkButton !== undefined ||
    renderEnvelope.bookingCard !== undefined ||
    renderEnvelope.bookingsList !== undefined ||
    renderEnvelope.reasoning !== undefined ||
    renderEnvelope.sources !== undefined;
  if (!finalText && !hasAnyRender) {
    console.error(
      "[oto/chat] no text + no render after tool loop. iterations=" +
        iterations +
        " hitCap=" +
        hitCap +
        " — returning fallback text",
    );
    finalText =
      "I'm having trouble pulling that one together — can you rephrase or break it into a smaller question?";
  }

  // Voice-rail post-process: the prompt bans markdown bold for data points
  // and headers, but Haiku falls back to them under pressure (especially in
  // shorter responses or when emphasizing service names). Strip them
  // server-side as belt-and-suspenders. If real safety-critical emphasis is
  // ever needed in v0.8+, swap this for a directive that the chat UI
  // renders specially.
  finalText = stripVoiceMarkup(finalText);

  // ── 8. Persist both turns ────────────────────────────────────────────
  // Harness runs (debug + debug_skip_persist) skip persistence so iteration
  // doesn't pollute the user's real conversation history.
  const skipPersist = debug === true && debug_skip_persist === true;
  if (!skipPersist) {
    // B-P2: lock the conversation's vehicle anchor on first send. setVehicleId
    // had ZERO production call sites, so ai_conversations.vehicle_id stayed
    // null for every real chat — the viewer showed no car and a mid-chat
    // global-picker drift could repoint the envelope. Idempotent anchor-lock;
    // failure-isolated so it can never break the turn.
    if (activeVehicle?.id && !conversationVehicleId) {
      try {
        await ctx.runMutation(internal.ai_conversations.setVehicleIdInternal, {
          conversationId,
          vehicleId: activeVehicle.id as Id<"vehicles">,
        });
      } catch (e: any) {
        console.error("[oto/chat] vehicle anchor write failed (swallowed):", e?.message);
      }
    }

    await ctx.runMutation(internal.ai_messages.create, {
      conversation_id: conversationId,
      role: "user",
      content: message,
    });
    // Persist the render envelope alongside the assistant text so the inline
    // interactive components (booking flow, quick replies, cards, …) can be
    // rebuilt when this conversation is re-opened from history.
    const renderToPersist: Record<string, unknown> = {};
    if (quickReplies) renderToPersist.quickReplies = quickReplies;
    if (showRecordConfirmation)
      renderToPersist.showRecordConfirmation = showRecordConfirmation;
    if (renderEnvelope.bookService !== undefined)
      renderToPersist.bookService = renderEnvelope.bookService;
    if (renderEnvelope.linkButton !== undefined)
      renderToPersist.linkButton = renderEnvelope.linkButton;
    if (renderEnvelope.bookingCard !== undefined)
      renderToPersist.bookingCard = renderEnvelope.bookingCard;
    if (renderEnvelope.bookingsList !== undefined)
      renderToPersist.bookingsList = renderEnvelope.bookingsList;
    if (renderEnvelope.reasoning !== undefined)
      renderToPersist.reasoning = renderEnvelope.reasoning;
    if (renderEnvelope.sources !== undefined)
      renderToPersist.sources = renderEnvelope.sources;
    await ctx.runMutation(internal.ai_messages.create, {
      conversation_id: conversationId,
      role: "assistant",
      content: finalText,
      ...(Object.keys(renderToPersist).length
        ? { render: renderToPersist }
        : {}),
    });

    await ctx.runMutation(internal.ai_conversations.incrementMessageCount, {
      id: conversationId,
    });
    await ctx.runMutation(internal.ai_conversations.incrementMessageCount, {
      id: conversationId,
    });

    // Wave 3 forensic spine — DUAL-WRITE alongside ai_messages.
    // ----------------------------------------------------------------------
    // ai_messages is the mobile-render substrate; conversation_audit is the
    // append-only forensic record (WAVE_3_DESIGN.md §2.4, §3.2 strangler
    // pattern). Until Wave 5's read-cutover, BOTH are written per turn.
    // Failures here must NEVER break the turn — wrap in try/catch + swallow,
    // same as the legacy telemetry block below.
    //
    // turn_number convention: sortedMessages.length captures the pre-this-
    // turn ai_messages count, which is the canonical 0-indexed turn index
    // for this user-row. The assistant-row shares the same turn_number; the
    // helper's by_conversation_turn uniqueness check is on (id, turn, role)
    // so (user, N) + (assistant, N) cohabit a single turn cleanly.
    //
    // model_used translation: the recordTurn validator union is the short
    // literal "haiku" | "sonnet" (matches schema enum). chat.ts uses full
    // Anthropic model IDs (e.g. "claude-haiku-4-5-20251001"). We translate
    // at the call site here rather than loosen the helper enum — keeps
    // CI Rule 15 (written_by enum integrity) and the schema invariant
    // intact. If the turnModel ever fails to map, default to "haiku"
    // (the cascade origin per Locked Principle #2) so the assistant-row
    // satisfies the role-conditional invariant; log loudly so the drift
    // is visible.
    const turnNumber = sortedMessages.length;
    // Translate the full Anthropic model ID to the short literal the
    // recordTurn validator accepts. Default to "haiku" on any unmapped
    // value (the cascade origin per Locked Principle #2); log loudly so
    // drift is visible. Const-asserted return values pin the IIFE's
    // type to the literal union so TS doesn't widen to `string`.
    let modelShortLiteral: "haiku" | "sonnet";
    if (turnModel === SONNET_MODEL) {
      modelShortLiteral = "sonnet";
    } else if (turnModel === HAIKU_MODEL) {
      modelShortLiteral = "haiku";
    } else {
      console.warn(
        `[oto/chat] conversation_audit: unmapped turnModel "${turnModel}"; ` +
          `defaulting to "haiku" for the role=assistant recordTurn.`,
      );
      modelShortLiteral = "haiku";
    }

    try {
      // User-turn row — role-conditional invariant: no model_used /
      // prompt_version / tool_calls. content is the raw user message
      // before envelope-wrapping (forensic preference per dispatch).
      await ctx.runMutation(internal.oto.memoryEditing.recordTurn, {
        conversation_id: conversationId,
        turn_number: turnNumber,
        role: "user",
        content: message,
      });
    } catch (e: any) {
      console.error(
        "[oto/chat] conversation_audit user-row insert failed (swallowed):",
        e?.message,
      );
      // Sprint 2 Day 9 — observability: recordTurn swallow signal.
      ctx
        .runMutation(internal.oto.reliability.recordReliabilityEvent, {
          surface: "wave3_record_turn",
          kind: "swallowed",
          error_message: e?.message,
          user_id: user._id,
          conversation_id: conversationId,
          metadata: { role: "user", turn_number: turnNumber },
        })
        .catch((reportErr: unknown) => {
          console.error(
            "[oto/chat] recordReliabilityEvent itself failed (silent):",
            (reportErr as { message?: string })?.message,
          );
        });
    }

    try {
      // Assistant-turn row — role-conditional invariant requires
      // model_used + prompt_version. tool_calls carry the action-bearing tool
      // uses this turn (renders + state/memory writes) accumulated across the
      // loop; the conditional spread omits the field entirely on a text-only
      // turn so the row stays schema-valid (tool_calls is optional).
      await ctx.runMutation(internal.oto.memoryEditing.recordTurn, {
        conversation_id: conversationId,
        turn_number: turnNumber,
        role: "assistant",
        content: finalText,
        model_used: modelShortLiteral,
        prompt_version: SYSTEM_PROMPT_VERSION,
        ...(accumulatedToolCalls.length
          ? { tool_calls: accumulatedToolCalls }
          : {}),
      });
    } catch (e: any) {
      console.error(
        "[oto/chat] conversation_audit assistant-row insert failed (swallowed):",
        e?.message,
      );
      // Sprint 2 Day 9 — observability: recordTurn (assistant) swallow signal.
      ctx
        .runMutation(internal.oto.reliability.recordReliabilityEvent, {
          surface: "wave3_record_turn",
          kind: "swallowed",
          error_message: e?.message,
          user_id: user._id,
          conversation_id: conversationId,
          metadata: {
            role: "assistant",
            turn_number: turnNumber,
            model_used: modelShortLiteral,
          },
        })
        .catch((reportErr: unknown) => {
          console.error(
            "[oto/chat] recordReliabilityEvent itself failed (silent):",
            (reportErr as { message?: string })?.message,
          );
        });
    }

    // Wave 3 wire-in step 3 (commitControl — sonnet_turns_used counter).
    // ----------------------------------------------------------------------
    // A "sonnet turn" is one that COMPLETED on the Sonnet model. The natural
    // wire site is here, after the assistant recordTurn write — by this
    // point we know modelShortLiteral and the turn is irrevocable. Field-
    // class purity: control-class only (sonnet_turns_used). Failure-isolated
    // try/catch; a missing row or stale expected_turn must NEVER fail the
    // chat turn. The counter is monotonic per §7 D8 — commitControl rejects
    // decreases.
    //
    // Skip on harness debug runs to keep eval traffic out of the counter.
    if (!skipPersist && modelShortLiteral === "sonnet") {
      try {
        await ctx.runMutation(
          internal.oto.memoryEditing.initEpisodicControl,
          { conversation_id: conversationId },
        );
        const row: Doc<"conversation_episodic_control"> | null =
          await ctx.runQuery(
            internal.oto.memoryEditing.getEpisodicControl,
            { conversation_id: conversationId },
          );
        if (row) {
          await ctx.runMutation(internal.oto.memoryEditing.commitControl, {
            conversation_id: conversationId,
            expected_turn: row.updated_by_turn,
            delta: {
              sonnet_turns_used: row.sonnet_turns_used + 1,
            },
            next_turn: row.updated_by_turn + 1,
          });
        }
      } catch (e: any) {
        console.error(
          "[oto/chat] commitControl (sonnet_turns_used) mirror failed (swallowed):",
          e?.message,
        );
        // Sprint 2 Day 9 — observability: control-class mirror swallow.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "wave3_commit_control_sonnet",
            kind: "swallowed",
            error_message: e?.message,
            user_id: user._id,
            conversation_id: conversationId,
            metadata: { trigger: "sonnet_turns_used_counter" },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
      }
    }
  }

  // B-P1: assemble token + tool stats from the unconditional turnSamples
  // (pure function — tests/telemetryAssembly.test.ts). The old version
  // replayed trace.iterations, which only exist on debug runs, so every
  // PRODUCTION row recorded 0 tokens / 0 latency / constant branch — and
  // stamped the MODEL constant instead of the routed turnModel.
  const telemetryRow = assembleTelemetryRow(turnSamples, {
    model: turnModel,
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    iterationsUsed: iterations,
    hitCap,
  });

  if (trace) {
    trace.hit_cap = hitCap;
    trace.iterations_used = iterations;
    trace.final_text = finalText;
    trace.quick_replies = quickReplies ?? null;
    trace.book_service = renderEnvelope.bookService ?? null;
    trace.persisted = !skipPersist;
    trace.usage_total = {
      input_tokens: telemetryRow.input_tokens,
      output_tokens: telemetryRow.output_tokens,
      cache_creation_tokens: telemetryRow.cache_creation_tokens ?? 0,
      cache_read_tokens: telemetryRow.cache_read_tokens ?? 0,
    };
  }

  // Polite-exit counter (Locked Principle #6) — server-managed, SERVER-DERIVED.
  // Beta feedback: the over-interrogation→booking guardrail "isn't firing." Root
  // cause: the count only advanced when Haiku self-tagged last_user_intent as
  // "symptom_narrowing" every turn, which it often forgot to do — so the count
  // never reached the threshold and the polite-exit block never appeared.
  //
  // We now derive "still interrogating" from observable turn shape instead of
  // trusting the model to tag itself:
  //   - rendered a booking this turn → narrowing resolved → reset to 0.
  //   - else Oto's reply asked a question (a "?") AND we're in a diagnostic arc
  //     (the model tagged a diagnostic/symptom intent, OR the count is already
  //     advancing) → increment. Once the arc starts, every further question-turn
  //     advances even if the model stops tagging.
  //   - else Oto answered without asking → the narrowing arc resolved → reset.
  // Skip on harness debug runs.
  if (!skipPersist) {
    try {
      const renderedBooking = renderEnvelope.bookService !== undefined;
      let nextCount: number | null = null;
      if (renderedBooking) {
        nextCount = 0;
      } else {
        const fresh = await ctx.runQuery(internal.ai_conversations.getById, {
          id: conversationId,
        });
        const latestIntent = (fresh as any)?.last_user_intent as string | undefined;
        const askedQuestion = /\?/.test(finalText ?? "");
        const modelTaggedNarrowing =
          !!latestIntent &&
          (latestIntent.startsWith("symptom_narrowing") ||
            latestIntent.startsWith("diagnos"));
        const alreadyNarrowing = diagnosticTurnCount > 0;
        // A booking OFFER ("...want to book that service now?") ends in a "?"
        // but is CONVERGENCE, not failed narrowing — the two-step
        // offer→confirm→render pattern means render_book_service hasn't fired
        // yet, so renderedBooking is still false this turn. Don't let the offer
        // turn inflate the count (it would push a successful conversation into
        // the forced not_sure exit one turn early). Hold the count on offer.
        const offeringBooking =
          /\b(book|booking|set (?:that|it) up|schedule)\b/i.test(finalText ?? "");
        if (askedQuestion && !offeringBooking && (modelTaggedNarrowing || alreadyNarrowing)) {
          nextCount = diagnosticTurnCount + 1;
        } else if (!askedQuestion && alreadyNarrowing) {
          // Oto stopped asking — arc resolved or moved on. Decay so a later,
          // unrelated clarifying question doesn't instantly re-trip the exit.
          nextCount = 0;
        }
        // offeringBooking turn → leave count unchanged (convergence, not a
        // failed-narrowing turn).
      }
      if (nextCount !== null) {
        await ctx.runMutation(internal.ai_conversations.setDiagnosticTurnCount, {
          id: conversationId,
          count: nextCount,
        });
      }
    } catch (e: any) {
      console.error("[oto/chat] polite-exit counter update failed (swallowed):", e?.message);
    }
  }

  // Block 5 telemetry — fire-and-forget. Failures must NOT break the turn.
  // Skip on harness runs (same gate as ai_messages persistence) so we don't
  // pollute analytics with debug traffic.
  if (!skipPersist) {
    try {
      await ctx.runMutation(internal.oto.telemetry.recordTurn, {
        conversation_id: conversationId,
        user_id: user._id,
        ...telemetryRow,
      });
    } catch (e: any) {
      console.error("[oto/chat] telemetry insert failed (swallowed):", e?.message);
    }

    // B-P2: measure the state-tool contract. A non-trivial turn (a data tool
    // fired — Oto engaged the user's real context) that never wrote
    // conversation state is Haiku silently under-calling
    // update_conversation_state. Fire a reliability event so the under-call
    // rate is visible and tunable. Fire-and-forget; never breaks the turn.
    const dataToolFired = telemetryRow.tools_called.some(
      (n) => OTO_TOOL_CATEGORY[n] === "data",
    );
    if (
      shouldFlagStateSkip({
        stateCalled: telemetryRow.state_called,
        dataToolFired,
      })
    ) {
      ctx
        .runMutation(internal.oto.reliability.recordReliabilityEvent, {
          surface: "state_tool_undercall",
          kind: "skipped",
          user_id: user._id,
          conversation_id: conversationId,
          metadata: {
            iterations_used: telemetryRow.iterations_used,
            tools_called: telemetryRow.tools_called,
            model: telemetryRow.model,
          },
        })
        .catch((e: unknown) =>
          console.error(
            "[oto/chat] state-undercall reliability event failed (silent):",
            (e as { message?: string })?.message,
          ),
        );
    }
  }

  // Pull through every render directive the merger produced. The mobile
  // app and the harness key off whichever fields are non-null to decide
  // which UI element to render.
  // Sprint 4 Day 1 Pass B — the single terminal booking render replaced
  // the legacy 7-field booking-flow surface (Pass G removed the residual
  // pull-through). render_book_service is now the only booking-flow render.
  const bookService =
    renderEnvelope.bookService !== undefined
      ? (renderEnvelope.bookService as SendMessageResult["bookService"])
      : undefined;
  // Sprint 3 Day 2/5 — link button, booking card/list. Each is
  // dispatcher-produced; chat.ts forwards the typed payload through.
  const linkButton =
    renderEnvelope.linkButton !== undefined
      ? (renderEnvelope.linkButton as SendMessageResult["linkButton"])
      : undefined;
  const bookingCard =
    renderEnvelope.bookingCard !== undefined
      ? (renderEnvelope.bookingCard as SendMessageResult["bookingCard"])
      : undefined;
  const bookingsList =
    renderEnvelope.bookingsList !== undefined
      ? (renderEnvelope.bookingsList as SendMessageResult["bookingsList"])
      : undefined;
  const reasoning = renderEnvelope.reasoning;
  const sources = renderEnvelope.sources;
  // render_vehicle_update — pull the merged directive through to the result so
  // the mobile confirm card and the director sim receive it (the dispatcher
  // produces it, mergeRenderDirectives carries it, but it was never forwarded
  // here — so the tool fired and silently rendered nothing).
  const showVehicleUpdate =
    renderEnvelope.showVehicleUpdate !== undefined
      ? (renderEnvelope.showVehicleUpdate as SendMessageResult["showVehicleUpdate"])
      : undefined;

  return {
    text: finalText,
    ...(quickReplies ? { quickReplies } : {}),
    ...(showRecordConfirmation ? { showRecordConfirmation } : {}),
    ...(showVehicleUpdate !== undefined ? { showVehicleUpdate } : {}),
    ...(bookService !== undefined ? { bookService } : {}),
    ...(linkButton !== undefined ? { linkButton } : {}),
    ...(bookingCard !== undefined ? { bookingCard } : {}),
    ...(bookingsList !== undefined ? { bookingsList } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(trace ? { trace } : {}),
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Strip markdown that violates Oto's voice rules. The prompt bans bold and
 * headers, but Haiku falls back to them under pressure. This is the
 * belt-and-suspenders pass — runs once on finalText right before persistence
 * and return. Safe to apply to all turns: nothing in Oto's voice depends on
 * markdown styling being preserved.
 */
function stripVoiceMarkup(s: string): string {
  if (!s) return s;
  return s
    // Bold **text** and __text__ → text
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    // ATX headers at line start: ## Title → Title
    .replace(/^#{1,6}\s+/gm, "");
}

// =============================================================================
// Anthropic retry + backoff (LLM Reliability Engineer mandate)
// =============================================================================
//
// Failure-mode handling for the Anthropic `/v1/messages` fetch. Any 5xx (and
// 429) is treated as transient — these are Anthropic-side / load issues that
// commonly recover on retry within seconds. 4xx-non-429 codes are programmer
// errors (bad API key, malformed payload, unknown model) and surface
// immediately so they get fixed instead of being papered over.
//
// Policy:
//   • Max 3 attempts (initial + 2 retries).
//   • Exponential backoff: 1000ms → 2000ms → 4000ms.
//   • If Anthropic sends a `Retry-After` header and it's reasonable (≤10s),
//     use it instead of the default backoff. >10s falls back to the schedule
//     (a long wait would blow past the action's effective budget).
//   • Network-level failures (fetch throws — ECONNRESET, DNS, etc.) are also
//     retried under the same policy.
//   • On retry-exhaust, throws `AnthropicTransientError` so the handler can
//     translate it to a user-friendly shape. Non-retryable failures throw
//     plain `Error` (preserving the current behavior so 400/401/403 still
//     surface loudly during dev).
//
// Success path is untouched: a 2xx response returns the parsed Response on
// the first attempt with no extra latency.
class AnthropicTransientError extends Error {
  readonly kind: "overloaded" | "transient";
  readonly lastStatus: number | null;
  readonly attempts: number;
  constructor(opts: {
    kind: "overloaded" | "transient";
    lastStatus: number | null;
    attempts: number;
    message: string;
  }) {
    super(opts.message);
    this.name = "AnthropicTransientError";
    this.kind = opts.kind;
    this.lastStatus = opts.lastStatus;
    this.attempts = opts.attempts;
  }
}

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const;
const RETRY_AFTER_CEILING_MS = 10_000;

function isRetryableStatus(status: number): boolean {
  // 5xx (any) + 429. Anthropic uses 529 for "overloaded"; treat the same.
  return status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  // Retry-After can be either a delta in seconds or an HTTP-date. We only
  // honor the seconds form — date-form would require a clock skew that
  // Convex actions don't reliably have.
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = Math.round(seconds * 1000);
  if (ms > RETRY_AFTER_CEILING_MS) return null;
  return ms;
}

async function fetchAnthropicWithRetry(
  url: string,
  init: RequestInit,
  contextLabel: string,
): Promise<Response> {
  let lastStatus: number | null = null;
  let lastBodyPreview = "";
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    let response: Response | null = null;
    let networkErr: unknown = null;
    try {
      response = await fetch(url, init);
    } catch (e) {
      networkErr = e;
    }

    // Verification gap: no unit-test framework yet for this path. Telemetry
    // below lets us confirm post-hoc whether the retry logic engages in prod.
    if (networkErr) {
      const errMsg = (networkErr as { message?: string })?.message ?? String(networkErr);
      lastBodyPreview = `network error: ${errMsg}`;
      lastStatus = null;
      if (attempt >= RETRY_MAX_ATTEMPTS) break;
      const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 4000;
      console.warn(
        `[callAnthropic${contextLabel ? `:${contextLabel}` : ""}] retry attempt ${attempt}/${RETRY_MAX_ATTEMPTS} after network error="${errMsg}", backoff=${backoff}ms`,
      );
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    // TS narrowing: networkErr is null here so response is non-null.
    const resp = response as Response;
    if (resp.ok) return resp;

    lastStatus = resp.status;
    if (!isRetryableStatus(resp.status)) {
      // Non-retryable: hand the Response back to the caller, which preserves
      // its existing error-message format (`Anthropic API ${status}: ${body}`).
      return resp;
    }

    // Retryable. Stash a small preview for the final error message, then
    // either back off or give up.
    lastBodyPreview = await resp.text().catch(() => "<unreadable>");
    if (attempt >= RETRY_MAX_ATTEMPTS) break;
    const retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
    const defaultBackoff = RETRY_BACKOFF_MS[attempt - 1] ?? 4000;
    const backoff = retryAfterMs ?? defaultBackoff;
    console.warn(
      `[callAnthropic${contextLabel ? `:${contextLabel}` : ""}] retry attempt ${attempt}/${RETRY_MAX_ATTEMPTS} after status=${resp.status}, retry-after=${retryAfterMs ?? "null"}, backoff=${backoff}ms`,
    );
    await new Promise((r) => setTimeout(r, backoff));
  }

  // Exhausted — translate to the friendly-fallback-eligible error class.
  // 529 = Anthropic's overloaded code; expose it distinctly so the UX layer
  // can surface a tailored message if it wants.
  const kind: "overloaded" | "transient" =
    lastStatus === 529 || lastStatus === 503 ? "overloaded" : "transient";
  const preview = lastBodyPreview.slice(0, 200);
  throw new AnthropicTransientError({
    kind,
    lastStatus,
    attempts: RETRY_MAX_ATTEMPTS,
    message: `Anthropic API ${lastStatus ?? "network"} after ${RETRY_MAX_ATTEMPTS} attempts${contextLabel ? ` (${contextLabel})` : ""}: ${preview}`,
  });
}

async function callAnthropic({
  apiKey,
  messages,
  tools,
  model,
}: {
  apiKey: string;
  messages: AnthropicMessage[];
  tools: ReadonlyArray<unknown>;
  model?: string;
}): Promise<AnthropicResponse> {
  const modelToUse = model ?? MODEL;
  // Block 6 — prompt caching.
  // System prompt is the largest static block; wrap it as a single text
  // content block with cache_control: ephemeral. Anthropic returns the
  // cache_creation tokens on first call and cache_read tokens on every
  // subsequent call within the TTL. Cost on cached input drops ~90% relative
  // to a normal input token.
  //
  // B-P4: ttl "1h" (GA — no beta header). The default 5-minute TTL silently
  // expires during normal conversation gaps (user reading/typing between
  // turns), forcing a full-price re-read of the large system prompt + tools
  // on the next turn. 1h survives those gaps; the doubled write cost (2x vs
  // 1.25x) breaks even at 3 cache reads, which a multi-turn chat clears
  // easily.
  const CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;
  const systemBlocks: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral"; ttl?: string };
  }> = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: CACHE_CONTROL,
    },
  ];
  // Merge OUR tool schemas + server-managed (Anthropic-provided) tools.
  // Cache breakpoint goes on the last OUR-tool entry; server-managed tools
  // follow it. Anthropic caches everything up to the breakpoint.
  const ourTools = tools.length > 0
    ? tools.map((t, i) =>
        i === tools.length - 1
          ? { ...(t as object), cache_control: CACHE_CONTROL }
          : t,
      )
    : tools;
  const mergedTools = [...(ourTools as unknown[]), ...SERVER_MANAGED_TOOLS];

  const response = await fetchAnthropicWithRetry(
    ANTHROPIC_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // web_search is currently a beta feature — required header.
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelToUse,
        max_tokens: MAX_TOKENS,
        system: systemBlocks,
        tools: mergedTools,
        messages,
      }),
    },
    "main",
  );

  if (!response.ok) {
    // Reached only on non-retryable codes (4xx-non-429). The retry wrapper
    // throws AnthropicTransientError on retry-exhaust before we get here.
    const body = await response.text().catch(() => "<unreadable>");
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }

  return (await response.json()) as AnthropicResponse;
}

// -----------------------------------------------------------------------------
// Callable map — closes over ctx so dispatcher.ts never sees Convex types.
// Three callables for this slice; add entries here when wiring more tools.
// -----------------------------------------------------------------------------

function buildCallables(
  ctx: any,
  conversationId: Id<"ai_conversations">,
  userId: Id<"users">,
  // Wave 3 wire-in (D-3.2): snapshot of established_facts AT TURN START.
  // The update_conversation_state callable diffs the NEW established_facts
  // (sent by Haiku via the tool args) against this snapshot and mirrors
  // each new entry into the append-only conversation_facts table via
  // recordConversationFact. Captured in sendMessageHandler before the
  // tool-use loop begins so concurrent Haiku iterations within the same
  // turn observe a consistent "previous" baseline (only the FIRST diff
  // of the turn ever sees new entries; subsequent same-turn calls observe
  // their own writes already merged into the array, so the diff degenerates
  // to empty — append-only invariant preserved).
  previousEstablishedFacts: string[],
  // Wave 3 wire-in: turn number for conversation_facts.source_turn.
  // Convention matches the conversation_audit recordTurn wire-in: this is
  // sortedMessages.length captured pre-this-turn.
  factSourceTurn: number,
  // Wave 3 wire-in step 3 (commitEpisodic — WAVE_3_DESIGN §2.3): pre-turn
  // snapshots of the episodic field-class. `null` is the legacy-unset
  // sentinel (the first turn for this conversation finds ai_conversations
  // with no mood/arc populated yet). The state callable diffs Haiku's new
  // values against these to decide when to mirror to
  // conversation_episodic_control via commitEpisodic. Field-class purity is
  // upheld here: the closure carries mood + arc but NOT current_model /
  // counters; control-class mirroring lives at its OWN call sites
  // (request_sonnet_handoff, request_haiku_handback, per-turn sonnet usage)
  // never through update_conversation_state.
  previousMood: string | null,
  previousArcSummary: string | null,
  // Wave 7.2 (Sprint 2 Day 10) — pre-turn degradation-ladder DEGRADED gate.
  // When true (ladder state DEGRADED), the `retrieve_vehicle_facts` callable
  // overrides the cascade dispatch's `no_web_search: false` production
  // default to `true` so T3 web_search is stripped for the duration of this
  // turn. Falls back to `false` on FULL (the only other state that reaches
  // buildCallables; MINIMAL/DOWN short-circuit before the callable map is
  // built). See docs/SPRINT_2/WAVE_7_2_DEGRADATION_LADDER.md §4.2.
  noWebSearchOverride: boolean,
): ToolCallables {
  // Wave 7.3 Option B: counter-bump helper for action-context moat reads.
  // Invoked AFTER each ctx.runQuery into a moat-reading query function
  // with the row-count delta. Errors are swallowed -- the moat read has
  // already completed and we must not let a bump failure break the turn.
  // The decision (ok/soft_block/hard_block) is currently logged only;
  // see queryMoat.ts header for the rationale (action-side bump is an
  // alarm signal, not a circuit breaker -- the read already happened).
  const bumpMoat = async (
    tableHint: string,
    rowsDelta: number,
  ): Promise<void> => {
    if (rowsDelta <= 0) return;
    try {
      const { decision } = (await ctx.runMutation(
        internal.oto.queryMoat.bumpUserCounter,
        { userId, rowsDelta },
      )) as { decision: "ok" | "soft_block" | "hard_block" };
      if (decision !== "ok") {
        console.warn(
          `[oto/chat] moat counter ${decision} for user=${userId} after ` +
            `${rowsDelta}-row read of ${tableHint}`,
        );
      }
    } catch (e: any) {
      console.error(
        `[oto/chat] bumpUserCounter failed (swallowed) for ${tableHint}:`,
        e?.message,
      );
    }
  };
  return {
    /**
     * list_services_for_vehicle — the catalog filtered by the vehicle's
     * structural applicability (Schema Gap 4 closed, Jun-10): joins the
     * resolved vehicle_config through the SAME isServiceApplicable rules as
     * the booking surface, so Oto can no longer offer a PS flush on an EPS
     * car or an oil change on an EV. Fails open to the full catalog when the
     * vehicle/config can't be resolved (see oto/applicableServices.ts).
     */
    list_services_for_vehicle: async (input) => {
      const vehicleId = (input.vehicle_id ?? "") as string;
      const listed = await ctx.runQuery(
        internal.oto.applicableServices.listServicesForUserVehicle,
        {
          actingUserId: userId,
          ...(vehicleId ? { vehicle_id: vehicleId } : {}),
        },
      );
      // Wave 7.3 Option B: services is a moat table; bump counter by row count.
      await bumpMoat("services", listed?.length ?? 0);
      return listed;
    },

    /**
     * get_service_details — slug → full row from the services table.
     *
     * Validates the slug against OTOPAIR_SERVICE_SLUGS first so the AI gets
     * a clear error if it invented a name (and so we never run a wide query
     * for a slug that can't exist).
     */
    get_service_details: async (input) => {
      const slug = (input.service_slug ?? "") as string;
      if (!OTOPAIR_SERVICE_SLUGS.includes(slug as never)) {
        throw new Error(
          `Unknown service slug "${slug}". Must match the seeded services catalog.`,
        );
      }
      const all: Array<Doc<"services">> = await ctx.runQuery(
        api.services.list,
        {},
      );
      // Wave 7.3 Option B: services moat table; bump counter by row count.
      await bumpMoat("services", all?.length ?? 0);
      const svc = (all ?? []).find((s) => s.slug === slug);
      if (!svc) throw new Error(`Service "${slug}" not in catalog.`);
      return {
        slug: svc.slug,
        name: svc.name,
        description: svc.description ?? null,
        default_labor_hours: svc.default_labor_hours ?? null,
        has_options: svc.has_options === true,
        is_labor_only: svc.is_labor_only === true,
        requires_parts: svc.requires_parts === true,
        requires_fluids: svc.requires_fluids === true,
        requires_ice_engine: svc.requires_ice_engine === true,
        requires_timing_belt: svc.requires_timing_belt === true,
        requires_hydraulic_ps: svc.requires_hydraulic_ps === true,
        requires_differential: svc.requires_differential === true,
        requires_rotatable_tires: svc.requires_rotatable_tires === true,
        requires_state_inspection: svc.requires_state_inspection === true,
        requires_emissions_test: svc.requires_emissions_test === true,
        min_model_year: svc.min_model_year ?? null,
      };
    },

    /**
     * get_vehicle_health — health score + per-type maintenance breakdown.
     *
     * Backed by api.oto.vehicleHealth.getVehicleHealth. The `vehicle_id` arg
     * is the Convex `vehicles._id` emitted in the `<vehicle>` block's `id:`
     * field. The query resolves it to a vehicle_owners row internally; the AI
     * layer never sees the VIN.
     */
    get_vehicle_health: async (input) => {
      const vehicleId = (input.vehicle_id ?? "") as string;
      // Resolve against the already-resolved acting user (works for real auth
      // AND the simulation harness, where sub-query auth would be null).
      return await ctx.runQuery(internal.oto.vehicleHealth.getVehicleHealthForUser, {
        actingUserId: userId,
        vehicle_id: vehicleId,
      });
    },

    /**
     * get_projected_health_score — counterfactual score if one item flipped
     * to on-time. Pass the item_id from a prior get_vehicle_health response.
     */
    get_projected_health_score: async (input) => {
      const vehicleId = (input.vehicle_id ?? "") as string;
      const itemId = (input.item_id ?? "") as string;
      return await ctx.runQuery(
        internal.oto.vehicleHealth.getProjectedHealthScoreForUser,
        { actingUserId: userId, vehicle_id: vehicleId, item_id: itemId },
      );
    },

    /**
     * get_bookings — user-scoped booking list with status filter.
     * Identity pulled from auth in the query handler; no user_id passes the
     * tool boundary. Default limit is enforced by the schema validator.
     */
    get_bookings: async (input) => {
      const statusFilter = (input.status_filter ?? "active") as
        | "active"
        | "completed"
        | "all";
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? (input.limit as number)
          : undefined;
      return await ctx.runQuery(internal.oto.bookings.getBookingsForUser, {
        actingUserId: userId,
        status_filter: statusFilter,
        ...(limit !== undefined ? { limit } : {}),
      });
    },

    /**
     * get_pending_bookings — Sprint 3 Day 5 §14.3. Strict subset of
     * get_bookings: returns ONLY status === "pending" rows (not the broader
     * "active" set of pending + confirmed + in_progress). Identity pulled
     * from auth in the query handler; no user_id passes the tool boundary.
     * Default limit is enforced by the schema validator (5, max 20).
     */
    get_pending_bookings: async (input) => {
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? (input.limit as number)
          : undefined;
      return await ctx.runQuery(internal.oto.bookings.getPendingBookingsForUser, {
        actingUserId: userId,
        ...(limit !== undefined ? { limit } : {}),
      });
    },

    /**
     * get_due_services — overdue + due_soon services for the active vehicle.
     * `vehicle_id` is the Convex `vehicles._id` from the <vehicle> envelope
     * block (same convention as get_vehicle_health). Resolved server-side.
     */
    get_due_services: async (input) => {
      const vehicleId = (input.vehicle_id ?? "") as string;
      return await ctx.runQuery(internal.oto.dueServices.getDueServicesForUser, {
        actingUserId: userId,
        vehicle_id: vehicleId,
      });
    },

    /**
     * get_vehicle_facts — specs for the user's vehicle (engine, transmission,
     * tire fitment, fluids). Same `vehicle_id` convention as the other
     * vehicle-scoped tools.
     */
    get_vehicle_facts: async (input) => {
      const vehicleId = (input.vehicle_id ?? "") as string;
      const result = await ctx.runQuery(internal.oto.vehicleFacts.getVehicleFactsForUser, {
        actingUserId: userId,
        vehicle_id: vehicleId,
      });
      // Wave 7.3 Option B: getVehicleFacts reads trim_specs (1 row) plus
      // joined structural lookups (engine, transmission, trim, make, model)
      // via ctx.db.get -- those gets are NOT counted (point lookups by
      // primary key are not subject to the wide-scan exfiltration risk
      // that the moat counter targets). The trim_specs row is the only
      // moat-table read here; delta = 1 if a facts object came back.
      await bumpMoat("trim_specs", result ? 1 : 0);
      return result;
    },

    /**
     * lookup_vehicle_spec — comparison-car factual lookup against the
     * catalog (any car, not just the user's). Fuzzy-matches free-text.
     */
    lookup_vehicle_spec: async (input) => {
      const q = (input.query ?? "") as string;
      const result = await ctx.runQuery(
        internal.oto.lookupVehicleSpec.lookupVehicleSpec,
        { query: q },
      );
      // Wave 7.3 Option B: lookupVehicleSpec scans the entire `makes` table
      // (EXEMPT-annotated direct read at line 118) plus `models` and
      // `vehicle_configs` filtered down by make. The returned shape exposes
      // `candidates[]` + an optional `matched`. We can't know the raw scan
      // size from the result alone; conservative attribution: bump by
      // (candidates.length + matched-presence). The wide-scan exposure is
      // bounded by the existing EXEMPT annotation -- this counter captures
      // the moat-distinct rows the caller actually saw.
      const cands = Array.isArray(result?.candidates)
        ? result.candidates.length
        : 0;
      const matched = result?.matched ? 1 : 0;
      await bumpMoat(
        "vehicle_configs+models+makes",
        cands + matched,
      );
      return result;
    },

    /**
     * retrieve_vehicle_facts — KB lookup. Two-layer: semantic if
     * question_text + embedding API key, else structural by config /
     * chassis / engine fallback.
     */
    retrieve_vehicle_facts: async (input) => {
      // v3 Wave 5.4 — Tier 2 cascade against vehicle_facts.
      // canonical-hash → structural → BM25 searchIndex.
      // EvalTest short-circuit: synthetic eval fixtures must never serve real users.
      const topic = (input.topic ?? "") as string;
      const topic_axis = (input.topic_axis ?? "vehicle") as
        | "vehicle"
        | "trim"
        | "chassis"
        | "engine"
        | "model_year";
      const question_text =
        typeof input.question_text === "string" ? input.question_text : "";
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const vehicle_config_id = input.vehicle_config_id as
        | Id<"vehicle_configs">
        | undefined;

      // EvalTest filter — short-circuit before invoking the cascade.
      if (vehicle_config_id) {
        const isEval = (await ctx.runQuery(
          internal.oto.evalTestFilter.isEvalTestConfigId,
          { vehicleConfigId: vehicle_config_id },
        )) as boolean;
        if (isEval) {
          return { mode: "kb_v3_cascade", tier: null, facts: [] };
        }
      }

      // Sprint 2 Day 8 — strangler completion. Production now calls
      // `runFullCascade` (T1 enrichment-table reads → T2 hash+struct+text →
      // T3 web_search) instead of `cascadeTier2` directly. Eval and prod
      // share ONE retrieval entry point — the cascade walk that
      // `evalHarness.runFullCascade` measures IS the cascade walk that
      // serves real users. `no_web_search: false` (T3 ENABLED in production;
      // the eval harness sets `true` for baseline runs to skip variable-cost
      // web_search). Return shape: `runFullCascade` returns
      //   { tier, facts, attempted_tiers }
      // vs `cascadeTier2`'s narrower
      //   { tier, facts }.
      // Consumer shape preservation: we map back to
      //   { mode: "kb_v3_cascade", tier, facts }
      // so downstream tool_result and moat-bump attribution stay byte-
      // identical to the pre-strangler behavior. `attempted_tiers` is
      // observability-only (logged when present); production consumers don't
      // surface it. If `runFullCascade` somehow fails (transient action
      // failure / scope mismatch / future schema drift), the try/catch
      // swallows + returns an empty-facts response — the chat turn never
      // breaks. Failure-isolation discipline matches the rest of Wave 3.
      let result: { tier: string | null; facts: any[] } = {
        tier: null,
        facts: [],
      };
      try {
        const cascadeResult = (await ctx.runAction(
          internal.oto.evalHarness.runFullCascade,
          {
            question_text,
            topic,
            topic_axis,
            ...(vehicle_config_id !== undefined ? { vehicle_config_id } : {}),
            ...(typeof input.chassis_code === "string"
              ? { chassis_code: input.chassis_code }
              : {}),
            ...(typeof input.engine_code === "string"
              ? { engine_code: input.engine_code }
              : {}),
            ...(limit !== undefined ? { limit } : {}),
            // Prod: T3 web_search ENABLED (eval pins `true` for baseline).
            // Wave 7.2 DEGRADED state override: when the pre-turn ladder gate
            // (sendMessageHandlerCore §2.5) detected DEGRADED, the
            // `noWebSearchOverride` closure flag is true and we strip T3
            // web_search from this turn's cascade. See
            // docs/SPRINT_2/WAVE_7_2_DEGRADATION_LADDER.md §4.2.
            no_web_search: noWebSearchOverride,
          },
        )) as {
          tier: string | null;
          facts: any[];
          attempted_tiers?: string[];
        };
        result = { tier: cascadeResult.tier, facts: cascadeResult.facts ?? [] };
        if (
          cascadeResult.attempted_tiers !== undefined &&
          cascadeResult.attempted_tiers.length > 0
        ) {
          console.log(
            `[oto/chat] runFullCascade attempted_tiers=${JSON.stringify(cascadeResult.attempted_tiers)} tier=${cascadeResult.tier} facts=${result.facts.length}`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          "[oto/chat] retrieve_vehicle_facts runFullCascade swallowed error:",
          msg,
        );
        // Sprint 2 Day 9 — observability: cascade-strangler swallow signal.
        // This surface feeds the FULL→DEGRADED ladder transition per
        // docs/SPRINT_2/WAVE_7_2_DEGRADATION_LADDER.md §2.1 (the web_search-
        // tagged failure pattern shows up here).
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "cascade_strangler_full_cascade",
            kind: "swallowed",
            error_message: msg,
            user_id: userId,
            conversation_id: conversationId,
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
        // Graceful empty-facts fallback — see comment above.
        result = { tier: null, facts: [] };
      }
      // Wave 7.3 Option B: runFullCascade internally walks T1 (enrichment-
      // owned reads — no vehicle_facts row) and T2 (cascadeTier2: HASH →
      // STRUCT → TEXT — reads vehicle_facts). The cascade is an action; its
      // sub-queries are query-context (cannot self-bump). We bump from here
      // on behalf of those internal reads with the delivered fact-count as
      // the delta. Same conservative attribution pattern as the other moat-
      // reading callables. Bump is a no-op for T1-only hits (those don't
      // read vehicle_facts), and over-bumping vs under-bumping here is the
      // designed trade-off (better to attribute a fictitious delta than
      // lose a real one).
      await bumpMoat("vehicle_facts", result?.facts?.length ?? 0);
      return { mode: "kb_v3_cascade", tier: result.tier, facts: result.facts };
    },

    /**
     * record_vehicle_fact — KB write. Persists the fact then (if an
     * embedding API key is set) embeds the question_text and patches the
     * embedding column for future semantic retrieval.
     */
    record_vehicle_fact: async (input) => {
      // v3 Day 4 — migrated from legacy recordFact action to recordVehicleFact mutation.
      // Helper requires canonical_question_key + clamps web_search confidence to <= 0.7.
      const VALID_SOURCES = new Set([
        "manufacturer",
        "oto_inferred",
        "web_search",
        "user_confirmed",
        "propagated",
      ]);
      const VALID_AXES = new Set([
        "vehicle",
        "trim",
        "chassis",
        "engine",
        "model_year",
      ]);

      const topic =
        typeof input.topic === "string" && input.topic.trim() ? input.topic : null;
      const factText =
        typeof input.fact_text === "string" && input.fact_text.trim()
          ? input.fact_text
          : null;
      const questionText =
        typeof input.question_text === "string" && input.question_text.trim()
          ? input.question_text
          : null;

      if (!topic || !factText || !questionText) {
        console.warn(
          "[oto/chat] record_vehicle_fact called with missing essential field(s); skipping write.",
          { topic, fact_text_len: factText?.length, question_text_len: questionText?.length },
        );
        return { ok: false, reason: "missing essential fields" };
      }

      const sourceRaw = typeof input.source === "string" ? input.source : "";
      const source: any = VALID_SOURCES.has(sourceRaw) ? sourceRaw : "oto_inferred";
      const axisRaw = typeof input.topic_axis === "string" ? input.topic_axis : "";
      const topic_axis: any = VALID_AXES.has(axisRaw) ? axisRaw : "vehicle";

      // Confidence: clamp web_search source to <= 0.7 (helper enforces).
      let confidence =
        typeof input.confidence === "number" &&
        input.confidence >= 0 &&
        input.confidence <= 1
          ? input.confidence
          : 0.5;
      if (source === "web_search" && confidence > 0.7) {
        console.warn(
          `[oto/chat] record_vehicle_fact: clamping web_search confidence ${confidence} -> 0.7`,
        );
        confidence = 0.7;
      }

      // canonical_question_key — v3 requirement for the canonical-hash cache.
      const canonical_question_key = await canonicalQuestionKey(questionText);

      const args: any = {
        topic,
        topic_axis,
        fact_text: factText,
        question_text: questionText,
        canonical_question_key,
        source,
        written_by: "chat_agent" as const,
        confidence,
      };
      for (const k of [
        "vehicle_config_id",
        "chassis_code",
        "engine_code",
        "make",
        "model",
        "trim_name",
        "answer_format",
        "cited_url",
      ]) {
        if (typeof input[k] === "string" && (input[k] as string).trim()) {
          args[k] = input[k];
        }
      }
      for (const k of ["year_min", "year_max"]) {
        if (typeof input[k] === "number" && Number.isFinite(input[k])) {
          args[k] = input[k];
        }
      }
      return await ctx.runMutation(
        internal.oto.vehicleFactsEditing.recordVehicleFact,
        args,
      );
    },

    /**
     * record_semantic_fact — Wave 3 §2.2 user_semantic_facts insert.
     *
     * The model invokes this when content is "worth remembering across
     * conversations" — durable preferences, profile attributes, dismissals.
     * Conversation-scoped observations belong to update_conversation_state
     * (different scope; the prompt rule disambiguates).
     *
     * Scope: RECORD ONLY. Reinforcement (asymptotic confidence bump on
     * re-observation) and retraction (soft-retract on contradiction) are
     * deferred to a future dispatch — they need contradiction/equivalence
     * detection beyond this dispatch's mandate.
     *
     * Failure-isolation discipline (matches the conversation_audit / state-
     * mirror wire-ins): try/catch, swallow, return ok=false on the inner
     * shape. A failed semantic-fact write MUST NEVER break the chat turn —
     * the helper enforces the (source, written_by) legality matrix and may
     * throw on invalid combinations; we degrade gracefully instead of
     * surfacing a tool error that Haiku would then narrate as failure.
     *
     * Argument mapping:
     *  - text → payload (the helper stores it verbatim as prose; the model
     *    has been instructed to write in third person referring to the user)
     *  - fact_type → fact_type (passed through to the schema-enforced union)
     *  - source → source (chat-agent path; "mechanic_confirmed" is rejected
     *    by the helper's (source, written_by) legality matrix anyway)
     *  - confidence → noted but NOT passed: recordUserSemanticFact takes a
     *    fixed initial confidence of 1.0 per the design's "stored is the
     *    last-reinforced value; decay computed at read time" discipline.
     *    The model's confidence arg becomes a guidance signal we log; future
     *    reinforce/retract dispatches consume it. Documented gap (PM ruling
     *    candidate); for now the design's 1.0-on-insert is authoritative.
     *  - vehicle_id → vehicle_id (optional; pass-through Convex id when set)
     *
     * written_by is fixed to "chat_agent" — this is the chat-agent write
     * surface (the only path Haiku has to reach user_semantic_facts).
     */
    record_semantic_fact: async (input) => {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const factTypeRaw =
        typeof input.fact_type === "string" ? input.fact_type : "";
      const sourceRaw =
        typeof input.source === "string" ? input.source : "user_stated";
      const confidence =
        typeof input.confidence === "number" &&
        input.confidence >= 0 &&
        input.confidence <= 1
          ? input.confidence
          : 0.5;
      const vehicleIdRaw =
        typeof input.vehicle_id === "string" && input.vehicle_id.trim()
          ? input.vehicle_id
          : null;

      // Validate fact_type against the schema enum. Reject silently (ok=false)
      // rather than throwing — failure-isolation: the chat turn must not break
      // on a model-supplied bad enum.
      const VALID_FACT_TYPES = new Set([
        "mechanic_preference",
        "service_preference",
        "communication_style",
        "vehicle_quirk",
        "history_anchor",
      ]);
      const VALID_SOURCES = new Set(["user_stated", "inferred_behavior"]);
      if (!text) {
        console.warn(
          "[oto/chat] record_semantic_fact called with empty text; skipping write.",
        );
        return { ok: false, reason: "missing text" };
      }
      if (!VALID_FACT_TYPES.has(factTypeRaw)) {
        console.warn(
          `[oto/chat] record_semantic_fact called with invalid fact_type="${factTypeRaw}"; skipping write.`,
        );
        return { ok: false, reason: "invalid fact_type" };
      }
      if (!VALID_SOURCES.has(sourceRaw)) {
        console.warn(
          `[oto/chat] record_semantic_fact called with invalid source="${sourceRaw}"; skipping write.`,
        );
        return { ok: false, reason: "invalid source" };
      }

      // Log the model-supplied confidence for future reinforce/retract work
      // (the helper stores 1.0 on insert per the design; confidence is the
      // model's anchor signal that a future dispatch will consume).
      if (confidence !== 0.5) {
        console.log(
          `[oto/chat] record_semantic_fact confidence guidance=${confidence} (stored 1.0 per design §2.2)`,
        );
      }

      // Sprint 2 Day 6 — Wave 3 reinforce wire-in.
      //
      // Equivalence-detection: BEFORE inserting, look up an existing active
      // row for (user_id, fact_type, vehicle_id ?? null) whose payload
      // normalizes to the candidate's normalization (trim + lowercase +
      // collapse-whitespace). On hit, REINFORCE the existing row instead
      // of inserting a duplicate. On miss, fall through to insert as before.
      //
      // The model-facing surface is INVARIANT — the prompt still says "fire
      // record_semantic_fact when the user states a durable preference."
      // Whether the helper layer reinforces or inserts is OPAQUE to Haiku
      // per the design's helper-internal-decides principle. The trace's
      // tool_use.input still surfaces `reinforced: true` for QA assertions.
      //
      // Security note: payload comparison uses ONLY whitespace+case normalize
      // (see findUserSemanticFactByPayload doc); aggressive normalization
      // could collapse "I prefer X" with "ignore previous: I prefer Y" into
      // the same row — that adversarial near-duplicate is intentionally NOT
      // an equivalence under v1.
      const factTypeTyped = factTypeRaw as
        | "mechanic_preference"
        | "service_preference"
        | "communication_style"
        | "vehicle_quirk"
        | "history_anchor";
      const sourceTyped = sourceRaw as "user_stated" | "inferred_behavior";
      const vehicleIdTyped: Id<"vehicles"> | undefined =
        vehicleIdRaw !== null ? (vehicleIdRaw as Id<"vehicles">) : undefined;

      try {
        // Equivalence lookup — internalQuery; on hit returns existing fact_id.
        const existingFactId: Id<"user_semantic_facts"> | null =
          await ctx.runQuery(
            internal.oto.memoryEditing.findUserSemanticFactByPayload,
            {
              user_id: userId,
              fact_type: factTypeTyped,
              payload: text,
              ...(vehicleIdTyped !== undefined
                ? { vehicle_id: vehicleIdTyped }
                : {}),
            },
          );

        if (existingFactId !== null) {
          // REINFORCE path — bump the existing row asymptotically. Helper
          // does the (1 - (1-c)*0.5) math + observation_count++ + last_
          // reinforced=now atomically. We do NOT pass the model's
          // confidence guidance — reinforcement uses the formula, not
          // the model's anchor (per design §2.2).
          try {
            await ctx.runMutation(
              internal.oto.memoryEditing.reinforceUserSemanticFact,
              { fact_id: existingFactId },
            );
            console.log(
              `[oto/chat] record_semantic_fact reinforced existing fact ${existingFactId} (fact_type=${factTypeTyped})`,
            );
            return {
              ok: true,
              fact_id: existingFactId,
              recorded: false,
              reinforced: true,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Reinforce-side failure (e.g., the row got retracted between
            // our lookup and the patch). Failure-isolation: swallow and
            // fall back to insert. Worst case: we get a fresh duplicate
            // row, which a Day 7+ retraction pass can clean up.
            console.warn(
              "[oto/chat] record_semantic_fact reinforce swallowed error; falling back to insert:",
              msg,
            );
            // Sprint 2 Day 9 — observability: reinforce-fallback signal.
            ctx
              .runMutation(internal.oto.reliability.recordReliabilityEvent, {
                surface: "wave3_record_semantic_fact_reinforce",
                kind: "swallowed",
                error_message: msg,
                user_id: userId,
                conversation_id: conversationId,
                metadata: { existing_fact_id: existingFactId },
              })
              .catch((reportErr: unknown) => {
                console.error(
                  "[oto/chat] recordReliabilityEvent itself failed (silent):",
                  (reportErr as { message?: string })?.message,
                );
              });
            // fall through to insert below
          }
        }

        // INSERT path — no equivalent active row found (or reinforce failed
        // open). Mirrors the pre-Day-6 behavior exactly.
        const insertArgs = {
          user_id: userId,
          fact_type: factTypeTyped,
          payload: text,
          source: sourceTyped,
          written_by: "chat_agent" as const,
          ...(vehicleIdTyped !== undefined
            ? { vehicle_id: vehicleIdTyped }
            : {}),
        };
        const factId = await ctx.runMutation(
          internal.oto.memoryEditing.recordUserSemanticFact,
          insertArgs,
        );
        return { ok: true, fact_id: factId, recorded: true };
      } catch (e) {
        // Outer envelope catch — helper may throw on the (source, written_by)
        // legality matrix or empty-payload guard; the equivalence lookup may
        // throw on a transient Convex read failure. Swallow per failure-
        // isolation discipline (matches the conversation_audit recordTurn
        // wire-in pattern; matches the Pass A setCurrentModel fix).
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          "[oto/chat] record_semantic_fact swallowed error:",
          msg,
        );
        // Sprint 2 Day 9 — observability: outer semantic-fact swallow signal.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "wave3_record_semantic_fact",
            kind: "swallowed",
            error_message: msg,
            user_id: userId,
            conversation_id: conversationId,
            metadata: { fact_type: factTypeTyped, source: sourceTyped },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
        return { ok: false, recorded: false };
      }
    },

    /**
     * update_conversation_state — state writeback. Persists Haiku's read of
     * the current mood, conversation arc, established facts, and intent
     * onto ai_conversations. Ack is trivial; the loop layer does NOT use
     * its result to gate continuation.
     *
     * Wave 3 wire-in (D-3.2 / WAVE_3_DESIGN §2.1): after the legacy
     * established_facts array is persisted onto ai_conversations, this
     * callable also DIFFS the new array against the pre-turn snapshot and
     * mirrors each NEW entry into the append-only conversation_facts table
     * via recordConversationFact. This is the structural fix for Doc 1
     * §3.3's "established_facts race" — typed rows replace the array.
     *
     * Failure-isolation discipline (matches the conversation_audit
     * recordTurn wire-in in commit 912ebe2): the mirror runs in try/catch
     * and SWALLOWS errors. A failed mirror MUST NEVER break the chat turn
     * — the legacy array write is what the working-memory builder still
     * reads from today; conversation_facts is the forensic substrate Wave 5
     * will switch to. Until Wave 5 cuts over, both surfaces co-exist.
     *
     * fact_type choice: "observation" — the closest semantic fit for an
     * AI-established conversation-context fact within the existing
     * discriminated-payload validator. The other options:
     *   - "id_reference" requires structured entity_type/entity_id (no fit)
     *   - "preference" requires dimension/value (no fit)
     *   - "hypothesis" is "Oto's working theory" — closer for diagnostic
     *     facts but the design's payload carries a `confidence` field that
     *     Haiku never emits explicitly for these strings; using observation
     *     dodges that mismatch
     *   - "user_quote" is "exact user phrasing verbatim" — wrong (these
     *     facts are AI-authored, not user-spoken)
     *
     * confidence handling: the dispatch suggested a 0.8 default. The
     * observation payload shape ({ kind, text }) does NOT carry confidence,
     * so the 0.8 default is documented here but not stored. If a future
     * dispatch needs stored confidence on session-established facts, the
     * cleanest path is to use the hypothesis payload (which has confidence)
     * or to introduce a new fact_type — both require schema changes that
     * the current dispatch explicitly forbids.
     */
    update_conversation_state: async (input) => {
      // Tool params use short names (arc / last_intent) — matching the
      // envelope labels Haiku reads. Translate to schema-column names for
      // the mutation. Back-compat: accept the long-form names too in case
      // Haiku falls back to them.
      const args: any = { id: conversationId };
      if (typeof input.mood === "string") args.mood = input.mood;
      const arc = (input.arc ?? input.arc_summary) as string | undefined;
      if (typeof arc === "string") args.arc_summary = arc;
      // Defensively coerce to strings + cap at 12 entries; captured here
      // so the Wave 3 mirror below uses the SAME normalized list that the
      // legacy mutation will see (no drift between the two writes).
      let normalizedNewFacts: string[] | null = null;
      if (Array.isArray(input.established_facts)) {
        normalizedNewFacts = (input.established_facts as unknown[])
          .filter((f): f is string => typeof f === "string")
          .slice(0, 12);
        args.established_facts = normalizedNewFacts;
      }
      const intent = (input.last_intent ?? input.last_user_intent) as
        | string
        | undefined;
      if (typeof intent === "string") args.last_user_intent = intent;
      await ctx.runMutation(internal.ai_conversations.updateState, args);

      // ── Wave 3 mirror: diff new vs previous, append new facts as
      // typed conversation_facts rows. ──────────────────────────────────
      // The pre-turn snapshot lives in the previousEstablishedFacts
      // closure arg. Convert to a Set for O(1) membership checks; "new"
      // means present in normalizedNewFacts but not in the previous set.
      // Each new entry becomes one observation row attributed to
      // chat_agent. Mutations are sequential (Promise.all would race the
      // conversation_audit recordTurn writes in some test harnesses);
      // count is bounded by 12 (the cap above) so latency is acceptable.
      if (normalizedNewFacts !== null) {
        try {
          const previousSet = new Set<string>(previousEstablishedFacts);
          const newEntries: string[] = [];
          for (const fact of normalizedNewFacts) {
            if (!previousSet.has(fact)) {
              newEntries.push(fact);
            }
          }
          for (const factText of newEntries) {
            try {
              // CROSS-CONVERSATION-INELIGIBLE by contract. These mirrored
              // established_facts are conversation-scoped session observations
              // (a symptom, a warning light, "checking health score"); they are
              // retained here as forensic/replay substrate but MUST NOT surface
              // in a FUTURE conversation's <recent_context> — the model
              // mis-attributes them to the user ("you mentioned…") and lets a
              // stale "now completed" observation override the live
              // get_vehicle_health record. The read side enforces this in
              // memoryEditing.getCrossConversationMemory (Pool A loop) by
              // skipping exactly the (fact_type:"observation",
              // written_by:"chat_agent") tuple written below. If you change
              // either value here, update that read-side guard in lock-step or
              // the pollution re-leaks silently.
              await ctx.runMutation(
                internal.oto.memoryEditing.recordConversationFact,
                {
                  conversation_id: conversationId,
                  fact_type: "observation" as const,
                  payload: {
                    kind: "observation" as const,
                    text: factText,
                  },
                  source_turn: factSourceTurn,
                  written_by: "chat_agent" as const,
                },
              );
            } catch (innerErr: any) {
              // Per-fact failure — log but keep processing the rest. A
              // single bad row must not poison the whole mirror.
              console.error(
                "[oto/chat] recordConversationFact failed for one entry (swallowed):",
                innerErr?.message,
                { fact: factText, turn: factSourceTurn },
              );
              // Sprint 2 Day 9 — observability: per-row conversation_fact swallow.
              ctx
                .runMutation(
                  internal.oto.reliability.recordReliabilityEvent,
                  {
                    surface: "wave3_record_conversation_fact",
                    kind: "swallowed",
                    error_message: innerErr?.message,
                    user_id: userId,
                    conversation_id: conversationId,
                    metadata: { turn: factSourceTurn, scope: "inner" },
                  },
                )
                .catch((reportErr: unknown) => {
                  console.error(
                    "[oto/chat] recordReliabilityEvent itself failed (silent):",
                    (reportErr as { message?: string })?.message,
                  );
                });
            }
          }
        } catch (e: any) {
          // Outer guard — same failure-isolation discipline as the
          // conversation_audit recordTurn wire-in. A broken mirror MUST
          // NEVER fail the chat turn; the legacy array on
          // ai_conversations is what the working-memory builder still
          // reads from until Wave 5 cuts over.
          console.error(
            "[oto/chat] conversation_facts mirror failed (swallowed):",
            e?.message,
          );
          // Sprint 2 Day 9 — observability: outer mirror swallow signal.
          ctx
            .runMutation(internal.oto.reliability.recordReliabilityEvent, {
              surface: "wave3_record_conversation_fact",
              kind: "swallowed",
              error_message: e?.message,
              user_id: userId,
              conversation_id: conversationId,
              metadata: { scope: "outer_mirror" },
            })
            .catch((reportErr: unknown) => {
              console.error(
                "[oto/chat] recordReliabilityEvent itself failed (silent):",
                (reportErr as { message?: string })?.message,
              );
            });
        }
      }

      // ── Wave 3 mirror step 3: episodic field-class delta ─────────────
      // If Haiku's update_conversation_state changed mood or arc_summary
      // versus the pre-turn snapshot, mirror those changes into
      // conversation_episodic_control via commitEpisodic. Field-class
      // purity: ONLY mood + arc_summary are passed; control-class fields
      // are NEVER touched here (CI Rule 16 + design §2.3 enforce that).
      //
      // last_user_intent is NOT mirrored — the §2.3 schema deliberately
      // drops it. The polite-exit counter still reads it from the legacy
      // ai_conversations.last_user_intent until Wave 5's read-cutover.
      //
      // Concurrency envelope: commitEpisodic enforces
      // expected_turn == row.updated_by_turn. The first turn for this
      // conversation finds an unseeded row (initEpisodicControl creates it
      // at updated_by_turn=0), so we read the row BEFORE calling
      // commitEpisodic to learn the current expected_turn. next_turn is
      // factSourceTurn + 1 — the canonical "after this turn finishes"
      // marker that matches the recordTurn convention used elsewhere in
      // this file. Subsequent commitEpisodic calls within the SAME chat
      // turn (e.g. Haiku calls update_conversation_state twice in one
      // tool-use iteration) will observe expected_turn advanced by the
      // FIRST commit and fail the gate — which is the correct fail-loud
      // posture per §7 D8 (a second state mutation in the same turn is
      // either a Haiku duplicate or a real race; both deserve telemetry).
      const newMood = typeof input.mood === "string" ? input.mood : null;
      const newArc =
        typeof (input.arc ?? input.arc_summary) === "string"
          ? ((input.arc ?? input.arc_summary) as string)
          : null;
      const moodChanged = newMood !== null && newMood !== previousMood;
      const arcChanged = newArc !== null && newArc !== previousArcSummary;
      if (moodChanged || arcChanged) {
        try {
          // Ensure the row exists; initEpisodicControl is idempotent (returns
          // the existing _id if a row is already there). This is the design-
          // gap solution surfaced by the wire-in: the §2.3 schema is mutable-
          // in-place and ships EMPTY by design (wave3Backfill no-ops the
          // table), so the first commitEpisodic per conversation must lazy-
          // seed. The bootstrap lives inside memoryEditing.ts so CI Rule 16
          // still defends the table from out-of-helper writes.
          await ctx.runMutation(
            internal.oto.memoryEditing.initEpisodicControl,
            { conversation_id: conversationId },
          );
          // Read the row to learn the current updated_by_turn — the helper
          // gates on expected_turn == updated_by_turn for concurrency
          // detection. A fresh row is at turn 0; commitEpisodic advances it.
          const row: Doc<"conversation_episodic_control"> | null =
            await ctx.runQuery(
              internal.oto.memoryEditing.getEpisodicControl,
              { conversation_id: conversationId },
            );
          if (!row) {
            throw new Error(
              "initEpisodicControl returned but row not readable",
            );
          }
          const delta: Record<string, unknown> = {};
          if (moodChanged) {
            // B-P5: map the tool's 7-value mood vocabulary to the §2.3
            // five-member episodic enum BY VALENCE (moodMap.ts). The old code
            // accepted only exact matches and flattened the other four tool
            // moods (calm/worried/hyped/confused) to "neutral", destroying the
            // signal — worried is really concerned, hyped is satisfied. An
            // unrecognized value still logs + falls back to neutral.
            const mapped = mapToolMoodToEpisodic(newMood as string);
            if (mapped !== null) {
              delta.mood = mapped;
            } else {
              console.warn(
                `[oto/chat] commitEpisodic: unmapped mood "${newMood}"; ` +
                  `defaulting to "neutral" for the conversation_episodic_control mirror.`,
              );
              delta.mood = "neutral" as const;
            }
          }
          if (arcChanged) {
            delta.arc_summary = newArc as string;
          }
          await ctx.runMutation(internal.oto.memoryEditing.commitEpisodic, {
            conversation_id: conversationId,
            expected_turn: row.updated_by_turn,
            delta,
            next_turn: row.updated_by_turn + 1,
          });
        } catch (e: any) {
          // Same failure-isolation discipline as the conversation_facts
          // mirror above and the conversation_audit recordTurn wire-in.
          // The legacy ai_conversations.mood / .arc_summary are what the
          // envelope builder still reads until Wave 5 cuts over;
          // conversation_episodic_control is the forensic substrate.
          console.error(
            "[oto/chat] commitEpisodic mirror failed (swallowed):",
            e?.message,
          );
          // Sprint 2 Day 9 — observability: episodic mirror swallow signal.
          ctx
            .runMutation(internal.oto.reliability.recordReliabilityEvent, {
              surface: "wave3_commit_episodic",
              kind: "swallowed",
              error_message: e?.message,
              user_id: userId,
              conversation_id: conversationId,
              metadata: { mood_changed: moodChanged, arc_changed: arcChanged },
            })
            .catch((reportErr: unknown) => {
              console.error(
                "[oto/chat] recordReliabilityEvent itself failed (silent):",
                (reportErr as { message?: string })?.message,
              );
            });
        }
      }

      return { ok: true, persisted_at: Date.now() };
    },

    /**
     * request_sonnet_handoff — Haiku escalates the NEXT turn to Sonnet.
     * Sets ai_conversations.current_model = "sonnet". Per-turn model selection
     * in sendMessageHandler reads this and switches model at turn start.
     * Telemetry captures the reason for calibration.
     *
     * Wave 3 wire-in step 3 (commitControl — WAVE_3_DESIGN §2.3): also
     * mirrors current_model and increments escalation_count on the
     * conversation_episodic_control row. Field-class purity: control-class
     * only; never touches mood / arc / flow. Same try/catch + swallow
     * discipline — a mirror failure must NEVER break the cascade.
     *
     * Counter rationale (escalation_count = number of times Haiku ESCALATED
     * to Sonnet for this conversation): handoff request IS the escalation
     * event, so incrementing here is the canonical site. Monotonic guard
     * in commitControl rejects decreases per §7 D8.
     */
    request_sonnet_handoff: async (input) => {
      const reason =
        typeof input.reason === "string" && input.reason.trim()
          ? input.reason
          : "unspecified";
      // Failure-isolation: a transient Convex hiccup here was a chat-turn
      // killer before this guard. On failure we surface ok:false so the model
      // loop knows the handoff didn't take + skip the mirror to avoid
      // canonical/mirror drift; user-facing turn continues normally.
      try {
        await ctx.runMutation(internal.ai_conversations.setCurrentModel, {
          id: conversationId,
          model: "sonnet",
        });
      } catch (e: any) {
        console.warn(
          "[oto/chat] setCurrentModel (sonnet handoff) failed (swallowed):",
          e?.message,
        );
        // Sprint 2 Day 9 — observability: sonnet handoff failure signal.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "setCurrentModel_sonnet_handoff",
            kind: "swallowed",
            error_message: e?.message,
            user_id: userId,
            conversation_id: conversationId,
            metadata: { reason },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
        return { ok: false, model: "haiku" as const, reason };
      }
      console.log(`[oto/chat] sonnet handoff requested (reason: ${reason})`);
      // ── Wave 3 control-class mirror ──────────────────────────────────
      try {
        await ctx.runMutation(
          internal.oto.memoryEditing.initEpisodicControl,
          { conversation_id: conversationId },
        );
        const row: Doc<"conversation_episodic_control"> | null =
          await ctx.runQuery(
            internal.oto.memoryEditing.getEpisodicControl,
            { conversation_id: conversationId },
          );
        if (row) {
          await ctx.runMutation(internal.oto.memoryEditing.commitControl, {
            conversation_id: conversationId,
            expected_turn: row.updated_by_turn,
            delta: {
              current_model: "sonnet" as const,
              escalation_count: row.escalation_count + 1,
              escalation_state: "active" as const,
            },
            next_turn: row.updated_by_turn + 1,
          });
        }
      } catch (e: any) {
        console.error(
          "[oto/chat] commitControl (sonnet handoff) mirror failed (swallowed):",
          e?.message,
        );
        // Sprint 2 Day 9 — observability: sonnet-handoff control-mirror swallow.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "wave3_commit_control_sonnet",
            kind: "swallowed",
            error_message: e?.message,
            user_id: userId,
            conversation_id: conversationId,
            metadata: { trigger: "sonnet_handoff_mirror", reason },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
      }
      return { ok: true, model: "sonnet", reason };
    },

    /**
     * request_haiku_handback — Sonnet returns routing to Haiku for the
     * NEXT turn. Clears the current_model field on the conversation.
     *
     * Wave 3 wire-in step 3 (commitControl): mirrors current_model back to
     * "haiku" and clears the escalation_state to "none". escalation_count
     * is NOT decremented (monotonic counter — handback does NOT undo the
     * escalation event; the count is a forensic record of how many times
     * Sonnet was engaged across the conversation lifetime).
     */
    request_haiku_handback: async (input) => {
      const reason =
        typeof input.reason === "string" && input.reason.trim()
          ? input.reason
          : "unspecified";
      // Failure-isolation (matches sonnet handoff above): swallow transient
      // Convex hiccups so the chat turn continues; ok:false signals to the
      // model loop that the handback didn't take.
      try {
        await ctx.runMutation(internal.ai_conversations.setCurrentModel, {
          id: conversationId,
          model: "haiku",
        });
      } catch (e: any) {
        console.warn(
          "[oto/chat] setCurrentModel (haiku handback) failed (swallowed):",
          e?.message,
        );
        // Sprint 2 Day 9 — observability: haiku handback failure signal.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "setCurrentModel_haiku_handback",
            kind: "swallowed",
            error_message: e?.message,
            user_id: userId,
            conversation_id: conversationId,
            metadata: { reason },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
        return { ok: false, model: "sonnet" as const, reason };
      }
      console.log(`[oto/chat] haiku handback (reason: ${reason})`);
      // ── Wave 3 control-class mirror ──────────────────────────────────
      try {
        await ctx.runMutation(
          internal.oto.memoryEditing.initEpisodicControl,
          { conversation_id: conversationId },
        );
        const row: Doc<"conversation_episodic_control"> | null =
          await ctx.runQuery(
            internal.oto.memoryEditing.getEpisodicControl,
            { conversation_id: conversationId },
          );
        if (row) {
          await ctx.runMutation(internal.oto.memoryEditing.commitControl, {
            conversation_id: conversationId,
            expected_turn: row.updated_by_turn,
            delta: {
              current_model: "haiku" as const,
              escalation_state: "none" as const,
            },
            next_turn: row.updated_by_turn + 1,
          });
        }
      } catch (e: any) {
        console.error(
          "[oto/chat] commitControl (haiku handback) mirror failed (swallowed):",
          e?.message,
        );
        // Sprint 2 Day 9 — observability: haiku-handback control-mirror swallow.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "wave3_commit_control_haiku",
            kind: "swallowed",
            error_message: e?.message,
            user_id: userId,
            conversation_id: conversationId,
            metadata: { trigger: "haiku_handback_mirror", reason },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
      }
      return { ok: true, model: "haiku", reason };
    },

    /**
     * retract_semantic_fact — Sprint 2 Day 7 — Wave 3 retract pair wire-in.
     *
     * Locates the user's most-recent active user_semantic_facts row whose
     * payload matches the model's `payload_descriptor` (case-insensitive
     * substring; fuzzier than reinforce's byte-exact rule per Day 6 paraphrase-
     * variance finding) and routes to memoryEditing.retractUserSemanticFact
     * with retracted_reason = the model's reason string.
     *
     * Mirrors the record_semantic_fact failure-isolation pattern: invalid
     * inputs and no-match conditions return `{ ok: false, reason }` without
     * throwing; transient Convex hiccups are swallowed via outer try/catch.
     * A failed retract MUST NEVER break the chat turn — the user's correction
     * is acknowledged conversationally even when the lookup misses.
     *
     * Conflict policy (multi-match): the lookup returns the row with the
     * highest _creationTime (most recently inserted active row). Documented in
     * memoryEditing.findActiveUserSemanticFactForRetract.
     */
    retract_semantic_fact: async (input) => {
      const factTypeRaw =
        typeof input.fact_type === "string" ? input.fact_type : "";
      const payloadDescriptor =
        typeof input.payload_descriptor === "string"
          ? input.payload_descriptor.trim()
          : "";
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      const vehicleIdRaw =
        typeof input.vehicle_id === "string" && input.vehicle_id.trim()
          ? input.vehicle_id
          : null;

      const VALID_FACT_TYPES = new Set([
        "mechanic_preference",
        "service_preference",
        "communication_style",
        "vehicle_quirk",
        "history_anchor",
      ]);
      if (!VALID_FACT_TYPES.has(factTypeRaw)) {
        console.warn(
          `[oto/chat] retract_semantic_fact called with invalid fact_type="${factTypeRaw}"; skipping.`,
        );
        return { ok: false, reason: "invalid fact_type" };
      }
      if (!payloadDescriptor) {
        console.warn(
          "[oto/chat] retract_semantic_fact called with empty payload_descriptor; skipping.",
        );
        return { ok: false, reason: "missing payload_descriptor" };
      }
      if (!reason) {
        console.warn(
          "[oto/chat] retract_semantic_fact called with empty reason; skipping.",
        );
        return { ok: false, reason: "missing reason" };
      }

      const factTypeTyped = factTypeRaw as
        | "mechanic_preference"
        | "service_preference"
        | "communication_style"
        | "vehicle_quirk"
        | "history_anchor";
      const vehicleIdTyped: Id<"vehicles"> | undefined =
        vehicleIdRaw !== null ? (vehicleIdRaw as Id<"vehicles">) : undefined;

      try {
        const lookupArgs = {
          user_id: userId,
          fact_type: factTypeTyped,
          payload_substring: payloadDescriptor,
          ...(vehicleIdTyped !== undefined
            ? { vehicle_id: vehicleIdTyped }
            : {}),
        };
        const matchedId: Id<"user_semantic_facts"> | null = await ctx.runQuery(
          internal.oto.memoryEditing.findActiveUserSemanticFactForRetract,
          lookupArgs,
        );
        if (matchedId === null) {
          console.warn(
            `[oto/chat] retract_semantic_fact: no matching active fact for fact_type="${factTypeTyped}" descriptor="${payloadDescriptor.slice(0, 80)}"`,
          );
          return { ok: false, reason: "no matching active fact found" };
        }
        await ctx.runMutation(
          internal.oto.memoryEditing.retractUserSemanticFact,
          { fact_id: matchedId, reason },
        );
        console.log(
          `[oto/chat] retract_semantic_fact retracted ${matchedId} (fact_type=${factTypeTyped})`,
        );
        return { ok: true, fact_id: matchedId, retracted: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Outer envelope catch — the lookup or the retract mutation may throw
        // on a transient Convex hiccup or on the helper's idempotent guard
        // (a concurrent retract patched the row between lookup and mutation).
        // Failure-isolation: swallow per Wave 3 pattern.
        console.warn(
          "[oto/chat] retract_semantic_fact swallowed error:",
          msg,
        );
        // Sprint 2 Day 9 — observability: retract semantic-fact swallow signal.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "wave3_retract_semantic_fact",
            kind: "swallowed",
            error_message: msg,
            user_id: userId,
            conversation_id: conversationId,
            metadata: { fact_type: factTypeTyped },
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
        return { ok: false, reason: "swallowed error" };
      }
    },

    /**
     * retract_conversation_fact — Sprint 2 Day 7 — Wave 3 retract pair wire-in.
     *
     * In-conversation counterpart of retract_semantic_fact. Looks up an
     * active conversation_facts row whose flattened text representation
     * (extractPayloadText) matches the model's `fact_descriptor` via
     * case-insensitive substring, then routes to
     * memoryEditing.retractConversationFact.
     *
     * retracted_by_turn is set to factSourceTurn (the same convention the
     * other wire-ins use — pre-turn sortedMessages.length). The existing
     * retractConversationFact helper's contract requires it.
     *
     * Failure-isolation as above: invalid input + no-match return ok:false;
     * transient throws are swallowed.
     */
    retract_conversation_fact: async (input) => {
      const factDescriptor =
        typeof input.fact_descriptor === "string"
          ? input.fact_descriptor.trim()
          : "";
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";

      if (!factDescriptor) {
        console.warn(
          "[oto/chat] retract_conversation_fact called with empty fact_descriptor; skipping.",
        );
        return { ok: false, reason: "missing fact_descriptor" };
      }
      if (!reason) {
        console.warn(
          "[oto/chat] retract_conversation_fact called with empty reason; skipping.",
        );
        return { ok: false, reason: "missing reason" };
      }

      try {
        const matchedId: Id<"conversation_facts"> | null = await ctx.runQuery(
          internal.oto.memoryEditing.findActiveConversationFactForRetract,
          {
            conversation_id: conversationId,
            fact_substring: factDescriptor,
          },
        );
        if (matchedId === null) {
          console.warn(
            `[oto/chat] retract_conversation_fact: no matching active fact for descriptor="${factDescriptor.slice(0, 80)}"`,
          );
          return { ok: false, reason: "no matching active fact found" };
        }
        await ctx.runMutation(
          internal.oto.memoryEditing.retractConversationFact,
          {
            fact_id: matchedId,
            reason,
            retracted_by_turn: factSourceTurn,
          },
        );
        console.log(
          `[oto/chat] retract_conversation_fact retracted ${matchedId} (turn=${factSourceTurn})`,
        );
        return { ok: true, fact_id: matchedId, retracted: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          "[oto/chat] retract_conversation_fact swallowed error:",
          msg,
        );
        // Sprint 2 Day 9 — observability: retract conversation-fact swallow.
        ctx
          .runMutation(internal.oto.reliability.recordReliabilityEvent, {
            surface: "wave3_retract_conversation_fact",
            kind: "swallowed",
            error_message: msg,
            user_id: userId,
            conversation_id: conversationId,
          })
          .catch((reportErr: unknown) => {
            console.error(
              "[oto/chat] recordReliabilityEvent itself failed (silent):",
              (reportErr as { message?: string })?.message,
            );
          });
        return { ok: false, reason: "swallowed error" };
      }
    },

    // -------------------------------------------------------------------
    // Loyalty / rewards data tools — Sprint 3 Day 3 §11 + §14.2 graduation.
    // INFORMATIONAL only. Per §14.2 Constraint 2 (Day 1 Pass F), Oto does
    // NOT support redemption claim in chat — `render_redemption_card` was
    // dropped. The claim flow lives on the Loyalty screen; these callables
    // surface state, history, options, and program rules ONLY.
    // -------------------------------------------------------------------

    /**
     * get_rewards_summary — comprehensive snapshot of the user's rewards
     * posture. Returns credit balance, miles-safe, services completed, shops
     * visited, and primary-vehicle tier in one shot. Composed from three
     * rewards.ts queries (wallet + membership-stats + primary-tier) because
     * no single rewards.ts query returns all five fields. Parallelized via
     * Promise.all to keep per-turn op count flat.
     *
     * userId is the closure-bound auth-resolved Convex users._id; no
     * user-supplied id crosses the tool boundary.
     */
    get_rewards_summary: async (_input) => {
      const [wallet, stats, tierInfo] = await Promise.all([
        ctx.runQuery(api.rewards.getWallet, { userId }) as Promise<
          { balance: number; auto_apply_to_booking?: boolean; miles_safe?: number } | null
        >,
        ctx.runQuery(api.rewards.getMembershipStats, { userId }) as Promise<{
          milesSafe: number;
          services: number;
          shops: number;
        }>,
        ctx.runQuery(api.rewards.getPrimaryVehicleTier, { userId }) as Promise<{
          tier: "driver" | "preferred" | "elite";
        }>,
      ]);
      return {
        credit_balance: wallet?.balance ?? 0,
        auto_apply_to_booking: wallet?.auto_apply_to_booking ?? true,
        miles_safe: stats.milesSafe,
        services_completed: stats.services,
        shops_visited: stats.shops,
        primary_vehicle_tier: tierInfo.tier,
      };
    },

    /**
     * get_loyalty_points_history — recent ownership_credit_transactions for
     * the user (both earn and redeem). Backed by api.rewards.getCreditHistory.
     * Default limit 5 per the schema; clamped at 1..20 in the schema validator,
     * but we re-coerce here defensively so a malformed Haiku call doesn't blow
     * past the cap.
     */
    get_loyalty_points_history: async (input) => {
      const rawLimit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.floor(input.limit as number)
          : 5;
      const limit = Math.max(1, Math.min(20, rawLimit));
      const transactions = (await ctx.runQuery(api.rewards.getCreditHistory, {
        userId,
        limit,
      })) as Array<{
        _id: string;
        amount: number;
        type: string;
        description?: string;
        reference_id?: string;
        expires_at?: number;
        created_at: number;
      }>;
      return {
        limit,
        transactions: (transactions ?? []).map((t) => ({
          id: t._id,
          amount: t.amount,
          type: t.type,
          description: t.description ?? null,
          reference_id: t.reference_id ?? null,
          expires_at: t.expires_at ?? null,
          created_at: t.created_at,
        })),
      };
    },

    /**
     * get_available_redemptions — what the user could redeem with current
     * balance. INFORMATIONAL ONLY (no claim affordance per §14.2 Constraint 2).
     * Backed by api.rewards.getAllDeals (full catalog) — the result includes
     * the user's current balance so Haiku can surface "you have enough" / "you
     * need $X more" framing. Optional `category` filter applied client-side.
     */
    get_available_redemptions: async (input) => {
      const category =
        typeof input.category === "string" && input.category.trim()
          ? input.category.trim().toLowerCase()
          : null;
      const [wallet, deals] = await Promise.all([
        ctx.runQuery(api.rewards.getWallet, { userId }) as Promise<
          { balance: number } | null
        >,
        ctx.runQuery(api.rewards.getAllDeals, {}) as Promise<
          Array<{
            _id: string;
            title?: string;
            name?: string;
            description?: string;
            category?: string;
            cost?: number;
            credit_cost?: number;
            value?: number;
          }>
        >,
      ]);
      const balance = wallet?.balance ?? 0;
      const filtered = (deals ?? []).filter((d) => {
        if (!category) return true;
        const dealCat = typeof d.category === "string" ? d.category.toLowerCase() : "";
        return dealCat === category;
      });
      const items = filtered.map((d) => {
        const cost = typeof d.cost === "number"
          ? d.cost
          : typeof d.credit_cost === "number"
            ? d.credit_cost
            : null;
        return {
          id: d._id,
          title: d.title ?? d.name ?? null,
          description: d.description ?? null,
          category: d.category ?? null,
          cost,
          value: typeof d.value === "number" ? d.value : null,
          affordable_now: cost !== null ? balance >= cost : null,
        };
      });
      return {
        credit_balance: balance,
        category_filter: category,
        // Reminder for Haiku — surfaced in the tool result so the model sees
        // it inline with the options. Pairs with the prompt-section rule:
        // claim flow happens on the Loyalty screen, never in chat.
        claim_flow_note:
          "Informational only. The actual claim happens on the Loyalty screen in the app — describe these options to the user and point them there if they want to redeem.",
        redemptions: items,
      };
    },

    /**
     * get_loyalty_program_info — program-level rules (tier breakpoints, earn
     * rates, expiry policy). Backed by a new api.rewards.getProgramInfo query
     * (added in the same dispatch). The query mirrors the constants embedded
     * in addCreditForCompletedBooking so program-rule answers stay in sync
     * with actual credit-issuance behavior.
     *
     * Optional `scope` narrows the response. Schema enforces the enum;
     * invalid values fall back to "overview" via the query's default branch.
     */
    get_loyalty_program_info: async (input) => {
      const VALID_SCOPES = new Set([
        "overview",
        "tiers",
        "earning_rules",
        "expiry_rules",
      ]);
      const scope =
        typeof input.scope === "string" && VALID_SCOPES.has(input.scope)
          ? (input.scope as
              | "overview"
              | "tiers"
              | "earning_rules"
              | "expiry_rules")
          : undefined;
      return await ctx.runQuery(
        api.rewards.getProgramInfo,
        scope !== undefined ? { scope } : {},
      );
    },

    // render_quick_replies and render_book_service (Sprint 4 Day 1 Pass B)
    // have no callables — render tools never do; the dispatcher's render
    // packager handles them without touching Convex.
  };
}
