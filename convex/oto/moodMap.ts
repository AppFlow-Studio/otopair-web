// =============================================================================
// Oto AI — mood mapping (B-P5, Jun-10)
// =============================================================================
//
// The update_conversation_state tool offers Haiku SEVEN mood values
// (tools.ts): calm, curious, worried, frustrated, hyped, confused, neutral.
// The conversation_episodic_control.mood column (schema.ts) is a FIVE-member
// enum: neutral, curious, concerned, frustrated, satisfied.
//
// The episodic mirror used to accept only exact matches and route everything
// else to "neutral" — which silently flattened FOUR of the seven moods
// (calm, worried, hyped, confused) to neutral, destroying the emotional
// signal the column exists to capture. Map by valence instead so the mirror
// keeps a meaningful read:
//   worried  -> concerned   (negative / worry — the worst loss before)
//   hyped    -> satisfied   (positive energy — the only positive enum value)
//   confused -> concerned   (friction / needs help — a mild negative)
//   calm     -> neutral     (calm IS the routine baseline; genuinely neutral)
//
// Pure; unit-tested in tests/moodMap.test.ts.
// =============================================================================

export type EpisodicMood =
  | "neutral"
  | "curious"
  | "concerned"
  | "frustrated"
  | "satisfied";

const MOOD_MAP: Record<string, EpisodicMood> = {
  // Exact episodic-enum members pass through.
  neutral: "neutral",
  curious: "curious",
  concerned: "concerned",
  frustrated: "frustrated",
  satisfied: "satisfied",
  // The four tool-only moods, mapped by valence.
  calm: "neutral",
  worried: "concerned",
  hyped: "satisfied",
  confused: "concerned",
};

/**
 * Map a tool-emitted mood string to the episodic-control enum. Returns null
 * for an unrecognized value so the caller can log it and fall back to
 * "neutral" (preserving the forensic signal that an unknown mood arrived).
 */
export function mapToolMoodToEpisodic(mood: string): EpisodicMood | null {
  return MOOD_MAP[mood] ?? null;
}
