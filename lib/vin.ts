/**
 * lib/vin.ts — client-side VIN field hygiene.
 *
 * The server already owns "is this string a real VIN" (convex/lib/vinIdentity.ts).
 * This is the front-of-house complement: it cleans raw keystrokes as the user
 * types so a mis-keyed VIN never silently fails validation deeper in the flow.
 *
 * ISO 3779 excludes the letters I, O and Q from the VIN alphabet precisely so
 * they can't be confused with 1, 0 and 0. That gives us two safe moves:
 *
 *   - O → 0 and I → 1 are AUTO-CORRECTED. A real VIN never contains O or I, so a
 *     typed one is a mis-key for the digit essentially every time. Correcting
 *     (rather than dropping) is what lets a VIN entered with an "O" still reach
 *     the 17-char check and trigger enrichment, instead of stalling one char
 *     short of valid with no popup and no explanation.
 *   - Q, and every other out-of-alphabet character (spaces, hyphens, dashes from
 *     a pasted label…), is DROPPED. Q has no digit twin, so there is nothing
 *     safe to correct it to.
 *
 * `sanitizeVinInput` reports what it changed so the field can tell the user
 * ("we read O/I as 0/1", "removed a character a VIN can't contain") rather than
 * mutating their input silently.
 */

export const VIN_LENGTH = 17;

/** ISO 3779 VIN alphabet — I, O and Q are excluded by the standard. */
export const VIN_CHARSET = /^[A-HJ-NPR-Z0-9]{17}$/;

const VIN_CHAR = /[A-HJ-NPR-Z0-9]/;

export interface SanitizeVinResult {
  /** Cleaned value, uppercased, ≤ 17 chars, all in the VIN alphabet. */
  value: string;
  /** An O or I was auto-corrected to 0 or 1. */
  correctedOI: boolean;
  /** A character with no VIN equivalent (Q, punctuation, whitespace…) was removed. */
  droppedInvalid: boolean;
}

/**
 * Clean a raw VIN input value into the ISO 3779 alphabet.
 *
 * Uppercases, transliterates O→0 / I→1, drops anything else outside the VIN
 * alphabet, and caps the result at 17 characters. Overflow past 17 is trimmed
 * silently (not flagged as "dropped") so a paste of a well-formed VIN with a
 * trailing space doesn't nag.
 */
export function sanitizeVinInput(raw: string): SanitizeVinResult {
  const upper = (raw ?? "").toUpperCase();
  let value = "";
  let correctedOI = false;
  let droppedInvalid = false;

  for (const ch of upper) {
    if (value.length >= VIN_LENGTH) break;
    if (ch === "O") {
      value += "0";
      correctedOI = true;
    } else if (ch === "I") {
      value += "1";
      correctedOI = true;
    } else if (VIN_CHAR.test(ch)) {
      value += ch;
    } else {
      // Q, whitespace, hyphens, punctuation — nothing to map to.
      droppedInvalid = true;
    }
  }

  return { value, correctedOI, droppedInvalid };
}

/** True when `vin` is a structurally complete VIN: 17 chars, no I/O/Q. */
export function isCompleteVin(vin: string | null | undefined): boolean {
  if (!vin) return false;
  return VIN_CHARSET.test(vin.trim().toUpperCase());
}
