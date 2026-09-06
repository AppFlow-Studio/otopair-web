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
  // W3.2 — unresolved symptoms from EARLIER turns of this conversation,
  // appended deterministically by the safety classifier (never by the model).
  // Rendered so a subject change cannot silently drop a safety thread (D-43).
  open_symptoms?: { text: string; category: string; safety_relevant: boolean }[];
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

/**
 * Map the onboarding car-knowledge self-rating to a coarse label Oto can act
 * on. The onboarding question stores a NUMBER (onboarding_questions_answers
 * .car_knowledge_level). CONFIRMED 1–3 scale from production (temurbek) data:
 *   1 = "I prefer things explained to me"  → beginner
 *   2 = "I know some stuff"                → intermediate
 *   3 = "I'm car-savvy"                    → experienced
 * Strings are also accepted (forward-compat) and matched by keyword.
 * Null/unknown → null, which the envelope omits entirely so Oto stays at its
 * friendly baseline (no behavior change for users who never answered).
 */
export function knowledgeLabel(
  level: number | string | null | undefined,
): "beginner" | "intermediate" | "experienced" | null {
  if (level == null) return null;
  if (typeof level === "number") {
    if (!Number.isFinite(level)) return null;
    if (level <= 1) return "beginner";
    if (level === 2) return "intermediate";
    return "experienced";
  }
  const s = level.trim().toLowerCase();
  if (!s) return null;
  if (/(beginner|novice|new|1)/.test(s)) return "beginner";
  if (/(intermediate|some|2)/.test(s)) return "intermediate";
  if (/(experienced|expert|advanced|pro|enthusiast|3|4|5)/.test(s)) return "experienced";
  return null;
}

interface BuildEnvelopeArgs {
  userFirstName: string | null;
  vehicle: ResolvedVehicle | null;
  history: HistoryTurn[];
  userMessage: string;
  conversationState?: ConversationStateBlock | null;
  diagnosticTurnCount?: number;
  // Onboarding car-knowledge level (already mapped via knowledgeLabel). Drives
  // answer-complexity scaling in the prompt's "Knowledge-level adaptation"
  // rule. Omitted from the <user> block when null.
  knowledgeLevel?: "beginner" | "intermediate" | "experienced" | null;
  // Wave 3 integration step 4 — facts established in this user's OTHER
  // conversations, top_K most-recent first. Optional; skipped from the
  // envelope when empty or omitted. See PriorConversationFact above.
  priorConversationFacts?: PriorConversationFact[];
  // Wave 2.2 — pre-rendered <safety_override> block from
  // convex/oto/safety.ts `renderSafetyOverrideBlock`, or null/undefined when
  // the turn carries no urgent-or-worse hazard. Passed in rather than computed
  // here so the classifier stays out of the envelope's dependency surface
  // (envelope.ts is pure formatting; safety.ts owns the hazard model).
  safetyOverride?: string | null;
  // Reference "now" for relative-time formatting under <recent_context>.
  // Defaults to Date.now() at call time when omitted (production path);
  // tests pin it explicitly so format output is deterministic.
  now?: number;
}

// Lowered 6 → 4 (beta feedback: a stranded user hit "just get me a mechanic"
// frustration well before six rounds of narrowing), then 4 → 2 (2026-08-14):
// the prompt's three-state termination rule caps narrowing at ~two clarifying
// turns, and N=10 eval runs showed the model sailing past turn 3 explaining
// instead of concluding — the server now enforces the same deadline the
// prompt asks for. Two unconverged question-turns → the third turn carries
// the block and must conclude.
// Exported (2026-08-14) so chat.ts's forced-exit backstop keys on the same
// number this block does — one threshold, two enforcement layers.
export const POLITE_EXIT_THRESHOLD = 2;

// -----------------------------------------------------------------------------
// Pick the active vehicle for this conversation. Precedence:
//   1. `conversation.vehicle_id` — the LOCKED anchor. Per the schema contract
//      (ai_conversations.vehicle_id), this wins over the frontend picker once
//      set, so resuming a chat later — when the global picker may have drifted
//      to a different car — still rebinds to the chat's own car. This is the
//      "one chat, one car" guarantee and the strongest guard against the
//      "who is this Lexus?" wrong-car bug. (Latent until setVehicleId is wired:
//      the column exists on ai_conversations but isn't written yet, so this
//      rule is a no-op today and rule 2 effectively leads.)
//   2. Explicit `preferredVin` from the client vehicle picker — honored
//      whenever the user actually owns it (the first-message selection, before
//      the anchor is set).
//   2b. preferredVin supplied but NOT owned (stale pick / decode mismatch /
//      ownership not yet written): DO NOT silently anchor to a different car.
//      A single owned car is unambiguous, so use it; with multiple cars prefer
//      the user's primary, otherwise return null so Oto asks which car rather
//      than confidently discussing the wrong one.
//   3. No explicit selection at all → the user's primary car, then the most
//      recently added. (A user-designated primary is a more stable default
//      than "whatever was added last".)
//   4. Null (no <vehicle> block in the envelope).
//
// Returns the chosen OwnedVehicleRow (still carries vin + raw vehicle/ownership)
// so the caller can run a follow-up resolution query (vehicles.getDisplayInfoForVin)
// to walk the FK chain into makes/models/trims. We DO NOT format the display
// string here — make/model/trim aren't on the vehicles row, they're foreign keys.
// -----------------------------------------------------------------------------

const hasVehicleId = (row: OwnedVehicleRow | undefined): row is OwnedVehicleRow =>
  !!row?.vehicle?._id;

const primaryOf = (owned: OwnedVehicleRow[]): OwnedVehicleRow | undefined =>
  owned.find((row) => row.ownership?.is_primary);

export function pickActiveVehicleRow(
  owned: OwnedVehicleRow[],
  conversationVehicleId: string | undefined,
  preferredVin: string | undefined,
): OwnedVehicleRow | null {
  if (owned.length === 0) return null;

  // 1. Locked conversation anchor wins once set (schema: vehicle_id beats the
  //    picker so a chat stays on its car even if the global picker drifts).
  //    If the anchor points at a car the user no longer owns, fall through.
  if (conversationVehicleId) {
    const pinned = owned.find((row) => row.vehicle?._id === conversationVehicleId);
    if (hasVehicleId(pinned)) return pinned!;
  }

  // 2. Explicit selection from the client vehicle picker.
  if (preferredVin) {
    const exact = owned.find((row) => row.vin === preferredVin);
    if (exact) return hasVehicleId(exact) ? exact : null;

    // 2b. Asked for a VIN we can't match to an owned row — never fall through
    //     to a different car. One car → unambiguous; otherwise prefer primary,
    //     else refuse to guess (Oto will ask which car).
    if (owned.length === 1) return hasVehicleId(owned[0]) ? owned[0] : null;
    const primary = primaryOf(owned);
    return hasVehicleId(primary) ? primary! : null;
  }

  // 3. No explicit selection — prefer the user's primary, then newest-added.
  const primary = primaryOf(owned);
  if (hasVehicleId(primary)) return primary!;

  const newest = [...owned].sort((a, b) => {
    const aAdded = a.ownership?.added_at ?? a.ownership?._creationTime ?? 0;
    const bAdded = b.ownership?.added_at ?? b.ownership?._creationTime ?? 0;
    return bAdded - aAdded; // newest first
  })[0];

  return hasVehicleId(newest) ? newest : null;
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
  knowledgeLevel,
  safetyOverride,
  now,
}: BuildEnvelopeArgs): string {
  const blocks: string[] = [];
  const nowMs = typeof now === "number" ? now : Date.now();

  const userLines = [`<user>`, `  name: ${userFirstName ?? "(unknown)"}`];
  // Onboarding car-knowledge level — present only when the user answered.
  // Drives the prompt's "Knowledge-level adaptation" rule (beginner → plain
  // + answer-first; experienced → can go more technical).
  if (knowledgeLevel) userLines.push(`  car_knowledge: ${knowledgeLevel}`);
  userLines.push(`</user>`);
  blocks.push(userLines.join("\n"));

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
    // W3.2 — the open-symptom ledger. Only rows still open reach the envelope
    // (chat.ts filters), and the rule line travels WITH the data so the model
    // never sees an open symptom without also seeing what it owes it.
    const openSymptoms = conversationState.open_symptoms ?? [];
    if (openSymptoms.length > 0) {
      lines.push(`  unresolved_symptoms:`);
      for (const s of openSymptoms) {
        lines.push(
          `    - "${s.text}"${s.safety_relevant ? " [safety-relevant]" : ""}`,
        );
      }
      lines.push(
        `  unresolved_symptoms_rule: These were reported earlier in THIS conversation and never resolved. Do not let a subject change drop them. Before this conversation ends or a booking is finalized, either fold them into the booking (they are auto-added to the customer notes when you fire render_book_service) or explicitly ask the user about them once.`,
      );
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

  // Wave 2.2 — safety override. Deliberately placed BEFORE conversation
  // history and before <untrusted_user_input>: the block is system-authored
  // context about the current turn, and putting it ahead of the user's own
  // words keeps it from reading as something the user asked for. Highest
  // priority block in the envelope; see convex/oto/safety.ts for why it
  // exists and why it is tone-blind.
  if (safetyOverride) blocks.push(safetyOverride);

  if (diagnosticTurnCount >= POLITE_EXIT_THRESHOLD) {
    blocks.push(
      [
        `<polite_exit_required>`,
        `  diagnostic_turn_count: ${diagnosticTurnCount}`,
        `  rule: This conversation has narrowed for ${diagnosticTurnCount} turns without converging. Stop narrowing — THIS turn must reach a terminal state, and no further clarifying question is allowed. If you have not yet consulted get_vehicle_health for the implicated system this conversation, call it NOW in this same turn before concluding. Then: if the trust gate holds (the narrowed symptom contradicts an on_time self_reported record — the recorded service, if real, would have eliminated this symptom), fire render_record_confirmation for that maintenance type. Otherwise call render_book_service with service_slugs=["diagnostic_scan"], diagnostic_system set to the closest subsystem (or "not_sure"), and customer_notes summarizing everything the user has mentioned across the conversation. The mechanic can see what you couldn't.`,
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
      s.last_user_intent ||
      // W3.2 — an open symptom alone is reason enough to render the block;
      // it is exactly the state that must survive a first-turn subject change.
      (s.open_symptoms && s.open_symptoms.length > 0),
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
