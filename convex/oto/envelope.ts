// =============================================================================
// Oto AI — Uncached-zone envelope builder + active-vehicle resolution
// =============================================================================
//
// Split out of chat.ts so the action declaration's TS inference depth stays
// under TS2589. Pure functions only — no Convex ctx, no api refs.
//
// State Contract §2.4: this builds the `<user>` / `<vehicle>` /
// `<conversation_history>` / `<untrusted_user_input>` envelope that goes
// into the uncached zone of every Anthropic call. The current user's
// message is wrapped in `<untrusted_user_input>` (Wave 7.1, Day 7) for
// structural separation — Day 8's prompt rule will reference that exact
// tag name as the "treat-as-data" anchor.
// =============================================================================

export interface OwnedVehicleRow {
  vin: string;
  vehicle: {
    _id: string;
    _creationTime: number;
    year?: number;
    metadata?: Record<string, unknown>;
  } | null;
  ownership: {
    _id: string;
    _creationTime: number;
    nickname?: string;
    is_primary?: boolean;
    added_at?: number;
  } | null;
}

export interface ResolvedVehicle {
  /** Opaque Convex document id of the vehicles row. NOT the VIN. */
  id: string;
  /** "2020 BMW M550i xDrive" — what the AI sees and uses in phrasing. */
  display: string;
  /** Real VIN. Exposed in the <vehicle> envelope block so Haiku can
   *  pass it to vehicle-scoped tools like `get_bookings`. */
  vin: string | null;
}

export interface HistoryTurn {
  role: string;
  content: string;
}

export interface ConversationStateBlock {
  mood: string | null;
  arc_summary: string | null;
  established_facts: string[];
  last_user_intent: string | null;
  updated_at: number | null;
}

// Wave 3 integration step 4 (§3.4) — one fact pulled from a PRIOR
// conversation of the same user. The flattened payload_text + fact_type +
// created_at are all the envelope needs to render a one-line bullet under
// the new <recent_context> block.
//
// Sourced by `memoryEditing.getCrossConversationMemory`. The query has already
// sorted newest-first, capped at top_K, and truncated over-long payload_text;
// the envelope builder just renders.
export interface PriorConversationFact {
  conversation_id: string;
  fact_type: string;
  payload_text: string;
  written_by: string;
  created_at: number;
}

interface BuildEnvelopeArgs {
  userFirstName: string | null;
  vehicle: ResolvedVehicle | null;
  history: HistoryTurn[];
  userMessage: string;
  conversationState?: ConversationStateBlock | null;
  diagnosticTurnCount?: number;
  // Wave 3 integration step 4 — facts established in this user's OTHER
  // conversations, top_K most-recent first. Optional; skipped from the
  // envelope when empty or omitted. See PriorConversationFact above.
  priorConversationFacts?: PriorConversationFact[];
  // Reference "now" for relative-time formatting under <recent_context>.
  // Defaults to Date.now() at call time when omitted (production path);
  // tests pin it explicitly so format output is deterministic.
  now?: number;
}

const POLITE_EXIT_THRESHOLD = 6;

// -----------------------------------------------------------------------------
// Pick the active vehicle for this conversation. Precedence:
//   1. Explicit `preferredVin` from the client (frontend vehicle picker — wins
//      whenever the user has manually selected one). Only honored if the user
//      actually owns it; otherwise falls through to the next rule.
//   2. `conversation.vehicle_id` if the column is present and the user owns it.
//      (Forward-compat: the column doesn't exist on ai_conversations yet, so
//      this rule is a no-op today.)
//   3. Most-recently-added vehicle on the user's account.
//   4. Null (no <vehicle> block in the envelope).
//
// Returns the chosen OwnedVehicleRow (still carries vin + raw vehicle/ownership)
// so the caller can run a follow-up resolution query (vehicles.getDisplayInfoForVin)
// to walk the FK chain into makes/models/trims. We DO NOT format the display
// string here — make/model/trim aren't on the vehicles row, they're foreign keys.
// -----------------------------------------------------------------------------

export function pickActiveVehicleRow(
  owned: OwnedVehicleRow[],
  conversationVehicleId: string | undefined,
  preferredVin: string | undefined,
): OwnedVehicleRow | null {
  if (owned.length === 0) return null;

  let chosen: OwnedVehicleRow | undefined;
  if (preferredVin) {
    chosen = owned.find((row) => row.vin === preferredVin);
  }
  if (!chosen && conversationVehicleId) {
    chosen = owned.find((row) => row.vehicle?._id === conversationVehicleId);
  }
  if (!chosen) {
    chosen = [...owned].sort((a, b) => {
      const aAdded = a.ownership?.added_at ?? a.ownership?._creationTime ?? 0;
      const bAdded = b.ownership?.added_at ?? b.ownership?._creationTime ?? 0;
      return bAdded - aAdded; // newest first
    })[0];
  }

  if (!chosen?.vehicle?._id) return null;
  return chosen;
}

// -----------------------------------------------------------------------------
// Assemble the "{year} {make} {model} {trim}" display string from resolved
// fields. All four are optional; whatever's present is concatenated in order.
// If everything's missing, fall back to the user's ownership nickname, then a
// generic label.
// -----------------------------------------------------------------------------

export interface DisplayInfo {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
}

export function formatDisplayString(
  info: DisplayInfo,
  ownershipNickname?: string | null,
): string {
  const parts: string[] = [];
  if (info.year !== null && info.year !== undefined) parts.push(String(info.year));
  if (info.make) parts.push(titleCaseMake(info.make));
  if (info.model) parts.push(info.model);
  if (info.trim) parts.push(info.trim);

  if (parts.length > 0) return parts.join(" ");

  if (ownershipNickname?.trim()) return ownershipNickname.trim();
  return "Your vehicle";
}

// VW/BMW/GMC are stored uppercase in some sources, mixed in others. Match the
// chat screen's existing `formatMake` behavior without importing it from the
// client side.
function titleCaseMake(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper === "BMW" || upper === "VW" || upper === "GMC") return upper;
  return raw[0]?.toUpperCase() + raw.slice(1).toLowerCase();
}

// -----------------------------------------------------------------------------
// Build the State Contract §2.4 envelope.
// Blocks with no data are skipped entirely — don't tell Haiku to think about
// missing fields.
// -----------------------------------------------------------------------------

export function buildEnvelope({
  userFirstName,
  vehicle,
  history,
  userMessage,
  conversationState,
  diagnosticTurnCount = 0,
  priorConversationFacts,
  now,
}: BuildEnvelopeArgs): string {
  const blocks: string[] = [];
  const nowMs = typeof now === "number" ? now : Date.now();

  blocks.push(
    [`<user>`, `  name: ${userFirstName ?? "(unknown)"}`, `</user>`].join("\n"),
  );

  if (vehicle) {
    const vehicleLines = [
      `<vehicle>`,
      `  display: ${vehicle.display}`,
      `  id: ${vehicle.id}`,
    ];
    // Expose VIN so vehicle-scoped tools (get_bookings, etc.) can be
    // filtered to the active car when the user's question is car-scoped.
    if (vehicle.vin) vehicleLines.push(`  vin: ${vehicle.vin}`);
    vehicleLines.push(`</vehicle>`);
    blocks.push(vehicleLines.join("\n"));
  }

  // Conversation state replay (v0.7). Skip the block entirely when there's
  // nothing useful to say — don't tell Haiku to think about empty fields.
  if (conversationState && hasUsefulState(conversationState)) {
    const lines = [`<conversation_state>`];
    if (conversationState.mood) lines.push(`  mood: ${conversationState.mood}`);
    if (conversationState.last_user_intent) {
      lines.push(`  last_intent: ${conversationState.last_user_intent}`);
    }
    if (conversationState.arc_summary) {
      lines.push(`  arc: ${conversationState.arc_summary}`);
    }
    if (conversationState.established_facts.length > 0) {
      lines.push(`  established_facts:`);
      for (const fact of conversationState.established_facts) {
        lines.push(`    - ${fact}`);
      }
    }
    lines.push(`</conversation_state>`);
    blocks.push(lines.join("\n"));
  }

  // Wave 3 integration step 4 — cross-conversation memory.
  // Render facts from PRIOR conversations under <recent_context> so the AI
  // sees what was established earlier with this user, not just within the
  // current conversation. Skip the block entirely if no prior facts (matches
  // the <conversation_state> "no useful state → no block" pattern).
  if (priorConversationFacts && priorConversationFacts.length > 0) {
    const lines = [
      `<recent_context>`,
      `  facts_from_prior_conversations:`,
    ];
    for (const fact of priorConversationFacts) {
      const rel = formatRelativeTime(fact.created_at, nowMs);
      lines.push(
        `    - [${fact.fact_type}] ${fact.payload_text}  (${rel})`,
      );
    }
    lines.push(`</recent_context>`);
    blocks.push(lines.join("\n"));
  }

  if (diagnosticTurnCount >= POLITE_EXIT_THRESHOLD) {
    blocks.push(
      [
        `<polite_exit_required>`,
        `  diagnostic_turn_count: ${diagnosticTurnCount}`,
        `  rule: This conversation has narrowed for ${diagnosticTurnCount} turns without converging. Stop narrowing now. Call render_book_service with service_slugs=["diagnostic_scan"], diagnostic_system="not_sure", and customer_notes summarizing everything the user has mentioned across the conversation. The mechanic can see what you couldn't.`,
        `</polite_exit_required>`,
      ].join("\n"),
    );
  }

  if (history.length > 0) {
    const lines = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `  ${m.role}: ${m.content}`);
    if (lines.length > 0) {
      blocks.push(
        [`<conversation_history>`, ...lines, `</conversation_history>`].join("\n"),
      );
    }
  }

  // Wave 7.1 (Day 7) — untrusted-input structural separation. The CURRENT
  // user's message is the primary prompt-injection surface. Wrap it in a
  // distinct, named tag so a subsequent prompt rule (Day 8 — Wave 1.5
  // protocol pair) can refer to "text inside <untrusted_user_input>" by
  // name and treat it as data, not instructions. The tag rename is purely
  // structural; the inner content is byte-identical to v0.7 envelope.
  blocks.push(
    [
      `<untrusted_user_input>`,
      `  ${userMessage}`,
      `</untrusted_user_input>`,
    ].join("\n"),
  );

  return blocks.join("\n\n");
}

function hasUsefulState(s: ConversationStateBlock): boolean {
  return Boolean(
    s.mood ||
      s.arc_summary ||
      (s.established_facts && s.established_facts.length > 0) ||
      s.last_user_intent,
  );
}

// -----------------------------------------------------------------------------
// Human-readable relative time for <recent_context> bullets. Buckets chosen
// to convey freshness without leaking precise timestamps into the prompt:
//   < 60s            → "just now"
//   < 60m            → "N min ago"   (1 min ago / 5 min ago / 59 min ago)
//   < 24h            → "N hours ago" (1 hour ago / 2 hours ago / ...)
//   1 day            → "yesterday"
//   < 30 days        → "N days ago"
//   >= 30 days       → "N+ days ago" (cap; we don't need month/year resolution
//                                     for memory-relevance signals)
// Negative deltas (future timestamp — clock skew) bucket as "just now".
// -----------------------------------------------------------------------------
export function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const deltaMs = nowMs - timestampMs;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(deltaMs / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `30+ days ago`;
}
