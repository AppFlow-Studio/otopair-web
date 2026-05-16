// =============================================================================
// Oto AI — Tool Dispatcher (Phase 1)
// =============================================================================
//
// Executes a single Anthropic `tool_use` block. Pure logic — no Convex ctx,
// no api refs. The caller (chat action) owns the Convex bindings and passes
// in a `callables` map per call, which is what dispatcher invokes for data
// tools.
//
// Why this pattern: dispatcher.ts is registered in convex/_generated/api.d.ts
// as `api.oto.dispatcher`. If it imported `api` from _generated, its exported
// type signatures would pull the entire api tree into their inferred types,
// then the consumer (chat.ts) re-importing dispatcher would close a circular
// type cycle that trips TS2589 ("excessively deep instantiation"). Inverting
// the dependency keeps dispatcher.ts free of Convex types entirely.
//
// Three categories (see convex/oto/tools.ts → OTO_TOOL_CATEGORY):
//   • data       — look up `callables[name]`, invoke with toolUse.input,
//                  wrap result in the ok-envelope shape.
//   • render     — no DB call; package args into a directive that the chat
//                  action merges into the assistant ChatMessage envelope.
//   • navigation — Phase 1 only has navigate_to_payment. Packages a route
//                  directive the React Native client interprets.
//
// Companions:
//   • convex/oto/tools.ts             — schemas + category lookup
//   • convex/oto/chat.ts              — owns api bindings, builds callables
//   • docs/oto-ai/tool-inventory.md   — what maps to what, gaps, open Qs
// =============================================================================

import { OTO_TOOL_CATEGORY, OTOPAIR_SERVICE_SLUGS } from "./tools";

// -----------------------------------------------------------------------------
// Anthropic content-block types — kept loose so this file doesn't depend on
// the SDK and stays Convex-runtime-friendly.
// -----------------------------------------------------------------------------

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string; // JSON-stringified envelope
  is_error?: boolean;
}

// -----------------------------------------------------------------------------
// Result envelope types
// -----------------------------------------------------------------------------

interface OkEnvelope<T> {
  status: "ok";
  data: T;
}
interface ErrorEnvelope {
  status: "error";
  code:
    | "unknown_tool"
    | "invalid_args"
    | "not_implemented"
    | "not_authorized"
    | "not_found"
    | "upstream_failure";
  message: string;
}
type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

// -----------------------------------------------------------------------------
// Callable map — chat.ts builds this with bound api refs and passes it in.
// -----------------------------------------------------------------------------

export type ToolCallable = (input: Record<string, unknown>) => Promise<unknown>;
export type ToolCallables = Record<string, ToolCallable>;

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function executeTool(
  toolUse: ToolUseBlock,
  callables: ToolCallables,
): Promise<ToolResultBlock> {
  const category = OTO_TOOL_CATEGORY[toolUse.name];
  if (!category) {
    return errorResult(
      toolUse.id,
      "unknown_tool",
      `Tool "${toolUse.name}" is not registered. Schema/dispatcher out of sync.`,
    );
  }

  try {
    if (category === "render") return packageRenderDirective(toolUse);
    if (category === "navigation") return packageNavigationIntent(toolUse);
    return await executeDataTool(toolUse, callables);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(toolUse.id, "upstream_failure", message);
  }
}

// =============================================================================
// DATA TOOL DISPATCH
// =============================================================================
//
// Look up the named callable in the map and run it. The callable owns the
// underlying Convex query/mutation call AND any per-tool sanitization (e.g.,
// stripping stripe_* from a shop record). The dispatcher only wraps the
// result in the envelope shape Anthropic expects.

async function executeDataTool(
  toolUse: ToolUseBlock,
  callables: ToolCallables,
): Promise<ToolResultBlock> {
  const fn = callables[toolUse.name];
  if (!fn) {
    return errorResult(
      toolUse.id,
      "not_implemented",
      `Data tool "${toolUse.name}" has no callable wired in the chat action.`,
    );
  }
  const data = await fn(toolUse.input);
  return ok(toolUse.id, data);
}

// =============================================================================
// RENDER DIRECTIVE PACKAGING
// =============================================================================
//
// Each render tool produces a directive of the shape:
//   { type: "render", field: <ChatMessage key>, value: <field value> }
//
// The chat action collects all render directives emitted in one turn and
// merges them into the assistant ChatMessage envelope before persisting and
// returning to the client. Field names match services/ai/types.ts:ChatMessage
// 1:1.
//
// Gap 6 / Gap 7 (inventory.md): `timeSlots` and `bookingSummary` are envelope
// EXTENSIONS not yet present on ChatMessage. Documented for the slice that
// wires those render tools.

interface RenderDirective<T = unknown> {
  type: "render";
  field: string;
  value: T;
}

function packageRenderDirective(toolUse: ToolUseBlock): ToolResultBlock {
  switch (toolUse.name) {
    case "render_shop_carousel":
      return ok(toolUse.id, renderD("shops", toolUse.input.shops));

    case "render_service_picker":
      return ok(toolUse.id, {
        type: "render",
        directives: [
          { field: "showServicePicker", value: true },
          ...(toolUse.input.services
            ? [{ field: "pickerServices", value: toolUse.input.services }]
            : []),
        ],
      });

    case "render_time_selector":
      return ok(toolUse.id, {
        type: "render",
        directives: [
          { field: "timeSlots", value: toolUse.input.slots },
          { field: "timeSlotsShopId", value: toolUse.input.shop_id },
        ],
      });

    case "render_booking_confirmation":
      return ok(toolUse.id, renderD("bookingSummary", toolUse.input.summary));

    case "render_quick_replies":
      return ok(toolUse.id, renderD("quickReplies", toolUse.input.replies));

    case "render_reasoning":
      return ok(toolUse.id, renderD("reasoning", toolUse.input.steps));

    case "render_sources":
      return ok(toolUse.id, renderD("sources", toolUse.input.sources));

    default:
      return errorResult(
        toolUse.id,
        "unknown_tool",
        `Render tool "${toolUse.name}" has no packager branch.`,
      );
  }
}

function renderD<T>(field: string, value: T): RenderDirective<T> {
  return { type: "render", field, value };
}

// =============================================================================
// NAVIGATION PACKAGING
// =============================================================================
//
// Phase 1 has exactly ONE navigation case: payment.
// Route matches `app/(main-tabs)/ai-chat/index.tsx:619`:
//   router.push(`/home/mechanic/${mechanic.id}/payment`)
// The chat action returns this intent in its response payload; the React
// Native client triggers the navigation after rendering the AI's prose.

function packageNavigationIntent(toolUse: ToolUseBlock): ToolResultBlock {
  if (toolUse.name !== "navigate_to_payment") {
    return errorResult(
      toolUse.id,
      "unknown_tool",
      `Navigation tool "${toolUse.name}" is not registered. Phase 1 only supports navigate_to_payment.`,
    );
  }

  const slug = toolUse.input.service_slug as string;
  if (!OTOPAIR_SERVICE_SLUGS.includes(slug as never)) {
    return errorResult(
      toolUse.id,
      "invalid_args",
      `Unknown service slug "${slug}". Must match the seeded services catalog.`,
    );
  }

  return ok(toolUse.id, {
    type: "navigate",
    target: "payment",
    route: `/home/mechanic/${toolUse.input.mechanic_id}/payment`,
    params: {
      mechanic_id: toolUse.input.mechanic_id,
      service_slug: slug,
      slot_id: toolUse.input.slot_id,
      vehicle_id: toolUse.input.vehicle_id,
    },
  });
}

// =============================================================================
// Result envelope helpers
// =============================================================================

function ok<T>(toolUseId: string, data: T): ToolResultBlock {
  const envelope: Envelope<T> = { status: "ok", data };
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(envelope),
  };
}

function errorResult(
  toolUseId: string,
  code: ErrorEnvelope["code"],
  message: string,
): ToolResultBlock {
  const envelope: ErrorEnvelope = { status: "error", code, message };
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(envelope),
    is_error: true,
  };
}

// =============================================================================
// MERGING RENDER DIRECTIVES INTO THE ASSISTANT ENVELOPE
// =============================================================================
//
// The chat action calls executeTool for each tool_use block; for render tools,
// the result's `data` is a RenderDirective (single field+value) or a wrapper
// `{ type: "render", directives: [{field, value}, …] }` (multi-field). This
// helper flattens whatever was emitted in one turn into a `Partial<ChatMessage>`
// the caller can spread onto the assistant message.

export interface ChatMessageEnvelope {
  quickReplies?: unknown;
  shops?: unknown;
  showServicePicker?: boolean;
  pickerServices?: unknown;
  timeSlots?: unknown;
  timeSlotsShopId?: unknown;
  bookingSummary?: unknown;
  reasoning?: unknown;
  sources?: unknown;
  [k: string]: unknown;
}

export function mergeRenderDirectives(
  results: ToolResultBlock[],
): ChatMessageEnvelope {
  const out: ChatMessageEnvelope = {};
  for (const r of results) {
    if (r.is_error) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const env = parsed as { status?: string; data?: unknown };
    if (env.status !== "ok") continue;
    const d = env.data as
      | { type?: string; field?: string; value?: unknown; directives?: Array<{ field: string; value: unknown }> }
      | null
      | undefined;
    if (!d || d.type !== "render") continue;
    if (Array.isArray(d.directives)) {
      for (const sub of d.directives) out[sub.field] = sub.value;
    } else if (d.field) {
      out[d.field] = d.value;
    }
  }
  return out;
}
