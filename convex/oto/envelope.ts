// =============================================================================
// Oto AI — Uncached-zone envelope builder + active-vehicle resolution
// =============================================================================
//
// Split out of chat.ts so the action declaration's TS inference depth stays
// under TS2589. Pure functions only — no Convex ctx, no api refs.
//
// State Contract §2.4: this builds the `<user>` / `<vehicle>` /
// `<conversation_history>` / `<user_message>` envelope that goes into the
// uncached zone of every Anthropic call.
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
}

export interface HistoryTurn {
  role: string;
  content: string;
}

interface BuildEnvelopeArgs {
  userFirstName: string | null;
  vehicle: ResolvedVehicle | null;
  history: HistoryTurn[];
  userMessage: string;
}

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
}: BuildEnvelopeArgs): string {
  const blocks: string[] = [];

  blocks.push(
    [`<user>`, `  name: ${userFirstName ?? "(unknown)"}`, `</user>`].join("\n"),
  );

  if (vehicle) {
    blocks.push(
      [
        `<vehicle>`,
        `  display: ${vehicle.display}`,
        `  id: ${vehicle.id}`,
        `</vehicle>`,
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

  blocks.push(
    [`<user_message>`, `  ${userMessage}`, `</user_message>`].join("\n"),
  );

  return blocks.join("\n\n");
}
