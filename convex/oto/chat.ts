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

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const HISTORY_TURNS = 10;
const MAX_TOOL_ITERATIONS = 5;

const STUB_SYSTEM_PROMPT =
  "You are Oto, a friendly and educational automotive assistant for Otopair users. Explain the why behind your recommendations in 1-2 sentences.";

// Subset of OTO_TOOLS to surface in this slice. Add tool names here as later
// slices wire them; the dispatcher already covers the routing for the full
// inventory, so this list is the only place to extend.
const TOOL_NAMES_V1 = [
  "list_services_for_vehicle",
  "get_service_details",
  "render_quick_replies",
] as const;
const TOOLS_FOR_HAIKU = OTO_TOOLS.filter((t) =>
  (TOOL_NAMES_V1 as readonly string[]).includes(t.name),
);

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
// NOTE: Waleed's branch had `@ts-expect-error TS2589` directives here to
// suppress a circular-type quirk that surfaced in his api tree. In mobile's
// api tree the suppression isn't needed (tsc reports the directive as
// "Unused"), so it was removed per his own removal-criteria comment. If
// TS2589 reappears after adding more `oto.*` modules, restore both
// directives.
export const sendMessage = action({
  args: {
    conversationId: v.id("ai_conversations"),
    message: v.string(),
    // VIN of the vehicle the user has currently selected in the chat picker.
    // Optional — if omitted, the action falls back to most-recently-added.
    // Wins over the (forward-compat) conversation.vehicle_id rule.
    vehicleVin: v.optional(v.string()),
  },
  // `quickReplies` typed loose (v.any()) so the shape can evolve as we add
  // render tools without churning the validator on every change.
  returns: v.object({
    text: v.string(),
    quickReplies: v.optional(v.array(v.any())),
  }),
  handler: sendMessageHandler,
});

async function sendMessageHandler(
  // `ctx` typed `any` so this function's body doesn't drag the api tree into
  // its inferred type. Doc<…> annotations on each call-site result restore
  // type safety where it matters.
  ctx: any,
  {
    conversationId,
    message,
    vehicleVin,
  }: {
    conversationId: Id<"ai_conversations">;
    message: string;
    vehicleVin?: string;
  },
): Promise<{ text: string; quickReplies?: unknown[] }> {
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
    api.ai_conversations.getById,
    { id: conversationId },
  );
  if (!conversation) throw new Error("conversation not found");
  if (conversation.user_id !== user._id) throw new Error("not authorized");

  const allMessages: Array<Doc<"ai_messages">> = await ctx.runQuery(
    api.ai_messages.getByConversationId,
    { conversationId },
  );
  const sortedMessages = [...allMessages].sort((a, b) => a.timestamp - b.timestamp);
  const history = sortedMessages.slice(-HISTORY_TURNS);

  // ── 3. Resolve active vehicle ────────────────────────────────────────
  const conversationVehicleId = (conversation as Record<string, unknown>)
    .vehicle_id as string | undefined;

  const ownedRaw: OwnedVehicleRow[] | null = await ctx.runQuery(
    api.vehicles.getMyVehicles,
    {},
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
      activeVehicle = { id: activeRow.vehicle._id, display };
    }
  }

  // ── 4. Build the uncached-zone envelope ──────────────────────────────
  const envelope = buildEnvelope({
    userFirstName: user.first_name ?? null,
    vehicle: activeVehicle,
    history,
    userMessage: message,
  });
  console.log("[oto/chat] envelope sent to Haiku:\n" + envelope);

  // ── 5. Build the callable map ────────────────────────────────────────
  // chat.ts owns every `api.*` reference. Each callable is a closure that
  // captures ctx + api; dispatcher.ts never sees Convex types.
  const callables = buildCallables(ctx);

  // ── 6. Tool-use loop ─────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var not set");

  const messages: AnthropicMessage[] = [{ role: "user", content: envelope }];
  const accumulatedResults: ToolResultBlock[] = [];

  let finalText = "";
  let iterations = 0;
  let hitCap = false;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const resp = await callAnthropic({
      apiKey,
      messages,
      tools: TOOLS_FOR_HAIKU,
    });

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
    // the client. We dispatch them in-process, never feed their results
    // back to Haiku, and exit the loop after this iteration. Mixing the
    // two in one turn means the AI both asked for data AND emitted output;
    // we treat output as authoritative ("you're done") and exit anyway.
    const dataToolUses: ToolUseBlock[] = [];
    const terminalToolUses: ToolUseBlock[] = [];
    for (const tu of toolUses) {
      const cat = OTO_TOOL_CATEGORY[tu.name];
      if (cat === "data") dataToolUses.push(tu);
      else terminalToolUses.push(tu); // render | navigation | unknown
    }

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
      // Whatever text accompanied the render call is the user-facing prose.
      finalText = textBlock?.text ?? "";
      break;
    }

    if (dataToolUses.length === 0) {
      // No tools at all → pure text turn → terminal.
      finalText = textBlock?.text ?? "";
      break;
    }

    console.log(
      `[oto/chat] iteration ${iterations}: dispatching ${dataToolUses.length} data tool_use(s): ` +
        dataToolUses.map((tu) => tu.name).join(", "),
    );

    // Standard data-tool continuation: append assistant turn, dispatch,
    // append tool_results as next user turn, loop.
    messages.push({ role: "assistant", content: resp.content });

    const dataResults = await Promise.all(
      dataToolUses.map((tu) => executeTool(tu, callables)),
    );
    accumulatedResults.push(...dataResults);

    messages.push({ role: "user", content: dataResults });

    if (iterations === MAX_TOOL_ITERATIONS) {
      hitCap = true;
    }
  }

  // Forced-terminate: cap was hit with tool_use still firing. Call Anthropic
  // once more with `tools: []` so the model has to emit text.
  if (hitCap && !finalText) {
    console.warn(
      "[oto/chat] tool loop hit MAX_TOOL_ITERATIONS; forcing final response with tools disabled.",
    );
    const forced = await callAnthropic({
      apiKey,
      messages,
      tools: [],
    });
    const forcedText = forced.content.find(
      (b): b is AnthropicTextBlock => b.type === "text",
    );
    finalText = forcedText?.text ?? "";
  }

  // ── 7. Merge render directives ───────────────────────────────────────
  const renderEnvelope = mergeRenderDirectives(accumulatedResults);
  const quickReplies = Array.isArray(renderEnvelope.quickReplies)
    ? (renderEnvelope.quickReplies as unknown[])
    : undefined;

  // Empty text is fine when render directives carry the turn (e.g., the
  // model emits only quick-reply buttons with no accompanying prose). Only
  // throw if BOTH are empty — that's a real "nothing to say" failure.
  if (!finalText && !quickReplies) {
    throw new Error(
      "Anthropic returned no text and no render directives after tool loop",
    );
  }

  // ── 8. Persist both turns ────────────────────────────────────────────
  await ctx.runMutation(api.ai_messages.create, {
    conversation_id: conversationId,
    role: "user",
    content: message,
  });
  await ctx.runMutation(api.ai_messages.create, {
    conversation_id: conversationId,
    role: "assistant",
    content: finalText,
  });

  await ctx.runMutation(api.ai_conversations.incrementMessageCount, {
    id: conversationId,
  });
  await ctx.runMutation(api.ai_conversations.incrementMessageCount, {
    id: conversationId,
  });

  return quickReplies ? { text: finalText, quickReplies } : { text: finalText };
}

// =============================================================================
// Helpers
// =============================================================================

async function callAnthropic({
  apiKey,
  messages,
  tools,
}: {
  apiKey: string;
  messages: AnthropicMessage[];
  tools: ReadonlyArray<unknown>;
}): Promise<AnthropicResponse> {
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: STUB_SYSTEM_PROMPT,
      tools,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }

  return (await response.json()) as AnthropicResponse;
}

// -----------------------------------------------------------------------------
// Callable map — closes over ctx so dispatcher.ts never sees Convex types.
// Three callables for this slice; add entries here when wiring more tools.
// -----------------------------------------------------------------------------

function buildCallables(ctx: any): ToolCallables {
  return {
    /**
     * list_services_for_vehicle — returns the full 23-service catalog.
     *
     * Schema Gap 4 (inventory.md): the real implementation should join
     * vehicles → vehicle_configs → engines/chassis_specs/trim_specs and
     * apply `requires_*` filters against the resolved spec set. That's a
     * follow-up Convex query change; for this slice we surface raw data so
     * the AI layer's loop can be validated end-to-end.
     *
     * The schema's `vehicle_id` arg is accepted-and-ignored. The AI still
     * passes it because the inventory marks it required — preserving the
     * contract means no schema churn when filtering lands.
     */
    list_services_for_vehicle: async (_input) => {
      const all: Array<Doc<"services">> = await ctx.runQuery(
        api.services.list,
        {},
      );
      return (all ?? []).map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description ?? null,
        default_labor_hours: s.default_labor_hours ?? null,
        has_options: s.has_options === true,
        is_labor_only: s.is_labor_only === true,
      }));
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

    // render_quick_replies has no callable — the dispatcher's render packager
    // handles it without touching Convex.
  };
}
