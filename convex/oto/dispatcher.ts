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
//   • navigation — empty as of Sprint 4 Day 1 Pass B; the prior sole entry
//                  (navigate_to_payment) was removed when the booking flow
//                  consolidated into render_book_service. The category is
//                  retained for future re-introduction.
//
// Companions:
//   • convex/oto/tools.ts             — schemas + category lookup
//   • convex/oto/chat.ts              — owns api bindings, builds callables
//   • docs/oto-ai/tool-inventory.md   — what maps to what, gaps, open Qs
// =============================================================================

import { OTO_TOOL_CATEGORY } from "./tools";

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
    case "render_book_service":
      // Sprint 4 Day 1 Pass B — single terminal booking render. Trigger-only:
      // pass `service_slugs` (≥1; supports multi-service bundling) plus
      // optional prefills (`diagnostic_system`, `customer_notes`,
      // `recommended_priority`, `recommended_mechanic_id`). The mobile
      // BookServiceComponent handles every sub-stage internally — service
      // selection, per-service options, diagnostic notes (when applicable),
      // mechanic selection, time-slot picker, final review summary, AND the
      // redirect to the existing pay-screen (`/home/mechanic/{id}/payment`).
      // Oto's involvement ENDS at this call; there is no follow-up Oto turn
      // for the booking-flow stages. Replaces the prior 6-stage chain
      // (render_service_picker → render_diagnostic_form → render_shop_carousel
      // → render_time_selector → render_booking_confirmation →
      // navigate_to_payment) — all deprecated as of Sprint 4 Day 1 Pass A.
      return ok(
        toolUse.id,
        renderD("bookService", {
          service_slugs: toolUse.input.service_slugs,
          ...(toolUse.input.diagnostic_system !== undefined
            ? { diagnostic_system: toolUse.input.diagnostic_system }
            : {}),
          ...(toolUse.input.customer_notes !== undefined
            ? { customer_notes: toolUse.input.customer_notes }
            : {}),
          ...(toolUse.input.recommended_priority !== undefined
            ? { recommended_priority: toolUse.input.recommended_priority }
            : {}),
          ...(toolUse.input.recommended_mechanic_id !== undefined
            ? { recommended_mechanic_id: toolUse.input.recommended_mechanic_id }
            : {}),
        }),
      );

    case "render_record_confirmation":
      // Trigger-only: pass vehicle_id + maintenance_type. The mobile component
      // queries Convex for the actual maintenance_record row and renders its
      // current state with Confirm / Update buttons. Confirm path writes
      // confirmedHealthyAt: Date.now() via upsertRecord (locks status to
      // on_time for 90 days per CONFIRMED_HEALTHY_TTL_MS). Update path
      // collects new date+mileage in an inline form, then writes via
      // upsertRecord with serviceSource: "ai_chat_correction" and
      // confidence: "self_reported". Either way, the user's decision is
      // pushed back into conversation_state via appendEstablishedFact so
      // Oto sees it on the next turn.
      return ok(
        toolUse.id,
        renderD("showRecordConfirmation", {
          vehicle_id: toolUse.input.vehicle_id,
          maintenance_type: toolUse.input.maintenance_type,
        }),
      );

    case "render_vehicle_update":
      // Trigger-only: pass the vehicle-truth inputs Oto captured. The mobile
      // component renders a one-tap confirm card; on confirm it calls
      // vehicleTruth.applyVehicleTruth with the supplied mileage,
      // service_claims, and fault_lights. All three inputs are optional —
      // pass only what the user actually stated.
      // Sanitize every arg — Haiku emits malformed numerics ("" / NaN) that
      // would render blank on the card and throw at applyVehicleTruth's
      // v.optional(v.number()) validator. Drop non-finite numbers, non-string
      // fault lights, and structurally-invalid claims here at the choke point.
      {
        const mileage = toFiniteNumber(toolUse.input.mileage);
        const serviceClaims = sanitizeServiceClaims(toolUse.input.service_claims);
        const faultLights = Array.isArray(toolUse.input.fault_lights)
          ? toolUse.input.fault_lights.filter(
              (x): x is string => typeof x === "string" && x.trim().length > 0,
            )
          : undefined;
        return ok(
          toolUse.id,
          renderD("showVehicleUpdate", {
            ...(mileage !== undefined ? { mileage } : {}),
            ...(serviceClaims !== undefined ? { service_claims: serviceClaims } : {}),
            ...(faultLights && faultLights.length ? { fault_lights: faultLights } : {}),
          }),
        );
      }

    case "render_link_button":
      // Sprint 3 §14.1 — terminal app-nav redirect surface. Trigger-only: pass
      // `destination` (one of 8 enum values: terms_of_service / privacy_policy
      // / settings / profile / transaction_history / customer_support /
      // feedback / bug_report) and optional `label` text override. The mobile
      // component renders a tap-to-open button; on tap, the app navigates to
      // the appropriate screen (deep-link for in-app destinations; in-app
      // browser for TOS / Privacy). Oto NEVER recomposes screen content here.
      // bug_report is for GENERAL APP bugs only; AI-conversation feedback is
      // handled by the per-message UI button (UI-only, no Oto tool surface).
      return ok(
        toolUse.id,
        renderD("linkButton", {
          destination: toolUse.input.destination,
          ...(toolUse.input.label ? { label: toolUse.input.label } : {}),
        }),
      );

    case "render_booking_card":
      // Sprint 3 §14.3 — single-booking detail card. Trigger-only: pass
      // ONLY the booking_id; the mobile component queries Convex for the
      // shop name, mechanic, scheduled date/time, service names, status,
      // and renders the card itself. Oto NEVER composes booking details.
      return ok(
        toolUse.id,
        renderD("bookingCard", {
          booking_id: toolUse.input.booking_id,
        }),
      );

    case "render_bookings_list":
      // Sprint 3 §14.3 — multi-booking list. Trigger-only: pass ONLY the
      // booking_ids array (min 1, max 10 enforced by the tool schema). The
      // mobile component queries Convex for each booking's details and
      // renders the list itself. Oto NEVER composes booking data.
      return ok(
        toolUse.id,
        renderD("bookingsList", {
          booking_ids: toolUse.input.booking_ids,
        }),
      );

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

// Anthropic tool schemas are advisory, not enforced — Haiku can emit a numeric
// field as "" / null / NaN. These sanitizers drop malformed values at the render
// packaging layer so they never reach the mobile card or the Convex
// v.optional(v.number()) validators downstream (which THROW on a non-number).
function toFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const VEHICLE_TRUTH_CLAIM_KINDS = new Set(["due", "light_on", "completed"]);
// W4.3 (QA K3) — hedged self-reports. Only the two literal values pass; any
// other emission ("unsure", "", 0.5) is dropped here so downstream treats the
// claim as the default "certain" (matches pre-field behavior for old payloads).
const VEHICLE_TRUTH_STATED_CONFIDENCE = new Set(["certain", "hedged"]);

function sanitizeServiceClaims(
  raw: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const claim = entry as Record<string, unknown>;
    if (typeof claim.service_slug !== "string") continue;
    if (typeof claim.kind !== "string" || !VEHICLE_TRUTH_CLAIM_KINDS.has(claim.kind)) continue;
    const clean: Record<string, unknown> = {
      service_slug: claim.service_slug,
      kind: claim.kind,
    };
    const serviceMileage = toFiniteNumber(claim.service_mileage);
    if (serviceMileage !== undefined) clean.service_mileage = serviceMileage;
    const serviceAgeDays = toFiniteNumber(claim.service_age_days);
    if (serviceAgeDays !== undefined) clean.service_age_days = serviceAgeDays;
    const serviceDate = toFiniteNumber(claim.service_date);
    if (serviceDate !== undefined) clean.service_date = serviceDate;
    if (
      typeof claim.stated_confidence === "string" &&
      VEHICLE_TRUTH_STATED_CONFIDENCE.has(claim.stated_confidence)
    ) {
      clean.stated_confidence = claim.stated_confidence;
    }
    out.push(clean);
  }
  return out.length ? out : undefined;
}

// =============================================================================
// NAVIGATION PACKAGING
// =============================================================================
//
// Sprint 4 Day 1 Pass B: the sole navigation case (`navigate_to_payment`) was
// removed when the booking flow consolidated into `render_book_service`; the
// mobile BookServiceComponent handles the pay-screen redirect internally on
// final user confirm (same route the deprecated tool used:
// `/home/mechanic/{mechanic_id}/payment`). The function is retained as a
// refusal stub so the `category === "navigation"` branch in `executeTool`
// stays well-typed — if a future tool re-introduces the category, route it
// here. Today no tool routes here; reaching this function is a config drift.
function packageNavigationIntent(toolUse: ToolUseBlock): ToolResultBlock {
  return errorResult(
    toolUse.id,
    "unknown_tool",
    `Navigation tool "${toolUse.name}" is not registered. Phase 2 has no navigation tools; the booking pay-screen redirect is handled inside the BookServiceComponent (rendered by render_book_service).`,
  );
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
  // Sprint 4 Day 1 Pass B — consolidated booking-flow render. Replaces the
  // prior 6 envelope fields (showServicePicker, pickerServices,
  // pickerPreSelectedId, showDiagnosticForm, shopCarousel, timeSelector,
  // bookingConfirmation). Payload shape:
  //   { service_slugs: string[], diagnostic_system?: string,
  //     customer_notes?: string, recommended_priority?: string,
  //     recommended_mechanic_id?: string }
  // The mobile BookServiceComponent reads this and drives every sub-stage
  // internally including the pay-screen redirect — Oto fires it ONCE and
  // does not participate in subsequent booking-flow turns.
  bookService?: unknown;
  // render_record_confirmation (§6 Trust Protocol) — Convex maintenance_record
  // confirmation surface; NOT part of the Sprint 4 booking consolidation.
  showRecordConfirmation?: unknown;
  // Sprint 3 §14.1 — app-nav redirect: { destination, label? }. Mobile
  // component reads `destination` and renders a tap-to-open button that
  // navigates to the corresponding screen (deep-link for in-app destinations;
  // in-app browser for TOS / Privacy).
  linkButton?: unknown;
  // Sprint 3 §14.3 — Booking Status surfaces. Trigger payloads: pass only
  // the booking_id(s); the mobile components query Convex for the
  // renderable booking record(s) and render the card / list itself.
  bookingCard?: unknown;
  bookingsList?: unknown;
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
