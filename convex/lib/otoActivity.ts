// =============================================================================
// Oto activity — shared summarizer for "what Oto DID" in a conversation, plus
// the booking outcome. One source of truth so every reader (ops /oto-ai,
// director conversations/sim debug, ops user profile, end-user mobile queries)
// renders Oto's actions + bookings consistently.
//
// Two inputs feed the summary:
//   1. conversation_audit.tool_calls — {name, input} captured per assistant turn
//      (chat.ts wires this for new turns; the Oto sim shares that loop).
//   2. oto_telemetry.tools_called — tool NAMES only. The historical fallback:
//      pre-wiring conversations never stored tool inputs, so we can only surface
//      the fact that a mutating/memory tool fired, not its values.
//
// summarizeOtoActions is PURE (no ctx) so it's trivially reusable and testable;
// service slugs are humanized in place rather than resolved to DB names (that
// would cost N lookups per conversation — the booking OUTCOME card shows the
// real resolved names via enrichBookingRefs).
// =============================================================================
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { enrichBookingRefs } from "./bookingEnrichment";

export type OtoActionKind =
  | "booking"
  | "vehicle_update"
  | "record_confirm"
  | "memory"
  | "other";

export type OtoAction = {
  /** conversation_audit turn_number, or -1 when derived from telemetry names. */
  turn: number;
  /** raw tool name that produced this action. */
  tool: string;
  kind: OtoActionKind;
  /** human one-liner, e.g. "Proposed mileage update". */
  label: string;
  /** secondary detail, e.g. "→ 14,001 mi" or "Oil Change". */
  detail?: string;
  /** ms-epoch when known (audit/telemetry timestamp). */
  at?: number;
};

/** Minimal audit-row shape summarizeOtoActions needs (structurally typed so
 *  callers can pass their query projections without importing Doc types). */
export type AuditToolRow = {
  turn_number: number;
  tool_calls?: Array<{ name: string; input?: unknown }> | null;
  timestamp?: number;
};
export type TelemetryToolRow = { ts?: number; tools_called?: string[] };

// slug / enum → "Title Case" ("oil_change" → "Oil Change").
const humanize = (s: string): string =>
  s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

// Tool names that represent an action on the USER's data/records (vs. UI-only
// renders like quick-replies, or internal control tools). Used for the
// telemetry-only historical fallback.
function mutatingKind(name: string): OtoActionKind | null {
  switch (name) {
    case "render_book_service":
      return "booking";
    case "render_vehicle_update":
      return "vehicle_update";
    case "render_record_confirmation":
      return "record_confirm";
    case "record_semantic_fact":
    case "record_vehicle_fact":
    case "retract_semantic_fact":
    case "retract_conversation_fact":
      return "memory";
    default:
      return null;
  }
}

function labelForToolName(name: string): string {
  switch (name) {
    case "render_book_service":
      return "Started a booking";
    case "render_vehicle_update":
      return "Proposed a vehicle update";
    case "render_record_confirmation":
      return "Confirmed a maintenance record";
    case "retract_semantic_fact":
    case "retract_conversation_fact":
      return "Retracted a fact";
    default:
      return "Saved a durable fact";
  }
}

// Classify one {name, input} tool call into 0..n human actions.
function classifyToolCall(
  name: string,
  input: unknown,
  turn: number,
  at: number | undefined,
): OtoAction[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<
    string,
    any
  >;
  const base = { turn, tool: name, at };

  switch (name) {
    case "render_book_service": {
      const slugs: string[] = Array.isArray(i.service_slugs)
        ? i.service_slugs.filter((x: unknown): x is string => typeof x === "string")
        : [];
      const svc = slugs.map(humanize).join(", ");
      const bits: string[] = [];
      if (i.diagnostic_system && i.diagnostic_system !== "not_sure") {
        bits.push(`diagnostic: ${humanize(String(i.diagnostic_system))}`);
      }
      if (typeof i.recommended_priority === "string") {
        bits.push(String(i.recommended_priority).replace(/[_-]+/g, " "));
      }
      if (typeof i.customer_notes === "string" && i.customer_notes.trim()) {
        bits.push(`“${truncate(i.customer_notes.trim(), 140)}”`);
      }
      return [
        {
          ...base,
          kind: "booking",
          label: svc ? `Started a booking · ${svc}` : "Started a booking",
          detail: bits.join(" — ") || undefined,
        },
      ];
    }

    case "render_vehicle_update": {
      const out: OtoAction[] = [];
      if (typeof i.mileage === "number" && Number.isFinite(i.mileage)) {
        out.push({
          ...base,
          kind: "vehicle_update",
          label: "Proposed mileage update",
          detail: `→ ${Math.round(i.mileage).toLocaleString()} mi`,
        });
      }
      const claims = Array.isArray(i.service_claims) ? i.service_claims : [];
      for (const c of claims) {
        if (!c || typeof c.service_slug !== "string") continue;
        const done = c.kind === "completed";
        const qualifier = done
          ? ""
          : c.kind === "light_on"
            ? " (warning light)"
            : " (due)";
        out.push({
          ...base,
          kind: "vehicle_update",
          label: done ? "Recorded service complete" : "Flagged service",
          detail: `${humanize(c.service_slug)}${qualifier}`,
        });
      }
      const lights: string[] = Array.isArray(i.fault_lights)
        ? i.fault_lights.filter((x: unknown): x is string => typeof x === "string")
        : [];
      if (lights.length) {
        out.push({
          ...base,
          kind: "vehicle_update",
          label: lights.length > 1 ? "Logged warning lights" : "Logged warning light",
          detail: lights.map(humanize).join(", "),
        });
      }
      if (out.length === 0) {
        out.push({ ...base, kind: "vehicle_update", label: "Proposed a vehicle update" });
      }
      return out;
    }

    case "render_record_confirmation":
      return [
        {
          ...base,
          kind: "record_confirm",
          label: "Confirmed a maintenance record",
          detail:
            typeof i.maintenance_type === "string"
              ? humanize(i.maintenance_type)
              : undefined,
        },
      ];

    case "record_semantic_fact":
    case "record_vehicle_fact": {
      const text =
        typeof i.text === "string"
          ? i.text
          : typeof i.fact_text === "string"
            ? i.fact_text
            : undefined;
      return [
        {
          ...base,
          kind: "memory",
          label: "Saved a durable fact",
          detail: text ? truncate(text, 140) : undefined,
        },
      ];
    }

    case "retract_semantic_fact":
    case "retract_conversation_fact":
      return [
        {
          ...base,
          kind: "memory",
          label: "Retracted a fact",
          detail: typeof i.reason === "string" ? truncate(i.reason, 140) : undefined,
        },
      ];

    default:
      // UI-only renders (quick replies, cards, reasoning), state control
      // (update_conversation_state), and model routing are not user-data actions.
      return [];
  }
}

/**
 * Summarize the action-bearing tool calls of a conversation into a human
 * timeline. Prefers the rich audit tool_calls; falls back to telemetry tool
 * NAMES (values unrecoverable) only when no audit tool_calls exist at all.
 */
export function summarizeOtoActions(
  auditRows: ReadonlyArray<AuditToolRow>,
  telemetryRows: ReadonlyArray<TelemetryToolRow>,
): OtoAction[] {
  const actions: OtoAction[] = [];
  let sawAuditToolCalls = false;

  for (const row of auditRows) {
    if (!row.tool_calls || row.tool_calls.length === 0) continue;
    sawAuditToolCalls = true;
    for (const tc of row.tool_calls) {
      if (!tc || typeof tc.name !== "string") continue;
      actions.push(...classifyToolCall(tc.name, tc.input, row.turn_number, row.timestamp));
    }
  }

  if (!sawAuditToolCalls) {
    // Historical fallback — inputs were never stored on these turns.
    for (const t of telemetryRows) {
      for (const name of t.tools_called ?? []) {
        const kind = mutatingKind(name);
        if (!kind) continue;
        actions.push({ turn: -1, tool: name, kind, label: labelForToolName(name), at: t.ts });
      }
    }
  }

  return actions.sort((a, b) => a.turn - b.turn || (a.at ?? 0) - (b.at ?? 0));
}

export type OtoBookingOutcome =
  | {
      state: "created";
      bookingId: string;
      status: string;
      services: string[];
      scheduledDate: string | null;
      scheduledTime: string | null;
      shopName: string | null;
      vehicleYmm: string | null;
    }
  // Oto teed up a booking (render_book_service fired) but no booking is linked
  // to the conversation — the "Oto said booked, but nothing exists" signal.
  | { state: "not_created" }
  | { state: "none" };

/**
 * Resolve whether a conversation actually produced a booking. Reuses
 * enrichBookingRefs so the outcome card shows the same customer/shop/vehicle/
 * service resolution as the rest of ops.
 */
export async function resolveBookingOutcome(
  ctx: QueryCtx,
  conversation: Doc<"ai_conversations">,
  actions: ReadonlyArray<OtoAction>,
): Promise<OtoBookingOutcome> {
  if (conversation.booking_id) {
    const booking = await ctx.db.get(conversation.booking_id);
    if (booking) {
      const refs = await enrichBookingRefs(ctx, booking);
      return {
        state: "created",
        bookingId: String(booking._id),
        status: booking.status,
        services: refs.serviceNames,
        scheduledDate: booking.scheduled_date ?? null,
        scheduledTime: booking.scheduled_time ?? null,
        shopName: refs.shopName,
        vehicleYmm: refs.vehicle.ymm,
      };
    }
  }
  if (actions.some((a) => a.kind === "booking")) return { state: "not_created" };
  return { state: "none" };
}

// A structured "sheet" the mobile app rendered (booking bottom-sheet / vehicle-
// update confirm card) that shows as an EMPTY bubble in the read-only ops
// transcript. Reconstructed from conversation_audit.tool_calls so the reviewer
// sees what the sheet contained, not a blank bubble.
export type RenderCard = {
  kind: "booking" | "vehicle_update" | "record_confirm";
  title: string;
  fields: { label: string; value: string }[];
};

/** Reconstruct the render sheets a single assistant turn produced from its
 *  captured tool_calls. Empty when the turn fired no render directives. */
export function renderCardsFromToolCalls(
  toolCalls: ReadonlyArray<{ name: string; input?: unknown }> | null | undefined,
): RenderCard[] {
  if (!toolCalls) return [];
  const cards: RenderCard[] = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc.name !== "string") continue;
    const i = (tc.input && typeof tc.input === "object" ? tc.input : {}) as Record<
      string,
      any
    >;

    if (tc.name === "render_book_service") {
      const slugs: string[] = Array.isArray(i.service_slugs)
        ? i.service_slugs.filter((x: unknown): x is string => typeof x === "string")
        : [];
      const fields: { label: string; value: string }[] = [];
      if (slugs.length) fields.push({ label: "Services", value: slugs.map(humanize).join(", ") });
      if (i.diagnostic_system && i.diagnostic_system !== "not_sure") {
        fields.push({ label: "Diagnostic", value: humanize(String(i.diagnostic_system)) });
      }
      if (typeof i.recommended_priority === "string") {
        fields.push({
          label: "Priority",
          value: String(i.recommended_priority).replace(/[_-]+/g, " "),
        });
      }
      if (typeof i.customer_notes === "string" && i.customer_notes.trim()) {
        fields.push({ label: "Notes", value: i.customer_notes.trim() });
      }
      cards.push({ kind: "booking", title: "Booking sheet", fields });
    } else if (tc.name === "render_vehicle_update") {
      const fields: { label: string; value: string }[] = [];
      if (typeof i.mileage === "number" && Number.isFinite(i.mileage)) {
        fields.push({ label: "Mileage", value: `${Math.round(i.mileage).toLocaleString()} mi` });
      }
      const claims = Array.isArray(i.service_claims) ? i.service_claims : [];
      for (const c of claims) {
        if (!c || typeof c.service_slug !== "string") continue;
        const label =
          c.kind === "completed"
            ? "Completed"
            : c.kind === "light_on"
              ? "Warning light"
              : "Due";
        fields.push({ label, value: humanize(c.service_slug) });
      }
      const lights: string[] = Array.isArray(i.fault_lights)
        ? i.fault_lights.filter((x: unknown): x is string => typeof x === "string")
        : [];
      if (lights.length) fields.push({ label: "Fault lights", value: lights.map(humanize).join(", ") });
      cards.push({ kind: "vehicle_update", title: "Vehicle update", fields });
    } else if (tc.name === "render_record_confirmation") {
      const fields: { label: string; value: string }[] = [];
      if (typeof i.maintenance_type === "string") {
        fields.push({ label: "Record", value: humanize(i.maintenance_type) });
      }
      cards.push({ kind: "record_confirm", title: "Maintenance record", fields });
    }
  }
  return cards;
}
